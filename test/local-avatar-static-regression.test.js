const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { stringify } = require("node:querystring");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "local-avatar-timeline.json"), "utf8"));
const FIXED_SESSION_ID = "00000000-0000-4000-8000-000000000173";

test("static join payload and Fish bot_output bytes match the frozen fixture", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join();
    assert.equal(join.statusCode, 200);

    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.ok(createRequest, "Attendee create request was not made");
    assert.deepEqual(JSON.parse(createRequest.body), fixture.staticAttendee.normalized);
    assert.equal(createRequest.body, fixture.staticAttendee.serialized);
    assert.equal(Buffer.byteLength(createRequest.body), fixture.staticAttendee.utf8ByteLength);
    assert.equal(Buffer.from(createRequest.body).toString("hex"), fixture.staticAttendee.serializedHex);
    assert.equal(createRequest.options.headers["Content-Length"], fixture.staticAttendee.utf8ByteLength);
    assert.deepEqual(Object.keys(JSON.parse(createRequest.body)).sort(), ["bot_name", "meeting_url", "websocket_settings"]);
    assert.equal("voice_agent_settings" in JSON.parse(createRequest.body), false);

    const client = harness.connect();
    const pcm = Buffer.from(fixture.pcm.base64, "base64");
    const chunks = splitPcmBySamples(pcm, fixture.pcm.chunkings[0]);
    for (const chunk of chunks) harness.pipelines[0].onAudio(chunk);

    assert.equal(client.sent.length, fixture.pcm.botOutputSendCount);
    assert.deepEqual(client.sent, fixture.pcm.botOutputSerialized);
    assert.equal(client.sent.reduce((total, serialized) => {
      const payload = JSON.parse(serialized);
      assert.equal(payload.trigger, "realtime_audio.bot_output");
      assert.equal(payload.data.sample_rate, fixture.pcm.sampleRate);
      return total + Buffer.from(payload.data.chunk, "base64").length;
    }, 0), fixture.pcm.byteCount);
    assert.deepEqual(Buffer.concat(client.sent.map((serialized) => Buffer.from(JSON.parse(serialized).data.chunk, "base64"))), pcm);

    assertStaticIsolation(harness.isolation);
  });
});

test("static-isolation detector rejects an in-memory live socket violation", () => {
  const simulated = emptyIsolationEvidence();
  simulated.socketCreations.push("simulated local-avatar socket");
  assert.throws(() => assertStaticIsolation(simulated), /local-avatar socket/);
  simulated.socketCreations.length = 0;
  assert.doesNotThrow(() => assertStaticIsolation(simulated));
});

test("mixed input, echo gate, reconnect, and delayed cleanup stay fixed", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.join();
    const firstClient = harness.connect();
    const firstPipeline = harness.pipelines[0];
    const mixed = Buffer.from([9, 8, 7, 6]);
    const mixedMessage = JSON.stringify({ trigger: "realtime_audio.mixed", data: { chunk: mixed.toString("base64") } });

    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.deepEqual(firstPipeline.receivedInput, [mixed]);

    firstPipeline.turnState.isAgentSpeaking = true;
    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.equal(firstPipeline.receivedInput.length, 1);
    assert.equal(firstPipeline.turnState.droppedEchoFrames, 1);

    firstPipeline.turnState.isAgentSpeaking = false;
    firstPipeline.turnState.inputCooldownUntil = Date.now() + 1000;
    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.equal(firstPipeline.receivedInput.length, 1);
    assert.equal(firstPipeline.turnState.droppedEchoFrames, 2);

    firstPipeline.turnState.inputCooldownUntil = 0;
    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.deepEqual(firstPipeline.receivedInput, [mixed, mixed]);
    assert.equal(firstPipeline.turnState.droppedEchoFrames, 0);

    firstClient.emit("close");
    assert.equal(firstPipeline.closeCalls, 1);
    const secondClient = harness.connect();
    assert.equal(secondClient.closed.length, 0);
    assert.equal(harness.pipelines.length, 2);

    await delay(30);
    assert.equal((await harness.activeSession()).body.active, true, "reconnect must cancel delayed cleanup");

    secondClient.emit("close");
    assert.equal(harness.pipelines[1].closeCalls, 1);
    assert.equal((await harness.activeSession()).body.active, true, "cleanup must remain delayed");
    await delay(30);
    assert.equal((await harness.activeSession()).body.active, false);
  });
});

test("exit, leave, and reconnect rejection retain current lifecycle behavior", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.join();
    const client = harness.connect();

    harness.pipelines[0].emit("exit_requested", {
      sessionId: FIXED_SESSION_ID,
      trigger: "voice_command",
      text: "退出します",
    });
    assert.deepEqual(client.closed, [{ code: 1000, reason: "Exit requested by user" }]);
    assert.equal(harness.httpsRequests.some((request) => request.options.path === "/api/v1/bots/bot-static-173/leave"), true);

    const rejectedReconnect = harness.connect();
    assert.deepEqual(rejectedReconnect.closed, [{ code: 1000, reason: "Session is leaving" }]);
    assert.equal(harness.pipelines.length, 1);

    const leave = await harness.leave();
    assert.equal(leave.statusCode, 200);
    assert.match(leave.text, /退出リクエスト送信/);
    assert.equal((await harness.activeSession()).body.active, false);
  });
});

test("static path forwards greeting and turn configuration without avatar capability", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.join({ greeting: "固定された挨拶", prompt: "固定された指示" });
    harness.connect();

    const handlerConfig = harness.pipelineConfigCalls.at(-1);
    assert.equal(handlerConfig.overrides.greeting, "固定された挨拶");
    assert.equal(handlerConfig.overrides.prompt, "固定された指示");
    assert.equal(handlerConfig.overrides.wakeMode, "off");
    assert.equal(harness.pipelines[0].session.config.greeting, "固定された挨拶");
    assert.equal(Object.keys(harness.pipelines[0].options).some((key) => /avatar/i.test(key)), false);
    assertStaticIsolation(harness.isolation);
  });
});

function assertStaticIsolation(evidence) {
  assert.deepEqual(evidence.moduleLoads, [], `unexpected local-avatar module: ${evidence.moduleLoads.join(", ")}`);
  assert.deepEqual(evidence.capabilities, [], `unexpected local-avatar capability: ${evidence.capabilities.join(", ")}`);
  assert.deepEqual(evidence.pageReads, [], `unexpected local-avatar page read: ${evidence.pageReads.join(", ")}`);
  assert.deepEqual(evidence.socketCreations, [], `unexpected local-avatar socket: ${evidence.socketCreations.join(", ")}`);
  assert.deepEqual(evidence.timerCreations, [], `unexpected local-avatar timer: ${evidence.timerCreations.join(", ")}`);
  assert.deepEqual(evidence.networkRequests, [], `unexpected local-avatar network: ${evidence.networkRequests.join(", ")}`);
}

function emptyIsolationEvidence() {
  return {
    moduleLoads: [],
    capabilities: [],
    pageReads: [],
    socketCreations: [],
    timerCreations: [],
    networkRequests: [],
  };
}

async function withMeetRoutes(fn) {
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
  ].map((file) => path.join(src, file));
  const cachePaths = [routesPath, ...mockPaths];
  const previousCache = new Map(cachePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of cachePaths) delete require.cache[require.resolve(file)];

  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "test-key",
    FISH_AUDIO_API_KEY: "fish-test-key",
    SESSION_GRACE_CLOSE_MS: "20",
    SLACK_NOTIFY_ENABLED: "false",
    SUMMARY_ENABLED: "false",
    JOIN_SHARED_TOKEN: undefined,
    WS_SHARED_TOKEN: undefined,
  });
  const isolation = emptyIsolationEvidence();
  const httpsRequests = [];
  const pipelines = [];
  const pipelineConfigCalls = [];
  const originalHttpsRequest = https.request;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsGet = https.get;
  const originalFetch = global.fetch;
  const originalRandomUUID = crypto.randomUUID;
  const originalLoad = Module._load;
  const originalReadFile = fs.readFile;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };

  class GuardedWebSocket {
    static OPEN = 1;
    constructor(url) {
      isolation.socketCreations.push(String(url));
    }
  }

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: fixture.pcm.sampleRate,
    TTS_PROVIDER: "fish-audio",
    loadConfig: () => ({ attendee: { apiKey: "test-key" }, slack: { notifications: {} } }),
    validateSttProviderApiKey: () => true,
    resolveMessages: () => ({ delegation: {}, slack: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: (overrides = {}) => {
      pipelineConfigCalls.push({ overrides: { ...overrides } });
      return {
        stt: { provider: "soniox", sampleRate: 16_000 },
        llm: { provider: "openclaw", model: "test", gateway: { url: "http://gateway.invalid", token: "test" } },
        tts: { sampleRate: fixture.pcm.sampleRate },
        gatewayEvents: { enabled: false },
        greeting: overrides.greeting || "",
      };
    },
  });
  installMock(path.join(src, "pipeline.js"), {
    createPipeline: (session, turnState, onAudio, config, options) => {
      const pipeline = new EventEmitter();
      Object.assign(pipeline, {
        session,
        turnState,
        onAudio,
        config,
        options,
        receivedInput: [],
        closeCalls: 0,
        sendAudio(buffer) { this.receivedInput.push(Buffer.from(buffer)); },
        close() { this.closeCalls += 1; },
        getDelegationResults: () => [],
      });
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  installMock(path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: () => {},
    warmUpMultipleAgents: () => {},
  });
  installMock(path.join(src, "session-events.js"), { SessionLifecycle: FakeLifecycle });
  installMock(path.join(src, "slack-notifier.js"), { SlackNotifier: FakeSlackNotifier });
  installMock(path.join(src, "summarizer.js"), { summarizeConversation: async () => "" });
  installMock(path.join(src, "agent-profile.js"), {
    resolveAgentProfile: () => ({
      agentId: "caty",
      name: "Caty",
      displayName: "AI",
      attendeeApiKey: "test-key",
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
      trackGatewaySession: () => {},
      untrackGatewaySession: () => false,
      findGatewayRoute: () => null,
    }),
  });
  installMock(path.join(src, "ui-routes.js"), {
    servePublicAsset: (_req, _res, url) => {
      if (/local-avatar/i.test(url.pathname)) isolation.pageReads.push(url.pathname);
      return false;
    },
    sendMetricsSummary: async () => false,
  });
  installMock(path.join(src, "paths.js"), {
    logsDir: () => "/tmp/meetmate-m0-logs",
    avatarCachePath: () => "/tmp/meetmate-m0-avatar.png",
    bundledAssetPath: (name) => `/tmp/${name}`,
    bundledPublicDir: () => "/tmp/meetmate-m0-public",
  });

  Module._load = function guardedLoad(request, parent, isMain) {
    if (/local-avatar/i.test(String(request))) isolation.moduleLoads.push(String(request));
    if (request === "ws") return { WebSocket: GuardedWebSocket };
    if (request === "@deepgram/sdk") {
      return {
        createClient: () => ({ agent: () => new EventEmitter() }),
        AgentEvents: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  fs.readFile = function guardedReadFile(filename, ...args) {
    if (/local-avatar/i.test(String(filename))) isolation.pageReads.push(String(filename));
    return originalReadFile.call(this, filename, ...args);
  };
  global.setTimeout = function guardedTimeout(callback, ms, ...args) {
    const stack = new Error().stack || "";
    if (/src\/.*local-avatar/i.test(stack)) isolation.timerCreations.push(stack);
    return originalSetTimeout(callback, ms, ...args);
  };
  global.setInterval = function guardedInterval(callback, ms, ...args) {
    const stack = new Error().stack || "";
    if (/src\/.*local-avatar/i.test(stack)) isolation.timerCreations.push(stack);
    return originalSetInterval(callback, ms, ...args);
  };
  https.request = (options, callback) => {
    const record = { options, body: "" };
    httpsRequests.push(record);
    if (options.hostname !== "app.attendee.dev") isolation.networkRequests.push(`${options.hostname}${options.path}`);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = (chunk) => { record.body += String(chunk); };
    request.end = () => {
      if (options.path === "/api/v1/bots") {
        const payload = JSON.parse(record.body);
        for (const key of Object.keys(payload)) {
          if (/avatar|voice_agent/i.test(key)) isolation.capabilities.push(key);
        }
      }
      const response = new EventEmitter();
      response.statusCode = options.path === "/api/v1/bots" ? 201 : 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", options.path === "/api/v1/bots" ? '{"id":"bot-static-173"}' : "{}");
        response.emit("end");
      });
    };
    return request;
  };
  http.request = (...args) => {
    isolation.networkRequests.push(String(args[0]));
    return originalHttpRequest(...args);
  };
  http.get = (...args) => {
    isolation.networkRequests.push(String(args[0]));
    return originalHttpGet(...args);
  };
  https.get = (...args) => {
    isolation.networkRequests.push(String(args[0]));
    return originalHttpsGet(...args);
  };
  global.fetch = async (...args) => {
    isolation.networkRequests.push(String(args[0]));
    throw new Error("unexpected static-path fetch");
  };
  crypto.randomUUID = () => FIXED_SESSION_ID;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  let routes;
  const clients = [];
  try {
    routes = require(routesPath);
    const harness = {
      isolation,
      httpsRequests,
      pipelines,
      pipelineConfigCalls,
      async join(overrides = {}) {
        return requestHttp(routes, "POST", "/join-meeting", {
          meetingUrl: fixture.staticAttendee.normalized.meeting_url,
          wsUrl: "wss://meetmate.example/realtime?mode=static",
          conversationMode: "one_to_one",
          ...overrides,
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
      leave() {
        return requestHttp(routes, "POST", "/leave-meeting", { sessionId: FIXED_SESSION_ID });
      },
      activeSession() {
        return requestHttp(routes, "GET", "/active-session");
      },
    };
    await fn(harness);
  } finally {
    for (const client of clients) {
      client.emit("close");
      client.removeAllListeners();
    }
    await new Promise((resolve) => originalSetTimeout(resolve, 25));
    https.request = originalHttpsRequest;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.get = originalHttpsGet;
    global.fetch = originalFetch;
    crypto.randomUUID = originalRandomUUID;
    Module._load = originalLoad;
    fs.readFile = originalReadFile;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    Object.assign(console, originalConsole);
    restoreEnv();
    for (const file of cachePaths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
  }
}

class FakeLifecycle extends EventEmitter {
  constructor(sessionId, platform, meta) {
    super();
    this.sessionId = sessionId;
    this.platform = platform;
    this._meta = meta;
    this.state = "created";
    this.isTerminal = false;
  }
  transition(state) {
    this.state = state;
    this.isTerminal = ["completed", "failed", "cancelled"].includes(state);
  }
  setConversationLog(log) { this._conversationLog = log; }
}

class FakeSlackNotifier {
  constructor() { this.enabled = false; }
  postStatus() { return Promise.resolve(); }
  startElapsedUpdates() {}
  stopElapsedUpdates() {}
  postSummary() { return Promise.resolve(); }
  postTranscript() { return Promise.resolve(); }
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
  send(payload) { this.sent.push(payload); }
  close(code, reason) { this.closed.push({ code, reason }); }
  terminate() { this.terminated += 1; }
  ping() {}
}

async function requestHttp(routes, method, url, formData = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.destroy = () => {};
  const result = { statusCode: null, headers: null, text: "", body: null };
  const res = {
    writeHead(statusCode, headers) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(body = "") {
      result.text = String(body);
      if (result.headers?.["Content-Type"]?.startsWith("application/json")) result.body = JSON.parse(result.text);
    },
  };
  const pending = routes.handleHttp(req, res);
  await Promise.resolve();
  if (formData) req.emit("data", Buffer.from(stringify(formData)));
  req.emit("end");
  await pending;
  return result;
}

function splitPcmBySamples(buffer, sampleCounts) {
  const chunks = [];
  let offset = 0;
  for (const count of sampleCounts) {
    chunks.push(buffer.subarray(offset, offset + count * 2));
    offset += count * 2;
  }
  assert.equal(offset, buffer.length);
  return chunks;
}

function installMock(filename, exports) {
  const resolved = require.resolve(filename);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
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
