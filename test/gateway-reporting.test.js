const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

test("canDispatchHandoff blocks on in-flight cap and cooldown until expiry", async () => {
  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        handoffInflightMax: 2,
        handoffCooldownMs: 0,
        reportVoiceEnabled: false,
      },
    });

    assert.equal(pipeline._test.canDispatchHandoff(1_000), true);
    pipeline._test.markHandoffDispatched("first", "forced", 1_000);
    assert.equal(pipeline._test.canDispatchHandoff(1_001), true);
    pipeline._test.markHandoffDispatched("second", "forced", 1_001);
    assert.equal(pipeline._test.canDispatchHandoff(1_002), false);
    assert.equal(pipeline._test.canDispatchHandoff(1_001 + 5 * 60 * 1_000 + 1), true);
    pipeline.close();
  });

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        handoffInflightMax: 10,
        handoffCooldownMs: 1_000,
        reportVoiceEnabled: false,
      },
    });

    assert.equal(pipeline._test.canDispatchHandoff(10_000), true);
    pipeline._test.markHandoffDispatched("cooldown", "forced", 10_000);
    assert.equal(pipeline._test.canDispatchHandoff(10_999), false);
    assert.equal(pipeline._test.canDispatchHandoff(11_000), true);
    pipeline.close();
  });
});

test("pending handoff dispatch retries failure once and succeeds without dropping", async () => {
  const metricsEvents = [];

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        handoffInflightMax: 2,
        handoffCooldownMs: 0,
        reportVoiceEnabled: false,
      },
    });
    let attempts = 0;
    let successfulDispatches = 0;

    assert.equal(pipeline._test.enqueuePendingHandoff("transcript", "retry-once", async () => {
      attempts += 1;
      if (attempts === 1) return false;
      successfulDispatches += 1;
      return true;
    }), true);

    await pipeline._test.drainPendingHandoffs();
    assert.equal(attempts, 1);
    assert.equal(successfulDispatches, 0);
    assert.equal(pipeline._test.getPendingHandoffQueueLength(), 1);

    await pipeline._test.drainPendingHandoffs();
    assert.equal(attempts, 2);
    assert.equal(successfulDispatches, 1);
    assert.equal(pipeline._test.getPendingHandoffQueueLength(), 0);
    assert.equal(metricsEvents.some((event) => event.type === "handoff_dropped"), false);
    pipeline.close();
  }, { metricsEvents });
});

test("pending handoff dispatch drops after three failed attempts and records metric", async () => {
  const warnings = [];
  const metricsEvents = [];
  const restoreWarn = captureConsoleWarn(warnings);

  try {
    await withFreshPipeline(async ({ createPipeline }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        gatewayEventsConfig: {
          enabled: true,
          handoffInflightMax: 2,
          handoffCooldownMs: 0,
          reportVoiceEnabled: false,
        },
      });
      let attempts = 0;

      assert.equal(pipeline._test.enqueuePendingHandoff("transcript", "drop-after-three", async () => {
        attempts += 1;
        return false;
      }), true);

      await pipeline._test.drainPendingHandoffs();
      await pipeline._test.drainPendingHandoffs();
      await pipeline._test.drainPendingHandoffs();

      assert.equal(attempts, 3);
      assert.equal(pipeline._test.getPendingHandoffQueueLength(), 0);
      assert.equal(warnings.some((line) => line.includes("pending handoff dropped after dispatch failures")), true);
      assert.equal(metricsEvents.some((event) => (
        event.type === "handoff_dropped"
        && event.reason === "dispatch_failed"
        && event.label === "drop-after-three"
      )), true);
      pipeline.close();
    }, { metricsEvents });
  } finally {
    restoreWarn();
  }
});

test("reportQueue overflow drops the oldest line and warns", async () => {
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);

  try {
    await withFreshPipeline(async ({ createPipeline }) => {
      const { pipeline, turnState } = createTestPipeline(createPipeline, {
        gatewayEventsConfig: {
          enabled: true,
          reportVoiceGapMs: 100,
          reportVoiceEnabled: true,
        },
      });

      turnState.isAgentSpeaking = true;
      for (let i = 1; i <= 11; i += 1) {
        pipeline._test.enqueueReportVoiceLine(`line-${i}`);
      }

      assert.equal(pipeline._test.getReportQueueLength(), 10);
      assert.deepEqual(pipeline._test.getReportQueueLines(), [
        "line-2",
        "line-3",
        "line-4",
        "line-5",
        "line-6",
        "line-7",
        "line-8",
        "line-9",
        "line-10",
        "line-11",
      ]);
      assert.equal(warnings.filter((line) => line.includes("report voice queue overflow")).length, 1);
      pipeline.close();
    });
  } finally {
    restoreWarn();
  }
});

test("drainReportQueue does not speak after close during a pending gap wait", async (t) => {
  const spoken = [];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline, turnState } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        reportVoiceGapMs: 2_000,
        reportVoiceEnabled: true,
      },
    });

    turnState.isAgentSpeaking = true;
    pipeline._test.enqueueReportVoiceLine("line-after-close");
    await flushMicrotasks();
    assert.equal(pipeline._test.getReportQueueLength(), 1);

    pipeline.close();
    turnState.isAgentSpeaking = false;
    t.mock.timers.tick(2_000);
    await flushMicrotasks();

    assert.deepEqual(spoken, []);
  }, { spoken });
});

test("completion chat message strips emoji and rare scripts and never returns empty", async () => {
  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        reportVoiceEnabled: false,
      },
    });

    const message = pipeline._test.buildCompletionChatMessage({
      label: "調査👍𐌰",
      resultText: "結果です🎉𐌱",
    });
    assert.equal(message, "委譲タスク結果: 調査\n結果です");
    assert.equal(/[👍🎉]/u.test(message), false);
    assert.equal(/[\u{10330}-\u{1034F}]/u.test(message), false);

    const fallback = pipeline._test.buildCompletionChatMessage({
      label: "👍𐌰",
      resultText: "🎉𐌱",
    });
    assert.equal(fallback.length > 0, true);
    assert.match(fallback, /^委譲タスク結果:/);
    pipeline.close();
  });
});

function createTestPipeline(createPipeline, options = {}) {
  const session = { id: "gateway-reporting-test", conversationLog: [], config: { wakeMode: "wake" } };
  const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
  const config = {
    dgKey: "x",
    fishKey: "x",
    openclawUrl: "http://handoff.test",
    openclawToken: "x",
    stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
    llm: {
      model: "test",
      temperature: 0.5,
      maxTokens: 100,
      firstTokenDelegateMs: 0,
      responseTimeoutMs: 0,
      openclawSystemAddendum: "",
    },
    tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
    ackVariants: [],
    progressPings: [],
    echoCooldownMs: 1,
    greeting: "",
    exitDetection: false,
    gatewayEvents: options.gatewayEventsConfig || { enabled: false },
  };

  const pipeline = createPipeline(session, turnState, () => {}, config, {
    agents: { caty: { wakeWords: ["ケイティ"] } },
    selectedAgentIds: ["caty"],
    defaultAgentId: "caty",
    _testExposeInternals: true,
  });

  return { pipeline, turnState };
}

async function withFreshPipeline(fn, options = {}) {
  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm.js"),
    path.join(src, "tts-fish.js"),
    path.join(src, "metrics.js"),
    path.join(src, "gateway-events.js"),
    path.join(src, "pipeline.js"),
  ];
  const previousCache = new Map(paths.map((p) => [require.resolve(p), require.cache[require.resolve(p)]]));
  for (const p of paths) delete require.cache[require.resolve(p)];

  const previousEnv = setEnv({
    POST_UTTERANCE_BUFFER_MS: "0",
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    TTS_GAP_MS: "0",
    TTS_LEAD_MS: "0",
    SENTENCE_PAUSE_MS: "0",
    WAKE_WORDS: "ケイティ",
  });

  const sttExports = {
    createSTT: () => {
      const sttEmitter = new EventEmitter();
      sttEmitter.send = () => {};
      sttEmitter.close = () => {};
      return sttEmitter;
    },
    buildKeyterms: () => [],
  };

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm.js"))] = cacheEntry(path.join(src, "llm.js"), {
    streamChat: async function* () {},
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => {
      options.spoken?.push(text);
      onAudio(Buffer.alloc(4));
    },
  });
  require.cache[require.resolve(path.join(src, "metrics.js"))] = cacheEntry(path.join(src, "metrics.js"), {
    recordEvent: (type, fields = {}) => {
      options.metricsEvents?.push({ type, ...fields });
    },
  });
  require.cache[require.resolve(path.join(src, "gateway-events.js"))] = cacheEntry(path.join(src, "gateway-events.js"), {
    abortSession: async () => true,
  });
  const createdPipelines = new Set();

  try {
    const pipelineModule = require(path.join(src, "pipeline.js"));
    const createPipeline = (...args) => {
      const pipeline = pipelineModule.createPipeline(...args);
      createdPipelines.add(pipeline);
      return pipeline;
    };
    return await fn({ ...pipelineModule, createPipeline });
  } finally {
    for (const pipeline of createdPipelines) {
      try { pipeline.close?.(); } catch { /* ignore test cleanup */ }
    }
    restoreEnv(previousEnv);
    for (const p of paths) {
      const resolved = require.resolve(p);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
  }
}

function cacheEntry(filename, exports) {
  return {
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
  return previous;
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function captureConsoleWarn(warnings) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  return () => {
    console.warn = originalWarn;
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
