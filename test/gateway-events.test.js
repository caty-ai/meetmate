const test = require("node:test");
const assert = require("node:assert/strict");

const gatewayEvents = require("../src/gateway-events");

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
};

test.before(() => {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
});

test.after(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
});

test.beforeEach(() => {
  gatewayEvents._test.reset();
});

test.afterEach(async () => {
  await gatewayEvents._test.drainActiveTasks();
  gatewayEvents._test.reset();
});

test("builds the verified connect handshake frame and session keys", () => {
  const frame = gatewayEvents._test.buildConnectFrame("1", {
    openclawToken: "secret",
    displayName: "Caty MeetServer",
    version: "0.1.0",
    platform: "darwin",
  });

  assert.equal(frame.type, "req");
  assert.equal(frame.method, "connect");
  assert.equal(frame.params.minProtocol, 4);
  assert.equal(frame.params.maxProtocol, 4);
  assert.equal(frame.params.client.id, "gateway-client");
  assert.equal(frame.params.client.mode, "backend");
  assert.deepEqual(frame.params.scopes, ["operator.read", "operator.write", "operator.admin"]);
  assert.equal(frame.params.auth.token, "secret");
  assert.equal(gatewayEvents.buildSessionKey("meet-abc-caty", "main"), "agent:main:openai-user:meet-abc-caty");
});

test("isDelegateSessionKey only matches delegate suffix", () => {
  assert.equal(gatewayEvents._test.isDelegateSessionKey("agent:main:openai-user:foo-delegate"), true);
  assert.equal(gatewayEvents._test.isDelegateSessionKey("agent:main:openai-user:foo-delegate-bar"), false);
});

test("delegate announce end frame does not emit a delegate reply or fetch reply text", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const replies = [];
  const announces = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "chat.history") {
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { messages: [{ role: "assistant", content: "announce text must not relay" }] },
        });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onSessionReply((evt) => replies.push(evt));
  gatewayEvents.onAnnounceInjected((evt) => announces.push(evt));
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });

  sockets[0].serverMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "n", ts: Date.now() },
  });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
      features: { methods: [], events: [] },
    },
  });
  await tick();

  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: "agent:main:openai-user:meet-123-caty-delegate",
      phase: "end",
      runId: "announce:v1:xyz",
    },
  });
  await tick();
  await tick();

  assert.equal(sent.some((frame) => frame.method === "chat.history"), false);
  assert.deepEqual(replies, []);
  assert.equal(announces.length, 1);
  assert.equal(announces[0].runId, "announce:v1:xyz");
  gatewayEvents._test.reset();
});

test("disabled start never constructs WebSocket", () => {
  gatewayEvents._test.reset();
  let constructed = 0;
  class DisabledWs {
    constructor() {
      constructed += 1;
    }
  }

  gatewayEvents.start({
    enabled: false,
    openclawUrl: "http://gateway.test",
    openclawToken: "secret",
    WebSocketImpl: DisabledWs,
  });

  assert.equal(constructed, 0);
  gatewayEvents._test.reset();
});

test("scrubs the configured token from WebSocket construction failures", () => {
  const token = ["gateway", "runtime", "token"].join("-");
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);

  class ThrowingWs {
    constructor() {
      throw new Error(`constructor rejected ${token}`);
    }
  }

  try {
    gatewayEvents.start({
      enabled: true,
      openclawUrl: "http://gateway.test:18789",
      openclawToken: token,
      WebSocketImpl: ThrowingWs,
    });

    const warning = warnings.find((line) => line.startsWith("⚠️  gateway-events WS construction failed:"));
    assert.ok(warning);
    assert.equal(warning.includes("[REDACTED]"), true);
    assert.equal(warning.includes(token), false);
  } finally {
    restoreWarn();
  }
});

test("scrubs the configured token from WebSocket error events", () => {
  const token = ["gateway", "socket", "token"].join("-");
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);
  const sockets = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    close() {
      this.listeners.get("close")?.({});
    }
    emitError(error) {
      this.listeners.get("error")?.(error);
    }
  }

  try {
    gatewayEvents.start({
      enabled: true,
      openclawUrl: "http://gateway.test:18789",
      openclawToken: token,
      WebSocketImpl: FakeWs,
    });
    sockets[0].emitError(new Error(`socket rejected ${token}`));

    const warning = warnings.find((line) => line.startsWith("⚠️  gateway-events WS error:"));
    assert.ok(warning);
    assert.equal(warning.includes("[REDACTED]"), true);
    assert.equal(warning.includes(token), false);
  } finally {
    restoreWarn();
  }
});

test("scrubs the configured token from connect rejection warnings", () => {
  const token = ["gateway", "connect", "token"].join("-");
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);
  const sockets = [];
  const sent = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      sent.push(JSON.parse(data));
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  try {
    gatewayEvents.start({
      enabled: true,
      openclawUrl: "http://gateway.test:18789",
      openclawToken: token,
      WebSocketImpl: FakeWs,
    });
    sockets[0].serverMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "scrub-connect" },
    });
    sockets[0].serverMessage({
      type: "res",
      id: sent[0].id,
      ok: false,
      error: { code: "AUTH_FAILED", message: `connect rejected ${token}` },
    });

    const warning = warnings.find((line) => line.startsWith("⚠️  gateway-events connect rejected:"));
    assert.ok(warning);
    assert.equal(warning.includes("[REDACTED]"), true);
    assert.equal(warning.includes(token), false);
  } finally {
    restoreWarn();
  }
});

test("scrubs the configured token from listener failures", async () => {
  const token = ["gateway", "listener", "token"].join("-");
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);
  const sockets = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  try {
    gatewayEvents.onSubagentSpawn(() => {
      throw new Error(`listener rejected ${token}`);
    });
    gatewayEvents.start({
      enabled: true,
      openclawUrl: "http://gateway.test:18789",
      openclawToken: token,
      WebSocketImpl: FakeWs,
    });
    sockets[0].serverMessage({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:subagent:scrub-listener",
        parentSessionKey: "agent:main:openai-user:meet-scrub-caty",
        reason: "create",
      },
    });
    await gatewayEvents._test.drainActiveTasks();

    const warning = warnings.find((line) => line.startsWith("⚠️  gateway-events listener failed:"));
    assert.ok(warning);
    assert.equal(warning.includes("[REDACTED]"), true);
    assert.equal(warning.includes(token), false);
  } finally {
    restoreWarn();
  }
});

test("parses hello-ok response envelope, subscribes, demuxes completion once, and ignores announce errors", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const completions = [];
  const spawns = [];

  class FakeWs {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "chat.history") {
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            messages: [
              { role: "user", content: "task" },
              { role: "assistant", content: "final result" },
            ],
          },
        });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onSubagentSpawn((evt) => spawns.push(evt));
  gatewayEvents.onSubagentCompletion((evt) => {
    completions.push(evt);
    return true;
  });
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });

  assert.equal(sockets.length, 1);
  sockets[0].serverMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "n", ts: Date.now() },
  });
  assert.equal(sent[0].method, "connect");
  assert.equal(sent[0].params.client.id, "gateway-client");
  assert.equal(sent[0].params.client.mode, "backend");

  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
      features: { methods: [], events: [] },
    },
  });
  await tick();
  assert.equal(gatewayEvents.isConnected(), true);
  assert.equal(sent.some((frame) => frame.method === "sessions.subscribe"), true);

  const parentSessionKey = "agent:main:openai-user:meet-123-caty";
  const childKey = "agent:main:subagent:child-1";
  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: childKey,
      reason: "create",
      parentSessionKey,
      label: "調査",
    },
  });
  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: childKey,
      reason: "create",
      parentSessionKey,
      label: "調査",
    },
  });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].label, "調査");
  assert.equal(typeof spawns[0].spawnAtMs, "number");

  const endPayload = {
    sessionKey: childKey,
    phase: "end",
    runId: "run-1",
  };
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload: endPayload });
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload: endPayload });
  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: childKey,
      reason: "subagent-status",
      parentSessionKey,
      label: "調査",
    },
  });
  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: parentSessionKey,
      phase: "error",
      runId: `announce:v1:${childKey}:run-1`,
    },
  });
  await tick();
  await tick();

  assert.equal(completions.length, 1);
  assert.equal(completions[0].childKey, childKey);
  assert.equal(completions[0].parentSessionKey, parentSessionKey);
  assert.equal(completions[0].label, "調査");
  assert.equal(completions[0].resultText, "final result");
  assert.equal(typeof completions[0].spawnAtMs, "number");
  gatewayEvents._test.reset();
});

test("subagent-status can complete after reconnect when create frame was missed", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const completions = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "chat.history") {
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { messages: [{ role: "assistant", content: "replayed result" }] },
        });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onSubagentCompletion((evt) => completions.push(evt));
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { scopes: ["operator.read", "operator.write", "operator.admin"] },
    },
  });
  await tick();

  const parentSessionKey = "agent:main:openai-user:meet-123-caty";
  const childKey = "agent:main:subagent:child-replay";
  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: childKey,
      reason: "subagent-status",
      parentSessionKey,
      label: "再接続後の調査",
    },
  });
  await tick();
  await tick();

  assert.equal(completions.length, 1);
  assert.equal(completions[0].parentSessionKey, parentSessionKey);
  assert.equal(completions[0].label, "再接続後の調査");
  assert.equal(completions[0].resultText, "replayed result");
  gatewayEvents._test.reset();
});

test("end-only completion recovers parent via sessions.resolve before routing", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const completions = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "sessions.resolve") {
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            key: frame.params.key,
            spawnedBy: "agent:main:openai-user:meet-123-caty",
            label: "resolved label",
          },
        });
      }
      if (frame.method === "chat.history") {
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { messages: [{ role: "assistant", content: "resolved result" }] },
        });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onSubagentCompletion((evt) => {
    completions.push(evt);
    return true;
  });
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { scopes: ["operator.read", "operator.write", "operator.admin"] },
    },
  });
  await tick();

  const childKey = "agent:main:subagent:end-only";
  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: childKey, phase: "end", runId: "run-end" },
  });
  await tick();
  await tick();

  assert.equal(completions.length, 1);
  assert.equal(completions[0].parentSessionKey, "agent:main:openai-user:meet-123-caty");
  assert.equal(completions[0].label, "resolved label");
  assert.equal(completions[0].resultText, "resolved result");
  gatewayEvents._test.reset();
});

test("concurrent parentless completions recover child metadata once", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const completions = [];
  const pendingResolveIds = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "sessions.resolve") {
        pendingResolveIds.push(frame.id);
      }
      if (frame.method === "chat.history") {
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { messages: [{ role: "assistant", content: "concurrent result" }] },
        });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onSubagentCompletion((evt) => {
    completions.push(evt);
    return true;
  });
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { scopes: ["operator.read", "operator.write", "operator.admin"] },
    },
  });
  await tick();

  const childKey = "agent:main:subagent:concurrent-parentless";
  const payload = { sessionKey: childKey, phase: "end", runId: "run-concurrent" };
  const first = gatewayEvents._test.handleSessionsChanged(payload);
  const second = gatewayEvents._test.handleSessionsChanged(payload);
  await tick();

  assert.deepEqual(sent.filter((frame) => frame.method === "sessions.resolve").map((frame) => frame.params.key), [childKey]);
  assert.equal(sent.some((frame) => frame.method === "sessions.list"), false);
  assert.equal(pendingResolveIds.length, 1);

  sockets[0].serverMessage({
    type: "res",
    id: pendingResolveIds[0],
    ok: true,
    payload: {
      key: childKey,
      spawnedBy: "agent:main:openai-user:meet-123-caty",
      label: "concurrent label",
    },
  });
  await Promise.all([first, second]);

  assert.equal(completions.length, 1);
  assert.equal(completions[0].parentSessionKey, "agent:main:openai-user:meet-123-caty");
  assert.equal(completions[0].label, "concurrent label");
  assert.equal(completions[0].resultText, "concurrent result");
  gatewayEvents._test.reset();
});

test("completion dedup waits for successful history fetch and retries duplicate end frames", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const completions = [];
  let historyAttempts = 0;

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "chat.history") {
        historyAttempts += 1;
        if (historyAttempts === 1) {
          this.serverMessage({ type: "res", id: frame.id, ok: false, error: { message: "temporary history failure" } });
          return;
        }
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { messages: [{ role: "assistant", content: "retry result" }] },
        });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onSubagentCompletion((evt) => {
    completions.push(evt);
    return true;
  });
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { scopes: ["operator.read", "operator.write", "operator.admin"] },
    },
  });
  await tick();

  const payload = {
    sessionKey: "agent:main:subagent:retry-child",
    parentSessionKey: "agent:main:openai-user:meet-123-caty",
    phase: "end",
    runId: "run-retry",
    label: "retry",
  };
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload });
  await tick();
  await tick();
  assert.equal(completions.length, 0);
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload });
  await tick();
  await tick();

  assert.equal(historyAttempts, 2);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].resultText, "retry result");
  gatewayEvents._test.reset();
});

test("delegate session end fetches reply text and dedupes by run", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const replies = [];
  let historyCalls = 0;

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "chat.history") {
        historyCalls += 1;
        this.serverMessage({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { messages: [{ role: "assistant", content: "delegate answer" }] },
        });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onSessionReply((evt) => replies.push(evt));
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: { type: "hello-ok", auth: { scopes: ["operator.read", "operator.write", "operator.admin"] } },
  });
  await tick();

  const payload = {
    sessionKey: "agent:main:openai-user:meet-123-caty-delegate",
    phase: "end",
    runId: "chatcmpl_delegate",
  };
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload });
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload });
  sockets[0].serverMessage({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: "agent:main:openai-user:meet-123-caty",
      phase: "end",
      runId: "chatcmpl_parent",
    },
  });
  await tick();
  await tick();

  assert.equal(historyCalls, 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].sessionKey, payload.sessionKey);
  assert.equal(replies[0].runId, "chatcmpl_delegate");
  assert.equal(replies[0].resultText, "delegate answer");
  gatewayEvents._test.reset();
});

test("announce run is detected once and compactSession sends sessions.compact", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];
  const announces = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "sessions.compact") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { ok: true, compacted: true } });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.onAnnounceInjected((evt) => announces.push(evt));
  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: { type: "hello-ok", auth: { scopes: ["operator.read", "operator.write", "operator.admin"] } },
  });
  await tick();

  const payload = {
    sessionKey: "agent:main:openai-user:meet-123-caty",
    phase: "end",
    runId: "announce:v1:child:run",
  };
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload });
  sockets[0].serverMessage({ type: "event", event: "sessions.changed", payload });
  await tick();

  assert.equal(announces.length, 1);
  assert.equal(announces[0].phase, "end");
  const compact = await gatewayEvents.compactSession("meet-123-caty", { maxLines: 40 });
  assert.equal(compact.ok, true);
  assert.equal(compact.compacted, true);
  assert.deepEqual(
    sent.find((frame) => frame.method === "sessions.compact").params,
    { key: "agent:main:openai-user:meet-123-caty", maxLines: 40 }
  );
  gatewayEvents._test.reset();
});

test("compactSession requires payload ok true and preserves compacted field", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
      if (frame.method === "sessions.compact") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { compacted: true } });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: { type: "hello-ok", auth: { scopes: ["operator.read", "operator.write", "operator.admin"] } },
  });
  await tick();

  const compact = await gatewayEvents.compactSession("meet-123-caty", { maxLines: 40 });
  assert.equal(compact.ok, false);
  assert.equal(compact.compacted, true);
  gatewayEvents._test.reset();
});

test("start is ref-counted and stale socket close does not clobber the live connection", async () => {
  gatewayEvents._test.reset();
  const sockets = [];
  const sent = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  const first = gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  const second = gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  assert.equal(first, second);
  assert.equal(sockets.length, 1);
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { scopes: ["operator.read", "operator.write", "operator.admin"] },
    },
  });
  await tick();
  assert.equal(gatewayEvents.isConnected(), true);

  gatewayEvents.stop();
  assert.equal(gatewayEvents.isConnected(), true);
  gatewayEvents.stop();
  assert.equal(gatewayEvents.isConnected(), false);

  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  assert.equal(sockets.length, 2);
  sockets[0].close();
  assert.equal(gatewayEvents.isConnected(), false);
  sockets[1].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n2" } });
  sockets[1].serverMessage({
    type: "res",
    id: sent.findLast((frame) => frame.method === "connect").id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { scopes: ["operator.read", "operator.write", "operator.admin"] },
    },
  });
  await tick();
  assert.equal(gatewayEvents.isConnected(), true);
  sockets[0].close();
  assert.equal(gatewayEvents.isConnected(), true);
  gatewayEvents._test.reset();
});

test("connect-time ok:false response logs, closes, and schedules reconnect", () => {
  const sockets = [];
  const sent = [];
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      this.closeCount = 0;
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      sent.push(JSON.parse(data));
    }
    close() {
      this.closeCount += 1;
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  try {
    gatewayEvents.start({
      enabled: true,
      openclawUrl: "http://gateway.test:18789",
      openclawToken: "secret",
      WebSocketImpl: FakeWs,
    });
    sockets[0].serverMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n", ts: Date.now() },
    });
    sockets[0].serverMessage({
      type: "res",
      id: sent[0].id,
      ok: false,
      error: { code: "INVALID_REQUEST", message: "missing scope: operator.read" },
    });

    assert.equal(sockets[0].closeCount, 1);
    assert.equal(warnings.some((line) => line.includes("INVALID_REQUEST") && line.includes("missing scope")), true);
  } finally {
    restoreWarn();
    gatewayEvents._test.reset();
  }
});

test("late ok:false for a non-connect id warns without closing or reconnecting", () => {
  const sockets = [];
  const sent = [];
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      this.closeCount = 0;
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      sent.push(JSON.parse(data));
    }
    close() {
      this.closeCount += 1;
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  try {
    gatewayEvents.start({
      enabled: true,
      openclawUrl: "http://gateway.test:18789",
      openclawToken: "secret",
      WebSocketImpl: FakeWs,
    });
    sockets[0].serverMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n", ts: Date.now() },
    });
    assert.equal(sent[0].method, "connect");

    sockets[0].serverMessage({
      type: "res",
      id: "timed-out-request",
      ok: false,
      error: { code: "TIMEOUT", message: "late request rejection" },
    });

    assert.equal(sockets[0].closeCount, 0);
    assert.equal(gatewayEvents.isConnected(), false);
    assert.equal(warnings.some((line) => line.includes("ignored late rejected response timed-out-request")), true);
  } finally {
    restoreWarn();
    gatewayEvents._test.reset();
  }
});

test("abort retry does not schedule after stop clears the pending request", async () => {
  const sockets = [];
  const sent = [];

  class FakeWs {
    constructor() {
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(name, cb) {
      this.listeners.set(name, cb);
    }
    send(data) {
      const frame = JSON.parse(data);
      sent.push(frame);
      if (frame.method === "sessions.subscribe") {
        this.serverMessage({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } });
      }
    }
    close() {
      this.listeners.get("close")?.({});
    }
    serverMessage(frame) {
      this.listeners.get("message")?.({ data: JSON.stringify(frame) });
    }
  }

  gatewayEvents.start({
    enabled: true,
    openclawUrl: "http://gateway.test:18789",
    openclawToken: "secret",
    WebSocketImpl: FakeWs,
  });
  sockets[0].serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
  sockets[0].serverMessage({
    type: "res",
    id: sent[0].id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { scopes: ["operator.read", "operator.write", "operator.admin"] },
    },
  });
  await tick();

  const abortPromise = gatewayEvents.abortSession("meet-123-caty");
  assert.equal(sent.filter((frame) => frame.method === "chat.abort").length, 1);

  gatewayEvents.stop();
  assert.equal(await abortPromise, false);
  await tick();
  assert.equal(sent.filter((frame) => frame.method === "chat.abort").length, 1);
});

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function captureConsoleWarn(warnings) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  return () => {
    console.warn = originalWarn;
  };
}
