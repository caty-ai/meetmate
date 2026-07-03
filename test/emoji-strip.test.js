const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { buildVoiceAddendum } = require("../src/llm");
const { stripEmojis } = require("../src/speech-policy");
const { cacheKey } = require("../src/tts-cache");

describe("stripEmojis()", () => {
  it("strips emoji and emoji sequence code points", () => {
    assert.equal(stripEmojis("了解！👍"), "了解！");
    assert.equal(stripEmojis("すごい🎉🎉ですね"), "すごいですね");
    assert.equal(stripEmojis("🇯🇵は…"), "は…");
    assert.equal(stripEmojis("1️⃣"), "");
    assert.equal(stripEmojis("1︎⃣"), "");
    assert.equal(stripEmojis("👨‍👩‍👧‍👦"), "");
    assert.equal(stripEmojis("👋🏽"), "");
    assert.equal(stripEmojis("☀️今日は晴れ"), "今日は晴れ");
    assert.equal(stripEmojis("★おすすめ☆"), "おすすめ");
    assert.equal(stripEmojis("♪こんにちは♬"), "こんにちは");
    assert.equal(stripEmojis("🏴󠁧󠁢󠁥󠁮󠁧󠁿"), "");
  });

  it("preserves emotion tags and ordinary speech text", () => {
    const inputs = [
      "[soft voice] 了解です。ちょっと待ってね。",
      "(grateful) いま処理中だよ、もう少し待ってね。",
      "温度は25℃→30℃です",
      "©2026 Re-plus",
      "矢印は↑↓←→",
      "音程は〜こんな感じ",
      "「了解しました」。準備できましたか？はい、大丈夫です！",
      "© ® ™ ↑ ↓ → ← ㊙ 〽",
      "※注意",
      "〒100-0001",
      "重要‼",
      "本当⁉",
      "〽そういうこと",
    ];

    for (const input of inputs) {
      assert.equal(stripEmojis(input), input);
    }
  });

  it("returns an empty string when only emoji remain", () => {
    assert.equal(stripEmojis("🎉🎉"), "");
  });

  it("removes Unicode tag characters from subdivision flags", () => {
    const result = stripEmojis("🏴󠁧󠁢󠁥󠁮󠁧󠁿");

    assert.equal(result, "");
    assert.equal(/[\u{E0000}-\u{E007F}]/u.test(result), false);
  });
});

describe("emoji stripping cache-key consistency", () => {
  it("is idempotent for emoji, non-emoji, and empty-stripped strings", () => {
    const samples = [
      "了解！👍 [soft voice] テスト🎉",
      "[soft voice] 了解です。",
      "🎉🎉",
    ];

    for (const sample of samples) {
      assert.equal(stripEmojis(stripEmojis(sample)), stripEmojis(sample));
    }
  });

  it("keeps stripped cache keys stable and distinct from raw emoji-bearing text", () => {
    const text = "[soft voice] 確認します👍";
    const params = { referenceId: null, sampleRate: 24_000, speed: 1.0 };

    assert.equal(
      cacheKey(stripEmojis(text), params),
      cacheKey(stripEmojis(stripEmojis(text)), params)
    );
    assert.notEqual(cacheKey(stripEmojis(text), params), cacheKey(text, params));
  });
});

describe("buildVoiceAddendum()", () => {
  it("includes the emoji-ban voice rule", () => {
    assert.match(buildVoiceAddendum(), /絵文字は使わない/);
  });
});

describe("pipeline TTS emoji stripping", () => {
  it("passes cleaned utterance text to synthesize", async () => {
    await withEnvAsync(
      {
        POST_UTTERANCE_BUFFER_MS: "0",
        ENABLE_PROGRESS_GUARD: "false",
        TTS_GAP_MS: "0",
        TTS_LEAD_MS: "0",
        SENTENCE_PAUSE_MS: "0",
        WAKE_WORDS: "ケイティ",
      },
      async () => {
        const spoken = [];

        await withFreshPipelineModule(
          ({ createPipeline }) => {
            const session = { id: "emoji-strip-test", conversationLog: [], config: { wakeMode: "wake" } };
            const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
            const config = {
              dgKey: "x",
              fishKey: "x",
              openclawUrl: "http://localhost:9",
              openclawToken: "x",
              stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
              llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, openclawSystemAddendum: "" },
              tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
              ackVariants: ["[soft voice] 確認します👍"],
              echoCooldownMs: 1,
              greeting: "",
              exitDetection: false,
            };

            const pipeline = createPipeline(session, turnState, () => {}, config, {
              agents: { caty: { wakeWords: ["ケイティ"] } },
              selectedAgentIds: ["caty"],
              defaultAgentId: "caty",
              _testExposeInternals: true,
            });

            return pipeline._test.handleUtteranceEnd("ケイティ、確認して")
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
                onAudio(Buffer.alloc(4));
              },
            },
          }
        );

        assert.deepEqual(spoken, ["[soft voice] 確認します"]);
      }
    );
  });
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
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
