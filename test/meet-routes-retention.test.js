"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const path = require("node:path");
const { stringify } = require("node:querystring");
const { Readable } = require("node:stream");
const test = require("node:test");

const { createGatewaySessionTracker } = require("../src/gateway-session-tracker");
const routesPath = require.resolve("../src/transport-meet/meet-routes");

const JOIN_FORM = {
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  wsUrl: "wss://meetmate.example/realtime",
  conversationMode: "one_to_one",
};

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

function installMock(previousCache, filename, exports) {
  const resolved = require.resolve(filename);
  previousCache.set(resolved, require.cache[resolved]);
  require.cache[resolved] = cacheEntry(resolved, exports);
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

  setConversationLog(log) {
    this._conversationLog = log;
  }
}

class FakeSlackNotifier {
  constructor() {
    this.enabled = false;
  }

  postStatus() {
    return Promise.resolve();
  }

  startElapsedUpdates() {}

  stopElapsedUpdates() {}

  postSummary() {
    return Promise.resolve();
  }

  postTranscript() {
    return Promise.resolve();
  }
}

function request(method, url, formData) {
  const body = Buffer.from(stringify(formData));
  const req = Readable.from([body]);
  Object.assign(req, {
    method,
    url,
    headers: {
      host: "meetmate.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    socket: { remoteAddress: "198.51.100.44", localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

async function invoke(routes, url, formData) {
  const output = { status: 0, headers: {}, text: "" };
  const res = {
    writeHead(status, headers = {}) {
      output.status = status;
      output.headers = headers;
    },
    end(chunk = "") {
      output.text += String(chunk);
    },
  };
  await routes.handleHttp(request("POST", url, formData), res);
  return output;
}

function sessionIdFrom(response) {
  const match = response.text.match(/^session_id=(.+)$/m);
  assert.ok(match, response.text);
  return match[1];
}

function gatewayEventsHarness() {
  const spawnListeners = [];
  const completionListeners = [];
  return {
    spawnListeners,
    completionListeners,
    events: {
      buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
      start: () => ({}),
      stop: () => {},
      verifySessionKey: async () => true,
      onSubagentSpawn(callback) {
        spawnListeners.push(callback);
      },
      onSubagentCompletion(callback) {
        completionListeners.push(callback);
      },
      onSessionReply: () => {},
      onAnnounceInjected: () => {},
    },
  };
}

async function releaseThroughRealTracker(onRetentionReleased, sessionId, reason) {
  const harness = gatewayEventsHarness();
  const session = {
    id: sessionId,
    config: { defaultAgentId: "caty" },
    gatewayDelegationState: { inFlightCount: 1, pendingQueueCount: 0 },
  };
  const tracker = createGatewaySessionTracker({
    gatewayEvents: harness.events,
    recordEvent: () => {},
    sessions: new Map([[sessionId, session]]),
    activeConnections: new Map(),
    getGatewayConfigForProfile: () => ({ enabled: true, agentId: "main" }),
    getDefaultAgentId: () => "caty",
    appendLateResult: () => true,
    onRetentionReleased,
  });
  tracker.trackGatewaySession(session, { agentId: "caty" });

  if (reason === "settled") {
    const parentSessionKey = `agent:main:openai-user:meet-${sessionId}-caty`;
    const childKey = `agent:main:subagent:${sessionId}`;
    await harness.spawnListeners[0]({ parentSessionKey, childKey });
    assert.equal(tracker.untrackGatewaySession(sessionId, { retainIfDelegations: true, ttlMs: 100 }), true);
    await harness.completionListeners[0]({ parentSessionKey, childKey, resultText: "done" });
    return;
  }

  assert.equal(tracker.untrackGatewaySession(sessionId, { retainIfDelegations: true, ttlMs: 20 }), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function withRetentionRoutes(run) {
  const src = path.join(__dirname, "..", "src");
  const previousCache = new Map();
  const previousHttpsRequest = https.request;
  const previousConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const trackerControl = {
    activeConnections: null,
    onRetentionReleased: null,
    retained: true,
  };
  const attendeeRequests = [];

  installMock(previousCache, path.join(src, "config.js"), {
    getPipelineConfig: () => ({
      llm: { provider: "openclaw", gateway: { url: "https://gateway.example", token: "gateway-token" } },
      gatewayEvents: {},
    }),
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: 24_000,
    TTS_PROVIDER: "fish-audio",
    loadConfig: () => ({}),
    resolveMessages: () => ({ delegation: {}, prompts: { summary: "" }, slack: {} }),
    HUB_CONFIG: { enabled: false },
  });
  installMock(previousCache, path.join(src, "pipeline.js"), { createPipeline: () => ({}) });
  installMock(previousCache, path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: () => {},
    warmUpMultipleAgents: () => {},
  });
  installMock(previousCache, path.join(src, "session-events.js"), { SessionLifecycle: FakeLifecycle });
  installMock(previousCache, path.join(src, "slack-notifier.js"), { SlackNotifier: FakeSlackNotifier });
  installMock(previousCache, path.join(src, "summarizer.js"), { summarizeConversation: async () => "" });
  installMock(previousCache, path.join(src, "agent-profile.js"), {
    resolveAgentProfile: () => ({
      agentId: "caty",
      name: "Caty",
      displayName: "Caty",
      attendeeApiKey: "attendee-key",
      wakeWords: ["ケイティ"],
    }),
    AgentNotFoundError: class AgentNotFoundError extends Error {},
  });
  installMock(previousCache, path.join(src, "attendee-chat.js"), { sendAttendeeChatMessage: async () => true });
  installMock(previousCache, path.join(src, "gateway-events.js"), {});
  installMock(previousCache, path.join(src, "metrics.js"), { recordEvent: () => {} });
  installMock(previousCache, path.join(src, "delegation-results.js"), { buildDelegationResultsSection: () => "" });
  installMock(previousCache, path.join(src, "gateway-session-tracker.js"), {
    createGatewaySessionTracker(options) {
      trackerControl.activeConnections = options.activeConnections;
      trackerControl.onRetentionReleased = options.onRetentionReleased;
      return {
        trackGatewaySession: () => true,
        untrackGatewaySession: () => trackerControl.retained,
        findGatewayRoute: () => null,
      };
    },
  });
  installMock(previousCache, path.join(src, "ui-routes.js"), {
    servePublicAsset: () => false,
    serveLocalAvatar: () => false,
    sendMetricsSummary: async () => false,
  });
  installMock(previousCache, path.join(src, "paths.js"), {
    logsDir: () => "/tmp",
    avatarCachePath: () => "/tmp/avatar.png",
    bundledAssetPath: (...parts) => path.join(src, ...parts),
    bundledPublicDir: () => path.join(src, "..", "public"),
  });
  installMock(previousCache, path.join(src, "settings", "avatar-assets.js"), {
    AVATAR_FILE_LIMIT: 64 * 1024 * 1024,
    installUrlCacheAvatar: async () => {},
    readBundledAvatar: () => {
      throw new Error("no bundled avatar in test");
    },
    readManagedAvatar: () => {
      throw new Error("no managed avatar in test");
    },
  });
  installMock(previousCache, path.join(src, "settings", "resolver.js"), {
    getDiagnosticValue(key) {
      const values = {
        attendee_timeout_ms: 2_000,
        attendee_retry_attempts: 1,
        attendee_retry_base_ms: 1,
        body_limit_bytes: 1024 * 1024,
        public_wss_url: "wss://meetmate.example",
      };
      return values[key];
    },
    getEffectiveValue(key) {
      const values = {
        attendee_base_url: "app.attendee.dev",
        attendee_api_key: "attendee-key",
        avatar_experiment: "",
        slack_notifications_enabled: false,
        slack_notifications_target: "dm",
        slack_dm_user_id: "",
        slack_notify_channel: "",
        slack_summary_channel: "",
        slack_status_channel: "",
        task_extraction_enabled: false,
        agent_language: "ja",
      };
      return values[key];
    },
    getRawConfig: () => ({}),
    getStatus: () => ({ meetingReady: true, issues: [] }),
    meaningful: (value) => Boolean(value),
    registerCacheInvalidator: () => {},
    resolveDynamicSlackToken: () => "",
    getPublishedValue: (key) => key === "server_ngrok_domain" ? "meetmate.example" : "",
    getRuntime: () => ({
      serverPort: 5005,
      startup: { resolvedHome: "/tmp/meet-routes-retention" },
    }),
  });
  installMock(previousCache, path.join(src, "settings", "readiness.js"), {
    configure: () => {},
    bootstrap: async () => {},
    recheckPublic: async () => {},
    revalidateForJoin: async () => {},
    getReadiness: () => ({
      ready: true,
      blockers: [],
      systems: [
        { id: "soniox", code: "CONNECTED" },
        { id: "fish-audio", code: "CONNECTED" },
        { id: "attendee", code: "CONNECTED" },
        { id: "llm", code: "CONNECTED" },
        { id: "tunnel", code: "CONNECTED" },
      ],
    }),
    createPublicRateLimiter: () => () => ({ allowed: true, retryAfterSeconds: 0 }),
  });
  installMock(previousCache, path.join(src, "settings", "probes.js"), {
    checkWsUrlIdentity: async () => ({ ok: true, code: "CONNECTED" }),
  });

  https.request = (options, callback) => {
    attendeeRequests.push(options.path);
    const response = new EventEmitter();
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        const body = options.path === "/api/v1/bots"
          ? JSON.stringify({ id: `bot-${attendeeRequests.filter((item) => item === "/api/v1/bots").length}` })
          : "{}";
        response.emit("data", body);
        response.emit("end");
      });
    };
    return req;
  };

  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};

  delete require.cache[routesPath];
  try {
    const routes = require(routesPath);
    await routes.init({ detectNgrok: false, loadAvatar: false, instanceId: "test-boot" });
    await run({ attendeeRequests, routes, trackerControl });
  } finally {
    https.request = previousHttpsRequest;
    console.error = previousConsole.error;
    console.log = previousConsole.log;
    console.warn = previousConsole.warn;
    delete require.cache[routesPath];
    for (const [resolved, cached] of previousCache.entries()) {
      if (cached === undefined) delete require.cache[resolved];
      else require.cache[resolved] = cached;
    }
  }
}

test("retention keeps the byte-identical 409 until settlement or TTL releases the session", { concurrency: false }, async () => {
  await withRetentionRoutes(async ({ attendeeRequests, routes, trackerControl }) => {
    const firstJoin = await invoke(routes, "/join-meeting", JOIN_FORM);
    assert.equal(firstJoin.status, 200);
    const settledSid = sessionIdFrom(firstJoin);

    const leaveAfterSettlementCandidate = await invoke(routes, "/leave-meeting", { sessionId: settledSid });
    assert.equal(leaveAfterSettlementCandidate.status, 200);
    const blockedBeforeSettlement = await invoke(routes, "/join-meeting", JOIN_FORM);
    assert.equal(blockedBeforeSettlement.status, 409);
    assert.equal(blockedBeforeSettlement.headers["Content-Type"], "text/plain; charset=utf-8");
    assert.equal(
      blockedBeforeSettlement.text,
      `既にアクティブなセッションがあります（${settledSid}）。退出してから再度参加してください。`,
    );

    await releaseThroughRealTracker(trackerControl.onRetentionReleased, settledSid, "settled");
    const joinAfterSettlement = await invoke(routes, "/join-meeting", JOIN_FORM);
    assert.equal(joinAfterSettlement.status, 200);
    const ttlSid = sessionIdFrom(joinAfterSettlement);

    const leaveBeforeTtl = await invoke(routes, "/leave-meeting", { sessionId: ttlSid });
    assert.equal(leaveBeforeTtl.status, 200);
    const blockedBeforeTtl = await invoke(routes, "/join-meeting", JOIN_FORM);
    assert.equal(blockedBeforeTtl.status, 409);

    await releaseThroughRealTracker(trackerControl.onRetentionReleased, ttlSid, "ttl");
    const joinAfterTtl = await invoke(routes, "/join-meeting", JOIN_FORM);
    assert.equal(joinAfterTtl.status, 200);
    assert.equal(attendeeRequests.filter((item) => item === "/api/v1/bots").length, 3);
  });
});

test("retention release does not delete a reconnected live session", { concurrency: false }, async () => {
  await withRetentionRoutes(async ({ routes, trackerControl }) => {
    const firstJoin = await invoke(routes, "/join-meeting", JOIN_FORM);
    assert.equal(firstJoin.status, 200);
    const sessionId = sessionIdFrom(firstJoin);
    assert.equal((await invoke(routes, "/leave-meeting", { sessionId })).status, 200);

    trackerControl.activeConnections.set(sessionId, { client: {} });
    trackerControl.onRetentionReleased(sessionId, "settled");

    const blocked = await invoke(routes, "/join-meeting", JOIN_FORM);
    assert.equal(blocked.status, 409);
    assert.equal(
      blocked.text,
      `既にアクティブなセッションがあります（${sessionId}）。退出してから再度参加してください。`,
    );
    trackerControl.activeConnections.delete(sessionId);
  });
});
