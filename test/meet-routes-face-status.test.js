"use strict";

// #283 stage 2: face status of self-hosted face-package sessions in meet-routes (design v3.1 §6 T2–T9).
// Fake clock (Date.now) and a fake interval driven by the test; the bot WebSocket and the face
// page are emulated, the page through the LocalAvatarSession the join created.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { stringify } = require("node:querystring");

const resolver = require("../src/settings/resolver");
const readiness = require("../src/settings/readiness");

const SID = "00000000-0000-4000-8000-000000000283";
const SELF_HOSTED = "attendee.example.com";
const CLOUD = "app.attendee.dev";
const LOG_CODE = "MM-MMT-513";
const FACE = { avatarExperiment: "face-package" };

function installMock(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function unavailableNgrokHttpGet() {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  queueMicrotask(() => request.emit("error", Object.assign(new Error("ngrok unavailable in test"), { code: "ECONNREFUSED" })));
  return request;
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
  }
  send() {}
  close() {} // a slow close: the "close" event comes only when the test emits it
  terminate() {}
  ping() {}
}

// setInterval / clearInterval stand-ins: callbacks run only when the test ticks.
function fakeTimers() {
  const active = new Map();
  let next = 0;
  return {
    active,
    registered: [],
    setInterval(fn, ms) {
      const handle = { id: (next += 1), ms };
      active.set(handle, fn);
      this.registered.push({ handle, fn });
      return handle;
    },
    clearInterval(handle) { active.delete(handle); },
    tick() { for (const fn of [...active.values()]) fn(); },
  };
}

async function requestHttp(routes, method, url, formData = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5005 };
  req.destroy = () => {};
  const result = { statusCode: null, text: "" };
  const res = {
    writeHead(statusCode) { result.statusCode = statusCode; },
    end(body = "") { result.text += String(body); },
  };
  const pending = routes.handleHttp(req, res);
  await Promise.resolve();
  if (formData) req.emit("data", Buffer.from(stringify(formData)));
  req.emit("end");
  await pending;
  return result;
}

function facePackageDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "face-status-pkg-"));
  fs.writeFileSync(path.join(directory, "face.json"), JSON.stringify({ spec: "face-package/1", entry: "index.html", supports: ["speak", "level"] }));
  fs.writeFileSync(path.join(directory, "index.html"), "<!doctype html>");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function withRoutes(t, fn, { host = SELF_HOSTED, avatar = {}, botStatus = 201, warmupThrows = false, retainDelegations = false } = {}) {
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const src = path.join(__dirname, "..", "src");
  const mockPaths = ["config.js", "pipeline.js", "gateway-warmup.js", "session-events.js", "slack-notifier.js", "summarizer.js",
    "agent-profile.js", "attendee-chat.js", "gateway-events.js", "metrics.js", "delegation-results.js",
    "gateway-session-tracker.js", "ui-routes.js", "paths.js"].map((name) => path.join(src, name));
  const cachePaths = [routesPath, path.join(src, "transport-meet", "local-avatar-session.js"), ...mockPaths];
  const previousCache = new Map(cachePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of cachePaths) delete require.cache[require.resolve(file)];

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-face-status-"));
  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "attendee-secret",
    FISH_AUDIO_API_KEY: "fish-secret",
    SESSION_GRACE_CLOSE_MS: "10",
    ECHO_LOOP_COOLDOWN_MS: undefined,
    ECHO_GATE_CLOSED_BYPASS: "false",
    OPENCLAW_WORKSPACE: undefined,
  });
  const settings = {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "test-model" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-secret" },
    tts: { provider: "fish-audio", apiKey: "fish-secret", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-secret", baseUrl: host },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
    avatar: { facePackageDir: facePackageDir(t), ...avatar },
  };
  resolver.resetRuntimeForTest();
  readiness.reset();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: settings, revision: "c".repeat(64), fingerprint: "face-status" },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}), dotenvSeeds: Object.freeze({}), resolvedHome: homeDir,
      configPath: path.join(homeDir, "config.json"),
      connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: "gateway-secret", openaiApiKey: "" }),
    }),
    serverPort: 5005,
  });
  for (const system of readiness.gateSystems()) readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });

  const pipelines = [];
  const clients = [];
  const httpsRequests = [];
  const logs = [];
  const originals = { request: https.request, get: http.get, uuid: crypto.randomUUID, load: Module._load, now: Date.now,
    log: console.log, warn: console.warn, error: console.error };
  const clock = { now: originals.now() };
  Date.now = () => clock.now;
  console.log = (...args) => logs.push({ level: "info", text: args.join(" ") });
  console.warn = (...args) => logs.push({ level: "warn", text: args.join(" ") });
  console.error = (...args) => logs.push({ level: "error", text: args.join(" ") });

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: 24_000,
    TTS_PROVIDER: "fish-audio",
    loadConfig: () => settings,
    resolveMessages: () => ({ delegation: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: () => ({
      stt: { provider: "soniox", sampleRate: 16_000 },
      llm: { provider: "test", model: "test-model", gateway: { url: "http://gateway.invalid", token: "test" } },
      tts: { sampleRate: 24_000, referenceId: "voice-id" },
      gatewayEvents: { enabled: false },
      hub: { debug: false },
      greeting: "",
      echoCooldownMs: 0,
    }),
    validateSttProviderApiKey: () => true,
  });
  installMock(path.join(src, "pipeline.js"), {
    createPipeline: (session, turnState, onAudio) => {
      const pipeline = new EventEmitter();
      Object.assign(pipeline, { session, turnState, onAudio, sendAudio() {}, close() {}, getDelegationResults() { return []; } });
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  installMock(path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: () => { if (warmupThrows) throw new Error("warm-up exploded"); },
  });
  installMock(path.join(src, "session-events.js"), {
    SessionLifecycle: class {
      constructor(sessionId) { this.sessionId = sessionId; this.state = "idle"; this.isTerminal = false; }
      transition(state) { this.state = state; this.isTerminal = ["completed", "failed"].includes(state); return true; }
      on() {}
      setConversationLog() {}
    },
  });
  installMock(path.join(src, "slack-notifier.js"), {
    SlackNotifier: class {
      postStatus() { return Promise.resolve(); }
      startElapsedUpdates() {}
      stopElapsedUpdates() {}
      postSummary() { return Promise.resolve(); }
      postTranscript() { return Promise.resolve(); }
    },
  });
  installMock(path.join(src, "summarizer.js"), { summarizeConversation: async () => "" });
  installMock(path.join(src, "agent-profile.js"), {
    resolveAgentProfile: () => ({ agentId: "caty", name: "Caty", displayName: "Caty", attendeeApiKey: "attendee-secret", wakeWords: ["ケイティ"] }),
    AgentNotFoundError: class AgentNotFoundError extends Error {},
  });
  installMock(path.join(src, "attendee-chat.js"), { sendAttendeeChatMessage: async () => true });
  installMock(path.join(src, "gateway-events.js"), {});
  installMock(path.join(src, "metrics.js"), { recordEvent: () => {} });
  installMock(path.join(src, "delegation-results.js"), { buildDelegationResultsSection: () => "" });
  installMock(path.join(src, "gateway-session-tracker.js"), {
    createGatewaySessionTracker: () => ({ trackGatewaySession() {}, untrackGatewaySession() { return retainDelegations; }, findGatewayRoute() { return null; } }),
  });
  installMock(path.join(src, "ui-routes.js"), { serveLocalAvatar: () => false, servePublicAsset: () => false, sendMetricsSummary: async () => false });
  installMock(path.join(src, "paths.js"), {
    logsDir: () => path.join(homeDir, "logs"),
    avatarCachePath: () => path.join(homeDir, "avatar.png"),
    bundledAssetPath: (name) => path.join(homeDir, name),
    bundledPublicDir: () => homeDir,
  });
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@deepgram/sdk") return { createClient: () => ({ agent: () => new EventEmitter() }), AgentEvents: {} };
    return originals.load.call(this, request, parent, isMain);
  };
  https.request = (requestOptions, callback) => {
    const request = new EventEmitter();
    const record = { options: requestOptions, body: "" };
    httpsRequests.push(record);
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = (chunk) => { record.body += String(chunk); };
    request.end = () => {
      const response = new EventEmitter();
      const create = requestOptions.path === "/api/v1/bots";
      response.statusCode = create ? botStatus : 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", create && botStatus < 300 ? '{"id":"bot-face-status"}' : "{}");
        response.emit("end");
      });
    };
    return request;
  };
  http.get = unavailableNgrokHttpGet;
  crypto.randomUUID = () => SID;

  const offline = async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); };
  let routes = null;
  try {
    routes = require(routesPath);
    const timers = fakeTimers();
    routes._test.setFaceMonitorTimersForTest(timers);
    await routes.init({ detectNgrok: false, loadAvatar: false,
      readinessProbeOptions: { fetchFn: offline, requestFn: offline, httpGet: unavailableNgrokHttpGet } });
    routes._test.configureReadinessForTest({ fetchFn: offline, requestFn: offline, httpGet: unavailableNgrokHttpGet });
    const harness = {
      routes,
      clock,
      timers,
      pipelines,
      session: () => routes._test.meetingSessions.get(SID),
      join(fields = FACE) {
        return requestHttp(routes, "POST", "/join-meeting", {
          meetingUrl: "https://meet.google.com/abc-defg-hij", wsUrl: "wss://meetmate.example/realtime",
          conversationMode: "one_to_one", ...fields,
        });
      },
      leave() { return requestHttp(routes, "POST", "/leave-meeting", { sessionId: SID }); },
      async activeSessionText() { return (await requestHttp(routes, "GET", "/active-session")).text; },
      async face() {
        const body = JSON.parse(await harness.activeSessionText());
        assert.equal(body.sessions.length, 1);
        return body.sessions[0].face;
      },
      connectBot() {
        const client = new FakeClient();
        clients.push(client);
        routes.handleWsConnection(client, { url: `/realtime?sid=${SID}`, socket: { remoteAddress: "127.0.0.1" } });
        return client;
      },
      // The face page as the join launched it: same capability and origin as the launch URL.
      page() {
        const create = httpsRequests.find((request) => request.options.path === "/api/v1/bots");
        const url = new URL(JSON.parse(create.body).voice_agent_settings.url);
        const credentials = { capability: new URLSearchParams(url.hash.slice(1)).get("cap"), origin: url.origin };
        const visual = harness.session().localAvatarSession;
        assert.ok(visual, "a face page needs a visual session");
        return {
          visual,
          seen: () => visual.recordPageSeen(),
          connect: () => visual.connect(credentials).generation,
          poll: (generation) => visual.recordPoll(generation),
        };
      },
      // Advances the clock in monitor-interval steps, ticking after each; onStep(now) may poll.
      advance(ms, onStep) {
        let left = ms;
        while (left > 0) {
          const step = Math.min(left, routes._test.FACE_MONITOR_INTERVAL_MS);
          clock.now += step;
          left -= step;
          onStep?.(clock.now);
          timers.tick();
        }
      },
      faceLogs: () => logs.filter((line) => line.text.includes(LOG_CODE) || /\bface (connected|recovered)\b/.test(line.text)),
      logs,
    };
    await fn(harness);
  } finally {
    for (const client of clients) { client.emit("close"); client.removeAllListeners(); }
    for (const sid of [...(routes?._test.meetingSessions.keys() || [])]) routes._test.deleteSessionAndRelease(sid);
    Date.now = originals.now;
    await new Promise((resolve) => setTimeout(resolve, 15));
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    https.request = originals.request;
    http.get = originals.get;
    crypto.randomUUID = originals.uuid;
    Module._load = originals.load;
    restoreEnv();
    readiness.reset();
    resolver.resetRuntimeForTest();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const file of cachePaths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
  }
}

async function joinFace(harness, fields = FACE) {
  const join = await harness.join(fields);
  assert.equal(join.statusCode, 200, join.text);
  return join;
}

function assertNoSecrets(harness) {
  const page = harness.session()?.localAvatarSession;
  for (const { text } of harness.faceLogs()) {
    assert.doesNotMatch(text, /https?:\/\/|wss?:\/\/|cap=|Bearer|secret/i, text);
    if (page) assert.equal(text.includes(page.visualId), false, text);
  }
}

test("T2 S1: no page request -> missing after 30 s with one warn; a late page -> loading -> connected with one info", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "pending", reason: null });
    assert.equal(harness.timers.active.size, 1, "one session-scoped interval");
    assert.equal([...harness.timers.active.keys()][0].ms, 5_000);

    harness.connectBot();
    harness.advance(30_000);
    assert.equal((await harness.face()).state, "pending", "exactly 30 s is still inside the grace");
    harness.advance(5_000);
    const missing = await harness.face();
    assert.deepEqual(pick(missing, ["state", "reason"]), { state: "missing", reason: "page_not_requested" });
    assert.equal(missing.since, new Date(harness.clock.now).toISOString());
    harness.advance(60_000);
    assert.deepEqual(harness.faceLogs(), [
      { level: "warn", text: `⚠️  ${LOG_CODE}: face missing (reason=page_not_requested, 35s since bot connected, sid=${SID})` },
    ]);
    assert.equal((await harness.face()).since, missing.since, "since moves only on a change");

    const page = harness.page();
    page.seen();
    harness.advance(5_000);
    assert.equal((await harness.face()).state, "loading");
    harness.clock.now += 1_000;
    const generation = page.connect();
    harness.advance(5_000, () => page.poll(generation));
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "connected", reason: null });
    assert.deepEqual(harness.faceLogs().slice(1), [
      { level: "info", text: `🙂  face connected: page seen → ready 6s (sid=${SID})` },
    ]);
    assertNoSecrets(harness);
  });
});

test("T3 S2: page seen, no connect -> stalled after the ready grace; a connect -> connected", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    harness.connectBot();
    const page = harness.page();
    harness.clock.now += 1_000;
    page.seen();
    harness.advance(120_000);
    assert.equal((await harness.face()).state, "loading", "exactly the grace is still loading");
    harness.advance(5_000);
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "stalled", reason: "not_ready" });
    harness.advance(10_000);
    const generation = page.connect();
    harness.advance(5_000, () => page.poll(generation));
    assert.equal((await harness.face()).state, "connected");
    assert.deepEqual(harness.faceLogs().map(({ level, text }) => `${level} ${text}`), [
      `warn ⚠️  ${LOG_CODE}: face stalled (reason=not_ready, 126s since bot connected, sid=${SID})`,
      `info 🙂  face connected: page seen → ready 135s (sid=${SID})`,
      `info 🙂  face recovered from stalled (sid=${SID})`,
    ]);
    assertNoSecrets(harness);
  });
});

test("T4 S3: polls stop while the bot is connected -> lost; old-generation polls never count; resumed polls recover", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    harness.connectBot();
    const page = harness.page();
    page.seen();
    const first = page.connect();
    harness.advance(60_000, () => page.poll(first));
    assert.equal((await harness.face()).state, "connected");

    harness.advance(20_000);
    assert.equal((await harness.face()).state, "connected", "20 s without a poll is still inside the window");
    harness.advance(5_000);
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "lost", reason: "page_stopped" });

    // The page reconnects: measured from the new connect, and its old generation's polls do not count.
    const second = page.connect();
    assert.equal(second, first + 1);
    harness.advance(5_000, () => page.poll(first));
    assert.equal((await harness.face()).state, "connected");
    harness.advance(20_000, () => page.poll(first));
    assert.equal((await harness.face()).state, "lost", "no poll of the current generation since the reconnect");
    harness.advance(5_000, () => page.poll(second));
    assert.equal((await harness.face()).state, "connected");
    assert.deepEqual(harness.faceLogs().map(({ text }) => text.replace(/\d+s since/, "Ns since")), [
      `🙂  face connected: page seen → ready 0s (sid=${SID})`,
      `⚠️  ${LOG_CODE}: face lost (reason=page_stopped, Ns since bot connected, sid=${SID})`,
      `🙂  face recovered from lost (sid=${SID})`,
      `⚠️  ${LOG_CODE}: face lost (reason=page_stopped, Ns since bot connected, sid=${SID})`,
      `🙂  face recovered from lost (sid=${SID})`,
    ]);
  });
});

test("T5 S4: page seen then silence past the TTL -> the tick closes the visual session -> missing/page_expired, and it stays", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    harness.connectBot();
    const page = harness.page();
    page.seen();
    harness.advance(295_000);
    assert.equal((await harness.face()).state, "stalled");
    assert.equal(page.visual.snapshot().closed, false);
    harness.advance(10_000);
    assert.equal(page.visual.snapshot().closedReason, "expired", "the monitor's isLive() closed it");
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "missing", reason: "page_expired" });
    harness.advance(120_000);
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "missing", reason: "page_expired" });
    assert.deepEqual(harness.faceLogs().map(({ text }) => text.match(/face (\w+) \(reason=(\w+)/).slice(1).join("/")),
      ["stalled/not_ready", "missing/page_expired"]);
  });
});

test("T5 variants: the bot never connects -> pending past the TTL; the page never comes -> page_not_requested stays, one warn", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    const visual = harness.session().localAvatarSession;
    harness.advance(400_000);
    assert.equal(visual.snapshot().closedReason, "expired");
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "pending", reason: null });
    assert.deepEqual(harness.faceLogs(), []);
  });
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    const visual = harness.session().localAvatarSession;
    harness.connectBot();
    harness.advance(400_000);
    assert.equal(visual.snapshot().closedReason, "expired");
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "missing", reason: "page_not_requested" });
    assert.equal(harness.faceLogs().length, 1);
  });
});

test("T6 S0: a face package that fails to load -> join 200 and unavailable from the start", async (t) => {
  const missing = path.join(os.tmpdir(), `meetmate-missing-face-${crypto.randomBytes(6).toString("hex")}`);
  await withRoutes(t, async (harness) => {
    const join = await harness.join();
    assert.equal(join.statusCode, 200, join.text);
    assert.equal(harness.session().localAvatarSession, null, "no visual session: no face page will exist");
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "unavailable", reason: "package_load_failed" });
    assert.deepEqual(harness.faceLogs(), [
      { level: "warn", text: `⚠️  ${LOG_CODE}: face unavailable (reason=package_load_failed, bot not connected yet, sid=${SID})` },
    ]);
    harness.connectBot();
    harness.advance(60_000);
    assert.equal((await harness.face()).state, "unavailable");
    assert.equal(harness.faceLogs().length, 1);
  }, { avatar: { facePackageDir: missing } });
});

test("T7 reconnect, new connection before the old close: no false missing, lost still detected", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    const oldClient = harness.connectBot();
    const page = harness.page();
    page.seen();
    const generation = page.connect();
    harness.advance(10_000, () => page.poll(generation));
    const botFirstConnectedAt = harness.session().faceMonitor.botFirstConnectedAt;

    harness.advance(40_000, () => page.poll(generation));
    harness.connectBot();
    oldClient.emit("close"); // the superseded client's close handler runs afterwards
    await new Promise((resolve) => setTimeout(resolve, 20)); // past the finalize grace
    assert.equal(harness.session().faceMonitor.botFirstConnectedAt, botFirstConnectedAt, "a reconnect does not move it");
    assert.equal(harness.timers.active.size, 1, "the WebSocket close stopped nothing");
    harness.advance(60_000, () => page.poll(generation));
    assert.equal((await harness.face()).state, "connected");
    harness.advance(25_000);
    assert.equal((await harness.face()).state, "lost", "detection works on the new connection");
    assert.equal(harness.faceLogs().filter(({ text }) => text.includes("missing")).length, 0);
  });
});

test("T7 reconnect, old close before the new connection: no lost while the WebSocket is down", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    const oldClient = harness.connectBot();
    const page = harness.page();
    page.seen();
    const generation = page.connect();
    harness.advance(10_000, () => page.poll(generation));

    oldClient.emit("close");
    harness.advance(60_000); // the page is silent too, but the bot is not connected: rule 4 cannot fire
    assert.equal((await harness.face()).state, "connected");
    harness.connectBot();
    assert.equal(harness.timers.active.size, 1);
    harness.advance(5_000, () => page.poll(generation));
    assert.equal((await harness.face()).state, "connected", "fresh polls after the reconnect");
    harness.advance(25_000);
    assert.equal((await harness.face()).state, "lost");
    assert.equal(harness.faceLogs().filter(({ level }) => level === "warn").length, 1);
  });
});

test("T8 out of scope: cloud, non-face and MCP-style joins carry no face key and a byte-identical payload", async (t) => {
  const cases = [
    { label: "cloud face-package", host: CLOUD, fields: FACE, avatar: {} },
    { label: "self-hosted, no avatar experiment", host: SELF_HOSTED, fields: {}, avatar: {} },
    { label: "self-hosted rig", host: SELF_HOSTED, fields: { avatarExperiment: "hybrid-local-l0" }, avatar: {} },
    // MCP join_meeting never sends avatarExperiment, so a face-package setting is off for the join (C6).
    { label: "self-hosted MCP-style", host: SELF_HOSTED, fields: {}, avatar: { experiment: "face-package" } },
  ];
  for (const { label, host, fields, avatar } of cases) {
    await withRoutes(t, async (harness) => {
      await joinFace(harness, fields);
      harness.connectBot();
      harness.advance(60_000);
      const session = harness.session();
      assert.equal(harness.timers.registered.length, 0, `${label}: nothing is computed`);
      assert.equal(session.face, undefined, label);
      assert.equal(session.faceMonitor, undefined, label);
      // The pre-#283 payload, key order included.
      const fixture = JSON.stringify({ active: true, sessions: [{
        sessionId: SID, meetingUrl: "https://meet.google.com/abc-defg-hij", startedAt: session.startedAt,
        state: "in-progress", botId: "bot-face-status", hasConnection: true, agentIds: ["caty"], agentDisplayNames: ["Caty"],
      }] });
      assert.equal(await harness.activeSessionText(), fixture, label);
      assert.deepEqual(harness.faceLogs(), [], label);
    }, { host, avatar });
  }
});

test("T9 web-UI leave stops the monitor even with a slow WebSocket close; a retained session keeps face frozen", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    const client = harness.connectBot();
    const page = harness.page();
    page.seen();
    const generation = page.connect();
    harness.advance(10_000, () => page.poll(generation));
    const frozen = await harness.face();
    assert.equal(frozen.state, "connected");
    const [{ fn: callback }] = harness.timers.registered;

    const leave = await harness.leave();
    assert.equal(leave.statusCode, 200, leave.text);
    assert.equal(harness.timers.active.size, 0, "the interval is gone at the leave request");
    assert.equal(harness.session().faceMonitor.stopped, true);
    // The WebSocket still looks open (slow close) and the page has stopped: no false lost.
    const before = harness.faceLogs().length;
    harness.clock.now += 60_000;
    callback(); // even a stray callback after stop does nothing
    harness.advance(60_000);
    assert.deepEqual(await harness.face(), frozen, "retained for pending delegations: face stays frozen");
    assert.equal(harness.faceLogs().length, before);
    client.emit("close");
    harness.advance(10_000);
    assert.deepEqual(await harness.face(), frozen);
    assert.equal(harness.faceLogs().length, before);
  }, { retainDelegations: true });
});

test("T9 voice exit stops the monitor at the request, before the slow WebSocket close", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    const client = harness.connectBot();
    const page = harness.page();
    page.seen();
    const generation = page.connect();
    harness.advance(10_000, () => page.poll(generation));
    harness.pipelines.at(-1).emit("exit_requested", { trigger: "voice" });
    assert.equal(harness.timers.active.size, 0);
    harness.advance(60_000); // > FACE_PAGE_LOST_MS with the WebSocket still open
    assert.equal((await harness.face()).state, "connected");
    assert.equal(harness.faceLogs().some(({ text }) => text.includes("lost")), false);
    client.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 20)); // finalize after the grace
    assert.equal(harness.session(), undefined);
  });
});

test("T9 a plain bot disconnect: session_end via the finalize grace stops the monitor (retained session, face frozen)", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    const client = harness.connectBot();
    const page = harness.page();
    page.seen();
    const generation = page.connect();
    harness.advance(10_000, () => page.poll(generation));
    const frozen = await harness.face();
    assert.equal(frozen.state, "connected");

    // No leave request: the current WebSocket just closes. Retention keeps the session (and so
    // keeps deleteSessionAndRelease's safety stop out of play): only session_end can stop it.
    client.emit("close");
    assert.equal(harness.timers.active.size, 1, "the WebSocket close handler itself stops nothing");
    await new Promise((resolve) => setTimeout(resolve, 30)); // past SESSION_GRACE_CLOSE_MS
    assert.equal(page.visual.snapshot().closedReason, "session_end");
    assert.equal(harness.timers.active.size, 0, "session_end stopped the interval");
    assert.equal(harness.session().faceMonitor.stopped, true);
    const before = harness.faceLogs().length;
    harness.advance(120_000);
    assert.deepEqual(await harness.face(), frozen);
    assert.equal(harness.faceLogs().length, before);
  }, { retainDelegations: true });
});

test("T9 a stopped monitor ignores a later bot connect (botFirstConnectedAt stays unset)", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    harness.routes._test.finalizeSessionIfInactive(SID); // session_end before any bot connected; retained
    assert.equal(harness.session().faceMonitor.stopped, true);
    harness.connectBot();
    assert.equal(harness.session().faceMonitor.botFirstConnectedAt, null);
    harness.advance(60_000);
    assert.deepEqual(pick(await harness.face(), ["state", "reason"]), { state: "pending", reason: null });
    assert.deepEqual(harness.faceLogs(), []);
  }, { retainDelegations: true });
});

test("a failing status check logs one warn per session with the error name only", async (t) => {
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    harness.connectBot();
    const visual = harness.session().localAvatarSession;
    visual.snapshot = () => {
      throw Object.assign(new Error(`https://meetmate.example/local-avatar/face-host.html?v=${visual.visualId}#cap=secret`),
        { name: "TypeError" });
    };
    harness.advance(60_000);
    assert.deepEqual(harness.faceLogs(), [
      { level: "warn", text: `⚠️  ${LOG_CODE}: face status check failed (TypeError, sid=${SID})` },
    ]);
    assertNoSecrets(harness);
    assert.equal(harness.timers.active.size, 1, "the monitor keeps running");
  });
});

test("T9 an S0 session's leave leaves no interval", async (t) => {
  const missing = path.join(os.tmpdir(), `meetmate-missing-face-${crypto.randomBytes(6).toString("hex")}`);
  await withRoutes(t, async (harness) => {
    await joinFace(harness);
    assert.equal(harness.timers.active.size, 1);
    harness.connectBot();
    assert.equal((await harness.leave()).statusCode, 200);
    assert.equal(harness.timers.active.size, 0);
  }, { avatar: { facePackageDir: missing } });
});

test("T9 an upstream bot-launch failure (502) leaves no interval", async (t) => {
  await withRoutes(t, async (harness) => {
    const join = await harness.join();
    assert.equal(join.statusCode, 502, join.text);
    assert.match(join.text, /BOT_LAUNCH_UPSTREAM_ERROR/);
    assert.equal(harness.timers.registered.length, 1, "the monitor had started");
    assert.equal(harness.timers.active.size, 0);
    assert.equal(harness.session(), undefined);
  }, { botStatus: 400 });
});

test("T9 an exception in the join path (500) leaves no interval", async (t) => {
  await withRoutes(t, async (harness) => {
    const join = await harness.join();
    assert.equal(join.statusCode, 500, join.text);
    assert.equal(harness.timers.registered.length, 1, "the monitor had started");
    assert.equal(harness.timers.active.size, 0);
    assert.equal(harness.session(), undefined);
  }, { warmupThrows: true });
});

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value?.[key]]));
}
