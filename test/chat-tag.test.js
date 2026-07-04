const { EventEmitter } = require("node:events");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { extractChatTags } = require("../src/speech-policy");

describe("extractChatTags()", () => {
  it("removes a mid-sentence tag and preserves surrounding speech", () => {
    const result = extractChatTags("資料は[[[chat: https://example.com ]]]あとで見てね。");
    assert.equal(result.speech, "資料はあとで見てね。");
    assert.deepEqual(result.chats, ["https://example.com"]);
    assert.equal(result.holdback, "");
  });

  it("re-prepends holdback when a tag is split across pushes", () => {
    let buffer = "資料はこれ！";
    let result = extractChatTags(`${buffer}[[[cha`);
    assert.equal(result.speech, "資料はこれ！");
    assert.equal(result.holdback, "[[[cha");

    buffer = result.speech;
    result = extractChatTags(`${buffer}${result.holdback}t: https://example.com/a?x=1]]]あとで見てね。`);
    assert.equal(result.speech, "資料はこれ！あとで見てね。");
    assert.deepEqual(result.chats, ["https://example.com/a?x=1"]);
    assert.equal(result.holdback, "");
  });

  it("keeps sentence punctuation, newlines, URLs, and emoji in chat content", () => {
    const result = extractChatTags("貼るね[[[chat: https://example.com/a?x=1。詳細！？\nOK👍]]]終わり。");
    assert.equal(result.speech, "貼るね終わり。");
    assert.deepEqual(result.chats, ["https://example.com/a?x=1。詳細！？\nOK👍"]);
  });

  it("extracts multiple tags in one response", () => {
    const result = extractChatTags("A[[[chat: one]]]B[[[CHAT: two]]]C");
    assert.equal(result.speech, "ABC");
    assert.deepEqual(result.chats, ["one", "two"]);
    assert.equal(result.holdback, "");
  });

  it("holds an unterminated tag at stream end", () => {
    const result = extractChatTags("口頭だけ。[[[chat: 未終了の詳細");
    assert.equal(result.speech, "口頭だけ。");
    assert.deepEqual(result.chats, []);
    assert.equal(result.holdback, "[[[chat: 未終了の詳細");
  });

  it("skips empty tags", () => {
    const result = extractChatTags("前[[[chat:    ]]]後");
    assert.equal(result.speech, "前後");
    assert.deepEqual(result.chats, []);
    assert.equal(result.holdback, "");
  });

  it("does not strip emojis from chat content", () => {
    const result = extractChatTags("[[[chat: 了解👍🎉]]]");
    assert.equal(result.speech, "");
    assert.deepEqual(result.chats, ["了解👍🎉"]);
  });

  it("releases literal bracket text once it is clearly not a chat tag", () => {
    let result = extractChatTags("普通の[[");
    assert.equal(result.speech, "普通の");
    assert.equal(result.holdback, "[[");

    result = extractChatTags(`${result.speech}${result.holdback}xです`);
    assert.equal(result.speech, "普通の[[xです");
    assert.deepEqual(result.chats, []);
    assert.equal(result.holdback, "");
  });

  it("never leaks holdback into speech", () => {
    const result = extractChatTags("話す部分[[[ch");
    assert.equal(result.speech, "話す部分");
    assert.equal(result.holdback, "[[[ch");
    assert.ok(!result.speech.includes("[[[ch"));
  });

  it("holds a trailing partial prefix before an unterminated tag", () => {
    const result = extractChatTags("[[[c[[[chat: y");
    assert.ok(!result.speech.includes("["));
    assert.ok(result.holdback.includes("[[[c"));
    assert.ok(result.holdback.includes("[[[chat: y"));
    assert.equal(result.holdback, "[[[c[[[chat: y");
  });

  it("captures a chat tag when the closing marker is split across pushes", () => {
    let result = extractChatTags("[[[chat: https://example.com/split]]");
    assert.equal(result.speech, "");
    assert.deepEqual(result.chats, []);
    assert.equal(result.holdback, "[[[chat: https://example.com/split]]");

    result = extractChatTags(`${result.speech}${result.holdback}]`);
    assert.equal(result.speech, "");
    assert.deepEqual(result.chats, ["https://example.com/split"]);
    assert.equal(result.holdback, "");
  });
});

describe("pipeline chat tags", () => {
  it("speaks tag-stripped text and emits one chat message", async () => {
    const spoken = [];
    const chats = [];

    await withEnvAsync(
      {
        ENABLE_IMMEDIATE_ACK: "false",
        ENABLE_PROGRESS_GUARD: "false",
        POST_UTTERANCE_BUFFER_MS: "0",
        TTS_GAP_MS: "0",
        TTS_LEAD_MS: "0",
        SENTENCE_PAUSE_MS: "0",
        WAKE_WORDS: "ケイティ",
      },
      async () => {
        await withFreshPipelineModule(
          async ({ createPipeline }) => {
            const session = { id: "chat-tag-pipeline-test", conversationLog: [], config: { wakeMode: "wake" } };
            const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
            const config = basePipelineConfig();

            const pipeline = createPipeline(session, turnState, () => {}, config, {
              agents: { caty: { wakeWords: ["ケイティ"] } },
              selectedAgentIds: ["caty"],
              defaultAgentId: "caty",
              onChatMessage: (text) => chats.push(text),
              _testExposeInternals: true,
            });

            await pipeline._test.handleUtteranceEnd("ケイティ、こんにちは");
            pipeline.close();
          },
          {
            llm: {
              streamChat: async function* () {
                yield "チャットに貼っておくね。[[[cha";
                yield "t: https://example.com/a?x=1。詳細👍]]]";
              },
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
      }
    );

    assert.ok(spoken.includes("チャットに貼っておくね。"));
    assert.equal(spoken.some((text) => text.includes("[[[chat:")), false);
    assert.deepEqual(chats, ["https://example.com/a?x=1。詳細👍"]);
  });

  it("salvages an unterminated final chat tag without speaking tag fragments", async () => {
    const { spoken, chats } = await runPipelineChatStream([
      "貼るね。[[[chat: https://x.example/incomplete",
    ]);

    assert.equal(spoken.some((text) => text.includes("[[[")), false);
    assert.deepEqual(chats, ["https://x.example/incomplete"]);
  });

  it("emits a complete chat-only response without speaking", async () => {
    const { spoken, chats } = await runPipelineChatStream([
      "[[[chat: https://example.com/only]]]",
    ]);

    assert.deepEqual(spoken, []);
    assert.deepEqual(chats, ["https://example.com/only"]);
  });

  it("does not let a leading chat tag reach the first-chunk early-speak path", async () => {
    const { spoken, chats } = await runPipelineChatStream([
      "[[[chat: https://example.com/first]]]これは句点なしで長めの本文です",
    ]);

    assert.equal(spoken.some((text) => text.includes("[[[")), false);
    assert.deepEqual(spoken, ["これは句点なしで長めの本文です"]);
    assert.deepEqual(chats, ["https://example.com/first"]);
  });
});

async function runPipelineChatStream(chunks) {
  const spoken = [];
  const chats = [];
  let streamCallCount = 0;

  await withEnvAsync(
    {
      ENABLE_IMMEDIATE_ACK: "false",
      ENABLE_PROGRESS_GUARD: "false",
      POST_UTTERANCE_BUFFER_MS: "0",
      TTS_GAP_MS: "0",
      TTS_LEAD_MS: "0",
      SENTENCE_PAUSE_MS: "0",
      WAKE_WORDS: "ケイティ",
    },
    async () => {
      await withFreshPipelineModule(
        async ({ createPipeline }) => {
          const session = { id: `chat-tag-pipeline-${Date.now()}`, conversationLog: [], config: { wakeMode: "wake" } };
          const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
          const config = basePipelineConfig();

          const pipeline = createPipeline(session, turnState, () => {}, config, {
            agents: { caty: { wakeWords: ["ケイティ"] } },
            selectedAgentIds: ["caty"],
            defaultAgentId: "caty",
            onChatMessage: (text) => chats.push(text),
            _testExposeInternals: true,
          });

          await pipeline._test.handleUtteranceEnd("ケイティ、準備");
          spoken.length = 0;
          chats.length = 0;
          await pipeline._test.handleUtteranceEnd("ケイティ、こんにちは");
          pipeline.close();
        },
        {
          llm: {
            streamChat: async function* () {
              streamCallCount += 1;
              if (streamCallCount === 1) {
                yield "NO_REPLY";
                return;
              }
              for (const chunk of chunks) yield chunk;
            },
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
    }
  );

  return { spoken, chats };
}

function basePipelineConfig() {
  return {
    dgKey: "x",
    fishKey: "x",
    openclawUrl: "http://localhost:9",
    openclawToken: "x",
    stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
    llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, openclawSystemAddendum: "" },
    tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
    ackVariants: [],
    echoCooldownMs: 1,
    greeting: "",
    exitDetection: false,
  };
}

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
