const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  DEFAULT_MESSAGES,
  buildVoiceAddendumFromMessages,
  resolveMessages,
} = require("../src/messages");

const ORIGINAL_OPENCLAW_ADDENDUM = `あなたは音声通話中です。

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

test("recombined OpenClaw addendum is byte-identical to the main-branch template", () => {
  const recombined = buildVoiceAddendumFromMessages(resolveMessages());
  const digest = crypto.createHash("sha256").update(recombined).digest("hex");

  // Literal snapshot of main:src/messages.js before the split.
  assert.equal(recombined, ORIGINAL_OPENCLAW_ADDENDUM);
  assert.equal(recombined.length, 1153);
  assert.equal(digest, "3744196ac55e57c812e5bdc4858cac16350663edbb2448acefd0d586f29741b6");
});

test("neutral addendum excludes OpenClaw-only tool, delegation, and Slack rules", () => {
  const neutral = buildVoiceAddendumFromMessages(resolveMessages(), { openclaw: false });
  assert.match(neutral, /【応答ルール】/);
  assert.match(neutral, /【絶対禁止事項】/);
  assert.doesNotMatch(neutral, /Slack|ツール実行ルール|sessions_spawn|サブエージェント結果の報告/);
});

test("voice addendum template and rendered addendum overrides retain precedence", () => {
  const templateMessages = resolveMessages({
    prompts: { voiceSystemAddendumTemplate: "custom {emotionLine}template" },
  });
  assert.equal(
    buildVoiceAddendumFromMessages(templateMessages, { emotionTags: false }),
    "custom template"
  );

  const renderedMessages = resolveMessages({
    prompts: { voiceSystemAddendum: "fully rendered override" },
  });
  assert.equal(renderedMessages.prompts.voiceSystemAddendum, "fully rendered override");
  assert.equal(DEFAULT_MESSAGES.prompts.voiceSystemAddendum, undefined);
});
