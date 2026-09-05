"use strict";

// #127 phase 1: measured on v8.14.1, before removing agent switching.
// Phase 2 may change option construction/adapters only; assertions are frozen.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { stringify } = require("node:querystring");
const resolver = require("../src/settings/resolver");
const readiness = require("../src/settings/readiness");
const realSessionEvents = require("../src/session-events");

const FIXED_SESSION_ID = "sid-pin";
const fixtureKey = "pin-" + "key";

function makeProfile(overrides = {}) {
  return {
    agentId: "caty", name: "Caty", displayName: "Caty", systemPrompt: "",
    greeting: "", model: null, voiceId: null,
    wakeWords: ["ケイティ"], keyterms: [], sttWakeVariants: [], exitCommands: [],
    emotionTags: true, ackVariants: null, progressPings: null, timeoutFallback: null,
    exitFarewell: null, cancelAck: null, avatarPath: null, avatarUrl: null,
    attendeeApiKey: null, isDefault: true,
    ...overrides,
  };
}

function buildTransportPipelineOptions(profile, extra = {}) {
  return { agentProfile: profile, ...extra };
}

function callIsWakeCancelText(pipeline, text, profile, regexConfig = null) {
  return pipeline._test.isWakeCancelText(text, profile, regexConfig);
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

// Local copy of the require-cache STT mux harness; no test-module imports.
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

  const fixtureEnv = {
    WAKE_WORDS: options.wakeWords ?? "ケイティ",
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    POST_UTTERANCE_BUFFER_MS: "0",
    TTS_GAP_MS: "0",
    TTS_LEAD_MS: "0",
    SENTENCE_PAUSE_MS: "0",
    METRICS_DISABLED: "1",
  };
  const restoreEnv = setEnv(fixtureEnv);

  const sttInstances = [];
  const llmCalls = [];
  const spoken = [];
  const ttsCalls = [];
  const observedAudio = [];
  const sttExports = {
    createSTT: (key, sttOptions) => {
      const instance = new EventEmitter();
      instance.index = sttInstances.length;
      instance.options = structuredClone(sttOptions);
      instance.sent = [];
      instance.closeCalls = 0;
      instance.send = (buffer) => instance.sent.push(Buffer.from(buffer));
      instance.close = () => {
        instance.closeCalls += 1;
      };
      sttInstances.push(instance);
      return instance;
    },
    buildKeyterms: () => [],
  };
  installMock(path.join(src, "stt-provider.js"), sttExports);
  installMock(path.join(src, "stt.js"), sttExports);
  installMock(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      VOICE_SYSTEM_ADDENDUM: "",
      buildVoiceAddendum: () => "",
      streamChat: async function* (...args) {
        llmCalls.push(args);
        yield "通常応答として今日の天気をお伝えします。";
      },
    }),
  });
  installMock(path.join(src, "tts-fish.js"), {
    synthesize: async (text, ttsOptions) => {
      ttsCalls.push({ text, referenceId: ttsOptions.referenceId });
      spoken.push(text);
      ttsOptions.onAudio(Buffer.from([1, 0, 2, 0]));
    },
  });
  installMock(path.join(src, "metrics.js"), { recordEvent: () => {} });

  let closed = false;
  let pipeline = null;
  try {
    // The settings resolver snapshots environment aliases at boot. Give every
    // require its own snapshot so WAKE_WORDS cannot leak across harnesses.
    resolver.resetRuntimeForTest();
    resolver.initializeRuntime({
      state: { exists: false, valid: false, parsed: null, revision: "pin", fingerprint: "pin" },
      startup: Object.freeze({
        preDotenvEnv: Object.freeze({ ...fixtureEnv }), dotenvSeeds: Object.freeze({}),
        resolvedHome: os.tmpdir(), configPath: path.join(os.tmpdir(), "unused-pin-config.json"),
        connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
      }),
      serverPort: 5005,
    });
    const pipelineModule = require(path.join(src, "pipeline.js"));
    const { createPipeline } = pipelineModule;
    const session = {
      id: FIXED_SESSION_ID,
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
      dgKey: fixtureKey,
      fishKey: fixtureKey,
      stt: { provider: "soniox", model: "test", language: "ja", sampleRate: 16_000 },
      llm: { provider: "openclaw", model: "session-model", temperature: 0, maxTokens: 64, responseTimeoutMs: 0, openclawSystemAddendum: "" },
      tts: { referenceId: "session-voice", sampleRate: 24_000, latency: "balanced", speed: 1 },
      echoCooldownMs: 0,
      greeting: options.greeting ?? "session greeting",
      gatewayEvents: { enabled: false },
      messages: {
        speech: { circuitBreakerRecoveryNotice: "recovering" },
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
    pipeline = createPipeline(session, turnState, (buffer, metadata) => {
      observedAudio.push({ buffer: Buffer.from(buffer), metadata: { ...metadata } });
    }, config, buildTransportPipelineOptions(options.profile || makeProfile(), {
      transport: "meet",
      capabilities: { echoesOwnOutput: false, perSpeakerAudio: true },
      suppressGreeting: true,
      _testExposeInternals: true,
      ...options.pipelineOptions,
    }));
    const rawClose = pipeline.close.bind(pipeline);
    pipeline.close = () => {
      if (closed) return;
      closed = true;
      return rawClose();
    };

    await run({
      pipeline,
      pipelineModule,
      session,
      turnState,
      sttInstances,
      llmCalls,
      spoken,
      ttsCalls,
      observedAudio,
      closePipeline: () => pipeline.close(),
    });
  } finally {
    if (!closed) pipeline?.close();
    resolver.resetRuntimeForTest();
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    restoreEnv();
  }
}

// Minimal join/connect subset of characterization-attendee-session's harness.
// That file registers tests at import time, so it cannot be imported as a helper.
async function withMeetRoutes(run) {
  const src = path.join(__dirname, "..", "src");
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const files = [routesPath, ...[
    "config.js", "pipeline.js", "gateway-warmup.js", "session-events.js",
    "slack-notifier.js", "summarizer.js", "agent-profile.js", "attendee-chat.js",
    "gateway-events.js", "metrics.js", "delegation-results.js",
    "gateway-session-tracker.js", "ui-routes.js", "paths.js", "session-coordinator.js",
  ].map((name) => require.resolve(path.join(src, name)))];
  const previousCache = new Map(files.map((file) => [file, require.cache[file]]));
  for (const file of files) delete require.cache[file];
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-pins-"));
  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: fixtureKey, FISH_AUDIO_API_KEY: fixtureKey,
    SESSION_GRACE_CLOSE_MS: "1", JOIN_SHARED_TOKEN: undefined,
    WS_SHARED_TOKEN: undefined, OPENCLAW_WORKSPACE: undefined,
  });
  const profile = makeProfile({ attendeeApiKey: fixtureKey });
  const settings = {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "test-model" },
    stt: { provider: "soniox", sonioxApiKey: fixtureKey },
    tts: { provider: "fish-audio", apiKey: fixtureKey, voiceId: "voice-id" },
    attendee: { apiKey: fixtureKey, baseUrl: "app.attendee.dev" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
  };
  const pipelines = [], warmups = [], httpsRequests = [], lifecycles = [], clients = [];
  const originals = { httpsRequest: https.request, httpGet: http.get,
    randomUUID: crypto.randomUUID, randomBytes: crypto.randomBytes };
  const mock = (name, exports) => installMock(path.join(src, name), exports);
  let lease = null;
  let routes;
  const unavailableHttpGet = () => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    queueMicrotask(() => req.emit("error", new Error("offline fixture")));
    return req;
  };
  try {
    resolver.resetRuntimeForTest();
    readiness.reset();
    resolver.initializeRuntime({
      state: { exists: true, valid: true, parsed: settings, revision: "pin", fingerprint: "pin" },
      startup: Object.freeze({
        preDotenvEnv: Object.freeze({}), dotenvSeeds: Object.freeze({}),
        resolvedHome: homeDir, configPath: path.join(homeDir, "config.json"),
        connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: fixtureKey, openaiApiKey: "" }),
      }),
      serverPort: 5005,
    });
    for (const system of readiness.gateSystems()) {
      readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
    }
    mock("config.js", {
      SAMPLE_RATE: 16_000, TTS_SAMPLE_RATE: 24_000, TTS_PROVIDER: "fish-audio",
      loadConfig: () => settings,
      resolveMessages: () => ({ delegation: {}, prompts: { summary: "summary" } }),
      getPipelineConfig: () => ({
        stt: { provider: "soniox", sampleRate: 16_000 },
        llm: { provider: "test", model: "test-model" },
        tts: { sampleRate: 24_000, referenceId: "voice-id" },
        gatewayEvents: { enabled: false }, greeting: "", echoCooldownMs: 0,
      }),
      validateSttProviderApiKey: () => true,
    });
    mock("pipeline.js", {
      createPipeline(session) {
        const pipeline = new EventEmitter();
        Object.assign(pipeline, { session, sendAudio() {}, close() {}, getDelegationResults: () => [] });
        pipelines.push(pipeline);
        return pipeline;
      },
    });
    mock("gateway-warmup.js", { warmUpGatewaySession: (...args) => warmups.push(args) });
    mock("session-events.js", {
      ...realSessionEvents,
      SessionLifecycle: class extends realSessionEvents.SessionLifecycle {
        constructor(...args) { super(...args); lifecycles.push(this); }
      },
    });
    mock("slack-notifier.js", {
      SlackNotifier: class {
        async postStatus() {}
        startElapsedUpdates() {}
        stopElapsedUpdates() {}
        async postSummary() {}
        async postTranscript() {}
      },
    });
    mock("summarizer.js", { summarizeConversation: async () => "" });
    mock("agent-profile.js", { resolveAgentProfile: () => profile, AgentNotFoundError: class extends Error {} });
    mock("attendee-chat.js", { sendAttendeeChatMessage: async () => true });
    mock("gateway-events.js", {});
    mock("metrics.js", { recordEvent() {} });
    mock("delegation-results.js", { buildDelegationResultsSection: () => "" });
    mock("gateway-session-tracker.js", {
      createGatewaySessionTracker: () => ({ trackGatewaySession() {}, untrackGatewaySession: () => false, findGatewayRoute: () => null }),
    });
    mock("ui-routes.js", { serveLocalAvatar: () => false, servePublicAsset: () => false, sendMetricsSummary: async () => false });
    mock("paths.js", {
      logsDir: () => path.join(homeDir, "logs"), avatarCachePath: () => path.join(homeDir, "avatar.png"),
      bundledAssetPath: (name) => path.join(homeDir, name), bundledPublicDir: () => homeDir,
    });
    mock("session-coordinator.js", {
      active: () => lease,
      tryAcquire: (transport, sessionId) => (lease = { transport, sessionId }),
      release: () => { lease = null; },
    });
    https.request = (options, callback) => {
      const req = new EventEmitter();
      const record = { options, body: "" };
      httpsRequests.push(record);
      req.setTimeout = () => req;
      req.destroy = () => {};
      req.write = (chunk) => { record.body += String(chunk); };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = options.path === "/api/v1/bots" ? 201 : 200;
        callback(res);
        queueMicrotask(() => {
          res.emit("data", options.path === "/api/v1/bots" ? '{"id":"bot-pin"}' : "{}");
          res.emit("end");
        });
      };
      return req;
    };
    http.get = unavailableHttpGet;
    crypto.randomUUID = () => FIXED_SESSION_ID;
    crypto.randomBytes = (size) => Buffer.alloc(size, 0x99);
    const probeOptions = {
      fetchFn: async () => { throw new Error("offline fixture"); },
      requestFn: async () => { throw new Error("offline fixture"); },
      httpGet: unavailableHttpGet,
    };
    routes = require(routesPath);
    await routes.init({ detectNgrok: false, loadAvatar: false, readinessProbeOptions: probeOptions });
    routes._test.configureReadinessForTest(probeOptions);
    await run({
      pipelines, warmups, httpsRequests, lifecycles,
      async join() {
        const req = new EventEmitter();
        Object.assign(req, { method: "POST", url: "/join-meeting", headers: {},
          socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5005 }, destroy() {} });
        const result = { statusCode: null, text: "" };
        const res = { writeHead(code) { result.statusCode = code; }, end(body = "") { result.text += String(body); } };
        const pending = routes.handleHttp(req, res);
        await Promise.resolve();
        req.emit("data", Buffer.from(stringify({
          meetingUrl: "https://meet.google.com/abc-defg-hij", wsUrl: "wss://meetmate.example/realtime",
          conversationMode: "one_to_one",
        })));
        req.emit("end");
        await pending;
        return result;
      },
      connect() {
        const client = new EventEmitter();
        Object.assign(client, { readyState: 1, isAlive: true, send() {}, close() {}, terminate() {}, ping() {} });
        clients.push(client);
        routes.handleWsConnection(client, { url: "/realtime?sid=sid-pin", socket: { remoteAddress: "127.0.0.1" } });
      },
    });
  } finally {
    for (const client of clients) { client.emit("close"); client.removeAllListeners(); }
    await delay(15);
    https.request = originals.httpsRequest;
    http.get = originals.httpGet;
    crypto.randomUUID = originals.randomUUID;
    crypto.randomBytes = originals.randomBytes;
    readiness.reset();
    resolver.resetRuntimeForTest();
    restoreEnv();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const file of files) {
      delete require.cache[file];
      if (previousCache.get(file)) require.cache[file] = previousCache.get(file);
    }
  }
}

async function driveTurn(harness, text) {
  harness.turnState.inputCooldownUntil = 0;
  harness.sttInstances[0].emit("transcript", text, true, 0.99);
  harness.sttInstances[0].emit("utterance_end", text);
  await waitUntil(() => harness.llmCalls.length === 1 && harness.pipeline._test.getGateState() === "OPEN");
}

function lastUserText(session) {
  return session.conversationLog.findLast((entry) => entry.role === "user")?.content;
}

test("P1: Meet and Discord sessionUser include the profile suffix before greeting", { concurrency: false }, async () => {
  await withPipelineHarness(async ({ pipeline }) => {
    assert.deepEqual(pipeline.getSessionUsers(), { parent: "meet-sid-pin-caty", delegate: "meet-sid-pin-caty-delegate" });
  });
  await withPipelineHarness(async ({ pipeline }) => {
    assert.deepEqual(pipeline.getSessionUsers(), { parent: "discord-sid-pin-caty", delegate: "discord-sid-pin-caty-delegate" });
  }, { pipelineOptions: { transport: "discord" } });
});

test("P2: Meet warm-up uses the same literal as the real pipeline's P1 identity", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    assert.equal((await harness.join()).statusCode, 200);
    assert.equal(harness.warmups[0][0], "meet-sid-pin-caty");
    harness.connect();
  });
});

test("P3: profile greeting/model/voice win; empty profile values fall back to the session", { concurrency: false }, async () => {
  for (const row of [
    { profile: makeProfile({ greeting: "profile greeting", model: "profile-model", voiceId: "profile-voice" }), greeting: "profile greeting", model: "profile-model", voice: "profile-voice" },
    { profile: makeProfile({ greeting: "", model: "", voiceId: "" }), greeting: "session greeting", model: "session-model", voice: "session-voice" },
  ]) {
    await withPipelineHarness(async (harness) => {
      await harness.pipeline._test.sendGreeting();
      assert.deepEqual(harness.spoken, [row.greeting]);
      assert.equal(harness.ttsCalls[0].referenceId, row.voice);
      await driveTurn(harness, "ケイティ、質問です");
      assert.equal(harness.llmCalls[0][1].model, row.model);
      assert.deepEqual(harness.spoken, [row.greeting, "通常応答として今日の天気をお伝えします。"]);
      assert.equal(harness.ttsCalls.at(-1).referenceId, row.voice);
    }, { profile: row.profile, pipelineOptions: { suppressGreeting: false } });
  }
});

test("P4: mixed and attributed STT preserve keyterms before wakeWords", { concurrency: false }, async () => {
  await withPipelineHarness(async ({ pipeline, sttInstances }) => {
    assert.deepEqual(sttInstances[0].options.keyterms, ["k1", "k2", "ケイティ", "キャティ"]);
    pipeline.sendAudio(Buffer.alloc(640), { speaker: { platform: "meet", id: "speaker-pin", displayName: "Speaker", isBot: false } });
    assert.equal(sttInstances.length, 2);
    assert.deepEqual(sttInstances[1].options.keyterms, ["k1", "k2", "ケイティ", "キャティ"]);
  }, { profile: makeProfile({ keyterms: ["k1", "k2"], wakeWords: ["ケイティ", "キャティ"] }) });
});

test("P5: module WAKE_WORDS address the profile; unaddressed speech never calls the LLM", { concurrency: false }, async () => {
  await withPipelineHarness(async (harness) => {
    await driveTurn(harness, "ねえ");
    assert.equal(harness.llmCalls.length, 1);
    assert.equal(harness.pipeline.getSessionUsers().parent, "meet-sid-pin-caty");
    assert.equal(lastUserText(harness.session), "ねえ");
    harness.turnState.inputCooldownUntil = 0;
    harness.sttInstances[0].emit("transcript", "今日の天気は？", true, 0.99);
    harness.sttInstances[0].emit("utterance_end", "今日の天気は？");
    await waitUntil(() => harness.session.conversationLog.filter((entry) => entry.role === "user").length === 2);
    assert.equal(lastUserText(harness.session), "[会議音声・未指名] 今日の天気は？");
    assert.equal(harness.llmCalls.length, 1);
  }, { wakeWords: "ねえ" });
});

test("P6: normal turns retain wake prefixes; cancel stripping tries module words first", { concurrency: false }, async () => {
  const profile = makeProfile({ wakeWords: ["ケイティさん"], sttWakeVariants: ["けいてぃ"] });
  for (const row of [
    { input: "ケイティさん、今日の天気は？", expected: "ケイティさん、今日の天気は？" },
    { input: "けいてぃ、今日の天気は？", expected: "けいてぃ、今日の天気は？" },
  ]) {
    await withPipelineHarness(async (harness) => {
      await driveTurn(harness, row.input);
      assert.equal(lastUserText(harness.session), row.expected);
      assert.equal(harness.llmCalls[0][0].findLast((entry) => entry.role === "user").content, row.expected);
      // Default cancel regex is anchored: the surviving "さん" prevents cancellation.
      assert.equal(callIsWakeCancelText(harness.pipelineModule, "ケイティさんストップ", profile), false);
    }, { profile, wakeWords: "ケイティ" });
  }
});

test("P7: Meet session config and lifecycle retain one-element identity arrays", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    assert.equal((await harness.join()).statusCode, 200);
    harness.connect();
    const session = harness.pipelines[0].session;
    assert.deepEqual(session.config.agentIds, ["caty"]);
    assert.equal(session.config.defaultAgentId, "caty");
    assert.deepEqual(session.conversationLogs, { caty: [] });
    assert.deepEqual(session.agents, ["Caty"]);
    assert.deepEqual(harness.lifecycles[0]._meta.agentIds, ["caty"]);
    assert.deepEqual(harness.lifecycles[0]._meta.agents, ["Caty"]);
  });
});

test("P8: Meet's omitted botName defaults to Caty (AI)", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    assert.equal((await harness.join()).statusCode, 200);
    const request = harness.httpsRequests.find((entry) => entry.options.path === "/api/v1/bots");
    assert.ok(request);
    assert.equal(JSON.parse(request.body).bot_name, "Caty (AI)");
    harness.connect();
  });
});
