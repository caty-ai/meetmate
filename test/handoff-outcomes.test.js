const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const MEET_LINE = "[soft voice] 続きは裏に回したよ。まとまったらチャットに貼るね。";
const BUSY_LINE = "[soft voice] ごめんね、いま立て込んでるから少し待ってね。";
const SLACK_LINE = "[soft voice] 続きはSlackに共有しておくね。";

const cases = [
  {
    name: "flag off dispatch ok",
    enabled: false,
    mode: "success",
    gatewayEventsConfig: { enabled: false },
    turns: ["ケイティ、通常委譲して"],
    expectedUser: "meet-handoff-outcomes-caty",
    expectedRequestsBeforeRelease: 1,
    expectedLine: SLACK_LINE,
  },
  {
    name: "flag on dispatch ok",
    enabled: true,
    mode: "success",
    gatewayEventsConfig: { enabled: true, handoffInflightMax: 2, handoffCooldownMs: 0 },
    turns: ["ケイティ、委譲して"],
    expectedUser: "meet-handoff-outcomes-caty-delegate",
    expectedRequestsBeforeRelease: 1,
    expectedLine: MEET_LINE,
  },
  {
    name: "flag on client timeout succeeds unconfirmed",
    enabled: true,
    mode: "client-timeout",
    gatewayEventsConfig: { enabled: true, handoffInflightMax: 2, handoffCooldownMs: 0 },
    turns: ["ケイティ、タイムアウトでも委譲して"],
    expectedUser: "meet-handoff-outcomes-caty-delegate",
    expectedRequestsBeforeRelease: 1,
    expectedLine: MEET_LINE,
  },
  {
    name: "cap blocked queues then dispatches after completion",
    enabled: true,
    mode: "success",
    gatewayEventsConfig: { enabled: true, handoffInflightMax: 1, handoffCooldownMs: 0 },
    turns: ["ケイティ、1つめ", "ケイティ、2つめ"],
    expectedUser: "meet-handoff-outcomes-caty-delegate",
    expectedRequestsBeforeRelease: 1,
    expectedLine: MEET_LINE,
    releaseFirst: true,
    expectedRequestsAfterRelease: 2,
  },
  {
    name: "cooldown blocked queues then dispatches after cooldown",
    enabled: true,
    mode: "success",
    gatewayEventsConfig: { enabled: true, handoffInflightMax: 5, handoffCooldownMs: 100 },
    turns: ["ケイティ、1つめ", "ケイティ、2つめ"],
    expectedUser: "meet-handoff-outcomes-caty-delegate",
    expectedRequestsBeforeRelease: 1,
    expectedLine: MEET_LINE,
    waitAfterTurnsMs: 100,
    expectedRequestsAfterRelease: 2,
  },
  {
    name: "queue full speaks busy line",
    enabled: true,
    mode: "success",
    gatewayEventsConfig: { enabled: true, handoffInflightMax: 1, handoffCooldownMs: 0 },
    turns: [
      "ケイティ、初回",
      "ケイティ、待機1",
      "ケイティ、待機2",
      "ケイティ、待機3",
      "ケイティ、待機4",
      "ケイティ、待機5",
      "ケイティ、待機6",
    ],
    expectedUser: "meet-handoff-outcomes-caty-delegate",
    expectedRequestsBeforeRelease: 1,
    expectedLine: MEET_LINE,
    expectedBusyCount: 1,
    expectedPending: 5,
  },
];

for (const item of cases) {
  test(`handoff outcome matrix: ${item.name}`, async () => {
    const handoffRequests = [];
    const spoken = [];
    const abortUsers = [];
    let pipeline;

    await withFreshPipeline(
      async ({ createPipeline }) => {
        try {
          pipeline = createTestPipeline(createPipeline, item.gatewayEventsConfig);
          for (const turn of item.turns) {
            await pipeline._test.handleUtteranceEnd(turn, `turn-${handoffRequests.length}-${spoken.length}`);
            await sleep(20);
          }
          assert.equal(handoffRequests.length, item.expectedRequestsBeforeRelease);
          assert.equal(JSON.parse(handoffRequests[0].body).user, item.expectedUser);
          assert.equal(spoken.includes(item.expectedLine), true);
          if (item.waitAfterTurnsMs) await sleep(item.waitAfterTurnsMs);

          if (item.releaseFirst) {
            pipeline._test.handleGatewaySubagentSpawn({
              childKey: "agent:main:subagent:first",
              parentSessionKey: "agent:main:openai-user:meet-handoff-outcomes-caty",
              label: "first",
              source: "forced",
              spawnAtMs: Date.now() - 10,
            });
            await pipeline._test.handleGatewaySubagentCompletion({
              childKey: "agent:main:subagent:first",
              parentSessionKey: "agent:main:openai-user:meet-handoff-outcomes-caty",
              label: "first",
              status: "ok",
              resultText: "done",
              spawnAtMs: Date.now() - 10,
            });
            await sleep(40);
          }
          if (item.expectedRequestsAfterRelease) {
            assert.equal(handoffRequests.length, item.expectedRequestsAfterRelease);
          }
          if (item.expectedBusyCount) {
            assert.equal(spoken.filter((line) => line === BUSY_LINE).length, item.expectedBusyCount);
            assert.equal(pipeline._test.getPendingHandoffQueueLength(), item.expectedPending);
          }
          if (!item.enabled) assert.deepEqual(abortUsers, []);
        } finally {
          pipeline?.close();
        }
      },
      { handoffRequests, spoken, abortUsers, handoffMode: item.mode }
    );
  });
}

function createTestPipeline(createPipeline, gatewayEventsConfig) {
  const session = { id: "handoff-outcomes", conversationLog: [], config: { wakeMode: "wake" } };
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
      firstTokenDelegateMs: 5,
      responseTimeoutMs: 90,
      openclawSystemAddendum: "",
    },
    tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
    ackVariants: [],
    progressPings: [],
    echoCooldownMs: 1,
    greeting: "",
    exitDetection: false,
    gatewayEvents: {
      forcedDelegationAbort: true,
      handoffDelegateSession: true,
      reportChatEnabled: false,
      reportVoiceEnabled: false,
      reportVoiceGapMs: 1,
      shortUtteranceSkipChars: 0,
      ...gatewayEventsConfig,
    },
  };
  return createPipeline(session, turnState, () => {}, config, {
    agents: { caty: { wakeWords: ["ケイティ"] } },
    selectedAgentIds: ["caty"],
    defaultAgentId: "caty",
    _testExposeInternals: true,
  });
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
    METRICS_DISABLED: "1",
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
  httpModule.request = createFakeRequest(options.handoffRequests || [], options.handoffMode);
  const createdPipelines = new Set();

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm.js"))] = cacheEntry(path.join(src, "llm.js"), {
    streamChat: async function* (_messages, opts) {
      await waitForAbort(opts.signal);
    },
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
  });
  require.cache[require.resolve(path.join(src, "gateway-events.js"))] = cacheEntry(path.join(src, "gateway-events.js"), {
    abortSession: async (sessionUser) => {
      options.abortUsers?.push(sessionUser);
      return { ok: true, attempts: 1 };
    },
    compactSession: async () => ({ ok: true, compacted: true }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => {
      options.spoken?.push(text);
      onAudio(Buffer.alloc(4));
    },
  });

  try {
    const pipelineModule = require(path.join(src, "pipeline.js"));
    const createPipeline = (...args) => {
      const pipeline = pipelineModule.createPipeline(...args);
      createdPipelines.add(pipeline);
      return pipeline;
    };
    return await fn({ createPipeline });
  } finally {
    for (const pipeline of createdPipelines) {
      try { pipeline.close?.(); } catch { /* ignore test cleanup */ }
    }
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

function createFakeRequest(requests, mode = "success") {
  return (requestOptions, callback) => {
    const req = new EventEmitter();
    let body = "";
    let timeoutMs = null;
    let timeoutCallback = null;
    req.write = (chunk) => { body += String(chunk || ""); };
    req.end = () => {
      requests.push({ options: requestOptions, body, timeoutMs });
      if (mode === "client-timeout") {
        process.nextTick(() => timeoutCallback?.());
        return;
      }
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        callback(res);
      });
    };
    req.setTimeout = (ms, cb) => {
      timeoutMs = ms;
      timeoutCallback = cb;
      return req;
    };
    req.destroy = (err) => {
      if (err) process.nextTick(() => req.emit("error", err));
    };
    return req;
  };
}

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
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
