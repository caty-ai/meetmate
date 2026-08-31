"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

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

function speaker(id, displayName = id) {
  return { platform: "discord", id, displayName, isBot: false };
}

function pcmWindow(sample, sampleCount = 320) {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(sample, index * 2);
  }
  return buffer;
}

function lastUserEntry(session) {
  return [...session.conversationLog].reverse().find((entry) => entry.role === "user") || null;
}

async function withMuxHarness(run, options = {}) {
  const src = path.join(__dirname, "..", "src");
  const files = [
    "stt-provider.js",
    "stt.js",
    "llm-provider.js",
    "tts-fish.js",
    "metrics.js",
    "pipeline.js",
  ].map((name) => path.join(src, name));
  const previousCache = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of files) delete require.cache[require.resolve(file)];

  const restoreEnv = setEnv({
    WAKE_WORDS: undefined,
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    POST_UTTERANCE_BUFFER_MS: "0",
    TTS_GAP_MS: "0",
    TTS_LEAD_MS: "0",
    SENTENCE_PAUSE_MS: "0",
    METRICS_DISABLED: "1",
  });

  const sttInstances = [];
  const llmCalls = [];
  const spoken = [];
  const observedAudio = [];
  const sttExports = {
    createSTT: () => {
      const instance = new EventEmitter();
      instance.index = sttInstances.length;
      instance.sent = [];
      instance.closeCalls = 0;
      instance.send = (buffer) => instance.sent.push(Buffer.from(buffer));
      instance.close = () => {
        instance.closeCalls += 1;
      };
      options.onCreateStt?.(instance, instance.index);
      sttInstances.push(instance);
      return instance;
    },
    buildKeyterms: () => [],
  };
  installMock(path.join(src, "stt-provider.js"), cacheEntry(path.join(src, "stt-provider.js"), sttExports).exports);
  installMock(path.join(src, "stt.js"), cacheEntry(path.join(src, "stt.js"), sttExports).exports);
  installMock(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      VOICE_SYSTEM_ADDENDUM: "",
      buildVoiceAddendum: () => "",
      streamChat: async function* (...args) {
        llmCalls.push(args);
        if (options.streamChat) {
          yield* options.streamChat(...args);
          return;
        }
        yield "通常応答です。";
      },
    }),
  });
  installMock(path.join(src, "tts-fish.js"), {
    synthesize: options.synthesize || (async (text, { onAudio }) => {
      spoken.push(text);
      onAudio(Buffer.from([1, 0, 2, 0]));
    }),
  });
  installMock(path.join(src, "metrics.js"), { recordEvent: () => {} });

  let closed = false;
  let pipeline = null;
  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = {
      id: options.sessionId || "mux-session",
      conversationLog: [],
      conversationLogs: { caty: [] },
      config: { wakeMode: "wake" },
    };
    const turnState = {
      isAgentSpeaking: false,
      lastTurnEndAt: null,
      inputCooldownUntil: 0,
      droppedEchoFrames: 0,
    };
    const config = {
      dgKey: "dg-key",
      fishKey: "fish-key",
      stt: { provider: "soniox", model: "test", language: "ja", sampleRate: 16_000 },
      llm: { provider: "openclaw", model: "test-model", temperature: 0, maxTokens: 64, responseTimeoutMs: 0, openclawSystemAddendum: "" },
      tts: { referenceId: "voice-id", sampleRate: 24_000, latency: "balanced", speed: 1 },
      echoCooldownMs: 0,
      greeting: options.greeting ?? "",
      gatewayEvents: options.gatewayEventsConfig || { enabled: false },
      messages: {
        speech: { circuitBreakerRecoveryNotice: "recovering" },
        regex: {
          cancelPattern: "ストップ|停止|キャンセル|やめて",
          cancelFlags: "iu",
          shortUtterancePingPatterns: [],
          shortUtterancePingFlags: "iu",
        },
        prompts: {},
        delegation: {},
      },
    };
    const agents = options.agents || {
      caty: { wakeWords: ["ケイティ"], voiceId: "voice-id", model: "test-model", greeting: "default greeting" },
    };
    pipeline = createPipeline(session, turnState, (buffer, metadata) => {
      observedAudio.push({ buffer: Buffer.from(buffer), metadata: { ...metadata } });
    }, config, {
      transport: "discord",
      capabilities: { echoesOwnOutput: false, perSpeakerAudio: true },
      agents,
      selectedAgentIds: options.selectedAgentIds || Object.keys(agents),
      defaultAgentId: options.defaultAgentId || "caty",
      onChatMessage: options.onChatMessage,
      _testExposeInternals: true,
      ...options.pipelineOptions,
    });
    const rawClose = pipeline.close.bind(pipeline);
    pipeline.close = () => {
      if (closed) return;
      closed = true;
      return rawClose();
    };

    await run({
      pipeline,
      session,
      turnState,
      sttInstances,
      llmCalls,
      spoken,
      observedAudio,
      closePipeline: () => pipeline.close(),
    });
  } finally {
    if (!closed) pipeline?.close();
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    restoreEnv();
  }
}

test("stt mux keeps slots lazy, caps attributed streams at four, and never slots unknown", { concurrency: false }, async () => {
  await withMuxHarness(async ({ pipeline, sttInstances }) => {
    const chunk = pcmWindow(1_000);
    assert.equal(sttInstances.length, 1);

    for (const id of ["a", "b", "c", "d"]) {
      pipeline.sendAudio(chunk, { speaker: speaker(id) });
    }
    assert.equal(sttInstances.length, 5);
    assert.deepEqual(pipeline._test.getSttMuxState().slots, ["a", "b", "c", "d"]);
    assert.equal(sttInstances[0].sent.length, 0);

    pipeline.sendAudio(chunk, { speaker: speaker("e") });
    await delay(35);
    pipeline.sendAudio(chunk, { speaker: speaker("unknown", "Overflow") });
    await delay(35);

    assert.equal(sttInstances.length, 5);
    assert.deepEqual(pipeline._test.getSttMuxState().slots, ["a", "b", "c", "d"]);
    assert.equal(sttInstances[0].sent.length, 2);
  });
});

test("stt mux evicts only on utterance_end for the current LRU slot, preserves speaker fields, and admits new speakers after eviction", { concurrency: false }, async () => {
  await withMuxHarness(async ({ pipeline, sttInstances, session }) => {
    const chunk = pcmWindow(500);
    for (const id of ["a", "b", "c", "d"]) {
      pipeline.sendAudio(chunk, { speaker: speaker(id) });
    }
    const [, slotA, slotB] = sttInstances;

    pipeline.sendAudio(chunk, { speaker: speaker("b") });
    slotB.emit("transcript", "発話中", true, 0.99);
    await delay(5);
    assert.deepEqual(pipeline._test.getSttMuxState().slots, ["a", "b", "c", "d"]);

    slotB.emit("utterance_end", "ただの発話");
    await delay(15);
    assert.deepEqual(pipeline._test.getSttMuxState().slots, ["a", "b", "c", "d"]);
    assert.deepEqual(
      Object.keys(lastUserEntry(session).speaker).sort(),
      ["displayName", "id", "isBot", "platform"]
    );

    slotA.emit("utterance_end", "別の発話");
    await waitUntil(() => !pipeline._test.getSttMuxState().slots.includes("a"));
    assert.deepEqual(pipeline._test.getSttMuxState().slots, ["b", "c", "d"]);
    assert.equal(slotA.closeCalls, 1);

    pipeline.sendAudio(chunk, { speaker: speaker("e") });
    assert.equal(sttInstances.length, 6);
    assert.deepEqual(pipeline._test.getSttMuxState().slots, ["b", "c", "d", "e"]);
  });
});

test("queued late finals from an evicted slot are skipped by the shared utterance chain", { concurrency: false }, async () => {
  let releaseFirstTurn = null;
  const firstTurnGate = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });

  await withMuxHarness(async ({ pipeline, sttInstances, llmCalls, session, turnState, closePipeline }) => {
    const chunk = pcmWindow(700);
    for (const id of ["a", "b", "c", "d"]) {
      pipeline.sendAudio(chunk, { speaker: speaker(id) });
    }
    const [, slotA] = sttInstances;

    pipeline.sendAudio(chunk, { speaker: speaker("d") });
    slotA.emit("utterance_end", "ケイティ、最初の依頼");
    slotA.emit("utterance_end", "ケイティ、遅延した依頼");

    await waitUntil(() => llmCalls.length === 1);
    releaseFirstTurn();

    await waitUntil(() => !pipeline._test.getSttMuxState().slots.includes("a"));
    await delay(20);

    assert.equal(llmCalls.length, 1);
    assert.equal(session.conversationLog.some((entry) => String(entry.content).includes("遅延した依頼")), false);
    await waitUntil(
      () => session.conversationLog.filter((entry) => entry.role === "assistant" && entry.content === "通常応答です。").length === 1
    );
    await waitUntil(() => pipeline._test.getCurrentAbortController() === null && turnState.isAgentSpeaking === false);
    closePipeline();
    await delay(10);
  }, {
    streamChat: async function* () {
      await firstTurnGate;
      yield "通常応答です。";
    },
  });
});

test("distinct speaker finals serialize through the shared utterance chain one at a time", { concurrency: false }, async () => {
  let releaseFirstTurn = null;
  const firstTurnGate = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });

  await withMuxHarness(async ({ pipeline, sttInstances, llmCalls, session, turnState, closePipeline }) => {
    const chunk = pcmWindow(650);
    pipeline.sendAudio(chunk, { speaker: speaker("a", "Alice") });
    pipeline.sendAudio(chunk, { speaker: speaker("b", "Bob") });
    const [, slotA, slotB] = sttInstances;

    slotA.emit("utterance_end", "ケイティ、タスクA");
    await waitUntil(() => llmCalls.length === 1);

    slotB.emit("utterance_end", "ケイティ、タスクB");
    await delay(20);
    assert.equal(llmCalls.length, 1);

    releaseFirstTurn();

    await waitUntil(() => llmCalls.length === 2);
    await waitUntil(
      () => session.conversationLog.filter((entry) => entry.role === "assistant" && entry.content === "通常応答です。").length === 2
    );
    assert.deepEqual(
      session.conversationLog
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.content),
      ["ケイティ、タスクA", "ケイティ、タスクB"]
    );
    await waitUntil(() => pipeline._test.getCurrentAbortController() === null && turnState.isAgentSpeaking === false);
    closePipeline();
    await delay(10);
  }, {
    streamChat: async function* () {
      await firstTurnGate;
      yield "通常応答です。";
    },
  });
});

test("mixed overflow clamps at flush and resets between separated bursts", { concurrency: false }, async () => {
  await withMuxHarness(async ({ pipeline, sttInstances }) => {
    const baseNow = Date.now();
    const originalNow = Date.now;
    let now = baseNow;
    Date.now = () => now;
    try {
      const pos = pcmWindow(30_000);
      const neg = pcmWindow(-30_000);
      const next = pcmWindow(1_000);
      for (const id of ["a", "b", "c", "d"]) {
        pipeline.sendAudio(pos, { speaker: speaker(id) });
      }

      pipeline.sendAudio(pos, { speaker: speaker("e") });
      pipeline.sendAudio(pos, { speaker: speaker("f") });
      pipeline.sendAudio(neg, { speaker: speaker("g") });
      setTimeout(() => { now = baseNow + 25; }, 10);
      await delay(40);

      assert.equal(sttInstances[0].sent.length, 1);
      assert.equal(sttInstances[0].sent[0].length, 640);
      assert.equal(sttInstances[0].sent[0].readInt16LE(0), 30_000);

      now = baseNow + 60;
      pipeline.sendAudio(next, { speaker: speaker("h") });
      setTimeout(() => { now = baseNow + 85; }, 10);
      await delay(40);

      assert.equal(sttInstances[0].sent.length, 2);
      assert.equal(sttInstances[0].sent[1].readInt16LE(0), 1_000);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("mixed wake survives overflow and absent-meta direct audio clears stale unknown attribution", { concurrency: false }, async () => {
  await withMuxHarness(async ({ pipeline, sttInstances, session }) => {
    const chunk = pcmWindow(1_200);
    for (const id of ["a", "b", "c", "d"]) {
      pipeline.sendAudio(chunk, { speaker: speaker(id) });
    }

    pipeline.sendAudio(chunk, { speaker: speaker("e") });
    await delay(35);
    sttInstances[0].emit("utterance_end", "ケイティ、確認して");
    await waitUntil(() => session.conversationLog.some((entry) => entry.role === "assistant" && entry.content === "通常応答です。"));

    const mixedWakeEntry = lastUserEntry(session);
    assert.equal(mixedWakeEntry?.speaker?.id, "unknown");

    pipeline.sendAudio(chunk);
    assert.deepEqual(sttInstances[0].sent.at(-1), chunk);
    sttInstances[0].emit("utterance_end", "ただの発話");
    await waitUntil(() => String(lastUserEntry(session)?.content || "").includes("ただの発話"));

    const directEntry = lastUserEntry(session);
    assert.equal(Object.hasOwn(directEntry, "speaker"), false);
  });
});

test("perSpeakerAudio false ignores speaker metadata and never creates slots", { concurrency: false }, async () => {
  await withMuxHarness(async ({ pipeline, sttInstances }) => {
    const chunk = pcmWindow(900);

    pipeline.sendAudio(chunk, { speaker: speaker("a") });
    pipeline.sendAudio(chunk);

    assert.equal(sttInstances.length, 1);
    assert.deepEqual(sttInstances[0].sent, [chunk, chunk]);
  }, {
    pipelineOptions: { capabilities: { echoesOwnOutput: false, perSpeakerAudio: false } },
  });
});

test("close closes slot streams before the mixed stream and swallows close rejections", { concurrency: false }, async () => {
  const closeOrder = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await withMuxHarness(async ({ pipeline, sttInstances, closePipeline }) => {
      const chunk = pcmWindow(600);
      pipeline.sendAudio(chunk, { speaker: speaker("a") });
      pipeline.sendAudio(chunk, { speaker: speaker("b") });

      sttInstances[0].close = () => {
        closeOrder.push("mixed");
        sttInstances[0].closeCalls += 1;
      };
      sttInstances[1].close = () => {
        closeOrder.push("slot-a");
        sttInstances[1].closeCalls += 1;
        return Promise.reject(new Error("async close fail"));
      };
      sttInstances[2].close = () => {
        closeOrder.push("slot-b");
        sttInstances[2].closeCalls += 1;
        throw new Error("sync close fail");
      };

      closePipeline();
      await delay(20);
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(closeOrder, ["slot-a", "slot-b", "mixed"]);
  assert.deepEqual(unhandled, []);
});

test("suppressGreeting preserves the default-agent switch but skips speech, while the default path still speaks", { concurrency: false }, async () => {
  await withMuxHarness(async ({ pipeline, spoken }) => {
    assert.deepEqual(pipeline._test.switchAgent("other"), { oldId: "caty" });
    assert.equal(pipeline.getSessionUsers().parent, "discord-mux-session-other");

    await pipeline._test.sendGreeting();

    assert.deepEqual(spoken, []);
    assert.equal(pipeline.getSessionUsers().parent, "discord-mux-session-caty");
  }, {
    agents: {
      caty: { wakeWords: ["ケイティ"], voiceId: "voice-id", model: "test-model", greeting: "default greeting" },
      other: { wakeWords: ["シエル"], voiceId: "voice-2", model: "test-model", greeting: "other greeting" },
    },
    selectedAgentIds: ["caty", "other"],
    pipelineOptions: { suppressGreeting: true },
  });

  await withMuxHarness(async ({ pipeline, spoken, session }) => {
    await pipeline._test.sendGreeting();
    assert.deepEqual(spoken, ["default greeting"]);
    assert.equal(session.conversationLog.some((entry) => entry.role === "assistant" && entry.content === "default greeting"), true);
  }, {
    greeting: "fallback greeting",
    pipelineOptions: { suppressGreeting: false },
  });
});
