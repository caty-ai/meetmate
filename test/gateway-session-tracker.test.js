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

test("retained route releases once when its TTL expires", async () => {
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
  const releases = [];

  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions,
    activeConnections,
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => true,
    onRetentionReleased: (...args) => releases.push(args),
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  const retained = tracker.untrackGatewaySession(session.id, { retainIfDelegations: true, ttlMs: 20 });
  assert.equal(retained, true);
  assert.equal(gatewayEvents.stopCount, 0);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(releases, [[session.id, "ttl"]]);
  assert.equal(tracker.findGatewayRoute("agent:main:openai-user:meet-sid-2-caty"), null);
  assert.equal(gatewayEvents.stopCount, 1);
  tracker.close();
});

test("late completion releases a settled retained route and cancels its TTL", async () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-settled",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
  };
  const lateResults = [];
  const releases = [];
  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions: new Map([[session.id, session]]),
    activeConnections: new Map(),
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: (sessionId, evt) => {
      lateResults.push([sessionId, evt]);
      return true;
    },
    onRetentionReleased: (...args) => releases.push(args),
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  const parentSessionKey = "agent:main:openai-user:meet-sid-settled-caty";
  const childKey = "agent:main:subagent:settled-child";
  await spawnListeners[0]({ parentSessionKey, childKey, label: "late child" });
  assert.equal(tracker.untrackGatewaySession(session.id, { retainIfDelegations: true, ttlMs: 30 }), true);

  await completionListeners[0]({
    parentSessionKey,
    childKey,
    label: "late child",
    resultText: "done",
  });

  assert.equal(lateResults.length, 1);
  assert.deepEqual(releases, [[session.id, "settled"]]);
  assert.equal(tracker.findGatewayRoute(parentSessionKey), null);
  assert.equal(gatewayEvents.stopCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(releases, [[session.id, "settled"]]);
  assert.equal(gatewayEvents.stopCount, 1);
  tracker.close();
});

test("immediate untrack does not fire the retention release hook", () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-immediate",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 0, pendingQueueCount: 0 },
  };
  const releases = [];
  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions: new Map([[session.id, session]]),
    activeConnections: new Map(),
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => true,
    onRetentionReleased: (...args) => releases.push(args),
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  assert.equal(tracker.untrackGatewaySession(session.id, { retainIfDelegations: true }), false);

  assert.deepEqual(releases, []);
  assert.equal(gatewayEvents.stopCount, 1);
  tracker.close();
});

test("closing the tracker does not fire the retention release hook", () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-close",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
  };
  const releases = [];
  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions: new Map([[session.id, session]]),
    activeConnections: new Map(),
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => true,
    onRetentionReleased: (...args) => releases.push(args),
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  assert.equal(tracker.untrackGatewaySession(session.id, { retainIfDelegations: true, ttlMs: 100 }), true);
  tracker.close();

  assert.deepEqual(releases, []);
  assert.equal(gatewayEvents.stopCount, 1);
});

test("re-tracking a retained route cancels retention and keeps late completion live", async () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-reconnect",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
  };
  const releases = [];
  const clearedTimers = [];
  const originalClearTimeout = global.clearTimeout;
  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions: new Map([[session.id, session]]),
    activeConnections: new Map(),
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => true,
    onRetentionReleased: (...args) => releases.push(args),
  });

  try {
    tracker.trackGatewaySession(session, { agentId: "caty" });
    const parentSessionKey = "agent:main:openai-user:meet-sid-reconnect-caty";
    const childKey = "agent:main:subagent:reconnect-child";
    await spawnListeners[0]({ parentSessionKey, childKey });
    assert.equal(tracker.untrackGatewaySession(session.id, { retainIfDelegations: true, ttlMs: 30 }), true);
    const previousRetainTimer = tracker._test.routes.get(session.id).retainTimer;

    global.clearTimeout = (timer) => {
      clearedTimers.push(timer);
      return originalClearTimeout(timer);
    };
    tracker.trackGatewaySession(session, { agentId: "caty" });

    const retrackedEntry = tracker._test.routes.get(session.id);
    assert.equal(retrackedEntry.ended, false);
    assert.equal(retrackedEntry.retainTimer, null);
    assert.equal(clearedTimers.includes(previousRetainTimer), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(releases, []);

    await completionListeners[0]({ parentSessionKey, childKey, resultText: "done after reconnect" });
    assert.deepEqual(releases, []);
    assert.equal(tracker._test.routes.get(session.id).ended, false);
  } finally {
    global.clearTimeout = originalClearTimeout;
    tracker.close();
  }
});

test("retained route waits until every tracked child completes", async () => {
  const spawnListeners = [];
  const completionListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners);
  const session = {
    id: "sid-two-children",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 2, pendingQueueCount: 0 },
  };
  const releases = [];
  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions: new Map([[session.id, session]]),
    activeConnections: new Map(),
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => true,
    onRetentionReleased: (...args) => releases.push(args),
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  const parentSessionKey = "agent:main:openai-user:meet-sid-two-children-caty";
  const firstChild = "agent:main:subagent:first";
  const secondChild = "agent:main:subagent:second";
  await spawnListeners[0]({ parentSessionKey, childKey: firstChild });
  await spawnListeners[0]({ parentSessionKey, childKey: secondChild });
  assert.equal(tracker.untrackGatewaySession(session.id, { retainIfDelegations: true, ttlMs: 100 }), true);

  await completionListeners[0]({ parentSessionKey, childKey: firstChild, resultText: "first done" });
  assert.deepEqual(releases, []);
  assert.notEqual(tracker.findGatewayRoute(parentSessionKey), null);

  await completionListeners[0]({ parentSessionKey, childKey: secondChild, resultText: "second done" });
  assert.deepEqual(releases, [[session.id, "settled"]]);
  assert.equal(tracker.findGatewayRoute(parentSessionKey), null);
  assert.equal(gatewayEvents.stopCount, 1);
  tracker.close();
});

test("late delegate-session reply releases an already settled retained route", async () => {
  const spawnListeners = [];
  const completionListeners = [];
  const replyListeners = [];
  const gatewayEvents = fakeGatewayEvents(spawnListeners, completionListeners, replyListeners);
  const session = {
    id: "sid-reply",
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
  };
  const lateResults = [];
  const releases = [];
  const tracker = createGatewaySessionTracker({
    gatewayEvents,
    recordEvent: () => {},
    sessions: new Map([[session.id, session]]),
    activeConnections: new Map(),
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: (sessionId, evt) => {
      lateResults.push([sessionId, evt]);
      return true;
    },
    onRetentionReleased: (...args) => releases.push(args),
  });

  tracker.trackGatewaySession(session, { agentId: "caty" });
  assert.equal(tracker.untrackGatewaySession(session.id, { retainIfDelegations: true, ttlMs: 100 }), true);
  await replyListeners[0]({
    sessionKey: "agent:main:openai-user:meet-sid-reply-caty-delegate",
    resultText: "delegate done",
  });

  assert.equal(lateResults.length, 1);
  assert.equal(lateResults[0][1].resultText, "delegate done");
  assert.deepEqual(releases, [[session.id, "settled"]]);
  assert.equal(gatewayEvents.stopCount, 1);
  tracker.close();
});

function fakeGatewayEvents(spawnListeners, completionListeners, replyListeners = []) {
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
    onSessionReply(cb) {
      replyListeners.push(cb);
      return () => {};
    },
    onAnnounceInjected() {
      return () => {};
    },
  };
}
