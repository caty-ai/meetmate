const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const readiness = require("../src/settings/readiness");

test("Fish synthesize contract streams aligned PCM16 at 24 kHz and resolves void", async (t) => {
  const resolver = require("../src/settings/resolver");
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: {}, revision: "a".repeat(64), fingerprint: "fish-contract" },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}), dotenvSeeds: Object.freeze({}),
      resolvedHome: "/tmp/fish-contract", configPath: "/tmp/fish-contract/config.json",
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
  });
  const originalRequest = https.request;
  let requestOptions;
  let requestBody = "";
  const events = [];
  https.request = (options, callback) => {
    requestOptions = options;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => error && req.emit("error", error);
    req.write = (chunk) => { requestBody += String(chunk); };
    req.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from([1]));
      response.emit("data", Buffer.from([2, 3, 4]));
      response.emit("end");
    });
    return req;
  };
  t.after(() => {
    https.request = originalRequest;
    readiness.reset();
    resolver.resetRuntimeForTest();
  });

  const { synthesize } = require("../src/tts-fish");
  const returned = await synthesize(" contract ", {
    apiKey: "fish-key",
    onAudio: (chunk) => events.push(Buffer.from(chunk)),
  });

  assert.equal(returned, undefined);
  assert.deepEqual(events, [Buffer.from([1, 2, 3, 4])]);
  assert.equal(events.every((chunk) => chunk.length % 2 === 0), true);
  assert.deepEqual(
    { hostname: requestOptions.hostname, path: requestOptions.path, method: requestOptions.method },
    { hostname: "api.fish.audio", path: "/v1/tts", method: "POST" },
  );
  assert.deepEqual(JSON.parse(requestBody), {
    text: "contract", format: "pcm", sample_rate: 24_000, latency: "balanced",
    temperature: 0.7, top_p: 0.7, chunk_length: 300, normalize: true,
  });
});

test("Fish runtime 402 records PAYMENT_REQUIRED through the real synthesize path", async (t) => {
  const resolver = require("../src/settings/resolver");
  resolver.resetRuntimeForTest();
  readiness.reset();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: {}, revision: "a".repeat(64), fingerprint: "a".repeat(64) },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}), dotenvSeeds: Object.freeze({}),
      resolvedHome: "/tmp/fish-runtime-hook", configPath: "/tmp/fish-runtime-hook/config.json",
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
  });
  const originalRequest = https.request;
  https.request = (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 402;
      response.headers = {};
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.from("payment"));
        response.emit("end");
      });
    };
    return req;
  };
  t.after(() => {
    https.request = originalRequest;
    readiness.reset();
    resolver.resetRuntimeForTest();
  });

  const { synthesize } = require("../src/tts-fish");
  await assert.rejects(() => synthesize("test", { apiKey: "key", sampleRate: 8_000, onAudio: () => {} }), /402/);
  assert.equal(readiness.inspect("fish-audio").code, "PAYMENT_REQUIRED");
  assert.equal(readiness.inspect("fish-audio").source, "runtime");
});

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
      bodies.push(body);
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
  const options = { apiKey: "key", referenceId: "voice-33", sampleRate: 8_000, latency: "low", speed: 1.25, onAudio: () => {} };

  setEmotionTags(false);
  await synthesize(taggedText, options);
  setEmotionTags(true);
  await synthesize(taggedText, options);

  assert.equal(bodies[0], '{"text":"hello","format":"pcm","sample_rate":8000,"latency":"low",'
    + '"temperature":0.7,"top_p":0.7,"chunk_length":300,"normalize":true,'
    + '"reference_id":"voice-33","speed":1.25,"prosody":{"speed":1.25}}');
  assert.equal(JSON.parse(bodies[1]).text, taggedText);
  assert.deepEqual(JSON.parse(bodies[1]).prosody, { speed: 1.25 });
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
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  settingsBootstrap.resetStartupForTest();
  settingsResolver.resetRuntimeForTest();
  try {
    return await fn();
  } finally {
    restoreEnv(previous);
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
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
