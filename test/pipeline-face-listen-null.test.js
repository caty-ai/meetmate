"use strict";

// #269: after a leave, meet-routes sets session.localAvatarSession = null while
// STT utterance_end events and reply TTS can still arrive. faceMode is latched
// at pipeline construction, so every face read must tolerate the null session.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const QUIET_ENV = {
  WAKE_WORDS: "ケイティ",
  POST_UTTERANCE_BUFFER_MS: "0",
  ENABLE_IMMEDIATE_ACK: "false",
  ENABLE_PROGRESS_GUARD: "false",
  TTS_LEAD_MS: "0",
  TTS_GAP_MS: "0",
  SENTENCE_PAUSE_MS: "0",
  CLAUSE_PAUSE_MS: "0",
  TTS_CACHE_PREWARM: "false",
  METRICS_DISABLED: "1",
};

function settingsFor(emotionJudge) {
  return { state: { exists: true, valid: true, parsed: { avatar: { emotionJudge } } } };
}

function installMock(filename, exports) {
  require.cache[require.resolve(filename)] = { id: filename, filename, loaded: true, exports };
}

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for pipeline state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withFacePipeline(overrides, fn) {
  const restoreEnv = setEnv({ ...QUIET_ENV, ...(overrides.env || {}) });
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  settingsBootstrap.resetStartupForTest();
  settingsResolver.resetRuntimeForTest();
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const src = path.join(__dirname, "..", "src");
  const modulePaths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((file) => path.join(src, file));
  const previousCache = new Map(modulePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of modulePaths) delete require.cache[require.resolve(file)];

  const stt = new EventEmitter();
  stt.send = () => {};
  stt.close = () => {};
  const sttExports = { createSTT: () => stt, buildKeyterms: () => [] };
  installMock(path.join(src, "stt-provider.js"), sttExports);
  installMock(path.join(src, "stt.js"), sttExports);
  installMock(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      streamChat: async function* () {},
      VOICE_SYSTEM_ADDENDUM: "",
      buildVoiceAddendum: () => "",
    }),
  });
  installMock(path.join(src, "tts-fish.js"), {
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4800)),
  });

  let pipeline;
  try {
    settingsResolver.initializeRuntime(overrides.settings);
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = {
      id: "face-listen-null",
      conversationLog: [],
      config: { wakeMode: "wake" },
      localAvatarSession: overrides.localAvatarSession,
    };
    const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
    const config = {
      dgKey: "test",
      fishKey: "test",
      stt: { provider: "soniox", model: "stt-test", language: "ja", sampleRate: 16_000 },
      llm: { provider: "openclaw", model: "llm-test", temperature: 0, maxTokens: 100, responseTimeoutMs: 0, firstTokenDelegateMs: 0 },
      tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1 },
      greeting: "",
      cancelAck: "",
      echoCooldownMs: 1,
      exitDetection: false,
      gatewayEvents: { enabled: false },
    };
    pipeline = createPipeline(session, turnState, overrides.onAudio || (() => {}), config, {
      agentProfile: { agentId: "caty", wakeWords: ["ケイティ"] },
      _testExposeInternals: true,
    });
    await fn({ pipeline, session, stt });
  } finally {
    try { pipeline?.close(); } catch { /* test cleanup */ }
    for (const file of modulePaths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    restoreEnv();
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
    Object.assign(console, originalConsole);
  }
}

test("utterance_end after the face session closed does not throw and the utterance is still handled", { concurrency: false }, async () => {
  await withFacePipeline({
    localAvatarSession: { mode: "face-package", listenReactions: true },
    settings: settingsFor("tags"),
  }, async ({ pipeline, session, stt }) => {
    const listenEvents = [];
    pipeline.on("face_listen", (value) => listenEvents.push(value));
    session.localAvatarSession = null; // leave: meet-routes clears the reference

    assert.doesNotThrow(() => stt.emit("transcript", "hello there", false, 0.9));
    assert.doesNotThrow(() => stt.emit("utterance_end", "hello there"));

    await waitUntil(() => session.conversationLog.length === 1);
    assert.equal(session.conversationLog[0].role, "user");
    assert.equal(session.conversationLog[0].content, "[会議音声・未指名] hello there");
    assert.deepEqual(listenEvents, [], "no face_listen events once the avatar session is gone");
  });
});

test("a listening cue in flight when the face session closes is dropped without throwing", { concurrency: false }, async () => {
  const previousFetch = global.fetch;
  const restoreKey = setEnv({ TYPESAFE_API_KEY: ["synthetic", "listen", "null"].join("-") });
  const resolvers = [];
  global.fetch = () => new Promise((resolve) => resolvers.push(resolve));
  try {
    await withFacePipeline({
      localAvatarSession: { mode: "face-package", listenReactions: true },
      settings: settingsFor("jev"),
    }, async ({ pipeline, session, stt }) => {
      const cues = [];
      pipeline.on("face_listen", (value) => { if (value.cue) cues.push(value); });
      stt.emit("utterance_end", "hello there");
      await waitUntil(() => resolvers.length === 1);
      session.localAvatarSession = null;
      resolvers[0]({ ok: true, json: async () => ({ answers: { emotion: { choice: "trust" }, strong: { noul: 0.2 } } }) });
      await waitUntil(() => session.conversationLog.length === 1);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cues, []);
      assert.equal(session.conversationLog[0].content, "[会議音声・未指名] hello there");
    });
  } finally {
    global.fetch = previousFetch;
    restoreKey();
  }
});

test("speakSentence after the face session closed does not throw and still delivers audio without face metadata", { concurrency: false }, async () => {
  const audio = [];
  await withFacePipeline({
    localAvatarSession: { mode: "face-package", emotionModule: require("../src/emotion") },
    settings: settingsFor("tags"),
    onAudio: (_buffer, metadata) => audio.push({ ...metadata }),
  }, async ({ pipeline, session }) => {
    const emotions = [];
    pipeline.on("face_emotion", (value) => emotions.push(value));
    session.localAvatarSession = null;

    await assert.doesNotReject(pipeline._test.speakSentence("[warm] Hello", null, { faceReply: true }));

    assert.ok(audio.length >= 1, "reply audio is still delivered");
    assert.equal(audio[0].utteranceId, undefined, "no face utterance is attached once the avatar session is gone");
    assert.equal(audio[0].emotion, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(emotions, []);
  });
});
