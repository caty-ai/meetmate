"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const TIMEOUT_LINE = "[empathetic, unhurried] ごめん、ちょっと時間がかかってるね。少し待ってもらえるかな？";
const GATEWAY_TOKEN = ["to", "k"].join("");
const src = path.join(__dirname, "..", "src");
const pipelinePath = path.join(src, "pipeline.js");

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

async function waitForAbort(signal) {
  if (!signal || signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

async function withPipeline(provider, fn) {
  const files = ["pipeline.js", "llm-provider.js", "stt-provider.js", "tts-fish.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  const previousEnv = {
    WAKE_WORDS: process.env.WAKE_WORDS,
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    POST_UTTERANCE_BUFFER_MS: process.env.POST_UTTERANCE_BUFFER_MS,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
  };
  const spoken = [];
  const warnings = [];
  const stt = Object.assign(new EventEmitter(), { send() {}, close() {} });
  const originalWarn = console.warn;
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  let pipeline;

  try {
    console.warn = (...args) => warnings.push(args.join(" "));
    Object.assign(process.env, {
      WAKE_WORDS: "zznever",
      ENABLE_IMMEDIATE_ACK: "false",
      ENABLE_PROGRESS_GUARD: "false",
      POST_UTTERANCE_BUFFER_MS: "0",
      TTS_GAP_MS: "0",
      SENTENCE_PAUSE_MS: "0",
    });
    for (const file of files) delete require.cache[require.resolve(file)];
    require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(
      path.join(src, "stt-provider.js"),
      { createSTT: () => stt, buildKeyterms: () => [] },
    );
    require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(
      path.join(src, "llm-provider.js"),
      { createLlmProvider: () => provider },
    );
    require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(
      path.join(src, "tts-fish.js"),
      {
        synthesize: async (text, { onAudio }) => {
          spoken.push(text);
          onAudio(Buffer.alloc(2));
        },
      },
    );

    settingsBootstrap.resetStartupForTest();
    settingsResolver.resetRuntimeForTest();

    const { createPipeline } = require(pipelinePath);
    pipeline = createPipeline(
      { id: "pipeline-timeout-stage", conversationLog: [], config: { wakeMode: "wake" } },
      { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 },
      () => {},
      {
        dgKey: "x",
        fishKey: "x",
        stt: { model: "test", language: "ja", sampleRate: 16_000 },
        tts: { referenceId: null, sampleRate: 16_000, latency: "balanced", speed: 1 },
        llm: {
          provider: "openclaw",
          model: "test",
          responseTimeoutMs: 30,
          firstTokenDelegateMs: 0,
          gateway: { url: "http://gateway.test", token: GATEWAY_TOKEN },
        },
        hub: { enabled: false },
        gatewayEvents: { enabled: false },
        greeting: "",
        echoCooldownMs: 0,
      },
      {
        agentProfile: { agentId: "alpha", wakeWords: ["alpha"] },
        suppressGreeting: true,
        _testExposeInternals: true,
      },
    );

    await fn({ pipeline, spoken, warnings });
  } finally {
    console.warn = originalWarn;
    pipeline?.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      if (previousCache.get(resolved)) require.cache[resolved] = previousCache.get(resolved);
    }
  }
}

test("LLM first-response timeout log reports the stalled stage and preserves timeout fallback behavior", { concurrency: false }, async (t) => {
  const rows = [
    {
      name: "gateway_no_response when the gateway never answers",
      streamChatFactory(onAbort) {
        return async function* (_messages, options) {
          await waitForAbort(options.signal);
          onAbort(options.signal.aborted);
        };
      },
      verify(line) {
        assert.equal(line.includes("stage=gateway_no_response"), true);
        assert.equal(line.includes("request_sent=+0ms"), true);
        assert.equal(line.includes("gateway_response=none"), true);
        assert.equal(line.includes("stream_event=none"), true);
        assert.equal(line.includes("tts=not_started"), true);
      },
    },
    {
      name: "agent_no_output when the gateway answered but no stream event arrived",
      streamChatFactory(onAbort) {
        return async function* (_messages, options) {
          options.onResponseStart?.({ statusCode: 200 });
          await waitForAbort(options.signal);
          onAbort(options.signal.aborted);
        };
      },
      verify(line) {
        assert.equal(line.includes("stage=agent_no_output"), true);
        assert.match(line, /gateway_response=HTTP 200 \+\d+ms/);
        assert.equal(line.includes("stream_event=none"), true);
        assert.equal(line.includes("tts=not_started"), true);
      },
    },
    {
      name: "stream_no_content when the stream opened but emitted no content chunk",
      streamChatFactory(onAbort) {
        return async function* (_messages, options) {
          options.onResponseStart?.({ statusCode: 200 });
          options.onFirstEvent?.();
          await waitForAbort(options.signal);
          onAbort(options.signal.aborted);
        };
      },
      verify(line) {
        assert.equal(line.includes("stage=stream_no_content"), true);
        assert.match(line, /gateway_response=HTTP 200 \+\d+ms/);
        assert.match(line, /stream_event=\+\d+ms/);
        assert.equal(line.includes("tts=not_started"), true);
      },
    },
  ];

  for (const row of rows) {
    await t.test(row.name, async () => {
      let abortSeen = false;
      await withPipeline(
        { name: "openclaw", streamChat: row.streamChatFactory((value) => { abortSeen = value; }) },
        async ({ pipeline, spoken, warnings }) => {
          await pipeline._test.processUserInput("調べてまとめて");

          const line = warnings.find((entry) => entry.startsWith("⏱️  LLM first-response timeout ("));
          assert.ok(line, "expected first-response timeout warning");
          row.verify(line);
          assert.equal(spoken.includes(TIMEOUT_LINE), true);
        },
      );
      assert.equal(abortSeen, true);
    });
  }
});

test("LLM first-response timeout log stays absent when content arrives before the timer", { concurrency: false }, async () => {
  await withPipeline(
    {
      name: "openclaw",
      streamChat: async function* () {
        yield "これは通常の応答です。";
      },
    },
    async ({ pipeline, spoken, warnings }) => {
      await pipeline._test.processUserInput("普通に答えて");

      assert.equal(warnings.some((entry) => entry.startsWith("⏱️  LLM first-response timeout (")), false);
      assert.equal(spoken.includes(TIMEOUT_LINE), false);
      assert.equal(spoken.includes("これは通常の応答です。"), true);
    },
  );
});
