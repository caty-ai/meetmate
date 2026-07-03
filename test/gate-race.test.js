const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("utterance handling serializes rapid wake turns without dropping the replayed reply", async () => {
  const previousEnv = {
    POST_UTTERANCE_BUFFER_MS: process.env.POST_UTTERANCE_BUFFER_MS,
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
    WAKE_WORDS: process.env.WAKE_WORDS,
  };
  process.env.POST_UTTERANCE_BUFFER_MS = "0";
  process.env.ENABLE_IMMEDIATE_ACK = "false";
  process.env.ENABLE_PROGRESS_GUARD = "false";
  process.env.TTS_GAP_MS = "0";
  process.env.SENTENCE_PAUSE_MS = "0";
  process.env.WAKE_WORDS = "ケイティ";

  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm.js"),
    path.join(src, "tts-fish.js"),
    path.join(src, "pipeline.js"),
  ];
  const previousCache = new Map(paths.map((p) => [require.resolve(p), require.cache[require.resolve(p)]]));
  for (const p of paths) delete require.cache[require.resolve(p)];

  let sttEmitter;
  const sttExports = {
    createSTT: () => {
      sttEmitter = new EventEmitter();
      sttEmitter.send = () => {};
      sttEmitter.close = () => {};
      return sttEmitter;
    },
    buildKeyterms: () => [],
  };

  let active = 0;
  let maxConcurrent = 0;
  const starts = [];
  const completed = [];
  const spoken = [];

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm.js"))] = cacheEntry(path.join(src, "llm.js"), {
    streamChat: async function* (messages, opts) {
      const label = String(messages[0]?.content || "").match(/タスク[A-C]/)?.[0] || "unknown";
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      starts.push({ label, concurrentAtStart: active });
      try {
        await sleep(140);
        if (opts.signal?.aborted) return;
        yield `完了:${label}。`;
        completed.push(label);
      } finally {
        active -= 1;
      }
    },
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => {
      spoken.push(text);
      onAudio(Buffer.alloc(4));
    },
  });

  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = { id: "race-test", conversationLog: [], config: { wakeMode: "wake" } };
    const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
    const config = {
      dgKey: "x",
      fishKey: "x",
      openclawUrl: "http://localhost:9",
      openclawToken: "x",
      stt: { model: "nova-3", language: "ja", sampleRate: 16000 },
      llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, openclawSystemAddendum: "" },
      tts: { referenceId: null, sampleRate: 16000, latency: "balanced", speed: 1.0 },
      echoCooldownMs: 1,
      greeting: "",
    };

    const pipeline = createPipeline(session, turnState, () => {}, config, {
      agents: { caty: { wakeWords: ["ケイティ"] } },
      selectedAgentIds: ["caty"],
      defaultAgentId: "caty",
    });

    sttEmitter.emit("utterance_end", "ケイティ、タスクA");
    await sleep(20);
    sttEmitter.emit("utterance_end", "ケイティ、タスクB");
    await sleep(170);
    const cArrivedDuringActiveRun = active > 0;
    sttEmitter.emit("utterance_end", "ケイティ、タスクC");

    await waitFor(() => completed.length === 3, 2500);
    pipeline.close();

    assert.equal(maxConcurrent, 1);
    assert.equal(cArrivedDuringActiveRun, true);
    assert.deepEqual(starts.map((r) => r.concurrentAtStart), [1, 1, 1]);
    assert.deepEqual(completed.sort(), ["タスクA", "タスクB", "タスクC"]);
    assert(spoken.some((text) => text.includes("完了:タスクC。")));
  } finally {
    for (const p of paths) {
      const resolved = require.resolve(p);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("pending queue replays a wake turn observed while the gate is closed", async () => {
  const previousEnv = {
    POST_UTTERANCE_BUFFER_MS: process.env.POST_UTTERANCE_BUFFER_MS,
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
    WAKE_WORDS: process.env.WAKE_WORDS,
  };
  process.env.POST_UTTERANCE_BUFFER_MS = "0";
  process.env.ENABLE_IMMEDIATE_ACK = "false";
  process.env.ENABLE_PROGRESS_GUARD = "false";
  process.env.TTS_GAP_MS = "0";
  process.env.SENTENCE_PAUSE_MS = "0";
  process.env.WAKE_WORDS = "ケイティ";

  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm.js"),
    path.join(src, "tts-fish.js"),
    path.join(src, "pipeline.js"),
  ];
  const previousCache = new Map(paths.map((p) => [require.resolve(p), require.cache[require.resolve(p)]]));
  for (const p of paths) delete require.cache[require.resolve(p)];

  let sttEmitter;
  const sttExports = {
    createSTT: () => {
      sttEmitter = new EventEmitter();
      sttEmitter.send = () => {};
      sttEmitter.close = () => {};
      return sttEmitter;
    },
    buildKeyterms: () => [],
  };

  let active = 0;
  const completed = [];

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm.js"))] = cacheEntry(path.join(src, "llm.js"), {
    streamChat: async function* (messages, opts) {
      const label = String(messages[0]?.content || "").match(/タスク[A-B]/)?.[0] || "unknown";
      active += 1;
      try {
        await sleep(160);
        if (opts.signal?.aborted) return;
        yield `完了:${label}。`;
        completed.push(label);
      } finally {
        active -= 1;
      }
    },
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => {
      onAudio(Buffer.alloc(4));
    },
  });

  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = { id: "pending-replay-test", conversationLog: [], config: { wakeMode: "wake" } };
    const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
    const config = {
      dgKey: "x",
      fishKey: "x",
      openclawUrl: "http://localhost:9",
      openclawToken: "x",
      stt: { model: "nova-3", language: "ja", sampleRate: 16000 },
      llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, openclawSystemAddendum: "" },
      tts: { referenceId: null, sampleRate: 16000, latency: "balanced", speed: 1.0 },
      echoCooldownMs: 1,
      greeting: "",
    };

    const pipeline = createPipeline(session, turnState, () => {}, config, {
      agents: { caty: { wakeWords: ["ケイティ"] } },
      selectedAgentIds: ["caty"],
      defaultAgentId: "caty",
      _testExposeInternals: true,
    });

    sttEmitter.emit("utterance_end", "ケイティ、タスクA");
    await waitFor(() => active === 1 && pipeline._test.getGateState() === "CLOSED", 500);

    await pipeline._test.handleUtteranceEnd("ケイティ、タスクB");
    assert.equal(pipeline._test.getPendingQueueLength(), 1);

    await waitFor(() => completed.length === 2, 2500);
    assert.deepEqual(completed, ["タスクA", "タスクB"]);
    assert.equal(pipeline._test.getPendingQueueLength(), 0);
    assert.equal(pipeline._test.getGateState(), "OPEN");

    pipeline.close();
  } finally {
    for (const p of paths) {
      const resolved = require.resolve(p);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function cacheEntry(filename, exports) {
  return {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail("Timed out waiting for serialized wake turns to complete");
}
