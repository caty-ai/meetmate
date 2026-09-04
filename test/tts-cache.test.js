const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");

const { createTtsCache, _test } = require("../src/tts-cache");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("cache key changes with content inputs and ignores streaming-only inputs", () => {
  withEnv({ FISH_AUDIO_MODEL: "s2-pro" }, () => {
    const base = { referenceId: "voice-a", sampleRate: 24_000, speed: 1.0, latency: "balanced", apiKey: "a" };
    const key = _test.cacheKey("[soft voice] はい。", base);

    assert.equal(_test.cacheKey("[soft voice] はい。", { ...base, latency: "normal", apiKey: "b" }), key);
    assert.equal(_test.cacheKey("[soft voice] はい。", { ...base }), key);
    assert.notEqual(_test.cacheKey("[soft voice] 了解。", base), key);
    assert.notEqual(_test.cacheKey("[soft voice] はい。", { ...base, referenceId: "voice-b" }), key);
    assert.notEqual(_test.cacheKey("[soft voice] はい。", { ...base, sampleRate: 16_000 }), key);
    assert.notEqual(_test.cacheKey("[soft voice] はい。", { ...base, speed: 1.1 }), key);
  });
});

test("Fish cache keys remain byte-compatible with the pre-provider identity payload", () => {
  const options = {
    referenceId: "legacy-voice",
    model: "s2-pro",
    sampleRate: 24_000,
    speed: 1,
  };
  assert.equal(
    _test.cacheKey("upgrade-compatible fish", options),
    "d0c7d1ce3f61be2ca68d3b5e288532b194157cbe676d2b3f110b82a3031e61b6",
  );
  assert.deepEqual(_test.synthesisIdentity(options), {
    referenceId: "legacy-voice",
    model: "s2-pro",
    sampleRate: 24_000,
    speed: 1,
  });
});

test("new-provider cache namespaces stay disjoint from Fish and use the effective voice override", () => {
  const common = { model: "same-model", sampleRate: 24_000 };
  const fish = _test.cacheKey("same text", { ...common, referenceId: "same-voice", speed: 1 });
  const elevenGlobal = _test.cacheKey("same text", {
    ...common, provider: "elevenlabs", voiceId: "same-voice",
  });
  const elevenOverride = _test.cacheKey("same text", {
    ...common, provider: "elevenlabs", voiceId: "same-voice", referenceId: "agent-voice",
  });
  assert.notEqual(elevenGlobal, fish);
  assert.notEqual(elevenOverride, elevenGlobal);

  const openaiGlobal = _test.cacheKey("same text", {
    ...common, provider: "openai-compatible", baseUrl: "http://tts-a.example", voice: "same-voice",
  });
  const openaiOverride = _test.cacheKey("same text", {
    ...common, provider: "openai-compatible", baseUrl: "http://tts-a.example", voice: "same-voice", referenceId: "agent-voice",
  });
  assert.notEqual(openaiGlobal, fish);
  assert.notEqual(openaiOverride, openaiGlobal);
});

test("OpenAI-compatible cache identity includes the canonical backend base URL", () => {
  const common = {
    provider: "openai-compatible",
    voice: "voice",
    model: "model",
    sampleRate: 24_000,
  };
  assert.notEqual(
    _test.cacheKey("same text", { ...common, baseUrl: "https://tts-a.example" }),
    _test.cacheKey("same text", { ...common, baseUrl: "https://tts-b.example" }),
  );
  assert.equal(
    _test.cacheKey("same text", { ...common, baseUrl: "https://API.OPENAI.COM./" }),
    _test.cacheKey("same text", { ...common, baseUrl: "https://api.openai.com" }),
  );
});

test("a Fish cache entry is never served after switching to ElevenLabs for the same text", async (t) => {
  const resolver = require("../src/settings/resolver");
  const directory = tempDir();
  t.after(() => {
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const startup = Object.freeze({
    preDotenvEnv: Object.freeze({}), dotenvSeeds: Object.freeze({}),
    resolvedHome: directory, configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
  });
  const initialize = (tts, revision) => {
    resolver.resetRuntimeForTest();
    resolver.initializeRuntime({
      state: { exists: true, valid: true, parsed: { tts: { ...tts, cache: { enabled: true } } }, revision, fingerprint: revision },
      startup,
    });
  };
  const calls = [];
  const cache = createTtsCache({
    dir: directory,
    synthesizeFn: async (_text, options) => {
      const provider = resolver.getEffectiveValue("tts_provider");
      calls.push(provider);
      options.onAudio(provider === "fish-audio" ? Buffer.from([1, 2]) : Buffer.from([3, 4]));
    },
  });

  initialize({ provider: "fish-audio", model: "same-model", voiceId: "same-voice" }, "a".repeat(64));
  await cache.synthesize("same text", { referenceId: "same-voice", model: "same-model", onAudio: () => {} });
  initialize({
    provider: "elevenlabs",
    elevenlabs: { apiKey: "key", voiceId: "same-voice", model: "same-model" },
  }, "b".repeat(64));
  const emitted = [];
  await cache.synthesize("same text", { referenceId: "same-voice", model: "same-model", onAudio: (chunk) => emitted.push(Buffer.from(chunk)) });

  assert.deepEqual(calls, ["fish-audio", "elevenlabs"]);
  assert.deepEqual(Buffer.concat(emitted), Buffer.from([3, 4]));
});

test("live emotion toggles use distinct effective text for cache, managed lookup, and synthesis", async (t) => {
  const resolver = require("../src/settings/resolver");
  const directory = tempDir();
  t.after(() => {
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const startup = Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
  });
  const state = (enabled, revision) => ({
    exists: true,
    valid: true,
    parsed: { agent: { emotionTags: enabled }, tts: { cache: { enabled: true } } },
    revision,
    fingerprint: `bytes:${revision}`,
  });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({ state: state(true, "a".repeat(64)), startup });

  const texts = [];
  const cache = createTtsCache({
    dir: path.join(directory, "cache"),
    synthesizeFn: async (text, options) => {
      texts.push(text);
      options.onAudio(Buffer.from([texts.length, texts.length]));
    },
  });
  const phrase = "[soft voice] 了解です";
  const options = { sampleRate: 24_000, speed: 1, onAudio: () => {} };
  const taggedFile = cache.fileFor(_test.effectiveSynthesisText(phrase), options);
  await cache.synthesize(phrase, options);

  resolver.publishState(state(false, "b".repeat(64)));
  const plainFile = cache.fileFor(_test.effectiveSynthesisText(phrase), options);
  await cache.synthesize(phrase, options);
  assert.notEqual(taggedFile, plainFile);
  assert.deepEqual(texts, [phrase, "了解です"]);

  resolver.publishState(state(true, "c".repeat(64)));
  await cache.synthesize(phrase, options);
  assert.deepEqual(texts, [phrase, "了解です"], "OFF then ON reuses only the matching tagged cache");
});

test("effective text is fixed once when a live publish lands during synthesis lookup", async (t) => {
  const resolver = require("../src/settings/resolver");
  const audio = require("../src/settings/audio");
  const directory = tempDir();
  const startup = Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
  });
  const state = (enabled, revision) => ({
    exists: true,
    valid: true,
    parsed: { agent: { emotionTags: enabled }, tts: { cache: { enabled: true } } },
    revision,
    fingerprint: `bytes:${revision}`,
  });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({ state: state(true, "d".repeat(64)), startup });
  const originalLookup = audio.lookupManagedPcm;
  audio.lookupManagedPcm = () => {
    resolver.publishState(state(false, "e".repeat(64)));
    return null;
  };
  t.after(() => {
    audio.lookupManagedPcm = originalLookup;
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const phrase = "[soft voice] fixed once";
  const synthesized = [];
  const options = { sampleRate: 24_000, speed: 1, onAudio: () => {} };
  const cache = createTtsCache({
    dir: path.join(directory, "cache"),
    synthesizeFn: async (text, delegateOptions) => {
      synthesized.push(text);
      delegateOptions.onAudio(Buffer.from([1, 2]));
    },
  });
  await cache.synthesize(phrase, options);

  assert.deepEqual(synthesized, [phrase]);
  assert.equal(fs.existsSync(cache.fileFor(phrase, options)), true);
  assert.equal(fs.existsSync(cache.fileFor("fixed once", options)), false);
});

test("tag-free whitespace keeps the existing ON cache identity when emotion tags are OFF", (t) => {
  const resolver = require("../src/settings/resolver");
  const directory = tempDir();
  const startup = Object.freeze({
    preDotenvEnv: Object.freeze({}), dotenvSeeds: Object.freeze({}), resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
  });
  const state = (enabled, revision) => ({
    exists: true, valid: true, parsed: { agent: { emotionTags: enabled } }, revision, fingerprint: `bytes:${revision}`,
  });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({ state: state(true, "f".repeat(64)), startup });
  t.after(() => {
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const phrase = "keep  internal   spaces";
  const onText = _test.effectiveSynthesisText(phrase);
  resolver.publishState(state(false, "0".repeat(64)));
  const offText = _test.effectiveSynthesisText(phrase);
  assert.equal(onText, phrase);
  assert.equal(offText, phrase);
  assert.equal(_test.cacheKey(onText), _test.cacheKey(offText));
  assert.equal(_test.effectiveSynthesisText("left  [warm]   right"), "left right");
});

test("miss calls synthesize, forwards chunks, and writes emitted PCM", async () => {
  const dir = tempDir();
  const chunks = [Buffer.from([1, 2]), Buffer.from([3, 4, 5, 6])];
  let calls = 0;
  const cache = createTtsCache({
    dir,
    synthesizeFn: async (_text, options) => {
      calls += 1;
      for (const chunk of chunks) options.onAudio(chunk);
    },
  });

  const emitted = [];
  await cache.synthesize("hello", {
    referenceId: "voice",
    sampleRate: 24_000,
    speed: 1,
    onAudio: (chunk) => emitted.push(Buffer.from(chunk)),
  });

  const expected = Buffer.concat(chunks);
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.concat(emitted), expected);
  assert.deepEqual(fs.readFileSync(cache.fileFor("hello", { referenceId: "voice", sampleRate: 24_000, speed: 1 })), expected);
});

test("hit does not call synthesize and emits cached PCM identically", async () => {
  const dir = tempDir();
  const pcm = Buffer.from([10, 11, 12, 13, 14, 15]);
  const cache = createTtsCache({
    dir,
    synthesizeFn: async () => {
      throw new Error("should not synthesize on hit");
    },
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cache.fileFor("cached", { sampleRate: 24_000 }), pcm);

  const emitted = [];
  await cache.synthesize("cached", {
    sampleRate: 24_000,
    onAudio: (chunk) => emitted.push(Buffer.from(chunk)),
  });

  assert.deepEqual(Buffer.concat(emitted), pcm);
});

test("hit playback is paced in 100ms chunks and abortable", async () => {
  const dir = tempDir();
  const oneSecondPcm = Buffer.alloc(24_000 * 2);
  const cache = createTtsCache({
    dir,
    synthesizeFn: async () => {
      throw new Error("should not synthesize on hit");
    },
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cache.fileFor("one second", { sampleRate: 24_000 }), oneSecondPcm);

  const emitted = [];
  const started = performance.now();
  await cache.synthesize("one second", {
    sampleRate: 24_000,
    onAudio: (chunk) => emitted.push(chunk.length),
  });
  const elapsed = performance.now() - started;

  assert.equal(emitted.length, 10);
  assert.deepEqual(emitted, Array(10).fill(4_800));
  assert.ok(elapsed >= 800, `expected paced playback >= 800ms, got ${elapsed}ms`);
  assert.ok(elapsed <= 1500, `expected paced playback <= 1500ms, got ${elapsed}ms`);

  const abort = new AbortController();
  const abortedEmitted = [];
  await cache.synthesize("one second", {
    sampleRate: 24_000,
    signal: abort.signal,
    onAudio: (chunk) => {
      abortedEmitted.push(chunk);
      abort.abort();
    },
  });
  assert.equal(abortedEmitted.length, 1);
});

test("hit playback can abort mid-playback", async () => {
  const dir = tempDir();
  const oneSecondPcm = Buffer.alloc(24_000 * 2);
  const cache = createTtsCache({
    dir,
    synthesizeFn: async () => {
      throw new Error("should not synthesize on hit");
    },
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cache.fileFor("mid abort", { sampleRate: 24_000 }), oneSecondPcm);

  const abort = new AbortController();
  const emitted = [];
  await cache.synthesize("mid abort", {
    sampleRate: 24_000,
    signal: abort.signal,
    onAudio: (chunk) => {
      emitted.push(chunk);
      if (emitted.length === 5) abort.abort();
    },
  });

  assert.equal(emitted.length, 5);
  assert.ok(emitted.length > 1);
  assert.ok(emitted.length < 10);
});

test("aborted miss does not write a cache file", async () => {
  const dir = tempDir();
  const abort = new AbortController();
  const cache = createTtsCache({
    dir,
    synthesizeFn: async (_text, options) => {
      options.onAudio(Buffer.from([1, 2, 3, 4]));
      abort.abort();
    },
  });

  await cache.synthesize("abort miss", {
    sampleRate: 24_000,
    signal: abort.signal,
    onAudio: () => {},
  });

  assert.equal(fs.existsSync(cache.fileFor("abort miss", { sampleRate: 24_000 })), false);
});

test("TTS_CACHE_ENABLED=false passes through and writes no file", async () => {
  await withEnvAsync({ TTS_CACHE_ENABLED: "false" }, async () => {
    const dir = tempDir();
    let calls = 0;
    const cache = createTtsCache({
      dir,
      synthesizeFn: async (_text, options) => {
        calls += 1;
        options.onAudio(Buffer.from([9, 8]));
      },
    });

    const emitted = [];
    await cache.synthesize("passthrough", {
      sampleRate: 24_000,
      onAudio: (chunk) => emitted.push(Buffer.from(chunk)),
    });

    assert.equal(calls, 1);
    assert.deepEqual(Buffer.concat(emitted), Buffer.from([9, 8]));
    assert.equal(fs.existsSync(cache.fileFor("passthrough", { sampleRate: 24_000 })), false);
  });
});

test("corrupt odd-size file is treated as a miss and re-synthesized", async () => {
  const dir = tempDir();
  let calls = 0;
  const cache = createTtsCache({
    dir,
    synthesizeFn: async (_text, options) => {
      calls += 1;
      options.onAudio(Buffer.from([1, 2, 3, 4]));
    },
  });
  fs.mkdirSync(dir, { recursive: true });
  const file = cache.fileFor("corrupt", { sampleRate: 24_000 });
  fs.writeFileSync(file, Buffer.from([1]));

  const emitted = [];
  await cache.synthesize("corrupt", {
    sampleRate: 24_000,
    onAudio: (chunk) => emitted.push(Buffer.from(chunk)),
  });

  assert.equal(calls, 1);
  assert.deepEqual(Buffer.concat(emitted), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(fs.readFileSync(file), Buffer.from([1, 2, 3, 4]));
});

test("hit stat/read race falls back to synthesize", async () => {
  const dir = tempDir();
  let calls = 0;
  const cache = createTtsCache({
    dir,
    synthesizeFn: async (_text, options) => {
      calls += 1;
      options.onAudio(Buffer.from([5, 6]));
    },
  });
  fs.mkdirSync(dir, { recursive: true });
  const file = cache.fileFor("vanishing", { sampleRate: 24_000 });
  fs.writeFileSync(file, Buffer.from([1, 2]));

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    if (target === file) {
      fs.unlinkSync(file);
      throw new Error("cache file vanished");
    }
    return originalReadFileSync.call(this, target, ...args);
  };

  const emitted = [];
  try {
    await cache.synthesize("vanishing", {
      sampleRate: 24_000,
      onAudio: (chunk) => emitted.push(Buffer.from(chunk)),
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(calls, 1);
  assert.deepEqual(Buffer.concat(emitted), Buffer.from([5, 6]));
  assert.deepEqual(fs.readFileSync(file), Buffer.from([5, 6]));
});

test("prewarm skips existing cache files and swallows per-phrase errors", async () => {
  const dir = tempDir();
  const calls = [];
  const cache = createTtsCache({
    dir,
    synthesizeFn: async (text, options) => {
      calls.push(text);
      if (text === "bad") throw new Error("boom");
      options.onAudio(Buffer.from([7, 8]));
    },
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cache.fileFor("existing", { referenceId: "voice", sampleRate: 24_000, speed: 1 }), Buffer.from([1, 2]));

  await cache.prewarm(
    [{ text: "existing" }, { text: "new" }, { text: "bad" }],
    { referenceId: "voice", sampleRate: 24_000, speed: 1 }
  );

  assert.deepEqual(calls, ["new", "bad"]);
  assert.deepEqual(fs.readFileSync(cache.fileFor("new", { referenceId: "voice", sampleRate: 24_000, speed: 1 })), Buffer.from([7, 8]));
});

test("prewarm scrubs labelled secrets from raw-string failures", async () => {
  const secret = "key" + "_" + "abc12";
  const warnings = [];
  const originalWarn = console.warn;
  const cache = createTtsCache({
    dir: tempDir(),
    synthesizeFn: async () => {
      throw `api_key=${secret}`;
    },
  });
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    await cache.prewarm(["unsafe"], { sampleRate: 24_000 });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^⚠️  TTS cache prewarm failed \(unsafe\):/);
  assert.match(warnings[0], /\[REDACTED\]/);
  assert.equal(warnings[0].includes(secret), false);
});

test("prewarm preserves benign raw-string failures", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  const cache = createTtsCache({
    dir: tempDir(),
    synthesizeFn: async () => {
      throw "socket hung up";
    },
  });
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    await cache.prewarm(["benign"], { sampleRate: 24_000 });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], "⚠️  TTS cache prewarm failed (benign): socket hung up");
  assert.equal(warnings[0].includes("[REDACTED]"), false);
});

test("prewarm stops before the next phrase when aborted", async () => {
  const dir = tempDir();
  const abort = new AbortController();
  const calls = [];
  const cache = createTtsCache({
    dir,
    synthesizeFn: async (text, options) => {
      calls.push(text);
      options.onAudio(Buffer.from([1, 2]));
      abort.abort();
    },
  });

  await cache.prewarm(
    [{ text: "first" }, { text: "second" }],
    { sampleRate: 24_000, signal: abort.signal }
  );

  assert.deepEqual(calls, ["first"]);
  assert.equal(fs.existsSync(cache.fileFor("first", { sampleRate: 24_000 })), false);
  assert.equal(fs.existsSync(cache.fileFor("second", { sampleRate: 24_000 })), false);
});

test("cached immediate ack keeps agent speaking until paced playback finishes", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-cache-pipeline-"));
  const ack = "[soft voice] はい。";
  const previousEnv = setEnv({
    POST_UTTERANCE_BUFFER_MS: "0",
    ENABLE_IMMEDIATE_ACK: "true",
    ENABLE_PROGRESS_GUARD: "false",
    TTS_GAP_MS: "0",
    TTS_LEAD_MS: "0",
    SENTENCE_PAUSE_MS: "0",
    TTS_CACHE_DIR: cacheDir,
    TTS_CACHE_PREWARM: "false",
    WAKE_WORDS: "ケイティ",
  });
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  settingsBootstrap.resetStartupForTest();
  settingsResolver.resetRuntimeForTest();

  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm-provider.js"),
    path.join(src, "tts-fish.js"),
    path.join(src, "tts-cache.js"),
    path.join(src, "pipeline.js"),
  ];
  const previousCache = new Map(paths.map((p) => [require.resolve(p), require.cache[require.resolve(p)]]));
  for (const p of paths) delete require.cache[require.resolve(p)];

  let sttEmitter;
  const sttExports = {
    createSTT: () => {
      sttEmitter = new EventEmitter();
      sttEmitter.send = () => {};
      sttEmitter.close = () => {};
      return sttEmitter;
    },
    buildKeyterms: () => [],
  };

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  const llmMock = {
    streamChat: async function* () {},
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
  };
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({ name: "openclaw", ...llmMock }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async () => {
      throw new Error("immediate ack should be served from cache");
    },
  });

  try {
    const seededCache = createTtsCache({
      dir: cacheDir,
      synthesizeFn: async () => {
        throw new Error("seed cache should not synthesize");
      },
    });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(seededCache.fileFor(ack, { referenceId: null, sampleRate: 1000, speed: 1 }), Buffer.alloc(800));

    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = { id: "tts-cache-pipeline-test", conversationLog: [], config: { wakeMode: "wake" } };
    const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
    const audio = [];
    const config = {
      dgKey: "x",
      fishKey: "x",
      openclawUrl: "http://localhost:9",
      openclawToken: "x",
      stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
      llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, openclawSystemAddendum: "" },
      tts: { referenceId: null, sampleRate: 1000, latency: "balanced", speed: 1 },
      ackVariants: [ack],
      echoCooldownMs: 1,
      greeting: "",
      exitDetection: false,
    };

    const pipeline = createPipeline(session, turnState, (buffer) => audio.push(buffer), config, {
      agents: { caty: { wakeWords: ["ケイティ"] } },
      selectedAgentIds: ["caty"],
      defaultAgentId: "caty",
    });

    sttEmitter.emit("utterance_end", "ケイティ、確認して");
    await waitFor(() => turnState.isAgentSpeaking === true, 500, "agent speaking to start");

    const started = performance.now();
    await sleep(75);
    assert.equal(turnState.isAgentSpeaking, true);
    await sleep(100);
    assert.equal(turnState.isAgentSpeaking, true);
    await sleep(100);
    assert.equal(turnState.isAgentSpeaking, true);

    await waitFor(() => turnState.isAgentSpeaking === false, 1000, "agent speaking to finish");
    const elapsed = performance.now() - started;
    pipeline.close();

    assert.ok(elapsed >= 350, `expected cached ack to keep gate closed for paced playback, got ${elapsed}ms`);
    assert.ok(elapsed <= 900, `expected cached ack playback to finish promptly, got ${elapsed}ms`);
    assert.equal(audio.filter((chunk) => chunk.length === 200).length, 4);
  } finally {
    for (const p of paths) {
      const resolved = require.resolve(p);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    restoreEnv(previousEnv);
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
  }
});

function withImmediateAckDecision({ launchEnv, seedEnv, postDotenvEnv }, assertion) {
  const resolver = require("../src/settings/resolver");
  const pipelinePath = require.resolve("../src/pipeline");
  const previousEnv = process.env.ENABLE_IMMEDIATE_ACK;
  delete process.env.ENABLE_IMMEDIATE_ACK;
  delete require.cache[pipelinePath];
  resolver.resetRuntimeForTest();
  const { shouldSendImmediateAck } = require(pipelinePath)._test;
  const resolvedHome = "/tmp/meetmate-immediate-ack-precedence";
  resolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      parsed: {},
      revision: "a".repeat(64),
      fingerprint: "test",
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({ ...(launchEnv || {}) }),
      dotenvSeeds: Object.freeze({ ...(seedEnv || {}) }),
      resolvedHome,
      configPath: path.join(resolvedHome, "config.json"),
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
  });
  try {
    if (postDotenvEnv === undefined) delete process.env.ENABLE_IMMEDIATE_ACK;
    else process.env.ENABLE_IMMEDIATE_ACK = postDotenvEnv;
    assertion(shouldSendImmediateAck);
  } finally {
    resolver.resetRuntimeForTest();
    delete require.cache[pipelinePath];
    if (previousEnv === undefined) delete process.env.ENABLE_IMMEDIATE_ACK;
    else process.env.ENABLE_IMMEDIATE_ACK = previousEnv;
  }
}

test("ENABLE_IMMEDIATE_ACK=false at launch overrides a true dotenv seed", () => {
  withImmediateAckDecision({
    launchEnv: { ENABLE_IMMEDIATE_ACK: "false" },
    seedEnv: { ENABLE_IMMEDIATE_ACK: "true" },
  }, (shouldSendImmediateAck) => {
    assert.equal(shouldSendImmediateAck("確認して"), false);
    assert.equal(shouldSendImmediateAck("", true), false);
  });
});

test("a false dotenv seed disables immediate ack when launch env is unset", () => {
  withImmediateAckDecision({ seedEnv: { ENABLE_IMMEDIATE_ACK: "false" } }, (shouldSendImmediateAck) => {
    assert.equal(shouldSendImmediateAck("確認して"), false);
  });
});

test("immediate ack remains enabled by default when launch env and dotenv seed are unset", () => {
  withImmediateAckDecision({}, (shouldSendImmediateAck) => {
    assert.equal(shouldSendImmediateAck("確認して"), true);
  });
});

test("a post-dotenv process env value does not become the launch tier", () => {
  withImmediateAckDecision({ postDotenvEnv: "false" }, (shouldSendImmediateAck) => {
    assert.equal(shouldSendImmediateAck("確認して"), true);
  });
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tts-cache-test-"));
}

function withEnv(values, fn) {
  const previous = setEnv(values);
  require("../src/settings/bootstrap").resetStartupForTest();
  require("../src/settings/resolver").resetRuntimeForTest();
  try {
    return fn();
  } finally {
    restoreEnv(previous);
    require("../src/settings/bootstrap").resetStartupForTest();
    require("../src/settings/resolver").resetRuntimeForTest();
  }
}

async function withEnvAsync(values, fn) {
  const previous = setEnv(values);
  require("../src/settings/bootstrap").resetStartupForTest();
  require("../src/settings/resolver").resetRuntimeForTest();
  try {
    return await fn();
  } finally {
    restoreEnv(previous);
    require("../src/settings/bootstrap").resetStartupForTest();
    require("../src/settings/resolver").resetRuntimeForTest();
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

function cacheEntry(filename, exports) {
  return {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}
