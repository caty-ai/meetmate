const DEFAULT_MESSAGES = {
  prompts: {
    standaloneSystemPrompt: `あなたは日本語で会話する音声アシスタントです。
ユーザーの話をよく聞き、自然で簡潔な話し言葉で答えてください。
わからないことは推測せず、必要なら確認してください。`,
    voiceEmotionLine: "- すべての発話の先頭に必ず感情タグを1個入れる（タグなしだと声が暴走するため、スタイル安定化のアンカーとして使う）。使えるタグ: [soft voice]（デフォルト・優しい声）, [warm]（温かみ）, [friendly, warm]（親しみ＋温かみ）, [empathetic, unhurried]（謝罪・落ち着き）, [thoughtful]（考え深く）。迷ったら [soft voice]。\n",
    voiceSystemAddendumTemplate: `あなたは音声通話中です。

【応答ルール】
- 短く話す（1回の発話は2〜3文まで。長くならないこと！）
{emotionLine}- コードブロック、マークダウン記法、長いリスト、テーブルは使わない（音声で読み上げるので）
- 絵文字は使わない（音声で読み上げできないため。なお [soft voice] のような感情タグは絵文字ではないので必須で使うこと）
- URL、長い詳細、リスト、コード風テキストは会議チャット専用タグ [[[chat: ...]]] で送る（読み上げられない）。口頭は「チャットに貼っておくね」程度に短くし、1項目1タグ、タグ位置は応答内のどこでもよい。絵文字はチャットにも使えない（会議チャット側が絵文字入りメッセージを拒否するため）
- 相手の話をしっかり聞いてから応答する
- 音声では結論→次アクションを優先。{openclawSlackRule}

{openclawRules}【絶対禁止事項】
NO_REPLY は絶対に使わないこと（音声通話ではサイレント応答は不可）。
何があっても必ずテキストで応答すること。
返すことがない場合は「了解！何かあったら言ってね」のように一言添えること。`,
    voiceOpenclawSystemAddendum: `【ツール実行ルール】
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
\n`,
    summary: `以下の音声通話/会議の会話ログから、簡潔なサマリーをJSON形式で生成してください。

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
`,
    gatewayBriefingSystem: [
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
    ].join("\n"),
    gatewayWarmupUser: "セッション準備中。次のメッセージから音声通話が始まります。",
    timeoutHandoffGateway: [
      "ユーザーの音声通話中に依頼処理がタイムアウトしました。",
      "必ず sessions_spawn を使って作業を委譲してください。",
      "まずユーザー依頼を短く要約し、実行計画を立ててからサブエージェントを起動してください。",
      "サブエージェントの結果を最終回答としてそのまま返してください。会議への報告は音声ハーネス側が行います。",
      "",
      "ユーザー依頼: {request}",
    ].join("\n"),
    timeoutHandoffSlack: [
      "ユーザーの音声通話中に依頼処理がタイムアウトしました。",
      "必ず sessions_spawn を使って作業を委譲し、結果をSlackに投稿してください。",
      "まずユーザー依頼を短く要約し、実行計画を立ててからサブエージェントを起動してください。",
      "",
      "ユーザー依頼: {request}",
    ].join("\n"),
    timeoutHandoffGatewaySystem: "あなたは音声タイムアウト時の自動委譲ハンドラーです。必ず sessions_spawn に委譲し、結果を最終回答として返してください。",
    timeoutHandoffSlackSystem: "あなたは音声タイムアウト時の自動委譲ハンドラーです。結果は必ずSlackに共有してください。",
  },
  speech: {
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
  },
  regex: {
    cancelPattern: "^[\\s\\u3000]*(キャンセル|やめて|もういい|中止|ストップ|stop|cancel)[\\s\\u3000。！!]*$",
    cancelFlags: "i",
    immediateAckPattern: "お願い|やって|して|調べ|確認|探し|実装|作業|対応|予約|連絡|電話|送って|まとめ",
    immediateAckFlags: "i",
    immediateAckEnglishPattern: "can you|please|check|find|implement|do this|call|book|summarize",
    immediateAckEnglishFlags: "i",
    immediateAckTaskPattern: "調べ|確認|探し|予約|連絡|call|check|find|book",
    immediateAckTaskFlags: "i",
    immediateAckTaskVariantPattern: "確認|調べ|check",
    immediateAckTaskVariantFlags: "i",
    shortUtterancePingPatterns: [
      "話せる",
      "大丈夫",
      "聞こえ",
      "おーい",
      "元気",
      "どう[?？]?$",
      "テスト",
    ],
    shortUtterancePingFlags: "u",
  },
  delegation: {
    statusComplete: "完了",
    statusIncomplete: "未完",
    sectionHeading: "## 委譲タスク結果",
    defaultLabel: "委譲タスク",
    emptyResult: "結果本文なし",
    missingResult: "結果本文を取得できませんでした。",
    chatPrefix: "委譲タスク結果",
  },
  exit: {
    commands: [
      "退出して", "退出していいよ", "退出", "退出して大丈夫",
      "退室して", "退室していいよ", "退室", "退室して大丈夫", "退室してもらって",
    ],
  },
  slack: {
    stateEmoji: {
      idle: "⬜ 待機",
      initiating: "⏳ 受付",
      ringing: "🔔 発信中",
      "in-progress": "🟢 通話中",
      ending: "🔄 終了処理中",
      completed: "✅ 完了",
      failed: "❌ 失敗",
    },
    transportLabel: {
      meet: "🎥 Google Meet",
      zoom: "🎥 Zoom Meeting",
    },
    statusCompleteSuffix: "完了",
    statusSuffix: "ステータス",
    separator: "━━━━━━━━━━━━━━━",
    agentLinePrefix: "🤖 エージェント",
    meetingLinePrefix: "🔗 ミーティング",
    stateLinePrefix: "📊 状態",
    durationLinePrefix: "⏱️ 会議時間",
    elapsedLinePrefix: "⏱️ 経過",
    emptyValue: "—",
    summaryTitleSuffix: "サマリー",
    summaryTitlePrefix: "📋",
    summarySection: "📝 要約",
    decisionsSection: "✅ 決定事項",
    todosSection: "📌 TODO",
    utteranceStatsPrefix: "💬 発話数",
    userLabel: "ユーザー",
    defaultAgentLabel: "AI",
  },
  gateway: {
    displayName: "AI MeetServer",
  },
  soniox: {
    smokeDefaultKeyterms: "AIエージェント",
  },
};

function getString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function getArray(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

function renderTemplate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
  });
}

function buildVoiceAddendumFromMessages(messages = DEFAULT_MESSAGES, { emotionTags = true, openclaw = true } = {}) {
  const prompts = messages.prompts || DEFAULT_MESSAGES.prompts;
  return renderTemplate(prompts.voiceSystemAddendumTemplate, {
    emotionLine: emotionTags ? prompts.voiceEmotionLine : "",
    openclawSlackRule: openclaw ? "詳細はSlackで共有する" : "",
    openclawRules: openclaw ? prompts.voiceOpenclawSystemAddendum : "",
  });
}

function resolveMessages(configJson = null) {
  const prompts = configJson?.prompts || {};
  const agentMessages = configJson?.agent?.messages || {};
  const regex = configJson?.regex || {};
  const delegation = configJson?.delegation || {};
  const slackLabels = configJson?.slack?.labels || {};
  const gateway = configJson?.gateway || {};
  const soniox = configJson?.soniox || {};

  return {
    prompts: {
      standaloneSystemPrompt: getString(prompts.standaloneSystemPrompt, DEFAULT_MESSAGES.prompts.standaloneSystemPrompt),
      voiceEmotionLine: getString(prompts.voiceEmotionLine, DEFAULT_MESSAGES.prompts.voiceEmotionLine),
      voiceSystemAddendumTemplate: getString(prompts.voiceSystemAddendumTemplate, DEFAULT_MESSAGES.prompts.voiceSystemAddendumTemplate),
      voiceOpenclawSystemAddendum: getString(prompts.voiceOpenclawSystemAddendum, DEFAULT_MESSAGES.prompts.voiceOpenclawSystemAddendum),
      voiceSystemAddendum: getString(prompts.voiceSystemAddendum, ""),
      summary: getString(prompts.summary, DEFAULT_MESSAGES.prompts.summary),
      gatewayBriefingSystem: getString(prompts.gatewayBriefingSystem, DEFAULT_MESSAGES.prompts.gatewayBriefingSystem),
      gatewayWarmupUser: getString(prompts.gatewayWarmupUser, DEFAULT_MESSAGES.prompts.gatewayWarmupUser),
      timeoutHandoffGateway: getString(prompts.timeoutHandoffGateway, DEFAULT_MESSAGES.prompts.timeoutHandoffGateway),
      timeoutHandoffSlack: getString(prompts.timeoutHandoffSlack, DEFAULT_MESSAGES.prompts.timeoutHandoffSlack),
      timeoutHandoffGatewaySystem: getString(prompts.timeoutHandoffGatewaySystem, DEFAULT_MESSAGES.prompts.timeoutHandoffGatewaySystem),
      timeoutHandoffSlackSystem: getString(prompts.timeoutHandoffSlackSystem, DEFAULT_MESSAGES.prompts.timeoutHandoffSlackSystem),
    },
    speech: {
      ackVariants: getArray(agentMessages.ackVariants, DEFAULT_MESSAGES.speech.ackVariants),
      progressPings: getArray(agentMessages.progressPings, DEFAULT_MESSAGES.speech.progressPings),
      timeoutFallback: getString(agentMessages.timeoutFallback, DEFAULT_MESSAGES.speech.timeoutFallback),
      forcedDelegationFallback: getString(agentMessages.forcedDelegationFallback, DEFAULT_MESSAGES.speech.forcedDelegationFallback),
      handoffSuccess: getString(agentMessages.handoffSuccess, DEFAULT_MESSAGES.speech.handoffSuccess),
      handoffFailure: getString(agentMessages.handoffFailure, DEFAULT_MESSAGES.speech.handoffFailure),
      forcedDelegationFallbackMeet: getString(agentMessages.forcedDelegationFallbackMeet, DEFAULT_MESSAGES.speech.forcedDelegationFallbackMeet),
      handoffUnconfirmedMeet: getString(agentMessages.handoffUnconfirmedMeet, DEFAULT_MESSAGES.speech.handoffUnconfirmedMeet),
      handoffBusyMeet: getString(agentMessages.handoffBusyMeet, DEFAULT_MESSAGES.speech.handoffBusyMeet),
      reportPostUnknown: getString(agentMessages.reportPostUnknown, DEFAULT_MESSAGES.speech.reportPostUnknown),
      circuitBreakerRecoveryNotice: getString(agentMessages.circuitBreakerRecoveryNotice, DEFAULT_MESSAGES.speech.circuitBreakerRecoveryNotice),
      exitFarewell: getString(agentMessages.exitFarewell, DEFAULT_MESSAGES.speech.exitFarewell),
      groupGreetingTemplate: getString(agentMessages.groupGreetingTemplate, DEFAULT_MESSAGES.speech.groupGreetingTemplate),
      completionVoiceTemplate: getString(agentMessages.completionVoiceTemplate, DEFAULT_MESSAGES.speech.completionVoiceTemplate),
      staleCompletionVoicePrefix: getString(agentMessages.staleCompletionVoicePrefix, DEFAULT_MESSAGES.speech.staleCompletionVoicePrefix),
      errorVoice: getString(agentMessages.errorVoice, DEFAULT_MESSAGES.speech.errorVoice),
    },
    regex: {
      cancelPattern: getString(regex.cancelPattern, DEFAULT_MESSAGES.regex.cancelPattern),
      cancelFlags: getString(regex.cancelFlags, DEFAULT_MESSAGES.regex.cancelFlags),
      immediateAckPattern: getString(regex.immediateAckPattern, DEFAULT_MESSAGES.regex.immediateAckPattern),
      immediateAckFlags: getString(regex.immediateAckFlags, DEFAULT_MESSAGES.regex.immediateAckFlags),
      immediateAckEnglishPattern: getString(regex.immediateAckEnglishPattern, DEFAULT_MESSAGES.regex.immediateAckEnglishPattern),
      immediateAckEnglishFlags: getString(regex.immediateAckEnglishFlags, DEFAULT_MESSAGES.regex.immediateAckEnglishFlags),
      immediateAckTaskPattern: getString(regex.immediateAckTaskPattern, DEFAULT_MESSAGES.regex.immediateAckTaskPattern),
      immediateAckTaskFlags: getString(regex.immediateAckTaskFlags, DEFAULT_MESSAGES.regex.immediateAckTaskFlags),
      immediateAckTaskVariantPattern: getString(regex.immediateAckTaskVariantPattern, DEFAULT_MESSAGES.regex.immediateAckTaskVariantPattern),
      immediateAckTaskVariantFlags: getString(regex.immediateAckTaskVariantFlags, DEFAULT_MESSAGES.regex.immediateAckTaskVariantFlags),
      shortUtterancePingPatterns: getArray(regex.shortUtterancePingPatterns, DEFAULT_MESSAGES.regex.shortUtterancePingPatterns),
      shortUtterancePingFlags: getString(regex.shortUtterancePingFlags, DEFAULT_MESSAGES.regex.shortUtterancePingFlags),
    },
    delegation: {
      statusComplete: getString(delegation.statusComplete, DEFAULT_MESSAGES.delegation.statusComplete),
      statusIncomplete: getString(delegation.statusIncomplete, DEFAULT_MESSAGES.delegation.statusIncomplete),
      sectionHeading: getString(delegation.sectionHeading, DEFAULT_MESSAGES.delegation.sectionHeading),
      defaultLabel: getString(delegation.defaultLabel, DEFAULT_MESSAGES.delegation.defaultLabel),
      emptyResult: getString(delegation.emptyResult, DEFAULT_MESSAGES.delegation.emptyResult),
      missingResult: getString(delegation.missingResult, DEFAULT_MESSAGES.delegation.missingResult),
      chatPrefix: getString(delegation.chatPrefix, DEFAULT_MESSAGES.delegation.chatPrefix),
    },
    exit: {
      commands: getArray(configJson?.exit?.commands, DEFAULT_MESSAGES.exit.commands),
    },
    slack: {
      stateEmoji: { ...DEFAULT_MESSAGES.slack.stateEmoji, ...(slackLabels.stateEmoji || {}) },
      transportLabel: { ...DEFAULT_MESSAGES.slack.transportLabel, ...(slackLabels.transportLabel || {}) },
      statusCompleteSuffix: getString(slackLabels.statusCompleteSuffix, DEFAULT_MESSAGES.slack.statusCompleteSuffix),
      statusSuffix: getString(slackLabels.statusSuffix, DEFAULT_MESSAGES.slack.statusSuffix),
      separator: getString(slackLabels.separator, DEFAULT_MESSAGES.slack.separator),
      agentLinePrefix: getString(slackLabels.agentLinePrefix, DEFAULT_MESSAGES.slack.agentLinePrefix),
      meetingLinePrefix: getString(slackLabels.meetingLinePrefix, DEFAULT_MESSAGES.slack.meetingLinePrefix),
      stateLinePrefix: getString(slackLabels.stateLinePrefix, DEFAULT_MESSAGES.slack.stateLinePrefix),
      durationLinePrefix: getString(slackLabels.durationLinePrefix, DEFAULT_MESSAGES.slack.durationLinePrefix),
      elapsedLinePrefix: getString(slackLabels.elapsedLinePrefix, DEFAULT_MESSAGES.slack.elapsedLinePrefix),
      emptyValue: getString(slackLabels.emptyValue, DEFAULT_MESSAGES.slack.emptyValue),
      summaryTitleSuffix: getString(slackLabels.summaryTitleSuffix, DEFAULT_MESSAGES.slack.summaryTitleSuffix),
      summaryTitlePrefix: getString(slackLabels.summaryTitlePrefix, DEFAULT_MESSAGES.slack.summaryTitlePrefix),
      summarySection: getString(slackLabels.summarySection, DEFAULT_MESSAGES.slack.summarySection),
      decisionsSection: getString(slackLabels.decisionsSection, DEFAULT_MESSAGES.slack.decisionsSection),
      todosSection: getString(slackLabels.todosSection, DEFAULT_MESSAGES.slack.todosSection),
      utteranceStatsPrefix: getString(slackLabels.utteranceStatsPrefix, DEFAULT_MESSAGES.slack.utteranceStatsPrefix),
      userLabel: getString(slackLabels.userLabel, DEFAULT_MESSAGES.slack.userLabel),
      defaultAgentLabel: getString(slackLabels.defaultAgentLabel, DEFAULT_MESSAGES.slack.defaultAgentLabel),
    },
    gateway: {
      displayName: getString(gateway.displayName, DEFAULT_MESSAGES.gateway.displayName),
    },
    soniox: {
      smokeDefaultKeyterms: getString(soniox.smokeDefaultKeyterms, DEFAULT_MESSAGES.soniox.smokeDefaultKeyterms),
    },
  };
}

module.exports = {
  DEFAULT_MESSAGES,
  buildVoiceAddendumFromMessages,
  renderTemplate,
  resolveMessages,
};
