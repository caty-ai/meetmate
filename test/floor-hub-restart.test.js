"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { resolveFloorHubDir, spawnFloorHub } = require("./tools/meet-script-driver");
const { FloorClient, STATES } = require("../src/floor-client");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("condition was not met before timeout");
}

async function waitForResult(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

function ensureFloorHubAvailable(t, hubDir) {
  if (fs.existsSync(path.join(hubDir, "server.js"))) return true;
  if (process.env.MEET_FLOOR_HUB_REQUIRED === "1") {
    throw new Error(`MEET_FLOOR_HUB_REQUIRED=1 but floor hub is missing: ${hubDir}`);
  }
  t.skip(`MEET FLOOR HUB MISSING — offline DW suite not executed: ${hubDir}`);
  return false;
}

function roundSequence(roundId) {
  const match = /^r(\d+)$/u.exec(String(roundId || ""));
  return match ? Number(match[1]) : null;
}

test("floor clients recover from a hub restart whose round sequence resets", async (t) => {
  const hubDir = resolveFloorHubDir();
  if (!ensureFloorHubAvailable(t, hubDir)) return;

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
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  settingsBootstrap.resetStartupForTest();
  settingsResolver.resetRuntimeForTest();

  const hub = await spawnFloorHub({ hubDir, stdio: true });
  t.after(async () => hub.stop());
  const hubIdentity = { url: hub.url, token: hub.token, WebSocketImpl: hub.WebSocketImpl };

  const src = path.join(__dirname, "..", "src");
  const paths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "pipeline.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(paths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of paths) delete require.cache[require.resolve(file)];

  const sttEmitters = [];
  const calls = [];
  const spoken = [];
  const spokenRoles = [];
  const audioWindows = new Map([["caty", []], ["ciel", []]]);
  const assignments = [];
  let observePostRestartAssignments = false;
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
    synthesize: async (text, { onAudio, role }) => {
      spoken.push(text);
      spokenRoles.push(role);
      await sleep(20);
      onAudio(Buffer.alloc(320));
      await sleep(10);
    },
  });

  const pipelines = [];
  const floorClients = [];
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
        tts: { provider: "fish-audio", referenceId: profile.agentId, sampleRate: 16_000, latency: "balanced", speed: 1 },
        hub: { enabled: true, url: hub.url, roomCode: "dw4-room", authToken: hub.token, tailMs: 100 },
        echoCooldownMs: 0,
        greeting: `${profile.agentId} greeting`,
      };
      const session = { id: `dw4-${profile.agentId}`, conversationLog: [], config: { wakeMode: "wake" } };
      const floorClient = new FloorClient({
        url: hub.url,
        roomCode: "dw4-room",
        authToken: hub.token,
        agentId: profile.agentId,
        displayName: profile.displayName,
        wakeWords: profile.wakeWords,
        WebSocketImpl: hub.WebSocketImpl,
      });
      floorClient.on("assignment", (assignment) => {
        if (observePostRestartAssignments) assignments.push(assignment);
      });
      floorClients.push(floorClient);
      const pipeline = createPipeline(session, {
        isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0,
      }, (buffer) => {
        const start = performance.now();
        audioWindows.get(profile.agentId).push({
          start,
          end: start + (buffer.length / 2 / config.tts.sampleRate * 1_000),
        });
      }, config, {
        agentProfile: profile,
        floorClient,
        _testExposeInternals: true,
      });
      pipelines.push(pipeline);
    }

    await waitFor(() => floorClients.every((client) => client.members.length === 2));
    await waitFor(() => spoken.some((text) => text.includes("greeting")));
    await sleep(800);

    const emitBoth = (text) => {
      sttEmitters[0].emit("utterance_end", text);
      sttEmitters[1].emit("utterance_end", text);
    };
    const waitOpen = () => waitFor(() => pipelines.every((pipeline) => pipeline._test.getGateState() === "OPEN"));

    const beforeDirected = calls.length;
    for (const [index, label] of ["一", "二", "三"].entries()) {
      emitBoth(`ケイティ、再起動前${label}`);
      await waitFor(() => calls.length === beforeDirected + index + 1);
      await waitOpen();
    }
    assert.deepEqual(calls.slice(beforeDirected).map((call) => call.agentId), ["caty", "caty", "caty"]);
    for (const client of floorClients) {
      assert.ok(client.latestRoundSequence >= 3, `pre-restart round sequence was ${client.latestRoundSequence}`);
    }
    const preRestartMaximum = Math.max(...floorClients.map((client) => client.latestRoundSequence));

    await hub.restart();
    assert.equal(hub.url, hubIdentity.url);
    assert.equal(hub.token, hubIdentity.token);
    assert.equal(hub.WebSocketImpl, hubIdentity.WebSocketImpl);
    await waitFor(() => floorClients.every((client) => (
      client.state === STATES.READY && client.members.length === 2
    )));

    observePostRestartAssignments = true;
    const beforePostRestartCalls = calls.length;
    const beforeCatyAudio = audioWindows.get("caty").length;
    const beforeCielAudio = audioWindows.get("ciel").length;
    emitBoth("シエル、再起動後も聞こえる？");
    await waitFor(() => assignments.length >= floorClients.length);
    const firstPostRestartSequence = roundSequence(assignments[0].roundId);
    assert.notEqual(firstPostRestartSequence, null);
    assert.ok(
      firstPostRestartSequence < preRestartMaximum,
      `post-restart round sequence ${firstPostRestartSequence} did not reset below ${preRestartMaximum}`,
    );

    const namedAgentResponded = await waitForResult(() => calls.length > beforePostRestartCalls, 2_000);
    assert.equal(namedAgentResponded, true, "named agent responded on the first post-restart directed utterance");
    await waitFor(() => audioWindows.get("ciel").length > beforeCielAudio);
    await waitOpen();
    await sleep(100);

    assert.deepEqual(calls.slice(beforePostRestartCalls).map((call) => call.agentId), ["ciel"]);
    assert.equal(audioWindows.get("caty").length, beforeCatyAudio);
    const catyWindows = audioWindows.get("caty");
    const cielWindows = audioWindows.get("ciel");
    for (const catyWindow of catyWindows) {
      for (const cielWindow of cielWindows) {
        assert.equal(
          catyWindow.end <= cielWindow.start || cielWindow.end <= catyWindow.start,
          true,
          `cross-agent PCM overlap: caty=${JSON.stringify(catyWindow)} ciel=${JSON.stringify(cielWindow)}`,
        );
      }
    }
    assert.equal(pipelines.every((pipeline) => pipeline._test.getGateState() === "OPEN"), true);
    assert.equal(spokenRoles.includes("ack"), false);
  } finally {
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
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
  }
});
