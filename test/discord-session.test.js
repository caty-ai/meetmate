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

function emitVendorPlayback(player, { duration = 900, error = null, idle = true } = {}) {
  const idleState = { status: "idle" };
  const playingState = { status: "playing", resource: { playbackDuration: duration } };
  player.state = playingState;
  player.emit("stateChange", idleState, playingState);
  queueMicrotask(() => {
    if (error) player.emit("error", error);
    if (idle) {
      player.state = idleState;
      player.emit("stateChange", playingState, idleState);
    }
  });
}

async function waitFor(predicate, message, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function createHarness(overrides = {}) {
  let manager = null;
  const phaseStates = [];
  const player = new EventEmitter();
  player.state = { status: "idle" };
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
      pipeline.handleGatewaySubagentCompletion = overrides.handleGatewaySubagentCompletion;
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
      emitVendorPlayback(player);
    },
    waitForReconnect: overrides.waitForReconnect,
    gatewayEvents: overrides.gatewayEvents,
    getGatewayConfigForProfile: overrides.getGatewayConfigForProfile,
    recordEvent: overrides.recordEvent,
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
  const activeStatus = harness.manager.getStatus();
  assert.equal(activeStatus.session.sessionId, result.body.sessionId);
  assert.equal(activeStatus.session.startedAt, "2024-08-30T06:40:00.000Z");
  assert.equal(activeStatus.session.connectionReady, false);
  assert.equal(Object.hasOwn(activeStatus.session, "guildId"), false);
  assert.equal(Object.hasOwn(activeStatus.session, "channelId"), false);
  harness.connection.emit("stateChange", { status: "connecting" }, { status: "ready" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.manager.getStatus().session.connectionReady, true);
  assert.deepEqual(harness.phaseStates, [
    { step: "login", state: "initiating" },
    { step: "voice-connect", state: "initiating" },
    { step: "announce", state: "initiating" },
    { step: "pipeline", state: "initiating" },
    { step: "subscription", state: "initiating" },
  ]);
});

test("join wires the pipeline releaseSpeaker into audio-in (feature-detected)", async () => {
  const audioInOptions = [];
  const stubAudioIn = () => ({ subscribeUser() {}, unsubscribeUser() {}, close() {} });

  const legacy = createHarness({
    createAudioIn: (options) => {
      audioInOptions.push({ kind: "legacy", options });
      return stubAudioIn();
    },
  });
  assert.equal((await legacy.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID })).status, 200);
  assert.equal(audioInOptions[0].options.releaseSpeaker, undefined);

  const releaseCalls = [];
  let wiredPipeline;
  const wired = createHarness({
    createAudioIn: (options) => {
      audioInOptions.push({ kind: "wired", options });
      return stubAudioIn();
    },
    createPipeline: (session, turnState, onAudio, config, options) => {
      const pipeline = new EventEmitter();
      Object.assign(pipeline, {
        session,
        turnState,
        config,
        options,
        closeCalls: 0,
        sendAudio() {},
        close() { pipeline.closeCalls += 1; },
      });
      pipeline.releaseSpeaker = function releaseSpeaker(id) {
        releaseCalls.push({ self: this, id });
        return true;
      };
      wiredPipeline = pipeline;
      return pipeline;
    },
  });
  assert.equal((await wired.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID })).status, 200);
  const wiredOptions = audioInOptions.find((entry) => entry.kind === "wired").options;
  assert.equal(typeof wiredOptions.releaseSpeaker, "function");
  assert.equal(wiredOptions.releaseSpeaker("42"), true);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].id, "42");
  assert.equal(releaseCalls[0].self, wiredPipeline);
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

test("discord exit_requested ends the active voice session through the leave teardown path", async () => {
  const harness = createHarness();
  const joined = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(joined.status, 200);

  const session = harness.manager._test.getActiveSession();
  session.session.conversationLog.push({ role: "user", content: "さようなら" });
  harness.createdPipelines[0].emit("exit_requested", {
    sessionId: joined.body.sessionId,
    trigger: "voice_command",
    text: "さようなら",
  });

  await waitFor(
    () => harness.manager._test.getActiveSession() === null
      && harness.notifierCalls.some((item) => item.type === "summary"),
    "exit_requested did not complete Discord session teardown"
  );
  assert.equal(session.lifecycle.state, "completed");
  assert.equal(session.lifecycle.isTerminal, true);
  assert.equal(harness.connection.destroyCalls, 1);
  assert.equal(harness.createdPipelines[0].closeCalls, 1);
  assert.equal(harness.audioInSubscriptions.at(-1), "closed");
  assert.equal(harness.notifierCalls.some((item) => item.type === "summary"), true);

  const leftAgain = await harness.manager.leave();
  assert.equal(leftAgain.status, 404);
  assert.equal(leftAgain.body.code, "DISCORD_SESSION_NOT_FOUND");
});

test("discord ignores exit_requested from an already-left stale pipeline", async () => {
  const harness = createHarness();
  assert.equal((await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID })).status, 200);
  const stalePipeline = harness.createdPipelines[0];
  assert.equal((await harness.manager.leave()).status, 200);

  assert.equal((await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID })).status, 200);
  const currentSession = harness.manager._test.getActiveSession();
  const destroyCalls = harness.connection.destroyCalls;
  assert.doesNotThrow(() => {
    stalePipeline.emit("exit_requested", { trigger: "voice_command" });
    stalePipeline.emit("exit_requested", { trigger: "voice_command" });
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.manager._test.getActiveSession(), currentSession);
  assert.equal(harness.connection.destroyCalls, destroyCalls);
  assert.equal(harness.createdPipelines[1].closeCalls, 0);
  assert.equal(harness.coordinatorState.releaseCalls, 1);
  await harness.manager.leave();
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
        emitVendorPlayback(player, { error: new Error("player failed") });
      },
    },
    {
      name: "duration short",
      synthesize: async ({ options, player }) => {
        options.onAudio(Buffer.alloc(24000));
        emitVendorPlayback(player, { duration: 399 });
      },
    },
    {
      name: "timeout",
      synthesize: async ({ options, player }) => {
        options.onAudio(Buffer.alloc(24000));
        emitVendorPlayback(player, { idle: false });
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
    assert.equal(harness.player.listenerCount("stateChange"), 0, scenario.name);
    assert.equal(harness.player.listenerCount("error"), 0, scenario.name);
  }
});

test("discord announce rejects an error before a sufficient-duration Idle transition", async () => {
  const harness = createHarness({
    synthesize: async ({ options, player }) => {
      options.onAudio(Buffer.alloc(24000));
      emitVendorPlayback(player, { duration: 900, error: new Error("independent player error") });
    },
  });

  const result = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(result.status, 502);
  assert.equal(result.body.message, "Discord announce failed: player_error");
  assert.equal(harness.coordinatorState.releaseCalls, 1);
  assert.equal(harness.createdPipelines.length, 0);
  assert.equal(harness.player.listenerCount("stateChange"), 0);
  assert.equal(harness.player.listenerCount("error"), 0);
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
      emitVendorPlayback(player, { idle: false });
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
  assert.equal(ready.connection.destroyCalls, 1);

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
      initiatingInvalidated.client.emit("invalidated");
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
  invalidated.client.emit("invalidated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidatedActive.lifecycle.state, "failed");
  assert.equal(invalidated.connection.destroyCalls, 1);
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

  const missingLiveGuild = createHarness();
  const third = await missingLiveGuild.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(third.status, 200);
  const thirdSession = missingLiveGuild.manager._test.getActiveSession();
  missingLiveGuild.client.emit("voiceStateUpdate", null, { id: BOT_ID, channelId: CHANNEL_ID });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdSession.lifecycle.state, "failed");
});

test("discord voiceStateUpdate left transitions release the departed speaker slot", async () => {
  const harness = createHarness();
  const result = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(result.status, 200);

  const released = [];
  harness.createdPipelines[0].releaseSpeaker = (userId) => {
    released.push(userId);
    return true;
  };

  harness.client.emit(
    "voiceStateUpdate",
    {
      channelId: CHANNEL_ID,
      member: { user: { id: HUMAN_ID, bot: false }, displayName: "Human" },
    },
    {
      channelId: null,
    }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.audioInUnsubscriptions, [HUMAN_ID]);
  assert.deepEqual(released, [HUMAN_ID]);
});

test("discord voiceStateUpdate does not release slots for bot movement, other bots, or other-channel leaves", async () => {
  const otherChannelHarness = createHarness();
  const otherChannelResult = await otherChannelHarness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(otherChannelResult.status, 200);
  const otherChannelReleased = [];
  otherChannelHarness.createdPipelines[0].releaseSpeaker = (userId) => {
    otherChannelReleased.push(userId);
    return true;
  };
  otherChannelHarness.client.emit(
    "voiceStateUpdate",
    {
      channelId: "99999999999999999",
      member: { user: { id: HUMAN_ID, bot: false }, displayName: "Human" },
    },
    {
      channelId: null,
      member: { user: { id: HUMAN_ID, bot: false }, displayName: "Human" },
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(otherChannelReleased, []);
  assert.deepEqual(otherChannelHarness.audioInUnsubscriptions, []);

  const otherBotHarness = createHarness();
  const otherBotResult = await otherBotHarness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(otherBotResult.status, 200);
  const otherBotReleased = [];
  otherBotHarness.createdPipelines[0].releaseSpeaker = (userId) => {
    otherBotReleased.push(userId);
    return true;
  };
  otherBotHarness.client.emit(
    "voiceStateUpdate",
    {
      channelId: CHANNEL_ID,
      member: { user: { id: "55555555555555555", bot: true }, displayName: "Other Bot" },
    },
    {
      channelId: null,
      member: { user: { id: "55555555555555555", bot: true }, displayName: "Other Bot" },
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(otherBotReleased, []);
  assert.deepEqual(otherBotHarness.audioInUnsubscriptions, []);

  const botHarness = createHarness();
  const botResult = await botHarness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(botResult.status, 200);
  const botReleased = [];
  botHarness.createdPipelines[0].releaseSpeaker = (userId) => {
    botReleased.push(userId);
    return true;
  };
  botHarness.client.emit(
    "voiceStateUpdate",
    { id: BOT_ID, guild: { id: GUILD_ID }, channelId: CHANNEL_ID },
    { id: BOT_ID, guild: { id: GUILD_ID }, channelId: null }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(botReleased, []);
});

test("discord voiceStateUpdate tolerates pipelines without releaseSpeaker on human leave", async () => {
  const harness = createHarness();
  const result = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(result.status, 200);

  const unhandled = [];
  const listenerErrors = [];
  const onUnhandled = (error) => unhandled.push(error);
  const originalConsoleError = console.error;
  process.on("unhandledRejection", onUnhandled);
  console.error = (...args) => listenerErrors.push(args);
  try {
    harness.client.emit(
      "voiceStateUpdate",
      {
        channelId: CHANNEL_ID,
        member: { user: { id: HUMAN_ID, bot: false }, displayName: "Human" },
      },
      {
        channelId: null,
        member: { user: { id: HUMAN_ID, bot: false }, displayName: "Human" },
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalConsoleError;
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(harness.audioInUnsubscriptions, [HUMAN_ID]);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(listenerErrors, []);
});

test("discord voiceStateUpdate is transition-only, announce-safe, and partial-state safe", async () => {
  const duringAnnounce = createHarness({
    synthesize: async ({ options, player }) => {
      options.onAudio(Buffer.alloc(24000));
      duringAnnounce.client.emit("voiceStateUpdate", null, {
        channelId: CHANNEL_ID,
        member: { user: { id: "55555555555555555", bot: false }, displayName: "During announce" },
      });
      emitVendorPlayback(player);
    },
  });
  const announceErrors = [];
  const originalAnnounceConsoleError = console.error;
  let joined;
  console.error = (...args) => announceErrors.push(args);
  try {
    joined = await duringAnnounce.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  } finally {
    console.error = originalAnnounceConsoleError;
  }
  assert.equal(joined.status, 200);
  assert.deepEqual(announceErrors, []);
  assert.deepEqual(duringAnnounce.audioInSubscriptions, [HUMAN_ID]);

  const beforeSubscriptions = duringAnnounce.audioInSubscriptions.slice();
  const beforeUnsubscriptions = duringAnnounce.audioInUnsubscriptions.slice();
  const sameChannelState = {
    channelId: CHANNEL_ID,
    member: { user: { id: HUMAN_ID, bot: false }, displayName: "Human" },
  };
  duringAnnounce.client.emit("voiceStateUpdate", sameChannelState, { ...sameChannelState, selfMute: true });

  const unhandled = [];
  const listenerErrors = [];
  const onUnhandled = (error) => unhandled.push(error);
  const originalConsoleError = console.error;
  process.on("unhandledRejection", onUnhandled);
  console.error = (...args) => listenerErrors.push(args);
  try {
    duringAnnounce.client.emit("voiceStateUpdate", { channelId: CHANNEL_ID }, { channelId: null });
    duringAnnounce.client.emit("voiceStateUpdate", { channelId: null }, { channelId: CHANNEL_ID });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalConsoleError;
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(duringAnnounce.audioInSubscriptions, beforeSubscriptions);
  assert.deepEqual(duringAnnounce.audioInUnsubscriptions, beforeUnsubscriptions);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(listenerErrors, []);
});

test("discord gateway completion routes through the gateway events client", async () => {
  const completionListeners = [];
  const handled = [];
  const startedConfigs = [];
  const builtKeys = [];
  const gatewayEvents = {
    buildSessionKey(user, agentId) {
      builtKeys.push({ user, agentId });
      return `agent:${agentId}:openai-user:${user}`;
    },
    start(config) { startedConfigs.push(config); },
    stop() {},
    verifySessionKey: async () => true,
    onSubagentSpawn() { return () => {}; },
    onSubagentCompletion(listener) { completionListeners.push(listener); return () => {}; },
    onSessionReply() { return () => {}; },
    onAnnounceInjected() { return () => {}; },
  };
  const harness = createHarness({
    gatewayEvents,
    getPipelineConfig: () => ({
      systemPrompt: "system",
      greeting: "hello",
      fishKey: "fish-key",
      gatewayEvents: { enabled: true, agentId: "main" },
      llm: { model: "gpt-test", provider: "openclaw", gateway: { url: "https://gateway.example", token: "gateway.value" } },
      tts: { sampleRate: 24000, referenceId: "voice", latency: "balanced", speed: 1 },
      slack: { enabled: false, channelId: "", statusChannelId: "", summaryChannelId: "", notifyTarget: "dm", dmUserId: "", labels: {} },
      summary: { prompt: "summary" },
      briefing: "briefing",
    }),
    handleGatewaySubagentCompletion(event) {
      handled.push(event);
      return true;
    },
  });

  const joined = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(joined.status, 200);
  assert.equal(completionListeners.length, 1);
  assert.equal(startedConfigs.length, 1);
  assert.equal(startedConfigs[0].enabled, true);
  assert.equal(startedConfigs[0].agentId, "main");
  assert.equal(startedConfigs[0].name, "openclaw");
  assert.deepEqual(builtKeys, [
    { user: `discord-${joined.body.sessionId}-caty`, agentId: "main" },
    { user: `discord-${joined.body.sessionId}-caty-delegate`, agentId: "main" },
  ]);
  const parentSessionKey = `agent:main:openai-user:discord-${joined.body.sessionId}-caty`;
  await completionListeners[0]({ parentSessionKey, childKey: "child-1", resultText: "done" });
  assert.equal(handled.length, 1);
  assert.equal(handled[0].resultText, "done");
  await harness.manager.leave();
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

test("discord join failure responses and operator log never carry the configured bot token", async () => {
  const token = "dsc-sentinel-41";
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    const harness = createHarness({
      discordConfig: { token, guildAllowlist: [GUILD_ID] },
      loginError: new Error(`vendor rejected token=${token} (Authorization: Bot ${token})`),
    });
    const result = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, "DISCORD_JOIN_FAILED");
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes(token), false, serialized);
    assert.match(result.body.message, /vendor rejected token=\[REDACTED\]/);
    const joinLogs = errors.filter((line) => line.includes("Discord join failed"));
    assert.equal(joinLogs.length, 1, JSON.stringify(errors));
    assert.equal(joinLogs[0].includes(token), false, joinLogs[0]);
    assert.equal(harness.coordinatorState.releaseCalls, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test("scrubJoinErrorMessage strips the secret and generic token pairs without touching other text", () => {
  const { scrubJoinErrorMessage } = require("../src/transport-discord/discord-session");
  assert.equal(scrubJoinErrorMessage("429 identify", "dsc-secret-x"), "429 identify");
  assert.equal(scrubJoinErrorMessage("bad dsc-secret-x here", "dsc-secret-x"), "bad [REDACTED] here");
  assert.equal(scrubJoinErrorMessage("token: abc.def.ghi", ""), "token: [REDACTED]");
  assert.equal(scrubJoinErrorMessage(undefined, "x"), "");
});
