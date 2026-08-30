"use strict";

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
const { sessionUserFor } = require("../src/session-user");

const FIXED_SESSION_ID = "00000000-0000-4000-8000-000000000199";

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

function installMock(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function staticSettings() {
  return {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "test-model" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-secret" },
    tts: { provider: "fish-audio", apiKey: "fish-secret", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-secret", baseUrl: "app.attendee.dev" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
  };
}

function initializeRuntime(homeDir) {
  resolver.resetRuntimeForTest();
  readiness.reset();
  resolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      parsed: staticSettings(),
      revision: "a".repeat(64),
      fingerprint: "characterization-attendee-audio",
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: homeDir,
      configPath: path.join(homeDir, "config.json"),
      connection: Object.freeze({
        openclawUrl: "https://gateway.example",
        openclawToken: "gateway-secret",
        openaiApiKey: "",
      }),
    }),
    serverPort: 5005,
  });
  for (const system of readiness.gateSystems()) {
    readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  }
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
    this.isAlive = true;
    this.sent = [];
    this.closed = [];
    this.terminated = 0;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code, reason) {
    this.closed.push({ code, reason });
  }

  terminate() {
    this.terminated += 1;
  }

  ping() {}
}

async function requestHttp(routes, method, url, formData = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5005 };
  req.destroy = () => {};
  const result = { statusCode: null, headers: null, text: "", body: null };
  const res = {
    writeHead(statusCode, responseHeaders) {
      result.statusCode = statusCode;
      result.headers = responseHeaders;
    },
    end(body = "") {
      result.text += Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      try {
        result.body = JSON.parse(result.text);
      } catch {
        result.body = null;
      }
    },
  };
  const pending = routes.handleHttp(req, res);
  await Promise.resolve();
  if (formData) req.emit("data", Buffer.from(stringify(formData)));
  req.emit("end");
  await pending;
  return result;
}

async function withAudioRoutes(fn, options = {}) {
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const src = path.join(__dirname, "..", "src");
  const mockPaths = [
    "config.js",
    "pipeline.js",
    "gateway-warmup.js",
    "session-events.js",
    "slack-notifier.js",
    "summarizer.js",
    "agent-profile.js",
    "attendee-chat.js",
    "gateway-events.js",
    "metrics.js",
    "delegation-results.js",
    "gateway-session-tracker.js",
    "ui-routes.js",
    "paths.js",
  ].map((name) => path.join(src, name));
  const cachePaths = [routesPath, ...mockPaths];
  const previousCache = new Map(cachePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of cachePaths) delete require.cache[require.resolve(file)];

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-char-audio-"));
  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "attendee-secret",
    FISH_AUDIO_API_KEY: "fish-secret",
    SESSION_GRACE_CLOSE_MS: "10",
    ECHO_GATE_CLOSED_BYPASS: options.echoGateClosedBypass ? "true" : "false",
    OPENCLAW_WORKSPACE: undefined,
  });
  initializeRuntime(homeDir);

  const pipelines = [];
  const clients = [];
  const httpsRequests = [];
  const originalHttpsRequest = https.request;
  const originalHttpGet = http.get;
  const originalRandomUUID = crypto.randomUUID;
  const originalLoad = Module._load;

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: 24_000,
    TTS_PROVIDER: "fish-audio",
    loadConfig: () => staticSettings(),
    resolveMessages: () => ({ delegation: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: (overrides = {}) => ({
      stt: { provider: "soniox", sampleRate: 16_000 },
      llm: { provider: "test", model: "test-model", gateway: { url: "http://gateway.invalid", token: "test" } },
      tts: { sampleRate: 24_000, referenceId: "voice-id" },
      gatewayEvents: { enabled: false },
      greeting: overrides.greeting || "",
      echoCooldownMs: 0,
    }),
    validateSttProviderApiKey: () => true,
  });
  installMock(path.join(src, "pipeline.js"), {
    createPipeline: (session, turnState, onAudio, config, pipelineOptions) => {
      const pipeline = new EventEmitter();
      Object.assign(pipeline, {
        session,
        turnState,
        onAudio,
        config,
        options: pipelineOptions,
        receivedAudio: [],
        closeCalls: 0,
        sendAudio(...args) {
          this.receivedAudio.push(args);
        },
        close() {
          this.closeCalls += 1;
        },
        emitAudio(buffer, metadata) {
          this.onAudio(buffer, metadata);
        },
        getDelegationResults() {
          return [];
        },
      });
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  installMock(path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: () => {},
    warmUpMultipleAgents: () => {},
  });
  installMock(path.join(src, "session-events.js"), {
    SessionLifecycle: class {
      constructor(sessionId, transport, meta) {
        this.sessionId = sessionId;
        this.transport = transport;
        this.meta = meta;
        this.state = "idle";
        this.isTerminal = false;
      }
      transition(state) {
        this.state = state;
        this.isTerminal = ["completed", "failed"].includes(state);
        return true;
      }
      on() {}
      setConversationLog() {}
      toJSON() {
        return { sessionId: this.sessionId, transport: this.transport, state: this.state };
      }
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
    resolveAgentProfile: () => ({
      agentId: "caty",
      name: "Caty",
      displayName: "Caty",
      attendeeApiKey: "attendee-secret",
      wakeWords: ["ケイティ"],
    }),
    AgentNotFoundError: class AgentNotFoundError extends Error {},
  });
  installMock(path.join(src, "attendee-chat.js"), { sendAttendeeChatMessage: async () => true });
  installMock(path.join(src, "gateway-events.js"), {});
  installMock(path.join(src, "metrics.js"), { recordEvent: () => {} });
  installMock(path.join(src, "delegation-results.js"), { buildDelegationResultsSection: () => "" });
  installMock(path.join(src, "gateway-session-tracker.js"), {
    createGatewaySessionTracker: () => ({
      trackGatewaySession() {},
      untrackGatewaySession() { return false; },
      findGatewayRoute() { return null; },
    }),
  });
  installMock(path.join(src, "ui-routes.js"), {
    serveLocalAvatar: () => false,
    servePublicAsset: () => false,
    sendMetricsSummary: async () => false,
  });
  installMock(path.join(src, "paths.js"), {
    logsDir: () => path.join(homeDir, "logs"),
    avatarCachePath: () => path.join(homeDir, "avatar.png"),
    bundledAssetPath: (name) => path.join(homeDir, name),
    bundledPublicDir: () => homeDir,
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@deepgram/sdk") {
      return {
        createClient: () => ({ agent: () => new EventEmitter() }),
        AgentEvents: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
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
        response.emit("data", requestOptions.path === "/api/v1/bots" ? '{"id":"bot-char-audio"}' : "{}");
        response.emit("end");
      });
    };
    return request;
  };
  http.get = unavailableNgrokHttpGet;
  crypto.randomUUID = () => FIXED_SESSION_ID;

  try {
    const routes = require(routesPath);
    await routes.init({
      detectNgrok: false,
      loadAvatar: false,
      readinessProbeOptions: {
        fetchFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
        requestFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
        httpGet: unavailableNgrokHttpGet,
      },
    });
    routes._test.configureReadinessForTest({
      fetchFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
      requestFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
      httpGet: unavailableNgrokHttpGet,
    });

    await fn({
      pipelines,
      httpsRequests,
      async join() {
        return requestHttp(routes, "POST", "/join-meeting", {
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          wsUrl: "wss://meetmate.example/realtime",
          conversationMode: "one_to_one",
        });
      },
      connect() {
        const client = new FakeClient();
        clients.push(client);
        routes.handleWsConnection(client, {
          url: `/realtime?sid=${FIXED_SESSION_ID}`,
          socket: { remoteAddress: "127.0.0.1" },
        });
        return client;
      },
    });
  } finally {
    for (const client of clients) {
      client.emit("close");
      client.removeAllListeners();
    }
    await delay(15);
    https.request = originalHttpsRequest;
    http.get = originalHttpGet;
    crypto.randomUUID = originalRandomUUID;
    Module._load = originalLoad;
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

async function withPipelineHarness(run, options = {}) {
  const src = path.join(__dirname, "..", "src");
  const files = [
    "stt-provider.js",
    "stt.js",
    "llm-provider.js",
    "tts-fish.js",
    "metrics.js",
    "pipeline.js",
  ].map((name) => path.join(src, name));
  const previousCache = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of files) delete require.cache[require.resolve(file)];

  const restoreEnv = setEnv({
    WAKE_WORDS: undefined,
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    POST_UTTERANCE_BUFFER_MS: "0",
    TTS_GAP_MS: "0",
    TTS_LEAD_MS: "0",
    SENTENCE_PAUSE_MS: "0",
    METRICS_DISABLED: "1",
  });

  const sttCalls = [];
  const spoken = [];
  let sttEmitter = null;
  const sttExports = {
    createSTT: () => {
      sttEmitter = new EventEmitter();
      sttEmitter.send = (buffer) => sttCalls.push(Buffer.from(buffer));
      sttEmitter.close = () => {};
      return sttEmitter;
    },
    buildKeyterms: () => [],
  };
  installMock(path.join(src, "stt-provider.js"), cacheEntry(path.join(src, "stt-provider.js"), sttExports).exports);
  installMock(path.join(src, "stt.js"), cacheEntry(path.join(src, "stt.js"), sttExports).exports);
  installMock(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      VOICE_SYSTEM_ADDENDUM: "",
      buildVoiceAddendum: () => "",
      streamChat: options.streamChat || (async function* () {
        yield "通常応答です。";
      }),
    }),
  });
  installMock(path.join(src, "tts-fish.js"), {
    synthesize: options.synthesize || (async (text, { onAudio }) => {
      spoken.push(text);
      onAudio(Buffer.from([1, 0, 2, 0]));
    }),
  });

  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const observedAudio = [];
    const session = {
      id: options.sessionId || "audio-session",
      conversationLog: [],
      conversationLogs: { caty: [] },
      config: { wakeMode: "wake" },
    };
    const turnState = {
      isAgentSpeaking: false,
      lastTurnEndAt: null,
      inputCooldownUntil: 0,
      droppedEchoFrames: 0,
    };
    const config = {
      dgKey: "dg-key",
      fishKey: "fish-key",
      stt: { provider: "soniox", model: "test", language: "ja", sampleRate: 16_000 },
      llm: { provider: "openclaw", model: "test-model", temperature: 0, maxTokens: 64, responseTimeoutMs: 0, openclawSystemAddendum: "" },
      tts: { referenceId: "voice-id", sampleRate: options.ttsSampleRate || 1_000, latency: "balanced", speed: 1 },
      echoCooldownMs: 0,
      greeting: options.greeting ?? "",
      hub: options.hubConfig,
      messages: {
        speech: {
          circuitBreakerRecoveryNotice: "recovering",
        },
        regex: {
          cancelPattern: "ストップ|停止|キャンセル|やめて",
          cancelFlags: "iu",
          shortUtterancePingPatterns: [],
          shortUtterancePingFlags: "iu",
        },
        prompts: {},
        delegation: {},
      },
    };
    const pipeline = createPipeline(session, turnState, (buffer, metadata) => {
      observedAudio.push({ buffer: Buffer.from(buffer), metadata: { ...metadata } });
    }, config, {
      agents: { caty: { wakeWords: ["ケイティ"], voiceId: "voice-id", model: "test-model" } },
      selectedAgentIds: ["caty"],
      defaultAgentId: "caty",
      _testExposeInternals: true,
      ...options.pipelineOptions,
    });

    await run({ createPipeline, pipeline, sttEmitter, sttCalls, observedAudio, spoken, turnState, config, session });
    pipeline.close();
  } finally {
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    restoreEnv();
  }
}

test("Attendee websocket audio framing, echo gate, and bot_output wire shape stay pinned", { concurrency: false }, async () => {
  await withAudioRoutes(async (harness) => {
    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);

    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.ok(createRequest);
    const botPayload = JSON.parse(createRequest.body);
    assert.equal(botPayload.websocket_settings.audio.sample_rate, 16_000);

    const client = harness.connect();
    const pipeline = harness.pipelines[0];
    const mixed = Buffer.from([1, 2, 3, 4]);
    const payload = JSON.stringify({
      trigger: "realtime_audio.mixed",
      data: { chunk: mixed.toString("base64") },
    });

    client.emit("message", Buffer.from(payload));
    assert.equal(pipeline.receivedAudio.length, 1);
    assert.deepEqual(pipeline.receivedAudio[0], [mixed]);

    pipeline.turnState.isAgentSpeaking = true;
    client.emit("message", Buffer.from(payload));
    assert.equal(pipeline.receivedAudio.length, 1);
    assert.equal(pipeline.turnState.droppedEchoFrames, 1);

    pipeline.turnState.isAgentSpeaking = false;
    pipeline.turnState.inputCooldownUntil = Date.now() + 1_000;
    client.emit("message", Buffer.from(payload));
    assert.equal(pipeline.receivedAudio.length, 1);
    assert.equal(pipeline.turnState.droppedEchoFrames, 2);

    pipeline.turnState.inputCooldownUntil = 0;
    client.emit("message", Buffer.from(payload));
    assert.equal(pipeline.receivedAudio.length, 2);
    assert.equal(pipeline.turnState.droppedEchoFrames, 0);

    pipeline.emitAudio(Buffer.from([1, 0]), {
      outputEpoch: 7,
      firstSampleIndex: 11,
      sampleRate: 24_000,
    });
    const outbound = JSON.parse(client.sent.at(-1));
    assert.deepEqual(Object.keys(outbound).sort(), ["data", "trigger"]);
    assert.equal(outbound.trigger, "realtime_audio.bot_output");
    assert.deepEqual(Object.keys(outbound.data).sort(), ["chunk", "sample_rate"]);
    assert.equal(outbound.data.chunk, Buffer.from([1, 0]).toString("base64"));
    assert.equal(outbound.data.sample_rate, 24_000);
    assert.equal(Object.hasOwn(outbound.data, "outputEpoch"), false);
  });
});

test("ECHO_GATE_CLOSED_BYPASS keeps the legacy closed-gate bypass path reachable", { concurrency: false }, async () => {
  await withAudioRoutes(async (harness) => {
    await harness.join();
    const client = harness.connect();
    const pipeline = harness.pipelines[0];
    const mixed = Buffer.from([9, 8, 7, 6]);
    pipeline.turnState.isAgentSpeaking = true;
    pipeline.turnState.gateState = "CLOSED";

    client.emit("message", Buffer.from(JSON.stringify({
      trigger: "realtime_audio.mixed",
      data: { chunk: mixed.toString("base64") },
    })));

    assert.equal(pipeline.receivedAudio.length, 1);
    assert.deepEqual(pipeline.receivedAudio[0], [mixed]);
    assert.equal(pipeline.turnState.droppedEchoFrames, 0);
  }, { echoGateClosedBypass: true });
});

test("sessionUser naming stays helper-backed, defaulting to meet and accepting explicit transport", { concurrency: false }, async () => {
  assert.equal(sessionUserFor("meet", "sid-1"), "meet-sid-1");
  assert.equal(sessionUserFor("meet", "sid-1", "caty"), "meet-sid-1-caty");
  assert.equal(sessionUserFor("zoom", "sid-2"), "zoom-sid-2");
  assert.equal(sessionUserFor("discord", "sid-2", "bot"), "discord-sid-2-bot");
  assert.throws(() => sessionUserFor("slack", "sid-3"), /Unsupported transport/);

  await withPipelineHarness(async ({ pipeline }) => {
    assert.deepEqual(pipeline.getSessionUsers(), {
      parent: "meet-audio-session-caty",
      delegate: "meet-audio-session-caty-delegate",
    });
  });

  await withPipelineHarness(async ({ pipeline }) => {
    assert.deepEqual(pipeline.getSessionUsers(), {
      parent: "discord-audio-session-caty",
      delegate: "discord-audio-session-caty-delegate",
    });
  }, {
    pipelineOptions: { transport: "discord" },
  });

  await withPipelineHarness(async ({ createPipeline, turnState, config, session }) => {
    assert.throws(
      () => createPipeline(session, turnState, () => {}, config, { transport: "slack" }),
      /Unsupported transport: slack/
    );
  });
});

test("pipeline capabilities reject present non-object values", { concurrency: false }, async () => {
  await withPipelineHarness(async ({ createPipeline, turnState, config, session }) => {
    for (const capabilities of [null, "discord", 0, 1, true, false]) {
      assert.throws(
        () => createPipeline(session, turnState, () => {}, config, { capabilities }),
        /options\.capabilities must be an object/
      );
    }
  });
});

test("sendAudio accepts absent or well-formed speaker meta and drops malformed meta without throwing", { concurrency: false }, async () => {
  await withPipelineHarness(async ({ pipeline, sttCalls }) => {
    const chunk = Buffer.from([1, 0, 2, 0]);

    pipeline.sendAudio(chunk);
    pipeline.sendAudio(chunk, { speaker: { platform: "discord", id: "user-1", isBot: false } });
    pipeline.sendAudio(chunk, null);
    pipeline.sendAudio(chunk, {});
    pipeline.sendAudio(chunk, { speaker: { platform: "discord", isBot: false } });
    pipeline.sendAudio(chunk, { speaker: { platform: "discord", id: "user-2" } });
    pipeline.sendAudio(chunk, { speaker: { platform: "discord", id: "user-2", isBot: "false" } });

    assert.deepEqual(sttCalls, [chunk, chunk]);
  });
});

test("barge_in remains reachable for Attendee defaults and is suppressed when echoesOwnOutput is false", { concurrency: false }, async () => {
  let synthCall = 0;
  const cancellableSynthesize = async (_text, { signal, onAudio }) => {
    synthCall += 1;
    onAudio(Buffer.from([1, 0]));
    if (signal && !signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  };

  await withPipelineHarness(async ({ pipeline, sttEmitter, turnState }) => {
    const events = [];
    pipeline.on("playback_cancelled", (event) => events.push(event));
    const processing = pipeline._test.sendGreeting();
    await waitUntil(() => pipeline._test.getCurrentAbortController());
    turnState.isAgentSpeaking = true;
    sttEmitter.emit("transcript", "はい", false, 0.99);
    await processing;

    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "barge_in");
  }, {
    synthesize: cancellableSynthesize,
    greeting: "こんにちは",
  });

  synthCall = 0;
  await withPipelineHarness(async ({ pipeline, sttEmitter, turnState }) => {
    const events = [];
    pipeline.on("playback_cancelled", (event) => events.push(event));
    const processing = pipeline._test.sendGreeting();
    await waitUntil(() => pipeline._test.getCurrentAbortController());
    turnState.isAgentSpeaking = true;
    sttEmitter.emit("transcript", "はい", false, 0.99);
    await delay(20);
    assert.equal(events.length, 0);
    assert.equal(pipeline._test.getCurrentAbortController().signal.aborted, false);
    pipeline._test.abortCurrent();
    await processing;
    assert.deepEqual(events.map((event) => event.reason), ["external_abort"]);
  }, {
    synthesize: cancellableSynthesize,
    greeting: "こんにちは",
    pipelineOptions: {
      capabilities: { echoesOwnOutput: false },
    },
  });

  await withPipelineHarness(async ({ pipeline, sttEmitter, turnState }) => {
    const events = [];
    pipeline.on("playback_cancelled", (event) => events.push(event));
    const processing = pipeline._test.sendGreeting();
    await waitUntil(() => pipeline._test.getCurrentAbortController());
    turnState.isAgentSpeaking = true;
    sttEmitter.emit("transcript", "はい", false, 0.99);
    await delay(20);
    assert.equal(events.length, 0);
    assert.equal(pipeline._test.getCurrentAbortController().signal.aborted, false);
    pipeline._test.abortCurrent();
    await processing;
    assert.deepEqual(events.map((event) => event.reason), ["external_abort"]);
  }, {
    synthesize: cancellableSynthesize,
    greeting: "こんにちは",
    pipelineOptions: {
      capabilities: {},
    },
  });
});

test("floor_fence cancellation reports the pre-increment output epoch", { concurrency: false }, async () => {
  const floorClient = {
    memberId: "member-caty",
    readyGraceMs: 100,
    verdictTimeoutMs: 100,
    connect() {},
    close() {},
    fence: () => null,
    isFenceCurrent: () => false,
    waitForReady: async () => true,
    hasActivePeerSpeech: () => false,
    hasUnsettledReports: () => false,
    reportWake: async () => ({ kind: "assigned", assignment: { roundId: "r1" } }),
    acquire: () => ({ connectionEpoch: "epoch-1", roundId: "r1" }),
    fallbackDelayMs: () => 0,
  };

  await withPipelineHarness(async ({ pipeline }) => {
    const events = [];
    pipeline.on("playback_cancelled", (event) => events.push(event));

    await pipeline._test.speakSentence("fenced speech", null);

    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "floor_fence");
    assert.equal(events[0].outputEpoch, 0);
    assert.equal(pipeline._test.getEnvelopeRearmState().outputEpoch, 1);
  }, {
    hubConfig: { enabled: true, tailMs: 0 },
    pipelineOptions: { floorClient },
  });
});

test("output metadata, cancelled epoch, and silent envelope re-arm stay pinned", { concurrency: false }, async () => {
  let synthCall = 0;
  await withPipelineHarness(async ({ pipeline, observedAudio, turnState }) => {
    const events = [];
    pipeline.on("playback_cancelled", (event) => events.push(event));

    const first = pipeline._test.sendGreeting();
    await waitUntil(() => observedAudio.length > 0);
    pipeline._test.abortCurrent();
    await first;

    assert.deepEqual(Object.keys(observedAudio[0].metadata).sort(), [
      "firstSampleIndex",
      "outputEpoch",
      "sampleRate",
    ]);
    assert.deepEqual(observedAudio[0].metadata, {
      outputEpoch: 0,
      firstSampleIndex: 0,
      sampleRate: 1_000,
    });
    assert.equal(events[0].reason, "external_abort");
    assert.equal(events[0].outputEpoch, 0);

    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      await pipeline._test.speakSentence("seed", null);
      turnState.isAgentSpeaking = true;
      pipeline._test.clearAgentSpeaking();
      now = 5_000;
      await pipeline._test.speakSentence("after-hole", null);
    } finally {
      Date.now = originalNow;
    }

    assert.equal(observedAudio.at(-1).metadata.outputEpoch, 2);
    assert.deepEqual(events.map((event) => event.reason), ["external_abort"]);
  }, {
    synthesize: async (_text, { signal, onAudio }) => {
      synthCall += 1;
      onAudio(synthCall === 1 ? Buffer.from([1, 0]) : Buffer.alloc(4_800));
      if (synthCall === 1 && signal && !signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
    },
    greeting: "こんにちは",
  });
});

test("idle close emits no playback_cancelled after the turn completes, and greeting remains scheduled at 2 seconds", { concurrency: false }, async () => {
  const timerRegistrations = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = function wrappedSetTimeout(callback, ms, ...args) {
    if (ms === 2_000) {
      const registration = {
        callback,
        ms,
        args,
        unrefCalls: 0,
      };
      timerRegistrations.push(registration);
      return {
        unref() {
          registration.unrefCalls += 1;
        },
      };
    }
    return originalSetTimeout(callback, ms, ...args);
  };
  try {
    await withPipelineHarness(async ({ pipeline, spoken }) => {
      assert.equal(timerRegistrations.length, 1);
      const greetingRegistration = timerRegistrations[0];
      assert.equal(typeof greetingRegistration.callback, "function");
      assert.deepEqual(greetingRegistration.args, []);
      assert.equal(greetingRegistration.unrefCalls, 1);

      greetingRegistration.callback(...greetingRegistration.args);
      await waitUntil(() => spoken.includes("こんにちは"));

      const events = [];
      pipeline.on("playback_cancelled", (event) => events.push(event));
      await pipeline._test.processUserInput("完了するターン");
      assert.equal(pipeline._test.getCurrentAbortController(), null);
      pipeline.close();
      assert.deepEqual(events, []);
      assert.equal(timerRegistrations.length, 1);
    }, {
      greeting: "こんにちは",
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
