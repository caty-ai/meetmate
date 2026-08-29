const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { stringify } = require("node:querystring");
const {
  createLocalAvatarSession,
  FRAMES_HTML_ROUTE,
} = require("../src/transport-meet/local-avatar-session");

const PUBLIC_DIR = path.join(__dirname, "..", "public", "local-avatar");
const HTML_FILE = path.join(PUBLIC_DIR, "frames.html");
const SCRIPT_FILE = path.join(PUBLIC_DIR, "frames.js");

test("frame avatar page is an isolated dependency-free 1280x720 Canvas surface", () => {
  const html = fs.readFileSync(HTML_FILE, "utf8");
  const script = fs.readFileSync(SCRIPT_FILE, "utf8");
  const shipped = `${html}\n${script}`;

  assert.match(html, /<canvas\b[^>]*\bwidth="1280"[^>]*\bheight="720"/i);
  assert.match(html, /<script src="\/local-avatar\/frames\.js" defer><\/script>/i);
  assert.equal(/<script(?!\s+src=)[^>]*>\s*\S/i.test(html), false, "inline executable script is forbidden");
  assert.equal(/\b(?:https?:)?\/\//i.test(shipped), false, "third-party URL is forbidden");
  assert.equal(/\b(?:WebSocket|EventSource|sendBeacon)\b/.test(shipped), false);

  const forbidden = [
    "AudioContext",
    "<audio",
    "<video",
    "mediaDevices",
    "getUserMedia",
    "captureStream",
    "MediaStream",
    "serviceWorker",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
  ];
  for (const token of forbidden) {
    assert.equal(shipped.includes(token), false, `forbidden browser capability found: ${token}`);
  }

  assert.deepEqual(
    [...script.matchAll(/fetch\(([^,]+)/g)].map((match) => match[1].trim()),
    ["stateUrl(parameters)", "frameUrl(name)"],
  );
  assert.match(script, /const STATE_ROUTE = "\/local-avatar\/state"/);
  assert.match(script, /headers: \{ Authorization: `Bearer \$\{capability\}` \}/);
  assert.doesNotMatch(script, /(?:src|href)\s*=\s*["'](?!\/local-avatar\/)/i);
});

test("frame renderer enters speaking only on fresh advancing markers and returns to idle", async () => {
  const page = await runFramesPage();
  const contract = page.sandbox.__localAvatarFramesContract;

  assert.deepEqual(page.sandbox.replaced, [null, "", "/local-avatar/frames.html?v=abcdefghijklmnop"]);
  assert.equal(contract.getState().generation, 1);
  assert.equal(contract.getState().currentFrame, "idle");
  assert.equal(contract.limits.markerFreshMs, 600);

  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
  };
  assert.equal(contract.acceptState(marker, 1_000), true);
  assert.equal(contract.getState().speaking, true);
  assert.match(contract.getState().currentFrame, /^talk/);

  contract.render(1_599);
  assert.equal(contract.getState().speaking, true);
  contract.render(1_600);
  assert.equal(contract.getState().speaking, false);
  assert.equal(contract.getState().currentFrame, "idle");

  assert.equal(contract.acceptState({ ...marker, sequence: 3, sampleIndex: 480 }, 2_000), true);
  const cancel = { ...marker, kind: "cancel", cancelEpoch: 1, sequence: 4, sampleIndex: null };
  assert.equal(contract.acceptState(cancel, 2_010), true);
  assert.equal(contract.getState().speaking, false);
  assert.equal(contract.getState().currentFrame, "idle");
  assert.equal(contract.acceptState({ ...marker, sequence: 5, sampleIndex: 960 }, 2_020), false);

  const reloaded = await runFramesPage();
  assert.equal(reloaded.sandbox.__localAvatarFramesContract.getState().speaking, false);
  assert.equal(reloaded.sandbox.__localAvatarFramesContract.getState().currentFrame, "idle");
});

test("missing or broken frames fail closed to idle and then the diagnostic canvas", async () => {
  const missingTalk = await runFramesPage({ frameFailures: new Set(["talk2"]) });
  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
  };
  assert.doesNotThrow(() => missingTalk.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000));
  assert.equal(missingTalk.sandbox.__localAvatarFramesContract.getState().currentFrame, "idle");

  const missingIdle = await runFramesPage({ frameFailures: new Set(["idle", "talk2"]) });
  assert.doesNotThrow(() => missingIdle.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000));
  assert.equal(missingIdle.sandbox.__localAvatarFramesContract.getState().currentFrame, "diagnostic");
  assert.ok(missingIdle.drawCalls.some((call) => call[0] === "text" && call[1] === "IDLE"));
});

test("slow network: idle frame paints as soon as it arrives, before the talk frames finish", async () => {
  const gate = {};
  const held = new Set(["talk1", "talk2", "talk3", "blink", "talk_blink"]);
  const page = await runFramesPage({ holdFrames: held, gate });
  const contract = page.sandbox.__localAvatarFramesContract;

  assert.equal(contract.getState().currentFrame, "idle", "idle must render while talk frames are still loading");
  assert.ok(page.drawCalls.some((call) => call[0] === "image"), "idle bitmap must be drawn, not a placeholder");
  assert.equal(page.drawCalls.some((call) => call[0] === "text"), false, "no IDLE diagnostic flash while loading");

  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
  };
  assert.doesNotThrow(() => contract.acceptState(marker, 1_000));
  assert.equal(contract.getState().currentFrame, "idle", "talk falls back to idle until talk frames arrive");

  gate.release();
  await settleMicrotasks();
  assert.doesNotThrow(() => contract.acceptState({ ...marker, sequence: 3, sampleIndex: 960 }, 1_100));
  assert.match(contract.getState().currentFrame, /^talk/, "lip-sync upgrades once talk frames land");
});

test("frame assets require the session capability and an exact allowlisted PNG route", { concurrency: false }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-avatar-frames-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const frameDir = path.join(home, "assets", "avatar-frames");
  fs.mkdirSync(frameDir, { recursive: true });
  fs.writeFileSync(path.join(frameDir, "idle.png"), Buffer.from("allowed-idle-frame"));
  fs.writeFileSync(path.join(frameDir, "talk4.png"), Buffer.from("must-remain-rejected"));

  await withFreshUiRoutes(home, async ({ serveLocalAvatar, localAvatarCsp }) => {
    const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
    try {
      const visualId = encodeURIComponent(issued.session.visualId);
      const validPath = `/local-avatar/frames/idle.png?v=${visualId}`;
      const valid = await requestRoute(serveLocalAvatar, "GET", validPath, authHeaders(issued.capability));
      assertFrameHeaders(valid, 200, localAvatarCsp);
      assert.equal(valid.body.toString("utf8"), "allowed-idle-frame");

      assertFrameHeaders(
        await requestRoute(serveLocalAvatar, "GET", validPath, authHeaders(tamperCapability(issued.capability))),
        404,
        localAvatarCsp,
      );
      assertFrameHeaders(await requestRoute(serveLocalAvatar, "GET", validPath), 404, localAvatarCsp);

      for (const requestPath of [
        `/local-avatar/frames/../evil.png?v=${visualId}`,
        `/local-avatar/frames/%2e%2e/evil.png?v=${visualId}`,
        `/local-avatar/frames/idle.svg?v=${visualId}`,
        `/local-avatar/frames/talk4.png?v=${visualId}`,
        `/local-avatar/frames/idle.png?v=${visualId}&extra=1`,
      ]) {
        assertFrameHeaders(
          await requestRoute(serveLocalAvatar, "GET", requestPath, authHeaders(issued.capability)),
          404,
          localAvatarCsp,
        );
      }

      const missing = await requestRoute(
        serveLocalAvatar,
        "GET",
        `/local-avatar/frames/blink.png?v=${visualId}`,
        authHeaders(issued.capability),
      );
      assertFrameHeaders(missing, 404, localAvatarCsp);
    } finally {
      issued.session.close();
    }
  });
});

test("frame launch selection is explicit and leaves the H0 default unchanged", () => {
  const legacy = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const frames = createLocalAvatarSession({
    publicOrigin: "https://meetmate.example",
    htmlRoute: FRAMES_HTML_ROUTE,
  });
  try {
    assert.equal(new URL(legacy.launchUrl).pathname, "/local-avatar/index.html");
    assert.equal(new URL(frames.launchUrl).pathname, "/local-avatar/frames.html");
    assert.throws(
      () => createLocalAvatarSession({ publicOrigin: "https://meetmate.example", htmlRoute: "/local-avatar/evil.html" }),
      /invalid local avatar HTML route/,
    );

  } finally {
    legacy.session.close();
    frames.session.close();
  }
});

test("hybrid-local-frames joins only on Fish Audio with a public HTTPS origin", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: "hybrid-local-frames" });
    assert.equal(join.statusCode, 200);
    const payload = JSON.parse(harness.botRequests[0].body);
    const launch = new URL(payload.voice_agent_settings.url);
    assert.equal(launch.origin, "https://meetmate.example");
    assert.equal(launch.pathname, "/local-avatar/frames.html");
    assert.match(launch.searchParams.get("v"), /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(Buffer.from(new URLSearchParams(launch.hash.slice(1)).get("cap"), "base64url").length, 32);
    assert.equal((await harness.leave()).statusCode, 200);
  });

  const providerErrors = {};
  for (const experiment of ["hybrid-local-l0", "hybrid-local-frames"]) {
    await withMeetRoutes(async (harness) => {
      const join = await harness.join({ avatarExperiment: experiment });
      assert.equal(join.statusCode, 400);
      assert.equal(harness.botRequests.length, 0);
      providerErrors[experiment] = join.text;
    }, { ttsProvider: "other" });
  }
  assert.equal(providerErrors["hybrid-local-l0"], "hybrid-local-l0 は Fish Audio 構成でのみ利用できます。");
  assert.equal(
    providerErrors["hybrid-local-frames"].replace("hybrid-local-frames", "hybrid-local-l0"),
    providerErrors["hybrid-local-l0"],
  );

  const originErrors = {};
  for (const experiment of ["hybrid-local-l0", "hybrid-local-frames"]) {
    await withMeetRoutes(async (harness) => {
      const join = await harness.join({ avatarExperiment: experiment });
      assert.equal(join.statusCode, 400);
      assert.equal(harness.botRequests.length, 0);
      originErrors[experiment] = join.text;
    }, { ngrokDomain: "" });
  }
  assert.equal(originErrors["hybrid-local-l0"], "hybrid-local-l0 には公開 HTTPS origin が必要です。");
  assert.equal(
    originErrors["hybrid-local-frames"].replace("hybrid-local-frames", "hybrid-local-l0"),
    originErrors["hybrid-local-l0"],
  );
});

test("unknown experiments stay rejected and hybrid-local-l0 payload bytes remain pinned", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: "unknown" });
    assert.equal(join.statusCode, 400);
    assert.equal(join.text, "avatarExperiment が不正です。");
    assert.equal(harness.botRequests.length, 0);
  });

  let staticBody;
  await withMeetRoutes(async (harness) => {
    assert.equal((await harness.join()).statusCode, 200);
    staticBody = harness.botRequests[0].body;
    assert.equal((await harness.leave()).statusCode, 200);
  });

  await withMeetRoutes(async (harness) => {
    assert.equal((await harness.join({ avatarExperiment: "hybrid-local-l0" })).statusCode, 200);
    const livePayload = JSON.parse(harness.botRequests[0].body);
    assert.equal(new URL(livePayload.voice_agent_settings.url).pathname, "/local-avatar/index.html");
    delete livePayload.voice_agent_settings;
    assert.equal(JSON.stringify(livePayload), staticBody);
    assert.equal((await harness.leave()).statusCode, 200);
  });
});

async function withMeetRoutes(fn, { ttsProvider = "fish-audio", ngrokDomain = "meetmate.example" } = {}) {
  const settingsResolver = require("../src/settings/resolver");
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
  const previousCache = new Map(cachePaths.map((file) => [file, require.cache[file]]));
  for (const file of cachePaths) delete require.cache[file];

  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "test-key",
    FISH_AUDIO_API_KEY: "fish-test-key",
    SLACK_NOTIFY_ENABLED: "false",
    SUMMARY_ENABLED: "false",
    METRICS_DISABLED: "1",
    SESSION_GRACE_CLOSE_MS: "1",
  });
  settingsResolver.resetRuntimeForTest();
  settingsResolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      revision: "a".repeat(64),
      fingerprint: "local-avatar-frames",
      parsed: {
        agent: { id: "caty", displayName: "Caty", wakeWords: ["ケイティ"] },
        stt: { provider: "soniox", sonioxApiKey: "soniox-test-key" },
        tts: { provider: "fish-audio", apiKey: "fish-test-key", voiceId: "fish-test-voice" },
        attendee: { apiKey: "test-key" },
        server: { ngrokDomain },
        slack: { notifications: { enabled: false } },
        llm: { provider: "openclaw", model: "test" },
      },
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: "/tmp/meetmate-frames-home",
      configPath: "/tmp/meetmate-frames-home/config.json",
      connection: Object.freeze({
        provider: "openclaw",
        openclawUrl: "http://gateway.invalid",
        openclawToken: "test",
        openaiApiKey: "",
      }),
    }),
    serverPort: 5005,
  });

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: 24_000,
    TTS_PROVIDER: ttsProvider,
    loadConfig: () => ({
      attendee: { apiKey: "test-key" },
      server: { ngrokDomain },
      slack: { notifications: {} },
    }),
    validateSttProviderApiKey: () => true,
    resolveMessages: () => ({ delegation: {}, slack: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: () => ({
      stt: { provider: "soniox", sampleRate: 16_000 },
      llm: { provider: "openclaw", model: "test" },
      tts: { sampleRate: 24_000 },
      gatewayEvents: { enabled: false },
    }),
  });
  installMock(path.join(src, "pipeline.js"), { createPipeline: () => new EventEmitter() });
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
    serveLocalAvatar: () => false,
    servePublicAsset: () => false,
    sendMetricsSummary: async () => false,
  });
  installMock(path.join(src, "paths.js"), {
    logsDir: () => "/tmp/meetmate-frames-logs",
    avatarCachePath: () => "/tmp/meetmate-frames-avatar.png",
    bundledAssetPath: (name) => `/tmp/${name}`,
    bundledPublicDir: () => "/tmp/meetmate-frames-public",
  });

  const botRequests = [];
  const originalHttpsRequest = https.request;
  const originalRandomUUID = crypto.randomUUID;
  const originalRandomBytes = crypto.randomBytes;
  crypto.randomUUID = () => "00000000-0000-4000-8000-000000000058";
  crypto.randomBytes = (size) => Buffer.alloc(size, 0x58);
  https.request = (options, callback) => {
    const record = { options, body: "" };
    if (options.path === "/api/v1/bots") botRequests.push(record);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = (chunk) => { record.body += String(chunk); };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = options.path === "/api/v1/bots" ? 201 : 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", options.path === "/api/v1/bots" ? '{"id":"bot-frames-58"}' : "{}");
        response.emit("end");
      });
    };
    return request;
  };

  try {
    const routes = require(routesPath);
    const harness = {
      botRequests,
      join: (overrides = {}) => requestMeetRoute(routes, "POST", "/join-meeting", {
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        wsUrl: "wss://meetmate.example/realtime?mode=frames",
        conversationMode: "one_to_one",
        ...overrides,
      }),
      leave: () => requestMeetRoute(routes, "POST", "/leave-meeting", {
        sessionId: "00000000-0000-4000-8000-000000000058",
      }),
    };
    await fn(harness);
  } finally {
    for (const session of [...require("../src/transport-meet/local-avatar-session")._test.sessions.values()]) {
      session.close("test_cleanup");
    }
    https.request = originalHttpsRequest;
    crypto.randomUUID = originalRandomUUID;
    crypto.randomBytes = originalRandomBytes;
    restoreEnv();
    settingsResolver.resetRuntimeForTest();
    for (const file of cachePaths) {
      delete require.cache[file];
      const previous = previousCache.get(file);
      if (previous) require.cache[file] = previous;
    }
  }
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

class FakeSlackNotifier {
  postStatus() { return Promise.resolve(); }
  startElapsedUpdates() {}
  stopElapsedUpdates() {}
  postSummary() { return Promise.resolve(); }
  postTranscript() { return Promise.resolve(); }
}

function installMock(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

async function requestMeetRoute(routes, method, url, formData) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.destroy = () => {};
  const result = { statusCode: null, headers: null, text: "" };
  const res = {
    writeHead(statusCode, headers) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(body = "") {
      result.text = String(body);
    },
  };
  const pending = routes.handleHttp(req, res);
  await Promise.resolve();
  req.emit("data", Buffer.from(stringify(formData)));
  req.emit("end");
  await pending;
  return result;
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

async function runFramesPage({ frameFailures = new Set(), holdFrames = new Set(), gate = {} } = {}) {
  let releaseHeldFrames;
  const heldGate = new Promise((resolve) => { releaseHeldFrames = resolve; });
  gate.release = releaseHeldFrames;
  const script = fs.readFileSync(SCRIPT_FILE, "utf8");
  const drawCalls = [];
  const initial = {
    kind: "idle",
    generation: 1,
    cancelEpoch: 0,
    sequence: 1,
    outputEpoch: -1,
    sampleIndex: null,
    sampleRate: null,
  };
  const sandboxMath = Object.create(Math);
  sandboxMath.random = () => 0.5;
  const sandbox = {
    URLSearchParams,
    Date,
    Math: sandboxMath,
    location: {
      pathname: "/local-avatar/frames.html",
      search: "?v=abcdefghijklmnop",
      hash: "#cap=secret",
    },
    history: { replaceState: (...args) => { sandbox.replaced = args; } },
    document: {
      getElementById: () => ({
        width: 1280,
        height: 720,
        getContext: () => ({
          fillRect: (...args) => drawCalls.push(["rect", ...args]),
          fillText: (...args) => drawCalls.push(["text", ...args]),
          drawImage: (...args) => drawCalls.push(["image", ...args]),
          set fillStyle(_value) {},
          set font(_value) {},
          set textAlign(_value) {},
        }),
      }),
    },
    fetch: async (url) => {
      if (url.startsWith("/local-avatar/state?")) {
        return { ok: true, status: 200, json: async () => initial };
      }
      const name = /\/([^/?]+)\.png\?/.exec(url)?.[1] || "";
      if (holdFrames.has(name)) await heldGate;
      return {
        ok: !frameFailures.has(name),
        status: frameFailures.has(name) ? 404 : 200,
        blob: async () => ({ name }),
      };
    },
    createImageBitmap: async (blob) => ({ frame: blob.name }),
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: SCRIPT_FILE });
  await settleMicrotasks();
  return { sandbox, drawCalls };
}

async function settleMicrotasks() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withFreshUiRoutes(home, fn) {
  const pathsModule = require.resolve("../src/paths");
  const uiModule = require.resolve("../src/ui-routes");
  const bootstrap = require("../src/settings/bootstrap");
  const previousHome = process.env.AI_MEET_HOME;
  process.env.AI_MEET_HOME = home;
  bootstrap.resetStartupForTest();
  delete require.cache[pathsModule];
  delete require.cache[uiModule];
  try {
    const uiRoutes = require(uiModule);
    await fn({
      serveLocalAvatar: uiRoutes.serveLocalAvatar,
      localAvatarCsp: uiRoutes._test.LOCAL_AVATAR_CSP,
    });
  } finally {
    delete require.cache[uiModule];
    delete require.cache[pathsModule];
    bootstrap.resetStartupForTest();
    if (previousHome === undefined) delete process.env.AI_MEET_HOME;
    else process.env.AI_MEET_HOME = previousHome;
  }
}

function requestRoute(serveLocalAvatar, method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url: requestPath, headers };
    const result = { statusCode: null, headers: null, body: Buffer.alloc(0) };
    const res = {
      writeHead(statusCode, responseHeaders) {
        result.statusCode = statusCode;
        result.headers = responseHeaders;
      },
      end(body = "") {
        result.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        resolve(result);
      },
    };
    try {
      const handled = serveLocalAvatar(req, res, new URL(requestPath, "http://localhost"));
      if (!handled) reject(new Error(`route was not handled: ${requestPath}`));
    } catch (error) {
      reject(error);
    }
  });
}

function authHeaders(capability) {
  return { authorization: `Bearer ${capability}`, origin: "https://meetmate.example" };
}

function tamperCapability(value) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function assertFrameHeaders(result, statusCode, localAvatarCsp) {
  assert.equal(result.statusCode, statusCode);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Content-Security-Policy"], localAvatarCsp);
  if (statusCode === 200) assert.equal(result.headers["Content-Type"], "image/png");
}
