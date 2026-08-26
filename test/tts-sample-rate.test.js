const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const https = require("node:https");

test("getPipelineConfig keeps STT at 16k and defaults TTS to 24k", () => {
  withEnv({ TTS_SAMPLE_RATE: undefined }, () => {
    const { getPipelineConfig } = freshConfig();
    const config = getPipelineConfig();

    assert.equal(config.stt.sampleRate, 16_000);
    assert.equal(config.tts.sampleRate, 24_000);
  });
});

test("TTS_SAMPLE_RATE overrides only the TTS output rate", () => {
  withEnv({ TTS_SAMPLE_RATE: "16000" }, () => {
    const { getPipelineConfig } = freshConfig();
    const config = getPipelineConfig();

    assert.equal(config.stt.sampleRate, 16_000);
    assert.equal(config.tts.sampleRate, 16_000);
  });
});

test("sentence-boundary silence uses the TTS sample rate", async () => {
  await withEnvAsync(
    {
      POST_UTTERANCE_BUFFER_MS: "0",
      ENABLE_IMMEDIATE_ACK: "false",
      ENABLE_PROGRESS_GUARD: "false",
      TTS_GAP_MS: "0",
      SENTENCE_PAUSE_MS: "100",
      WAKE_WORDS: "ケイティ",
    },
    async () => {
      const src = path.join(__dirname, "..", "src");
      const paths = [
        path.join(src, "stt-provider.js"),
        path.join(src, "stt.js"),
        path.join(src, "llm-provider.js"),
        path.join(src, "tts-fish.js"),
        path.join(src, "pipeline.js"),
      ];
      const previousCache = new Map(paths.map((p) => [require.resolve(p), require.cache[require.resolve(p)]]));
      for (const p of paths) delete require.cache[require.resolve(p)];

      const sttExports = {
        createSTT: () => {
          const sttEmitter = new EventEmitter();
          sttEmitter.send = () => {};
          sttEmitter.close = () => {};
          return sttEmitter;
        },
        buildKeyterms: () => [],
      };
      const spoken = [];

      require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
      require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
      const llmMock = {
        streamChat: async function* () {
          yield "これは最初の文章です。";
          yield "これは次の文章です。";
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      };
      require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
        createLlmProvider: () => ({ name: "openclaw", ...llmMock }),
      });
      require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
        synthesize: async (text, { onAudio }) => {
          spoken.push(text);
          onAudio(Buffer.alloc(4));
        },
      });

      try {
        const { createPipeline } = require(path.join(src, "pipeline.js"));
        const session = { id: "tts-rate-test", conversationLog: [], config: { wakeMode: "wake" } };
        const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
        const config = {
          dgKey: "x",
          fishKey: "x",
          openclawUrl: "http://localhost:9",
          openclawToken: "x",
          stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
          llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, openclawSystemAddendum: "" },
          tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
          echoCooldownMs: 1,
          greeting: "",
          exitDetection: false,
        };
        const audio = [];
        const pipeline = createPipeline(session, turnState, (buffer) => audio.push(buffer), config, {
          agents: { caty: { wakeWords: ["ケイティ"] } },
          selectedAgentIds: ["caty"],
          defaultAgentId: "caty",
          _testExposeInternals: true,
        });

        await pipeline._test.handleUtteranceEnd("ケイティ、準備して");
        audio.length = 0;
        spoken.length = 0;

        await pipeline._test.handleUtteranceEnd("ケイティ、続けて");
        pipeline.close();

        assert.equal(spoken.length, 2);
        assert.deepEqual(audio.map((buffer) => buffer.length), [4, 4800, 4]);
      } finally {
        for (const p of paths) {
          const resolved = require.resolve(p);
          delete require.cache[resolved];
          const previous = previousCache.get(resolved);
          if (previous) require.cache[resolved] = previous;
        }
      }
    }
  );
});

test("Fish TTS strips only canonical emotion tags when the live toggle is OFF", async (t) => {
  const resolver = require("../src/settings/resolver");
  const { EMOTION_TAGS } = require("../src/messages");
  const originalRequest = https.request;
  const bodies = [];
  https.request = (_options, callback) => {
    const req = new EventEmitter();
    let body = "";
    req.write = (chunk) => { body += String(chunk); };
    req.setTimeout = () => req;
    req.destroy = (error) => error && req.emit("error", error);
    req.end = () => process.nextTick(() => {
      bodies.push(JSON.parse(body));
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from([0, 0]));
      response.emit("end");
    });
    return req;
  };
  t.after(() => {
    https.request = originalRequest;
    resolver.resetRuntimeForTest();
  });

  const setEmotionTags = (enabled) => {
    resolver.resetRuntimeForTest();
    resolver.initializeRuntime({
      state: {
        exists: true,
        valid: true,
        parsed: { agent: { emotionTags: enabled } },
        revision: "a".repeat(64),
        fingerprint: "tts-emotion-test",
      },
      startup: Object.freeze({
        preDotenvEnv: Object.freeze({}),
        dotenvSeeds: Object.freeze({}),
        resolvedHome: "/tmp/meetmate-tts-emotion-test",
        configPath: "/tmp/meetmate-tts-emotion-test/config.json",
        connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
      }),
    });
  };
  const taggedText = `${EMOTION_TAGS[0].tag} hello ${EMOTION_TAGS[1].tag}`;
  const { synthesize } = require("../src/tts-fish");

  setEmotionTags(false);
  await synthesize(taggedText, { apiKey: "key", onAudio: () => {} });
  setEmotionTags(true);
  await synthesize(taggedText, { apiKey: "key", onAudio: () => {} });

  assert.equal(bodies[0].text, "hello");
  assert.equal(bodies[1].text, taggedText);
});

function freshConfig() {
  require("../src/settings/bootstrap").resetStartupForTest();
  require("../src/settings/resolver").resetRuntimeForTest();
  const configPath = path.join(__dirname, "..", "src", "config.js");
  delete require.cache[require.resolve(configPath)];
  return require(configPath);
}

function cacheEntry(filename, exports) {
  return {
    id: filename,
    filename,
    loaded: true,
    exports,
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

async function withEnvAsync(values, fn) {
  const previous = setEnv(values);
  try {
    return await fn();
  } finally {
    restoreEnv(previous);
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
