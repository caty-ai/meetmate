const test = require("node:test");
const assert = require("node:assert/strict");

const { createGatewaySessionTracker } = require("../src/gateway-session-tracker");

test("shared tracker routes spawn to handler, replaces placeholder, and releases cap on completion", async () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-1",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
    delegationResults: [],
  };
  const sessions = new Map([[session.id, session]]);
  const handler = {
    inFlight: new Map([["pending:forced:1:0", { label: "placeholder" }]]),
    handleGatewaySubagentSpawn(evt) {
      this.inFlight.delete("pending:forced:1:0");
      this.inFlight.set(evt.childKey, { label: evt.label });
      session.gatewayDelegationState = { inFlightCount: this.inFlight.size, pendingQueueCount: 0 };
      return true;
    },
    handleGatewaySubagentCompletion(evt) {
      this.inFlight.delete(evt.childKey);
      session.gatewayDelegationState = { inFlightCount: this.inFlight.size, pendingQueueCount: 0 };
      return true;
    },
  };
  const activeConnections = new Map([[session.id, { handler }]]);
  const metrics = [];

  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: (type, fields) => metrics.push({ type, ...fields }),
    sessions,
    activeConnections,
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => false,
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  const parentSessionKey = "agent:main:openai-user:meet-sid-1-caty";
  const childKey = "agent:main:subagent:child-1";
  await spawnListeners[0]({ parentSessionKey, childKey, label: "調査", source: "forced" });
  assert.equal(handler.inFlight.has("pending:forced:1:0"), false);
  assert.equal(handler.inFlight.has(childKey), true);

  await completionListeners[0]({ parentSessionKey, childKey, label: "調査", resultText: "done" });
  assert.equal(handler.inFlight.size, 0);
  assert.equal(session.gatewayDelegationState.inFlightCount, 0);
  assert.equal(metrics.some((event) => event.type === "subagent_spawned" && event.session_id === session.id && event.source === "self"), true);
  assert.equal(metrics.some((event) => event.type === "spawn_detected" && event.session_id === session.id && event.deprecated === true), true);
  tracker.close();
});

test("shared tracker classifies delegate-session spawn source", async () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-delegate",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
    delegationResults: [],
  };
  const sessions = new Map([[session.id, session]]);
  const handledSpawns = [];
  const activeConnections = new Map([[session.id, {
    handler: {
      handleGatewaySubagentSpawn(evt) {
        handledSpawns.push(evt);
        return true;
      },
    },
  }]]);
  const metrics = [];

  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: (type, fields) => metrics.push({ type, ...fields }),
    sessions,
    activeConnections,
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => false,
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  await spawnListeners[0]({
    parentSessionKey: "agent:main:openai-user:meet-sid-delegate-caty-delegate",
    childKey: "agent:main:subagent:child-delegate",
    label: "delegate spawn",
  });

  assert.equal(handledSpawns[0].source, "delegate");
  assert.equal(handledSpawns[0].parentKind, "delegate");
  assert.equal(metrics.some((event) => (
    event.type === "subagent_spawned"
    && event.source === "delegate"
    && event.parent_kind === "delegate"
  )), true);
  tracker.close();
});

test("shared tracker retains ended route for late completions and stops after TTL cleanup", async () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-2",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
    delegationResults: [],
  };
  const sessions = new Map([[session.id, session]]);
  const activeConnections = new Map();
  const lateResults = [];

  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions,
    activeConnections,
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: (_sessionId, evt) => {
      lateResults.push(evt);
      session.gatewayDelegationState = { inFlightCount: 0, pendingQueueCount: 0 };
      return true;
    },
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  const retained = tracker.untrackGatewaySession(session.id, { retainIfDelegations: true, ttlMs: 50 });
  assert.equal(retained, true);
  assert.equal(gatewayEvents.stopCount, 0);

  await completionListeners[0]({
    parentSessionKey: "agent:main:openai-user:meet-sid-2-caty",
    childKey: "agent:main:subagent:late",
    label: "late",
    resultText: "done",
  });
  assert.equal(lateResults.length, 1);

  tracker._test.hardUntrackGatewaySession(session.id);
  assert.equal(gatewayEvents.stopCount, 1);
  tracker.close();
});

function fakeGatewayEvents(spawnListeners, completionListeners) {
  return {
    stopCount: 0,
    buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
    start() { return {}; },
    stop() { this.stopCount += 1; },
    verifySessionKey: async () => true,
    onSubagentSpawn(cb) {
      spawnListeners.push(cb);
      return () => {};
    },
    onSubagentCompletion(cb) {
      completionListeners.push(cb);
      return () => {};
    },
    onSessionReply() {
      return () => {};
    },
    onAnnounceInjected() {
      return () => {};
    },
  };
}
