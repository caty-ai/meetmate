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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function withPipeline(fn) {
  const files = ["pipeline.js", "llm-provider.js", "stt-provider.js", "tts-fish.js", "metrics.js"]
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
  const sttInstances = [];
  const logs = [];
  const originalLog = console.log;
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
      {
        createSTT: () => {
          const stt = Object.assign(new EventEmitter(), { send() {}, close() {} });
          sttInstances.push(stt);
          return stt;
        },
        buildKeyterms: () => [],
      },
    );
    require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(
      path.join(src, "llm-provider.js"),
      {
        createLlmProvider: () => ({
          name: "openclaw",
          streamChat: async function* () { yield "unused"; },
        }),
      },
    );
    require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(
      path.join(src, "tts-fish.js"),
      { synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(2)) },
    );
    require.cache[require.resolve(path.join(src, "metrics.js"))] = cacheEntry(
      path.join(src, "metrics.js"),
      { recordEvent() {} },
    );

    settingsBootstrap.resetStartupForTest();
    settingsResolver.resetRuntimeForTest();
    console.log = (...args) => logs.push(args.join(" "));

    const { createPipeline } = require(pipelinePath);
    pipeline = createPipeline(
      { id: "pipeline-speaker-log", conversationLog: [], config: { wakeMode: "wake" } },
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
          gateway: { url: "http://gateway.test", token: "gateway-token" },
        },
        hub: { enabled: false },
        gatewayEvents: { enabled: false },
        greeting: "",
        exitDetection: false,
        echoCooldownMs: 0,
      },
      {
        transport: "discord",
        capabilities: { echoesOwnOutput: false, perSpeakerAudio: true },
        agents: { alpha: { wakeWords: ["alpha"] } },
        selectedAgentIds: ["alpha"],
        defaultAgentId: "alpha",
        suppressGreeting: true,
        _testExposeInternals: true,
      },
    );
    await fn({ pipeline, sttInstances, logs });
  } finally {
    pipeline?.close();
    console.log = originalLog;
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

function createSpeaker(id, displayName) {
  return {
    platform: "discord",
    id,
    isBot: false,
    ...(displayName === undefined ? {} : { displayName }),
  };
}

function attributedStt(pipeline, sttInstances, speaker) {
  pipeline.sendAudio(Buffer.alloc(2), { speaker });
  assert.equal(sttInstances.length, 2);
  return sttInstances[1];
}

test("user transcript log uses the speaker display name", { concurrency: false }, async () => {
  await withPipeline(async ({ pipeline, sttInstances, logs }) => {
    const stt = attributedStt(pipeline, sttInstances, createSpeaker("user-1", "Alice"));
    stt.emit("utterance_end", "hello from Alice");

    await waitFor(
      () => logs.includes('🔇  [会議音声・未指名] [Alice] "hello from Alice..."'),
      "speaker utterance did not finish",
    );
    assert.ok(logs.includes("💬  [user] [Alice] hello from Alice"));
  });
});

test("user transcript log falls back to platform and id", { concurrency: false }, async () => {
  await withPipeline(async ({ pipeline, sttInstances, logs }) => {
    const stt = attributedStt(pipeline, sttInstances, createSpeaker("user-2"));
    stt.emit("utterance_end", "fallback identity");

    await waitFor(
      () => logs.includes('🔇  [会議音声・未指名] [discord:user-2] "fallback identity..."'),
      "speaker utterance did not finish",
    );
    assert.ok(logs.includes("💬  [user] [discord:user-2] fallback identity"));
  });
});

test("user transcript log falls back to id when platform is absent", { concurrency: false }, async () => {
  await withPipeline(async ({ pipeline, sttInstances, logs }) => {
    const stt = attributedStt(pipeline, sttInstances, { id: "user-9", isBot: false });
    stt.emit("utterance_end", "id-only identity");

    await waitFor(
      () => logs.includes('🔇  [会議音声・未指名] [user-9] "id-only identity..."'),
      "id-only utterance did not finish",
    );
    assert.ok(logs.includes("💬  [user] [user-9] id-only identity"));
  });
});

test("user transcript log without speaker metadata is byte-identical", { concurrency: false }, async () => {
  await withPipeline(async ({ sttInstances, logs }) => {
    sttInstances[0].emit("utterance_end", "shared stream text");

    await waitFor(
      () => logs.includes('🔇  [会議音声・未指名] "shared stream text..."'),
      "shared utterance did not finish",
    );
    const line = logs.find((candidate) => candidate.startsWith("💬  [user]"));
    assert.equal(line, "💬  [user] shared stream text");
  });
});

test("final transcript logs include a tag only for resolved speakers", { concurrency: false }, async () => {
  await withPipeline(async ({ pipeline, sttInstances, logs }) => {
    const stt = attributedStt(pipeline, sttInstances, createSpeaker("user-3", "Carol"));
    stt.emit("transcript", "attributed final", true, 0.99);
    sttInstances[0].emit("transcript", "shared final", true, 0.99);

    assert.ok(logs.includes("🎤  [interim→final] [Carol] attributed final"));
    assert.ok(logs.includes("🎤  [interim→final] shared final"));
  });
});

test("synthetic unknown mixed-stream speakers keep transcript logs byte-identical", { concurrency: false }, async () => {
  await withPipeline(async ({ pipeline, sttInstances, logs }) => {
    pipeline.sendAudio(Buffer.alloc(2), {
      speaker: { platform: "discord", id: "unknown", isBot: false },
    });
    assert.equal(sttInstances.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    sttInstances[0].emit("transcript", "unknown mixed final", true, 0.99);
    sttInstances[0].emit("utterance_end", "unknown mixed text");

    await waitFor(
      () => logs.includes('🔇  [会議音声・未指名] "unknown mixed text..."'),
      "unknown mixed utterance did not finish",
    );
    assert.ok(logs.includes("🎤  [interim→final] unknown mixed final"));
    assert.ok(logs.includes("💬  [user] unknown mixed text"));
    assert.ok(logs.every((line) => !line.includes("[discord:unknown]")));
  });
});

test("unaddressed transcript log includes the resolved speaker tag", { concurrency: false }, async () => {
  await withPipeline(async ({ pipeline, sttInstances, logs }) => {
    const stt = attributedStt(pipeline, sttInstances, createSpeaker("user-4", "Dana"));
    stt.emit("utterance_end", "not addressed");

    await waitFor(
      () => logs.some((line) => line.startsWith("🔇  [会議音声・未指名]")),
      "unaddressed utterance did not finish",
    );
    assert.ok(logs.includes('🔇  [会議音声・未指名] [Dana] "not addressed..."'));
  });
});
