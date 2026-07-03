const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

test("generateSilence emits bounded comfort noise by default", async () => {
  // WAKE_WORDS must be set before requiring pipeline.js: without it the module
  // falls back to resolveAgentProfile() → loadConfig(), which fail-fast-exits on
  // hosts where config.json exists but its ${ENV} placeholders are unresolved.
  await withEnvAsync({ COMFORT_NOISE_AMPLITUDE: undefined, WAKE_WORDS: "ケイティ" }, async () => {
    await withFreshPipelineModule(({ _test }) => {
      const restoreRandom = stubRandom([0, 0.5, 0.999, 0.25]);
      try {
        const buffer = _test.generateSilence(10, 1000);
        assert.equal(buffer.length, 20);

        let hasNonZero = false;
        let maxAbs = 0;
        for (let i = 0; i < buffer.length; i += 2) {
          const sample = buffer.readInt16LE(i);
          if (sample !== 0) hasNonZero = true;
          maxAbs = Math.max(maxAbs, Math.abs(sample));
        }

        assert.equal(hasNonZero, true);
        assert.ok(maxAbs <= 30, `expected max abs sample <= 30, got ${maxAbs}`);
      } finally {
        restoreRandom();
      }
    });
  });
});

test("COMFORT_NOISE_AMPLITUDE=0 restores byte-exact zero silence", async () => {
  await withEnvAsync({ COMFORT_NOISE_AMPLITUDE: "0", WAKE_WORDS: "ケイティ" }, async () => {
    await withFreshPipelineModule(({ _test }) => {
      const restoreRandom = stubRandom(() => {
        throw new Error("Math.random should not be called when amplitude is 0");
      });
      try {
        const buffer = _test.generateSilence(7, 8000);
        assert.deepEqual(buffer, Buffer.alloc(112));
      } finally {
        restoreRandom();
      }
    });
  });
});

test("first utterance is preceded by TTS_LEAD_MS pad before TTS audio", async () => {
  await withEnvAsync(
    {
      POST_UTTERANCE_BUFFER_MS: "0",
      ENABLE_IMMEDIATE_ACK: "false",
      ENABLE_PROGRESS_GUARD: "false",
      TTS_GAP_MS: "0",
      TTS_LEAD_MS: "100",
      SENTENCE_PAUSE_MS: "0",
      COMFORT_NOISE_AMPLITUDE: "0",
      WAKE_WORDS: "ケイティ",
    },
    async () => {
      const spoken = [];
      const audio = [];

      await withFreshPipelineModule(
        ({ createPipeline }) => {
          const session = { id: "comfort-noise-test", conversationLog: [], config: { wakeMode: "wake" } };
          const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
          const config = {
            dgKey: "x",
            fishKey: "x",
            openclawUrl: "http://localhost:9",
            openclawToken: "x",
            stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
            llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, openclawSystemAddendum: "" },
            tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
            ackVariants: ["[soft voice] はい。"],
            echoCooldownMs: 1,
            greeting: "",
            exitDetection: false,
          };

          const pipeline = createPipeline(session, turnState, (buffer) => audio.push(buffer), config, {
            agents: { caty: { wakeWords: ["ケイティ"] } },
            selectedAgentIds: ["caty"],
            defaultAgentId: "caty",
            _testExposeInternals: true,
          });

          return pipeline._test.handleUtteranceEnd("ケイティ、準備して")
            .then(() => {
              pipeline.close();
            });
        },
        {
          llm: {
            streamChat: async function* () {},
            VOICE_SYSTEM_ADDENDUM: "",
            buildVoiceAddendum: () => "",
          },
          tts: {
            synthesize: async (text, { onAudio }) => {
              spoken.push(text);
              onAudio(Buffer.from([1, 2, 3, 4]));
            },
          },
        }
      );

      assert.equal(spoken.length, 1);
      assert.equal(audio[0].length, 4800);
      assert.deepEqual(audio[0], Buffer.alloc(4800));
      assert.deepEqual(audio[1], Buffer.from([1, 2, 3, 4]));
    }
  );
});

async function withFreshPipelineModule(fn, overrides = {}) {
  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm.js"),
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

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), overrides.stt || sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), overrides.stt || sttExports);
  require.cache[require.resolve(path.join(src, "llm.js"))] = cacheEntry(path.join(src, "llm.js"), overrides.llm || {
    streamChat: async function* () {},
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), overrides.tts || {
    synthesize: async (_text, { onAudio }) => {
      onAudio(Buffer.alloc(4));
    },
  });

  try {
    return await fn(require(path.join(src, "pipeline.js")));
  } finally {
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

function stubRandom(valuesOrFn) {
  const original = Math.random;
  if (typeof valuesOrFn === "function") {
    Math.random = valuesOrFn;
  } else {
    let index = 0;
    Math.random = () => {
      const value = valuesOrFn[index % valuesOrFn.length];
      index += 1;
      return value;
    };
  }
  return () => {
    Math.random = original;
  };
}
