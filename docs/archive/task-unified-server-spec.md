# Task: 1ポート統合（Meet + Twilio 統一サーバー）

> ⚠️ **歴史的スペック文書**: Twilio 電話ブリッジ機能は廃止済み（2026-07・#124）。本文中の Twilio 関連記述は現行コードには存在しない。

## 背景
Meet ブリッジ（port 5005）と Twilio ブリッジ（port 5006）が別プロセス・別ポートで動いている。
free ngrok はトンネル1本しか張れないため、同時利用不可。
→ 1つの HTTP サーバーで両方のルートを処理し、ngrok 切り替え不要にする。

## ゴール
- **1ポート（5005）で Meet と Twilio の両方が動く**
- ngrok は1本で Meet も Twilio も OK
- 既存の動作（Meet/Twilio 各単体）が壊れない

## アーキテクチャ

### ルーティング方針
| パス | 処理 |
|------|------|
| `GET /` | Meet UI (index.html) |
| `GET /info` | Meet info JSON |
| `POST /join-meeting` | Meet bot 起動 |
| `WS /?sid=xxx` | Meet 音声ストリーム |
| `GET /health` | Twilio health check |
| `POST /call-me` | Twilio 発信 |
| `POST /twilio/voice` | Twilio TwiML 応答 |
| `POST /twilio/status` | Twilio ステータスコールバック |
| `WS /twilio/stream/<token>` | Twilio 音声ストリーム |

### ファイル構成（推奨）

```
src/
  server.js                    ← NEW: 統合エントリポイント（HTTPサーバー + WS + ルーティング）
  transport-meet/
    meet-routes.js             ← NEW: Meet 固有の HTTP/WS ハンドラ
  transport-twilio/
    twilio-routes.js           ← NEW: twilio-bridge.js から Twilio 固有の HTTP/WS ハンドラを抽出
    twilio-bridge.js           ← 残す（後方互換: 単体起動用。ただし通常は server.js を使用）
    call-manager.js            ← 変更なし
    twilio-adapter.js          ← 変更なし
  pipeline.js                  ← 変更なし
  config.js                    ← 変更なし
  llm.js                       ← 変更なし
  stt.js                       ← 変更なし
  tts-fish.js                  ← 変更なし
  gateway-warmup.js            ← 変更なし
  session-events.js            ← 変更なし
  slack-notifier.js            ← 変更なし
  summarizer.js                ← 変更なし
```

### server.js の責務
1. `dotenv` ロード
2. `http.createServer()` で1つの HTTP サーバー作成（PORT = process.env.PORT || 5005）
3. HTTP リクエストをパスで振り分け：
   - `/twilio/*` or `/call-me` or `/health` → `twilio-routes.handleHttp(req, res)`
   - それ以外 → `meet-routes.handleHttp(req, res)`
4. `server.on("upgrade")` で WS アップグレードをパスで振り分け：
   - `/twilio/stream/*` → `twilio-routes.handleUpgrade(req, socket, head, wss)`
   - それ以外 → Meet 用 WSS（既存ロジック）
5. 共有リソース（SlackNotifier 等）は各モジュールが独自にインスタンス化して OK（現状と同じ）

### meet-routes.js の責務
- Meet 実装から以下を抽出：
  - `GET /` (index.html), `GET /info`, `POST /join-meeting` の HTTP ハンドラ
  - Meet 用 WebSocket 接続ハンドラ（`wss.on("connection", ...)` のロジック）
  - `meetingSessions`, `activeConnections`, `meetLifecycles` Map 管理
  - `createHandler()`, `createLegacyAgent()`, 会話ログ保存、メモリ追記 等
- エクスポート：
  - `handleHttp(req, res)` — HTTP リクエスト処理
  - `handleWsConnection(ws, req)` — WS 接続処理
  - `init(options)` — 初期化（ngrok検出、bot avatar ロード等）

### twilio-routes.js の責務
- `twilio-bridge.js` から以下を抽出：
  - `GET /health`, `POST /call-me`, `POST /twilio/voice`, `POST /twilio/status` の HTTP ハンドラ
  - Twilio WebSocket ストリーム処理（`wss.on("connection", ...)` のロジック）
  - `sessionLifecycles`, ephemeral token 管理、rate limit 等
- エクスポート：
  - `handleHttp(req, res)` — HTTP リクエスト処理
  - `handleUpgrade(req, socket, head, wss)` — WS アップグレード処理
  - `init(options)` — 初期化

## 環境変数の変更

### TWILIO_PUBLIC_URL の扱い
- 統合後は Meet と Twilio が同じポート → ngrok URL も同じ
- `TWILIO_PUBLIC_URL` は統合サーバーの ngrok URL を指す（従来通り `.env` で設定）
- Meet 側の ngrok 自動検出（`http://localhost:4040/api/tunnels`）も統合サーバーで動く

### 新しい npm scripts（package.json）
```json
{
  "scripts": {
    "start": "node src/server.js",
    "start:twilio": "node src/transport-twilio/twilio-bridge.js",
    "dev": "node --watch src/server.js"
  }
}
```

## 制約・注意
- **既存ファイルは壊さない**: `twilio-bridge.js` は後方互換で残す（単体起動できるように）
- **共通モジュールは変更しない**: pipeline.js, config.js, llm.js, stt.js, tts-fish.js, gateway-warmup.js 等
- **テスト**: 統合サーバーで以下を確認
  1. `GET /health` → Twilio health JSON
  2. `POST /call-me` → Twilio 発信（電話がかかる）
  3. `POST /join-meeting` → Meet bot 起動（Attendee API にリクエスト飛ぶ）
  4. Meet WS 接続（`?sid=` パラメータ）
  5. Twilio WS 接続（`/twilio/stream/<token>`）
- **ngrok**: `ngrok http 5005` の1本で Meet も Twilio も通る

## やらないこと
- pipeline.js / config.js / llm.js / stt.js / tts-fish.js の変更
- ゲートウェイ分割（やらない、前回 revert 済み）
- 新機能追加（今回はポート統合のみ）
