const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const src = path.join(__dirname, "..", "src");

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
