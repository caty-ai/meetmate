const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { buildVoiceAddendum } = require("../src/llm");
const { getPipelineConfig, resolveMessages } = require("../src/config");
const { DEFAULT_MESSAGES, renderTemplate } = require("../src/messages");
const { SUMMARY_PROMPT } = require("../src/summarizer");
const { collectFixedTtsPhrases, getShortUtteranceSkipReason, isWakeCancelText } = require("../src/pipeline")._test;
const { buildDelegationResultsSection } = require("../src/delegation-results");
const { SlackNotifier } = require("../src/slack-notifier");

const OLD_VOICE_ADDENDUM = `あなたは音声通話中です。

【応答ルール】
- 短く話す（1回の発話は2〜3文まで。長くならないこと！）
- すべての発話の先頭に必ず感情タグを1個入れる（タグなしだと声が暴走するため、スタイル安定化のアンカーとして使う）。使えるタグ: [soft voice]（デフォルト・優しい声）, [warm]（温かみ）, [friendly, warm]（親しみ＋温かみ）, [empathetic, unhurried]（謝罪・落ち着き）, [thoughtful]（考え深く）。迷ったら [soft voice]。
- コードブロック、マークダウン記法、長いリスト、テーブルは使わない（音声で読み上げるので）
- 絵文字は使わない（音声で読み上げできないため。なお [soft voice] のような感情タグは絵文字ではないので必須で使うこと）
- URL、長い詳細、リスト、コード風テキストは会議チャット専用タグ [[[chat: ...]]] で送る（読み上げられない）。口頭は「チャットに貼っておくね」程度に短くし、1項目1タグ、タグ位置は応答内のどこでもよい。絵文字はチャットにも使えない（会議チャット側が絵文字入りメッセージを拒否するため）
- 相手の話をしっかり聞いてから応答する
- 音声では結論→次アクションを優先。詳細はSlackで共有する

【ツール実行ルール】
音声通話中は会話を止めないことが最優先。

軽い処理（直接実行OK）:
  memory_search、天気、単発web検索、短いメッセージ送信、1回で終わる確認系
  → 「ちょっと調べるね」等のつなぎを入れてから実行

重い処理（sessions_spawnで委譲）:
  複数ステップ、長文読解、ファイル/リポジトリ横断、exec、
  Deep Research、GitHub操作、デバッグ、スキル発動
  → 「調べてみるね、サブエージェントに頼んでおくね」と即答
  → 詳細はSlackに投稿、口頭では要約だけ伝える

判断に迷ったら: まず軽い方で試す。
タイムアウトした場合は自動でサブエージェントに切り替わるので安心して試してOK。

【サブエージェント結果の報告】
セッション履歴にサブエージェントの結果が返ってきている場合は、
ユーザーの発話に応答した後、「あ、さっきの結果が返ってきたみたい」と自発的に報告すること。
詳細はSlackを参照するよう案内し、口頭では短い要約を伝える。

【絶対禁止事項】
NO_REPLY は絶対に使わないこと（音声通話ではサイレント応答は不可）。
何があっても必ずテキストで応答すること。
返すことがない場合は「了解！何かあったら言ってね」のように一言添えること。`;

const OLD_SUMMARY_PROMPT = `以下の音声通話/会議の会話ログから、簡潔なサマリーをJSON形式で生成してください。

出力フォーマット（必ずこのJSONのみ出力すること）:
{
  "summary": ["要約1", "要約2", "要約3"],
  "decisions": ["決定事項1"],
  "todos": ["TODO1"]
}

ルール:
- summaryは最大3項目の箇条書き
- decisionsは決定事項があれば記載（なければ空配列）
- todosはTODOがあれば記載（なければ空配列）
- JSONのみ出力。説明やマークダウンは不要

会話ログ:
`;

const OLD_GATEWAY_BRIEFING_PROMPT = [
  "音声通話の準備中です。以下のブリーフィングを読んで準備してください。",
  "",
  "【重要】応答は以下のJSON形式のみで返してください：",
  "{\"purposeStatement\": \"挨拶の直後に話す、電話の目的を伝える1〜2文。自然な話し言葉で。感情タグ付き。\"}",
  "",
  "例: {\"purposeStatement\": \"[empathetic, unhurried] 今日はレストランの予約の件でお電話させていただきました。来週の金曜日に4名で伺いたいのですが。\"}",
  "",
  "ルール:",
  "- 1〜2文で簡潔に。長くならないこと",
  "- 自然な敬語の話し言葉にする",
  "- ブリーフィングの内容を要約・整形する（そのまま読まない）",
  "- 先頭に感情タグを必ず1個入れる（スタイル安定化のため）。使えるタグ: [soft voice], [warm], [friendly, warm], [empathetic, unhurried], [thoughtful]。迷ったら [soft voice]。",
  "- JSONのみ出力。説明やマークダウンは不要",
].join("\n");

const OLD_FIXED_SPEECH = {
  ackVariants: [
    "[soft voice] 了解、すぐ取りかかるね。",
    "[soft voice] 了解です。ちょっと待ってね。",
    "[soft voice] はい、今確認するね。",
  ],
  progressPings: [
    "[soft voice] いま処理中だよ、もう少し待ってね。",
    "[soft voice] 進めてるよ、あと少しで返せそう。",
    "[soft voice] ごめん、もう少しだけ待ってね。",
  ],
  timeoutFallback: "[empathetic, unhurried] ごめん、ちょっと時間がかかってるね。少し待ってもらえるかな？",
  forcedDelegationFallback: "ちょっと時間がかかってるから、詳細はあとでSlackで共有するね。",
  handoffSuccess: "[soft voice] 続きはSlackに共有しておくね。",
  handoffFailure: "[soft voice] ごめん、うまく繋げられなかったみたい。あとでもう一回試してね。",
  forcedDelegationFallbackMeet: "ちょっと時間がかかってるから、裏でまとめておくね。",
  handoffUnconfirmedMeet: "[soft voice] 続きは裏に回したよ。まとまったらチャットに貼るね。",
  handoffBusyMeet: "[soft voice] ごめんね、いま立て込んでるから少し待ってね。",
  reportPostUnknown: "結果まとまったよ、あとでログにも残すね。",
  circuitBreakerRecoveryNotice: "[soft voice] ごめんね、ちょっと立て直し中。急ぎはそのまま話しかけてね。",
  exitFarewell: "[warm] 了解です！退出しますね。お疲れさまでした！",
  groupGreetingTemplate: "。今日は{agents}も一緒だよ！",
  completionVoiceTemplate: "さっきの「{label}」、まとまったよ。チャットに貼ったね。",
  staleCompletionVoicePrefix: "(遅くなってごめんね) ",
  errorVoice: "すみません、ちょっとエラーが起きちゃいました。",
};

test("default message resolution preserves previously hardcoded bytes and regex behavior", () => {
  const resolved = resolveMessages();

  assert.equal(buildVoiceAddendum(), OLD_VOICE_ADDENDUM);
  assert.equal(SUMMARY_PROMPT, OLD_SUMMARY_PROMPT);
  assert.equal(resolved.prompts.summary, OLD_SUMMARY_PROMPT);
  assert.equal(resolved.prompts.gatewayBriefingSystem, OLD_GATEWAY_BRIEFING_PROMPT);
  assert.equal(resolved.prompts.gatewayWarmupUser, "セッション準備中。次のメッセージから音声通話が始まります。");
  assert.equal(
    renderTemplate(resolved.prompts.timeoutHandoffGateway, { request: "依頼" }),
    [
      "ユーザーの音声通話中に依頼処理がタイムアウトしました。",
      "必ず sessions_spawn を使って作業を委譲してください。",
      "まずユーザー依頼を短く要約し、実行計画を立ててからサブエージェントを起動してください。",
      "サブエージェントの結果を最終回答としてそのまま返してください。会議への報告は音声ハーネス側が行います。",
      "",
      "ユーザー依頼: 依頼",
    ].join("\n")
  );
  assert.equal(
    renderTemplate(resolved.prompts.timeoutHandoffSlack, { request: "依頼" }),
    [
      "ユーザーの音声通話中に依頼処理がタイムアウトしました。",
      "必ず sessions_spawn を使って作業を委譲し、結果をSlackに投稿してください。",
      "まずユーザー依頼を短く要約し、実行計画を立ててからサブエージェントを起動してください。",
      "",
      "ユーザー依頼: 依頼",
    ].join("\n")
  );
  assert.equal(resolved.prompts.timeoutHandoffGatewaySystem, "あなたは音声タイムアウト時の自動委譲ハンドラーです。必ず sessions_spawn に委譲し、結果を最終回答として返してください。");
  assert.equal(resolved.prompts.timeoutHandoffSlackSystem, "あなたは音声タイムアウト時の自動委譲ハンドラーです。結果は必ずSlackに共有してください。");
  assert.deepEqual(resolved.speech, OLD_FIXED_SPEECH);
  assert.deepEqual(resolved.delegation, {
    statusComplete: "完了",
    statusIncomplete: "未完",
    sectionHeading: "## 委譲タスク結果",
    defaultLabel: "委譲タスク",
    emptyResult: "結果本文なし",
    missingResult: "結果本文を取得できませんでした。",
    chatPrefix: "委譲タスク結果",
  });
  assert.deepEqual(resolved.exit.commands, [
    "退出して", "退出していいよ", "退出", "退出して大丈夫",
    "退室して", "退室していいよ", "退室", "退室して大丈夫", "退室してもらって",
  ]);
  assert.equal(isWakeCancelText("ケイティ、ストップ", { caty: { wakeWords: ["ケイティ"] } }, ["caty"]), true);
  assert.equal(isWakeCancelText("ケイティ、ストップウォッチ", { caty: { wakeWords: ["ケイティ"] } }, ["caty"]), false);
  assert.equal(getShortUtteranceSkipReason("今話せる？", 24), "ping");
  assert.equal(getShortUtteranceSkipReason("短い依頼", 24), "short");
  assert.equal(getShortUtteranceSkipReason("ケイティ、明日の会議の論点を整理して優先順位も付けて", 24), null);
});

test("default Slack and delegation builders preserve previous text", () => {
  const lifecycle = {
    sessionId: "s1",
    transport: "meet",
    state: "completed",
    isTerminal: true,
    durationFormatted: "00:01",
    meta: { meetingUrl: "https://meet.google.com/abc-defg-hij", agents: ["Agent"] },
    _conversationLog: [{ role: "user" }, { role: "assistant" }],
  };
  const notifier = new SlackNotifier("token", "channel", { enabled: true });

  assert.equal(
    notifier._buildStatusText(lifecycle),
    [
      "🎥 Google Meet 完了",
      "━━━━━━━━━━━━━━━",
      "🤖 エージェント: Agent",
      "🔗 ミーティング: https://meet.google.com/abc-defg-hij",
      "📊 状態: ✅ 完了",
      "⏱️ 会議時間: 00:01",
    ].join("\n")
  );
  assert.equal(
    notifier._buildSummaryText(lifecycle, { summary: ["要約"], decisions: ["決定"], todos: ["TODO"] }),
    [
      "📋 🎥 Google Meet サマリー",
      "━━━━━━━━━━━━━━━",
      "⏱️ 会議時間: 00:01",
      "",
      "📝 要約",
      "• 要約",
      "",
      "✅ 決定事項",
      "• 決定",
      "",
      "📌 TODO",
      "• TODO",
      "",
      "💬 発話数: 2（ユーザー: 1, Agent: 1）",
    ].join("\n")
  );
  assert.equal(
    buildDelegationResultsSection([{ label: "", status: "failed", resultText: "" }]),
    "\n## 委譲タスク結果\n\n- 委譲タスク (未完): 結果本文なし"
  );
});

test("representative config overrides replace defaults", () => {
  const configJson = {
    prompts: {
      summary: "CUSTOM SUMMARY\n",
      timeoutHandoffSlack: "HANDOFF {request}",
    },
    agent: {
      messages: {
        forcedDelegationFallback: "CUSTOM FORCED",
        groupGreetingTemplate: " plus {agents}",
      },
    },
    regex: {
      shortUtterancePingPatterns: ["ping"],
      shortUtterancePingFlags: "i",
    },
    delegation: {
      defaultLabel: "Task",
    },
    slack: {
      labels: {
        statusSuffix: "STATUS",
      },
    },
    gateway: {
      displayName: "Custom Gateway",
    },
  };

  const config = getPipelineConfig({}, null, null, configJson);
  assert.equal(config.summary.prompt, "CUSTOM SUMMARY\n");
  assert.equal(config.prompts.timeoutHandoffSlack, "HANDOFF {request}");
  assert.equal(config.messages.forcedDelegationFallback, "CUSTOM FORCED");
  assert.equal(config.messages.groupGreetingTemplate, " plus {agents}");
  assert.deepEqual(config.regex.shortUtterancePingPatterns, ["ping"]);
  assert.equal(getShortUtteranceSkipReason("PING", 24, config.regex), "ping");
  assert.equal(config.delegation.defaultLabel, "Task");
  assert.equal(config.slack.labels.statusSuffix, "STATUS");
  assert.equal(config.gatewayEvents.displayName, "Custom Gateway");
});

test("TTS prewarm uses resolved overridden fixed text", async () => {
  const capturedPrewarmTexts = [];
  await withFreshPipelineForPrewarm(async ({ createPipeline }) => {
    const messages = resolveMessages({
      agent: {
        messages: {
          forcedDelegationFallback: "OVERRIDE forced delegation line",
        },
      },
    });
    const config = {
      dgKey: "x",
      fishKey: "x",
      openclawUrl: "http://gateway.test",
      openclawToken: "x",
      stt: { model: "nova-3", language: "ja", sampleRate: 16_000 },
      llm: { model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 0, firstTokenDelegateMs: 15_000, openclawSystemAddendum: "" },
      tts: { referenceId: null, sampleRate: 1000, latency: "balanced", speed: 1 },
      ackVariants: messages.speech.ackVariants,
      progressPings: messages.speech.progressPings,
      timeoutFallback: messages.speech.timeoutFallback,
      exitFarewell: messages.speech.exitFarewell,
      greeting: "[warm] hello",
      echoCooldownMs: 1,
      gatewayEvents: { enabled: false },
      messages: messages.speech,
      regex: messages.regex,
      delegation: messages.delegation,
      exit: messages.exit,
    };
    const session = { id: "prewarm-test", conversationLog: [], config: { wakeMode: "off" } };
    const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
    const pipeline = createPipeline(session, turnState, () => {}, config, {});

    await waitFor(() => capturedPrewarmTexts.length > 0, 3000);
    pipeline.close();
  }, capturedPrewarmTexts);

  assert.equal(capturedPrewarmTexts.includes("OVERRIDE forced delegation line"), true);
  assert.equal(capturedPrewarmTexts.includes(DEFAULT_MESSAGES.speech.forcedDelegationFallback), false);
});

async function withFreshPipelineForPrewarm(fn, capturedPrewarmTexts) {
  const src = path.join(__dirname, "..", "src");
  const paths = [
    path.join(src, "stt-provider.js"),
    path.join(src, "stt.js"),
    path.join(src, "llm.js"),
    path.join(src, "tts-fish.js"),
    path.join(src, "tts-cache.js"),
    path.join(src, "pipeline.js"),
  ];
  const previousCache = new Map(paths.map((p) => [require.resolve(p), require.cache[require.resolve(p)]]));
  const previousEnv = setEnv({
    TTS_CACHE_PREWARM: undefined,
    TTS_CACHE_ENABLED: undefined,
    TTS_LEAD_MS: "0",
    TTS_GAP_MS: "0",
    METRICS_DISABLED: "1",
  });
  for (const p of paths) delete require.cache[require.resolve(p)];

  const sttExports = {
    createSTT: () => {
      const stt = new EventEmitter();
      stt.send = () => {};
      stt.close = () => {};
      return stt;
    },
    buildKeyterms: () => [],
  };

  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm.js"))] = cacheEntry(path.join(src, "llm.js"), {
    streamChat: async function* () {},
    VOICE_SYSTEM_ADDENDUM: "",
    buildVoiceAddendum: () => "",
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4)),
  });
  require.cache[require.resolve(path.join(src, "tts-cache.js"))] = cacheEntry(path.join(src, "tts-cache.js"), {
    createTtsCache: () => ({
      synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4)),
      prewarm: async (phrases) => {
        capturedPrewarmTexts.push(...phrases.map((phrase) => phrase.text));
      },
    }),
  });

  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    return await fn({ createPipeline });
  } finally {
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
  return { id: filename, filename, loaded: true, exports };
}

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
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

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition was not met before timeout");
}
