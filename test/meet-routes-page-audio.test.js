"use strict";

// #266 page audio: routing, markers, echo gate and join validation in meet-routes.
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

const FIXED_SESSION_ID = "00000000-0000-4000-8000-000000000266";
const ORIGIN = "https://meetmate.example";
const RATE = 24_000;

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

function staticSettings(avatar) {
  return {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "test-model" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-secret" },
    tts: { provider: "fish-audio", apiKey: "fish-secret", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-secret", baseUrl: "app.attendee.dev" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
    avatar,
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
    this.sent = [];
  }
  send(payload) { this.sent.push(payload); }
  close() {}
  terminate() {}
  ping() {}
}

// A streamed /local-avatar/audio response as the session sees it.
class FakeAudioResponse extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.ended = false;
    this.writableNeedDrain = false;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  write(chunk) { this.frames.push(Buffer.from(chunk)); return true; }
  end() { this.ended = true; }
  decoded() {
    return this.frames.map((frame) => {
      assert.equal(frame.readUInt32BE(0), frame.length - 4);
      const headerLength = frame.readUInt16BE(4);
      return { header: JSON.parse(frame.subarray(6, 6 + headerLength).toString("utf8")), pcm: frame.subarray(6 + headerLength) };
    });
  }
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "page-audio-face-"));
  fs.writeFileSync(path.join(directory, "face.json"), JSON.stringify({ spec: "face-package/1", entry: "index.html", supports: ["speak", "level"] }));
  fs.writeFileSync(path.join(directory, "index.html"), "<!doctype html>");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function withRoutes(t, fn, { avatar = {}, hub } = {}) {
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const src = path.join(__dirname, "..", "src");
  const mockPaths = ["config.js", "pipeline.js", "gateway-warmup.js", "session-events.js", "slack-notifier.js", "summarizer.js",
    "agent-profile.js", "attendee-chat.js", "gateway-events.js", "metrics.js", "delegation-results.js",
    "gateway-session-tracker.js", "ui-routes.js", "paths.js"].map((name) => path.join(src, name));
  const cachePaths = [routesPath, path.join(src, "transport-meet", "local-avatar-session.js"), ...mockPaths];
  const previousCache = new Map(cachePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of cachePaths) delete require.cache[require.resolve(file)];

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-page-audio-"));
  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "attendee-secret",
    FISH_AUDIO_API_KEY: "fish-secret",
    SESSION_GRACE_CLOSE_MS: "10",
    ECHO_LOOP_COOLDOWN_MS: undefined,
    ECHO_GATE_CLOSED_BYPASS: "false",
    OPENCLAW_WORKSPACE: undefined,
  });
  const settings = staticSettings({ facePackageDir: facePackageDir(t), ...avatar });
  resolver.resetRuntimeForTest();
  readiness.reset();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: settings, revision: "b".repeat(64), fingerprint: "page-audio" },
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
  const originals = { request: https.request, get: http.get, uuid: crypto.randomUUID, load: Module._load, now: Date.now };
  const clock = { now: originals.now() };
  Date.now = () => clock.now;

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: RATE,
    TTS_PROVIDER: "fish-audio",
    ...(hub ? { HUB_CONFIG: hub } : {}),
    loadConfig: () => settings,
    resolveMessages: () => ({ delegation: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: (overrides = {}) => ({
      stt: { provider: "soniox", sampleRate: 16_000 },
      llm: { provider: "test", model: "test-model", gateway: { url: "http://gateway.invalid", token: "test" } },
      tts: { sampleRate: RATE, referenceId: "voice-id" },
      gatewayEvents: { enabled: false },
      hub: { debug: false },
      greeting: overrides.greeting || "",
      echoCooldownMs: 0,
    }),
    validateSttProviderApiKey: () => true,
  });
  installMock(path.join(src, "pipeline.js"), {
    createPipeline: (session, turnState, onAudio) => {
      const pipeline = new EventEmitter();
      Object.assign(pipeline, { session, turnState, onAudio, receivedAudio: [], sendAudio(buffer) { this.receivedAudio.push(buffer); },
        close() {}, getDelegationResults() { return []; } });
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  installMock(path.join(src, "gateway-warmup.js"), { warmUpGatewaySession: () => {} });
  installMock(path.join(src, "session-events.js"), {
    SessionLifecycle: class {
      constructor(sessionId) { this.sessionId = sessionId; this.state = "idle"; this.isTerminal = false; }
      transition(state) { this.state = state; this.isTerminal = ["completed", "failed"].includes(state); return true; }
      on() {}
      setConversationLog() {}
      toJSON() { return { sessionId: this.sessionId, state: this.state }; }
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
    createGatewaySessionTracker: () => ({ trackGatewaySession() {}, untrackGatewaySession() { return false; }, findGatewayRoute() { return null; } }),
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
      response.statusCode = requestOptions.path === "/api/v1/bots" ? 201 : 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", requestOptions.path === "/api/v1/bots" ? '{"id":"bot-page-audio"}' : "{}");
        response.emit("end");
      });
    };
    return request;
  };
  http.get = unavailableNgrokHttpGet;
  crypto.randomUUID = () => FIXED_SESSION_ID;

  const offline = async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); };
  try {
    const routes = require(routesPath);
    await routes.init({ detectNgrok: false, loadAvatar: false,
      readinessProbeOptions: { fetchFn: offline, requestFn: offline, httpGet: unavailableNgrokHttpGet } });
    routes._test.configureReadinessForTest({ fetchFn: offline, requestFn: offline, httpGet: unavailableNgrokHttpGet });
    const harness = {
      routes,
      clock,
      pipelines,
      join(fields) {
        return requestHttp(routes, "POST", "/join-meeting", {
          meetingUrl: "https://meet.google.com/abc-defg-hij", wsUrl: "wss://meetmate.example/realtime",
          conversationMode: "one_to_one", ...fields,
        });
      },
      leave() { return requestHttp(routes, "POST", "/leave-meeting", { sessionId: FIXED_SESSION_ID }); },
      launch() {
        const create = httpsRequests.find((request) => request.options.path === "/api/v1/bots");
        const url = new URL(JSON.parse(create.body).voice_agent_settings.url);
        return { capability: new URLSearchParams(url.hash.slice(1)).get("cap"), origin: url.origin };
      },
      connect() {
        const client = new FakeClient();
        clients.push(client);
        routes.handleWsConnection(client, { url: `/realtime?sid=${FIXED_SESSION_ID}`, socket: { remoteAddress: "127.0.0.1" } });
        return client;
      },
    };
    await fn(harness);
  } finally {
    for (const client of clients) { client.emit("close"); client.removeAllListeners(); }
    Date.now = originals.now;
    await new Promise((resolve) => setTimeout(resolve, 15));
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

// Joins with faceAudio=page, connects the bot socket, and emulates the host page.
async function pageSession(harness, fields = { avatarExperiment: "face-package", faceAudio: "page" }) {
  const join = await harness.join(fields);
  assert.equal(join.statusCode, 200, join.text);
  const credentials = harness.launch();
  const client = harness.connect();
  const pipeline = harness.pipelines.at(-1);
  const visual = pipeline.session.localAvatarSession;
  const connected = visual.connect(credentials);
  const page = {
    client, pipeline, visual, credentials, connected,
    open() {
      const res = new FakeAudioResponse();
      assert.equal(visual.openAudioStream({ ...credentials, generation: page.connected.generation, res, headers: {} }), true);
      page.res = res;
      return res;
    },
    heartbeat(fields = {}) {
      assert.equal(visual.recordHeartbeat({ audio: { state: "running", playedEpoch: -1, playedSample: 0, receivedSample: 0, ...fields } }), true);
    },
    chunk(outputEpoch, firstSampleIndex, ms = 100) {
      const samples = Math.round(RATE * ms / 1000);
      const buffer = Buffer.alloc(samples * 2, 1);
      pipeline.onAudio(buffer, { outputEpoch, firstSampleIndex, sampleRate: RATE });
      return samples;
    },
    mic() {
      const before = pipeline.receivedAudio.length;
      client.emit("message", Buffer.from(JSON.stringify({ trigger: "realtime_audio.mixed", data: { chunk: "AAAA" } })));
      return pipeline.receivedAudio.length > before; // true = passed the echo gate
    },
    markers() {
      const state = visual.readState({ ...credentials, generation: connected.generation, afterSequence: -1 });
      return state;
    },
    // bot_output frames decoded; every one carries TTS_SAMPLE_RATE.
    botOutputs() {
      return client.sent.map((item) => JSON.parse(item)).filter((item) => item.trigger === "realtime_audio.bot_output").map((item) => {
        assert.equal(item.data.sample_rate, RATE);
        return Buffer.from(item.data.chunk, "base64");
      });
    },
    // Audible WebSocket chunks (test PCM is never all-zero). §2.12 silence is counted separately.
    wsChunks() { return page.botOutputs().filter((pcm) => pcm.some((byte) => byte !== 0)).length; },
    // §2.12 keep-alive frames: all-zero PCM; returns their sample counts.
    silence() { return page.botOutputs().filter((pcm) => pcm.every((byte) => byte === 0)).map((pcm) => pcm.length / 2); },
    silenceSamples() { return page.silence().reduce((sum, samples) => sum + samples, 0); },
  };
  // Samples of pcm frames queued to the page on every stream this page opened.
  page.streams = [];
  const open = page.open;
  page.open = () => { const res = open(); page.streams.push(res); return res; };
  page.pageSamples = () => page.streams.flatMap((res) => res.decoded()).filter((item) => item.header.t === "pcm")
    .reduce((sum, item) => sum + item.pcm.length / 2, 0);
  page.open();
  page.heartbeat();
  return page;
}

test("validation: follow-settings, empty or non-face experiments, bad values and an enabled hub are 400", async (t) => {
  for (const [fields, avatar] of [
    [{ faceAudio: "page" }, { experiment: "face-package" }],
    [{ avatarExperiment: "", faceAudio: "page" }, { experiment: "face-package" }],
    [{ avatarExperiment: "hybrid-local-l0", faceAudio: "page" }, {}],
    [{ avatarExperiment: "face-package", faceAudio: "yes" }, {}],
  ]) {
    await withRoutes(t, async (harness) => {
      const response = await harness.join(fields);
      assert.equal(response.statusCode, 400, JSON.stringify(fields));
      assert.match(response.text, /faceAudio/);
    }, { avatar });
  }
  await withRoutes(t, async (harness) => {
    const response = await harness.join({ avatarExperiment: "face-package", faceAudio: "page" });
    assert.equal(response.statusCode, 400);
    assert.match(response.text, /hub/);
  }, { hub: { mode: "local", enabled: true, url: "ws://hub.invalid", tailMs: 300 } });
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    assert.equal(page.visual.pageAudio, true);
    assert.equal(page.pipeline.session.hubConfig.enabled, false);
  }, { hub: { mode: "local", enabled: false, url: "ws://hub.invalid", tailMs: 300 } });
});

test("routing: ready -> page with a page marker; not ready -> WebSocket with a marker after the send", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    page.chunk(0, 0);
    assert.equal(page.wsChunks(), 0);
    assert.deepEqual(page.silence(), [RATE / 10], "only all-zero PCM of matching length reaches the WebSocket");
    const frames = page.res.decoded();
    assert.deepEqual(frames.map((item) => item.header.t), ["pcm"]);
    assert.equal(frames[0].header.outputEpoch, 0);
    assert.equal(frames[0].pcm.length, RATE / 10 * 2);
    const pageMarker = page.markers();
    assert.equal(pageMarker.kind, "marker");
    assert.equal(pageMarker.outputEpoch, 0);
    assert.equal(pageMarker.audio, "page");

    page.res.emit("close"); // stream gone: not ready for the next epoch
    page.chunk(1, 0);
    assert.equal(page.wsChunks(), 1);
    assert.equal(page.silence().length, 1, "a WebSocket-routed epoch gets no silence mirror");
    const wsMarker = page.markers();
    assert.equal(wsMarker.outputEpoch, 1);
    assert.equal(wsMarker.audio, undefined);
  });
});

test("routing: a stale heartbeat or a suspended context sends the next epoch to the WebSocket", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    harness.clock.now += 1001;
    page.chunk(0, 0);
    assert.equal(page.wsChunks(), 1);
    assert.equal(page.res.frames.length, 0);
    page.open();
    page.heartbeat();
    page.chunk(1, 0);
    assert.equal(page.wsChunks(), 1, "fresh heartbeat routes the next epoch to the page");
    assert.equal(page.res.frames.length, 1);
    page.heartbeat({ state: "suspended" });
    page.chunk(2, 0);
    assert.equal(page.wsChunks(), 2);
    assert.equal(page.res.frames.length, 1);
  });
});

test("M3: a WebSocket-routed epoch closes an open page stream before its first bot_output send", async (t) => {
  await withRoutes(t, async (harness) => {
    for (const notReady of ["stale", "backlog"]) {
      const page = notReady === "stale" ? await pageSession(harness) : harness.page;
      harness.page = page;
      page.open();
      page.heartbeat();
      const epoch = notReady === "stale" ? 0 : 2;
      page.chunk(epoch, 0); // page-routed reply, its tail still playing on the page
      const order = [];
      const res = page.res;
      const send = page.client.send.bind(page.client);
      page.client.send = (payload) => { order.push("bot_output"); send(payload); };
      const end = res.end.bind(res);
      res.end = () => { order.push("stream-end"); end(); };
      if (notReady === "stale") harness.clock.now += 1001;
      else page.heartbeat({ playedEpoch: epoch, playedSample: 0, receivedSample: 3 * RATE }); // backlog > 2 s
      page.chunk(epoch + 1, 0);
      assert.deepEqual(order, ["stream-end", "bot_output"], notReady);
      assert.equal(res.frames.length, 1, "nothing of the WebSocket epoch reaches the page");
      page.client.send = send;
    }
  });
});

test("never both paths in one epoch: a mid-epoch stream death loses the tail; a page-lost epoch stays lost after reconnect", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    page.chunk(0, 0);
    const first = page.res;
    first.emit("close");
    assert.equal(page.visual.isPageLost(0), true);
    page.chunk(0, 2400);
    assert.equal(page.wsChunks(), 0, "no switch to the WebSocket mid-epoch");
    assert.equal(first.frames.length, 1, "no duplicate");
    const second = page.open(); // reconnect in the same generation
    page.heartbeat();
    page.chunk(0, 4800);
    assert.equal(second.frames.length, 0, "no replay and the page-lost epoch stays lost");
    assert.equal(page.wsChunks(), 0);
    page.chunk(1, 0);
    const frames = second.decoded();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].header.outputEpoch, 1);

    // A new page generation mid-epoch: the old stream ends, the in-flight epoch is page-lost and stays lost.
    page.chunk(1, 2400);
    assert.equal(second.frames.length, 2);
    page.connected = page.visual.connect(page.credentials);
    assert.equal(second.ended, true);
    assert.equal(page.visual.isPageLost(1), true);
    const third = page.open();
    page.heartbeat();
    page.chunk(1, 4800);
    assert.equal(third.frames.length, 0);
    page.chunk(3, 0);
    assert.deepEqual(third.decoded().map((item) => [item.header.outputEpoch, item.header.generation]), [[3, page.connected.generation]]);
    assert.equal(page.wsChunks(), 0);
    // Only all-zero PCM reached the WebSocket during page epochs, one frame per queued chunk,
    // and the lost chunks (epoch 0 after the death, epoch 1 after the new generation) got none.
    assert.deepEqual(page.silence(), [2400, 2400, 2400, 2400]);
    assert.equal(page.silenceSamples(), page.pageSamples());
    third.emit("close");

    // The other direction: an epoch that started on the WebSocket stays there even if the page becomes ready.
    second.emit("close");
    page.chunk(2, 0);
    page.open();
    page.heartbeat();
    page.chunk(2, 2400);
    assert.equal(page.wsChunks(), 2);
    assert.equal(page.res.frames.length, 0);
    assert.equal(page.silence().length, 4, "a WebSocket-routed epoch adds no silence");
  });
});

test("§2.12 mic keep-alive: a page epoch mirrors all-zero PCM whose total equals the queued samples", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    let first = 0;
    for (const ms of [100, 40, 250, 20]) first += page.chunk(0, first, ms);
    // An odd byte length is queued without its trailing byte; the mirror matches the queued length.
    page.pipeline.onAudio(Buffer.alloc(2 * 480 + 1, 1), { outputEpoch: 0, firstSampleIndex: first, sampleRate: RATE });
    assert.equal(page.wsChunks(), 0, "no audible PCM on the WebSocket");
    assert.deepEqual(page.silence(), [2400, 960, 6000, 480, 480]);
    assert.equal(page.silenceSamples(), page.pageSamples());
    assert.equal(page.silenceSamples(), first + 480);
    // The keep-alive never throws into the pipeline, and needs an open Attendee socket.
    page.client.send = () => { throw new Error("socket write failed"); };
    assert.doesNotThrow(() => page.chunk(0, first + 480));
    page.client.send = FakeClient.prototype.send.bind(page.client);
    page.client.readyState = 3;
    const sent = page.client.sent.length;
    page.chunk(0, first + 2880);
    assert.equal(page.client.sent.length, sent);
  });
});

test("§2.12: no silence for a failed push, a page-lost epoch or a cancelled epoch", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    page.chunk(0, 0);
    assert.equal(page.silence().length, 1);
    page.res.emit("close"); // epoch 0 page-lost
    page.chunk(0, 2400);
    page.chunk(0, 4800);
    assert.equal(page.silence().length, 1, "no silence for page-lost chunks");
    page.open();
    page.heartbeat();
    page.chunk(1, 0);
    assert.equal(page.silence().length, 2);
    page.pipeline.emit("playback_cancelled", { outputEpoch: 1, reason: "barge_in", monotonicTime: 1 });
    page.chunk(1, 2400); // a late chunk of the cancelled epoch: the push fails
    assert.equal(page.silence().length, 2, "no silence for a failed push");
    assert.equal(page.wsChunks(), 0);
    assert.equal(page.silenceSamples(), page.pageSamples());
  });
});

test("queue overflow closes the stream: the epoch loses its tail and the next epoch falls back", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    page.res.writableNeedDrain = true;
    for (let i = 0; i < 20; i++) page.chunk(0, i * 2400);
    assert.equal(page.res.ended, false);
    page.chunk(0, 20 * 2400);
    assert.equal(page.res.ended, true);
    assert.equal(page.visual.isPageLost(0), true);
    assert.equal(page.wsChunks(), 0);
    page.heartbeat();
    page.chunk(1, 0);
    assert.equal(page.wsChunks(), 1);
  });
});

test("cancel pushes an in-stream cancel frame, keeps the stream open, and a later epoch is still page-routed", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    page.res.writableNeedDrain = true;
    page.chunk(0, 0);
    page.chunk(0, 2400);
    page.res.writableNeedDrain = false;
    page.pipeline.emit("playback_cancelled", { outputEpoch: 0, reason: "barge_in", monotonicTime: 1 });
    const frames = page.res.decoded();
    assert.deepEqual(frames.map((item) => item.header.t), ["cancel"], "queued frames of the cancelled epoch are purged");
    assert.equal(frames[0].header.outputEpoch, 0);
    assert.equal(page.res.ended, false);
    page.heartbeat();
    page.chunk(1, 0);
    const after = page.res.decoded();
    assert.deepEqual(after.map((item) => item.header.t), ["cancel", "pcm"]);
    assert.equal(after[1].header.outputEpoch, 1);
    assert.ok(after[1].header.cancelEpoch > 0);
    assert.equal(page.wsChunks(), 0);
  });
});

test("echo gate: drops while projected or backlogged, releases after, re-opens within pathPad+cooldown of a cancel", async (t) => {
  await withRoutes(t, async (harness) => {
    const { PAGE_AUDIO_PATH_PAD_MS: pad, PAGE_AUDIO_LEAD_MS: lead, ECHO_LOOP_COOLDOWN_MS: cooldown } = harness.routes._test;
    assert.equal(pad, 300);
    const page = await pageSession(harness);
    harness.clock.now += pad + cooldown; // the beginSource reset window has passed
    assert.equal(page.mic(), true);
    const t0 = harness.clock.now;
    page.chunk(0, 0, 1000);
    const until = t0 + lead + 1000;
    assert.equal(page.pipeline.turnState.pageAudioUntil, until);
    harness.clock.now = until + pad + cooldown - 1;
    assert.equal(page.mic(), false, "projected page audio plus the path pad is dropped");
    harness.clock.now = until + pad + cooldown;
    assert.equal(page.mic(), true, "released after the projection");

    // Backlog hold extends the gate from a fresh heartbeat of the live page epoch.
    const t1 = harness.clock.now;
    page.heartbeat({ playedEpoch: 0, playedSample: 0, receivedSample: 3 * RATE });
    assert.equal(page.mic(), false);
    assert.equal(page.pipeline.turnState.pageAudioUntil, t1 + 3000);
    harness.clock.now = t1 + 100;
    assert.equal(page.mic(), false);

    // Barge-in: the gate re-opens within pathPad + cooldown even though the stale heartbeat is still fresh.
    page.pipeline.emit("playback_cancelled", { outputEpoch: 0, reason: "barge_in", monotonicTime: 1 });
    const t2 = harness.clock.now;
    assert.equal(page.pipeline.turnState.pageAudioUntil, t2);
    harness.clock.now = t2 + pad + cooldown - 1;
    assert.equal(page.mic(), false);
    harness.clock.now = t2 + pad + cooldown;
    page.heartbeat({ playedEpoch: 0, playedSample: 0, receivedSample: 3 * RATE }); // stale pre-cancel backlog
    assert.equal(page.mic(), true, "a stale pre-cancel heartbeat does not re-close the gate");

    // After the next page-routed send, only heartbeats of that epoch extend the hold.
    page.heartbeat();
    page.chunk(1, 0, 10);
    const t3 = harness.clock.now;
    page.heartbeat({ playedEpoch: 0, playedSample: 0, receivedSample: 3 * RATE });
    harness.clock.now = t3 + lead + 10 + pad + cooldown;
    assert.equal(page.mic(), true, "a heartbeat for another epoch is ignored");
  });
});

test("C1: a finished page reply with a zero-backlog heartbeat never pins the gate; a suspended backlog does not extend it", async (t) => {
  await withRoutes(t, async (harness) => {
    const { PAGE_AUDIO_PATH_PAD_MS: pad, PAGE_AUDIO_LEAD_MS: lead, ECHO_LOOP_COOLDOWN_MS: cooldown } = harness.routes._test;
    const page = await pageSession(harness);
    const t0 = harness.clock.now;
    page.chunk(0, 0, 1000);
    const open = t0 + lead + 1000 + pad + cooldown;
    for (let now = t0 + 1200; now < open + 3000; now += 100) {
      harness.clock.now = now;
      page.heartbeat({ playedEpoch: 0, playedSample: RATE, receivedSample: RATE }); // playback complete
      assert.equal(page.mic(), now >= open, `input at +${now - t0} ms`);
    }
    const t1 = harness.clock.now;
    page.heartbeat({ state: "suspended", playedEpoch: 0, playedSample: 0, receivedSample: 3 * RATE });
    assert.equal(page.mic(), true, "a suspended context's backlog does not hold the gate");
    assert.ok(page.pipeline.turnState.pageAudioUntil < t1);
  });
});

test("M2 + K1: a mid-epoch stream death releases the gate within pad + cooldown and markers still flow", async (t) => {
  await withRoutes(t, async (harness) => {
    const { PAGE_AUDIO_PATH_PAD_MS: pad, ECHO_LOOP_COOLDOWN_MS: cooldown } = harness.routes._test;
    const page = await pageSession(harness);
    page.chunk(0, 0, 1000);
    harness.clock.now += 100;
    page.res.emit("close"); // the rest of epoch 0 is page-lost and never plays
    const lostAt = harness.clock.now;
    assert.equal(page.mic(), false);
    assert.equal(page.pipeline.turnState.pageAudioUntil, lostAt);
    harness.clock.now = lostAt + pad + cooldown - 1;
    assert.equal(page.mic(), false);
    harness.clock.now = lostAt + pad + cooldown;
    assert.equal(page.mic(), true, "no hold for a tail that never plays");
    const before = page.visual.snapshot().sequence;
    page.chunk(0, RATE);
    assert.equal(page.wsChunks(), 0);
    assert.ok(page.visual.snapshot().sequence > before, "a marker is published although the push failed");
    assert.equal(page.markers().sampleIndex, RATE);
    assert.equal(page.mic(), true, "a later lost chunk does not re-close the gate");
  });
});

test("G1: after a bot WebSocket reconnect one session close triggers exactly one reset", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    const first = page.pipeline.turnState;
    harness.connect();
    const second = harness.pipelines.at(-1).turnState;
    assert.notEqual(first, second);
    const firstValue = first.pageAudioUntil;
    harness.clock.now += 5000;
    assert.equal((await harness.leave()).statusCode, 200);
    assert.equal(second.pageAudioUntil, harness.clock.now);
    assert.equal(first.pageAudioUntil, firstValue, "the replaced connection's listener is gone");
  });
});

test("session close and leave reset pageAudioUntil and end the stream after a cancel frame", async (t) => {
  await withRoutes(t, async (harness) => {
    const page = await pageSession(harness);
    page.chunk(0, 0, 1000);
    harness.clock.now += 200;
    const turnState = page.pipeline.turnState;
    assert.ok(turnState.pageAudioUntil > harness.clock.now);
    assert.equal((await harness.leave()).statusCode, 200);
    assert.equal(turnState.pageAudioUntil, harness.clock.now);
    assert.equal(page.res.ended, true);
    assert.equal(page.res.decoded().at(-1).header.t, "cancel");
  });
});

test("DW1: with the mode off the bot_output send, marker-after-send and echo gate are unchanged", async (t) => {
  await withRoutes(t, async (harness) => {
    assert.equal((await harness.join({ avatarExperiment: "face-package" })).statusCode, 200);
    const credentials = harness.launch();
    const client = harness.connect();
    const pipeline = harness.pipelines.at(-1);
    const visual = pipeline.session.localAvatarSession;
    assert.equal(visual.pageAudio, undefined);
    assert.equal(Object.hasOwn(pipeline.turnState, "pageAudioUntil"), false);
    const connected = visual.connect(credentials);
    assert.equal(visual.openAudioStream({ ...credentials, generation: connected.generation, res: new FakeAudioResponse(), headers: {} }), false);
    assert.equal(visual.recordHeartbeat({ audio: { state: "running", playedEpoch: -1, playedSample: 0, receivedSample: 0 } }), false);

    pipeline.onAudio(Buffer.from([1, 0]), { outputEpoch: 0, firstSampleIndex: 0, sampleRate: RATE });
    assert.deepEqual(client.sent.map((item) => JSON.parse(item)), [{ trigger: "realtime_audio.bot_output", data: { chunk: "AQA=", sample_rate: RATE } }]);
    const marker = visual.readState({ ...credentials, generation: connected.generation, afterSequence: connected.sequence });
    assert.equal(marker.kind, "marker");
    assert.equal(marker.audio, undefined);
    const sequence = visual.snapshot().sequence;
    client.send = () => { throw new Error("audio send failure"); };
    pipeline.onAudio(Buffer.from([2, 0]), { outputEpoch: 0, firstSampleIndex: 1, sampleRate: RATE });
    assert.equal(visual.snapshot().sequence, sequence, "no marker without a successful send");

    const before = pipeline.receivedAudio.length;
    client.emit("message", Buffer.from(JSON.stringify({ trigger: "realtime_audio.mixed", data: { chunk: "AAAA" } })));
    assert.equal(pipeline.receivedAudio.length, before + 1, "the gate is open right after connect");
    assert.equal(client.sent.length, 1, "mode off never sends a silence mirror");
  });
});

// #274 page-audio settings default: join precedence through the real join route.
const SELF_HOSTED_ATTENDEE = "attendee.example.com";
const HUB_ON = Object.freeze({ mode: "local", enabled: true, url: "ws://hub.invalid", tailMs: 300 });
const HUB_OFF = Object.freeze({ mode: "local", enabled: false, url: "ws://hub.invalid", tailMs: 300 });

// Restarts the settings runtime inside a harness with a new boot snapshot (attendee_base_url is
// restart-required, so the effective host kind comes from the boot values).
function rebootSettings({ attendeeBaseUrl, avatar = {} }) {
  const runtime = resolver.getRuntime();
  const parsed = structuredClone(runtime.published.raw);
  parsed.avatar = { ...parsed.avatar, ...avatar };
  if (attendeeBaseUrl !== undefined) parsed.attendee = { ...parsed.attendee, baseUrl: attendeeBaseUrl };
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed, revision: "b".repeat(64), fingerprint: "page-audio" },
    startup: runtime.startup,
    serverPort: 5005,
  });
}

// Captures the Attendee bot-create bodies posted during fn (the harness mock stays in charge).
function captureBotCreates() {
  const bodies = [];
  const inner = https.request;
  https.request = (requestOptions, callback) => {
    const request = inner(requestOptions, callback);
    if (requestOptions.path === "/api/v1/bots") {
      const write = request.write;
      request.write = (chunk) => { bodies.push(String(chunk)); write(chunk); };
    }
    return request;
  };
  return bodies;
}

// The visual id and capability in the launch URL are random per session; everything else must be
// identical. The bot image is compared by digest to keep assertion diffs small.
function normalizedBotCreate(body) {
  const parsed = JSON.parse(body);
  if (parsed.voice_agent_settings?.url) {
    parsed.voice_agent_settings.url = parsed.voice_agent_settings.url.replace(/\?v=[^#]*/, "?v=<visual>").replace(/#.*$/, "#<capability>");
  }
  if (typeof parsed.bot_image?.data === "string") {
    parsed.bot_image.data = `sha256:${crypto.createHash("sha256").update(parsed.bot_image.data).digest("hex")}`;
  }
  return parsed;
}

async function defaultJoin(t, { field, faceAudioDefault, host, avatar, hub }) {
  const logs = [];
  const log = t.mock.method(console, "log", (...args) => { logs.push(args.join(" ")); });
  let result;
  try {
    await withRoutes(t, async (harness) => {
      rebootSettings({ attendeeBaseUrl: host === "self-hosted" ? SELF_HOSTED_ATTENDEE : "app.attendee.dev" });
      const bodies = captureBotCreates();
      const fields = {};
      if (avatar === "face-package") fields.avatarExperiment = "face-package";
      if (avatar === "other") fields.avatarExperiment = "hybrid-local-l0";
      if (field !== undefined) fields.faceAudio = field;
      const response = await harness.join(fields);
      const session = harness.routes._test.meetingSessions.get(FIXED_SESSION_ID);
      result = {
        status: response.statusCode,
        text: response.text,
        pageAudio: session?.localAvatarSession?.pageAudio === true,
        localAvatar: Boolean(session?.localAvatarSession),
        botCreates: bodies.map(normalizedBotCreate),
        logs: logs.filter((line) => line.includes("page audio")),
      };
    }, {
      avatar: {
        ...(faceAudioDefault === undefined ? {} : { faceAudioDefault }),
        ...(avatar === "follow-settings" ? { experiment: "face-package" } : {}),
      },
      hub: hub === "on" ? HUB_ON : HUB_OFF,
    });
  } finally {
    log.mock.restore();
  }
  return result;
}

test("#274 T3 precedence matrix: explicit field wins; an absent field takes the default only when it can apply; never a 400", async (t) => {
  let cells = 0;
  for (const field of [undefined, "", "page"]) {
    for (const faceAudioDefault of ["", "page"]) {
      for (const host of ["cloud", "self-hosted"]) {
        for (const avatar of ["face-package", "follow-settings", "other"]) {
          for (const hub of ["off", "on"]) {
            const label = JSON.stringify({ field: field ?? "<absent>", faceAudioDefault, host, avatar, hub });
            const result = await defaultJoin(t, { field, faceAudioDefault, host, avatar, hub });
            cells += 1;
            if (field === "page") {
              if (avatar !== "face-package") {
                assert.equal(result.status, 400, label);
                assert.equal(result.text, "faceAudio=page は avatarExperiment=face-package を明示した参加でのみ利用できます。", label);
              } else if (hub === "on") {
                assert.equal(result.status, 400, label);
                assert.equal(result.text, "faceAudio=page はフロア調停（hub）が有効なセッションでは利用できません。", label);
              } else {
                assert.equal(result.status, 200, label);
                assert.equal(result.pageAudio, true, label);
                assert.deepEqual(result.logs, ["🔊  page audio on (source=explicit)"], label);
              }
              continue;
            }
            assert.equal(result.status, 200, `${label} ${result.text}`);
            assert.equal(result.localAvatar, avatar !== "follow-settings", label);
            const expectOn = field === undefined && faceAudioDefault === "page" && host === "self-hosted"
              && avatar === "face-package" && hub === "off";
            assert.equal(result.pageAudio, expectOn, label);
            if (expectOn) {
              assert.deepEqual(result.logs, ["🔊  page audio on (source=default)"], label);
            } else if (field === undefined && faceAudioDefault === "page") {
              const reason = host === "cloud" ? "cloud" : avatar !== "face-package" ? "not-face-package" : "hub";
              assert.deepEqual(result.logs, [`🔊  page audio default skipped (reason=${reason})`], label);
            } else {
              assert.deepEqual(result.logs, [], `${label}: no line for a never-touched default or an explicit off`);
            }
          }
        }
      }
    }
  }
  assert.equal(cells, 72);
});

test("#274 T3: absent field x page default x self-hosted x face-package x hub on -> 200 on the WebSocket path", async (t) => {
  const result = await defaultJoin(t, { field: undefined, faceAudioDefault: "page", host: "self-hosted", avatar: "face-package", hub: "on" });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.localAvatar, true);
  assert.equal(result.pageAudio, false);
  assert.equal(result.botCreates.length, 1);
});

test("#274 T3: an explicit faceAudio= beats a page default on self-hosted Attendee", async (t) => {
  const result = await defaultJoin(t, { field: "", faceAudioDefault: "page", host: "self-hosted", avatar: "face-package", hub: "off" });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.pageAudio, false);
  assert.deepEqual(result.logs, []);
});

test("#274 T4 unchanged default path: with no stored default the bot-create request and session flags equal an explicit-off join", async (t) => {
  for (const host of ["cloud", "self-hosted"]) {
    for (const avatar of ["face-package", "follow-settings", "other"]) {
      const label = `${host} ${avatar}`;
      const absent = await defaultJoin(t, { field: undefined, faceAudioDefault: undefined, host, avatar, hub: "off" });
      const explicitOff = await defaultJoin(t, { field: "", faceAudioDefault: undefined, host, avatar, hub: "off" });
      const storedEmpty = await defaultJoin(t, { field: undefined, faceAudioDefault: "", host, avatar, hub: "off" });
      for (const result of [absent, explicitOff, storedEmpty]) {
        assert.equal(result.status, 200, `${label} ${result.text}`);
        assert.equal(result.pageAudio, false, label);
        assert.deepEqual(result.logs, [], label);
        assert.equal(result.botCreates.length, 1, label);
      }
      assert.deepEqual(absent.botCreates, explicitOff.botCreates, label);
      assert.deepEqual(storedEmpty.botCreates, explicitOff.botCreates, label);
    }
  }
});

test("#274 T5 host switch: a stored page default is used on self-hosted and unused after a switch to cloud", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => { logs.push(args.join(" ")); });
  await withRoutes(t, async (harness) => {
    rebootSettings({ attendeeBaseUrl: SELF_HOSTED_ATTENDEE });
    const page = await pageSession(harness, { avatarExperiment: "face-package" });
    assert.equal(page.visual.pageAudio, true);
    assert.equal((await harness.leave()).statusCode, 200);
    rebootSettings({ attendeeBaseUrl: "app.attendee.dev" });
    const join = await harness.join({ avatarExperiment: "face-package" });
    assert.equal(join.statusCode, 200, join.text);
    assert.equal(harness.routes._test.meetingSessions.get(FIXED_SESSION_ID).localAvatarSession.pageAudio === true, false);
  }, { avatar: { faceAudioDefault: "page" }, hub: HUB_OFF });
  assert.deepEqual(logs.filter((line) => line.includes("page audio")),
    ["🔊  page audio on (source=default)", "🔊  page audio default skipped (reason=cloud)"]);
});
