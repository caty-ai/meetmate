const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const DELEGATION_LINE = "ちょっと時間がかかってるから、詳細はあとでSlackで共有するね。";
const TIMEOUT_LINE = "[empathetic, unhurried] ごめん、ちょっと時間がかかってるね。少し待ってもらえるかな？";

test("getPipelineConfig parses FIRST_TOKEN_DELEGATE_MS default, override, disabled, empty, and invalid", () => {
  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: undefined }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "15000" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "0" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 0);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "-1" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 0);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "abc" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });
});

test("Timer A aborts the LLM, speaks the delegation line, requests handoff, records metrics, and suppresses Timer B", async (t) => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "forced-delegation-metrics-"));
  let streamAborted = false;
  const spoken = [];
  const warnings = [];
  t.after(captureConsoleWarn(warnings));

  const result = await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline, turnState } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 80,
        responseTimeoutMs: 220,
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、調べてまとめて", "turn-a");
      await sleep(260);
      pipeline.close();
      await metrics._test.flush();

      return { turnState, gateState: pipeline._test.getGateState() };
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
          streamAborted = opts.signal.aborted;
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);
  const forcedEvent = events.find((event) => event.type === "forced_delegation_fired");

  assert.equal(streamAborted, true);
  assert.equal(spoken.includes(DELEGATION_LINE), true);
  assert.equal(handoffRequests.length, 1);
  assert.equal(forcedEvent.turn_id, "turn-a");
  assert.equal(forcedEvent.threshold_ms, 80);
  assert.equal(forcedEvent.elapsed_ms >= 50, true);
  assert.equal(forcedEvent.elapsed_ms < 500, true);
  assert.equal(warnings.some((line) => line.includes("LLM first-response timeout")), false);
  assert.equal(events.some((event) => event.type === "timeout_fallback_fired"), false);
  assert.equal(events.some((event) => event.type === "handoff_requested" && event.turn_id === "turn-a"), true);
  assert.equal(events.some((event) => event.type === "tts_playback_start" && event.source === "forced_delegation"), true);
  assert.equal(events.some((event) => event.type === "turn_end" && event.turn_id === "turn-a" && event.handoff_attempted === true), true);
  assert.equal(result.turnState.isAgentSpeaking, false);
  assert.equal(result.gateState, "OPEN");
});

test("Timer A disabled preserves the 35s timeout fallback path", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "response-timeout-metrics-"));
  let streamAborted = false;
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 80,
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、調べてまとめて", "turn-b");
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
          streamAborted = opts.signal.aborted;
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);

  assert.equal(streamAborted, true);
  assert.equal(spoken.includes(TIMEOUT_LINE), true);
  assert.equal(spoken.includes(DELEGATION_LINE), false);
  assert.equal(handoffRequests.length, 1);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired"), false);
  assert.equal(events.some((event) => event.type === "timeout_fallback_fired" && event.turn_id === "turn-b"), true);
  assert.equal(events.some((event) => event.type === "handoff_requested" && event.turn_id === "turn-b"), true);
});

test("first token before Timer A threshold cancels forced delegation", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-token-normal-metrics-"));
  let streamAborted = false;
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 120,
        responseTimeoutMs: 300,
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、短く答えて", "turn-c");
      await sleep(160);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await sleep(10);
          streamAborted = opts.signal.aborted;
          yield "これは通常応答です。";
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);

  assert.equal(streamAborted, false);
  assert.equal(spoken.includes("これは通常応答です。"), true);
  assert.equal(handoffRequests.length, 0);
  assert.equal(events.some((event) => event.type === "first_token" && event.turn_id === "turn-c"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired"), false);
  assert.equal(events.some((event) => event.type === "timeout_fallback_fired"), false);
});

test("gateway fallback retry cancels the outer first-response timers", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-fallback-timers-"));
  const spoken = [];
  const streamCalls = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 160,
        responseTimeoutMs: 500,
        agents: {
          caty: { wakeWords: ["ケイティ"] },
          analyst: { wakeWords: ["アナリスト"], gatewayUrl: "http://analyst.test" },
        },
        selectedAgentIds: ["caty", "analyst"],
        defaultAgentId: "caty",
      });

      await pipeline._test.handleUtteranceEnd("アナリスト、調べてまとめて", "turn-d");
      await sleep(220);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          streamCalls.push(opts.sessionUser);
          if (opts.sessionUser.endsWith("-analyst")) {
            await sleep(60);
            throw new Error("ECONNREFUSED analyst gateway");
          }

          await sleep(120);
          yield "通常のフォールバック応答です。";
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);

  assert.deepEqual(streamCalls, ["meet-forced-delegation-test-analyst", "meet-forced-delegation-test-caty"]);
  assert.equal(spoken.includes("通常のフォールバック応答です。"), true);
  assert.equal(spoken.includes(DELEGATION_LINE), false);
  assert.equal(handoffRequests.length, 0);
  assert.equal(events.some((event) => event.type === "first_token" && event.turn_id === "turn-d"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired" && event.turn_id === "turn-d"), false);
  assert.equal(events.some((event) => event.type === "tts_playback_start" && event.source === "forced_delegation"), false);
});

function createTestPipeline(createPipeline, options) {
  const session = { id: "forced-delegation-test", conversationLog: [], config: { wakeMode: "wake" } };
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
      firstTokenDelegateMs: options.firstTokenDelegateMs,
      responseTimeoutMs: options.responseTimeoutMs,
      openclawSystemAddendum: "",
    },
    tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
    ackVariants: [],
    progressPings: [],
    echoCooldownMs: 1,
    greeting: "",
    exitDetection: false,
  };

  const pipeline = createPipeline(session, turnState, () => {}, config, {
    agents: options.agents || { caty: { wakeWords: ["ケイティ"] } },
    selectedAgentIds: options.selectedAgentIds || ["caty"],
    defaultAgentId: options.defaultAgentId || "caty",
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
    METRICS_LOG_DIR: options.metricsDir,
    METRICS_DISABLED: undefined,
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

  const httpModule = require("node:http");
  const previousHttpRequest = httpModule.request;
  httpModule.request = createFakeRequest(options.handoffRequests || []);

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm.js"))] = cacheEntry(path.join(src, "llm.js"), options.llm);
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => {
      options.spoken?.push(text);
      onAudio(Buffer.alloc(4));
    },
  });

  try {
    const pipelineModule = require(path.join(src, "pipeline.js"));
    const metrics = require(path.join(src, "metrics.js"));
    return await fn({ createPipeline: pipelineModule.createPipeline, metrics });
  } finally {
    httpModule.request = previousHttpRequest;
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

function freshConfig() {
  const configPath = path.join(__dirname, "..", "src", "config.js");
  delete require.cache[require.resolve(configPath)];
  return require(configPath);
}

function readMetrics(dir) {
  const file = path.join(dir, "metrics.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createFakeRequest(requests) {
  return (requestOptions, callback) => {
    const req = new EventEmitter();
    let body = "";
    req.write = (chunk) => {
      body += String(chunk || "");
    };
    req.end = () => {
      requests.push({ options: requestOptions, body });
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        callback(res);
      });
    };
    req.setTimeout = () => req;
    req.destroy = (err) => {
      if (err) process.nextTick(() => req.emit("error", err));
    };
    return req;
  };
}

function waitForAbort(signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", resolve, { once: true });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureConsoleWarn(warnings) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
    originalWarn(...args);
  };
  return () => {
    console.warn = originalWarn;
  };
}

function withEnv(values, fn) {
  const previous = setEnv(values);
  try {
    return fn();
  } finally {
    restoreEnv(previous);
    const configPath = path.join(__dirname, "..", "src", "config.js");
    delete require.cache[require.resolve(configPath)];
  }
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
