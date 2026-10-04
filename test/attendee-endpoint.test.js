"use strict";

// #260 PR A: src/attendee-endpoint.js custody, request builder and scrubbing, and the
// meet-routes session binding (T4, T5, T6, T11, T12 of the design; cloud slot only).

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { stringify } = require("node:querystring");
const { Readable } = require("node:stream");
const test = require("node:test");
const util = require("node:util");

const resolver = require("../src/settings/resolver");
const endpoint = require("../src/attendee-endpoint");

const { resolveBotHostTarget, attendeeRequest, scrubForTarget } = endpoint;

const SENTINEL = "SENTINEL-CREDENTIAL-a1b2c3";
const OTHER_SENTINEL = "SENTINEL-CREDENTIAL-z9y8x7";
const PROFILE_MARK = "SENTINEL-PROFILE-CREDENTIAL-q5";
const HOST = "attendee-one.example";
const OTHER_HOST = "attendee-two.example";

function useSettings({ apiKey, baseUrl, offset } = {}) {
  const attendee = {};
  if (apiKey !== undefined) attendee.apiKey = apiKey;
  if (baseUrl !== undefined) attendee.baseUrl = baseUrl;
  const parsed = { attendee };
  if (offset !== undefined) parsed.avatar = { faceTimelineOffsetMs: offset };
  const home = path.join(os.tmpdir(), "meetmate-attendee-endpoint-test");
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed, revision: "e".repeat(64), fingerprint: "attendee-endpoint" },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: home,
      configPath: path.join(home, "config.json"),
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
  });
}

function targetFor(settings) {
  useSettings(settings);
  try {
    return resolveBotHostTarget({ snapshot: "effective" });
  } finally {
    resolver.resetRuntimeForTest();
  }
}

// Replaces https.request with a recorder. `respond(record)` returns
// { statusCode, body } | { error } | { stall: true }.
function captureHttps(respond = () => ({ statusCode: 200, body: "{}" })) {
  const original = https.request;
  const records = [];
  https.request = (options, callback) => {
    const request = new EventEmitter();
    const record = { options, body: "", calls: [], destroyed: [] };
    records.push(record);
    request.setTimeout = (ms, onTimeout) => {
      record.calls.push("setTimeout");
      record.timeoutMs = ms;
      record.onTimeout = onTimeout;
      return request;
    };
    request.destroy = (error) => {
      record.destroyed.push(error);
      if (error) request.emit("error", error);
    };
    request.write = (chunk) => {
      record.calls.push("write");
      record.body += String(chunk);
      return true;
    };
    request.end = () => {
      record.calls.push("end");
      const outcome = respond(record);
      if (outcome.stall) return;
      queueMicrotask(() => {
        if (outcome.error) {
          request.emit("error", outcome.error);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = outcome.statusCode;
        callback(response);
        response.emit("data", outcome.body);
        response.emit("end");
        record.ended = true;
      });
    };
    return request;
  };
  return { records, restore: () => { https.request = original; } };
}

function captureConsole() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const method of ["log", "warn", "error"]) console[method] = (...args) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => Object.assign(console, original) };
}

function expectedOptions(hostname, credential, requestPath, body) {
  return {
    hostname,
    port: 443,
    path: requestPath,
    method: "POST",
    headers: {
      Authorization: `Token ${credential}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };
}

function assertSameRequestShape(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  assert.deepEqual(Object.keys(actual.headers), Object.keys(expected.headers));
}

// ── resolution ──────────────────────────────────────────────────────────────

test("cloud slot target: legacy entries, https/443, frozen, total on missing values", () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST, offset: -700 });
  assert.equal(Object.isFrozen(target), true);
  assert.deepEqual(Object.keys(target).sort(), ["basePath", "configured", "hostId", "hostname", "offsetMs", "port", "protocol", "targetId"]);
  assert.equal(target.hostId, "attendee-cloud");
  assert.equal(target.configured, true);
  assert.equal(target.protocol, "https");
  assert.equal(target.port, 443);
  assert.equal(target.hostname, HOST);
  assert.equal(target.basePath, "");
  assert.equal(target.offsetMs, -700);
  assert.equal(target.targetId.includes(SENTINEL), false);

  const unconfigured = targetFor({ baseUrl: HOST });
  assert.equal(unconfigured.configured, false);
  const defaults = targetFor({});
  assert.equal(defaults.configured, false);
  assert.equal(defaults.offsetMs, 300);
  assert.equal(defaults.port, 443);

  assert.throws(() => resolveBotHostTarget(), TypeError);
  assert.throws(() => resolveBotHostTarget({ snapshot: "boot" }), TypeError);
});

test("targetId follows the endpoint and the key without containing the key", () => {
  const first = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const same = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const otherKey = targetFor({ apiKey: OTHER_SENTINEL, baseUrl: HOST });
  const otherHost = targetFor({ apiKey: SENTINEL, baseUrl: OTHER_HOST });
  assert.equal(first.targetId, same.targetId);
  assert.notEqual(first.targetId, otherKey.targetId);
  assert.notEqual(first.targetId, otherHost.targetId);
  assert.notEqual(first, same, "every resolution is a new target object");
});

test("published snapshot reads saved values; effective keeps the boot value of restart-required entries", async () => {
  useSettings({ apiKey: SENTINEL, baseUrl: HOST });
  const capture = captureHttps();
  try {
    resolver.publishState({ exists: true, valid: true, parsed: { attendee: { apiKey: OTHER_SENTINEL, baseUrl: OTHER_HOST } } });
    const effective = resolveBotHostTarget({ snapshot: "effective" });
    const published = resolveBotHostTarget({ snapshot: "published" });
    assert.equal(effective.hostname, HOST);
    assert.equal(published.hostname, OTHER_HOST);
    await attendeeRequest(effective, { method: "POST", path: "/p", body: "{}" });
    await attendeeRequest(published, { method: "POST", path: "/p", body: "{}" });
    assert.equal(capture.records[0].options.headers.Authorization, `Token ${SENTINEL}`);
    assert.equal(capture.records[1].options.headers.Authorization, `Token ${OTHER_SENTINEL}`);
  } finally {
    capture.restore();
    resolver.resetRuntimeForTest();
  }
});

// ── T12 custody ─────────────────────────────────────────────────────────────

test("T12 custody: copies, clones, serialisation and inspection never carry the key", () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const views = [
    JSON.stringify({ ...target }),
    JSON.stringify(structuredClone(target)),
    JSON.stringify(target),
    util.inspect(target, { showHidden: true, depth: Infinity }),
    util.inspect(endpoint, { showHidden: true, depth: Infinity }),
  ];
  for (const view of views) assert.equal(view.includes(SENTINEL), false, view);
  assert.deepEqual(Object.keys(endpoint).sort(), ["attendeeRequest", "resolveBotHostTarget", "scrubForTarget"]);
});

test("T12 custody: a copied, cloned or hand-built target cannot make a request", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const capture = captureHttps();
  try {
    const forgeries = [
      { ...target },
      structuredClone(target),
      Object.assign({}, target),
      JSON.parse(JSON.stringify(target)),
      Object.freeze({ ...target }),
      new Proxy(target, {}),
      Object.create(target),
      null,
      undefined,
    ];
    for (const forged of forgeries) {
      const result = await attendeeRequest(forged, { method: "POST", path: "/api/v1/bots", body: "{}" });
      assert.equal(result.ok, false);
      assert.equal(result.code, "NOT_CONFIGURED");
    }
    assert.equal(capture.records.length, 0);

    const unconfigured = targetFor({ baseUrl: HOST });
    const result = await attendeeRequest(unconfigured, { method: "POST", path: "/api/v1/bots", body: "{}" });
    assert.equal(result.code, "NOT_CONFIGURED");
    assert.equal(capture.records.length, 0);
  } finally {
    capture.restore();
  }
});

test("T12 custody: no exported function hands the key back", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const capture = captureHttps(() => ({ statusCode: 200, body: `echo ${SENTINEL}` }));
  try {
    const result = await attendeeRequest(target, { method: "POST", path: "/x", body: "{}" });
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
    assert.equal(scrubForTarget(target, SENTINEL, { generic: false }).includes(SENTINEL), false);
    assert.equal(scrubForTarget(target, SENTINEL, { generic: true }).includes(SENTINEL), false);
  } finally {
    capture.restore();
  }
});

// ── builder and native dispatch (T6) ─────────────────────────────────────────

test("T6 builder: request(options, callback) shape, header order, body, write then end", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const capture = captureHttps(() => ({ statusCode: 201, body: '{"id":"bot-1"}' }));
  try {
    const body = JSON.stringify({ meeting_url: "https://meet.google.com/abc-defg-hij", bot_name: "ケイティ" });
    const result = await attendeeRequest(target, { method: "POST", path: "/api/v1/bots", body, timeoutMs: 1_234 });
    assert.deepEqual(result, { ok: true, statusCode: 201, text: '{"id":"bot-1"}' });
    const [record] = capture.records;
    assertSameRequestShape(record.options, expectedOptions(HOST, SENTINEL, "/api/v1/bots", body));
    assert.equal(record.body, body);
    assert.equal(record.timeoutMs, 1_234);
    assert.deepEqual(record.calls, ["setTimeout", "write", "end"]);
  } finally {
    capture.restore();
  }
});

test("T6 builder: https.request is looked up at call time", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const capture = captureHttps();
  try {
    await attendeeRequest(target, { method: "POST", path: "/late", body: "{}" });
    assert.equal(capture.records.length, 1);
  } finally {
    capture.restore();
  }
});

test("request failures: timeout, abort and network errors settle once and are scrubbed", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  let capture = captureHttps(() => ({ stall: true }));
  try {
    const pending = attendeeRequest(target, { method: "POST", path: "/t", body: "{}", timeoutMs: 50, timeoutMessage: "custom timeout" });
    capture.records[0].onTimeout();
    const timedOut = await pending;
    assert.equal(timedOut.code, "TIMEOUT");
    assert.equal(timedOut.error.message, "custom timeout");
    assert.equal(capture.records[0].destroyed.length, 1);

    const controller = new AbortController();
    const aborting = attendeeRequest(target, { method: "POST", path: "/a", body: "{}", signal: controller.signal });
    controller.abort(new Error("leave timeout"));
    const aborted = await aborting;
    assert.equal(aborted.code, "ABORTED");
    assert.equal(aborted.error.message, "leave timeout");
    assert.equal(capture.records[1].destroyed.length, 1);
    assert.equal(capture.records[1].destroyed[0].message, "leave timeout");
  } finally {
    capture.restore();
  }

  capture = captureHttps(() => ({ error: Object.assign(new Error(`connect failed Token ${SENTINEL}`), { code: "ECONNRESET" }) }));
  try {
    const failed = await attendeeRequest(target, { method: "POST", path: "/e", body: "{}" });
    assert.equal(failed.code, "NETWORK_ERROR");
    assert.equal(failed.error.code, "ECONNRESET");
    assert.equal(failed.error.message, "connect failed Token [REDACTED]");
    assert.equal(String(failed.error.stack).includes(SENTINEL), false);
  } finally {
    capture.restore();
  }
});

test("request failures: a timeout after the request already settled does not destroy it again", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const capture = captureHttps(() => ({ stall: true }));
  try {
    const controller = new AbortController();
    const pending = attendeeRequest(target, { method: "POST", path: "/a", body: "{}", timeoutMs: 50, signal: controller.signal });
    controller.abort(new Error("leave timeout"));
    const aborted = await pending;
    assert.equal(aborted.code, "ABORTED");
    capture.records[0].onTimeout();
    assert.equal(capture.records[0].destroyed.length, 1);
    assert.equal(capture.records[0].destroyed[0].message, "leave timeout");
  } finally {
    capture.restore();
  }
});

// Every view of a returned failure: serialisation, inspection and each own property of the error.
function assertFailureCarriesNo(result, sentinel) {
  assert.equal(result.ok, false);
  const views = [JSON.stringify(result), util.inspect(result, { showHidden: true, depth: Infinity })];
  for (const name of Object.getOwnPropertyNames(result.error)) views.push(`${name}=${String(result.error[name])}`);
  views.push(`code=${String(result.error.code)}`, `stack=${String(result.error.stack)}`, `cause=${String(result.error.cause)}`);
  for (const view of views) assert.equal(view.includes(sentinel), false, view);
}

test("custody: no property of a returned failure carries the key, whatever the request error holds", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const tainted = () => Object.assign(new Error(`connect failed ${SENTINEL}`), {
    code: `E_${SENTINEL}`,
    detail: SENTINEL,
    cause: new Error(SENTINEL),
  });
  let capture = captureHttps(() => ({ error: tainted() }));
  try {
    const failed = await attendeeRequest(target, { method: "POST", path: "/e", body: "{}" });
    assert.equal(failed.code, "NETWORK_ERROR");
    assert.equal(Object.hasOwn(failed.error, "code"), false);
    assertFailureCarriesNo(failed, SENTINEL);

    const controller = new AbortController();
    const aborting = attendeeRequest(target, { method: "POST", path: "/a", body: "{}", signal: controller.signal });
    controller.abort(tainted());
    const aborted = await aborting;
    assert.equal(aborted.code, "ABORTED");
    assertFailureCarriesNo(aborted, SENTINEL);
  } finally {
    capture.restore();
  }

  // A key that itself looks like an errno code: the pattern alone would let it through.
  const errnoShaped = "SENTINEL_ERRNO_SHAPED_CREDENTIAL";
  const shapedTarget = targetFor({ apiKey: errnoShaped, baseUrl: HOST });
  for (const code of [errnoShaped, `E${errnoShaped}_X`]) {
    capture = captureHttps(() => ({ error: Object.assign(new Error("connect failed"), { code }) }));
    try {
      const failed = await attendeeRequest(shapedTarget, { method: "POST", path: "/e", body: "{}" });
      assert.equal(Object.hasOwn(failed.error, "code"), false, code);
      assertFailureCarriesNo(failed, errnoShaped);
    } finally {
      capture.restore();
    }
  }

  capture = captureHttps(() => ({ error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }));
  try {
    const failed = await attendeeRequest(target, { method: "POST", path: "/e", body: "{}" });
    assert.equal(failed.error.code, "ECONNRESET");
  } finally {
    capture.restore();
  }
});

// ── scrubbing (T11 unit) ────────────────────────────────────────────────────

test("T11 scrubForTarget: literal-only keeps text byte-identical; generic adds the Token scheme", () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const prose = "response write failed after bot launch; token bucket refilled";
  assert.equal(scrubForTarget(target, prose, { generic: false }), prose);
  assert.equal(scrubForTarget(target, `x ${SENTINEL} y`, { generic: false }), "x [REDACTED] y");
  assert.equal(scrubForTarget(null, prose, { generic: false }), prose);
  assert.equal(scrubForTarget(target, undefined, { generic: false }), "undefined");
  assert.equal(scrubForTarget(target, "Authorization: Token other-value", { generic: true }), "Authorization: Token [REDACTED]");
  assert.equal(scrubForTarget(target, "the token bucket is full", { generic: true }), "the token bucket is full");
  assert.throws(() => scrubForTarget(target, prose), TypeError);
});

test("T11 attendeeRequest: an upstream body echoing the key comes back scrubbed", async () => {
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const echoes = [SENTINEL, `Authorization: Token ${SENTINEL}`, JSON.stringify({ api_key: SENTINEL, detail: `bad ${SENTINEL}` })];
  for (const echo of echoes) {
    const capture = captureHttps(() => ({ statusCode: 401, body: echo }));
    try {
      const result = await attendeeRequest(target, { method: "POST", path: "/x", body: "{}" });
      assert.equal(result.text.includes(SENTINEL), false, result.text);
      assert.equal(result.text.includes("[REDACTED]"), true);
    } finally {
      capture.restore();
    }
  }
});

// ── attendee-chat (T4 chat) ─────────────────────────────────────────────────

test("T4/T6 chat: request through the given target is byte-identical to the legacy shape", async () => {
  const { sendAttendeeChatMessage } = require("../src/attendee-chat");
  const target = targetFor({ apiKey: SENTINEL, baseUrl: HOST });
  const capture = captureHttps(() => ({ statusCode: 200, body: "{}" }));
  const output = captureConsole();
  try {
    assert.equal(await sendAttendeeChatMessage("bot-7", "hello", target), true);
  } finally {
    capture.restore();
    output.restore();
  }
  const body = JSON.stringify({ to: "everyone", message: "hello" });
  assertSameRequestShape(capture.records[0].options, expectedOptions(HOST, SENTINEL, "/api/v1/bots/bot-7/send_chat_message", body));
  assert.equal(capture.records[0].body, body);
  assert.equal(capture.records[0].timeoutMs, 10_000);
});

// ── meet-routes harness (T4, T5, T11) ───────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000260";

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

class FakeLifecycle extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.state = "created";
    this.isTerminal = false;
  }

  transition(state) {
    this.state = state;
    this.isTerminal = ["completed", "failed", "cancelled"].includes(state);
  }

  setConversationLog() {}
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.isAlive = true;
  }

  send() {}
  close() {}
  terminate() {}
  ping() {}
}

function formRequest(url, formData) {
  const req = Readable.from([Buffer.from(stringify(formData))]);
  Object.assign(req, {
    method: "POST",
    url,
    headers: { host: "meetmate.example", "content-type": "application/x-www-form-urlencoded" },
    socket: { remoteAddress: "198.51.100.44", localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

async function invoke(routes, url, formData, { throwOnSuccessEnd = false } = {}) {
  const output = { status: 0, text: "" };
  let thrown = false;
  const res = {
    writeHead(status) { output.status = status; },
    end(chunk = "") {
      if (throwOnSuccessEnd && output.status === 200 && !thrown) {
        thrown = true;
        throw new Error("response write failed after bot launch");
      }
      output.text += String(chunk);
    },
  };
  await routes.handleHttp(formRequest(url, formData), res);
  return output;
}

const JOIN_FORM = {
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  wsUrl: "wss://meetmate.example/realtime",
  conversationMode: "one_to_one",
};

async function withRoutes(run, options = {}) {
  const src = path.join(__dirname, "..", "src");
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const previousCache = new Map();
  const install = (relative, exports) => {
    const resolved = require.resolve(path.join(src, relative));
    previousCache.set(resolved, require.cache[resolved]);
    require.cache[resolved] = cacheEntry(resolved, exports);
  };
  // Mutable settings: the test changes them mid-meeting to prove nothing re-resolves.
  const settings = {
    attendee_base_url: HOST,
    attendee_api_key: SENTINEL,
    face_timeline_offset_ms: 300,
    avatar_experiment: "",
    slack_notifications_enabled: false,
    slack_notifications_target: "dm",
    task_extraction_enabled: false,
    agent_language: "ja",
    ...options.settings,
  };
  const pipelines = [];
  const clients = [];
  const leases = [];

  install("config.js", {
    getPipelineConfig: () => ({ llm: { provider: "test" }, gatewayEvents: {}, tts: {}, stt: {} }),
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: 24_000,
    TTS_PROVIDER: "fish-audio",
    HUB_CONFIG: { enabled: false },
    loadConfig: () => ({}),
    resolveMessages: () => ({ delegation: {}, prompts: { summary: "" }, slack: {} }),
    validateSttProviderApiKey: () => true,
  });
  install("pipeline.js", {
    createPipeline: (session, turnState, onAudio, config, pipelineOptions) => {
      const pipeline = new EventEmitter();
      Object.assign(pipeline, { options: pipelineOptions, sendAudio() {}, close() {}, getDelegationResults: () => [] });
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  install("gateway-warmup.js", { warmUpGatewaySession: () => {} });
  install("session-events.js", { SessionLifecycle: FakeLifecycle });
  install("slack-notifier.js", {
    SlackNotifier: class {
      postStatus() { return Promise.resolve(); }
      startElapsedUpdates() {}
      stopElapsedUpdates() {}
      postSummary() { return Promise.resolve(); }
      postTranscript() { return Promise.resolve(); }
    },
  });
  install("summarizer.js", { summarizeConversation: async () => "" });
  install("agent-profile.js", {
    // The profile key differs on purpose: it must never reach a request (v2.2 §4.3).
    resolveAgentProfile: () => ({ agentId: "caty", name: "Caty", displayName: "Caty", attendeeApiKey: PROFILE_MARK, wakeWords: ["ケイティ"] }),
    AgentNotFoundError: class AgentNotFoundError extends Error {},
  });
  install("gateway-events.js", {});
  install("metrics.js", { recordEvent: () => {} });
  install("delegation-results.js", { buildDelegationResultsSection: () => "" });
  install("gateway-session-tracker.js", {
    createGatewaySessionTracker: () => ({ trackGatewaySession: () => {}, untrackGatewaySession: () => false, findGatewayRoute: () => null }),
  });
  install("ui-routes.js", { servePublicAsset: () => false, serveLocalAvatar: () => false, sendMetricsSummary: async () => false });
  install("paths.js", {
    logsDir: () => path.join(os.tmpdir(), "meetmate-attendee-endpoint-logs"),
    avatarCachePath: () => path.join(os.tmpdir(), "meetmate-attendee-endpoint-avatar.png"),
    bundledAssetPath: (...parts) => path.join(src, ...parts),
    bundledPublicDir: () => path.join(src, "..", "public"),
    resolveHome: () => os.tmpdir(),
  });
  install("session-coordinator.js", {
    active: () => null,
    tryAcquire: (transport, sessionId) => {
      const lease = Object.freeze({ transport, sessionId });
      leases.push(lease);
      return lease;
    },
    release: () => {},
  });
  install(path.join("settings", "avatar-assets.js"), {
    AVATAR_FILE_LIMIT: 64 * 1024 * 1024,
    installUrlCacheAvatar: async () => {},
    readBundledAvatar: () => { throw new Error("no bundled avatar in test"); },
    readManagedAvatar: () => { throw new Error("no managed avatar in test"); },
  });
  install(path.join("settings", "resolver.js"), {
    getDiagnosticValue(key) {
      return {
        attendee_timeout_ms: 2_000,
        attendee_retry_attempts: options.retryAttempts || 1,
        attendee_retry_base_ms: 1,
        body_limit_bytes: 1024 * 1024,
        public_wss_url: "wss://meetmate.example",
      }[key];
    },
    getEffectiveValue: (key) => settings[key],
    getPublishedValue: (key) => (key === "server_ngrok_domain" ? "meetmate.example" : ""),
    getRawConfig: () => ({}),
    getStatus: () => ({ meetingReady: true, issues: [] }),
    meaningful: (value) => Boolean(value),
    registerCacheInvalidator: () => {},
    resolveDynamicSlackToken: () => "",
    readPath: () => undefined,
    getRuntime: () => ({ serverPort: 5005, startup: { resolvedHome: os.tmpdir() } }),
  });
  install(path.join("settings", "readiness.js"), {
    configure: () => {},
    bootstrap: async () => {},
    recheckPublic: async () => {},
    revalidateForJoin: async () => {},
    getReadiness: () => ({
      ready: true,
      blockers: [],
      systems: ["soniox", "fish-audio", "attendee", "llm", "tunnel"].map((id) => ({ id, code: "CONNECTED" })),
    }),
    createPublicRateLimiter: () => () => ({ allowed: true, retryAfterSeconds: 0 }),
  });
  install(path.join("settings", "probes.js"), { checkWsUrlIdentity: async () => ({ ok: true, code: "CONNECTED" }) });

  const capture = captureHttps((record) => {
    if (record.options.path === "/api/v1/bots") options.onCreate?.(settings);
    return options.respond?.(record) || (record.options.path === "/api/v1/bots"
      ? { statusCode: 201, body: JSON.stringify({ id: "bot-260" }) }
      : { statusCode: 200, body: "{}" });
  });
  const output = captureConsole();
  const previousGrace = process.env.SESSION_GRACE_CLOSE_MS;
  process.env.SESSION_GRACE_CLOSE_MS = "10";
  delete require.cache[routesPath];
  try {
    const routes = require(routesPath);
    await run({
      routes,
      settings,
      requests: capture.records,
      lines: output.lines,
      pipelines,
      leases,
      join: (invokeOptions) => invoke(routes, "/join-meeting", JOIN_FORM, invokeOptions),
      leave: () => invoke(routes, "/leave-meeting", { sessionId: SESSION_ID }),
      connect() {
        const client = new FakeClient();
        clients.push(client);
        routes.handleWsConnection(client, { url: `/realtime?sid=${SESSION_ID}`, socket: { remoteAddress: "127.0.0.1" } });
        return client;
      },
    });
  } finally {
    for (const client of clients) client.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 30));
    capture.restore();
    output.restore();
    if (previousGrace === undefined) delete process.env.SESSION_GRACE_CLOSE_MS;
    else process.env.SESSION_GRACE_CLOSE_MS = previousGrace;
    delete require.cache[routesPath];
    for (const [resolved, cached] of previousCache) {
      if (cached === undefined) delete require.cache[resolved];
      else require.cache[resolved] = cached;
    }
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function switchSettings(settings) {
  settings.attendee_base_url = OTHER_HOST;
  settings.attendee_api_key = OTHER_SENTINEL;
}

function assertJoinTimeTarget(record) {
  assert.equal(record.options.hostname, HOST, record.options.path);
  assert.equal(record.options.headers.Authorization, `Token ${SENTINEL}`, record.options.path);
}

function stubSessionIds(t) {
  const crypto = require("node:crypto");
  const original = crypto.randomUUID;
  crypto.randomUUID = () => SESSION_ID;
  t.after(() => { crypto.randomUUID = original; });
}

test("T4/T6 create: byte-identical request, profile key never used", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  await withRoutes(async ({ join, leave, requests }) => {
    const joined = await join();
    assert.equal(joined.status, 200, joined.text);
    const create = requests.find((record) => record.options.path === "/api/v1/bots");
    assertSameRequestShape(create.options, expectedOptions(HOST, SENTINEL, "/api/v1/bots", create.body));
    assert.equal(JSON.parse(create.body).meeting_url, JOIN_FORM.meetingUrl);
    assert.deepEqual(create.calls, ["setTimeout", "write", "end"]);
    assert.equal(create.timeoutMs, 2_000);
    await leave();
    await waitFor(() => requests.some((record) => record.ended && record.options.path.endsWith("/leave")));
    for (const record of requests) assert.equal(JSON.stringify(record).includes(PROFILE_MARK), false);
  });
});

test("T5 session binding: web_ui_leave and chat use the join-time target after a settings change", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  await withRoutes(async ({ join, leave, connect, pipelines, requests, settings }) => {
    assert.equal((await join()).status, 200);
    connect();
    await waitFor(() => pipelines.length === 1);
    switchSettings(settings);

    assert.equal(await pipelines[0].options.onChatMessage("hello"), true);
    const chat = requests.find((record) => record.options.path === "/api/v1/bots/bot-260/send_chat_message");
    assertJoinTimeTarget(chat);
    const chatBody = JSON.stringify({ to: "everyone", message: "hello" });
    assertSameRequestShape(chat.options, expectedOptions(HOST, SENTINEL, "/api/v1/bots/bot-260/send_chat_message", chatBody));

    assert.equal((await leave()).status, 200);
    await waitFor(() => requests.some((record) => record.ended && record.options.path.endsWith("/leave")));
    const leaveRecord = requests.find((record) => record.options.path === "/api/v1/bots/bot-260/leave");
    assertSameRequestShape(leaveRecord.options, expectedOptions(HOST, SENTINEL, "/api/v1/bots/bot-260/leave", "{}"));
    assert.equal(leaveRecord.body, "{}");
    assert.equal(requests.some((record) => record.options.hostname === OTHER_HOST), false);
  });
});

test("T5 session binding: exit_requested leave uses the join-time target", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  await withRoutes(async ({ join, connect, pipelines, requests, settings }) => {
    assert.equal((await join()).status, 200);
    connect();
    await waitFor(() => pipelines.length === 1);
    switchSettings(settings);
    pipelines[0].emit("exit_requested", { trigger: "test" });
    await waitFor(() => requests.some((record) => record.ended && record.options.path.endsWith("/leave")));
    const leaveRecord = requests.find((record) => record.options.path.endsWith("/leave"));
    assertSameRequestShape(leaveRecord.options, expectedOptions(HOST, SENTINEL, "/api/v1/bots/bot-260/leave", "{}"));
  });
});

test("T5 session binding: join_failed rollback after bot creation uses the join-time target", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  await withRoutes(async ({ join, requests, lines }) => {
    const failed = await join({ throwOnSuccessEnd: true });
    assert.equal(failed.status, 500);
    assert.equal(failed.text, "join-meeting エラー: response write failed after bot launch");
    const leaveRecord = requests.find((record) => record.options.path.endsWith("/leave"));
    assert.ok(leaveRecord, lines.join("\n"));
    assertSameRequestShape(leaveRecord.options, expectedOptions(HOST, SENTINEL, "/api/v1/bots/bot-260/leave", "{}"));
    assert.ok(lines.some((line) => line.startsWith("🚪  Attendee bot leave (join_failed): bot-260 → 200")), lines.join("\n"));
  }, { onCreate: switchSettings });
});

test("T5 recording the session fails after bot creation: rollback leaves with the join-time target", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  // No production hook: the session-bot map is module-private, so the insertion is made to
  // throw by intercepting Map#set for the one value shape it records ({ botId, target }).
  const originalSet = Map.prototype.set;
  t.after(() => { Map.prototype.set = originalSet; });
  await withRoutes(async ({ routes, join, requests, lines }) => {
    Map.prototype.set = function set(key, value) {
      if (value && typeof value === "object" && Object.hasOwn(value, "botId") && Object.hasOwn(value, "target")) {
        throw new Error("session record failed");
      }
      return originalSet.call(this, key, value);
    };
    let failed;
    try {
      failed = await join();
    } finally {
      Map.prototype.set = originalSet;
    }
    assert.equal(failed.status, 500, failed.text);
    assert.equal(failed.text, "join-meeting エラー: session record failed");
    await waitFor(() => requests.some((record) => record.ended && record.options.path.endsWith("/leave")));
    const leaveRecord = requests.find((record) => record.options.path.endsWith("/leave"));
    assertSameRequestShape(leaveRecord.options, expectedOptions(HOST, SENTINEL, "/api/v1/bots/bot-260/leave", "{}"));
    assert.equal(requests.some((record) => record.options.hostname === OTHER_HOST), false);
    assert.ok(lines.some((line) => line.startsWith("🚪  Attendee bot leave (join_failed): bot-260 → 200")), lines.join("\n"));
    assert.equal(routes._test.meetingSessions.has(SESSION_ID), false);
  }, { onCreate: switchSettings });
});

test("join success branch keeps its outcome for every create-response body shape", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  // [create body, bot recorded for the session (leave text), bot left on a join_failed rollback]
  const shapes = [
    ["not json", "bot=unknown", false],
    ["null", "bot=unknown", false],
    ["5", "bot=unknown", false],
    ['"bot-260"', "bot=unknown", false],
    ['{"id":7}', "bot=7", true],
    ['{"id":{"nested":1}}', "bot=[object Object]", false],
  ];
  for (const [body, leaveText, rolledBack] of shapes) {
    const respond = (record) => (record.options.path === "/api/v1/bots" ? { statusCode: 201, body } : null);
    await withRoutes(async ({ join, leave }) => {
      assert.equal((await join()).status, 200, body);
      const left = await leave();
      assert.equal(left.text, `退出リクエスト送信: session=${SESSION_ID}, ${leaveText}`, body);
    }, { respond });
    await withRoutes(async ({ join, requests }) => {
      assert.equal((await join({ throwOnSuccessEnd: true })).status, 500, body);
      assert.equal(requests.some((record) => record.options.path.endsWith("/leave")), rolledBack, body);
    }, { respond });
  }
});

test("T5 rollback before sessionBotIds.set: leave uses the target it is given", { concurrency: false }, async () => {
  await withRoutes(async ({ routes, requests, settings }) => {
    const target = resolveBotHostTarget({ snapshot: "effective" });
    switchSettings(settings);
    await routes._test.rollbackJoinAttempt({
      sessionId: "rollback-sid",
      lease: Object.freeze({ transport: "meet", sessionId: "rollback-sid" }),
      leaseCreated: true,
      sessionInserted: false,
      lifecycleCreated: false,
      botId: "bot-early",
      target,
    });
    assert.equal(requests.length, 1);
    assertSameRequestShape(requests[0].options, expectedOptions(HOST, SENTINEL, "/api/v1/bots/bot-early/leave", "{}"));
  });
});

// ── T11 hygiene through the routes ──────────────────────────────────────────

const ECHOES = [
  SENTINEL,
  `Authorization: Token ${SENTINEL}`,
  JSON.stringify({ detail: "rejected", api_key: SENTINEL, echo: `key=${SENTINEL}` }),
];

test("T11 create failure body echoing the key reaches no log and not the 502 body", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  for (const echo of ECHOES) {
    await withRoutes(async ({ join, lines }) => {
      const response = await join();
      assert.equal(response.status, 502);
      assert.equal(response.text.includes(SENTINEL), false);
      assert.ok(lines.some((line) => line.startsWith("❌  Bot起動失敗: 500")), lines.join("\n"));
      assert.equal(lines.some((line) => line.includes(SENTINEL)), false, lines.join("\n"));
    }, { respond: (record) => (record.options.path === "/api/v1/bots" ? { statusCode: 500, body: echo } : null) });
  }
});

test("T11 create network error echoing the key: retry warning, log and 500 body are scrubbed", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  await withRoutes(async ({ join, lines }) => {
    const response = await join();
    assert.equal(response.status, 500);
    assert.equal(response.text, "join-meeting エラー: connect refused [REDACTED]");
    assert.ok(lines.some((line) => line.startsWith("⚠️  Attendee API network retry 1/2")), lines.join("\n"));
    assert.equal(lines.some((line) => line.includes(SENTINEL)), false, lines.join("\n"));
  }, {
    retryAttempts: 2,
    respond: (record) => (record.options.path === "/api/v1/bots"
      ? { error: new Error(`connect refused ${SENTINEL}`) }
      : null),
  });
});

test("T11 leave and chat response bodies echoing the key reach no log", { concurrency: false }, async (t) => {
  stubSessionIds(t);
  for (const echo of ECHOES) {
    await withRoutes(async ({ join, leave, connect, pipelines, requests, lines }) => {
      assert.equal((await join()).status, 200);
      connect();
      await waitFor(() => pipelines.length === 1);
      await pipelines[0].options.onChatMessage("hello");
      await leave();
      await waitFor(() => requests.some((record) => record.ended && record.options.path.endsWith("/leave")));
      assert.ok(lines.some((line) => line.startsWith("💬  Attendee chat enqueue request")), lines.join("\n"));
      assert.ok(lines.some((line) => line.startsWith("🚪  Attendee bot leave (web_ui_leave)")), lines.join("\n"));
      assert.equal(lines.some((line) => line.includes(SENTINEL)), false, lines.join("\n"));
    }, { respond: (record) => (record.options.path === "/api/v1/bots" ? null : { statusCode: 200, body: echo }) });
  }
});
