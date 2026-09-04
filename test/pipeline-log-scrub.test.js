"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const src = path.join(__dirname, "..", "src");
const pipelinePath = path.join(src, "pipeline.js");

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

async function withPipeline(provider, token, fn, {
  hub = { enabled: false },
  floorClient,
  floorClientFactory,
  onChatMessage,
  exitDetection = false,
  timers,
} = {}) {
  const files = ["pipeline.js", "llm-provider.js", "stt-provider.js", "tts-fish.js", "floor-client.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  const previousEnv = {
    WAKE_WORDS: process.env.WAKE_WORDS,
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    POST_UTTERANCE_BUFFER_MS: process.env.POST_UTTERANCE_BUFFER_MS,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
  };
  const stt = Object.assign(new EventEmitter(), { send() {}, close() {} });
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  let pipeline;

  try {
    Object.assign(process.env, {
      WAKE_WORDS: "zznever",
      ENABLE_IMMEDIATE_ACK: "false",
      ENABLE_PROGRESS_GUARD: "false",
      POST_UTTERANCE_BUFFER_MS: "0",
      TTS_GAP_MS: "0",
      SENTENCE_PAUSE_MS: "0",
    });
    for (const file of files) delete require.cache[require.resolve(file)];
    require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(
      path.join(src, "stt-provider.js"),
      { createSTT: () => stt, buildKeyterms: () => [] },
    );
    require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(
      path.join(src, "llm-provider.js"),
      { createLlmProvider: () => provider },
    );
    require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(
      path.join(src, "tts-fish.js"),
      { synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(2)) },
    );
    if (floorClientFactory) {
      require.cache[require.resolve(path.join(src, "floor-client.js"))] = cacheEntry(
        path.join(src, "floor-client.js"),
        { FloorClient: class { constructor(options) { return floorClientFactory(options); } }, STATES: {} },
      );
    }

    settingsBootstrap.resetStartupForTest();
    settingsResolver.resetRuntimeForTest();

    const { createPipeline } = require(pipelinePath);
    pipeline = createPipeline(
      { id: "pipeline-log-scrub", conversationLog: [], config: { wakeMode: "wake" } },
      { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 },
      () => {},
      {
        dgKey: "x",
        fishKey: "x",
        stt: { model: "test", language: "ja", sampleRate: 16_000 },
        tts: { referenceId: null, sampleRate: 16_000, latency: "balanced", speed: 1 },
        llm: {
          provider: "openclaw",
          model: "test",
          responseTimeoutMs: 0,
          firstTokenDelegateMs: 0,
          gateway: { url: "http://gateway.test", token },
        },
        hub,
        gatewayEvents: { enabled: false },
        greeting: "",
        exitDetection,
        echoCooldownMs: 0,
      },
      {
        agents: { alpha: { wakeWords: ["alpha"] } },
        selectedAgentIds: ["alpha"],
        defaultAgentId: "alpha",
        suppressGreeting: true,
        _testExposeInternals: true,
        ...(onChatMessage ? { onChatMessage } : {}),
        ...(timers ? { timers } : {}),
        ...(floorClient ? { floorClient } : {}),
      },
    );
    await fn({ pipeline, stt });
  } finally {
    pipeline?.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      if (previousCache.get(resolved)) require.cache[resolved] = previousCache.get(resolved);
    }
  }
}

function assertScrubbedLog(lines, prefix, token) {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `missing log prefix: ${prefix}`);
  assert.ok(line.includes("[REDACTED]"));
  assert.ok(!line.includes(token));
}

function floorStub(overrides = {}) {
  return {
    state: "READY",
    memberId: "m1",
    connectionEpoch: 1,
    members: [],
    connect() {},
    close() {},
    claimAssignment() { return null; },
    reportText: async () => ({ kind: "empty" }),
    fallbackDelayMs() { return 0; },
    fence() { return null; },
    isFenceCurrent() { return false; },
    waitForReady: async () => true,
    remainingReadyGraceMs() { return 0; },
    reportWake: async () => ({ kind: "not_assigned" }),
    release() {},
    speech() {},
    ...overrides,
  };
}

const immediateTimers = {
  setTimeout(callback) { queueMicrotask(callback); return 0; },
  clearTimeout() {},
};

test("scrubErrorMessage scrubs configured secrets and preserves benign fallback text", () => {
  const token = "tok" + "_" + "abc123";
  const { scrubErrorMessage } = require(pipelinePath)._test;
  const emptyMessage = { message: "", toString: () => "fallback-object" };

  assert.equal(scrubErrorMessage(new Error(`failed with ${token}`), token), "failed with [REDACTED]");
  assert.equal(scrubErrorMessage(new Error("benign failure"), token), "benign failure");
  assert.doesNotThrow(() => scrubErrorMessage(undefined, token));
  assert.equal(scrubErrorMessage(undefined, token), "");
  assert.equal(scrubErrorMessage("plain failure", token), "plain failure");
  assert.equal(scrubErrorMessage(emptyMessage, token), "fallback-object");
});

test("STT operator error logs scrub the configured gateway token", { concurrency: false }, async () => {
  const token = "tok" + "_" + "abc123";
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await withPipeline({
      name: "openclaw",
      streamChat: async function* () { yield "unused"; },
    }, token, async ({ stt }) => {
      stt.emit("error", new Error(`stt failed with ${token}`));
    });
  } finally {
    console.error = originalError;
  }

  assertScrubbedLog(errors, "❌  STT error:", token);
});

test("pipeline operator error logs scrub the configured gateway token", { concurrency: false }, async () => {
  const token = "tok" + "_" + "abc123";
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await withPipeline({
      name: "openclaw",
      streamChat: async function* () {
        throw new Error(`gateway failed with ${token}`);
      },
    }, token, async ({ pipeline }) => {
      await pipeline._test.processUserInput("trigger failure");
    });
  } finally {
    console.error = originalError;
  }

  assertScrubbedLog(errors, "❌  Pipeline error:", token);
});

test("floor verdict logs scrub hub and gateway tokens while preserving benign text", { concurrency: false }, async (t) => {
  const gatewayToken = "gw" + "-secret";
  const hubAuthToken = "hub" + "-key";
  const rows = [
    {
      name: "scrubs the hub auth token",
      message: `hub rejected ${hubAuthToken}`,
      expected: "hub rejected [REDACTED]",
      absent: hubAuthToken,
    },
    {
      name: "still scrubs the gateway token",
      message: `hub echoed ${gatewayToken}`,
      expected: "hub echoed [REDACTED]",
      absent: gatewayToken,
    },
    {
      name: "keeps benign errors byte-identical",
      message: "benign hub failure",
      expected: "benign hub failure",
      absent: null,
    },
  ];

  for (const row of rows) {
    await t.test(row.name, async () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        await withPipeline({
          name: "openclaw",
          streamChat: async function* () { yield "unused"; },
        }, gatewayToken, async ({ pipeline }) => {
          await pipeline._test.handleUtteranceEnd("ordinary floor speech", null, {
            cancelled: false,
            verdictPromise: Promise.reject(new Error(row.message)),
          });
        }, {
          hub: {
            enabled: true,
            url: "ws://fake",
            roomCode: "scrub-room",
            authToken: hubAuthToken,
            tailMs: 0,
          },
          floorClient: {
            connect() {},
            close() {},
            claimAssignment() { return null; },
            fallbackDelayMs() { return 0; },
          },
        });
      } finally {
        console.warn = originalWarn;
      }

      const line = warnings.find((candidate) => candidate.startsWith("⚠️  floor verdict failed:"));
      assert.equal(line, `⚠️  floor verdict failed: ${row.expected}`);
      if (row.absent) assert.ok(!line.includes(row.absent));
    });
  }
});

test("floor status chat logs scrub the hub token", { concurrency: false }, async () => {
  const gatewayToken = "gw" + "-secret";
  const hubAuthToken = "hub" + "-status";
  const warnings = [];
  const originalWarn = console.warn;
  let triggerReady;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await withPipeline({ name: "openclaw", streamChat: async function* () { yield "unused"; } }, gatewayToken,
      async () => {
        triggerReady();
        await new Promise((resolve) => setImmediate(resolve));
      }, {
        hub: { enabled: true, url: "ws://fake", roomCode: "scrub-room", authToken: hubAuthToken, tailMs: 0 },
        onChatMessage: async () => { throw new Error(`failed ${hubAuthToken}`); },
        floorClientFactory: (options) => {
          triggerReady = () => options.onReady({ members: [] });
          return floorStub();
        },
      });
  } finally {
    console.warn = originalWarn;
  }
  assertScrubbedLog(warnings, "⚠️  floor status chat failed:", hubAuthToken);
});

test("floor acquire logs scrub the hub token", { concurrency: false }, async () => {
  const gatewayToken = "gw" + "-secret";
  const hubAuthToken = "hub" + "-acquire";
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await withPipeline({ name: "openclaw", streamChat: async function* () { yield "unused"; } }, gatewayToken,
      async ({ pipeline }) => {
        await pipeline._test.handleUtteranceEnd("ordinary floor speech", null, {
          cancelled: false,
          verdictPromise: Promise.resolve({ kind: "assigned", assignment: { roundId: "r1" } }),
        });
      }, {
        hub: { enabled: true, url: "ws://fake", roomCode: "scrub-room", authToken: hubAuthToken, tailMs: 0 },
        floorClient: floorStub({ acquire: async () => { throw new Error(`failed ${hubAuthToken}`); } }),
      });
  } finally {
    console.warn = originalWarn;
  }
  assertScrubbedLog(warnings, "⚠️  floor acquire failed:", hubAuthToken);
});

test("farewell floor failures scrub the hub token", { concurrency: false }, async (t) => {
  const gatewayToken = "gw" + "-secret";
  const hubAuthToken = "hub" + "-farewell";
  const rows = [
    {
      prefix: "⚠️  farewell floor verdict failed:",
      floorTurn: { cancelled: false, verdictPromise: Promise.reject(new Error(`failed ${hubAuthToken}`)) },
      floor: floorStub(),
    },
    {
      prefix: "⚠️  farewell floor acquire failed:",
      floorTurn: { cancelled: false, verdictPromise: Promise.resolve({ kind: "assigned", assignment: { roundId: "r1" } }) },
      floor: floorStub({ acquire: async () => { throw new Error(`failed ${hubAuthToken}`); } }),
    },
  ];

  for (const row of rows) {
    await t.test(row.prefix, async () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        await withPipeline({ name: "openclaw", streamChat: async function* () { yield "unused"; } }, gatewayToken,
          async ({ pipeline }) => {
            await pipeline._test.handleUtteranceEnd("alpha 退出して", null, row.floorTurn);
          }, {
            hub: { enabled: true, url: "ws://fake", roomCode: "scrub-room", authToken: hubAuthToken, tailMs: 0 },
            floorClient: row.floor,
            exitDetection: true,
            timers: immediateTimers,
          });
      } finally {
        console.warn = originalWarn;
      }
      assertScrubbedLog(warnings, row.prefix, hubAuthToken);
    });
  }
});

test("floor non-addressed transcript logs keep their prefix", { concurrency: false }, async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await withPipeline({ name: "openclaw", streamChat: async function* () { yield "unused"; } }, "gw" + "-secret",
      async ({ pipeline }) => {
        await pipeline._test.handleUtteranceEnd("not addressed", null, {
          cancelled: false,
          verdictPromise: Promise.resolve({ kind: "not_assigned" }),
        });
      }, {
        hub: { enabled: true, url: "ws://fake", roomCode: "scrub-room", authToken: "hub" + "-token", tailMs: 0 },
        floorClient: floorStub(),
      });
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.includes('🔇  [会議音声・非指名] "not addressed..."'));
});
