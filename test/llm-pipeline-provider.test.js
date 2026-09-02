const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const readiness = require("../src/settings/readiness");

const src = path.join(__dirname, "..", "src");

test("LLM in-meeting 404 records NOT_ENABLED and the next successful streamed session clears it", { concurrency: false }, async () => {
  readiness.reset();
  let failing = true;
  const provider = {
    name: "openclaw",
    streamChat: async function* () {
      if (failing) throw new Error("OpenClaw Gateway error (404): hidden vendor body");
      yield "recovered。";
    },
  };
  try {
    await withPipeline(provider, {}, async (pipeline) => {
      await pipeline._test.processUserInput("failure");
      assert.equal(readiness.inspect("llm").code, "NOT_ENABLED");
      assert.equal(readiness.inspect("llm").source, "runtime");
      failing = false;
      await pipeline._test.processUserInput("success");
      assert.equal(readiness.inspect("llm").code, "CONNECTED");
    });
  } finally {
    readiness.reset();
  }
});

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withPipeline(provider, configOverrides, fn, testOptions = {}) {
  const files = ["pipeline.js", "llm-provider.js", "stt-provider.js", "tts-fish.js"]
    .map((name) => path.join(src, name));
  const previous = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of files) delete require.cache[require.resolve(file)];

  const stt = new EventEmitter();
  stt.send = () => {};
  stt.close = () => {};
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(
    path.join(src, "stt-provider.js"),
    { createSTT: () => stt, buildKeyterms: () => [] },
  );
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(
    path.join(src, "tts-fish.js"),
    { synthesize: testOptions.synthesize || (async (_text, { onAudio }) => onAudio(Buffer.alloc(2))) },
  );
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(
    path.join(src, "llm-provider.js"),
    { createLlmProvider: () => provider },
  );

  const oldEnv = {
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
  };
  Object.assign(process.env, {
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    TTS_GAP_MS: "0",
    SENTENCE_PAUSE_MS: "0",
  });
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  settingsBootstrap.resetStartupForTest();
  settingsResolver.resetRuntimeForTest();

  const session = { id: "provider-pipeline", conversationLog: [], config: { wakeMode: "wake" } };
  const config = {
    dgKey: "x",
    fishKey: "x",
    stt: { model: "test", language: "ja", sampleRate: 16_000 },
    tts: { referenceId: null, sampleRate: 16_000, latency: "balanced", speed: 1 },
    llm: {
      provider: provider.name,
      model: "test",
      temperature: 0.5,
      maxTokens: 100,
      historyMaxTurns: 2,
      responseTimeoutMs: 0,
      firstTokenDelegateMs: 0,
      systemPrompt: "standalone system",
      gateway: { url: "http://gateway.test", token: "token" },
      openaiCompatible: { baseUrl: "http://llm.test/v1", apiKey: "key" },
      openclawSystemAddendum: "",
      ...configOverrides,
    },
    gatewayEvents: { enabled: false },
    greeting: "",
    exitDetection: false,
    echoCooldownMs: 0,
  };

  let pipeline;
  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    pipeline = createPipeline(
      session,
      { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 },
      () => {},
      config,
      {
        agents: { alpha: { wakeWords: ["alpha"] }, beta: { wakeWords: ["beta"] } },
        selectedAgentIds: ["alpha", "beta"],
        defaultAgentId: "alpha",
        _testExposeInternals: true,
      },
    );
    await fn(pipeline, session);
  } finally {
    pipeline?.close();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      if (previous.get(resolved)) require.cache[resolved] = previous.get(resolved);
    }
  }
}

test("standalone history is capped, session-isolated, and discards aborted/error turns", { concurrency: false }, async () => {
  const calls = [];
  const provider = {
    name: "openai-compatible",
    streamChat: async function* (messages, options) {
      calls.push(messages.map((message) => ({ ...message })));
      const user = messages.at(-1).content;
      if (user === "ABORT") {
        yield "partial";
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        return;
      }
      if (user === "ERROR") {
        yield "partial";
        throw new Error("synthetic failure");
      }
      yield `reply:${user}。`;
    },
  };

  await withPipeline(provider, {}, async (pipeline) => {
    await pipeline._test.processUserInput("one");
    await pipeline._test.processUserInput("two");
    await pipeline._test.processUserInput("three");

    assert.deepEqual(calls[2], [
      { role: "system", content: "standalone system" },
      { role: "user", content: "one" },
      { role: "assistant", content: "reply:one。" },
      { role: "user", content: "two" },
      { role: "assistant", content: "reply:two。" },
      { role: "user", content: "three" },
    ]);

    await pipeline._test.processUserInput("four");
    assert.equal(calls[3].some((message) => message.content === "one"), false, "oldest turn is truncated");

    pipeline._test.switchAgent("beta");
    await pipeline._test.processUserInput("beta-one");
    assert.deepEqual(calls[4].map((message) => message.content), ["standalone system", "beta-one"]);

    pipeline._test.switchAgent("alpha");
    const aborted = pipeline._test.processUserInput("ABORT");
    await sleep(10);
    pipeline._test.abortCurrent();
    await aborted;
    await pipeline._test.processUserInput("ERROR");
    await pipeline._test.processUserInput("after");

    const after = calls.at(-1).map((message) => message.content);
    assert.equal(after.includes("ABORT"), false);
    assert.equal(after.includes("partial"), false);
    assert.equal(after.includes("ERROR"), false);
    assert.deepEqual(after, ["standalone system", "three", "reply:three。", "four", "reply:four。", "after"]);
  });
});

test("first-token delegation timer remains OpenClaw-only", { concurrency: false }, async () => {
  for (const name of ["openclaw", "openai-compatible"]) {
    let aborted = false;
    const provider = {
      name,
      streamChat: async function* (_messages, options) {
        options.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        await sleep(35);
        if (!options.signal.aborted) yield "completed。";
      },
    };

    await withPipeline(provider, { firstTokenDelegateMs: 10 }, async (pipeline) => {
      await pipeline._test.processUserInput("timer check");
    });
    assert.equal(aborted, name === "openclaw", `${name} timer gate`);
  }
});

test("standalone provider receives the exact session user contract and optional retry flag", { concurrency: false }, async () => {
  const calls = [];
  const provider = {
    name: "openai-compatible",
    streamChat: async function* (messages, options) {
      calls.push({
        messages: messages.map((message) => ({ ...message })),
        options: {
          sessionUser: options.sessionUser,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          emptyResponseRetry: options.emptyResponseRetry,
          trustedAgentTools: options.trustedAgentTools,
          sessionHeader: options.sessionHeader,
          streamingEquivalentEnabled: options.streamingEquivalentEnabled,
        },
      });
      yield "ok。";
    },
  };

  await withPipeline(provider, {
    historyMaxTurns: 0,
    openaiCompatible: {
      baseUrl: "http://llm.test/v1",
      apiKey: "key",
      emptyResponseRetry: false,
      trustedAgentTools: true,
      sessionHeader: "X-Hermes-Session-Id",
      streamingEquivalentEnabled: false,
    },
  }, async (pipeline) => {
    await pipeline._test.processUserInput("alpha-one");
    pipeline._test.switchAgent("beta");
    await pipeline._test.processUserInput("beta-one");
  });

  assert.deepEqual(calls.map((call) => call.options.sessionUser), [
    "meet-provider-pipeline-alpha",
    "meet-provider-pipeline-beta",
  ]);
  assert.deepEqual(calls.map((call) => call.messages), [
    [
      { role: "system", content: "standalone system" },
      { role: "user", content: "alpha-one" },
    ],
    [
      { role: "system", content: "standalone system" },
      { role: "user", content: "beta-one" },
    ],
  ]);
  assert.deepEqual(calls.map((call) => call.options.emptyResponseRetry), [false, false]);
  assert.deepEqual(calls.map((call) => call.options.trustedAgentTools), [true, true]);
  assert.deepEqual(calls.map((call) => call.options.sessionHeader), ["X-Hermes-Session-Id", "X-Hermes-Session-Id"]);
  assert.deepEqual(calls.map((call) => call.options.streamingEquivalentEnabled), [false, false]);
  assert.deepEqual(calls.map((call) => [call.options.baseUrl, call.options.apiKey]), [
    ["http://llm.test/v1", "key"],
    ["http://llm.test/v1", "key"],
  ]);
});

test("streaming-equivalent false remains outside the OpenClaw streaming path", { concurrency: false }, async () => {
  const observed = [];
  const provider = {
    name: "openclaw",
    streamChat: async function* (_messages, options) {
      observed.push({
        hasFlag: Object.prototype.hasOwnProperty.call(options, "streamingEquivalentEnabled"),
        sessionUser: options.sessionUser,
      });
      yield "OpenClaw streamed reply。";
    },
  };
  await withPipeline(provider, {
    openaiCompatible: { streamingEquivalentEnabled: false },
  }, async (pipeline) => {
    await pipeline._test.processUserInput("stream check");
  });
  assert.deepEqual(observed, [{ hasFlag: false, sessionUser: "meet-provider-pipeline-alpha" }]);
});

test("historyMaxTurns=0 sends only system and latest user on later successful turns", { concurrency: false }, async () => {
  const calls = [];
  const provider = {
    name: "openai-compatible",
    streamChat: async function* (messages) {
      calls.push(messages.map((message) => ({ ...message })));
      yield `reply:${messages.at(-1).content}。`;
    },
  };

  await withPipeline(provider, { historyMaxTurns: 0 }, async (pipeline) => {
    await pipeline._test.processUserInput("first");
    await pipeline._test.processUserInput("second");
  });

  assert.deepEqual(calls, [
    [
      { role: "system", content: "standalone system" },
      { role: "user", content: "first" },
    ],
    [
      { role: "system", content: "standalone system" },
      { role: "user", content: "second" },
    ],
  ]);
});

test("barge-in during final-buffer TTS does not add the unheard turn to client history", { concurrency: false }, async () => {
  const calls = [];
  let abortCurrent;
  const provider = {
    name: "openai-compatible",
    streamChat: async function* (messages) {
      calls.push(messages.map((message) => ({ ...message })));
      yield messages.at(-1).content === "barge" ? "short" : "heard。";
    },
  };

  await withPipeline(provider, {}, async (pipeline, session) => {
    abortCurrent = pipeline._test.abortCurrent;
    await pipeline._test.processUserInput("barge");
    assert.equal(session.conversationLog.some((entry) => entry.role === "assistant" && entry.content === "short"), true);

    await pipeline._test.processUserInput("after");
    assert.deepEqual(calls[1].map((message) => message.content), ["standalone system", "after"]);
  }, {
    synthesize: async (text, { onAudio }) => {
      if (text === "short") abortCurrent();
      onAudio(Buffer.alloc(2));
    },
  });
});
