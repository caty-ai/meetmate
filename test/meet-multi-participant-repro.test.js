"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { resolveFloorHubDir, spawnFloorHub } = require("./tools/meet-script-driver");
const { FloorClient } = require("../src/floor-client");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("condition was not met before timeout");
}

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

test("real hub arbitrates two pipelines across DW0-DW3 and DW6", async (t) => {
  const hubDir = resolveFloorHubDir();
  if (!fs.existsSync(path.join(hubDir, "server.js"))) {
    t.skip(`MEET FLOOR HUB MISSING — offline DW suite not executed: ${hubDir}`);
    return;
  }

  const previousEnv = {
    POST_UTTERANCE_BUFFER_MS: process.env.POST_UTTERANCE_BUFFER_MS,
    ENABLE_IMMEDIATE_ACK: process.env.ENABLE_IMMEDIATE_ACK,
    ENABLE_PROGRESS_GUARD: process.env.ENABLE_PROGRESS_GUARD,
    TTS_GAP_MS: process.env.TTS_GAP_MS,
    TTS_LEAD_MS: process.env.TTS_LEAD_MS,
    SENTENCE_PAUSE_MS: process.env.SENTENCE_PAUSE_MS,
  };
  process.env.POST_UTTERANCE_BUFFER_MS = "0";
  process.env.ENABLE_IMMEDIATE_ACK = "false";
  process.env.ENABLE_PROGRESS_GUARD = "false";
  process.env.TTS_GAP_MS = "0";
  process.env.TTS_LEAD_MS = "0";
  process.env.SENTENCE_PAUSE_MS = "0";

  // The managed test sandbox forbids TCP listen(). The hub still runs as a
  // real child process from its own repo; a newline-framed WebSocket adapter
  // exercises its shipped validateMessage/rooms/floor/arbitration modules.
  const hub = await spawnFloorHub({ hubDir, stdio: true });
  t.after(async () => hub.stop());

  const src = path.join(__dirname, "..", "src");
  const paths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(paths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of paths) delete require.cache[require.resolve(file)];

  const sttEmitters = [];
  const calls = [];
  const spoken = [];
  const pipelineErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (String(args[0] || "").includes("❌")) pipelineErrors.push(args.map(String).join(" "));
    originalConsoleError(...args);
  };
  let activeSynthesis = 0;
  let maxActiveSynthesis = 0;
  const sttExports = {
    createSTT: () => {
      const emitter = new EventEmitter();
      emitter.send = () => {};
      emitter.close = () => {};
      sttEmitters.push(emitter);
      return emitter;
    },
    buildKeyterms: () => [],
  };
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      streamChat: async function* (messages, options) {
        const agentId = String(options.sessionUser).endsWith("-ciel") ? "ciel" : "caty";
        calls.push({ agentId, prompt: messages.at(-1).content });
        yield `${agentId}の回答です。`;
      },
    }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => {
      activeSynthesis += 1;
      maxActiveSynthesis = Math.max(maxActiveSynthesis, activeSynthesis);
      spoken.push(text);
      onAudio(Buffer.alloc(320));
      activeSynthesis -= 1;
    },
  });

  const pipelines = [];
  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const profiles = [
      { agentId: "caty", displayName: "Caty", wakeWords: ["ケイティ", "caty"] },
      { agentId: "ciel", displayName: "Ciel", wakeWords: ["シエル", "ciel"] },
    ];
    for (const profile of profiles) {
      const config = {
        dgKey: "x",
        fishKey: "x",
        stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
        llm: { provider: "openclaw", model: "test", temperature: 0, maxTokens: 64, responseTimeoutMs: 0, firstTokenDelegateMs: 0, openclawSystemAddendum: "" },
        tts: { provider: "fish-audio", referenceId: null, sampleRate: 16_000, latency: "balanced", speed: 1 },
        hub: { enabled: true, url: hub.url, roomCode: "dw-room", authToken: hub.token, tailMs: 100 },
        echoCooldownMs: 0,
        greeting: `${profile.agentId} greeting`,
      };
      const session = { id: `dw-${profile.agentId}`, conversationLog: [], config: { wakeMode: "wake" } };
      const pipeline = createPipeline(session, {
        isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0,
      }, () => {}, config, {
        agents: { [profile.agentId]: profile },
        selectedAgentIds: [profile.agentId],
        defaultAgentId: profile.agentId,
        agentProfile: profile,
        floorClient: new FloorClient({
          url: hub.url,
          roomCode: "dw-room",
          authToken: hub.token,
          agentId: profile.agentId,
          displayName: profile.displayName,
          wakeWords: profile.wakeWords,
          WebSocketImpl: hub.WebSocketImpl,
        }),
        _testExposeInternals: true,
      });
      pipelines.push(pipeline);
    }

    await waitFor(() => pipelines.every((pipeline) => pipeline._test.getFloorState().members?.length === 2));
    await waitFor(() => spoken.some((text) => text.includes("greeting")), 4_000);
    await sleep(800);
    assert.equal(spoken.filter((text) => text.includes("greeting")).length, 1);

    const emitBoth = (catyText, cielText = catyText) => {
      sttEmitters[0].emit("utterance_end", catyText);
      sttEmitters[1].emit("utterance_end", cielText);
    };
    const waitOpen = () => waitFor(() => pipelines.every((pipeline) => pipeline._test.getGateState() === "OPEN"));

    // DW0: transcript divergence still yields one named responder.
    emitBoth("ケイティ、予算案を説明して", "ケーティ、予算案を説明して");
    await waitFor(() => calls.length === 1);
    await waitOpen();
    assert.equal(calls[0].agentId, "caty");

    // DW1: both-name ballots honor first occurrence in either order.
    emitBoth("ケイティ、シエル、どちらか答えて");
    await waitFor(() => calls.length === 2);
    await waitOpen();
    assert.equal(calls[1].agentId, "caty");
    emitBoth("シエル、ケイティ、どちらか答えて");
    await waitFor(() => calls.length === 3);
    await waitOpen();
    assert.equal(calls[2].agentId, "ciel");

    // DW2: inject the handoff while speech is still held; the third agent
    // turn is capped by hub chainDepth and the recipient retains prior text.
    const beforeOriginalSpeech = spoken.length;
    emitBoth("ケイティ、原案の予算について答えて");
    await waitFor(() => calls.length === 4 && spoken.length > beforeOriginalSpeech);
    const beforeHandoffSpeech = spoken.length;
    emitBoth("シエル、今の原案の予算を引き継いで", "シエル、原案予算を引き継いで");
    await waitFor(() => calls.length === 5 && spoken.length > beforeHandoffSpeech);
    emitBoth("ケイティ、さらに続けて");
    await sleep(900);
    assert.equal(calls.length, 5);
    assert.match(calls[4].prompt, /原案.*予算|予算.*原案/u);
    await waitOpen();

    // DW3: three rapid directed utterances produce one response apiece,
    // never a delayed second response from the other instance.
    const beforeRapid = calls.length;
    for (const label of ["一", "二", "三"]) {
      emitBoth(`ケイティ、連呼${label}`);
      await waitFor(() => calls.length === beforeRapid + Number({ 一: 1, 二: 2, 三: 3 }[label]));
      await waitOpen();
    }
    assert.deepEqual(calls.slice(beforeRapid).map((call) => call.agentId), ["caty", "caty", "caty"]);

    // DW6 floor fence: all emitted PCM was serialized to one holder.
    assert.equal(maxActiveSynthesis, 1);
    assert.equal(spoken.length >= calls.length, true);
    assert.deepEqual(pipelineErrors, []);
    assert.equal(pipelines.every((pipeline) => pipeline._test.getGateState() === "OPEN"), true);
  } finally {
    console.error = originalConsoleError;
    for (const pipeline of pipelines) pipeline.close();
    for (const file of paths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
