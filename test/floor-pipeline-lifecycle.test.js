"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTimers {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(fn, delay = 0) {
    const handle = { id: this.nextId++, unref() {} };
    this.tasks.set(handle.id, { at: this.now + Number(delay), fn, handle });
    return handle;
  }

  clearTimeout(handle) {
    this.tasks.delete(handle?.id ?? handle);
  }

  tick(ms) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.values()]
        .filter((task) => task.at <= target)
        .sort((left, right) => left.at - right.at || left.handle.id - right.handle.id)[0];
      if (!next) break;
      this.tasks.delete(next.handle.id);
      this.now = next.at;
      next.fn();
    }
    this.now = target;
  }

  runAll() {
    while (this.tasks.size > 0) {
      const nextAt = Math.min(...[...this.tasks.values()].map((task) => task.at));
      this.tick(nextAt - this.now);
    }
  }
}

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

function createFloor(overrides = {}) {
  const floor = Object.assign(new EventEmitter(), {
    state: "READY",
    memberId: "m1",
    connectionEpoch: 1,
    members: [{ memberId: "m1", displayName: "Caty", wakeWords: ["ケイティ"] }],
    grant: null,
    nextRound: 0,
    speechEvents: [],
    releases: [],
    connect() {},
    close() {},
    claimAssignment() { return null; },
    waitForReady: async () => true,
    remainingReadyGraceMs: () => 15_000,
    fallbackDelayMs: () => 20,
    hasActivePeerSpeech: () => false,
    hasUnsettledReports: () => false,
    reportWake: async () => ({
      kind: "assigned",
      assignment: { roundId: `r${++floor.nextRound}`, memberId: "m1" },
    }),
    reportText: async () => ({ kind: "empty" }),
    async acquire(roundId) {
      floor.grant = { grantId: `g-${roundId}`, roundId, connectionEpoch: 1 };
      floor.state = "HELD";
      return { ...floor.grant };
    },
    fence() { return floor.grant ? { ...floor.grant } : null; },
    isFenceCurrent(fence) {
      return Boolean(floor.grant && fence?.grantId === floor.grant.grantId && floor.state === "HELD");
    },
    speech(phase, tailMs) {
      floor.speechEvents.push({ phase, tailMs, at: Date.now() });
      return true;
    },
    release(cause) {
      floor.releases.push({ cause, at: Date.now(), grantId: floor.grant?.grantId });
      floor.grant = null;
      floor.state = "READY";
      return true;
    },
  }, overrides);
  return floor;
}

async function createHarness({ floor = createFloor(), synthesize, streamChat, timers, config: configOverrides = {} } = {}) {
  const previousEnv = Object.fromEntries([
    "ENABLE_IMMEDIATE_ACK", "ENABLE_PROGRESS_GUARD", "POST_UTTERANCE_BUFFER_MS",
    "TTS_GAP_MS", "TTS_LEAD_MS", "SENTENCE_PAUSE_MS",
  ].map((key) => [key, process.env[key]]));
  process.env.ENABLE_IMMEDIATE_ACK = "false";
  process.env.ENABLE_PROGRESS_GUARD = "false";
  process.env.POST_UTTERANCE_BUFFER_MS = "0";
  process.env.TTS_GAP_MS = "0";
  process.env.TTS_LEAD_MS = "0";
  process.env.SENTENCE_PAUSE_MS = "0";

  const src = path.join(__dirname, "..", "src");
  const paths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(paths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of paths) delete require.cache[require.resolve(file)];

  const stt = Object.assign(new EventEmitter(), { send() {}, close() {} });
  const sttExports = { createSTT: () => stt, buildKeyterms: () => [] };
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      streamChat: streamChat || (async function* () { yield "回答です。"; }),
    }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: synthesize || (async (_text, { onAudio }) => onAudio(Buffer.alloc(320, 1))),
  });

  const audio = [];
  const session = { id: "floor-lifecycle", conversationLog: [], config: { wakeMode: "wake" } };
  const config = {
    dgKey: "x", fishKey: "x",
    stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
    llm: { provider: "openclaw", model: "test", responseTimeoutMs: 0, firstTokenDelegateMs: 0 },
    tts: { provider: "fish-audio", sampleRate: 16_000, speed: 1, latency: "balanced" },
    hub: { enabled: true, url: "ws://fake", roomCode: "race", authToken: "x", tailMs: 20 },
    gatewayEvents: { enabled: false },
    greeting: "", echoCooldownMs: 0,
    ...configOverrides,
  };
  const { createPipeline } = require(path.join(src, "pipeline.js"));
  const turnState = {
    isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0,
  };
  const pipeline = createPipeline(session, turnState,
    (buffer) => audio.push({ buffer: Buffer.from(buffer), at: Date.now() }), config, {
    agents: { caty: { wakeWords: ["ケイティ"] } },
    selectedAgentIds: ["caty"],
    defaultAgentId: "caty",
    floorClient: floor,
    timers,
    _testExposeInternals: true,
  });
  const previousConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  return {
    pipeline, floor, audio, session, stt, turnState,
    cleanup() {
      pipeline.close();
      console.log = previousConsole.log;
      console.warn = previousConsole.warn;
      console.error = previousConsole.error;
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
    },
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function settleWithMockTimers(promise, mockTimers) {
  let outcome = null;
  promise.then(
    (value) => { outcome = { value }; },
    (error) => { outcome = { error }; },
  );
  for (let i = 0; i < 30 && outcome === null; i += 1) {
    await flushMicrotasks(2);
    mockTimers.runAll();
  }
  if (outcome === null) assert.fail("promise did not settle under fake timers");
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

test("A3 releases after projected playback plus tail, not cumulative PCM", async () => {
  const floor = createFloor();
  const harness = await createHarness({
    floor,
    synthesize: async (_text, { onAudio }) => {
      onAudio(Buffer.alloc(1_600, 1)); // 50ms PCM
      await sleep(100); // delivery finishes after projected playback has elapsed
    },
  });
  try {
    await harness.pipeline._test.speakSentence("slow delivery", null);
    const finishStartedAt = Date.now();
    await harness.pipeline._test.finishFloorSpeech("a3");
    const releaseDelay = floor.releases[0].at - finishStartedAt;
    assert.equal(releaseDelay >= 15 && releaseDelay < 45, true, `release delay=${releaseDelay}ms`);
  } finally {
    harness.cleanup();
  }
});

test("A4 losing a grant resets speech lifecycle before the next turn", async () => {
  const floor = createFloor();
  let synthesis = 0;
  const harness = await createHarness({
    floor,
    synthesize: async (_text, { onAudio }) => {
      synthesis += 1;
      onAudio(Buffer.alloc(synthesis === 1 ? 1_600 : 320, 1));
      if (synthesis === 1) {
        floor.grant = null;
        floor.state = "READY";
      }
    },
  });
  try {
    await harness.pipeline._test.speakSentence("revoked", null);
    await harness.pipeline._test.finishFloorSpeech("revoked");
    assert.deepEqual(harness.pipeline._test.getFloorSpeechLifecycle(), {
      fallbackActive: false, pcmMs: 0, speechStarted: false,
    });

    await harness.pipeline._test.speakSentence("next", null);
    assert.equal(Math.round(harness.pipeline._test.getFloorSpeechLifecycle().pcmMs), 10);
    assert.equal(floor.speechEvents.filter((event) => event.phase === "started").length, 2);
    await harness.pipeline._test.finishFloorSpeech("next");
    assert.equal(floor.releases.at(-1).cause, "next");
  } finally {
    harness.cleanup();
  }
});

test("A5 report voice always finishes and releases its floor grant", async () => {
  const floor = createFloor();
  const harness = await createHarness({
    floor,
    config: {
      gatewayEvents: { enabled: true, reportVoiceEnabled: true, reportVoiceGapMs: 0 },
    },
  });
  try {
    harness.pipeline._test.enqueueReportVoiceLine("レポート完了です。");
    const deadline = Date.now() + 500;
    while (floor.releases.length === 0 && Date.now() < deadline) await sleep(10);
    assert.equal(floor.releases.at(-1)?.cause, "report");
    assert.equal(floor.grant, null);
  } finally {
    harness.cleanup();
  }
});

test("A2 cancelled timeout fallback stays fenced and releases the next assigned grant", async () => {
  const timers = new FakeTimers();
  let fallbackCancel = null;
  let reportMode = "timeout";
  const floor = createFloor({
    fallbackDelayMs: () => 500,
    reportText(_text, options) {
      fallbackCancel = options.onFallbackCancel;
      return Promise.resolve(reportMode === "timeout"
        ? { kind: "verdict_timeout" }
        : { kind: "assigned", assignment: { roundId: "r-next", memberId: "m1" } });
    },
  });
  const harness = await createHarness({ floor, timers });
  try {
    harness.stt.emit("utterance_end", "ケイティ、取消競合");
    await flushMicrotasks();
    fallbackCancel({ roundId: "r-other", memberId: "m2" });
    timers.tick(499);
    await flushMicrotasks();
    assert.equal(harness.audio.length, 0);
    timers.tick(1);
    for (let i = 0; i < 10; i += 1) await flushMicrotasks(2);
    assert.equal(harness.pipeline._test.getFloorSpeechLifecycle().fallbackActive, false);
    assert.equal(harness.pipeline._test.getGateState(), "OPEN");

    reportMode = "assigned";
    harness.stt.emit("utterance_end", "ケイティ、次の正規ターン");
    for (let i = 0; i < 30 && floor.releases.length === 0; i += 1) {
      await flushMicrotasks(2);
      timers.runAll();
    }
    assert.equal(harness.audio.length > 0, true);
    assert.equal(floor.releases.at(-1)?.grantId, "g-r-next");

  } finally {
    harness.cleanup();
  }
});

test("pipeline timeout before the client timer still lets a late peer assignment stop fallback PCM", async () => {
  const timers = new FakeTimers();
  let fallbackCancel = null;
  let synthesisStarted;
  let continueSynthesis;
  const started = new Promise((resolve) => { synthesisStarted = resolve; });
  const synthesisGate = new Promise((resolve) => { continueSynthesis = resolve; });
  const floor = createFloor({
    verdictTimeoutMs: 10,
    fallbackDelayMs: () => 0,
    reportWake(_hits, options) {
      fallbackCancel = options.onFallbackCancel;
      return new Promise(() => {});
    },
  });
  const harness = await createHarness({
    floor,
    timers,
    synthesize: async (_text, { onAudio }) => {
      onAudio(Buffer.alloc(320, 1));
      synthesisStarted();
      await synthesisGate;
      onAudio(Buffer.alloc(320, 2));
    },
  });
  try {
    const speaking = harness.pipeline._test.speakSentence("遅延割当競合", null);
    await flushMicrotasks();
    timers.tick(109);
    await flushMicrotasks();
    assert.equal(harness.audio.length, 0);
    timers.tick(1);
    await started;
    assert.equal(harness.audio.length, 1);
    assert.equal(harness.pipeline._test.getFloorSpeechLifecycle().fallbackActive, true);

    fallbackCancel({ roundId: "r-peer", memberId: "m2" });
    assert.equal(harness.pipeline._test.getFloorSpeechLifecycle().fallbackActive, false);
    continueSynthesis();
    await speaking;
    assert.equal(harness.audio.length, 1);
  } finally {
    continueSynthesis?.();
    harness.cleanup();
  }
});

test("A9 verdict timeout fallback waits for jitter before its first PCM", async () => {
  const timers = new FakeTimers();
  const harness = await createHarness({ floor: createFloor({ fallbackDelayMs: () => 500 }), timers });
  try {
    const fallback = harness.pipeline._test.handleUtteranceEnd("ケイティ、タイムアウト", null, {
      cancelled: false,
      verdictPromise: Promise.resolve({ kind: "verdict_timeout" }),
    });
    await flushMicrotasks();
    timers.tick(499);
    await flushMicrotasks();
    assert.equal(harness.audio.length, 0);
    timers.tick(1);
    await settleWithMockTimers(fallback, timers);
    assert.equal(harness.audio.length > 0, true);
  } finally {
    harness.cleanup();
  }
});

test("A9 empty ballot utterance reopens immediately without entering the LLM", async () => {
  const harness = await createHarness();
  try {
    await Promise.race([
      harness.pipeline._test.handleUtteranceEnd("誰も呼んでいない", null, {
        cancelled: false,
        verdictPromise: Promise.resolve({ kind: "empty" }),
      }),
      sleep(100).then(() => assert.fail("empty ballot waited for verdict timeout")),
    ]);
    assert.equal(harness.pipeline._test.getGateState(), "OPEN");
    assert.equal(harness.audio.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("A13 floor-exempt padding is digital zero when no current fence exists", async () => {
  const harness = await createHarness();
  try {
    harness.pipeline._test.deliverAudio(Buffer.alloc(32, 7), null, { floorExempt: true });
    assert.equal(harness.audio.length, 1);
    assert.equal(harness.audio[0].buffer.equals(Buffer.alloc(32)), true);
  } finally {
    harness.cleanup();
  }
});

test("A14 abort abandons readiness and report waits without poisoning a later turn", async () => {
  let reportOptions = null;
  let reportMode = "pending";
  let synthStarted;
  let continueSynthesis;
  const synthesisStarted = new Promise((resolve) => { synthStarted = resolve; });
  const synthesisGate = new Promise((resolve) => { continueSynthesis = resolve; });
  const floor = createFloor({
    reportWake(hits, options) {
      if (reportMode === "pending") {
        reportOptions = options;
        return new Promise(() => {});
      }
      return Promise.resolve({ kind: "assigned", assignment: { roundId: "r-later", memberId: "m1" } });
    },
  });
  const harness = await createHarness({
    floor,
    synthesize: async (_text, { onAudio }) => {
      synthStarted();
      await synthesisGate;
      onAudio(Buffer.alloc(320, 1));
    },
  });
  try {
    floor.waitForReady = () => new Promise(() => {});
    const readyAbort = new AbortController();
    const readyWait = harness.pipeline._test.acquireFloorPermission("greeting", readyAbort.signal);
    readyAbort.abort();
    assert.equal(await readyWait, null);

    floor.waitForReady = async () => true;
    const reportAbort = new AbortController();
    const reportWait = harness.pipeline._test.acquireFloorPermission("greeting", reportAbort.signal);
    await flushMicrotasks();
    reportAbort.abort();
    assert.equal(await reportWait, null);
    assert.equal(harness.pipeline._test.getFloorSpeechLifecycle().fallbackActive, false);

    reportMode = "assigned";
    const later = harness.pipeline._test.speakSentence("later", null);
    await synthesisStarted;
    reportOptions.onFallbackCancel({ roundId: "r-stale", memberId: "m2" });
    continueSynthesis();
    await later;
    assert.equal(harness.audio.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("A1 speech acquisition bounds readiness to the remaining grace window", async () => {
  const timers = new FakeTimers();
  const floor = createFloor({
    waitForReady: () => new Promise(() => {}),
    remainingReadyGraceMs: () => 250,
    fallbackDelayMs: () => 20,
  });
  const harness = await createHarness({ floor, timers });
  try {
    const waiting = harness.pipeline._test.acquireFloorPermission("greeting");
    let settled = false;
    waiting.finally(() => { settled = true; });
    timers.tick(249);
    await flushMicrotasks();
    assert.equal(settled, false);
    timers.tick(1);
    await flushMicrotasks();
    timers.tick(20);
    await flushMicrotasks();
    assert.equal(settled, true);
    assert.equal(harness.pipeline._test.getFloorSpeechLifecycle().fallbackActive, true);
  } finally {
    harness.cleanup();
  }
});

test("R1 synthetic self-ballot waits while peer speech or own reports are active", async () => {
  const timers = new FakeTimers();
  let reportAt = null;
  const floor = createFloor({
    now: () => timers.now,
    hasActivePeerSpeech: () => timers.now < 70,
    hasUnsettledReports: () => timers.now < 130,
    reportWake: async () => {
      reportAt = timers.now;
      return { kind: "assigned", assignment: { roundId: "r-r1", memberId: "m1" } };
    },
  });
  const harness = await createHarness({ floor, timers });
  try {
    await settleWithMockTimers(harness.pipeline._test.acquireFloorPermission("greeting"), timers);
    assert.equal(reportAt >= 130, true, `self ballot sent at injected time ${reportAt}ms`);
  } finally {
    harness.cleanup();
  }
});

test("A7 non-floor exit waits for grace and preserves farewell logging order", async () => {
  const timers = new FakeTimers();
  let unblockLlm;
  let llmCalls = 0;
  let farewellWasLoggedDuringSynthesis = null;
  let harness;
  const llmGate = new Promise((resolve) => { unblockLlm = resolve; });
  harness = await createHarness({
    timers,
    streamChat: async function* () {
      llmCalls += 1;
      await llmGate;
      yield "seed complete。";
    },
    synthesize: async (text, { onAudio }) => {
      if (text.includes("さようなら")) {
        farewellWasLoggedDuringSynthesis = harness.session.conversationLog
          .some((entry) => entry.content === "さようなら。");
        throw new Error("farewell tts unavailable");
      }
      onAudio(Buffer.alloc(320, 1));
    },
    config: {
      hub: { enabled: false },
      exitFarewell: "さようなら。",
    },
  });
  try {
    const seed = harness.pipeline._test.processUserInput("seed");
    await flushMicrotasks();
    await harness.pipeline._test.handleUtteranceEnd("ケイティ、保留ターン");
    assert.equal(harness.pipeline._test.getPendingQueueLength(), 1);

    let exitEvent = null;
    harness.pipeline.once("exit_requested", (event) => { exitEvent = event; });
    const exiting = harness.pipeline._test.handleUtteranceEnd("ケイティ、退出して");
    let exitSettled = false;
    exiting.finally(() => { exitSettled = true; });
    await flushMicrotasks();
    timers.tick(2_999);
    await flushMicrotasks();
    assert.equal(exitSettled, false);
    assert.equal(exitEvent, null);
    timers.tick(1);
    await settleWithMockTimers(exiting, timers);
    assert.equal(exitSettled, true);
    assert.equal(exitEvent?.trigger, "voice_command");
    assert.equal(harness.pipeline._test.getPendingQueueLength(), 1);
    assert.equal(llmCalls, 1);
    assert.equal(farewellWasLoggedDuringSynthesis, false);
    assert.equal(harness.session.conversationLog.some((entry) => entry.content === "さようなら。"), true);

    unblockLlm();
    await settleWithMockTimers(seed, timers);
  } finally {
    harness.cleanup();
  }
});

test("A8 non-floor wake cancel opens synchronously and preserves pending replay", async () => {
  let unblockLlm;
  let llmCalls = 0;
  let gateDuringAck = null;
  const llmGate = new Promise((resolve) => { unblockLlm = resolve; });
  let harness;
  harness = await createHarness({
    streamChat: async function* () {
      llmCalls += 1;
      await llmGate;
      yield "seed complete。";
    },
    synthesize: async (_text, { onAudio }) => {
      gateDuringAck = harness.turnState.gateState;
      onAudio(Buffer.alloc(320, 1));
    },
    config: {
      hub: { enabled: false },
      cancelAck: "キャンセルしました。",
    },
  });
  try {
    const seed = harness.pipeline._test.processUserInput("seed");
    await flushMicrotasks();
    await harness.pipeline._test.handleUtteranceEnd("ケイティ、保留ターン");
    assert.equal(harness.pipeline._test.getPendingQueueLength(), 1);

    await harness.pipeline._test.handleWakeCancelAbort("ケイティ、ストップ");
    assert.equal(gateDuringAck, "OPEN");
    assert.equal(harness.pipeline._test.getGateState(), "OPEN");
    assert.equal(harness.pipeline._test.getPendingQueueLength(), 1);
    assert.equal(llmCalls, 1);

    unblockLlm();
    await seed;
    assert.equal(llmCalls, 2);
    assert.equal(harness.pipeline._test.getPendingQueueLength(), 0);
  } finally {
    harness.cleanup();
  }
});

test("A12 greeting logs match base outside floor mode and stay conditional in floor mode", async () => {
  let greetingWasLoggedDuringSynthesis = null;
  let nonFloor;
  nonFloor = await createHarness({
    synthesize: async () => {
      greetingWasLoggedDuringSynthesis = nonFloor.session.conversationLog
        .some((entry) => entry.content === "base greeting");
      throw new Error("tts unavailable");
    },
    config: { hub: { enabled: false }, greeting: "base greeting" },
  });
  try {
    await nonFloor.pipeline._test.sendGreeting();
    assert.equal(greetingWasLoggedDuringSynthesis, true);
    assert.equal(nonFloor.session.conversationLog.some((entry) => entry.content === "base greeting"), true);
  } finally {
    nonFloor.cleanup();
  }

  const floor = createFloor({ reportWake: async () => ({ kind: "not_assigned" }) });
  const floorHarness = await createHarness({
    floor,
    config: { greeting: "suppressed greeting" },
  });
  const greetingDebug = [];
  const originalDebug = console.debug;
  console.debug = (...args) => greetingDebug.push(args.join(" "));
  try {
    await floorHarness.pipeline._test.sendGreeting();
    assert.equal(floorHarness.session.conversationLog.some((entry) => entry.content === "suppressed greeting"), false);
    assert.equal(greetingDebug.some((line) => line.includes("Greeting swallowed: not_assigned")), true);
  } finally {
    console.debug = originalDebug;
    floorHarness.cleanup();
  }
});
