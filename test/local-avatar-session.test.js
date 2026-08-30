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
  _test: localAvatarTest,
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

test("successful state polling renews the idle TTL beyond twice the maximum lifetime", () => {
  let now = 1_000;
  const issued = createLocalAvatarSession({
    publicOrigin: "https://meetmate.example",
    now: () => now,
    ttlMs: localAvatarTest.MAX_TTL_MS + 1,
  });
  const auth = { capability: issued.capability, origin: "https://meetmate.example" };
  const connected = issued.session.connect(auth);
  const readArgs = {
    ...auth,
    generation: connected.generation,
    afterSequence: connected.sequence,
  };

  assert.equal(issued.session.snapshot().expiresAt, now + localAvatarTest.MAX_TTL_MS);
  for (let poll = 0; poll < 3; poll += 1) {
    now += localAvatarTest.MAX_TTL_MS - 1;
    assert.equal(issued.session.readState(readArgs), undefined);
    assert.equal(issued.session.snapshot().expiresAt, now + localAvatarTest.MAX_TTL_MS);
  }
  assert.ok(now > 1_000 + (2 * localAvatarTest.MAX_TTL_MS));
  assert.equal(getLocalAvatarSession(issued.session.visualId), issued.session);

  now = issued.session.snapshot().expiresAt;
  assert.equal(issued.session.readState(readArgs), null);
  assert.equal(getLocalAvatarSession(issued.session.visualId), null);
});

test("local avatar marker supersede, delivery retries, source generations, and reconnect history are bounded", () => {
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
    assert.equal(issued.session.publishMarker(marker(2), firstSource), true);
    assert.deepEqual(pick(issued.session.snapshot(), ["queueSize", "queueLimit", "dropped", "envelopeDropped"]), {
      queueSize: 1,
      queueLimit: 2,
      dropped: 0,
      envelopeDropped: 0,
    });

    const readArgs = { ...auth, generation: connected.generation, afterSequence: connected.sequence };
    const latest = issued.session.readState(readArgs);
    assert.equal(latest.kind, "marker");
    assert.equal(latest.sampleIndex, 2);
    assert.deepEqual(latest.envelopes, []);
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

test("marker snapshots preserve bursts across supersede and stale retry delivery without mutating prior states", () => {
  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const auth = { capability: issued.capability, origin: "https://meetmate.example" };
  try {
    const connected = issued.session.connect(auth);
    const source = issued.session.beginSource();
    assert.equal(issued.session.publishMarker(envelopeMarker(0, [{ s: 0, v: [0.1] }]), source), true);
    assert.equal(issued.session.publishMarker(envelopeMarker(2_400, [{ s: 2_400, v: [0.2] }]), source), true);

    const readArgs = { ...auth, generation: connected.generation, afterSequence: connected.sequence };
    const firstDelivery = issued.session.readState(readArgs);
    const firstBytes = JSON.stringify(firstDelivery);
    assert.deepEqual(firstDelivery.envelopes, [{ s: 0, v: [0.1, 0.2] }]);
    assert.strictEqual(issued.session.readState(readArgs), firstDelivery, "retry returns the immutable minted state");

    assert.equal(issued.session.publishMarker(envelopeMarker(4_800, [{ s: 4_800, v: [0.3] }]), source), true);
    const replacement = issued.session.readState(readArgs);
    assert.notStrictEqual(replacement, firstDelivery);
    assert.deepEqual(replacement.envelopes, [{ s: 0, v: [0.1, 0.2, 0.3] }]);
    assert.equal(JSON.stringify(firstDelivery), firstBytes, "later log growth never mutates a delivered state");
    assert.notStrictEqual(replacement.envelopes[0].v, firstDelivery.envelopes[0].v);
  } finally {
    issued.session.close();
  }
});

test("marker supersede scans the whole queue while non-marker cap semantics remain unchanged", () => {
  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example", queueLimit: 3 });
  try {
    issued.session._queue.push(
      { kind: "marker", outputEpoch: 4, sequence: 1 },
      { kind: "idle", outputEpoch: 4, sequence: 2 },
      { kind: "marker", outputEpoch: 5, sequence: 3 },
    );
    assert.equal(issued.session._enqueue({ kind: "marker", outputEpoch: 4, sequence: 4 }), true);
    assert.deepEqual(issued.session._queue.map((state) => state.sequence), [4, 2, 3]);
    assert.equal(issued.session._enqueue({ kind: "idle", outputEpoch: 5, sequence: 5 }), false);
    assert.equal(issued.session.snapshot().dropped, 1);
  } finally {
    issued.session.close();
  }
});

test("envelope log coalesces contiguous pushes, prefix-trims old values, and caps fragmented snapshots", () => {
  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const auth = { capability: issued.capability, origin: "https://meetmate.example" };
  try {
    const connected = issued.session.connect(auth);
    const source = issued.session.beginSource();
    for (let index = 0; index < 300; index += 1) {
      assert.equal(issued.session.publishMarker(
        envelopeMarker(index * 2_400, [{ s: index * 2_400, v: [index / 300] }]),
        source,
      ), true);
    }
    const coalesced = issued.session.readState({
      ...auth,
      generation: connected.generation,
      afterSequence: connected.sequence,
    });
    assert.equal(coalesced.envelopes.length, 1);
    assert.equal(coalesced.envelopes[0].v.length, 200, "20 seconds at 10 Hz remain");
    assert.equal(coalesced.envelopes[0].s, 100 * 2_400, "the coalesced run is prefix-trimmed, not emptied");
    assert.equal(coalesced.envelopes[0].v.at(-1), 299 / 300);
    assert.equal(issued.session.snapshot().envelopeDropped, 100);

    const nextSource = issued.session.beginSource();
    const fragmented = Array.from({ length: 150 }, (_, index) => ({ s: index * 2, v: [0.5] }));
    const fragmentedAgain = Array.from({ length: 150 }, (_, index) => ({ s: index * 2 + 1, v: [0.6] }));
    assert.equal(issued.session.publishMarker(envelopeMarker(0, fragmented, 0), nextSource), true);
    assert.equal(issued.session.publishMarker(envelopeMarker(1, fragmentedAgain, 0), nextSource), true);
    const capped = issued.session.readState({
      ...auth,
      generation: connected.generation,
      afterSequence: coalesced.sequence,
    });
    assert.equal(capped.envelopes.reduce((total, segment) => total + segment.v.length, 0), localAvatarTest.MAX_ENVELOPE_VALUES);
    assert.ok(Buffer.byteLength(JSON.stringify(capped)) < 8_000, "fragmented worst-case marker stays below 8 KB");
    assert.ok(issued.session.snapshot().envelopeDropped >= 144);
  } finally {
    issued.session.close();
  }
});

test("envelope validation clamps finite values, rejects corrupted pushes as a unit, and does not block markers", () => {
  const invalidValues = [NaN, Infinity, -Infinity, "0.5"];
  for (const value of invalidValues) {
    const result = publishSingleEnvelope([{ s: 0, v: [value] }]);
    assert.deepEqual(result.envelopes, [], `invalid value ${String(value)} is skipped`);
  }
  for (const segments of [
    null,
    { s: 0, v: [0.5] },
    [{ s: 0, v: [] }],
    [{ s: 0.5, v: [0.5] }],
    [{ s: -1, v: [0.5] }],
    [{ s: 0, v: "not-an-array" }],
  ]) {
    assert.deepEqual(publishSingleEnvelope(segments).envelopes, []);
  }

  assert.deepEqual(
    publishSingleEnvelope([{ s: 0, v: [-2, 0.25, 4] }]).envelopes,
    [{ s: 0, v: [0, 0.25, 1] }],
  );
  assert.deepEqual(
    publishSingleEnvelope([{ s: 0, v: new Array(localAvatarTest.MAX_ENVELOPE_PUSH_VALUES + 1).fill(0.5) }]).envelopes,
    [],
    "an oversized synthesize push is rejected as a unit",
  );
  const mixed = publishSingleEnvelope([
    { s: 0, v: [0.25] },
    { s: 2_400, v: [NaN] },
  ]);
  assert.equal(mixed.kind, "marker");
  assert.deepEqual(mixed.envelopes, [], "a structurally invalid sibling rejects the whole push");
});

test("multi-segment pushes that cumulatively exceed the 150-window cap are rejected as a unit", () => {
  const state = publishSingleEnvelope([
    { s: 0, v: new Array(100).fill(0.25) },
    { s: 24_000, v: new Array(51).fill(0.5) },
  ]);
  assert.equal(state.kind, "marker");
  assert.deepEqual(state.envelopes, []);
});

test("connect, epoch bump, cancelPlayback, and beginSource clear envelope history", () => {
  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const auth = { capability: issued.capability, origin: "https://meetmate.example" };
  try {
    let connected = issued.session.connect(auth);
    let source = issued.session.beginSource();
    issued.session.publishMarker(envelopeMarker(0, [{ s: 0, v: [0.1] }]), source);
    connected = issued.session.connect(auth);
    source = issued.session.beginSource();
    issued.session.publishMarker(envelopeMarker(0, undefined), source);
    let state = issued.session.readState({ ...auth, generation: connected.generation, afterSequence: connected.sequence });
    assert.deepEqual(state.envelopes, [], "connect clears the previous log");

    issued.session.publishMarker(envelopeMarker(2_400, [{ s: 0, v: [0.2] }]), source);
    issued.session.publishMarker(envelopeMarker(0, [{ s: 0, v: [0.3] }], 1), source);
    state = issued.session.readState({ ...auth, generation: connected.generation, afterSequence: state.sequence });
    assert.deepEqual(state.envelopes, [{ s: 0, v: [0.3] }], "epoch bump starts a fresh log");

    assert.equal(issued.session.cancelPlayback({ outputEpoch: 1 }, source), true);
    assert.equal(issued.session.publishMarker(envelopeMarker(0, [{ s: 0, v: [0.4] }], 2), source), true);
    state = issued.session.readState({ ...auth, generation: connected.generation, afterSequence: state.sequence });
    assert.equal(state.kind, "marker", "the next epoch supersedes an unread cancel");
    assert.equal(state.cancelEpoch, 3);
    assert.deepEqual(state.envelopes, [{ s: 0, v: [0.4] }]);

    const nextSource = issued.session.beginSource();
    issued.session.publishMarker(envelopeMarker(0, undefined), nextSource);
    state = issued.session.readState({ ...auth, generation: connected.generation, afterSequence: state.sequence });
    assert.deepEqual(state.envelopes, [], "beginSource clears the previous log");
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

test("greeting preempts a pending turn before its late timeout can invalidate greeting playback", { concurrency: false }, async () => {
  const timeoutMs = 60_000;
  const captured = [];
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay !== timeoutMs) return originalSetTimeout(callback, delay, ...args);
    const handle = { unref() {} };
    captured.push({ callback, args, handle, cleared: false });
    return handle;
  };
  global.clearTimeout = (handle) => {
    const timer = captured.find((item) => item.handle === handle);
    if (timer) {
      timer.cleared = true;
      return;
    }
    originalClearTimeout(handle);
  };

  try {
    const observed = [];
    let greetingOnAudio;
    let greetingSignal;
    let finishGreeting;
    await withPipeline({
      config: {
        greeting: "こんにちは。",
        llm: { responseTimeoutMs: timeoutMs, firstTokenDelegateMs: 0 },
      },
      llm: { streamChat: waitForAbortStream },
      synthesize: async (_text, { signal, onAudio }) => {
        greetingSignal = signal;
        greetingOnAudio = onAudio;
        onAudio(Buffer.from([1, 0]));
        await new Promise((resolve) => {
          finishGreeting = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
      onAudio: (buffer, metadata) => observed.push({ hex: buffer.toString("hex"), metadata: { ...metadata } }),
    }, async ({ pipeline }) => {
      const events = collectCancellationEvents(pipeline);
      const processing = pipeline._test.processUserInput("応答待ちのターン");
      await waitUntil(() => captured.length === 1);
      const oldController = pipeline._test.getCurrentAbortController();
      let oldAbortCount = 0;
      oldController.signal.addEventListener("abort", () => { oldAbortCount += 1; });

      const greeting = pipeline._test.sendGreeting();
      await waitUntil(() => observed.length === 1);
      assert.equal(oldController.signal.aborted, true);
      assert.equal(oldAbortCount, 1);
      assertCancellation(events, "greeting_preempt", 0);
      assert.equal(captured[0].cleared, true);

      captured[0].callback(...captured[0].args);
      assert.equal(pipeline._test.abortPlayback(oldController, "llm_response_timeout"), false);
      assert.equal(events.length, 1);
      assert.equal(greetingSignal.aborted, false);

      greetingOnAudio(Buffer.from([2, 0]));
      assert.deepEqual(observed, [
        { hex: "0100", metadata: { outputEpoch: 1, firstSampleIndex: 0, sampleRate: fixture.pcm.sampleRate } },
        { hex: "0200", metadata: { outputEpoch: 1, firstSampleIndex: 1, sampleRate: fixture.pcm.sampleRate } },
      ]);
      finishGreeting();
      await Promise.all([processing, greeting]);
    });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
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

test("pipeline omits zero-window envelopes and keeps audio flowing when envelope computation fails or is disabled", { concurrency: false }, async () => {
  const small = [];
  await withPipeline({
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4)),
    onAudio: (_buffer, metadata) => small.push({ ...metadata }),
  }, async ({ pipeline }) => {
    await pipeline._test.speakSentence("small", null);
  });
  assert.equal(Object.hasOwn(small[0], "envelopeSegments"), false);

  const failed = [];
  await withPipeline({
    audioEnvelope: {
      createEnvelopeAccumulator: () => ({
        push: () => { throw new Error("meter failed"); },
        reset: () => {},
      }),
    },
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4_800)),
    onAudio: (buffer, metadata) => failed.push({ bytes: buffer.length, metadata: { ...metadata } }),
  }, async ({ pipeline }) => {
    await pipeline._test.speakSentence("failure", null);
  });
  assert.equal(failed[0].bytes, 4_800);
  assert.equal(Object.hasOwn(failed[0].metadata, "envelopeSegments"), false);

  let accumulatorCreated = false;
  const disabled = [];
  await withPipeline({
    env: { LOCAL_AVATAR_ENVELOPE: "off" },
    audioEnvelope: {
      createEnvelopeAccumulator: () => {
        accumulatorCreated = true;
        throw new Error("kill switch called the accumulator");
      },
    },
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4_800)),
    onAudio: (_buffer, metadata) => disabled.push({ ...metadata }),
  }, async ({ pipeline }) => {
    await pipeline._test.speakSentence("disabled", null);
  });
  assert.equal(accumulatorCreated, false);
  assert.equal(Object.hasOwn(disabled[0], "envelopeSegments"), false);
});

test("drained ack and post-stream tail boundaries re-arm, while a streamed first chain cannot bump", { concurrency: false }, async () => {
  await withFakeNow(0, async (clock) => {
    const ackAudio = [];
    await withPipeline({
      env: { ENABLE_IMMEDIATE_ACK: "true" },
      config: { ackVariants: ["はい。"] },
      llm: { streamChat: async function* () {} },
      synthesize: oneWindowSynthesize,
      onAudio: (_buffer, metadata) => ackAudio.push({ ...metadata }),
    }, async ({ pipeline }) => {
      await pipeline._test.processUserInput("first turn");
      clock.set(2_100);
      await pipeline._test.processUserInput("second turn");
    });
    assert.deepEqual(pick(ackAudio[0], ["outputEpoch", "firstSampleIndex"]), {
      outputEpoch: 0,
      firstSampleIndex: 0,
    });
    assert.deepEqual(pick(ackAudio.find((item) => item.outputEpoch === 1), ["outputEpoch", "firstSampleIndex"]), {
      outputEpoch: 1,
      firstSampleIndex: 0,
    });

    const tailAudio = [];
    clock.set(0);
    await withPipeline({
      llm: { streamChat: async function* () { yield "short tail"; } },
      synthesize: oneWindowSynthesize,
      onAudio: (_buffer, metadata) => tailAudio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      await primeRearmBoundary(pipeline, turnState, clock);
      clock.set(2_100);
      await pipeline._test.processUserInput("tail turn");
    });
    assert.equal(tailAudio.at(-1).outputEpoch, 1, "tail flush runs after the stream-open veto clears");
    assert.equal(tailAudio.at(-1).firstSampleIndex, 0);

    const streamedAudio = [];
    clock.set(0);
    await withPipeline({
      llm: { streamChat: async function* () { yield "abcdefghijklmnop"; } },
      synthesize: oneWindowSynthesize,
      onAudio: (_buffer, metadata) => streamedAudio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      await primeRearmBoundary(pipeline, turnState, clock);
      clock.set(2_100);
      await pipeline._test.processUserInput("streamed turn");
    });
    assert.equal(streamedAudio.at(-1).outputEpoch, 0, "the no-ack first chain remains vetoed inside streamChat");
  });
});

test("stream-open veto blocks between-sentence stalls and progress pings during thinking", { concurrency: false }, async () => {
  await withFakeNow(0, async (clock) => {
    const stalledAudio = [];
    await withPipeline({
      llm: {
        streamChat: async function* () {
          yield "これは十分に長い第一文です。";
          clock.set(5_000);
          yield "これは十分に長い第二文です。";
        },
      },
      synthesize: oneWindowSynthesize,
      onAudio: (_buffer, metadata) => stalledAudio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      await primeRearmBoundary(pipeline, turnState, clock);
      clock.set(2_100);
      await pipeline._test.processUserInput("stall turn");
    });
    assert.deepEqual(new Set(stalledAudio.map((item) => item.outputEpoch)), new Set([0]));

    const pingAudio = [];
    clock.set(0);
    await withPipeline({
      llm: { streamChat: waitForAbortStream },
      synthesize: oneWindowSynthesize,
      onAudio: (_buffer, metadata) => pingAudio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      await primeRearmBoundary(pipeline, turnState, clock);
      clock.set(2_100);
      const processing = pipeline._test.processUserInput("thinking turn");
      await waitUntil(() => pipeline._test.getEnvelopeRearmState().llmStreamOpen);
      clock.set(5_000);
      turnState.isAgentSpeaking = true;
      await pipeline._test.speakSentence("progress ping", null, { role: "progress" });
      assert.equal(pingAudio.at(-1).outputEpoch, 0);
      pipeline._test.abortCurrent();
      await processing;
    });
  });
});

test("pre-await snapshots prevent a lock-held stall from re-arming a queued chain", { concurrency: false }, async () => {
  await withFakeNow(0, async (clock) => {
    let releaseHold;
    const hold = new Promise((resolve) => { releaseHold = resolve; });
    const audio = [];
    await withPipeline({
      synthesize: async (text, { onAudio }) => {
        onAudio(Buffer.alloc(4_800));
        if (text === "hold") await hold;
      },
      onAudio: (_buffer, metadata) => audio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      await primeRearmBoundary(pipeline, turnState, clock);
      clock.set(2_100);
      const holding = pipeline._test.speakSentence("hold", null);
      await waitUntil(() => audio.length === 2);
      const queued = pipeline._test.speakSentence("queued", null);
      clock.set(8_000);
      releaseHold();
      await Promise.all([holding, queued]);
    });
    assert.deepEqual(audio.slice(-2).map((item) => item.outputEpoch), [1, 1]);
  });
});

test("drain projection blocks burst gaps and accounts for a lead-to-burst send hole", { concurrency: false }, async () => {
  await withFakeNow(0, async (clock) => {
    const burstAudio = [];
    await withPipeline({
      synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(240_000)),
      onAudio: (_buffer, metadata) => burstAudio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      turnState.isAgentSpeaking = true;
      await pipeline._test.speakSentence("burst", null);
      clock.set(100);
      pipeline._test.clearAgentSpeaking();
      clock.set(2_100);
      await pipeline._test.speakSentence("too early", null);
      assert.equal(burstAudio.at(-1).outputEpoch, 0);
      turnState.isAgentSpeaking = true;
      clock.set(2_200);
      pipeline._test.clearAgentSpeaking();
      clock.set(12_100);
      await pipeline._test.speakSentence("drained", null);
      assert.equal(burstAudio.at(-1).outputEpoch, 1);
    });

    const holeAudio = [];
    clock.set(0);
    await withPipeline({
      env: { TTS_LEAD_MS: "200" },
      synthesize: async (text, { onAudio }) => {
        if (text === "lead-burst") {
          clock.set(3_000);
          onAudio(Buffer.alloc(240_000));
        } else if (text === "probe with audio") {
          onAudio(Buffer.alloc(4_800));
        } else if (text === "after-hole") {
          onAudio(Buffer.alloc(4_800));
        }
      },
      onAudio: (_buffer, metadata) => holeAudio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      turnState.isAgentSpeaking = true;
      await pipeline._test.speakSentence("lead-burst", null);
      pipeline._test.clearAgentSpeaking();
      clock.set(8_600);
      await pipeline._test.speakSentence("probe with audio", null);
      assert.equal(holeAudio.at(-1).outputEpoch, 0);
    });

    const positiveAudio = [];
    clock.set(0);
    await withPipeline({
      env: { TTS_LEAD_MS: "200" },
      synthesize: async (text, { onAudio }) => {
        if (text === "lead-burst") {
          clock.set(3_000);
          onAudio(Buffer.alloc(240_000));
        } else if (text === "after-hole") {
          onAudio(Buffer.alloc(4_800));
        }
      },
      onAudio: (_buffer, metadata) => positiveAudio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      turnState.isAgentSpeaking = true;
      await pipeline._test.speakSentence("lead-burst", null);
      pipeline._test.clearAgentSpeaking();
      clock.set(10_000);
      await pipeline._test.speakSentence("after-hole", null);
      assert.equal(positiveAudio.at(-1).outputEpoch, 1, "re-arm waits through burst duration plus slack from burst start");
    });
  });
});

test("an aborted pre-delivery snapshot is chain-local and a second drained boundary re-arms from reset state", { concurrency: false }, async () => {
  await withFakeNow(0, async (clock) => {
    const audio = [];
    await withPipeline({
      synthesize: oneWindowSynthesize,
      onAudio: (_buffer, metadata) => audio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      await primeRearmBoundary(pipeline, turnState, clock);
      clock.set(2_100);
      const aborted = new AbortController();
      aborted.abort();
      await pipeline._test.speakSentence("aborted", aborted.signal);
      pipeline._test.deliverAudio(Buffer.alloc(4_800));
      assert.equal(audio.at(-1).outputEpoch, 0, "the aborted chain does not leak its re-arm snapshot");

      turnState.isAgentSpeaking = true;
      clock.set(2_200);
      pipeline._test.clearAgentSpeaking();
      clock.set(4_200);
      await pipeline._test.speakSentence("first boundary", null);
      assert.deepEqual(pick(audio.at(-1), ["outputEpoch", "firstSampleIndex"]), {
        outputEpoch: 1,
        firstSampleIndex: 0,
      });
      assert.equal(audio.at(-1).envelopeSegments[0].s, 0, "a re-arm bump restarts the accumulator at sample zero");
      assert.equal(pipeline._test.getEnvelopeRearmState().projectedEnd, 4_300, "a re-arm bump resets the drain projection");

      turnState.isAgentSpeaking = true;
      clock.set(4_300);
      pipeline._test.clearAgentSpeaking();
      clock.set(6_300);
      await pipeline._test.speakSentence("second boundary", null);
      assert.deepEqual(pick(audio.at(-1), ["outputEpoch", "firstSampleIndex"]), {
        outputEpoch: 2,
        firstSampleIndex: 0,
      });
      assert.equal(audio.at(-1).envelopeSegments[0].s, 0, "every bumped epoch restarts envelope segments from zero");
      assert.equal(pipeline._test.getEnvelopeRearmState().projectedEnd, 6_400);
    });
  });
});

test("all twelve pipeline speaking clears use the shared turnState timestamping helper", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "pipeline.js"), "utf8");
  assert.equal((source.match(/clearAgentSpeaking\(\);/g) || []).length, 12);
  assert.equal((source.match(/turnState\.isAgentSpeaking\s*=\s*false/g) || []).length, 1, "only the helper writes false directly");
  assert.match(source, /const wasSpeaking = turnState\.isAgentSpeaking === true;[\s\S]*if \(wasSpeaking\) turnState\.lastTurnEndAt = Date\.now\(\);/);
  assert.match(source, /turnState\.lastTurnEndAt !== null[\s\S]*now - turnState\.lastTurnEndAt >= ENVELOPE_REARM_IDLE_MS/);
});

test("re-arm gate consumes turnState.lastTurnEndAt instead of a closure-local timestamp", { concurrency: false }, async () => {
  await withFakeNow(0, async (clock) => {
    await withPipeline({
      synthesize: oneWindowSynthesize,
      onAudio: () => {},
    }, async ({ pipeline, turnState }) => {
      turnState.isAgentSpeaking = true;
      await pipeline._test.speakSentence("seed", null);
      clock.set(100);
      pipeline._test.clearAgentSpeaking();
      turnState.lastTurnEndAt = 8_500;
      turnState.isAgentSpeaking = false;
      clock.set(10_100);
      await pipeline._test.speakSentence("seeded recent block", null);
      assert.deepEqual(pick(pipeline._test.getEnvelopeRearmState(), ["outputEpoch", "firstSampleIndex"]), {
        outputEpoch: 0,
        firstSampleIndex: 4_800,
      }, "the gate must honor the seeded shared timestamp");
    });

    const audio = [];
    clock.set(0);
    await withPipeline({
      synthesize: oneWindowSynthesize,
      onAudio: (_buffer, metadata) => audio.push({ ...metadata }),
    }, async ({ pipeline, turnState }) => {
      turnState.isAgentSpeaking = true;
      await pipeline._test.speakSentence("seed", null);
      clock.set(100);
      pipeline._test.clearAgentSpeaking();
      turnState.lastTurnEndAt = 100;
      turnState.isAgentSpeaking = false;
      clock.set(10_100);
      await pipeline._test.speakSentence("seeded boundary", null);
      assert.deepEqual(pick(audio.at(-1), ["outputEpoch", "firstSampleIndex"]), {
        outputEpoch: 1,
        firstSampleIndex: 0,
      });
    });
  });
});

test("empty and whitespace local avatar envelope slack fall back to the 2000ms default", { concurrency: false }, async () => {
  for (const slack of ["", "   "]) {
    await withFakeNow(0, async (clock) => {
      const audio = [];
      await withPipeline({
        env: {
          TTS_LEAD_MS: "200",
          LOCAL_AVATAR_ENVELOPE_SLACK_MS: slack,
        },
        synthesize: async (text, { onAudio }) => {
          if (text === "lead-burst") {
            clock.set(3_000);
            onAudio(Buffer.alloc(240_000));
          } else {
            onAudio(Buffer.alloc(4_800));
          }
        },
        onAudio: (_buffer, metadata) => audio.push({ ...metadata }),
      }, async ({ pipeline, turnState }) => {
        turnState.isAgentSpeaking = true;
        await pipeline._test.speakSentence("lead-burst", null);
        pipeline._test.clearAgentSpeaking();
        clock.set(8_600);
        await pipeline._test.speakSentence("probe", null);
        assert.equal(audio.at(-1).outputEpoch, 0, `slack ${JSON.stringify(slack)} must keep the 2000ms default`);
      });
    });
  }
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
    "greeting_preempt",
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

function envelopeMarker(firstSampleIndex, envelopeSegments, outputEpoch = 0) {
  return {
    ...marker(firstSampleIndex, outputEpoch),
    ...(envelopeSegments === undefined ? {} : { envelopeSegments }),
  };
}

function publishSingleEnvelope(envelopeSegments) {
  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const auth = { capability: issued.capability, origin: "https://meetmate.example" };
  try {
    const connected = issued.session.connect(auth);
    const source = issued.session.beginSource();
    assert.equal(issued.session.publishMarker(envelopeMarker(0, envelopeSegments), source), true);
    return issued.session.readState({
      ...auth,
      generation: connected.generation,
      afterSequence: connected.sequence,
    });
  } finally {
    issued.session.close();
  }
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

async function oneWindowSynthesize(_text, { onAudio }) {
  onAudio(Buffer.alloc(4_800));
}

async function primeRearmBoundary(pipeline, turnState, clock) {
  clock.set(0);
  turnState.isAgentSpeaking = true;
  await pipeline._test.speakSentence("seed", null);
  clock.set(100);
  pipeline._test.clearAgentSpeaking();
}

async function withFakeNow(initial, fn) {
  const originalNow = Date.now;
  let now = initial;
  Date.now = () => now;
  try {
    await fn({
      get: () => now,
      set: (value) => { now = value; },
      advance: (value) => { now += value; },
    });
  } finally {
    Date.now = originalNow;
  }
}

async function withPipeline(overrides, fn) {
  const restoreEnv = setEnv({ ...QUIET_ENV, ...(overrides.env || {}) });
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const src = path.join(__dirname, "..", "src");
  const modulePaths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "tts-cache.js", "audio-envelope.js", "pipeline.js"]
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
  if (overrides.audioEnvelope) installMock(path.join(src, "audio-envelope.js"), overrides.audioEnvelope);

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
