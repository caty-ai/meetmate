"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDiscordSessionManager } = require("../src/transport-discord/discord-session");

const GUILD_ID = "11111111111111111";
const CHANNEL_ID = "22222222222222222";

test("discord join refuses missing optional runtime dependencies before acquire", async () => {
  for (const scenario of [
    {
      name: "@discordjs/voice missing",
      loadVoiceModule() {
        const error = new Error("Cannot find module '@discordjs/voice'");
        error.code = "MODULE_NOT_FOUND";
        throw error;
      },
      loadDiscordModule() {
        return { GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 }, Client: function MockClient() {} };
      },
    },
    {
      name: "discord.js missing",
      loadVoiceModule() {
        return { VoiceConnectionStatus: { Ready: "ready" } };
      },
      loadDiscordModule() {
        const error = new Error("Cannot find module 'discord.js'");
        error.code = "MODULE_NOT_FOUND";
        throw error;
      },
    },
  ]) {
    let acquireCalls = 0;
    let releaseCalls = 0;

    const manager = createDiscordSessionManager({
      getDiscordConfig: () => ({ token: "discord-token", guildAllowlist: [GUILD_ID] }),
      getPipelineConfig: () => ({
        systemPrompt: "system",
        greeting: "hello",
        fishKey: "fish-key",
        llm: { model: "gpt-test", provider: "openclaw" },
        tts: { sampleRate: 24000, referenceId: "voice", latency: "balanced", speed: 1 },
        slack: { enabled: false, channelId: "", statusChannelId: "", summaryChannelId: "", notifyTarget: "dm", dmUserId: "", labels: {} },
        summary: { prompt: "summary" },
      }),
      resolveAgentProfile: () => ({
        agentId: "caty",
        name: "Caty",
        displayName: "Caty",
        model: "gpt-test",
        voiceId: "voice",
        wakeWords: ["ケイティ"],
      }),
      sessionCoordinator: {
        tryAcquire() {
          acquireCalls += 1;
          return Object.freeze({ transport: "discord", sessionId: "dc-test" });
        },
        release() {
          releaseCalls += 1;
        },
        active() {
          return null;
        },
      },
      loadVoiceModule: scenario.loadVoiceModule,
      loadDiscordModule: scenario.loadDiscordModule,
      createClient() {
        throw new Error("createClient should not run when dependencies are missing");
      },
    });

    const result = await manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
    assert.equal(result.status, 503, scenario.name);
    assert.equal(result.body.code, "DISCORD_DEPENDENCY_MISSING", scenario.name);
    assert.equal(result.body.message, "Discord voice libraries are not installed; see the server log", scenario.name);
    assert.equal(acquireCalls, 0, scenario.name);
    assert.equal(releaseCalls, 0, scenario.name);
  }
});
