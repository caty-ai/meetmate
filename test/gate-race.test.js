const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gateRaceConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

test.before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

test.after(() => {
  console.log = gateRaceConsole.log;
  console.warn = gateRaceConsole.warn;
  console.error = gateRaceConsole.error;
});

function resetSettingsSnapshots() {
  require("../src/settings/bootstrap").resetStartupForTest();
  require("../src/settings/resolver").resetRuntimeForTest();
}

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
  resetSettingsSnapshots();

  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm-provider.js"),
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
  const llmMock = {
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
  };
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({ name: "openclaw", ...llmMock }),
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
      agentProfile: { agentId: "caty", wakeWords: ["ケイティ"] },
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
    resetSettingsSnapshots();
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
  resetSettingsSnapshots();

  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm-provider.js"),
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
  const llmMock = {
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
  };
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({ name: "openclaw", ...llmMock }),
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
      agentProfile: { agentId: "caty", wakeWords: ["ケイティ"] },
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
    resetSettingsSnapshots();
  }
});

test("hub pending reports arbitrate before replay and non-assigned exit reopens the gate", async () => {
  const previousEnv = {
    POST_UTTERANCE_BUFFER_MS: process.env.POST_UTTERANCE_BUFFER_MS,
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    TTS_LEAD_MS: process.env.TTS_LEAD_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
  };
  process.env.POST_UTTERANCE_BUFFER_MS = "0";
  process.env.ENABLE_IMMEDIATE_ACK = "false";
  process.env.ENABLE_PROGRESS_GUARD = "false";
  process.env.TTS_GAP_MS = "0";
  process.env.TTS_LEAD_MS = "0";
  process.env.SENTENCE_PAUSE_MS = "0";
  resetSettingsSnapshots();

  const src = path.join(__dirname, "..", "src");
  const paths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(paths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of paths) delete require.cache[require.resolve(file)];

  let sttEmitter;
  const events = [];
  const gatewayPrompts = [];
  const fallbackCancels = [];
  const floor = new EventEmitter();
  floor.state = "READY";
  floor.memberId = "m1";
  floor.connectionEpoch = 1;
  floor.members = [
    { memberId: "m1", displayName: "Caty", wakeWords: ["ケイティ"] },
    { memberId: "m2", displayName: "Ciel", wakeWords: ["シエル"] },
  ];
  floor.connect = () => {};
  floor.claimAssignment = () => null;
  floor.reportText = (text, options = {}) => {
    events.push(`report:${text}`);
    fallbackCancels.push(options.onFallbackCancel);
    if (text.includes("D")) return Promise.resolve({ kind: "verdict_timeout" });
    return Promise.resolve(/[AC]/u.test(text)
      ? { kind: "assigned", assignment: { roundId: text.includes("C") ? "r3" : "r1", memberId: "m1" } }
      : { kind: "not_assigned", assignment: { roundId: "r2", memberId: null } });
  };
  floor.reportWake = () => {
    events.push("synthetic_report");
    return Promise.resolve({ kind: "not_assigned" });
  };
  floor.acquire = async (roundId) => {
    events.push(`acquire:${roundId}`);
    floor.grant = { grantId: "g1", connectionEpoch: 1, roundId };
    floor.state = "HELD";
    return floor.grant;
  };
  floor.fence = () => floor.grant || null;
  floor.isFenceCurrent = (fence) => Boolean(floor.grant && fence?.grantId === floor.grant.grantId);
  floor.speech = () => true;
  floor.release = () => { floor.grant = null; floor.state = "READY"; return true; };
  floor.close = () => {};
  floor.waitForReady = async () => true;
  floor.fallbackDelayMs = () => 0;

  const sttExports = {
    createSTT: () => {
      sttEmitter = new EventEmitter();
      sttEmitter.send = () => {};
      sttEmitter.close = () => {};
      return sttEmitter;
    },
    buildKeyterms: () => [],
  };
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      streamChat: async function* (messages) {
        events.push("gateway");
        gatewayPrompts.push(messages.at(-1).content);
        yield "Aだけの回答です。";
      },
    }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4)),
  });

  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = { id: "floor-gate-race", conversationLog: [], config: { wakeMode: "wake" } };
    const pipeline = createPipeline(session, {
      isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0,
    }, () => {}, {
      dgKey: "x", fishKey: "x",
      stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
      llm: { provider: "openclaw", model: "test", responseTimeoutMs: 0, firstTokenDelegateMs: 0 },
      tts: { provider: "fish-audio", sampleRate: 16_000, speed: 1, latency: "balanced" },
      hub: { enabled: true, url: "ws://fake", roomCode: "race", authToken: "x", tailMs: 0 },
      greeting: "", echoCooldownMs: 0,
    }, {
      agentProfile: { agentId: "caty", wakeWords: ["ケイティ"] },
      floorClient: floor,
      _testExposeInternals: true,
    });

    sttEmitter.emit("utterance_end", "ケイティ、タスクA");
    sttEmitter.emit("utterance_end", "ケイティ、タスクB");
    assert.deepEqual(events.slice(0, 2), ["report:ケイティ、タスクA", "report:ケイティ、タスクB"]);
    await waitFor(() => pipeline._test.getGateState() === "OPEN" && gatewayPrompts.length === 1, 1_000);
    assert.equal(events.indexOf("acquire:r1") < events.indexOf("gateway"), true);
    assert.equal(gatewayPrompts.length, 1);
    assert.equal(session.conversationLog.some((entry) => entry.content.includes("[会議音声・未指名] ケイティ、タスクB")), true);
    assert.equal(pipeline._test.getPendingQueueLength(), 0);

    // A late assignment may cancel one local fallback, but that cancellation
    // belongs to that report only and must not poison the next valid turn.
    fallbackCancels[0]();
    sttEmitter.emit("utterance_end", "ケイティ、タスクC");
    await waitFor(() => gatewayPrompts.length === 2 && pipeline._test.getGateState() === "OPEN", 1_000);
    assert.match(gatewayPrompts[1], /タスクC/u);

    sttEmitter.emit("utterance_end", "ケイティ、タスクD");
    await waitFor(() => gatewayPrompts.length === 3 && pipeline._test.getGateState() === "OPEN", 1_000);
    assert.match(gatewayPrompts[2], /タスクD/u);
    assert.equal(events.includes("synthetic_report"), false);
    pipeline.close();
  } finally {
    for (const file of paths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSettingsSnapshots();
  }
});

test("grant fence drops PCM produced after a mid-stream revoke", async () => {
  const previousEnv = {
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    TTS_LEAD_MS: process.env.TTS_LEAD_MS,
  };
  process.env.TTS_GAP_MS = "0";
  process.env.TTS_LEAD_MS = "0";

  const src = path.join(__dirname, "..", "src");
  const paths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(paths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of paths) delete require.cache[require.resolve(file)];

  const floor = new EventEmitter();
  floor.state = "HELD";
  floor.memberId = "m1";
  floor.connectionEpoch = 7;
  floor.members = [{ memberId: "m1", displayName: "Caty", wakeWords: ["ケイティ"] }];
  floor.grant = { grantId: "g-live", connectionEpoch: 7, roundId: "r1" };
  floor.connect = () => {};
  floor.fence = () => floor.grant || null;
  floor.isFenceCurrent = (fence) => Boolean(
    floor.grant
    && fence?.grantId === floor.grant.grantId
    && fence?.connectionEpoch === floor.connectionEpoch
  );
  floor.speech = () => true;
  floor.release = () => true;
  floor.close = () => {};

  const sttExports = {
    createSTT: () => Object.assign(new EventEmitter(), { send() {}, close() {} }),
    buildKeyterms: () => [],
  };
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({ name: "openclaw", streamChat: async function* () {} }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (_text, { onAudio }) => {
      onAudio(Buffer.alloc(4, 1));
      floor.grant = null;
      floor.state = "READY";
      onAudio(Buffer.alloc(4, 2));
    },
  });

  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const audio = [];
    const pipeline = createPipeline(
      { id: "floor-fence-race", conversationLog: [], config: { wakeMode: "wake" } },
      { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 },
      (buffer) => audio.push(Buffer.from(buffer)),
      {
        dgKey: "x", fishKey: "x",
        stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
        llm: { provider: "openclaw", model: "test", responseTimeoutMs: 0, firstTokenDelegateMs: 0 },
        tts: { provider: "fish-audio", sampleRate: 16_000, speed: 1, latency: "balanced" },
        hub: { enabled: true, url: "ws://fake", roomCode: "race", authToken: "x", tailMs: 0 },
        greeting: "", echoCooldownMs: 0,
      },
      {
        agentProfile: { agentId: "caty", wakeWords: ["ケイティ"] },
        floorClient: floor,
        _testExposeInternals: true,
      },
    );
    const cancellations = [];
    pipeline.on("playback_cancelled", (event) => cancellations.push(event));

    await pipeline._test.speakSentence("二つのPCMチャンク", null);

    assert.equal(audio.length, 1);
    assert.equal(audio[0].equals(Buffer.alloc(4, 1)), true);
    assert.equal(cancellations.at(-1)?.reason, "floor_fence");
    pipeline.close();
  } finally {
    for (const file of paths) {
      const resolved = require.resolve(file);
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
