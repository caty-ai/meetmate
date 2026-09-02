"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { getPipelineConfig, TTS_PROVIDER } = require("../config");
const { resolveAgentProfile } = require("../agent-profile");
const { warmUpGatewaySession } = require("../gateway-warmup");
const { createPipeline } = require("../pipeline");
const { SessionLifecycle } = require("../session-events");
const { SlackNotifier } = require("../slack-notifier");
const { summarizeConversation } = require("../summarizer");
const { getEffectiveValue, meaningful, resolveDynamicSlackToken } = require("../settings/resolver");
const gatewayEvents = require("../gateway-events");
const { recordEvent } = require("../metrics");
const { createGatewaySessionTracker } = require("../gateway-session-tracker");
const sessionCoordinator = require("../session-coordinator");
const { sessionUserFor } = require("../session-user");
const { CAPABILITIES, TRANSPORT } = require("./constants");
const { isGuildAllowed, isValidSnowflake, parseAllowlist } = require("./allowlist");
const { renderAnnounceText, runAnnounce } = require("./announce");
const { createAudioIn } = require("./audio-in");
const { createAudioOut } = require("./audio-out");

function createDiscordClientFactory(loadDiscordModule = () => require("discord.js")) {
  return function createClient() {
    const discord = loadDiscordModule();
    return new discord.Client({
      intents: [
        discord.GatewayIntentBits.Guilds,
        discord.GatewayIntentBits.GuildVoiceStates,
      ],
    });
  };
}

function createJoinVoiceFactory(loadVoiceModule = () => require("@discordjs/voice")) {
  return function joinVoice(target) {
    const voice = loadVoiceModule();
    return voice.joinVoiceChannel({
      channelId: target.channel.id,
      guildId: target.guild.id,
      adapterCreator: target.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
  };
}

function defaultResolveVoiceTarget(client, guildId, channelId) {
  return Promise.resolve().then(async () => {
    const guild = client.guilds?.cache?.get(guildId) || await client.guilds?.fetch?.(guildId);
    if (!guild) throw new Error(`Discord guild not found: ${guildId}`);
    const channel = guild.channels?.cache?.get(channelId) || await guild.channels?.fetch?.(channelId);
    if (!channel) throw new Error(`Discord channel not found: ${channelId}`);
    return { guild, channel, receiver: null };
  });
}

function buildNotifier(pipelineConfig) {
  const fallback = pipelineConfig.slack.channelId || "";
  const summaryChannel = pipelineConfig.slack.summaryChannelId || fallback;
  const statusChannel = pipelineConfig.slack.statusChannelId || summaryChannel || fallback;
  const slackAuth = resolveDynamicSlackToken();
  return new SlackNotifier(slackAuth, fallback, {
    enabled: pipelineConfig.slack.enabled && meaningful(slackAuth),
    notifyTarget: pipelineConfig.slack.notifyTarget || "dm",
    dmUserId: pipelineConfig.slack.dmUserId || "",
    statusChannelId: statusChannel,
    summaryChannelId: summaryChannel,
    labels: pipelineConfig.slack.labels,
  });
}

function createSessionId(now = () => Date.now(), randomBytes = crypto.randomBytes) {
  return `dc-${now()}-${randomBytes(3).toString("hex")}`;
}

function createTurnState() {
  return {
    isAgentSpeaking: false,
    lastTurnEndAt: null,
    inputCooldownUntil: 0,
    droppedEchoFrames: 0,
  };
}

function createDiscordSessionManager(options = {}) {
  const getDiscordConfig = options.getDiscordConfig || (() => null);
  const getPipelineConfigImpl = options.getPipelineConfig || getPipelineConfig;
  const ttsProvider = options.ttsProvider || TTS_PROVIDER;
  const resolveAgentProfileImpl = options.resolveAgentProfile || resolveAgentProfile;
  const createPipelineImpl = options.createPipeline || createPipeline;
  const warmUpGatewaySessionImpl = options.warmUpGatewaySession || warmUpGatewaySession;
  const synthesizeImpl = options.synthesize || require("../tts-fish").synthesize;
  const createAudioInImpl = options.createAudioIn || createAudioIn;
  const createAudioOutImpl = options.createAudioOut || createAudioOut;
  const SessionLifecycleImpl = options.SessionLifecycle || SessionLifecycle;
  const coordinator = options.sessionCoordinator || sessionCoordinator;
  const createClient = options.createClient || createDiscordClientFactory(options.loadDiscordModule);
  const joinVoice = options.joinVoice || createJoinVoiceFactory(options.loadVoiceModule);
  const resolveVoiceTarget = options.resolveVoiceTarget || defaultResolveVoiceTarget;
  const summarizeConversationImpl = options.summarizeConversation || summarizeConversation;
  const notifierFactory = options.createNotifier || buildNotifier;
  const now = options.now || (() => Date.now());
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const timers = options.timers || globalThis;
  const reconnectWindowMs = Number(options.reconnectWindowMs || 500);
  const loadVoiceModule = options.loadVoiceModule || (() => require("@discordjs/voice"));
  const loadDiscordModule = options.loadDiscordModule || (() => require("discord.js"));
  const waitForReconnect = options.waitForReconnect || ((connection, timeoutMs) => {
    const voice = loadVoiceModule();
    return voice.entersState(connection, voice.VoiceConnectionStatus.Ready, timeoutMs);
  });
  const onSessionReady = options.onSessionReady || (() => {});
  const gatewayEventsImpl = options.gatewayEvents || gatewayEvents;
  const gatewaySessions = new Map();
  const gatewayConnections = new Map();
  const getGatewayConfigForProfileImpl = options.getGatewayConfigForProfile || ((profile) => {
    const config = getPipelineConfigImpl({}, null, profile);
    return {
      ...(config.gatewayEvents || {}),
      name: config.llm?.provider,
      openclawUrl: config.llm?.gateway?.url,
      openclawToken: config.llm?.gateway?.token,
    };
  });
  const gatewayTracker = options.gatewayTracker || createGatewaySessionTracker({
    gatewayEvents: gatewayEventsImpl,
    recordEvent: options.recordEvent || recordEvent,
    sessions: gatewaySessions,
    activeConnections: gatewayConnections,
    getGatewayConfigForProfile: getGatewayConfigForProfileImpl,
    getDefaultAgentId: () => resolveAgentProfileImpl()?.agentId || "agent",
    appendLateResult: () => false,
  });
  let active = null;
  let loginChain = Promise.resolve();

  function isCurrent(session) {
    return active && session && active.id === session.id;
  }

  function getStatus() {
    const startedAt = active?.startedAt || active?.session?.startedAt || null;
    return {
      ok: true,
      transport: TRANSPORT,
      configured: Boolean(getDiscordConfig()),
      session: active
        ? {
            sessionId: active.id,
            state: active.lifecycle.state,
            lifecycle: active.lifecycle.state,
            startedAt,
            connectionReady: Boolean(active.connectionReady),
          }
        : null,
    };
  }

  function buildSingleAgentMap(profile) {
    return {
      [profile.agentId]: {
        ...profile,
        voiceId: profile.voiceId,
        model: profile.model,
      },
    };
  }

  function subscribeExistingHumans(session) {
    const members = session.channel?.members?.values?.() || [];
    for (const member of members) {
      const user = member?.user || member;
      if (!user || user.bot === true) continue;
      session.audioIn.subscribeUser(session.receiver, {
        id: String(user.id),
        displayName: member?.displayName || user.username || user.globalName || undefined,
        isBot: false,
      });
    }
  }

  function bindLifecycleObservers(session) {
    const voice = loadVoiceModule();
    const readyStatus = voice.VoiceConnectionStatus?.Ready || "ready";
    const destroyedStatus = voice.VoiceConnectionStatus?.Destroyed || "destroyed";
    const disconnectedStatus = voice.VoiceConnectionStatus?.Disconnected || "disconnected";

    const finalize = async (reason, currentState = session.lifecycle.state) => {
      if (!isCurrent(session)) return;
      const terminalState = currentState === "in-progress" && reason === "voice_removed"
        ? "completed"
        : currentState === "in-progress" && reason === "channel_deleted"
          ? "completed"
          : currentState === "in-progress" && reason === "destroyed"
            ? "completed"
            : "failed";
      if (!session.lifecycle.isTerminal) {
        session.lifecycle.transition(terminalState, { reason });
      }
      await teardownSession(session, { destroyConnection: true });
    };

    const bindSafe = (emitter, event, handler) => {
      emitter?.on?.(event, async (...args) => {
        try {
          await handler(...args);
        } catch (error) {
          console.error(`Discord ${event} listener failed: ${error.message || error}`);
        }
      });
    };

    bindSafe(session.connection, "stateChange", async (oldState, newState) => {
      if (!isCurrent(session)) return;
      const status = newState?.status ?? newState;
      if (status === readyStatus) {
        session.connectionReady = true;
        return;
      }
      if (status === destroyedStatus) {
        await finalize("destroyed");
        return;
      }
      if (status === disconnectedStatus) {
        try {
          await Promise.resolve(waitForReconnect(session.connection, reconnectWindowMs));
          return;
        } catch {
          await finalize("disconnected");
        }
      }
    });

    bindSafe(session.connection, "error", async () => {
      await finalize("connection_error");
    });

    bindSafe(session.client, "invalidated", async () => {
      await finalize("gateway_invalidated");
    });

    bindSafe(session.client, "channelDelete", async (channel) => {
      if (!isCurrent(session)) return;
      if (channel?.id === session.channelId) {
        await finalize("channel_deleted");
      }
    });

    bindSafe(session.client, "voiceStateUpdate", async (oldState, newState) => {
      if (!isCurrent(session)) return;
      const liveState = newState?.id === session.botUserId ? newState : oldState?.id === session.botUserId ? oldState : null;
      if (liveState && !isGuildAllowed(session.allowlist, String(liveState.guild?.id || ""))) {
        if (!session.lifecycle.isTerminal) {
          session.lifecycle.transition("failed", { reason: "allowlist_abort" });
        }
        await teardownSession(session, { destroyConnection: true });
        return;
      }

      const movedAway = liveState && liveState.id === session.botUserId && !liveState.channelId;
      if (movedAway) {
        if (!session.lifecycle.isTerminal) {
          session.lifecycle.transition(session.lifecycle.state === "in-progress" ? "completed" : "failed", { reason: "voice_removed" });
        }
        await teardownSession(session, { destroyConnection: true });
        return;
      }

      const oldChannelId = oldState?.channelId || null;
      const newChannelId = newState?.channelId || null;
      const newUserId = newState?.member?.user?.id;
      const oldUserId = oldState?.member?.user?.id;
      const joined = newChannelId === session.channelId && oldChannelId !== session.channelId;
      const left = oldChannelId === session.channelId && newChannelId !== session.channelId;

      if (joined && newUserId && newState.member.user.bot !== true && session.audioIn) {
        session.audioIn.subscribeUser(session.receiver, {
          id: String(newUserId),
          displayName: newState.member.displayName || newState.member.user.username || undefined,
          isBot: false,
        });
      }

      if (left && oldUserId && oldState.member.user.bot !== true && session.audioIn) {
        session.audioIn.unsubscribeUser(String(oldUserId));
        if (typeof session.pipeline?.releaseSpeaker === "function") {
          session.pipeline.releaseSpeaker(String(oldUserId));
        }
      }
    });
  }

  async function maybePostSummary(session) {
    const notifier = session.notifier;
    notifier.stopElapsedUpdates(session.id);
    await notifier.postStatus(session.lifecycle);

    if (getEffectiveValue("summary_enabled") !== false && session.session.conversationLog.length > 0) {
      const summary = await summarizeConversationImpl(session.session.conversationLog, {
        llm: session.pipelineConfig.llm,
        summaryPrompt: session.pipelineConfig.summary.prompt,
        taskExtractionEnabled: getEffectiveValue("task_extraction_enabled") !== false,
      });
      await notifier.postSummary(session.lifecycle, summary);
    }
  }

  async function teardownSession(session, { destroyConnection = true } = {}) {
    if (!session || session.teardownStarted) return;
    session.teardownStarted = true;
    session.abortController.abort();
    gatewayConnections.delete(session.id);
    gatewayTracker.untrackGatewaySession(session.id);
    gatewaySessions.delete(session.id);
    session.audioIn?.close();
    session.audioOut?.close();
    session.pipeline?.close?.();
    if (destroyConnection) {
      try {
        session.connection?.destroy?.();
      } catch {
        // Voice teardown must be best-effort.
      }
    }
    try {
      session.client?.destroy?.();
    } catch {
      // Client teardown must be best-effort.
    }
    coordinator.release(session.lease);
    if (active && active.id === session.id) {
      active = null;
    }
    if (session.lifecycle.isTerminal) {
      await maybePostSummary(session).catch(() => {});
    }
  }

  async function endSession(session, reason) {
    if (!session || session.teardownStarted) return;
    if (!session.lifecycle.isTerminal) {
      const terminalState = session.lifecycle.state === "in-progress" ? "completed" : "failed";
      session.lifecycle.transition(terminalState, { reason });
    }
    await teardownSession(session, { destroyConnection: true });
  }

  async function join(body = {}) {
    const requestBody = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const guildId = typeof requestBody.guildId === "string" ? requestBody.guildId.trim() : "";
    const channelId = typeof requestBody.channelId === "string" ? requestBody.channelId.trim() : "";
    if (!isValidSnowflake(guildId) || !isValidSnowflake(channelId)) {
      return {
        status: 400,
        body: {
          ok: false,
          code: "DISCORD_INVALID_REQUEST",
          message: "guildId and channelId must be Discord snowflakes",
        },
      };
    }

    const discordConfig = getDiscordConfig();
    if (!discordConfig) {
      return {
        status: 503,
        body: {
          ok: false,
          code: "DISCORD_SETUP_REQUIRED",
          message: "Discord adapter is not configured",
        },
      };
    }

    const allowlistState = parseAllowlist(discordConfig.guildAllowlist);
    if (!allowlistState.ok) {
      return {
        status: 503,
        body: {
          ok: false,
          code: "DISCORD_ALLOWLIST_INVALID",
          message: `Discord guild allowlist is invalid (${allowlistState.code})`,
        },
      };
    }
    const allowlist = allowlistState.entries;
    if (allowlist.length === 0) {
      return {
        status: 403,
        body: {
          ok: false,
          code: "DISCORD_ALLOWLIST_REQUIRED",
          message: "Discord guild allowlist is empty",
        },
      };
    }

    if (!isGuildAllowed(allowlist, guildId)) {
      return {
        status: 403,
        body: {
          ok: false,
          code: "DISCORD_GUILD_NOT_ALLOWED",
          message: "Discord guild is not allowlisted",
        },
      };
    }

    if (ttsProvider !== "fish-audio") {
      return {
        status: 503,
        body: {
          ok: false,
          code: "DISCORD_SETUP_REQUIRED",
          message: "Discord transport requires the decomposed Fish Audio pipeline",
        },
      };
    }

    let voice;
    try {
      voice = loadVoiceModule();
      loadDiscordModule();
    } catch (error) {
      return {
        status: 503,
        body: {
          ok: false,
          code: "DISCORD_DEPENDENCY_MISSING",
          message: error.message,
        },
      };
    }

    const profile = resolveAgentProfileImpl();
    const pipelineConfig = getPipelineConfigImpl({
      prompt: typeof requestBody.prompt === "string" ? requestBody.prompt.trim() || null : null,
      greeting: typeof requestBody.greeting === "string" ? requestBody.greeting.trim() || null : null,
      model: typeof requestBody.model === "string" ? requestBody.model.trim() || null : null,
      briefing: typeof requestBody.briefing === "string" ? requestBody.briefing.trim() || null : null,
      wakeMode: "wake",
    }, null, profile);

    if (![24000, 48000].includes(pipelineConfig.tts.sampleRate)) {
      return {
        status: 503,
        body: {
          ok: false,
          code: "DISCORD_UNSUPPORTED_TTS_RATE",
          message: "Discord transport only supports 24000 or 48000 Hz TTS output",
        },
      };
    }

    const sessionId = createSessionId(now, randomBytes);
    let lease;
    try {
      lease = coordinator.tryAcquire(TRANSPORT, sessionId);
    } catch (error) {
      return {
        status: 503,
        body: {
          ok: false,
          code: "DISCORD_COORDINATOR_UNAVAILABLE",
          message: error.message,
        },
      };
    }
    if (!lease) {
      const current = coordinator.active();
      return {
        status: 409,
        body: {
          ok: false,
          code: "DISCORD_MUTEX_BUSY",
          message: "Another active voice session is already running",
          activeSession: current,
        },
      };
    }

    let sessionRecord = null;
    let client;
    try {
      const startedAt = new Date(now()).toISOString();
      sessionRecord = {
        id: sessionId,
        startedAt,
        lease,
        guildId,
        channelId,
        allowlist,
        session: {
          id: sessionId,
          createdAt: startedAt,
          startedAt,
          meetingUrl: `discord://${guildId}/${channelId}`,
          config: {
            prompt: pipelineConfig.systemPrompt || null,
            greeting: pipelineConfig.greeting || null,
            model: pipelineConfig.llm.model || null,
            wakeMode: "wake",
            agentIds: [profile.agentId],
            defaultAgentId: profile.agentId,
          },
          conversationLog: [],
          conversationLogs: {
            [profile.agentId]: [],
          },
          gatewayDelegationState: { inFlightCount: 0, pendingQueueCount: 0 },
          agents: [profile.displayName || profile.name || profile.agentId],
        },
        profile,
        pipelineConfig,
        notifier: notifierFactory(pipelineConfig),
        lifecycle: new SessionLifecycleImpl(sessionId, TRANSPORT, {
          to: `#${channelId}`,
          guildId,
          channelId,
          agents: [profile.displayName || profile.name || profile.agentId],
          agentIds: [profile.agentId],
        }),
        abortController: new AbortController(),
        playbackEvents: new EventEmitter(),
        teardownStarted: false,
        connectionReady: false,
      };
      sessionRecord.lifecycle.setConversationLog(sessionRecord.session.conversationLog);
      sessionRecord.lifecycle.transition("initiating");
      active = sessionRecord;

      const warmupConfig = getPipelineConfigImpl({
        prompt: pipelineConfig.systemPrompt || null,
        model: pipelineConfig.llm.model || null,
        wakeMode: "wake",
        briefing: typeof requestBody.briefing === "string" ? requestBody.briefing.trim() || null : null,
      }, null, profile);
      warmUpGatewaySessionImpl(sessionUserFor(TRANSPORT, sessionId, profile.agentId), warmupConfig, warmupConfig.briefing).catch?.(() => {});

      client = createClient();
      sessionRecord.client = client;
      loginChain = loginChain.catch(() => {}).then(() => client.login(discordConfig.token));
      await loginChain;
      if (!isCurrent(sessionRecord) || sessionRecord.abortController.signal.aborted) {
        throw new Error("Discord join aborted");
      }

      sessionRecord.botUserId = String(client.user?.id || "discord-bot");
      const target = await resolveVoiceTarget(client, guildId, channelId);
      const liveGuildId = String(target.guild?.id || guildId);
      if (!isGuildAllowed(allowlist, liveGuildId)) {
        throw Object.assign(new Error("Discord guild is not allowlisted"), { code: "allowlist_abort" });
      }
      sessionRecord.guild = target.guild;
      sessionRecord.channel = target.channel;
      sessionRecord.connection = joinVoice(target);
      sessionRecord.receiver = target.receiver || sessionRecord.connection.receiver;
      sessionRecord.audioOut = createAudioOutImpl({
        sampleRate: pipelineConfig.tts.sampleRate,
        connection: sessionRecord.connection,
        voice,
        eventSource: sessionRecord.playbackEvents,
      });
      bindLifecycleObservers(sessionRecord);

      const announceText = renderAnnounceText(profile.displayName || profile.name || profile.agentId, profile.wakeWords);
      const announceResult = await runAnnounce({
        audioOut: sessionRecord.audioOut,
        synthesize: synthesizeImpl,
        synthOptions: {
          apiKey: pipelineConfig.fishKey,
          referenceId: pipelineConfig.tts.referenceId,
          latency: pipelineConfig.tts.latency,
          speed: pipelineConfig.tts.speed,
        },
        text: announceText,
        sampleRate: pipelineConfig.tts.sampleRate,
        signal: sessionRecord.abortController.signal,
        loadVoiceModule: () => voice,
        timers,
      });
      if (!announceResult.ok) {
        throw Object.assign(new Error(`Discord announce failed: ${announceResult.code}`), {
          code: announceResult.code,
        });
      }

      sessionRecord.turnState = createTurnState();
      const agentMap = buildSingleAgentMap(profile);
      sessionRecord.pipeline = createPipelineImpl(
        sessionRecord.session,
        sessionRecord.turnState,
        (buffer, metadata) => sessionRecord.audioOut.onAudio(buffer, metadata),
        pipelineConfig,
        {
          transport: TRANSPORT,
          capabilities: CAPABILITIES,
          suppressGreeting: true,
          agents: agentMap,
          selectedAgentIds: [profile.agentId],
          defaultAgentId: profile.agentId,
          agentProfile: profile,
        }
      );
      sessionRecord.pipeline.on?.("playback_cancelled", (event) => {
        sessionRecord.playbackEvents.emit("playback_cancelled", event);
      });
      sessionRecord.pipeline.on?.("exit_requested", (event) => {
        if (sessionRecord.teardownStarted || active !== sessionRecord) return;
        console.log(`🚪  Discord exit requested for session ${sessionRecord.id}: ${event?.trigger || "unknown"}`);
        endSession(sessionRecord, "exit_requested").catch((error) => {
          console.error(`Discord exit_requested teardown failed: ${error?.message || error}`);
        });
      });
      gatewaySessions.set(sessionId, sessionRecord.session);
      gatewayConnections.set(sessionId, { handler: sessionRecord.pipeline });
      gatewayTracker.trackGatewaySession(sessionRecord.session, profile, TRANSPORT);
      sessionRecord.audioIn = createAudioInImpl({
        sendAudio: sessionRecord.pipeline.sendAudio.bind(sessionRecord.pipeline),
        releaseSpeaker: typeof sessionRecord.pipeline.releaseSpeaker === "function"
          ? sessionRecord.pipeline.releaseSpeaker.bind(sessionRecord.pipeline)
          : undefined,
        loadVoiceModule: () => voice,
      });
      subscribeExistingHumans(sessionRecord);
      sessionRecord.lifecycle.transition("in-progress", { reason: "ready" });
      sessionRecord.notifier.postStatus(sessionRecord.lifecycle).catch(() => {});
      sessionRecord.notifier.startElapsedUpdates(sessionRecord.lifecycle);
      onSessionReady(sessionRecord);

      return {
        status: 200,
        body: {
          ok: true,
          sessionId,
          guildId,
          channelId,
          state: sessionRecord.lifecycle.state,
          announceText,
        },
      };
    } catch (error) {
      if (sessionRecord?.lifecycle && !sessionRecord.lifecycle.isTerminal) {
        sessionRecord.lifecycle.transition("failed", { reason: error.code || "discord_join_failed" });
      }
      if (sessionRecord) {
        await teardownSession(sessionRecord, { destroyConnection: true });
      } else {
        coordinator.release(lease);
        if (active?.id === sessionId) active = null;
      }
      return {
        status: 502,
        body: {
          ok: false,
          code: error.code === "aborted" ? "DISCORD_JOIN_ABORTED" : "DISCORD_JOIN_FAILED",
          message: error.message,
        },
      };
    }
  }

  async function leave() {
    if (!active) {
      return {
        status: 404,
        body: {
          ok: false,
          code: "DISCORD_SESSION_NOT_FOUND",
          message: "No active Discord session",
        },
      };
    }

    const session = active;
    await endSession(session, "leave_requested");
    return {
      status: 200,
      body: {
        ok: true,
        sessionId: session.id,
        state: session.lifecycle.state,
      },
    };
  }

  async function shutdown() {
    if (active) {
      await leave();
    }
  }

  return {
    getStatus,
    join,
    leave,
    shutdown,
    _test: {
      getActiveSession() {
        return active;
      },
    },
  };
}

module.exports = {
  createDiscordSessionManager,
  _test: {
    buildNotifier,
    createSessionId,
    createTurnState,
  },
};
