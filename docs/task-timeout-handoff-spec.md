# タスク: タイムアウト時のサブエージェント自動委譲

> ℹ️ 注記（2026-07・#124）: Twilio 電話ブリッジ機能は廃止済み。本文中の Twilio への言及は執筆当時の歴史的記述で、現行コードに Twilio 実装は存在しない（Meet 側の内容は現役）。

## 背景
タイムアウト時のフォールバック音声「Slackで共有するね」が嘘にならないよう、
timeout 発火時に自動で sessions_spawn を呼び、元の依頼をサブエージェントに委譲する。

## やること（3つ）

### 1. `lastUserTranscript` の保持
**場所**: `src/pipeline.js`

- パイプライン内で最新のユーザー発話（transcript）を常に保持する
- `handleTranscriptForLLM()` (utterance_end handler) で更新
- 変数名: `lastUserTranscript`

### 2. タイムアウト時の自動 sessions_spawn
**場所**: `src/pipeline.js` の `maybeSpeakLlmTimeoutFallback()` 内

- フォールバック音声再生の後に、OpenClaw Gateway へ sessions_spawn リクエストを送る
- HTTP POST: `${config.openclawUrl}/v1/chat/completions`
  - messages に `sessions_spawn` の指示を含めるか、
  - または Gateway の REST API で直接 sessions_spawn を叩く
- **もっとシンプルな方法**: Gateway の `/v1/chat/completions` に
  「ユーザーが音声で「${lastUserTranscript}」と依頼しました。
  実行して結果を Slack に投稿してください」
  というメッセージを sessions_spawn 形式で送る

**推奨実装**:
```javascript
// maybeSpeakLlmTimeoutFallback() 内、音声再生の後に追加
if (lastUserTranscript && !handoffAttempted) {
  handoffAttempted = true;
  // Fire-and-forget: Gateway に sessions_spawn リクエスト
  const spawnBody = JSON.stringify({
    model: config.llm.model || "anthropic/claude-sonnet-4-6",
    stream: false,
    messages: [
      { role: "system", content: "ユーザーの音声通話中に処理がタイムアウトしました。以下の依頼を実行し、結果をSlackで報告してください。" },
      { role: "user", content: lastUserTranscript }
    ],
    user: `meet-handoff-${session.id}`,
  });
  // HTTP POST to gateway (fire-and-forget, no await)
  const url = new URL("/v1/chat/completions", config.openclawUrl);
  const req = (url.protocol === "https:" ? require("https") : require("http")).request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.openclawToken}`,
    },
  });
  req.on("error", (err) => console.error("❌ Handoff spawn failed:", err.message));
  req.end(spawnBody);
  console.log("🔄 Timeout handoff: spawned sub-agent for:", lastUserTranscript.slice(0, 80));
}
```

### 3. ガードレール
- `handoffAttempted` フラグ: 1依頼あたり handoff は1回だけ（二重委譲防止）
- `lastUserTranscript` が空の場合は handoff しない
- fire-and-forget（await しない）— 通話の流れを止めない
- エラーはログ出力のみ（通話に影響させない）

### 4. Twilio bridge デフォルトタイムアウト設定
**場所**: `src/transport-twilio/twilio-bridge.js`

- `getPipelineConfig()` の overrides に `responseTimeoutMs: 25000` を追加
- Meet側はデフォルト（env設定で任意）、Twilio側は25秒をデフォルトに

```javascript
const config = getPipelineConfig({
  wakeMode: "off",
  exitDetection: false,
  responseTimeoutMs: 25000,
});
```

## テスト確認
- タイムアウト発火 → フォールバック音声 → handoff spawn のログが出ること
- 同一ターンで二重委譲されないこと（`handoffAttempted` が効いてること）
- `lastUserTranscript` が空の時は handoff がスキップされること
- Twilio bridge が 25秒デフォルトで動作すること

## ⚠️ やらないこと
- プロアクティブ通知（次フェーズ）
- ゲートウェイ分離関連のコード
