const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  createLocalAvatarSession,
  getLocalAvatarSession,
  redactLogValue,
} = require("../src/transport-meet/local-avatar-session");

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

test("local avatar capability is 256-bit, audience-bound, short-lived, and revoked on close", () => {
  let now = 1_000;
  const issued = createLocalAvatarSession({
    publicOrigin: "https://meetmate.example",
    now: () => now,
    ttlMs: 50,
  });
  const capabilityBytes = Buffer.from(issued.capability, "base64url");

  assert.equal(capabilityBytes.length, 32);
  assert.equal(issued.launchUrl.startsWith("https://meetmate.example/local-avatar/index.html?v="), true);
  assert.equal(issued.launchUrl.includes(`#cap=${issued.capability}`), true);
  assert.equal(getLocalAvatarSession(issued.session.visualId), issued.session);
  assert.equal(issued.session.verifyCapability(issued.capability), true);
  assert.equal(issued.session.verifyCapability(tamperCapability(issued.capability)), false);
  assert.equal(issued.session.connect({ capability: issued.capability, origin: "https://wrong.example" }), null);

  now += 51;
  assert.equal(issued.session.verifyCapability(issued.capability), false);
  assert.equal(getLocalAvatarSession(issued.session.visualId), null);
  assert.equal(issued.session.close("cancelled"), false);
});

test("local avatar queue, delivery retries, source generations, and reconnect history are bounded", () => {
  const issued = createLocalAvatarSession({
    publicOrigin: "https://meetmate.example",
    queueLimit: 2,
    retryLimit: 2,
  });
  const auth = { capability: issued.capability, origin: "https://meetmate.example" };
  try {
    const connected = issued.session.connect(auth);
    const firstSource = issued.session.beginSource();
    assert.equal(firstSource, 1);
    assert.equal(issued.session.publishMarker(marker(0), firstSource), true);
    assert.equal(issued.session.publishMarker(marker(1), firstSource), true);
    assert.equal(issued.session.publishMarker(marker(2), firstSource), false);
    assert.deepEqual(pick(issued.session.snapshot(), ["queueSize", "queueLimit", "dropped"]), {
      queueSize: 2,
      queueLimit: 2,
      dropped: 1,
    });

    const readArgs = { ...auth, generation: connected.generation, afterSequence: connected.sequence };
    const latest = issued.session.readState(readArgs);
    assert.equal(latest.kind, "marker");
    assert.equal(latest.sampleIndex, 1);
    assert.deepEqual(issued.session.readState(readArgs), latest);
    assert.deepEqual(issued.session.readState(readArgs), latest);
    assert.equal(issued.session.readState(readArgs), undefined);

    const staleSequence = latest.sequence;
    const reconnected = issued.session.connect(auth);
    assert.ok(reconnected.generation > connected.generation);
    assert.equal(reconnected.kind, "idle");
    assert.equal(issued.session.readState({ ...auth, generation: reconnected.generation, afterSequence: -1 }), undefined);
    assert.equal(issued.session.readState({ ...auth, generation: connected.generation, afterSequence: staleSequence }), null);

    const secondSource = issued.session.beginSource();
    assert.equal(issued.session.publishMarker(marker(3), firstSource), false);
    assert.equal(issued.session.publishMarker(marker(0), secondSource), true);
  } finally {
    issued.session.close();
  }
});

test("playback cancel is exactly-once and rejects stale epoch state", () => {
  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const auth = { capability: issued.capability, origin: "https://meetmate.example" };
  try {
    const connected = issued.session.connect(auth);
    const source = issued.session.beginSource();
    assert.equal(issued.session.publishMarker(marker(0), source), true);
    assert.equal(issued.session.cancelPlayback({ outputEpoch: 0 }, source), true);
    const afterCancel = issued.session.snapshot();
    assert.equal(issued.session.cancelPlayback({ outputEpoch: 0 }, source), false);
    assert.equal(issued.session.publishMarker(marker(10), source), false);
    assert.deepEqual(issued.session.snapshot(), afterCancel);

    const state = issued.session.readState({
      ...auth,
      generation: connected.generation,
      afterSequence: connected.sequence,
    });
    assert.equal(state.kind, "cancel");
    assert.equal(state.cancelEpoch, afterCancel.cancelEpoch);
    assert.equal(state.outputEpoch, 0);
  } finally {
    issued.session.close();
  }
});

test("local avatar logs redact capability-shaped values", () => {
  const value = redactLogValue({
    authorization: "Bearer secret",
    url: "https://meetmate.example/local-avatar/index.html#cap=secret",
    nested: { capability: "secret" },
  });
  assert.equal(JSON.stringify(value).includes("secret"), false);

  const logs = [];
  const issued = createLocalAvatarSession({
    publicOrigin: "https://meetmate.example",
    logger: { info: (...args) => logs.push(args) },
  });
  issued.session.verifyCapability(tamperCapability(issued.capability));
  issued.session.close();
  assert.equal(JSON.stringify(logs).includes(issued.capability), false);
});

test("capability mismatch uses the constant-time comparison path", { concurrency: false }, () => {
  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const original = crypto.timingSafeEqual;
  let comparisons = 0;
  crypto.timingSafeEqual = (...args) => {
    comparisons += 1;
    return original(...args);
  };
  try {
    assert.equal(issued.session.verifyCapability(tamperCapability(issued.capability)), false);
    assert.equal(comparisons, 1);
  } finally {
    crypto.timingSafeEqual = original;
    issued.session.close();
  }
});

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

test("a foreign controller cannot abort playback or advance outputEpoch", { concurrency: false }, async () => {
  const observed = [];
  await withPipeline({ llm: { streamChat: waitForAbortStream } }, async ({ pipeline }) => {
    const events = collectCancellationEvents(pipeline);
    const processing = pipeline._test.processUserInput("controller identity");
    await waitUntil(() => pipeline._test.getCurrentAbortController());
    const active = pipeline._test.getCurrentAbortController();
    const foreign = new AbortController();

    assert.equal(pipeline._test.abortPlayback(foreign, "external_abort"), false);
    assert.equal(foreign.signal.aborted, false);
    assert.equal(active.signal.aborted, false);
    assert.deepEqual(events, []);

    assert.equal(pipeline._test.abortCurrent(), true);
    assertCancellation(events, "external_abort", 0);
    observed.push(...events);
    await processing;
  });
  assert.equal(observed.length, 1);
});

test("lead, gap, and purpose silence preserve contiguous metadata", { concurrency: false }, async () => {
  const observed = [];
  let value = 1;
  await withPipeline({
    env: { TTS_LEAD_MS: "1", TTS_GAP_MS: "1", SENTENCE_PAUSE_MS: "2" },
    config: { greeting: "挨拶。", purposeStatement: "目的。" },
    synthesize: async (_text, { onAudio }) => {
      onAudio(Buffer.from([value, 0, value, 0]));
      value += 1;
    },
    onAudio: (buffer, metadata) => observed.push({ bytes: buffer.length, metadata: { ...metadata } }),
  }, async ({ pipeline }) => {
    await pipeline._test.sendGreeting();
  });

  assert.deepEqual(observed, [
    audioObservation(48, 0),
    audioObservation(4, 24),
    audioObservation(96, 26),
    audioObservation(48, 74),
    audioObservation(4, 98),
  ]);
});

test("sentence-boundary silence preserves contiguous metadata", { concurrency: false }, async () => {
  const observed = [];
  await withPipeline({
    env: { SENTENCE_PAUSE_MS: "2" },
    llm: {
      streamChat: async function* () {
        yield "これは十分に長い第一文です。";
        yield "これは十分に長い第二文です。";
      },
    },
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.from([1, 0])),
    onAudio: (buffer, metadata) => observed.push({ bytes: buffer.length, metadata: { ...metadata } }),
  }, async ({ pipeline }) => {
    await pipeline._test.processUserInput("二つの文を話して");
  });

  assert.deepEqual(observed, [
    audioObservation(2, 0),
    audioObservation(96, 1),
    audioObservation(2, 49),
  ]);
});

test("TTS-cache playback and ack silence preserve contiguous metadata", { concurrency: false }, async () => {
  const observed = [];
  let cachedCalls = 0;
  let rawCalls = 0;
  await withPipeline({
    exposeInternals: false,
    env: { ENABLE_IMMEDIATE_ACK: "true", SENTENCE_PAUSE_MS: "2" },
    config: { ackVariants: ["はい。"] },
    llm: { streamChat: async function* () {} },
    synthesize: async () => { rawCalls += 1; },
    ttsCache: {
      createTtsCache: () => ({
        synthesize: async (_text, { onAudio }) => {
          cachedCalls += 1;
          onAudio(Buffer.from([1, 0]));
          onAudio(Buffer.from([2, 0, 3, 0]));
        },
        prewarm: async () => {},
      }),
    },
    onAudio: (buffer, metadata) => observed.push({ bytes: buffer.length, metadata: { ...metadata } }),
  }, async ({ pipeline, stt }) => {
    stt.emit("utterance_end", "ケイティ、確認して");
    await waitUntil(() => observed.length >= 3);
    pipeline.close();
  });

  assert.equal(cachedCalls, 1);
  assert.equal(rawCalls, 0);
  assert.deepEqual(observed.slice(0, 3), [
    audioObservation(2, 0),
    audioObservation(4, 1),
    audioObservation(96, 3),
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

function audioObservation(bytes, firstSampleIndex) {
  return {
    bytes,
    metadata: {
      outputEpoch: 0,
      firstSampleIndex,
      sampleRate: fixture.pcm.sampleRate,
    },
  };
}

function marker(firstSampleIndex, outputEpoch = 0) {
  return { outputEpoch, firstSampleIndex, sampleRate: fixture.pcm.sampleRate };
}

function tamperCapability(value) {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
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
  const restoreEnv = setEnv({ ...QUIET_ENV, ...(overrides.env || {}) });
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const src = path.join(__dirname, "..", "src");
  const modulePaths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "tts-cache.js", "pipeline.js"]
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
  if (overrides.ttsCache) installMock(path.join(src, "tts-cache.js"), overrides.ttsCache);

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
      _testExposeInternals: overrides.exposeInternals !== false,
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
