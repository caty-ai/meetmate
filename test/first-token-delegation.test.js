const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const DELEGATION_LINE = "ちょっと時間がかかってるから、詳細はあとでSlackで共有するね。";
const TIMEOUT_LINE = "[empathetic, unhurried] ごめん、ちょっと時間がかかってるね。少し待ってもらえるかな？";

test("getPipelineConfig parses FIRST_TOKEN_DELEGATE_MS default, override, disabled, empty, and invalid", () => {
  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: undefined }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "15000" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "0" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 0);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "-1" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 0);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", FIRST_TOKEN_DELEGATE_MS: "abc" }, () => {
    assert.equal(freshConfig().getPipelineConfig().llm.firstTokenDelegateMs, 15_000);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", HANDOFF_INFLIGHT_MAX: "0" }, () => {
    assert.equal(freshConfig().getPipelineConfig().gatewayEvents.handoffInflightMax, 2);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", HANDOFF_INFLIGHT_MAX: "not-a-number" }, () => {
    assert.equal(freshConfig().getPipelineConfig().gatewayEvents.handoffInflightMax, 2);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x" }, () => {
    const gatewayEvents = freshConfig().getPipelineConfig().gatewayEvents;
    assert.equal(gatewayEvents.delegateReplyFreshMs, 90_000);
    assert.equal(gatewayEvents.parentCompactDelayMs, 5_000);
    assert.equal(gatewayEvents.parentCompactMaxLines, 0);
    assert.equal(gatewayEvents.shortUtteranceSkipChars, 24);
    assert.equal(gatewayEvents.circuitBreakerTimeouts, 2);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", PARENT_COMPACT_MAX_LINES: "12" }, () => {
    assert.equal(freshConfig().getPipelineConfig().gatewayEvents.parentCompactMaxLines, 12);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", CIRCUIT_BREAKER_TIMEOUTS: "0" }, () => {
    assert.equal(freshConfig().getPipelineConfig().gatewayEvents.circuitBreakerTimeouts, 0);
  });

  withEnv({ OPENCLAW_GATEWAY_URL: "http://gateway.test", OPENCLAW_GATEWAY_TOKEN: "x", DELEGATE_REPLY_FRESH_MS: "0" }, () => {
    assert.equal(freshConfig().getPipelineConfig().gatewayEvents.delegateReplyFreshMs, 0);
  });
});

test("short utterance skip reasons distinguish ping, substring, and normal long requests", () => {
  withEnv({ METRICS_DISABLED: "1" }, () => {
    const pipelinePath = path.join(__dirname, "..", "src", "pipeline.js");
    delete require.cache[require.resolve(pipelinePath)];
    const { getShortUtteranceSkipReason } = require(pipelinePath)._test;

    assert.equal(getShortUtteranceSkipReason("今話せる？", 24), "ping");
    assert.equal(getShortUtteranceSkipReason("聞こえる？", 24), "ping");
    assert.equal(getShortUtteranceSkipReason("これはかなり長い確認なので大丈夫という言葉が途中にあっても委譲をスキップしないで", 24), null);
    assert.equal(getShortUtteranceSkipReason("ケイティ、明日の会議の論点を整理して優先順位も付けて", 24), null);
  });
});

test("fixed TTS prewarm phrases keep gateway-only Meet lines behind the gateway flag", () => {
  withEnv({ METRICS_DISABLED: "1" }, () => {
    const pipelinePath = path.join(__dirname, "..", "src", "pipeline.js");
    delete require.cache[require.resolve(pipelinePath)];
    const { collectFixedTtsPhrases } = require(pipelinePath)._test;
    const baseConfig = {
      ackVariants: [],
      progressPings: [],
      greeting: "",
      cancelAck: "",
      llm: { firstTokenDelegateMs: 15_000 },
      gatewayEvents: { enabled: false },
    };
    const mainBaseline = [
      "[soft voice] 了解、すぐ取りかかるね。",
      "[soft voice] 了解です。ちょっと待ってね。",
      "[soft voice] はい、今確認するね。",
      "[soft voice] いま処理中だよ、もう少し待ってね。",
      "[soft voice] 進めてるよ、あと少しで返せそう。",
      "[soft voice] ごめん、もう少しだけ待ってね。",
      "[warm] 了解です！退出しますね。お疲れさまでした！",
      DELEGATION_LINE,
      TIMEOUT_LINE,
      "[soft voice] 続きはSlackに共有しておくね。",
      "[soft voice] ごめん、うまく繋げられなかったみたい。あとでもう一回試してね。",
    ];
    const gatewayOnly = [
      "[soft voice] 続きは裏に回したよ。まとまったらチャットに貼るね。",
      "[soft voice] ごめんね、いま立て込んでるから少し待ってね。",
      "[soft voice] ごめんね、ちょっと立て直し中。急ぎはそのまま話しかけてね。",
    ];

    assert.deepEqual(collectFixedTtsPhrases(baseConfig, ""), mainBaseline);
    assert.deepEqual(
      collectFixedTtsPhrases({ ...baseConfig, gatewayEvents: { enabled: true } }, "").slice(-3),
      gatewayOnly
    );
  });
});

test("gateway-enabled short utterance skips Timer A without changing flag-off behavior", async () => {
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "short-skip-metrics-"));
  const handoffRequests = [];
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 20,
        responseTimeoutMs: 60,
        gatewayEventsConfig: {
          enabled: true,
          shortUtteranceSkipChars: 24,
          handoffInflightMax: 2,
          handoffCooldownMs: 0,
          reportVoiceEnabled: false,
        },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、大丈夫?", "turn-short");
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
      gatewayEvents: { abortSession: async () => true },
    }
  );

  const events = readMetrics(metricsDir);
  assert.equal(events.some((event) => event.type === "forced_delegation_skipped" && event.reason === "ping"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired"), false);
  assert.equal(handoffRequests.length, 1);

  const flagOffMetricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "short-no-skip-metrics-"));
  const flagOffRequests = [];
  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 20,
        responseTimeoutMs: 60,
        gatewayEventsConfig: { enabled: false },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、大丈夫?", "turn-flag-off");
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir: flagOffMetricsDir,
      handoffRequests: flagOffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );
  const flagOffEvents = readMetrics(flagOffMetricsDir);
  assert.equal(flagOffEvents.some((event) => event.type === "forced_delegation_skipped"), false);
  assert.equal(flagOffEvents.some((event) => event.type === "forced_delegation_fired"), true);
});

test("Timer A aborts the LLM, speaks the delegation line, requests handoff, records metrics, and suppresses Timer B", async (t) => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "forced-delegation-metrics-"));
  let streamAborted = false;
  const spoken = [];
  const warnings = [];
  t.after(captureConsoleWarn(warnings));

  const result = await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline, turnState } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 40,
        responseTimeoutMs: 90,
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、調べてまとめて", "turn-a");
      await sleep(90);
      pipeline.close();
      await metrics._test.flush();

      return { turnState, gateState: pipeline._test.getGateState() };
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
          streamAborted = opts.signal.aborted;
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);
  const forcedEvent = events.find((event) => event.type === "forced_delegation_fired");

  assert.equal(streamAborted, true);
  assert.equal(spoken.includes(DELEGATION_LINE), true);
  assert.equal(handoffRequests.length, 1);
  assert.equal(forcedEvent.turn_id, "turn-a");
  assert.equal(forcedEvent.threshold_ms, 40);
  assert.equal(forcedEvent.elapsed_ms >= 25, true);
  assert.equal(forcedEvent.elapsed_ms < 500, true);
  assert.equal(warnings.some((line) => line.includes("LLM first-response timeout")), false);
  assert.equal(events.some((event) => event.type === "timeout_fallback_fired"), false);
  assert.equal(events.some((event) => event.type === "handoff_requested" && event.turn_id === "turn-a"), true);
  assert.equal(events.some((event) => event.type === "tts_playback_start" && event.source === "forced_delegation"), true);
  assert.equal(events.some((event) => event.type === "turn_end" && event.turn_id === "turn-a" && event.handoff_attempted === true), true);
  assert.equal(result.turnState.isAgentSpeaking, false);
  assert.equal(result.gateState, "OPEN");
});

test("Timer A disabled preserves the 35s timeout fallback path", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "response-timeout-metrics-"));
  let streamAborted = false;
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 80,
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、調べてまとめて", "turn-b");
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
          streamAborted = opts.signal.aborted;
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);

  assert.equal(streamAborted, true);
  assert.equal(spoken.includes(TIMEOUT_LINE), true);
  assert.equal(spoken.includes(DELEGATION_LINE), false);
  assert.equal(handoffRequests.length, 1);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired"), false);
  assert.equal(events.some((event) => event.type === "timeout_fallback_fired" && event.turn_id === "turn-b"), true);
  assert.equal(events.some((event) => event.type === "handoff_requested" && event.turn_id === "turn-b"), true);
});

test("first token before Timer A threshold cancels forced delegation", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-token-normal-metrics-"));
  let streamAborted = false;
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 80,
        responseTimeoutMs: 90,
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、短く答えて", "turn-c");
      await sleep(90);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await sleep(5);
          streamAborted = opts.signal.aborted;
          yield "これは通常応答です。";
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);

  assert.equal(streamAborted, false);
  assert.equal(spoken.includes("これは通常応答です。"), true);
  assert.equal(handoffRequests.length, 0);
  assert.equal(events.some((event) => event.type === "first_token" && event.turn_id === "turn-c"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired"), false);
  assert.equal(events.some((event) => event.type === "timeout_fallback_fired"), false);
});

test("consecutive Timer A firings open circuit breaker and first token closes it", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "circuit-breaker-metrics-"));
  const spoken = [];
  const compactCalls = [];
  let callCount = 0;

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 20,
        responseTimeoutMs: 80,
        gatewayEventsConfig: {
          enabled: true,
          agentId: "main",
          handoffInflightMax: 5,
          handoffCooldownMs: 0,
          reportVoiceGapMs: 0,
          circuitBreakerTimeouts: 2,
          shortUtteranceSkipChars: 24,
          parentCompactDelayMs: 0,
          reportVoiceEnabled: true,
        },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、これはとても長い調査を一つめとして詳しくお願い", "turn-breaker-1");
      await pipeline._test.handleUtteranceEnd("ケイティ、これはとても長い調査を二つめとして詳しくお願い", "turn-breaker-2");
      await sleep(10);
      assert.equal(pipeline._test.getCircuitBreakerState().open, true);
      assert.equal(
        [...spoken, ...pipeline._test.getReportQueueLines()].some((text) => text.includes("立て直し中")),
        true
      );
      assert.equal(compactCalls.length >= 1, true);

      await pipeline._test.handleUtteranceEnd("ケイティ、大丈夫?", "turn-breaker-open-short");
      assert.equal(pipeline._test.getCircuitBreakerState().open, true);

      await pipeline._test.handleUtteranceEnd("ケイティ、通常応答で回復確認をお願いします", "turn-breaker-close");
      assert.equal(pipeline._test.getCircuitBreakerState().open, false);

      await pipeline._test.handleUtteranceEnd("ケイティ、大丈夫?", "turn-breaker-after-close");
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      gatewayEvents: {
        abortSession: async () => true,
        buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
        compactSession: async (sessionUser, options) => {
          compactCalls.push({ sessionUser, options });
          return { ok: true, compacted: true };
        },
      },
      llm: {
        streamChat: async function* (_messages, opts) {
          callCount += 1;
          if (callCount <= 3) {
            await waitForAbort(opts.signal);
            return;
          }
          await sleep(1);
          yield "戻ったよ。";
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  const events = readMetrics(metricsDir);
  assert.equal(events.some((event) => event.type === "circuit_breaker" && event.state === "open"), true);
  assert.equal(events.some((event) => event.type === "circuit_breaker" && event.state === "close"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired" && event.turn_id === "turn-breaker-open-short"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_skipped" && event.turn_id === "turn-breaker-open-short"), false);
  assert.equal(events.some((event) => event.type === "forced_delegation_skipped" && event.turn_id === "turn-breaker-after-close"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired" && event.turn_id === "turn-breaker-after-close"), false);
});

test("CIRCUIT_BREAKER_TIMEOUTS=0 disables breaker opening", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "circuit-breaker-disabled-metrics-"));

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 20,
        responseTimeoutMs: 80,
        gatewayEventsConfig: {
          enabled: true,
          handoffInflightMax: 5,
          handoffCooldownMs: 0,
          reportVoiceGapMs: 0,
          circuitBreakerTimeouts: 0,
          shortUtteranceSkipChars: 0,
          reportVoiceEnabled: false,
        },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、これは一つめの長い調査依頼です", "turn-no-breaker-1");
      await pipeline._test.handleUtteranceEnd("ケイティ、これは二つめの長い調査依頼です", "turn-no-breaker-2");
      assert.equal(pipeline._test.getCircuitBreakerState().open, false);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      handoffRequests,
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  const events = readMetrics(metricsDir);
  assert.equal(events.filter((event) => event.type === "forced_delegation_fired").length, 2);
  assert.equal(events.some((event) => event.type === "circuit_breaker" && event.state === "open"), false);
});

test("gateway fallback retry cancels the outer first-response timers", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-fallback-timers-"));
  const spoken = [];
  const streamCalls = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 80,
        responseTimeoutMs: 90,
        agents: {
          caty: { wakeWords: ["ケイティ"] },
          analyst: { wakeWords: ["アナリスト"], gatewayUrl: "http://analyst.test" },
        },
        selectedAgentIds: ["caty", "analyst"],
        defaultAgentId: "caty",
      });

      await pipeline._test.handleUtteranceEnd("アナリスト、調べてまとめて", "turn-d");
      await sleep(90);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      spoken,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          streamCalls.push(opts.sessionUser);
          if (opts.sessionUser.endsWith("-analyst")) {
            await sleep(20);
            throw new Error("ECONNREFUSED analyst gateway");
          }

          await sleep(40);
          yield "通常のフォールバック応答です。";
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  const events = readMetrics(metricsDir);

  assert.deepEqual(streamCalls, ["meet-forced-delegation-test-analyst", "meet-forced-delegation-test-caty"]);
  assert.equal(spoken.includes("通常のフォールバック応答です。"), true);
  assert.equal(spoken.includes(DELEGATION_LINE), false);
  assert.equal(handoffRequests.length, 0);
  assert.equal(events.some((event) => event.type === "first_token" && event.turn_id === "turn-d"), true);
  assert.equal(events.some((event) => event.type === "forced_delegation_fired" && event.turn_id === "turn-d"), false);
  assert.equal(events.some((event) => event.type === "tts_playback_start" && event.source === "forced_delegation"), false);
});

test("gateway events enabled makes Timer A abort the server run and handoff on delegate session", async () => {
  const handoffRequests = [];
  const abortUsers = [];
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 40,
        responseTimeoutMs: 90,
        gatewayEventsConfig: {
          enabled: true,
          forcedDelegationAbort: true,
          handoffDelegateSession: true,
          handoffInflightMax: 2,
          handoffCooldownMs: 0,
          reportVoiceGapMs: 1,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
          shortUtteranceSkipChars: 0,
        },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、重い調査をして", "turn-gw");
      await sleep(90);
      pipeline.close();
    },
    {
      spoken,
      handoffRequests,
      gatewayEvents: {
        abortSession: async (sessionUser) => {
          abortUsers.push(sessionUser);
          return true;
        },
      },
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  assert.deepEqual(abortUsers, ["meet-forced-delegation-test-caty"]);
  assert.equal(handoffRequests.length, 1);
  assert.equal(handoffRequests[0].timeoutMs, 15_000);
  const body = JSON.parse(handoffRequests[0].body);
  assert.equal(body.user, "meet-forced-delegation-test-caty-delegate");
  assert.equal(JSON.stringify(body).includes("Slack"), false);
  assert.equal(spoken.includes("ちょっと時間がかかってるから、裏でまとめておくね。"), true);
});

test("gateway handoff guard skips dispatch while cooldown is active", async () => {
  const handoffRequests = [];
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 30,
        responseTimeoutMs: 90,
        gatewayEventsConfig: {
          enabled: true,
          forcedDelegationAbort: false,
          handoffDelegateSession: true,
          handoffInflightMax: 2,
          handoffCooldownMs: 100,
          reportVoiceGapMs: 1,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
          shortUtteranceSkipChars: 0,
        },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、1つめを調べて", "turn-cool-1");
      await sleep(20);
      await pipeline._test.handleUtteranceEnd("ケイティ、2つめを調べて", "turn-cool-2");
      await sleep(20);
      pipeline.close();
    },
    {
      spoken,
      handoffRequests,
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  assert.equal(handoffRequests.length, 1);
  assert.equal(spoken.filter((line) => line === "ちょっと時間がかかってるから、裏でまとめておくね。").length, 2);
});

test("gateway handoff guard skips dispatch while in-flight cap is full", async () => {
  const handoffRequests = [];
  const spoken = [];

  await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 30,
        responseTimeoutMs: 90,
        gatewayEventsConfig: {
          enabled: true,
          forcedDelegationAbort: false,
          handoffDelegateSession: true,
          handoffInflightMax: 1,
          handoffCooldownMs: 0,
          reportVoiceGapMs: 1,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
          shortUtteranceSkipChars: 0,
        },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、1つめを調べて", "turn-cap-1");
      await sleep(60);
      await pipeline._test.handleUtteranceEnd("ケイティ、2つめを調べて", "turn-cap-2");
      await sleep(60);
      assert.equal(pipeline._test.getHandoffInflightCount(), 1);
      pipeline.close();
    },
    {
      spoken,
      handoffRequests,
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  assert.equal(handoffRequests.length, 1);
  assert.equal(spoken.filter((line) => line === "ちょっと時間がかかってるから、裏でまとめておくね。").length, 2);
});

test("short timeout handoff blocked by cap is dropped without entering pending FIFO", async () => {
  const handoffRequests = [];
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "short-handoff-drop-metrics-"));

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 20,
        gatewayEventsConfig: {
          enabled: true,
          handoffInflightMax: 1,
          handoffCooldownMs: 0,
          reportVoiceEnabled: false,
          shortUtteranceSkipChars: 24,
        },
      });

      pipeline._test.markHandoffDispatched("busy", "forced", Date.now(), { utteranceExcerpt: "busy" });
      await pipeline._test.handleUtteranceEnd("ケイティ、大丈夫?", "turn-short-cap");
      assert.equal(pipeline._test.getPendingHandoffQueueLength(), 0);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      handoffRequests,
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  const events = readMetrics(metricsDir);
  assert.equal(handoffRequests.length, 0);
  assert.equal(events.some((event) => (
    event.type === "handoff_dropped"
    && event.reason === "short_utterance"
    && event.label === "ケイティ、大丈夫?"
  )), true);
});

test("DELEGATE_REPLY_FRESH_MS=0 treats old delegate replies as fresh and never drops", async () => {
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-fresh-zero-metrics-"));
  const chats = [];

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 0,
        gatewayEventsConfig: {
          enabled: true,
          agentId: "main",
          delegateReplyFreshMs: 0,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
          reportVoiceGapMs: 0,
        },
        onChatMessage: (text) => {
          chats.push(text);
          return true;
        },
      });

      pipeline._test.markHandoffDispatched(
        "old delegate reply",
        "forced",
        Date.now() - 24 * 60 * 60 * 1_000,
        { utteranceExcerpt: "old delegate reply" }
      );
      const handled = await pipeline._test.handleGatewaySessionReply({
        sessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty-delegate",
        runId: "run-fresh-zero",
        resultText: "古いけど新鮮扱い",
      });
      assert.equal(handled, true);
      assert.deepEqual(chats, ["古いけど新鮮扱い"]);
      assert.equal(pipeline._test.getHandoffInflightCount(), 0);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      handoffRequests: [],
      gatewayEvents: {
        buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
        abortSession: async () => true,
      },
      llm: {
        streamChat: async function* () {},
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  const events = readMetrics(metricsDir);
  assert.equal(events.some((event) => (
    event.type === "delegate_replied_no_spawn"
    && event.runId === "run-fresh-zero"
    && event.fresh === true
    && event.relayed_chat === true
    && event.relayed_voice === true
  )), true);
});

test("gateway handoff client timeout is treated as dispatched, not failure", async () => {
  const handoffRequests = [];
  const spoken = [];
  const warnings = [];

  const result = await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 30,
        responseTimeoutMs: 90,
        gatewayEventsConfig: {
          enabled: true,
          forcedDelegationAbort: false,
          handoffDelegateSession: true,
          handoffInflightMax: 2,
          handoffCooldownMs: 0,
          reportVoiceGapMs: 1,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
          shortUtteranceSkipChars: 0,
        },
      });

      await pipeline._test.handleUtteranceEnd("ケイティ、タイムアウトしても委譲して", "turn-timeout");
      await sleep(90);
      const inflight = pipeline._test.getHandoffInflightCount();
      pipeline.close();
      return { inflight };
    },
    {
      spoken,
      handoffRequests,
      handoffMode: "client-timeout",
      warnings,
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* (_messages, opts) {
          await waitForAbort(opts.signal);
        },
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      }
    }
  );

  assert.equal(handoffRequests.length, 1);
  assert.equal(handoffRequests[0].timeoutMs, 15_000);
  assert.equal(result.inflight, 1);
  assert.equal(spoken.includes("[soft voice] ごめん、うまく繋げられなかったみたい。あとでもう一回試してね。"), false);
  assert.equal(warnings.some((line) => line.includes("client timeout")), true);
});

test("gateway completion posts sanitized chat immediately and speaks only after a gap", async () => {
  const spoken = [];
  const chats = [];

  await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline, turnState } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 0,
        gatewayEventsConfig: {
          enabled: true,
          reportVoiceGapMs: 20,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
        },
        onChatMessage: (text) => {
          chats.push(text);
          return true;
        },
      });
      turnState.isAgentSpeaking = true;
      await pipeline._test.handleGatewaySubagentCompletion({
        childKey: "agent:main:subagent:child",
        parentSessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty",
        label: "調査👍",
        status: "ok",
        resultText: "結果です👍",
      });
      assert.deepEqual(chats, ["委譲タスク結果: 調査\n結果です"]);

      await sleep(40);
      assert.equal(spoken.some((line) => line.includes("まとまったよ")), false);
      turnState.isAgentSpeaking = false;
      await sleep(80);
      pipeline.close();
    },
    {
      spoken,
      handoffRequests: [],
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* () {},
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  assert.equal(spoken.some((line) => line === "さっきの「調査」、まとまったよ。チャットに貼ったね。"), true);
});

test("gateway completion voice gap is gated by fake timers", async (t) => {
  const spoken = [];
  const chats = [];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });

  await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 0,
        gatewayEventsConfig: {
          enabled: true,
          reportVoiceGapMs: 4_000,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
        },
        onChatMessage: (text) => {
          chats.push(text);
          return true;
        },
      });
      await pipeline._test.handleGatewaySubagentCompletion({
        childKey: "agent:main:subagent:child-gap",
        parentSessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty",
        label: "時差確認",
        status: "ok",
        resultText: "結果",
      });
      assert.equal(chats.length, 1);

      await flushMicrotasks();
      for (let i = 0; i < 7; i += 1) {
        t.mock.timers.tick(500);
        await flushMicrotasks();
      }
      assert.equal(spoken.length, 0);

      t.mock.timers.tick(500);
      await flushMicrotasks();
      assert.equal(spoken.includes("さっきの「時差確認」、まとまったよ。チャットに貼ったね。"), true);
      pipeline.close();
    },
    {
      spoken,
      handoffRequests: [],
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* () {},
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("gateway completion voice drain stops after close before speaking", async () => {
  const spoken = [];
  const chats = [];

  await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline, turnState } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 0,
        gatewayEventsConfig: {
          enabled: true,
          reportVoiceGapMs: 20,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
        },
        onChatMessage: (text) => {
          chats.push(text);
          return true;
        },
      });
      turnState.isAgentSpeaking = true;
      await pipeline._test.handleGatewaySubagentCompletion({
        childKey: "agent:main:subagent:child-close",
        parentSessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty",
        label: "終了時",
        status: "ok",
        resultText: "閉じた後は読まない",
      });
      assert.equal(chats.length, 1);
      pipeline.close();
      turnState.isAgentSpeaking = false;
      await sleep(80);
    },
    {
      spoken,
      handoffRequests: [],
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* () {},
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  assert.equal(spoken.some((line) => line.includes("終了時")), false);
});

test("gateway completion voice queue caps at ten and drops oldest report lines", async () => {
  const spoken = [];
  const chats = [];
  const warnings = [];

  await withFreshPipeline(
    async ({ createPipeline }) => {
      const { pipeline, turnState } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 0,
        gatewayEventsConfig: {
          enabled: true,
          reportVoiceGapMs: 100,
          reportChatEnabled: true,
          reportVoiceEnabled: true,
        },
        onChatMessage: (text) => {
          chats.push(text);
          return true;
        },
      });
      turnState.isAgentSpeaking = true;
      for (let i = 0; i < 12; i += 1) {
        await pipeline._test.handleGatewaySubagentCompletion({
          childKey: `agent:main:subagent:child-${i}`,
          parentSessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty",
          label: `調査${i}`,
          status: "ok",
          resultText: `結果${i}`,
        });
      }
      assert.equal(pipeline._test.getReportQueueLength(), 10);
      pipeline.close();
    },
    {
      spoken,
      handoffRequests: [],
      warnings,
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* () {},
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  assert.equal(chats.length, 12);
  assert.equal(warnings.filter((line) => line.includes("report voice queue overflow")).length, 2);
  assert.equal(spoken.length, 0);
});

test("gateway completion decrements matching child and records elapsed from spawn time", async () => {
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-completion-metrics-"));
  const now = Date.now();

  await withFreshPipeline(
    async ({ createPipeline, metrics }) => {
      const { pipeline } = createTestPipeline(createPipeline, {
        firstTokenDelegateMs: 0,
        responseTimeoutMs: 0,
        gatewayEventsConfig: {
          enabled: true,
          reportChatEnabled: false,
          reportVoiceEnabled: false,
        },
      });
      pipeline._test.handleGatewaySubagentSpawn({
        childKey: "agent:main:subagent:oldest",
        parentSessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty",
        label: "古い",
        source: "forced",
        spawnAtMs: now - 10_000,
      });
      pipeline._test.handleGatewaySubagentSpawn({
        childKey: "agent:main:subagent:completed",
        parentSessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty",
        label: "完了",
        source: "forced",
        spawnAtMs: now - 1_000,
      });
      pipeline._test.handleGatewaySubagentCompletion({
        childKey: "agent:main:subagent:completed",
        parentSessionKey: "agent:main:openai-user:meet-forced-delegation-test-caty",
        label: "完了",
        status: "ok",
        resultText: "結果",
        spawnAtMs: now - 1_000,
      });
      assert.equal(pipeline._test.getHandoffInflightCount(), 1);
      pipeline.close();
      await metrics._test.flush();
    },
    {
      metricsDir,
      handoffRequests: [],
      gatewayEvents: { abortSession: async () => true },
      llm: {
        streamChat: async function* () {},
        VOICE_SYSTEM_ADDENDUM: "",
        buildVoiceAddendum: () => "",
      },
    }
  );

  const events = readMetrics(metricsDir);
  const completed = events.find((event) => event.type === "delegation_completed" && event.label === "完了");
  assert.equal(Boolean(completed), true);
  assert.equal(completed.elapsed_ms >= 900, true);
  assert.equal(completed.elapsed_ms < 5_000, true);
});

function createTestPipeline(createPipeline, options) {
  const session = { id: "forced-delegation-test", conversationLog: [], config: { wakeMode: "wake" } };
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
      firstTokenDelegateMs: options.firstTokenDelegateMs,
      responseTimeoutMs: options.responseTimeoutMs,
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
    agents: options.agents || { caty: { wakeWords: ["ケイティ"] } },
    selectedAgentIds: options.selectedAgentIds || ["caty"],
    defaultAgentId: options.defaultAgentId || "caty",
    onChatMessage: options.onChatMessage,
    _testExposeInternals: true,
  });

  return { pipeline, turnState };
}

async function withFreshPipeline(fn, options = {}) {
  const src = path.join(__dirname, "..", "src");
  const llmOpenclawPath = path.join(src, "llm-openclaw.js");
  const realLlmOpenclaw = require(llmOpenclawPath);
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    llmOpenclawPath,
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
    METRICS_LOG_DIR: options.metricsDir,
    METRICS_DISABLED: options.metricsDir ? undefined : "1",
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

  const httpModule = require("node:http");
  const previousHttpRequest = httpModule.request;
  httpModule.request = createFakeRequest(options.handoffRequests || [], options.handoffMode);
  const restoreWarn = options.warnings ? captureConsoleWarn(options.warnings) : null;
  const createdPipelines = new Set();
  let loadedMetrics = null;

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(llmOpenclawPath)] = cacheEntry(llmOpenclawPath, {
    ...realLlmOpenclaw,
    ...options.llm,
  });
  if (options.gatewayEvents) {
    require.cache[require.resolve(path.join(src, "gateway-events.js"))] = cacheEntry(path.join(src, "gateway-events.js"), {
      buildSessionKey: (user, agentId) => `agent:${agentId}:openai-user:${user}`,
      compactSession: async () => ({ ok: true, compacted: true }),
      ...options.gatewayEvents,
    });
  }
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (text, { onAudio }) => {
      options.spoken?.push(text);
      onAudio(Buffer.alloc(4));
    },
  });

  try {
    const pipelineModule = require(path.join(src, "pipeline.js"));
    const createPipeline = (...args) => {
      const pipeline = pipelineModule.createPipeline(...args);
      createdPipelines.add(pipeline);
      return pipeline;
    };
    const metrics = require(path.join(src, "metrics.js"));
    loadedMetrics = metrics;
    return await fn({ createPipeline, metrics });
  } finally {
    for (const pipeline of createdPipelines) {
      try { pipeline.close?.(); } catch { /* ignore test cleanup */ }
    }
    loadedMetrics?._test?.dispose?.();
    if (restoreWarn) restoreWarn();
    httpModule.request = previousHttpRequest;
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

function freshConfig() {
  const configPath = path.join(__dirname, "..", "src", "config.js");
  delete require.cache[require.resolve(configPath)];
  return require(configPath);
}

function readMetrics(dir) {
  const file = path.join(dir, "metrics.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createFakeRequest(requests, mode = "success") {
  return (requestOptions, callback) => {
    const req = new EventEmitter();
    let body = "";
    let timeoutMs = null;
    let timeoutCallback = null;
    req.write = (chunk) => {
      body += String(chunk || "");
    };
    req.end = () => {
      requests.push({ options: requestOptions, body, timeoutMs });
      if (mode === "client-timeout") {
        process.nextTick(() => timeoutCallback?.());
        return;
      }
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        callback(res);
      });
    };
    req.setTimeout = (ms, cb) => {
      timeoutMs = ms;
      timeoutCallback = cb;
      return req;
    };
    req.destroy = (err) => {
      if (err) process.nextTick(() => req.emit("error", err));
    };
    return req;
  };
}

function waitForAbort(signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", resolve, { once: true });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureConsoleWarn(warnings) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
    originalWarn(...args);
  };
  return () => {
    console.warn = originalWarn;
  };
}

function withEnv(values, fn) {
  const previous = setEnv(values);
  try {
    return fn();
  } finally {
    restoreEnv(previous);
    const configPath = path.join(__dirname, "..", "src", "config.js");
    delete require.cache[require.resolve(configPath)];
  }
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
