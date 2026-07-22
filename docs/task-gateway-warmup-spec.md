# タスク: Gateway セッション事前ウォームアップ

> ℹ️ 注記（2026-07・#124）: Twilio 電話ブリッジ機能は廃止済み。本文中の Twilio への言及は執筆当時の歴史的記述で、現行コードに Twilio 実装は存在しない（Meet 側の内容は現役）。

## 背景
音声通話（Twilio / Meet）の初回レスポンスが遅い原因は、Gateway の初回セッションロード
（SOUL.md / MEMORY.md 等の読み込み + LLM初回推論）にある。
電話をかける前 / Meet に参加する前に Gateway セッションを事前ウォームアップすることで、
接続直後から即座に応答できるようにする。

## やること（3つ）

### 1. 共通 warm-up 関数
**場所**: `src/gateway-warmup.js`（新規ファイル）

```javascript
/**
 * Gateway セッションを事前ウォームアップする（fire-and-forget）
 *
 * @param {string} sessionId - セッション識別子（`meet-${id}` 等）
 * @param {object} config - getPipelineConfig() の結果
 * @param {string|null} briefing - タスクブリーフィング（オプション）
 */
async function warmUpGatewaySession(sessionId, config, briefing = null) {
  // ...
}
```

- Gateway URL/Token は `config.openclawUrl` / `config.openclawToken` から取得
- Gateway が未設定（OpenRouter fallback 環境）の場合は何もしない
- `briefing` が渡された場合:
  ```
  messages: [
    { role: "system", content: "音声通話の準備中です。以下の情報を確認して備えてください。" },
    { role: "user", content: briefing }
  ]
  ```
- `briefing` がない場合:
  ```
  messages: [
    { role: "user", content: "セッション準備中。次のメッセージから音声通話が始まります。" }
  ]
  ```
- `user: sessionId`（パイプラインと同じセッション ID を使う）
- `max_tokens` 制約なし（自然に応答させる、レスポンスは破棄）
- **fire-and-forget**（await しない、通話フローをブロックしない）
- リクエストタイムアウト: 30秒（warm-up は裏で完了すればOK）
- エラーはログのみ（通話に影響させない）

### 2. Twilio bridge への組み込み
**場所**: `src/transport-twilio/twilio-bridge.js` の `/call-me` ハンドラ

- Twilio API で発信する **直前** に `warmUpGatewaySession()` を呼ぶ
- session ID は `callSid` が使えないため（まだ発信前）、事前に生成する
  → `crypto.randomUUID()` で生成し、call-me レスポンスに含める
  → stream start 時に pipeline がこの同じ ID を使うようにする
- `/call-me` の POST body にオプションで `briefing` フィールドを受け付ける
  ```json
  { "to": "+81XXXXXXXXXX", "briefing": "レストラン〇〇に予約の電話..." }
  ```
- `briefing` があれば warm-up に渡す

**重要**: stream start 時のパイプライン作成で、warm-up と同じ session ID を使うこと。
現在は `ctx.callSid || ctx.streamSid || crypto.randomUUID()` だが、
warm-up で使った ID を `ctx.warmupSessionId` に保持して、それを優先する。

### 3. Meet bridge への組み込み
**場所**: `src/transport-meet/meet-routes.js` の `/join-meeting` ハンドラ

- Attendee Bot 起動 **直前** に `warmUpGatewaySession()` を呼ぶ
- session ID は既に `crypto.randomUUID()` で生成済み → そのまま使える
- `/join-meeting` の POST body にオプションで `briefing` を受け付ける
- Attendee Bot の参加に ~30秒かかるので、warm-up は余裕で完了する

## テスト確認
- warm-up 完了後の初回 LLM 応答が、warm-up なしと比べて速いこと
- Gateway 未設定環境で warm-up がスキップされること（エラーにならない）
- 電話がつながらなかった場合でもエラーが出ないこと
- `briefing` 付き warm-up → 通話開始後にブリーフィング内容を参照できること
- `briefing` なし warm-up → 通常通り動作すること

## ⚠️ やらないこと
- セッションの明示的な破棄（Gateway の TTL に任せる）
- ゲートウェイ分離関連のコード
- warm-up のレスポンス内容の利用（破棄するのみ）
