"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const path = require("node:path");
const { stringify } = require("node:querystring");
const { Readable } = require("node:stream");
const test = require("node:test");

const routesPath = require.resolve("../src/transport-meet/meet-routes");

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

async function invoke(routes, formData) {
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
  await routes.handleHttp(request("POST", "/join-meeting", formData), res);
  return output;
}

async function withJoinRoutes(run) {
  const src = path.join(__dirname, "..", "src");
  const previousCache = new Map();
  const previousHttpsRequest = https.request;
  const previousConsoleError = console.error;
  const consoleOutput = [];
  const sentinel = "SECRET-INTERNAL-URL";

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
    createGatewaySessionTracker: () => ({
      trackGatewaySession: () => {},
      untrackGatewaySession: () => false,
      findGatewayRoute: () => null,
    }),
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
      startup: { resolvedHome: "/tmp/meet-routes-join-502" },
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
    const response = new EventEmitter();
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      response.statusCode = options.path === "/api/v1/bots" ? 500 : 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", JSON.stringify({ error: sentinel, detail: "vendor exploded" }));
        response.emit("end");
      });
    };
    return request;
  };

  console.error = (...args) => {
    consoleOutput.push(args.map((value) => String(value)).join(" "));
  };

  delete require.cache[routesPath];
  try {
    const routes = require(routesPath);
    await routes.init({ detectNgrok: false, loadAvatar: false, instanceId: "test-boot" });
    await run({ routes, consoleOutput, sentinel });
  } finally {
    https.request = previousHttpsRequest;
    console.error = previousConsoleError;
    delete require.cache[routesPath];
    for (const [resolved, cached] of previousCache.entries()) {
      if (cached === undefined) delete require.cache[resolved];
      else require.cache[resolved] = cached;
    }
  }
}

test("join 502 sanitizes upstream Attendee bodies while preserving operator logs", { concurrency: false }, async () => {
  await withJoinRoutes(async ({ routes, consoleOutput, sentinel }) => {
    const response = await invoke(routes, {
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      wsUrl: "wss://meetmate.example/realtime",
      conversationMode: "one_to_one",
    });

    assert.equal(response.status, 502);
    assert.equal(response.text.includes(sentinel), false);
    assert.equal(response.text.includes("BOT_LAUNCH_UPSTREAM_ERROR"), true);
    assert.equal(response.text.includes("upstream_status=500"), true);
    assert.equal(
      consoleOutput.some((line) => line.includes("❌  Bot起動失敗: 500") && line.includes(sentinel)),
      true,
      consoleOutput.join("\n"),
    );
  });
});
