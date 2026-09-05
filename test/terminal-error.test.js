"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

function createFloor() {
  const floor = Object.assign(new EventEmitter(), {
    state: "READY",
    memberId: "m1",
    connectionEpoch: 1,
    members: [{ memberId: "m1", displayName: "Caty", wakeWords: ["ケイティ"] }],
    grant: null,
    terminal: null,
    muted: false,
    userOverride: false,
    round: 0,
    connect() {},
    close() {},
    claimAssignment() { return null; },
    waitForReady: async () => true,
    remainingReadyGraceMs: () => 0,
    fallbackDelayMs: () => 0,
    hasActivePeerSpeech: () => false,
    hasUnsettledReports: () => false,
    reportWake: async () => ({
      kind: "assigned",
      assignment: { roundId: `r${++floor.round}`, memberId: "m1" },
    }),
    reportText: async () => ({ kind: "degraded", delayMs: 0 }),
    async acquire(roundId) {
      floor.grant = { grantId: `g-${roundId}`, roundId, connectionEpoch: 1 };
      floor.state = "HELD";
      return floor.grant;
    },
    fence() { return floor.grant; },
    isFenceCurrent(fence) { return Boolean(floor.grant && fence?.grantId === floor.grant.grantId); },
    speech() { return true; },
    release() { floor.grant = null; floor.state = "READY"; return true; },
    isMuted() { return floor.muted; },
    terminalReason() { return floor.terminal?.code || null; },
    continueWithoutArbitration() {
      floor.muted = false;
      floor.userOverride = true;
      floor.emit("state", { previous: floor.state, state: floor.state, cause: "continue_without_arbitration" });
      return true;
    },
    reject(code, roomOccupied = false, extra = {}) {
      const message = { type: "error", code, terminal: true, roomOccupied, ...extra };
      floor.terminal = { code, roomOccupied, ...extra };
      floor.muted = true;
      floor.state = "DEGRADED";
      floor.emit("state", { previous: "READY", state: "DEGRADED", cause: code });
      floor.emit("hub_error", message);
    },
  });
  return floor;
}

test("terminal errors enforce muted-degraded speech and recovery contracts", async () => {
  const previousEnv = Object.fromEntries([
    "ENABLE_IMMEDIATE_ACK", "ENABLE_PROGRESS_GUARD", "POST_UTTERANCE_BUFFER_MS",
    "TTS_GAP_MS", "TTS_LEAD_MS", "SENTENCE_PAUSE_MS",
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    POST_UTTERANCE_BUFFER_MS: "0",
    TTS_GAP_MS: "0",
    TTS_LEAD_MS: "0",
    SENTENCE_PAUSE_MS: "0",
  });

  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  settingsBootstrap.resetStartupForTest();
  settingsResolver.resetRuntimeForTest();
  const src = path.join(__dirname, "..", "src");
  const files = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of files) delete require.cache[require.resolve(file)];

  const sttExports = { createSTT: () => Object.assign(new EventEmitter(), { send() {}, close() {} }), buildKeyterms: () => [] };
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({ name: "openclaw", streamChat: async function* () { yield "回答です。"; } }),
  });
  const spoken = [];
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => { spoken.push(text); onAudio(Buffer.alloc(320, 1)); },
  });

  const { createPipeline } = require(path.join(src, "pipeline.js"));
  const pipelines = [];
  function build(floor) {
    const audio = [];
    const chats = [];
    const pipeline = createPipeline(
      { id: `terminal-${pipelines.length}`, conversationLog: [], config: { wakeMode: "wake" } },
      { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 },
      (buffer) => audio.push(Buffer.from(buffer)),
      {
        dgKey: "x", fishKey: "x",
        stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
        llm: { provider: "openclaw", model: "test", responseTimeoutMs: 0, firstTokenDelegateMs: 0 },
        tts: { provider: "fish-audio", sampleRate: 16_000, speed: 1, latency: "balanced" },
        hub: { mode: "cloud", enabled: true, url: "wss://hub.test", roomCode: "r1-room", authToken: "t1", tailMs: 0 },
        gatewayEvents: { enabled: false }, greeting: "", echoCooldownMs: 0,
      },
      {
        agentProfile: { agentId: "caty", displayName: "Caty", wakeWords: ["ケイティ"] },
        floorClient: floor,
        onChatMessage: (message) => { chats.push(message); return true; },
        suppressGreeting: true,
        _testExposeInternals: true,
      },
    );
    pipelines.push(pipeline);
    return { pipeline, floor, audio, chats };
  }

  const previousConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    const limited = build(createFloor());
    limited.floor.reject("plan_agent_limit", true, { agentLimit: 3 });
    await limited.pipeline._test.handleUtteranceEnd("ケイティ、答えて");
    await limited.pipeline._test.speakSentence("発話しない");
    assert.equal(limited.audio.length, 0, "acceptance 2: muted wake must not speak");
    assert.deepEqual(limited.chats, ["Caty は調停に参加できません（この部屋の同時エージェント上限 3体）"]);
    assert.deepEqual(limited.pipeline.floorStatus().continueWithoutArbitration, { available: true });

    const rejected = build(createFloor());
    const healthy = build(createFloor());
    rejected.floor.reject("auth_failed", false);
    await Promise.all([
      rejected.pipeline._test.speakSentence("拒否側"),
      healthy.pipeline._test.speakSentence("正常側"),
    ]);
    assert.equal(rejected.audio.length, 0, "acceptance 4: rejected pipeline stays silent");
    assert.equal(healthy.audio.length > 0, true, "acceptance 4: healthy pipeline still speaks");
    assert.equal(rejected.pipeline.floorStatus().continueWithoutArbitration.available, true);

    const occupied = build(createFloor());
    occupied.floor.reject("plan_room_limit", true);
    assert.equal(occupied.pipeline.floorStatus().continueWithoutArbitration.available, true);
    assert.equal(rejected.pipeline.floorStatus().continueWithoutArbitration.available, true);
    assert.equal(rejected.pipeline.floorStatus().muted, true, "acceptance 5: empty-room rejection is muted");

    const beforeContinue = rejected.audio.length;
    const continued = rejected.pipeline.continueWithoutArbitration();
    assert.equal(continued.muted, false);
    await rejected.pipeline._test.speakSentence("明示操作後の発話");
    assert.equal(rejected.audio.length > beforeContinue, true, "explicit continue re-enables fallback speech");

    const wording = [
      ["auth_failed", "Caty は調停に参加できません（設定の確認が必要です）"],
      ["plan_meeting_quota", "調停OFF（今月の無料枠 5/5 を使い切りました）。この会議では自動発話を停止します"],
      ["plan_room_limit", "調停OFF（同時に開ける会議は1つまで）"],
      ["room_expired", "2時間の上限に達したため調停を終了しました（入り直すと次の1回としてカウントされます）"],
    ];
    for (const [code, expected] of wording) {
      const item = build(createFloor());
      item.floor.reject(code, false);
      item.floor.emit("hub_error", { type: "error", code, terminal: true, roomOccupied: false });
      await Promise.resolve();
      assert.deepEqual(item.chats, [expected], `${code} chat is posted exactly once`);
    }
  } finally {
    for (const pipeline of pipelines) pipeline.close();
    console.log = previousConsole.log;
    console.warn = previousConsole.warn;
    console.error = previousConsole.error;
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
  }
});
