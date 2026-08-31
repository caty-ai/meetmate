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
const realCoordinator = require("../src/session-coordinator");
const { createDiscordSessionManager } = require("../src/transport-discord/discord-session");

const FIXED_SESSION_ID = "00000000-0000-4000-8000-000000000115";
const DISCORD_SESSION_ID = "dc-held-session";
const GUILD_ID = "11111111111111111";
const CHANNEL_ID = "22222222222222222";
const AVATAR_EXPERIMENT = "hybrid-local-l0";

function installMock(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
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

function initializeRuntime(homeDir, settingsOverrides = {}) {
  resolver.resetRuntimeForTest();
  readiness.reset();
  resolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      parsed: staticSettings(settingsOverrides),
      revision: "c".repeat(64),
      fingerprint: "session-coordinator-test",
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
  queueMicrotask(() => request.emit("error", Object.assign(new Error("ngrok unavailable"), { code: "ECONNREFUSED" })));
  return request;
}

function createStubCoordinator(initialLease = null) {
  const state = {
    lease: initialLease,
    tryAcquireCalls: 0,
    releaseCalls: 0,
  };
  return {
    state,
    api: {
      tryAcquire(transport, sessionId) {
        state.tryAcquireCalls += 1;
        if (state.throwOnAcquire) throw state.throwOnAcquire;
        if (state.lease) {
          if (state.lease.transport === transport && state.lease.sessionId === sessionId) return state.lease;
          return null;
        }
        state.lease = Object.freeze({ transport, sessionId });
        return state.lease;
      },
      release(lease) {
        if (lease && lease === state.lease) {
          state.releaseCalls += 1;
          state.lease = null;
        }
      },
      active() {
        return state.lease ? { transport: state.lease.transport, sessionId: state.lease.sessionId } : null;
      },
    },
  };
}

async function requestHttp(routes, method, url, formData = null, responseOptions = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5005 };
  req.destroy = () => {};
  const result = { statusCode: null, headers: null, text: "" };
  let threwSuccessWrite = false;
  const res = {
    writeHead(statusCode, headers) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(body = "") {
      result.text += Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      if (responseOptions.throwOnFirstSuccessEnd && !threwSuccessWrite && result.statusCode === 200) {
        threwSuccessWrite = true;
        throw new Error("response write failed");
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

async function withMeetRoutesHarness(fn, options = {}) {
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const src = path.join(__dirname, "..", "src");
  const files = [
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
    "session-coordinator.js",
    path.join("transport-meet", "local-avatar-session.js"),
  ].map((name) => path.join(src, name));
  const cachePaths = [routesPath, ...files];
  const previousCache = new Map(cachePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of cachePaths) delete require.cache[require.resolve(file)];

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-session-coordinator-"));
  initializeRuntime(homeDir, options.settingsOverrides);

  const coordinator = options.coordinator || createStubCoordinator(options.initialLease);
  if (options.acquireError) coordinator.state.throwOnAcquire = options.acquireError;
  const httpsRequests = [];
  const retainedSessionIds = new Set();
  let avatarIssueCount = 0;
  const wsClients = [];

  const originalHttpsRequest = https.request;
  const originalHttpGet = http.get;
  const originalRandomUUID = crypto.randomUUID;
  const originalLoad = Module._load;

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16000,
    TTS_SAMPLE_RATE: 24000,
    TTS_PROVIDER: "fish-audio",
    loadConfig: () => staticSettings(options.settingsOverrides),
    resolveMessages: () => ({ delegation: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: () => ({
      stt: { provider: "soniox", sampleRate: 16000 },
      llm: { provider: "openclaw", model: "test-model", gateway: { url: "https://gateway.example", token: "gateway-secret" } },
      tts: { sampleRate: 24000, referenceId: "voice-id" },
      slack: { enabled: false, channelId: "", statusChannelId: "", summaryChannelId: "", notifyTarget: "dm", dmUserId: "", labels: {} },
      summary: { prompt: "summary" },
    }),
    validateSttProviderApiKey: () => true,
    HUB_CONFIG: { enabled: false },
  });
  installMock(path.join(src, "pipeline.js"), {
    createPipeline: () => {
      const pipeline = new EventEmitter();
      pipeline.sendAudio = () => {};
      pipeline.close = () => {};
      pipeline.getDelegationResults = () => [];
      return pipeline;
    },
  });
  installMock(path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: () => Promise.resolve(),
    warmUpMultipleAgents: () => Promise.resolve(),
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
  installMock(path.join(src, "summarizer.js"), { summarizeConversation: async () => ({ summary: [], decisions: [], todos: [] }) });
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
      untrackGatewaySession(sessionId, { retainIfDelegations } = {}) {
        return retainIfDelegations === true && retainedSessionIds.has(sessionId);
      },
      findGatewayRoute() {
        return null;
      },
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
  installMock(path.join(src, "session-coordinator.js"), coordinator.api);
  installMock(path.join(src, "transport-meet", "local-avatar-session.js"), {
    FRAMES_HTML_ROUTE: "/avatar/frames",
    createLocalAvatarSession() {
      avatarIssueCount += 1;
      return {
        session: { close() {}, beginSource() { return null; }, publishMarker() {}, cancelPlayback() {} },
        launchUrl: "https://avatar.example/session",
      };
    },
    redactLogValue(value) {
      return value;
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
    if (options.throwLeaveRequest && requestOptions.path?.includes("/leave")) {
      throw new Error("leave request failed");
    }
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
      queueMicrotask(async () => {
        if (requestOptions.path?.includes("/leave") && options.leaveResponseGate) {
          await options.leaveResponseGate;
        }
        const body = requestOptions.path === "/api/v1/bots" ? JSON.stringify({ id: "bot-115" }) : "{}";
        response.emit("data", body);
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
        fetchFn: async () => { throw Object.assign(new Error("network unavailable"), { code: "ENETUNREACH" }); },
        requestFn: async () => { throw Object.assign(new Error("network unavailable"), { code: "ENETUNREACH" }); },
        httpGet: unavailableNgrokHttpGet,
      },
    });
    routes._test.configureReadinessForTest({
      fetchFn: async () => { throw Object.assign(new Error("network unavailable"), { code: "ENETUNREACH" }); },
      requestFn: async () => { throw Object.assign(new Error("network unavailable"), { code: "ENETUNREACH" }); },
      httpGet: unavailableNgrokHttpGet,
    });

    await fn({
      routes,
      coordinator,
      httpsRequests,
      getAvatarIssueCount() {
        return avatarIssueCount;
      },
      retainSession(sessionId = FIXED_SESSION_ID) {
        retainedSessionIds.add(sessionId);
      },
      clearRetained(sessionId = FIXED_SESSION_ID) {
        retainedSessionIds.delete(sessionId);
      },
      join(form = {}, responseOptions = {}) {
        return requestHttp(routes, "POST", "/join-meeting", {
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          wsUrl: "wss://meetmate.example/realtime",
          conversationMode: "one_to_one",
          ...form,
        }, responseOptions);
      },
      leave(sessionId = FIXED_SESSION_ID) {
        return requestHttp(routes, "POST", "/leave-meeting", { sessionId });
      },
      activeSession() {
        return requestHttp(routes, "GET", "/active-session");
      },
      connect({ sid = FIXED_SESSION_ID, token = "" } = {}) {
        const client = new EventEmitter();
        client.readyState = 1;
        client.isAlive = true;
        client.sent = [];
        client.closed = [];
        client.terminated = 0;
        client.send = (payload) => {
          client.sent.push(payload);
        };
        client.close = (code, reason) => {
          client.closed.push({ code, reason });
        };
        client.terminate = () => {
          client.terminated += 1;
        };
        client.ping = () => {};
        wsClients.push(client);
        const query = token ? `?sid=${sid}&token=${token}` : `?sid=${sid}`;
        routes.handleWsConnection(client, {
          url: `/realtime${query}`,
          socket: { remoteAddress: "127.0.0.1" },
        });
        return client;
      },
    });
  } finally {
    for (const client of wsClients) {
      client.emit("close");
      client.removeAllListeners();
    }
    https.request = originalHttpsRequest;
    http.get = originalHttpGet;
    crypto.randomUUID = originalRandomUUID;
    Module._load = originalLoad;
    resolver.resetRuntimeForTest();
    readiness.reset();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const file of cachePaths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
  }
}

function createDiscordHarness(sessionCoordinator) {
  const player = new EventEmitter();
  player.state = { status: "idle" };
  const connection = new EventEmitter();
  connection.receiver = { subscribe() { return new EventEmitter(); } };
  connection.subscribe = () => {};
  connection.destroy = () => {};
  const guild = { id: GUILD_ID, voiceAdapterCreator: {} };
  const channel = { id: CHANNEL_ID, members: new Map() };
  const client = new EventEmitter();
  client.user = { id: "discord-bot" };
  client.login = async () => {};
  client.destroy = () => {};

  const manager = createDiscordSessionManager({
    getDiscordConfig: () => ({ token: "discord-token", guildAllowlist: [GUILD_ID] }),
    getPipelineConfig: () => ({
      systemPrompt: "system",
      greeting: "hello",
      fishKey: "fish-key",
      llm: { provider: "openclaw", model: "test-model" },
      tts: { sampleRate: 24000, referenceId: "voice", latency: "balanced", speed: 1 },
      slack: { enabled: false, channelId: "", statusChannelId: "", summaryChannelId: "", notifyTarget: "dm", dmUserId: "", labels: {} },
      summary: { prompt: "summary" },
    }),
    resolveAgentProfile: () => ({ agentId: "caty", name: "Caty", displayName: "Caty", model: "test-model", voiceId: "voice", wakeWords: ["ケイティ"] }),
    sessionCoordinator,
    loadVoiceModule: () => ({
      AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
      VoiceConnectionStatus: { Ready: "ready", Destroyed: "destroyed", Disconnected: "disconnected" },
      entersState: () => Promise.reject(new Error("reconnect timeout")),
    }),
    loadDiscordModule: () => ({ GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 }, Client: function MockClient() {} }),
    createClient: () => client,
    resolveVoiceTarget: async () => ({ guild, channel, receiver: connection.receiver }),
    joinVoice: () => connection,
    createAudioOut: () => ({
      onAudio() {},
      finish() {
        const idleState = { status: "idle" };
        const playingState = { status: "playing", resource: { playbackDuration: 900 } };
        player.state = playingState;
        player.emit("stateChange", idleState, playingState);
        queueMicrotask(() => {
          player.state = idleState;
          player.emit("stateChange", playingState, idleState);
        });
      },
      getPlayer() {
        return player;
      },
      close() {},
    }),
    createAudioIn: () => ({
      subscribeUser() {},
      unsubscribeUser() {},
      close() {},
    }),
    createPipeline: () => {
      const pipeline = new EventEmitter();
      pipeline.sendAudio = () => {};
      pipeline.close = () => {};
      return pipeline;
    },
    warmUpGatewaySession: () => Promise.resolve(),
    createNotifier: () => ({
      postStatus() { return Promise.resolve(); },
      startElapsedUpdates() {},
      stopElapsedUpdates() {},
      postSummary() { return Promise.resolve(); },
    }),
    summarizeConversation: async () => ({ summary: [], decisions: [], todos: [] }),
    synthesize: async (_text, options) => {
      options.onAudio(Buffer.alloc(24000));
    },
    now: () => 1_725_000_000_000,
    randomBytes: () => Buffer.from("abcdef", "hex"),
  });

  return { manager };
}

test("session-coordinator lease semantics stay opaque, exact, idempotent, and resettable", async () => {
  realCoordinator._test.reset();
  const first = realCoordinator.tryAcquire("meet", "sid-1");
  const reused = realCoordinator.tryAcquire("meet", "sid-1");
  const blocked = realCoordinator.tryAcquire("discord", "sid-2");

  assert.equal(first, reused);
  assert.equal(blocked, null);
  assert.deepEqual(realCoordinator.active(), { transport: "meet", sessionId: "sid-1" });

  realCoordinator.release(Object.freeze({ transport: "meet", sessionId: "sid-1" }));
  assert.deepEqual(realCoordinator.active(), { transport: "meet", sessionId: "sid-1" });

  realCoordinator.release(first);
  assert.equal(realCoordinator.active(), null);
  realCoordinator.release(first);
  assert.equal(realCoordinator.active(), null);

  realCoordinator.tryAcquire("meet", "sid-3");
  realCoordinator._test.reset();
  assert.equal(realCoordinator.active(), null);

  const secondHandle = require("../src/session-coordinator");
  secondHandle.tryAcquire("meet", "sid-4");
  assert.deepEqual(realCoordinator.active(), { transport: "meet", sessionId: "sid-4" });
  secondHandle._test.reset();
  assert.equal(realCoordinator.active(), null);
});

test("meet-routes keeps same-transport 409 byte-identical and uses the same template for cross-transport mutex busy", async () => {
  await withMeetRoutesHarness(async (harness) => {
    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);

    const duplicate = await harness.join();
    assert.equal(duplicate.statusCode, 409);
    assert.equal(
      duplicate.text,
      `既にアクティブなセッションがあります（${FIXED_SESSION_ID}）。退出してから再度参加してください。`
    );
  });

  await withMeetRoutesHarness(async (harness) => {
    const denied = await harness.join();
    assert.equal(denied.statusCode, 409);
    assert.equal(
      denied.text,
      `既にアクティブなセッションがあります（${DISCORD_SESSION_ID}）。退出してから再度参加してください。`
    );
  }, {
    initialLease: Object.freeze({ transport: "discord", sessionId: DISCORD_SESSION_ID }),
  });
});

test("attendee join validates before acquire, and cross-transport refusal happens before avatar issuance", async () => {
  await withMeetRoutesHarness(async (harness) => {
    const invalid = await harness.join({
      avatarExperiment: AVATAR_EXPERIMENT,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(harness.coordinator.state.tryAcquireCalls, 0);
    assert.equal(harness.getAvatarIssueCount(), 0);

    const valid = await harness.join();
    assert.equal(valid.statusCode, 200);
    assert.equal(harness.coordinator.state.tryAcquireCalls, 1);
  }, {
    settingsOverrides: { server: { ngrokDomain: "" } },
  });

  await withMeetRoutesHarness(async (harness) => {
    const denied = await harness.join({
      avatarExperiment: AVATAR_EXPERIMENT,
    });
    assert.equal(denied.statusCode, 409);
    assert.equal(harness.getAvatarIssueCount(), 0);
  }, {
    initialLease: Object.freeze({ transport: "discord", sessionId: DISCORD_SESSION_ID }),
  });
});

test("coordinator failures refuse attendee joins without vendor side effects", async () => {
  await withMeetRoutesHarness(async (harness) => {
    const refused = await harness.join();
    assert.equal(refused.statusCode, 503);
    assert.equal(harness.httpsRequests.length, 0);
  }, {
    acquireError: new Error("coordinator unavailable"),
  });

  await withMeetRoutesHarness(async (harness) => {
    const refused = await harness.join();
    assert.equal(refused.statusCode, 503);
    assert.equal(harness.httpsRequests.length, 0);
  }, {
    coordinator: {
      state: { tryAcquireCalls: 0, releaseCalls: 0 },
      api: {},
    },
  });
});

test("retained attendee sessions hold the shared lease until finalize settles on the narrow reconnect-plus-second-close path, then discord can acquire", async () => {
  await withMeetRoutesHarness(async (harness) => {
    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);

    harness.retainSession();
    const leave = await harness.leave();
    assert.equal(leave.statusCode, 200);
    assert.deepEqual(harness.coordinator.api.active(), { transport: "meet", sessionId: FIXED_SESSION_ID });

    const discord = createDiscordHarness(harness.coordinator.api);
    const blocked = await discord.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
    assert.equal(blocked.status, 409);

    harness.clearRetained();
    harness.routes._test.finalizeSessionIfInactive(FIXED_SESSION_ID);
    assert.equal(harness.coordinator.api.active(), null);

    const acquired = await discord.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
    assert.equal(acquired.status, 200);
  });
});

test("finalize while gateway retention is active keeps the lease and coordinator owner unchanged", async () => {
  await withMeetRoutesHarness(async (harness) => {
    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);
    harness.retainSession();

    harness.routes._test.finalizeSessionIfInactive(FIXED_SESSION_ID);

    assert.deepEqual(harness.coordinator.api.active(), { transport: "meet", sessionId: FIXED_SESSION_ID });
    const active = await harness.activeSession();
    assert.equal(active.text.includes(FIXED_SESSION_ID), true);
  });
});

test("vendor-aware catch rollback requests bot leave and still clears lifecycle and lease when leave throws", async () => {
  await withMeetRoutesHarness(async (harness) => {
    const failed = await harness.join({}, { throwOnFirstSuccessEnd: true });
    assert.equal(failed.statusCode, 500);
    assert.equal(harness.coordinator.state.releaseCalls, 1);
    const active = await harness.activeSession();
    assert.equal(active.text.includes(FIXED_SESSION_ID), false);
    assert.equal(harness.httpsRequests.some((item) => item.options.path === "/api/v1/bots"), true);
    assert.equal(harness.httpsRequests.some((item) => String(item.options.path || "").includes("/leave")), true);
  });

  await withMeetRoutesHarness(async (harness) => {
    const failed = await harness.join({}, { throwOnFirstSuccessEnd: true });
    assert.equal(failed.statusCode, 500);
    assert.equal(harness.coordinator.state.releaseCalls, 1);
    assert.equal(harness.coordinator.api.active(), null);
  }, {
    throwLeaveRequest: true,
  });

  let releaseLeave;
  const leaveResponseGate = new Promise((resolve) => { releaseLeave = resolve; });
  await withMeetRoutesHarness(async (harness) => {
    const pendingJoin = harness.join({}, { throwOnFirstSuccessEnd: true });
    while (!harness.httpsRequests.some((item) => String(item.options.path || "").includes("/leave"))) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(harness.coordinator.api.active(), { transport: "meet", sessionId: FIXED_SESSION_ID });
    assert.equal(harness.coordinator.state.releaseCalls, 0);
    releaseLeave();
    const failed = await pendingJoin;
    assert.equal(failed.statusCode, 500);
    assert.equal(harness.coordinator.api.active(), null);
  }, { leaveResponseGate });
});

test("real join reuse rollback removes its fresh registry entry without releasing the pre-existing coordinator lease", async () => {
  const reusedLease = Object.freeze({ transport: "meet", sessionId: FIXED_SESSION_ID });
  await withMeetRoutesHarness(async (harness) => {
    const failed = await harness.join({}, { throwOnFirstSuccessEnd: true });
    assert.equal(failed.statusCode, 500);

    assert.deepEqual(harness.coordinator.api.active(), { transport: "meet", sessionId: FIXED_SESSION_ID });
    assert.equal(harness.coordinator.state.releaseCalls, 0);
    const active = await harness.activeSession();
    assert.equal(active.text.includes(FIXED_SESSION_ID), false);
  }, { initialLease: reusedLease });
});

test("superseded old-owner websocket close does not release the shared attendee lease", async () => {
  await withMeetRoutesHarness(async (harness) => {
    const joined = await harness.join();
    assert.equal(joined.statusCode, 200);

    const first = harness.connect();
    const second = harness.connect();
    assert.equal(first.closed.at(-1)?.code, 1012);
    first.emit("close");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(harness.coordinator.api.active(), { transport: "meet", sessionId: FIXED_SESSION_ID });
    assert.equal(second.closed.length, 0);
  });
});
