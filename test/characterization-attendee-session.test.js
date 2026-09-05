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
const realSessionEvents = require("../src/session-events");
const { sessionUserFor } = require("../src/session-user");

const FIXED_SESSION_ID = "00000000-0000-4000-8000-000000000099";
const FIXED_RANDOM_BYTES = Buffer.alloc(16, 0x99);

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

function staticSettings(overrides = {}) {
  return {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "test-model" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-secret" },
    tts: { provider: "fish-audio", apiKey: "fish-secret", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-secret", baseUrl: "app.attendee.dev" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
    ...overrides,
  };
}

function initializeRuntime(options = {}) {
  resolver.resetRuntimeForTest();
  readiness.reset();
  resolver.initializeRuntime({
    state: options.setupIncomplete
      ? {
          exists: false,
          valid: false,
          parsed: null,
          revision: "bootstrap",
          fingerprint: "missing",
        }
      : {
          exists: true,
          valid: true,
          parsed: staticSettings(options.settingsOverrides),
          revision: "a".repeat(64),
          fingerprint: "characterization-attendee-session",
        },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: options.homeDir,
      configPath: path.join(options.homeDir, "config.json"),
      connection: Object.freeze({
        openclawUrl: "https://gateway.example",
        openclawToken: "gateway-secret",
        openaiApiKey: "",
      }),
    }),
    serverPort: 5005,
  });
  if (!options.setupIncomplete) {
    for (const system of readiness.gateSystems()) {
      readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
    }
  }
}

function unavailableNgrokHttpGet() {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  queueMicrotask(() => request.emit("error", Object.assign(new Error("ngrok unavailable in test"), { code: "ECONNREFUSED" })));
  return request;
}

async function requestHttp(routes, method, url, formData = null, headers = {}, options = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5005 };
  req.destroy = () => {};
  const result = { statusCode: null, headers: null, text: "", body: null };
  let responseEndThrown = false;
  const res = {
    writeHead(statusCode, responseHeaders) {
      result.statusCode = statusCode;
      result.headers = responseHeaders;
    },
    end(body = "") {
      if (options.throwOnFirstSuccessEnd && result.statusCode === 200 && !responseEndThrown) {
        responseEndThrown = true;
        throw new Error("response write failed after bot launch");
      }
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

async function withMeetRoutes(fn, options = {}) {
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
    "llm-provider.js",
    "session-coordinator.js",
    "session-user.js",
  ].map((name) => path.join(src, name));
  const cachePaths = [routesPath, ...mockPaths];
  const previousCache = new Map(cachePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of cachePaths) delete require.cache[require.resolve(file)];

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-char-session-"));
  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "attendee-secret",
    FISH_AUDIO_API_KEY: "fish-secret",
    SESSION_GRACE_CLOSE_MS: options.sessionGraceCloseMs || "10",
    JOIN_SHARED_TOKEN: undefined,
    WS_SHARED_TOKEN: options.wsSharedToken,
    OPENCLAW_WORKSPACE: undefined,
  });
  initializeRuntime({ ...options, homeDir });

  const createdLifecycles = [];
  const pipelines = [];
  const clients = [];
  const httpsRequests = [];
  const consoleOutput = [];
  const retainedSessionIds = new Set();
  const warmups = [];
  const lcmCompleteCalls = [];
  const sessionUserCalls = [];
  const operations = [];
  let trackedSessions = null;

  const coordinatorState = {
    lease: options.initialLease || null,
    tryAcquireCalls: [],
    releaseCalls: [],
    releaseSnapshots: [],
  };
  const coordinator = options.coordinator || {
    active() {
      return coordinatorState.lease
        ? { transport: coordinatorState.lease.transport, sessionId: coordinatorState.lease.sessionId }
        : null;
    },
    tryAcquire(transport, sessionId) {
      coordinatorState.tryAcquireCalls.push({ transport, sessionId });
      operations.push(`acquire:${transport}:${sessionId}`);
      if (options.acquireError) throw options.acquireError;
      if (coordinatorState.lease) {
        return coordinatorState.lease.transport === transport && coordinatorState.lease.sessionId === sessionId
          ? coordinatorState.lease
          : null;
      }
      coordinatorState.lease = Object.freeze({ transport, sessionId });
      return coordinatorState.lease;
    },
    release(lease) {
      coordinatorState.releaseCalls.push(lease);
      coordinatorState.releaseSnapshots.push({
        sessionId: lease?.sessionId,
        registryHasSession: trackedSessions?.has(lease?.sessionId) === true,
      });
      operations.push(`release:${lease?.sessionId || "none"}`);
      if (lease && lease === coordinatorState.lease) coordinatorState.lease = null;
    },
  };

  const originalHttpsRequest = https.request;
  const originalHttpGet = http.get;
  const originalRandomUUID = crypto.randomUUID;
  const originalRandomBytes = crypto.randomBytes;
  const originalLoad = Module._load;
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const NativeMap = global.Map;
  let lifecycleRegistry = null;

  const recordingSessionEvents = {
    ...realSessionEvents,
    SessionLifecycle: class RecordingLifecycle extends realSessionEvents.SessionLifecycle {
      constructor(...args) {
        super(...args);
        this.recordedEvents = [];
        this.on("state_change", (event) => this.recordedEvents.push({ type: "state_change", event }));
        this.on("session_start", (event) => this.recordedEvents.push({ type: "session_start", event }));
        this.on("session_end", (event) => this.recordedEvents.push({ type: "session_end", event }));
        createdLifecycles.push(this);
      }
    },
  };
  class ObservableMap extends NativeMap {
    set(key, value) {
      const result = super.set(key, value);
      if (value instanceof recordingSessionEvents.SessionLifecycle) lifecycleRegistry = this;
      return result;
    }
  }

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: 24_000,
    TTS_PROVIDER: "fish-audio",
    loadConfig: () => staticSettings(options.settingsOverrides),
    resolveMessages: () => ({ delegation: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: (overrides = {}) => ({
      stt: { provider: "soniox", sampleRate: 16_000 },
      llm: {
        provider: options.enableLcm ? "openclaw" : "test",
        model: "test-model",
        gateway: { url: "http://gateway.invalid", token: "test" },
      },
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
        getSessionUsers() {
          const base = sessionUserFor(
            pipelineOptions.transport ?? "meet",
            session.id,
            pipelineOptions.agentProfile?.agentId
          );
          return { parent: base, delegate: `${base}-delegate` };
        },
      });
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  installMock(path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: (...args) => { warmups.push(args); },
  });
  installMock(path.join(src, "session-events.js"), recordingSessionEvents);
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
    createGatewaySessionTracker: ({ sessions }) => {
      trackedSessions = sessions;
      return {
        trackGatewaySession() {},
        untrackGatewaySession(sessionId, { retainIfDelegations } = {}) {
          return retainIfDelegations === true && retainedSessionIds.has(sessionId);
        },
        findGatewayRoute() {
          return null;
        },
      };
    },
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
  installMock(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      async complete(messages, completeOptions) {
        lcmCompleteCalls.push({ messages, options: completeOptions });
        return { statusCode: 200, text: "{}" };
      },
    }),
  });
  installMock(path.join(src, "session-coordinator.js"), coordinator);
  installMock(path.join(src, "session-user.js"), {
    sessionUserFor(transport, sessionId, agentId) {
      sessionUserCalls.push([transport, sessionId, agentId]);
      return sessionUserFor(transport, sessionId, agentId);
    },
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
    request.destroy = (error) => {
      record.destroyError = error || null;
      if (error) request.emit("error", error);
    };
    request.write = (chunk) => { record.body += String(chunk); };
    request.end = () => {
      operations.push(`https:${requestOptions.path}`);
      if (options.leaveRequestError && requestOptions.path.endsWith("/leave")) {
        queueMicrotask(() => request.emit("error", new Error("leave request failed")));
        return;
      }
      if (options.stallLeaveRequest && requestOptions.path.endsWith("/leave")) return;
      const response = new EventEmitter();
      if (requestOptions.path === "/api/v1/bots") {
        response.statusCode = options.attendeeCreateStatus || 201;
      } else {
        response.statusCode = 200;
      }
      callback(response);
      const finishResponse = () => queueMicrotask(() => {
        if (requestOptions.path === "/api/v1/bots") {
          const responseBody = options.attendeeCreateBody || '{"id":"bot-char-99"}';
          record.responseBody = responseBody;
          response.emit("data", responseBody);
        } else {
          record.responseBody = "{}";
          response.emit("data", "{}");
        }
        response.emit("end");
        operations.push(`https-end:${requestOptions.path}`);
      });
      if (options.leaveResponseGate && requestOptions.path.endsWith("/leave")) {
        options.leaveResponseGate.then(finishResponse);
      } else {
        finishResponse();
      }
    };
    return request;
  };
  http.get = unavailableNgrokHttpGet;
  crypto.randomUUID = () => FIXED_SESSION_ID;
  crypto.randomBytes = () => FIXED_RANDOM_BYTES;
  console.log = (...args) => { consoleOutput.push(args.map(String).join(" ")); };
  console.warn = (...args) => { consoleOutput.push(args.map(String).join(" ")); };
  console.error = (...args) => { consoleOutput.push(args.map(String).join(" ")); };

  try {
    let routes;
    global.Map = ObservableMap;
    try {
      routes = require(routesPath);
    } finally {
      global.Map = NativeMap;
    }
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
      routes,
      pipelines,
      lifecycles: createdLifecycles,
      httpsRequests,
      consoleOutput,
      warmups,
      lcmCompleteCalls,
      sessionUserCalls,
      operations,
      coordinator: { api: coordinator, state: coordinatorState },
      trackedSessions: () => trackedSessions,
      lifecycleRegistryHas(sessionId = FIXED_SESSION_ID) {
        return lifecycleRegistry?.has(sessionId) === true;
      },
      join(form = {}, headers = {}, requestOptions = {}) {
        return requestHttp(routes, "POST", "/join-meeting", {
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          wsUrl: "wss://meetmate.example/realtime",
          conversationMode: "one_to_one",
          ...form,
        }, headers, requestOptions);
      },
      activeSession() {
        return requestHttp(routes, "GET", "/active-session");
      },
      leave(sessionId = FIXED_SESSION_ID) {
        return requestHttp(routes, "POST", "/leave-meeting", { sessionId });
      },
      connect({ sid = FIXED_SESSION_ID, token = "" } = {}) {
        const client = new FakeClient();
        clients.push(client);
        const query = token ? `?sid=${sid}&token=${token}` : `?sid=${sid}`;
        routes.handleWsConnection(client, {
          url: `/realtime${query}`,
          socket: { remoteAddress: "127.0.0.1" },
        });
        return client;
      },
      retainSession(sessionId = FIXED_SESSION_ID) {
        retainedSessionIds.add(sessionId);
      },
      releaseSession(sessionId = FIXED_SESSION_ID) {
        retainedSessionIds.delete(sessionId);
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
    crypto.randomBytes = originalRandomBytes;
    Module._load = originalLoad;
    global.Map = NativeMap;
    Object.assign(console, originalConsole);
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

function eventKeys(lifecycle, type) {
  return lifecycle.recordedEvents
    .filter((item) => item.type === type)
    .map((item) => Object.keys(item.event).sort());
}

function findLastEvent(lifecycle, type) {
  return lifecycle.recordedEvents.filter((item) => item.type === type).at(-1)?.event || null;
}

test("join guard order stays 503 then 409 then 400, and retention keeps the 409 surface", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const blocked = await harness.join({
      meetingUrl: "not-a-meeting",
      wsUrl: "not-a-websocket",
    });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.body.error.code, "MEETING_SETUP_REQUIRED");
    assert.equal(harness.httpsRequests.length, 0);
  }, { setupIncomplete: true });

  await withMeetRoutes(async (harness) => {
    const missingOrigin = await harness.join({
      avatarExperiment: "hybrid-local-l0",
    });
    assert.equal(missingOrigin.statusCode, 400);
    assert.equal(missingOrigin.text, "hybrid-local-l0 には公開 HTTPS origin が必要です。");
    assert.equal(harness.coordinator.state.tryAcquireCalls.length, 0);
  }, { settingsOverrides: { server: { ngrokDomain: "" } } });

  await withMeetRoutes(async (harness) => {
    const invalidUrl = await harness.join({
      meetingUrl: "https://example.com/not-meet",
      wsUrl: "wss://meetmate.example/realtime",
    });
    assert.equal(invalidUrl.statusCode, 400);
    assert.equal(invalidUrl.text, "meetingUrl が Google Meet または Zoom の URL 形式ではありません。");
    assert.equal(harness.coordinator.state.tryAcquireCalls.length, 0);

    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);
    harness.connect();

    const duplicate = await harness.join({
      meetingUrl: "https://example.com/not-meet",
      wsUrl: "not-even-checked",
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(
      duplicate.text,
      `既にアクティブなセッションがあります（${FIXED_SESSION_ID}）。退出してから再度参加してください。`
    );

    harness.retainSession();
    const leave = await harness.leave();
    assert.equal(leave.statusCode, 200);
    assert.equal(harness.coordinator.state.releaseCalls.length, 0);

    const retained = await harness.join();
    assert.equal(retained.statusCode, 409);
    assert.equal(
      retained.text,
      `既にアクティブなセッションがあります（${FIXED_SESSION_ID}）。退出してから再度参加してください。`
    );
  });
});

test("Attendee join/connect/leave keeps the observed meet collapse, lifecycle payloads, and omitted pipeline transport options", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const joined = await harness.join({
      meetingUrl: "https://company.zoom.us/j/123456789?pwd=abc",
    });
    assert.equal(joined.statusCode, 200);

    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.ok(createRequest);
    const botPayload = JSON.parse(createRequest.body);
    assert.equal(botPayload.websocket_settings.audio.sample_rate, 16_000);

    const client = harness.connect();
    const lifecycle = harness.lifecycles[0];
    assert.ok(lifecycle);
    assert.equal(lifecycle.transport, "meet");
    assert.equal(Object.hasOwn(harness.pipelines[0].options, "transport"), false);
    assert.equal(Object.hasOwn(harness.pipelines[0].options, "capabilities"), false);
    assert.deepEqual(harness.pipelines[0].getSessionUsers(), {
      parent: `meet-${FIXED_SESSION_ID}-caty`,
      delegate: `meet-${FIXED_SESSION_ID}-caty-delegate`,
    });

    const active = await harness.activeSession();
    assert.equal(active.statusCode, 200);
    assert.deepEqual(Object.keys(active.body).sort(), ["active", "sessions"]);
    assert.equal(active.body.active, true);
    assert.deepEqual(Object.keys(active.body.sessions[0]).sort(), [
      "agentDisplayNames",
      "agentIds",
      "botId",
      "hasConnection",
      "meetingUrl",
      "sessionId",
      "startedAt",
      "state",
    ]);
    assert.equal(active.body.sessions[0].sessionId, FIXED_SESSION_ID);
    assert.equal(active.body.sessions[0].state, "in-progress");
    assert.equal(active.body.sessions[0].botId, "bot-char-99");
    assert.equal(active.body.sessions[0].hasConnection, true);

    assert.deepEqual(eventKeys(lifecycle, "state_change"), [
      ["from", "meta", "sessionId", "timestamp", "to", "transport"],
      ["from", "meta", "sessionId", "timestamp", "to", "transport"],
    ]);
    assert.equal(lifecycle.recordedEvents[0].event.transport, "meet");
    assert.deepEqual(
      lifecycle.recordedEvents.slice(0, 2).map((item) => [item.event.from, item.event.to]),
      [["idle", "initiating"], ["initiating", "in-progress"]]
    );
    assert.deepEqual(eventKeys(lifecycle, "session_start"), [
      ["agents", "from", "sessionId", "timestamp", "to", "transport"],
    ]);
    assert.equal(findLastEvent(lifecycle, "session_start").transport, "meet");

    const leave = await harness.leave();
    assert.equal(leave.statusCode, 200);
    assert.equal(harness.coordinator.state.releaseCalls.length, 1);
    assert.deepEqual(harness.coordinator.state.releaseSnapshots, [{
      sessionId: FIXED_SESSION_ID,
      registryHasSession: false,
    }]);
    assert.deepEqual(client.closed, [{ code: 1000, reason: "leave_requested" }]);
    assert.deepEqual(lifecycle.toJSON().history.map((item) => item.state), [
      "idle",
      "initiating",
      "in-progress",
      "completed",
    ]);
    assert.equal(lifecycle.state, "completed");
    assert.equal(findLastEvent(lifecycle, "state_change").meta.reason, "leave_requested");
    assert.equal(findLastEvent(lifecycle, "state_change").transport, "meet");
    assert.equal(findLastEvent(lifecycle, "session_end").state, "completed");
    assert.equal(findLastEvent(lifecycle, "session_end").transport, "meet");
    assert.deepEqual(eventKeys(lifecycle, "session_end"), [
      ["agents", "conversationLog", "duration", "durationFormatted", "sessionId", "state", "timestamp", "transport"],
    ]);
  });
});

test("bot launch failure stays initiating -> failed with bot_launch_failed metadata", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const failed = await harness.join();
    assert.equal(failed.statusCode, 502);
    assert.match(failed.text, /Bot起動エラー \(upstream_status=502\) \[code=BOT_LAUNCH_UPSTREAM_ERROR\]/);

    const lifecycle = harness.lifecycles[0];
    assert.ok(lifecycle);
    assert.deepEqual(lifecycle.toJSON().history.map((item) => item.state), [
      "idle",
      "initiating",
      "failed",
    ]);
    const lastStateChange = findLastEvent(lifecycle, "state_change");
    assert.equal(lastStateChange.meta.reason, "bot_launch_failed");
    assert.equal(lastStateChange.meta.statusCode, 502);
    assert.equal(findLastEvent(lifecycle, "session_end").state, "failed");
    assert.equal(harness.coordinator.state.releaseCalls.length, 1);
    assert.deepEqual(harness.coordinator.state.releaseSnapshots, [{
      sessionId: FIXED_SESSION_ID,
      registryHasSession: false,
    }]);
    assert.equal((await harness.activeSession()).body.active, false);
    assert.equal(harness.httpsRequests.some((request) => request.options.path.endsWith("/leave")), false);
  }, {
    attendeeCreateStatus: 502,
    attendeeCreateBody: '{"error":"upstream failed"}',
  });
});

test("Attendee coordinator failures stay fail-closed with the exact cross-transport 409 before vendor launch", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const refused = await harness.join();
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.text, "Session coordinator unavailable: missing required methods");
    assert.equal(harness.httpsRequests.length, 0);
  }, { coordinator: {} });

  await withMeetRoutes(async (harness) => {
    const refused = await harness.join();
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.text, "Session coordinator unavailable: coordinator offline");
    assert.equal(harness.httpsRequests.length, 0);
  }, { acquireError: new Error("coordinator offline") });

  await withMeetRoutes(async (harness) => {
    const refused = await harness.join();
    assert.equal(refused.statusCode, 409);
    assert.equal(
      refused.text,
      "既にアクティブなセッションがあります（dc-existing）。退出してから再度参加してください。"
    );
    assert.deepEqual(harness.coordinator.state.tryAcquireCalls, [{
      transport: "meet",
      sessionId: FIXED_SESSION_ID,
    }]);
    assert.equal(harness.httpsRequests.length, 0);
  }, { initialLease: Object.freeze({ transport: "discord", sessionId: "dc-existing" }) });
});

test("Attendee catch rollback waits for launched-bot leave, then deletes before releasing even when leave errors", { concurrency: false }, async () => {
  let releaseLeave;
  const leaveResponseGate = new Promise((resolve) => { releaseLeave = resolve; });
  await withMeetRoutes(async (harness) => {
    const pending = harness.join({}, {}, { throwOnFirstSuccessEnd: true });
    await waitUntil(() => harness.httpsRequests.some((request) => request.options.path.endsWith("/leave")));

    const leaveRequest = harness.httpsRequests.find((request) => request.options.path.endsWith("/leave"));
    assert.equal(leaveRequest.options.path, "/api/v1/bots/bot-char-99/leave");
    assert.equal(leaveRequest.options.headers.Authorization, "Token attendee-secret");
    assert.equal(leaveRequest.body, "{}");
    assert.equal(harness.coordinator.state.releaseCalls.length, 0);

    releaseLeave();
    const failed = await pending;
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.text, "join-meeting エラー: response write failed after bot launch");
    assert.equal(harness.coordinator.state.releaseCalls.length, 1);
    assert.deepEqual(harness.coordinator.state.releaseSnapshots, [{
      sessionId: FIXED_SESSION_ID,
      registryHasSession: false,
    }]);
    assert.equal(harness.lifecycleRegistryHas(), false);
    const leaveEndIndex = harness.operations.indexOf("https-end:/api/v1/bots/bot-char-99/leave");
    const releaseIndex = harness.operations.indexOf(`release:${FIXED_SESSION_ID}`);
    assert.notEqual(leaveEndIndex, -1);
    assert.notEqual(releaseIndex, -1);
    assert.ok(leaveEndIndex < releaseIndex);
    assert.equal((await harness.activeSession()).body.active, false);
  }, { leaveResponseGate });

  await withMeetRoutes(async (harness) => {
    const failed = await harness.join({}, {}, { throwOnFirstSuccessEnd: true });
    assert.equal(failed.statusCode, 500);
    assert.equal(harness.coordinator.state.releaseCalls.length, 1);
    assert.equal((await harness.activeSession()).body.active, false);
  }, { leaveRequestError: true });

  await withMeetRoutes(async (harness) => {
    const guard = Symbol("rollback deadline guard");
    let guardTimer;
    const failed = await Promise.race([
      harness.join({}, {}, { throwOnFirstSuccessEnd: true }),
      new Promise((resolve) => {
        guardTimer = setTimeout(() => resolve(guard), 2_750);
      }),
    ]);
    clearTimeout(guardTimer);
    assert.notEqual(failed, guard);
    assert.equal(failed.statusCode, 500);
    assert.equal(harness.coordinator.state.releaseCalls.length, 1);
    assert.equal((await harness.activeSession()).body.active, false);
    const leaveRequest = harness.httpsRequests.find((request) => request.options.path.endsWith("/leave"));
    assert.match(leaveRequest.destroyError?.message || "", /leave timeout/);
  }, { stallLeaveRequest: true });
});

test("Attendee reused-lease rollback removes its new registry entry without releasing the existing owner", { concurrency: false }, async () => {
  const reusedLease = Object.freeze({ transport: "meet", sessionId: FIXED_SESSION_ID });
  await withMeetRoutes(async (harness) => {
    const failed = await harness.join();
    assert.equal(failed.statusCode, 502);
    assert.equal(harness.coordinator.state.releaseCalls.length, 0);
    assert.deepEqual(harness.coordinator.api.active(), {
      transport: "meet",
      sessionId: FIXED_SESSION_ID,
    });
    assert.equal((await harness.activeSession()).body.active, false);
  }, {
    initialLease: reusedLease,
    attendeeCreateStatus: 502,
    attendeeCreateBody: '{"error":"upstream failed"}',
  });
});

test("Meet warmup and LCM ingest both call sessionUserFor with the canonical transport tuple", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);
    assert.equal(harness.warmups.length, 1);
    assert.equal(harness.warmups[0][0], `meet-${FIXED_SESSION_ID}-caty`);
    assert.deepEqual(harness.sessionUserCalls[0], ["meet", FIXED_SESSION_ID, "caty"]);

    harness.connect();
    harness.pipelines[0].session.conversationLog.push({ role: "user", content: "hello" });
    const leave = await harness.leave();
    assert.equal(leave.statusCode, 200);
    await waitUntil(() => harness.lcmCompleteCalls.length === 1);

    assert.equal(harness.lcmCompleteCalls[0].options.user, `meet-${FIXED_SESSION_ID}-caty`);
    assert.deepEqual(harness.sessionUserCalls, [
      ["meet", FIXED_SESSION_ID, "caty"],
      ["meet", FIXED_SESSION_ID, "caty"],
    ]);
  }, { enableLcm: true });
});

test("meet-routes exports the shared byte-identical plain-response producer", { concurrency: false }, async () => {
  await withMeetRoutes(async ({ routes }) => {
    assert.equal(typeof routes._test.finalizeSessionIfInactive, "function");
    assert.equal(typeof routes._test.deleteSessionAndRelease, "function");
    assert.equal(typeof routes._test.rollbackJoinAttempt, "function");
    const observed = { statusCode: null, headers: null, body: "" };
    routes.writePlainResponse({
      writeHead(statusCode, headers) {
        observed.statusCode = statusCode;
        observed.headers = headers;
      },
      end(body) {
        observed.body = String(body);
      },
    }, 404, "Not Found");
    assert.deepEqual(observed, {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Not Found",
    });
  });
});

test("ws_close, supersede, and reconnect-inside-finalize window keep the observed Attendee lifecycle behavior", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);

    const lifecycle = harness.lifecycles[0];
    const firstClient = harness.connect();
    const firstPipeline = harness.pipelines[0];

    const secondClient = harness.connect();
    assert.deepEqual(firstClient.closed, [{ code: 1012, reason: "Superseded by a new connection" }]);
    assert.equal(firstPipeline.closeCalls, 1);
    assert.equal(secondClient.closed.length, 0);
    assert.equal(harness.pipelines.length, 2);

    const successorAudio = Buffer.from([1, 0, 2, 0]);
    secondClient.emit("message", Buffer.from(JSON.stringify({
      trigger: "realtime_audio.mixed",
      data: { chunk: successorAudio.toString("base64") },
    })));
    assert.deepEqual(firstPipeline.receivedAudio, []);
    assert.deepEqual(harness.pipelines[1].receivedAudio, [[successorAudio]]);

    const stateChangesBeforeSupersededClose = lifecycle.recordedEvents.filter(
      (item) => item.type === "state_change"
    ).length;
    firstClient.emit("close");
    const stateChangesAfterSupersededClose = lifecycle.recordedEvents.filter(
      (item) => item.type === "state_change"
    );
    assert.equal(stateChangesAfterSupersededClose.length, stateChangesBeforeSupersededClose + 1);
    const supersededCloseTransition = stateChangesAfterSupersededClose.at(-1).event;
    assert.deepEqual({
      from: supersededCloseTransition.from,
      to: supersededCloseTransition.to,
      transport: supersededCloseTransition.transport,
      reason: supersededCloseTransition.meta.reason,
    }, {
      from: "in-progress",
      to: "completed",
      transport: "meet",
      reason: "ws_close",
    });
    assert.equal(lifecycle.state, "completed");
    assert.equal(harness.pipelines.length, 2);

    secondClient.emit("close");
    assert.equal(harness.pipelines[1].closeCalls, 1);

    const reconnect = harness.connect();
    assert.equal(reconnect.closed.length, 0);
    assert.equal(harness.pipelines.length, 3);
    assert.equal(lifecycle.state, "completed");
    assert.equal(
      harness.consoleOutput.some((line) => line.includes(`invalid transition completed → in-progress (session=${FIXED_SESSION_ID})`)),
      true
    );

    reconnect.emit("close");
    assert.equal(harness.pipelines[2].closeCalls, 1);
    await delay(20);
    const finalStateChanges = lifecycle.recordedEvents.filter((item) => item.type === "state_change");
    assert.equal(finalStateChanges.length, stateChangesBeforeSupersededClose + 1);
    assert.equal(finalStateChanges.at(-1).event, supersededCloseTransition);
    assert.equal((await harness.activeSession()).body.active, false);
    assert.equal(findLastEvent(lifecycle, "state_change").meta.reason, "ws_close");
    assert.equal(harness.coordinator.state.releaseCalls.length, 1);
    assert.deepEqual(harness.coordinator.state.releaseSnapshots, [{
      sessionId: FIXED_SESSION_ID,
      registryHasSession: false,
    }]);
  });
});

test("websocket rejection ladder stays unknown-session then bad-token then leaving-session", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const unknown = harness.connect({ sid: "missing-session" });
    assert.deepEqual(unknown.closed, [{ code: 1008, reason: "Unknown session" }]);

    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);

    const unauthorized = harness.connect({ token: "wrong-token" });
    assert.deepEqual(unauthorized.closed, [{ code: 1008, reason: "Unauthorized websocket token" }]);

    const live = harness.connect({ token: "expected-token" });
    harness.pipelines[0].emit("exit_requested", {
      sessionId: FIXED_SESSION_ID,
      trigger: "voice_command",
      text: "退出します",
    });
    assert.deepEqual(live.closed, [{ code: 1000, reason: "Exit requested by user" }]);

    const leaving = harness.connect({ token: "expected-token" });
    assert.deepEqual(leaving.closed, [{ code: 1000, reason: "Session is leaving" }]);
  }, {
    wsSharedToken: "expected-token",
  });
});

test("getStatus keeps the frozen readiness shape", { concurrency: false }, () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-char-status-"));
  try {
    initializeRuntime({ setupIncomplete: true, homeDir });
    const status = resolver.getStatus();
    assert.deepEqual(Object.keys(status).sort(), ["issues", "meetingIssues", "meetingReady", "setupMode"]);
    assert.equal(typeof status.setupMode, "boolean");
    assert.equal(typeof status.meetingReady, "boolean");
    assert.equal(Array.isArray(status.issues), true);
  } finally {
    readiness.reset();
    resolver.resetRuntimeForTest();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
