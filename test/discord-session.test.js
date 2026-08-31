"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { SessionLifecycle } = require("../src/session-events");
const { createDiscordSessionManager } = require("../src/transport-discord/discord-session");

const GUILD_ID = "11111111111111111";
const CHANNEL_ID = "22222222222222222";
const HUMAN_ID = "33333333333333333";
const BOT_ID = "44444444444444444";

function createHarness(overrides = {}) {
  let manager = null;
  const phaseStates = [];
  const player = new EventEmitter();
  player.state = { status: "idle", resource: { playbackDuration: 0 } };
  const connection = new EventEmitter();
  connection.receiver = { subscribe() { throw new Error("subscribeStream stub not installed"); } };
  connection.subscribe = () => {};
  connection.destroyCalls = 0;
  connection.destroy = () => {
    connection.destroyCalls += 1;
  };

  const guild = {
    id: overrides.liveGuildId || GUILD_ID,
    voiceAdapterCreator: {},
    channels: {
      cache: new Map(),
    },
  };
  const channel = {
    id: CHANNEL_ID,
    members: new Map([
      [HUMAN_ID, { user: { id: HUMAN_ID, bot: false, username: "human" }, displayName: "Human" }],
      [BOT_ID, { user: { id: BOT_ID, bot: true, username: "bot" }, displayName: "Bot" }],
    ]),
  };
  guild.channels.cache.set(CHANNEL_ID, channel);

  const client = new EventEmitter();
  client.user = { id: BOT_ID };
  client.guilds = { cache: new Map([[GUILD_ID, guild]]) };
  client.loginCalls = [];
  client.destroyCalls = 0;
  client.login = async (token) => {
    client.loginCalls.push(token);
    phaseStates.push({ step: "login", state: manager?._test.getActiveSession()?.lifecycle.state || null });
    if (overrides.loginError) throw overrides.loginError;
  };
  client.destroy = () => {
    client.destroyCalls += 1;
  };

  const audioOutRecords = [];
  const audioInSubscriptions = [];
  const audioInUnsubscriptions = [];
  const createdPipelines = [];
  const warmups = [];
  const notifierCalls = [];
  const coordinatorState = { lease: null, releaseCalls: 0, tryAcquireCalls: 0 };
  const synthesizedTexts = [];

  const voice = {
    AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
    VoiceConnectionStatus: { Ready: "ready", Destroyed: "destroyed", Disconnected: "disconnected" },
    entersState: overrides.entersState || (() => Promise.reject(new Error("reconnect timeout"))),
  };

  const sessionCoordinator = overrides.sessionCoordinator || {
    tryAcquire(transport, sessionId) {
      coordinatorState.tryAcquireCalls += 1;
      if (overrides.acquireError) throw overrides.acquireError;
      if (coordinatorState.lease) return overrides.reuseLease ? coordinatorState.lease : null;
      coordinatorState.lease = Object.freeze({ transport, sessionId });
      return coordinatorState.lease;
    },
    release(lease) {
      if (lease && lease === coordinatorState.lease) {
        coordinatorState.releaseCalls += 1;
        coordinatorState.lease = null;
      }
    },
    active() {
      return coordinatorState.lease ? {
        transport: coordinatorState.lease.transport,
        sessionId: coordinatorState.lease.sessionId,
      } : null;
    },
  };

  const timers = overrides.timers || globalThis;

  manager = createDiscordSessionManager({
    getDiscordConfig: () => overrides.discordConfig === undefined
      ? { token: "discord-token", guildAllowlist: [GUILD_ID] }
      : overrides.discordConfig,
    ttsProvider: overrides.ttsProvider,
    getPipelineConfig: overrides.getPipelineConfig || (() => ({
      systemPrompt: "system",
      greeting: "hello",
      fishKey: "fish-key",
      llm: { model: "gpt-test", provider: "openclaw" },
      tts: { sampleRate: overrides.sampleRate || 24000, referenceId: "voice", latency: "balanced", speed: 1 },
      slack: { enabled: false, channelId: "", statusChannelId: "", summaryChannelId: "", notifyTarget: "dm", dmUserId: "", labels: {} },
      summary: { prompt: "summary" },
      briefing: "briefing",
    })),
    resolveAgentProfile: () => ({
      agentId: "caty",
      name: "Caty",
      displayName: "Caty",
      model: "gpt-test",
      voiceId: "voice",
      wakeWords: ["ケイティ"],
    }),
    sessionCoordinator,
    loadVoiceModule: () => voice,
    loadDiscordModule: () => ({ GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 }, Client: function MockClient() {} }),
    createClient: overrides.createClient || (() => client),
    resolveVoiceTarget: overrides.resolveVoiceTarget || (async () => ({ guild, channel, receiver: connection.receiver })),
    joinVoice: overrides.joinVoice || (() => {
      phaseStates.push({ step: "voice-connect", state: manager?._test.getActiveSession()?.lifecycle.state || null });
      return connection;
    }),
    createAudioOut: overrides.createAudioOut || (() => ({
      onAudio(buffer, metadata) {
        audioOutRecords.push({ buffer, metadata });
      },
      finish() {
        if (typeof overrides.onFinishAudioOut === "function") overrides.onFinishAudioOut({ player });
      },
      getPlayer() {
        return player;
      },
      close() {
        audioOutRecords.push({ closed: true });
      },
    })),
    createAudioIn: overrides.createAudioIn || (() => ({
      subscribeUser(_receiver, speaker) {
        phaseStates.push({ step: "subscription", state: manager?._test.getActiveSession()?.lifecycle.state || null });
        audioInSubscriptions.push(speaker.id);
      },
      unsubscribeUser(userId) {
        audioInUnsubscriptions.push(userId);
      },
      close() {
        audioInSubscriptions.push("closed");
      },
    })),
    createPipeline: overrides.createPipeline || ((session, turnState, onAudio, config, options) => {
      phaseStates.push({ step: "pipeline", state: manager?._test.getActiveSession()?.lifecycle.state || null });
      const pipeline = new EventEmitter();
      pipeline.session = session;
      pipeline.turnState = turnState;
      pipeline.config = config;
      pipeline.options = options;
      pipeline.closeCalls = 0;
      pipeline.sendAudio = () => {};
      pipeline.close = () => {
        pipeline.closeCalls += 1;
      };
      createdPipelines.push(pipeline);
      return pipeline;
    }),
    warmUpGatewaySession: (...args) => {
      warmups.push(args);
      return Promise.resolve();
    },
    createNotifier: overrides.createNotifier || (() => ({
      postStatus(lifecycle) {
        notifierCalls.push({ type: "status", state: lifecycle.state });
        return Promise.resolve();
      },
      startElapsedUpdates(lifecycle) {
        notifierCalls.push({ type: "start", state: lifecycle.state });
      },
      stopElapsedUpdates(lifecycleId) {
        notifierCalls.push({ type: "stop", sessionId: lifecycleId });
      },
      postSummary(_lifecycle, summary) {
        notifierCalls.push({ type: "summary", summary });
        return Promise.resolve();
      },
    })),
    summarizeConversation: overrides.summarizeConversation || (async () => ({ summary: ["summary"], decisions: [], todos: [] })),
    synthesize: async (text, options) => {
      synthesizedTexts.push(text);
      if (typeof overrides.synthesize === "function") {
        return overrides.synthesize({ text, options, player, timers });
      }
      phaseStates.push({ step: "announce", state: manager?._test.getActiveSession()?.lifecycle.state || null });
      const chunk = Buffer.alloc(24000, 0x11);
      options.onAudio(chunk);
      player.state = { status: "playing", resource: { playbackDuration: 0 } };
      player.emit("stateChange", { status: "idle" }, { status: "playing" });
      player.state = { status: "idle", resource: { playbackDuration: 900 } };
      queueMicrotask(() => {
        player.emit("stateChange", { status: "playing" }, { status: "idle" });
      });
    },
    waitForReconnect: overrides.waitForReconnect,
    timers,
    now: () => 1_725_000_000_000,
    randomBytes: () => Buffer.from("abcdef", "hex"),
  });

  return {
    manager,
    client,
    connection,
    guild,
    channel,
    player,
    voice,
    coordinatorState,
    audioOutRecords,
    audioInSubscriptions,
    audioInUnsubscriptions,
    createdPipelines,
    warmups,
    notifierCalls,
    synthesizedTexts,
    phaseStates,
  };
}

test("discord join refuses malformed request and setup blockers before acquire or vendor side effects", async () => {
  const invalid = createHarness();
  const invalidResult = await invalid.manager.join({ guildId: "bad", channelId: CHANNEL_ID });
  assert.equal(invalidResult.status, 400);
  assert.equal(invalid.coordinatorState.tryAcquireCalls, 0);
  assert.equal(invalid.client.loginCalls.length, 0);
  assert.equal(invalid.createdPipelines.length, 0);

  const nullBody = await invalid.manager.join(null);
  assert.equal(nullBody.status, 400);
  assert.equal(invalid.coordinatorState.tryAcquireCalls, 0);

  const allowlistEmpty = createHarness({ discordConfig: { token: "discord-token", guildAllowlist: [] } });
  const allowlistResult = await allowlistEmpty.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(allowlistResult.status, 403);
  assert.equal(allowlistEmpty.coordinatorState.tryAcquireCalls, 0);
  assert.equal(allowlistEmpty.client.loginCalls.length, 0);

  const allowlistInvalid = createHarness({ discordConfig: { token: "discord-token", guildAllowlist: [GUILD_ID, GUILD_ID] } });
  const invalidAllowlistResult = await allowlistInvalid.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(invalidAllowlistResult.status, 503);
  assert.equal(allowlistInvalid.coordinatorState.tryAcquireCalls, 0);

  const legacyTts = createHarness({ ttsProvider: "deepgram" });
  const legacyResult = await legacyTts.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(legacyResult.status, 503);
  assert.equal(legacyResult.body.code, "DISCORD_SETUP_REQUIRED");
  assert.equal(legacyTts.coordinatorState.tryAcquireCalls, 0);
  assert.equal(legacyTts.client.loginCalls.length, 0);

  const unsupportedTtsRate = createHarness({ sampleRate: 16000 });
  const unsupportedRateResult = await unsupportedTtsRate.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(unsupportedRateResult.status, 503);
  assert.equal(unsupportedRateResult.body.code, "DISCORD_UNSUPPORTED_TTS_RATE");
  assert.equal(unsupportedTtsRate.coordinatorState.tryAcquireCalls, 0);
  assert.equal(unsupportedTtsRate.client.loginCalls.length, 0);

  const coordinatorFailure = createHarness({ acquireError: new Error("coordinator unavailable") });
  const coordinatorFailureResult = await coordinatorFailure.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(coordinatorFailureResult.status, 503);
  assert.equal(coordinatorFailure.client.loginCalls.length, 0);

  const missingCoordinator = createHarness({ sessionCoordinator: {} });
  const missingCoordinatorResult = await missingCoordinator.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(missingCoordinatorResult.status, 503);
  assert.equal(missingCoordinator.client.loginCalls.length, 0);
});

test("discord join succeeds only after announce, then creates pipeline with suppressGreeting and subscribes humans", async () => {
  const harness = createHarness();
  const result = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID, briefing: "brief" });

  assert.equal(result.status, 200);
  assert.equal(result.body.state, "in-progress");
  assert.equal(harness.createdPipelines.length, 1);
  assert.equal(harness.createdPipelines[0].options.suppressGreeting, true);
  assert.deepEqual(harness.audioInSubscriptions, [HUMAN_ID]);
  assert.equal(harness.synthesizedTexts.length, 1);
  assert.match(harness.synthesizedTexts[0], /ケイティ/);
  assert.equal(harness.warmups.length, 1);
  assert.equal(harness.warmups[0][0], `discord-${result.body.sessionId}-caty`);
  assert.equal(harness.coordinatorState.releaseCalls, 0);
  assert.equal(harness.notifierCalls.some((item) => item.type === "start"), true);
  assert.deepEqual(harness.phaseStates, [
    { step: "login", state: "initiating" },
    { step: "voice-connect", state: "initiating" },
    { step: "announce", state: "initiating" },
    { step: "pipeline", state: "initiating" },
    { step: "subscription", state: "initiating" },
  ]);
});

test("discord sessions relay generic pipeline audio, post summaries on terminal leave, and never import LCM ingest", async () => {
  const summaryCalls = [];
  const harness = createHarness({
    createPipeline: (session, turnState, onAudio, config, options) => {
      const pipeline = new EventEmitter();
      pipeline.session = session;
      pipeline.turnState = turnState;
      pipeline.config = config;
      pipeline.options = options;
      pipeline.sendAudio = () => {};
      pipeline.closeCalls = 0;
      pipeline.close = () => {
        pipeline.closeCalls += 1;
      };
      pipeline.emitVoice = (buffer, metadata) => onAudio(buffer, metadata);
      harness.createdPipelines.push(pipeline);
      return pipeline;
    },
    summarizeConversation: async (conversationLog, summaryOptions) => {
      summaryCalls.push({ conversationLog, summaryOptions });
      return { summary: ["summary"], decisions: [], todos: [] };
    },
  });

  const joined = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(joined.status, 200);
  assert.equal(harness.createdPipelines[0].options.capabilities.chat, false);

  const relayChunk = Buffer.from([1, 0, 2, 0]);
  harness.createdPipelines[0].emitVoice(relayChunk, { outputEpoch: 0, firstSampleIndex: 0, sampleRate: 24_000 });
  assert.deepEqual(harness.audioOutRecords.at(-1), {
    buffer: relayChunk,
    metadata: { outputEpoch: 0, firstSampleIndex: 0, sampleRate: 24_000 },
  });

  const active = harness.manager._test.getActiveSession();
  active.session.conversationLog.push({ role: "user", content: "summary me" });
  const left = await harness.manager.leave();
  assert.equal(left.status, 200);
  assert.equal(summaryCalls.length, 1);
  assert.equal(harness.notifierCalls.some((item) => item.type === "summary"), true);

  const source = fs.readFileSync(path.join(__dirname, "..", "src", "transport-discord", "discord-session.js"), "utf8");
  assert.equal(source.includes("sendLcmIngest"), false);
});

test("discord join failure modes after acquire release the lease and avoid pipeline startup", async () => {
  for (const scenario of [
    {
      name: "zero audio",
      synthesize: async () => {
      },
    },
    {
      name: "player error",
      synthesize: async ({ options, player }) => {
        options.onAudio(Buffer.alloc(24000));
        player.state = { status: "playing", resource: { playbackDuration: 0 } };
        player.emit("stateChange", { status: "idle" }, { status: "playing" });
        queueMicrotask(() => player.emit("error", new Error("player failed")));
      },
    },
    {
      name: "timeout",
      synthesize: async ({ options, player }) => {
        options.onAudio(Buffer.alloc(24000));
        player.state = { status: "playing", resource: { playbackDuration: 0 } };
        player.emit("stateChange", { status: "idle" }, { status: "playing" });
      },
    },
    {
      name: "never resolving synth",
      synthesize: async () => new Promise(() => {}),
    },
    {
      name: "teardown during announce",
      synthesize: async ({ options }) => {
        await new Promise((resolve) => setImmediate(resolve));
        options.signal?.throwIfAborted?.();
      },
      teardown: true,
    },
  ]) {
    const harness = createHarness({
      synthesize: scenario.synthesize,
      timers: ["timeout", "never resolving synth"].includes(scenario.name)
        ? {
            setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms, 5)); },
            clearTimeout,
          }
        : globalThis,
    });
    const joinPromise = harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
    if (scenario.teardown) {
      await new Promise((resolve) => setImmediate(resolve));
      await harness.manager.leave();
    }
    const result = await joinPromise;
    assert.equal(result.status, 502, scenario.name);
    assert.equal(harness.coordinatorState.releaseCalls, 1, scenario.name);
    assert.equal(harness.createdPipelines.length, 0, scenario.name);
    assert.equal(harness.manager._test.getActiveSession(), null, scenario.name);
  }
});

test("discord join releases lease on identify failure and live allowlist mismatch", async () => {
  const identifyFailure = createHarness({ loginError: new Error("429 identify") });
  const identifyResult = await identifyFailure.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(identifyResult.status, 502);
  assert.equal(identifyFailure.coordinatorState.releaseCalls, 1);
  assert.equal(identifyFailure.createdPipelines.length, 0);

  const mismatchedGuild = createHarness({ liveGuildId: "99999999999999999" });
  const mismatchResult = await mismatchedGuild.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(mismatchResult.status, 502);
  assert.equal(mismatchedGuild.coordinatorState.releaseCalls, 1);
});

test("discord lifecycle maps pre-ready disconnects to failed and in-progress external teardown to terminal states", async () => {
  const preReady = createHarness({
    synthesize: async ({ options, player }) => {
      options.onAudio(Buffer.alloc(24000));
      player.state = { status: "playing", resource: { playbackDuration: 0 } };
      player.emit("stateChange", { status: "idle" }, { status: "playing" });
      preReady.connection.emit("stateChange", { status: "ready" }, { status: "destroyed" });
    },
  });
  const preReadyResult = await preReady.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(preReadyResult.status, 502);
  assert.equal(preReady.coordinatorState.releaseCalls, 1);

  const ready = createHarness();
  const readyResult = await ready.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(readyResult.status, 200);
  const active = ready.manager._test.getActiveSession();
  assert.equal(active.lifecycle.state, "in-progress");

  ready.connection.emit("stateChange", { status: "ready" }, { status: "destroyed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.lifecycle.state, "completed");

  const disconnected = createHarness({
    waitForReconnect: () => Promise.reject(new Error("timeout")),
  });
  const disconnectedResult = await disconnected.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(disconnectedResult.status, 200);
  const disconnectedActive = disconnected.manager._test.getActiveSession();
  disconnected.connection.emit("stateChange", { status: "ready" }, { status: "disconnected" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnectedActive.lifecycle.state, "failed");
});

test("discord lifecycle covers invalidated and channelDelete with state-aware terminal mapping", async () => {
  const initiatingInvalidated = createHarness({
    synthesize: async ({ options }) => {
      options.onAudio(Buffer.alloc(24000));
      initiatingInvalidated.connection.emit("invalidated");
    },
  });
  const initiatingResult = await initiatingInvalidated.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(initiatingResult.status, 502);
  assert.equal(initiatingInvalidated.coordinatorState.releaseCalls, 1);

  const ready = createHarness();
  const readyResult = await ready.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(readyResult.status, 200);
  const active = ready.manager._test.getActiveSession();

  ready.client.emit("channelDelete", { id: CHANNEL_ID });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.lifecycle.state, "completed");

  const invalidated = createHarness();
  const invalidatedResult = await invalidated.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(invalidatedResult.status, 200);
  const invalidatedActive = invalidated.manager._test.getActiveSession();
  invalidated.connection.emit("invalidated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidatedActive.lifecycle.state, "failed");
});

test("discord voiceStateUpdate aborts non-allowlisted bot movement and terminal leave transitions unsubscribe humans", async () => {
  const harness = createHarness();
  const result = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(result.status, 200);
  const session = harness.manager._test.getActiveSession();

  harness.client.emit("voiceStateUpdate", { id: BOT_ID, guild: { id: GUILD_ID }, channelId: CHANNEL_ID }, { id: BOT_ID, guild: { id: GUILD_ID }, channelId: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.lifecycle.state, "completed");

  const allowlistAbort = createHarness();
  const second = await allowlistAbort.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(second.status, 200);
  const secondSession = allowlistAbort.manager._test.getActiveSession();
  allowlistAbort.client.emit("voiceStateUpdate", null, { id: BOT_ID, guild: { id: "99999999999999999" }, channelId: CHANNEL_ID });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSession.lifecycle.state, "failed");
  assert.equal(allowlistAbort.coordinatorState.releaseCalls, 1);
});

test("discord post-acquire throw sites all release the lease and leave no active zombie session", async () => {
  const scenarios = [
    {
      name: "createClient",
      createClient: () => { throw new Error("createClient failed"); },
    },
    {
      name: "resolveVoiceTarget",
      resolveVoiceTarget: async () => { throw new Error("resolve target failed"); },
    },
    {
      name: "joinVoice",
      joinVoice: () => { throw new Error("join voice failed"); },
    },
    {
      name: "createAudioOut",
      createAudioOut: () => { throw new Error("audio out failed"); },
    },
    {
      name: "announce",
      synthesize: async () => { throw new Error("announce failed"); },
    },
    {
      name: "createPipeline",
      createPipeline: () => { throw new Error("pipeline failed"); },
    },
    {
      name: "createAudioIn",
      createAudioIn: () => { throw new Error("audio-in failed"); },
    },
    {
      name: "subscription",
      createAudioIn: () => ({
        subscribeUser() { throw new Error("subscription failed"); },
        unsubscribeUser() {},
        close() {},
      }),
    },
  ];

  for (const scenario of scenarios) {
    const harness = createHarness(scenario);
    const result = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
    assert.equal(result.status, 502, scenario.name);
    assert.equal(harness.coordinatorState.releaseCalls, 1, scenario.name);
    assert.equal(harness.manager._test.getActiveSession(), null, scenario.name);
  }
});
