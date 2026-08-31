const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

test("canDispatchHandoff blocks on in-flight cap and cooldown until expiry", async () => {
  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        handoffInflightMax: 2,
        handoffCooldownMs: 0,
        reportVoiceEnabled: false,
      },
    });

    assert.equal(pipeline._test.canDispatchHandoff(1_000), true);
    pipeline._test.markHandoffDispatched("first", "forced", 1_000);
    assert.equal(pipeline._test.canDispatchHandoff(1_001), true);
    pipeline._test.markHandoffDispatched("second", "forced", 1_001);
    assert.equal(pipeline._test.canDispatchHandoff(1_002), false);
    assert.equal(pipeline._test.canDispatchHandoff(1_001 + 5 * 60 * 1_000 + 1), true);
    pipeline.close();
  });

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        handoffInflightMax: 10,
        handoffCooldownMs: 1_000,
        reportVoiceEnabled: false,
      },
    });

    assert.equal(pipeline._test.canDispatchHandoff(10_000), true);
    pipeline._test.markHandoffDispatched("cooldown", "forced", 10_000);
    assert.equal(pipeline._test.canDispatchHandoff(10_999), false);
    assert.equal(pipeline._test.canDispatchHandoff(11_000), true);
    pipeline.close();
  });
});

test("pending handoff dispatch retries failure once and succeeds without dropping", async () => {
  const metricsEvents = [];

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        handoffInflightMax: 2,
        handoffCooldownMs: 0,
        reportVoiceEnabled: false,
      },
    });
    let attempts = 0;
    let successfulDispatches = 0;

    assert.equal(pipeline._test.enqueuePendingHandoff("transcript", "retry-once", async () => {
      attempts += 1;
      if (attempts === 1) return false;
      successfulDispatches += 1;
      return true;
    }), true);

    await pipeline._test.drainPendingHandoffs();
    assert.equal(attempts, 1);
    assert.equal(successfulDispatches, 0);
    assert.equal(pipeline._test.getPendingHandoffQueueLength(), 1);

    await pipeline._test.drainPendingHandoffs();
    assert.equal(attempts, 2);
    assert.equal(successfulDispatches, 1);
    assert.equal(pipeline._test.getPendingHandoffQueueLength(), 0);
    assert.equal(metricsEvents.some((event) => event.type === "handoff_dropped"), false);
    pipeline.close();
  }, { metricsEvents });
});

test("pending handoff dispatch drops after three failed attempts and records metric", async () => {
  const warnings = [];
  const metricsEvents = [];
  const restoreWarn = captureConsoleWarn(warnings);

  try {
    await withFreshPipeline(async ({ createPipeline }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        gatewayEventsConfig: {
          enabled: true,
          handoffInflightMax: 2,
          handoffCooldownMs: 0,
          reportVoiceEnabled: false,
        },
      });
      let attempts = 0;

      assert.equal(pipeline._test.enqueuePendingHandoff("transcript", "drop-after-three", async () => {
        attempts += 1;
        return false;
      }), true);

      await pipeline._test.drainPendingHandoffs();
      await pipeline._test.drainPendingHandoffs();
      await pipeline._test.drainPendingHandoffs();

      assert.equal(attempts, 3);
      assert.equal(pipeline._test.getPendingHandoffQueueLength(), 0);
      assert.equal(warnings.some((line) => line.includes("pending handoff dropped after dispatch failures")), true);
      assert.equal(metricsEvents.some((event) => (
        event.type === "handoff_dropped"
        && event.reason === "dispatch_failed"
        && event.label === "drop-after-three"
      )), true);
      pipeline.close();
    }, { metricsEvents });
  } finally {
    restoreWarn();
  }
});

test("reportQueue overflow drops the oldest line and warns", async () => {
  const warnings = [];
  const restoreWarn = captureConsoleWarn(warnings);

  try {
    await withFreshPipeline(async ({ createPipeline }) => {
      const { pipeline, turnState } = createTestPipeline(createPipeline, {
        gatewayEventsConfig: {
          enabled: true,
          reportVoiceGapMs: 100,
          reportVoiceEnabled: true,
        },
      });

      turnState.isAgentSpeaking = true;
      for (let i = 1; i <= 11; i += 1) {
        pipeline._test.enqueueReportVoiceLine(`line-${i}`);
      }

      assert.equal(pipeline._test.getReportQueueLength(), 10);
      assert.deepEqual(pipeline._test.getReportQueueLines(), [
        "line-2",
        "line-3",
        "line-4",
        "line-5",
        "line-6",
        "line-7",
        "line-8",
        "line-9",
        "line-10",
        "line-11",
      ]);
      assert.equal(warnings.filter((line) => line.includes("report voice queue overflow")).length, 1);
      pipeline.close();
    });
  } finally {
    restoreWarn();
  }
});

test("drainReportQueue does not speak after close during a pending gap wait", async (t) => {
  const spoken = [];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline, turnState } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        reportVoiceGapMs: 2_000,
        reportVoiceEnabled: true,
      },
    });

    turnState.isAgentSpeaking = true;
    pipeline._test.enqueueReportVoiceLine("line-after-close");
    await flushMicrotasks();
    assert.equal(pipeline._test.getReportQueueLength(), 1);

    pipeline.close();
    turnState.isAgentSpeaking = false;
    t.mock.timers.tick(2_000);
    await flushMicrotasks();

    assert.deepEqual(spoken, []);
  }, { spoken });
});

test("completion chat message strips emoji and rare scripts and never returns empty", async () => {
  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        reportVoiceEnabled: false,
      },
    });

    const message = pipeline._test.buildCompletionChatMessage({
      label: "調査👍𐌰",
      resultText: "結果です🎉𐌱",
    });
    assert.equal(message, "委譲タスク結果: 調査\n結果です");
    assert.equal(/[👍🎉]/u.test(message), false);
    assert.equal(/[\u{10330}-\u{1034F}]/u.test(message), false);

    const fallback = pipeline._test.buildCompletionChatMessage({
      label: "👍𐌰",
      resultText: "🎉𐌱",
    });
    assert.equal(fallback.length > 0, true);
    assert.match(fallback, /^委譲タスク結果:/);
    pipeline.close();
  });
});

test("delegate no-spawn reply relays fresh to chat and voice, stale to chat only, and drops too-late replies", async () => {
  const metricsEvents = [];
  const chatMessages = [];
  const spoken = [];

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        handoffInflightMax: 5,
        handoffCooldownMs: 0,
        delegateReplyFreshMs: 50,
        reportVoiceGapMs: 0,
      },
      onChatMessage: async (text) => {
        chatMessages.push(text);
        return true;
      },
    });

    pipeline._test.markHandoffDispatched("fresh", "forced", Date.now(), { utteranceExcerpt: "fresh" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-fresh",
      resultText: "了解です。",
    });
    await flushMicrotasks();
    assert.equal(chatMessages.at(-1), "了解です。");
    assert.equal(spoken.includes("了解です。"), true);

    pipeline._test.markHandoffDispatched("stale", "forced", Date.now() - 75, { utteranceExcerpt: "stale" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-stale",
      resultText: "遅い回答です。",
    });
    assert.match(chatMessages.at(-1), /^\(遅くなってごめんね\) /);
    assert.equal(spoken.includes("(遅くなってごめんね) 遅い回答です。"), false);

    pipeline._test.markHandoffDispatched("drop", "forced", Date.now() - 200, { utteranceExcerpt: "drop" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-drop",
      resultText: "古すぎる回答です。",
    });
    assert.equal(chatMessages.some((text) => text.includes("古すぎる回答です。")), false);

    const replyEvents = metricsEvents.filter((event) => event.type === "delegate_replied_no_spawn");
    assert.equal(replyEvents.length, 3);
    assert.equal(replyEvents.find((event) => event.runId === "run-fresh").relayed_voice, true);
    assert.equal(replyEvents.find((event) => event.runId === "run-stale").relayed_voice, false);
    assert.equal(replyEvents.find((event) => event.runId === "run-drop").relayed_chat, false);
    pipeline.close();
  }, { metricsEvents, spoken });
});

test("delegate no-spawn reply suppresses silent text before chat and voice relay", async () => {
  const metricsEvents = [];
  const chatMessages = [];
  const spoken = [];

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        handoffInflightMax: 5,
        handoffCooldownMs: 0,
        delegateReplyFreshMs: 90_000,
        reportVoiceGapMs: 0,
      },
      onChatMessage: async (text) => {
        chatMessages.push(text);
        return true;
      },
    });

    pipeline._test.markHandoffDispatched("silent", "forced", Date.now(), { utteranceExcerpt: "silent" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-no-reply",
      resultText: "NO_REPLY",
    });
    await flushMicrotasks();

    pipeline._test.markHandoffDispatched("empty", "forced", Date.now(), { utteranceExcerpt: "empty" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-empty",
      resultText: "",
    });
    await flushMicrotasks();

    pipeline._test.markHandoffDispatched("whitespace", "forced", Date.now(), { utteranceExcerpt: "whitespace" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-whitespace",
      resultText: " \n\t ",
    });
    await flushMicrotasks();

    pipeline._test.markHandoffDispatched("normal", "forced", Date.now(), { utteranceExcerpt: "normal" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-normal",
      resultText: "通常の返答です。",
    });
    await flushMicrotasks();

    assert.deepEqual(chatMessages, ["通常の返答です。"]);
    assert.deepEqual(spoken, ["通常の返答です。"]);

    const replyEvents = metricsEvents.filter((event) => event.type === "delegate_replied_no_spawn");
    assert.equal(replyEvents.length, 4);
    for (const runId of ["run-no-reply", "run-empty", "run-whitespace"]) {
      const event = replyEvents.find((candidate) => candidate.runId === runId);
      assert.equal(event.suppressed, true);
      assert.equal(event.relayed_chat, false);
      assert.equal(event.relayed_voice, false);
    }
    const normal = replyEvents.find((event) => event.runId === "run-normal");
    assert.equal(normal.suppressed, undefined);
    assert.equal(normal.relayed_chat, true);
    assert.equal(normal.relayed_voice, true);
    pipeline.close();
  }, { metricsEvents, spoken });
});

test("delegate reply is deduped and suppressed after spawn, while completion reports", async () => {
  const metricsEvents = [];
  const chatMessages = [];

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        handoffInflightMax: 5,
        handoffCooldownMs: 0,
        delegateReplyFreshMs: 90_000,
        reportVoiceEnabled: false,
      },
      onChatMessage: async (text) => {
        chatMessages.push(text);
        return true;
      },
    });

    pipeline._test.markHandoffDispatched("dedupe", "forced", Date.now(), { utteranceExcerpt: "dedupe" });
    const evt = {
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-dedupe",
      resultText: "一回だけ",
    };
    await pipeline._test.handleGatewaySessionReply(evt);
    await pipeline._test.handleGatewaySessionReply(evt);
    assert.deepEqual(chatMessages, ["一回だけ"]);

    pipeline._test.markHandoffDispatched("spawn wins", "forced", Date.now(), { utteranceExcerpt: "spawn wins" });
    pipeline._test.handleGatewaySubagentSpawn({
      childKey: "agent:main:subagent:child-spawn",
      parentSessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      label: "spawn wins",
      source: "delegate",
      spawnAtMs: Date.now(),
    });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-after-spawn",
      resultText: "relay should not happen",
    });
    await flushMicrotasks();
    assert.equal(chatMessages.includes("relay should not happen"), false);
    await pipeline._test.handleGatewaySubagentCompletion({
      childKey: "agent:main:subagent:child-spawn",
      parentSessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      label: "spawn wins",
      status: "ok",
      resultText: "completion should report",
      spawnAtMs: Date.now(),
      runId: "child-run-spawn-wins",
    });
    await flushMicrotasks();
    assert.equal(chatMessages.some((text) => text.includes("completion should report")), true);
    assert.equal(metricsEvents.filter((event) => event.type === "delegate_replied_no_spawn").length, 1);
    const completed = metricsEvents.find((event) => event.type === "delegation_completed" && event.label === "spawn wins");
    assert.equal(Boolean(completed), true);
    assert.equal(completed.suppressed_report, undefined);
    pipeline.close();
  }, { metricsEvents });
});

test("late spawn completion is metrics-only after delegate reply already relayed", async () => {
  const metricsEvents = [];
  const chatMessages = [];

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        handoffInflightMax: 5,
        handoffCooldownMs: 0,
        delegateReplyFreshMs: 90_000,
        reportVoiceEnabled: false,
      },
      onChatMessage: async (text) => {
        chatMessages.push(text);
        return true;
      },
    });

    pipeline._test.markHandoffDispatched("reply wins", "forced", Date.now(), { utteranceExcerpt: "reply wins" });
    await pipeline._test.handleGatewaySessionReply({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      runId: "run-reply-first",
      resultText: "reply surfaced first",
    });
    await flushMicrotasks();
    assert.deepEqual(chatMessages, ["reply surfaced first"]);
    assert.equal(pipeline._test.getGatewayDelegationState().inFlightCount, 0);

    pipeline._test.handleGatewaySubagentSpawn({
      childKey: "agent:main:subagent:child-reply-first",
      parentSessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      label: "reply wins",
      source: "delegate",
      spawnAtMs: Date.now(),
    });
    await flushMicrotasks();
    assert.equal(pipeline._test.getGatewayDelegationState().inFlightCount, 0);

    await pipeline._test.handleGatewaySubagentCompletion({
      childKey: "agent:main:subagent:child-reply-first",
      parentSessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty-delegate",
      label: "reply wins",
      status: "ok",
      resultText: "late completion should not report",
      spawnAtMs: Date.now(),
      runId: "child-run-reply-wins",
    });
    await flushMicrotasks();

    assert.equal(chatMessages.some((text) => text.includes("late completion should not report")), false);
    assert.deepEqual(chatMessages, ["reply surfaced first"]);
    assert.equal(metricsEvents.some((event) => (
      event.type === "delegate_replied_no_spawn"
      && event.runId === "run-reply-first"
      && event.relayed_chat === true
    )), true);
    assert.equal(metricsEvents.some((event) => (
      event.type === "delegation_completed"
      && event.label === "reply wins"
      && event.suppressed_report === true
    )), true);
    pipeline.close();
  }, { metricsEvents });
});

test("discord transport relays delegate completion by voice when chat surface is disabled", async () => {
  const spoken = [];
  const chats = [];

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline, turnState } = createTestPipeline(createPipeline, {
      transport: "discord",
      capabilities: {
        chat: false,
        perSpeakerAudio: true,
        avatarStream: false,
        supportsFlush: true,
        echoesOwnOutput: false,
      },
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        reportChatEnabled: false,
        reportVoiceEnabled: true,
        reportVoiceGapMs: 0,
      },
      onChatMessage: async (text) => {
        chats.push(text);
        return true;
      },
    });

    await pipeline._test.handleGatewaySubagentCompletion({
      childKey: "agent:main:subagent:discord-child",
      parentSessionKey: "agent:main:openai-user:discord-gateway-reporting-test-caty",
      label: "調査",
      status: "ok",
      resultText: "結果です",
      runId: "discord-child-run",
    });
    await sleep(50);

    assert.deepEqual(chats, []);
    assert.equal(spoken.includes("結果まとまったよ、あとでログにも残すね。"), true);
    assert.deepEqual(pipeline.getSessionUsers(), {
      parent: "discord-gateway-reporting-test-caty",
      delegate: "discord-gateway-reporting-test-caty-delegate",
    });
    await flushMicrotasks();
    await sleep(10);
    assert.equal(pipeline._test.getReportQueueLength(), 0);
    assert.equal(pipeline._test.getCurrentAbortController(), null);
    assert.equal(turnState.isAgentSpeaking, false);
    pipeline.close();
  }, { spoken });
});

test("announce injection schedules best-effort parent compact and records failures", async () => {
  const metricsEvents = [];
  const compactCalls = [];
  const gatewayEvents = {
    abortSession: async () => true,
    buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
    compactSession: async (sessionUser, options) => {
      compactCalls.push({ sessionUser, options });
      return { ok: false, reason: "boom" };
    },
  };

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        parentCompactDelayMs: 0,
        parentCompactMaxLines: 12,
        reportVoiceEnabled: false,
      },
    });

    const handled = pipeline._test.handleGatewayAnnounceInjected({
      sessionKey: "agent:main:openai-user:meet-gateway-reporting-test-caty",
      runId: "announce:v1:child:run",
      phase: "end",
    });
    assert.equal(handled, true);
    await sleep(5);
    assert.deepEqual(compactCalls, [{ sessionUser: "meet-gateway-reporting-test-caty", options: { maxLines: 12 } }]);
    assert.equal(metricsEvents.some((event) => event.type === "auto_announce_injected"), true);
    assert.equal(metricsEvents.some((event) => event.type === "parent_compact" && event.ok === false), true);
    pipeline.close();
  }, { metricsEvents, gatewayEvents });
});

test("parent compact omits maxLines by default so the gateway runs real compaction (#98)", async () => {
  const metricsEvents = [];
  const compactCalls = [];
  const gatewayEvents = {
    abortSession: async () => true,
    buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
    compactSession: async (sessionUser, options) => {
      compactCalls.push({ sessionUser, options });
      return { ok: true, compacted: true };
    },
  };

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        parentCompactMaxLines: 0,
        reportVoiceEnabled: false,
      },
    });

    const ok = await pipeline._test.compactParentSession("unit");
    assert.equal(ok, true);
    assert.deepEqual(compactCalls, [{ sessionUser: "meet-gateway-reporting-test-caty", options: {} }]);
    pipeline.close();
  }, { metricsEvents, gatewayEvents });
});

test("parent compact omits maxLines when config leaves it unset (#98)", async () => {
  const metricsEvents = [];
  const compactCalls = [];
  const gatewayEvents = {
    abortSession: async () => true,
    buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
    compactSession: async (sessionUser, options) => {
      compactCalls.push({ sessionUser, options });
      return { ok: true, compacted: true };
    },
  };

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        reportVoiceEnabled: false,
      },
    });

    const ok = await pipeline._test.compactParentSession("unit");
    assert.equal(ok, true);
    assert.deepEqual(compactCalls, [{ sessionUser: "meet-gateway-reporting-test-caty", options: {} }]);
    pipeline.close();
  }, { metricsEvents, gatewayEvents });
});

test("parent compact metric records compacted separately from ok", async () => {
  const metricsEvents = [];
  const gatewayEvents = {
    abortSession: async () => true,
    buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
    compactSession: async () => ({ ok: true, compacted: false }),
  };

  await withFreshPipeline(async ({ createPipeline }) => {
    const { pipeline } = createTestPipeline(createPipeline, {
      gatewayEventsConfig: {
        enabled: true,
        agentId: "main",
        reportVoiceEnabled: false,
      },
    });

    const ok = await pipeline._test.compactParentSession("unit");
    assert.equal(ok, true);
    assert.equal(metricsEvents.some((event) => (
      event.type === "parent_compact"
      && event.ok === true
      && event.compacted === false
      && event.reason === "unit"
    )), true);
    pipeline.close();
  }, { metricsEvents, gatewayEvents });
});

function createTestPipeline(createPipeline, options = {}) {
  const session = { id: "gateway-reporting-test", conversationLog: [], config: { wakeMode: "wake" } };
  const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
  const config = {
    dgKey: "x",
    fishKey: "x",
    stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
    llm: {
      model: "test",
      gateway: { url: "http://handoff.test", token: "x" },
      temperature: 0.5,
      maxTokens: 100,
      firstTokenDelegateMs: 0,
      responseTimeoutMs: 0,
      openclawSystemAddendum: "",
    },
    tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1.0 },
    ackVariants: [],
    progressPings: [],
    echoCooldownMs: 1,
    greeting: "",
    exitDetection: false,
    gatewayEvents: options.gatewayEventsConfig || { enabled: false },
  };

  const pipeline = createPipeline(session, turnState, () => {}, config, {
    transport: options.transport,
    capabilities: options.capabilities,
    agents: { caty: { wakeWords: ["ケイティ"] } },
    selectedAgentIds: ["caty"],
    defaultAgentId: "caty",
    onChatMessage: options.onChatMessage,
    _testExposeInternals: true,
  });

  return { pipeline, turnState };
}

async function withFreshPipeline(fn, options = {}) {
  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm-provider.js"),
    path.join(src, "tts-fish.js"),
    path.join(src, "metrics.js"),
    path.join(src, "gateway-events.js"),
    path.join(src, "pipeline.js"),
  ];
  const previousCache = new Map(paths.map((p) => [require.resolve(p), require.cache[require.resolve(p)]]));
  for (const p of paths) delete require.cache[require.resolve(p)];

  const previousEnv = setEnv({
    POST_UTTERANCE_BUFFER_MS: "0",
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    TTS_GAP_MS: "0",
    TTS_LEAD_MS: "0",
    SENTENCE_PAUSE_MS: "0",
    WAKE_WORDS: "ケイティ",
  });

  const sttExports = {
    createSTT: () => {
      const sttEmitter = new EventEmitter();
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
    synthesize: async (text, { onAudio }) => {
      options.spoken?.push(text);
      onAudio(Buffer.alloc(4));
    },
  });
  require.cache[require.resolve(path.join(src, "metrics.js"))] = cacheEntry(path.join(src, "metrics.js"), {
    recordEvent: (type, fields = {}) => {
      options.metricsEvents?.push({ type, ...fields });
    },
  });
  require.cache[require.resolve(path.join(src, "gateway-events.js"))] = cacheEntry(path.join(src, "gateway-events.js"), options.gatewayEvents || {
    abortSession: async () => true,
    buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
    compactSession: async () => ({ ok: true, compacted: true }),
  });
  const createdPipelines = new Set();

  try {
    const pipelineModule = require(path.join(src, "pipeline.js"));
    const createPipeline = (...args) => {
      const pipeline = pipelineModule.createPipeline(...args);
      createdPipelines.add(pipeline);
      return pipeline;
    };
    return await fn({ ...pipelineModule, createPipeline });
  } finally {
    for (const pipeline of createdPipelines) {
      try { pipeline.close?.(); } catch { /* ignore test cleanup */ }
    }
    restoreEnv(previousEnv);
    for (const p of paths) {
      const resolved = require.resolve(p);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
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

function captureConsoleWarn(warnings) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  return () => {
    console.warn = originalWarn;
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
