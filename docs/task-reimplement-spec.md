# タスク: タイムアウト・Ping上限・ノイズフィルター再実装

> ℹ️ 注記（2026-07・#124）: Twilio 電話ブリッジ機能は廃止済み。本文中の Twilio への言及（除外リスト内の `TWILIO_*` 環境変数）は執筆当時の歴史的記述で、現行コードに Twilio 実装は存在しない。

## 背景
Gateway分離に関する2コミット (`bc24dcd`, `d603254`) をrevertした。
その中に含まれていた **ゲートウェイ分離と無関係な改善** を個別に再実装する。

## ⚠️ やらないこと（明確に除外）
- `VOICE_LLM_MODE` / `llmMode` 切替ロジック（gateway/openrouter/auto）
- `TWILIO_GATEWAY_URL` / `TWILIO_GATEWAY_TOKEN` 環境変数
- `resolvedGatewayUrl` / `resolvedGatewayToken` / `useGateway` 条件分岐
- ゲートウェイ分離に関するすべてのコード

## ✅ やること（3つ）

### 1. LLMレスポンスタイムアウト
**場所**: `src/pipeline.js` + `src/config.js`

- 環境変数 `LLM_RESPONSE_TIMEOUT_MS`（デフォルト: 35000ms = ack + 3 progress pings + buffer。0 = 無効）
- `config.llm.responseTimeoutMs` として config に追加
- `overrides.responseTimeoutMs` からの受け取りも対応
- pipeline内で `llmTimeoutTimer` を設置
  - LLMストリーミング開始後、最初のチャンクが来るまでの制限時間
  - `firstChunkSeen` フラグで管理
  - タイムアウト時: `abort()` → フォールバック音声「ちょっと時間がかかってるから、詳細はあとでSlackで共有するね。」
- `stopLlmTimeoutTimer()` を finally + abort 時にクリーンアップ

### 2. 処理中Ping上限
**場所**: `src/pipeline.js`

- 環境変数 `PROGRESS_PING_MAX`（デフォルト: 3）
- `scheduleProgressPing()` 内で `progressPingIndex >= PROGRESS_PING_MAX` なら打ち切り
- 無限pingを防ぐ安全弁

### 3. Barge-inノイズフィルター
**場所**: `src/pipeline.js`

- `isNoiseInterim(text)` 関数を追加:
  - 空文字 → noise
  - 1-4文字の英字のみ（"LL", "ok", "ah"等） → noise
  - 数字のみ → noise
  - 意味のある文字比率 < 0.5 → noise
- `getAlphaNumericRatio(text)` ヘルパー:
  - ひらがな・カタカナ・漢字・英数字の比率を算出
- STT transcript handler で:
  - `confidence` パラメータを受け取る（第3引数）
  - `BARGE_IN_CONFIDENCE_MIN`（デフォルト: 0.45）未満はスキップ
  - `isNoiseInterim()` が true ならスキップ
  - スキップ時はログ出力: `🧹 Barge-in ignored (noise/conf)`

### 4. config.js の小改善（ゲートウェイ無関係の部分のみ）
- `responseTimeoutMs` を config に追加
- `openclawSystemAddendum` を config に追加（後続のサブエージェント委譲addendum用）
- `temperature` / `maxTokens` の overrides 対応
- `exitDetection` の overrides パススルー

## テスト確認
- `PROGRESS_PING_MAX=3` で4回目のpingが発火しないこと
- `LLM_RESPONSE_TIMEOUT_MS=25000` でタイムアウト時にフォールバック音声が流れること
- ノイズ文字列 "LL", "3", "!!" 等で barge-in が発火しないこと
- 正常な日本語発話でbarge-inが正常に動作すること
