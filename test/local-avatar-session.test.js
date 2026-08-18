const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "local-avatar-timeline.json"), "utf8"));

const QUIET_ENV = {
  WAKE_WORDS: "ケイティ",
  POST_UTTERANCE_BUFFER_MS: "0",
  ENABLE_IMMEDIATE_ACK: "false",
  ENABLE_PROGRESS_GUARD: "false",
  TTS_LEAD_MS: "0",
  TTS_GAP_MS: "0",
  SENTENCE_PAUSE_MS: "0",
  CLAUSE_PAUSE_MS: "0",
  TTS_CACHE_PREWARM: "false",
  METRICS_DISABLED: "1",
};

test("24 kHz S16LE metadata is continuous and chunk-boundary independent", { concurrency: false }, async () => {
  const pcm = Buffer.from(fixture.pcm.base64, "base64");
  const traces = [];

  for (const chunking of fixture.pcm.chunkings) {
    const chunks = splitPcmBySamples(pcm, chunking);
    const observed = [];

    await withPipeline({
      llm: {
        streamChat: async function* () {
          yield "これは十分に長いテスト文章です。";
        },
      },
      synthesize: async (_text, { onAudio }) => {
        for (const chunk of chunks) onAudio(chunk);
      },
      onAudio: (buffer, metadata) => observed.push({ buffer: Buffer.from(buffer), metadata: { ...metadata } }),
    }, async ({ pipeline }) => {
      await pipeline._test.processUserInput("fixture PCMを再生して");
    });

    assert.deepEqual(Buffer.concat(observed.map(({ buffer }) => buffer)), pcm);
    assert.equal(observed.reduce((total, item) => total + item.buffer.length, 0), fixture.pcm.byteCount);
    assert.deepEqual(observed.map(({ metadata }) => metadata.outputEpoch), Array(observed.length).fill(0));
    assert.deepEqual(observed.map(({ metadata }) => metadata.sampleRate), Array(observed.length).fill(fixture.pcm.sampleRate));

    let expectedFirstSample = 0;
    for (const item of observed) {
      assert.equal(item.metadata.firstSampleIndex, expectedFirstSample);
      expectedFirstSample += item.buffer.length / 2;
    }
    assert.equal(expectedFirstSample, fixture.pcm.samples.length);
    traces.push(expandSampleTrace(observed));
  }

  assert.deepEqual(traces[0], traces[1]);
  assert.deepEqual(traces[0], fixture.pcm.samples.map((sample, sampleIndex) => ({
    outputEpoch: 0,
    sampleIndex,
    sample,
  })));
});

test("greeting and turn audio retain their serialized order in one epoch", { concurrency: false }, async () => {
  const spoken = [];
  const observed = [];
  await withPipeline({
    config: { greeting: "固定された挨拶。" },
    llm: {
      streamChat: async function* () {
        yield "固定された応答文章です。";
      },
    },
    synthesize: async (text, { onAudio }) => {
      spoken.push(text);
      onAudio(Buffer.from([spoken.length, 0]));
    },
    onAudio: (buffer, metadata) => observed.push({ hex: buffer.toString("hex"), metadata: { ...metadata } }),
  }, async ({ pipeline, session }) => {
    await pipeline._test.sendGreeting();
    await pipeline._test.processUserInput("固定された依頼");
    assert.deepEqual(session.conversationLog.map(({ role, content }) => ({ role, content })), [
      { role: "assistant", content: "固定された挨拶。" },
      { role: "assistant", content: "固定された応答文章です。" },
    ]);
  });

  assert.deepEqual(spoken, ["固定された挨拶。", "固定された応答文章です。"]);
  assert.deepEqual(observed, [
    { hex: "0100", metadata: { outputEpoch: 0, firstSampleIndex: 0, sampleRate: fixture.pcm.sampleRate } },
    { hex: "0200", metadata: { outputEpoch: 0, firstSampleIndex: 1, sampleRate: fixture.pcm.sampleRate } },
  ]);
});

test("a cancellation advances the epoch and resets its sample coordinate", { concurrency: false }, async () => {
  let synthesisCount = 0;
  const observed = [];
  await withPipeline({
    llm: {
      streamChat: async function* () {
        yield "これは十分に長いテスト文章です。";
      },
    },
    synthesize: async (_text, { onAudio, signal }) => {
      synthesisCount += 1;
      onAudio(Buffer.from([synthesisCount, 0, synthesisCount, 0]));
      if (synthesisCount === 1) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
    },
    onAudio: (buffer, metadata) => observed.push({ hex: buffer.toString("hex"), metadata: { ...metadata } }),
  }, async ({ pipeline }) => {
    const events = collectCancellationEvents(pipeline);
    const first = pipeline._test.processUserInput("最初のepoch");
    await waitUntil(() => observed.length === 1);
    const staleController = pipeline._test.getCurrentAbortController();
    pipeline._test.abortCurrent();
    await first;

    await pipeline._test.processUserInput("次のepoch");
    staleController.abort();
    assert.equal(events.length, 1);
  });

  assert.deepEqual(observed, [
    { hex: "01000100", metadata: { outputEpoch: 0, firstSampleIndex: 0, sampleRate: fixture.pcm.sampleRate } },
    { hex: "02000200", metadata: { outputEpoch: 1, firstSampleIndex: 0, sampleRate: fixture.pcm.sampleRate } },
  ]);
});

test("wake+cancel emits synchronously and exactly once", { concurrency: false }, async () => {
  await withPipeline({ llm: { streamChat: waitForAbortStream } }, async ({ pipeline, stt }) => {
    const events = collectCancellationEvents(pipeline);
    const processing = pipeline._test.processUserInput("長時間の処理");
    await waitUntil(() => pipeline._test.getCurrentAbortController());

    stt.emit("utterance_end", "ケイティ、ストップ");
    assertCancellation(events, "wake_cancel", 0);
    await processing;
  });
});

test("interim barge-in emits synchronously and exactly once", { concurrency: false }, async () => {
  await withPipeline({
    config: { greeting: "こんにちは。" },
    synthesize: abortableSynthesize,
  }, async ({ pipeline, stt, turnState }) => {
    const events = collectCancellationEvents(pipeline);
    const greeting = pipeline._test.sendGreeting();
    await waitUntil(() => turnState.isAgentSpeaking);

    stt.emit("transcript", "割り込みます", false, 0.99);
    assertCancellation(events, "barge_in", 0);
    stt.emit("transcript", "もう一度", false, 0.99);
    assert.equal(events.length, 1);
    await greeting;
  });
});

test("finalized turn interruption emits synchronously and exactly once", { concurrency: false }, async () => {
  let synthesizeCalls = 0;
  await withPipeline({
    config: { greeting: "こんにちは。" },
    synthesize: async (...args) => {
      synthesizeCalls += 1;
      if (synthesizeCalls === 1) return abortableSynthesize(...args);
      args[1].onAudio(Buffer.from([3, 0, 4, 0]));
    },
  }, async ({ pipeline, turnState }) => {
    const events = collectCancellationEvents(pipeline);
    const greeting = pipeline._test.sendGreeting();
    await waitUntil(() => turnState.isAgentSpeaking);

    const nextTurn = pipeline._test.handleUtteranceEnd("ケイティ、次の依頼です");
    assertCancellation(events, "turn_interrupted", 0);
    pipeline.close();
    await Promise.all([greeting, nextTurn]);
    assert.equal(events.filter((event) => event.reason === "turn_interrupted").length, 1);
  });
});

test("LLM response timeout emits once from its timer abort", { concurrency: false }, async () => {
  await withPipeline({
    config: { llm: { responseTimeoutMs: 5, firstTokenDelegateMs: 0 } },
    llm: { streamChat: waitForAbortStream },
  }, async ({ pipeline }) => {
    const events = collectCancellationEvents(pipeline);
    await pipeline._test.processUserInput("応答待ち");
    assertCancellation(events, "llm_response_timeout", 0);
  });
});

test("first-token delegation emits once from its timer abort", { concurrency: false }, async () => {
  await withPipeline({
    config: { llm: { responseTimeoutMs: 0, firstTokenDelegateMs: 5 } },
    llm: { streamChat: waitForAbortStream },
  }, async ({ pipeline }) => {
    const events = collectCancellationEvents(pipeline);
    await pipeline._test.processUserInput("委譲待ち");
    assertCancellation(events, "first_token_delegation", 0);
  });
});

test("pipeline close and external abort are synchronous, exactly once, and stale-safe", { concurrency: false }, async () => {
  await withPipeline({ llm: { streamChat: waitForAbortStream } }, async ({ pipeline }) => {
    const events = collectCancellationEvents(pipeline);
    const first = pipeline._test.processUserInput("外部停止");
    await waitUntil(() => pipeline._test.getCurrentAbortController());
    const staleController = pipeline._test.getCurrentAbortController();

    assert.equal(pipeline._test.abortCurrent(), true);
    assertCancellation(events, "external_abort", 0);
    assert.equal(pipeline._test.abortCurrent(), false);
    staleController.abort();
    assert.equal(events.length, 1);
    await first;

    const second = pipeline._test.processUserInput("終了停止");
    await waitUntil(() => pipeline._test.getCurrentAbortController() !== staleController);
    pipeline.close();
    assertCancellation(events, "pipeline_close", 1, 2);
    assert.ok(events[1].monotonicTime >= events[0].monotonicTime);
    staleController.abort();
    assert.equal(events.length, 2);
    await second;
  });
});

test("missing and throwing observers preserve audio and abort ordering", { concurrency: false }, async () => {
  const withoutObserver = await runObserverRobustnessScenario(false);
  const withThrowingObserver = await runObserverRobustnessScenario(true);

  assert.deepEqual(withoutObserver.coreOrder, ["audio", "signal-aborted", "after-abort-call"]);
  assert.deepEqual(withThrowingObserver.coreOrder, withoutObserver.coreOrder);
  assert.deepEqual(withThrowingObserver.fullOrder, ["audio", "signal-aborted", "observer", "after-abort-call"]);
  assert.deepEqual(withThrowingObserver.audio, withoutObserver.audio);
});

test("every playback-authoritative abort call site uses the reasoned wrapper", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "pipeline.js"), "utf8");
  const reasons = [...source.matchAll(/abortPlayback\([^,]+, "([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(reasons.sort(), [
    "barge_in",
    "external_abort",
    "first_token_delegation",
    "llm_response_timeout",
    "pipeline_close",
    "turn_interrupted",
    "wake_cancel",
  ]);
  assert.deepEqual([...source.matchAll(/\b(?:currentAbort|abort)\.abort\(\)/g)].map((match) => match[0]), []);
});

async function runObserverRobustnessScenario(throwingObserver) {
  const fullOrder = [];
  const audio = [];
  await withPipeline({
    llm: {
      streamChat: async function* (_messages, { signal }) {
        yield "これは十分に長いテスト文章です。";
        await new Promise((resolve) => signal.addEventListener("abort", () => {
          fullOrder.push("signal-aborted");
          resolve();
        }, { once: true }));
      },
    },
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.from([1, 0, 2, 0])),
    onAudio: (buffer) => {
      fullOrder.push("audio");
      audio.push(buffer.toString("hex"));
    },
  }, async ({ pipeline }) => {
    if (throwingObserver) {
      pipeline.on("playback_cancelled", () => {
        fullOrder.push("observer");
        throw new Error("observer failure");
      });
    }
    const processing = pipeline._test.processUserInput("順序を確認");
    await waitUntil(() => fullOrder.includes("audio"));
    pipeline._test.abortCurrent();
    fullOrder.push("after-abort-call");
    await processing;
  });
  return {
    fullOrder,
    coreOrder: fullOrder.filter((item) => item !== "observer"),
    audio,
  };
}

async function* waitForAbortStream(_messages, { signal }) {
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

async function abortableSynthesize(_text, { signal, onAudio }) {
  onAudio(Buffer.from([1, 0, 2, 0]));
  if (!signal || signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

function collectCancellationEvents(pipeline) {
  const events = [];
  pipeline.on("playback_cancelled", (event) => events.push(event));
  return events;
}

function assertCancellation(events, reason, outputEpoch, length = 1) {
  assert.equal(events.length, length);
  const event = events.at(-1);
  assert.equal(event.reason, reason);
  assert.equal(event.outputEpoch, outputEpoch);
  assert.equal(Number.isFinite(event.monotonicTime), true);
  assert.ok(event.monotonicTime >= 0);
  assert.deepEqual(Object.keys(event).sort(), ["monotonicTime", "outputEpoch", "reason"]);
}

function splitPcmBySamples(buffer, sampleCounts) {
  const chunks = [];
  let byteOffset = 0;
  for (const samples of sampleCounts) {
    const byteLength = samples * 2;
    chunks.push(buffer.subarray(byteOffset, byteOffset + byteLength));
    byteOffset += byteLength;
  }
  assert.equal(byteOffset, buffer.length);
  return chunks;
}

function expandSampleTrace(observed) {
  const trace = [];
  for (const { buffer, metadata } of observed) {
    for (let offset = 0; offset < buffer.length; offset += 2) {
      trace.push({
        outputEpoch: metadata.outputEpoch,
        sampleIndex: metadata.firstSampleIndex + offset / 2,
        sample: buffer.readInt16LE(offset),
      });
    }
  }
  return trace;
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for pipeline state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withPipeline(overrides, fn) {
  const restoreEnv = setEnv(QUIET_ENV);
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const src = path.join(__dirname, "..", "src");
  const modulePaths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((file) => path.join(src, file));
  const previousCache = new Map(modulePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of modulePaths) delete require.cache[require.resolve(file)];

  const stt = new EventEmitter();
  stt.send = () => {};
  stt.close = () => {};
  const sttExports = { createSTT: () => stt, buildKeyterms: () => [] };
  const llm = {
    streamChat: async function* () {},
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
    ...(overrides.llm || {}),
  };
  installMock(path.join(src, "stt-provider.js"), sttExports);
  installMock(path.join(src, "stt.js"), sttExports);
  installMock(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({ name: overrides.providerName || "openclaw", ...llm }),
  });
  installMock(path.join(src, "tts-fish.js"), {
    synthesize: overrides.synthesize || (async (_text, { onAudio }) => onAudio(Buffer.alloc(4))),
  });

  let pipeline;
  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = { id: "local-avatar-m0", conversationLog: [], config: { wakeMode: "wake" } };
    const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
    const baseConfig = {
      dgKey: "test",
      fishKey: "test",
      stt: { provider: "soniox", model: "stt-test", language: "ja", sampleRate: 16_000 },
      llm: {
        provider: "openclaw",
        model: "llm-test",
        temperature: 0,
        maxTokens: 100,
        responseTimeoutMs: 0,
        firstTokenDelegateMs: 0,
      },
      tts: { referenceId: null, sampleRate: fixture.pcm.sampleRate, latency: "balanced", speed: 1 },
      greeting: "",
      cancelAck: "",
      echoCooldownMs: 1,
      exitDetection: false,
      gatewayEvents: { enabled: false },
    };
    const config = mergeConfig(baseConfig, overrides.config || {});
    pipeline = createPipeline(session, turnState, overrides.onAudio || (() => {}), config, {
      agents: { caty: { wakeWords: ["ケイティ"] } },
      selectedAgentIds: ["caty"],
      defaultAgentId: "caty",
      _testExposeInternals: true,
    });
    await fn({ pipeline, session, stt, turnState });
  } finally {
    try { pipeline?.close(); } catch { /* test cleanup */ }
    for (const file of modulePaths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    restoreEnv();
    Object.assign(console, originalConsole);
  }
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    stt: { ...base.stt, ...(override.stt || {}) },
    llm: { ...base.llm, ...(override.llm || {}) },
    tts: { ...base.tts, ...(override.tts || {}) },
  };
}

function installMock(filename, exports) {
  require.cache[require.resolve(filename)] = {
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
