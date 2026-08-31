"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const routesPath = require.resolve("../src/transport-meet/meet-routes");
const configPath = require.resolve("../src/config");
const pipelinePath = require.resolve("../src/pipeline");
const profilePath = require.resolve("../src/agent-profile");
const deepgramPath = require.resolve("@deepgram/sdk");

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

test("createHandler selects pipeline mode for every supported TTS provider and legacy mode otherwise", () => {
  const paths = [routesPath, configPath, pipelinePath, profilePath, deepgramPath];
  const previous = new Map(paths.map((filename) => [filename, require.cache[filename]]));
  const originalLog = console.log;
  const originalWarn = console.warn;
  let pipelineCalls = 0;
  let legacyCalls = 0;
  const warnings = [];
  try {
    const actualConfig = require(configPath);
    require.cache[pipelinePath] = cacheEntry(pipelinePath, {
      createPipeline() {
        pipelineCalls += 1;
        return {
          sendAudio() {},
          close() {},
        };
      },
    });
    require.cache[profilePath] = cacheEntry(profilePath, {
      AgentNotFoundError: class AgentNotFoundError extends Error {},
      resolveAgentProfile: () => ({
        agentId: "test-agent",
        name: "Test Agent",
        displayName: "Test Agent",
        voiceId: "voice",
        model: "model",
      }),
    });
    const AgentEvents = {
      Open: "open",
      Audio: "audio",
      Error: "error",
      Close: "close",
      Welcome: "welcome",
      ConversationText: "conversationText",
      AgentThinking: "agentThinking",
      AgentStartedSpeaking: "agentStartedSpeaking",
      UserStartedSpeaking: "userStartedSpeaking",
      AgentAudioDone: "agentAudioDone",
    };
    require.cache[deepgramPath] = cacheEntry(deepgramPath, {
      AgentEvents,
      createClient: () => ({
        agent() {
          legacyCalls += 1;
          const agent = new EventEmitter();
          agent.configure = () => {};
          agent.keepAlive = () => {};
          agent.send = () => {};
          agent.finish = () => agent.emit(AgentEvents.Close);
          return agent;
        },
      }),
    });
    console.log = () => {};
    console.warn = (...args) => warnings.push(args.join(" "));

    for (const provider of ["fish-audio", "elevenlabs", "openai-compatible", "legacy-deepgram"]) {
      require.cache[configPath] = cacheEntry(configPath, {
        ...actualConfig,
        HUB_CONFIG: { enabled: true },
        TTS_PROVIDER: provider,
        getPipelineConfig: () => ({}),
      });
      delete require.cache[routesPath];
      const { createHandler } = require(routesPath)._test;
      const beforePipeline = pipelineCalls;
      const beforeLegacy = legacyCalls;
      const beforeWarnings = warnings.length;
      const handler = createHandler(
        { id: provider, config: {}, conversationLog: [] },
        { isAgentSpeaking: false, inputCooldownUntil: 0 },
        () => {},
      );
      handler.close();
      if (provider === "legacy-deepgram") {
        assert.equal(pipelineCalls, beforePipeline, provider);
        assert.equal(legacyCalls, beforeLegacy + 1, provider);
        assert.equal(warnings.length, beforeWarnings + 1, provider);
        assert.match(warnings.at(-1), /requires a pipeline TTS provider/);
      } else {
        assert.equal(pipelineCalls, beforePipeline + 1, provider);
        assert.equal(legacyCalls, beforeLegacy, provider);
        assert.equal(warnings.length, beforeWarnings, provider);
      }
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    for (const filename of paths) {
      delete require.cache[filename];
      const entry = previous.get(filename);
      if (entry) require.cache[filename] = entry;
    }
  }
});
