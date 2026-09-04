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

async function withPipeline(provider, token, fn) {
  const files = ["pipeline.js", "llm-provider.js", "stt-provider.js", "tts-fish.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  const previousEnv = {
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
  };
  const stt = Object.assign(new EventEmitter(), { send() {}, close() {} });
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  let pipeline;

  try {
    Object.assign(process.env, {
      ENABLE_IMMEDIATE_ACK: "false",
      ENABLE_PROGRESS_GUARD: "false",
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
        hub: { enabled: false },
        gatewayEvents: { enabled: false },
        greeting: "",
        exitDetection: false,
        echoCooldownMs: 0,
      },
      {
        agents: { alpha: { wakeWords: ["alpha"] } },
        selectedAgentIds: ["alpha"],
        defaultAgentId: "alpha",
        suppressGreeting: true,
        _testExposeInternals: true,
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
