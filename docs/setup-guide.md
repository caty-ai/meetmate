# セットアップ手順書

## 事前準備

### API キー取得

| サービス | 取得先 | 用途 |
|---------|--------|------|
| Deepgram | https://console.deepgram.com/signup | STT（音声認識） |
| Attendee | https://app.attendee.dev/accounts/signup/ | Google Meet Bot |
| Fish Audio | https://fish.audio/ | TTS（音声合成） |
| ngrok | `brew install ngrok` | WebSocket トンネル |

### OpenClaw Gateway（推奨）
フル Caty 体験（SOUL.md + memory + ツール）を有効にするには、OpenClaw Gateway のトークンが必要。
Gateway が同じマシンで稼働している場合、URL は `http://localhost:18789`。

---

## セットアップ手順

### 1. 依存関係インストール

```bash
cd ~/meetmate
npm install
```

### 2. 環境変数設定

```bash
cp .env.example .env
```

`.env` を編集して API キーを設定:

```bash
# 必須
DEEPGRAM_API_KEY=your_key
ATTENDEE_API_KEY=your_key
FISH_AUDIO_API_KEY=your_key

# OpenClaw Gateway（推奨）
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your_token

# セキュリティ
JOIN_SHARED_TOKEN=your_random_token
WS_SHARED_TOKEN=your_random_token
```

### 3. ngrok 起動（ターミナル1）

```bash
# 初回のみ authtoken 設定
ngrok config add-authtoken <YOUR_AUTHTOKEN>

# トンネル起動
ngrok http 5005
```

### 4. Bridge Server 起動（ターミナル2）

```bash
node src/index.js
```

起動ログ:
```
🚀  AI Meet Participant Bridge Server 起動: http://localhost:5005
🐱  Caty（ケイティ）がMeetで待機中…
🔗  OpenClaw Gateway: http://localhost:18789 ✅
📡  Public WSS URL: wss://xxx.ngrok-free.app
```

### 5. Google Meet に参加させる

1. ブラウザで `http://localhost:5005` を開く
   - Tailscale 経由: `http://<tailscale-ip>:5005`
2. Google Meet URL を貼り付け
3. 「🚀 Meetに参加させる」をクリック
4. 約30秒で Bot が Meet に参加

---

## アクセス方法

| 方法 | URL | 用途 |
|------|-----|------|
| ローカル | `http://localhost:5005` | 同じマシンから |
| Tailscale | `http://<tailscale-ip>:5005` | 外出先から |
| ngrok | `https://xxx.ngrok-free.app` | Attendee 接続用（自動検出） |

---

## 音声設定

### Fish Audio Voice ID

現在のデフォルト: ユーザー が選んだ声 (`3dac2f5a837d43458d87918ef24b344d`)

変更方法: `.env` の `FISH_AUDIO_VOICE_ID` を変更して再起動。

声の探し方: https://fish.audio/ で試聴して Voice ID をコピー。

### ウェイクワード

ミーティングで特定の人だけに反応させたい場合:

```bash
# .env
WAKE_MODE=wake
WAKE_WORDS=ケイティ,けいてぃ,caty,katie,ケイケイ
```

- `off`: 全発話に応答（1対1ミーティング向け）
- `wake`: 名前を呼ばれた時だけ応答（複数人ミーティング向け）

---

## トラブルシューティング

### Bot が Meet に参加しない
- Meet URL が `https://meet.google.com/xxx-xxxx-xxx` 形式か確認
- Meet の「参加をリクエストしています」通知を承認
- 新しい Meet を作り直して再試行

### 音声が聞こえない
- ngrok が起動しているか確認
- コンソールに `🟢 STT connected` が出ているか確認
- `📡 Public WSS URL` が表示されているか確認

### Caty が応答しない
- OpenClaw Gateway が起動しているか確認: `curl http://localhost:18789/health`
- Gateway トークンが正しいか確認
- コンソールに `🔗 OpenClaw Gateway: ... ✅` が出ているか確認
- Gateway が使えない場合は `OPENROUTER_API_KEY` を設定してフォールバック

### エコー（Bot が自分の声に反応）
- `💬 [agent]` が連続で同じ内容を繰り返していたらエコー問題
- コンソールに `🔇 Muting` が出ていれば保護が動作中
- `LISTEN_ENDPOINTING_MS` を大きくすると改善する場合あり

### 音声にノイズ（シャラシャラ音）
- Fish Audio の PCM バイトアラインメントバッファが動作しているか確認
- コンソールに `⚠️ odd byte` 的なログがあれば正常に修正されている

---

## 開発者向け

### プロセス管理

```bash
# サーバー起動
node src/index.js

# 構文チェック
node -c src/index.js
node -c src/pipeline.js
node -c src/llm.js

# ログ確認
ls logs/
cat logs/meeting-*.json
```

### エンドポイント

| パス | メソッド | 説明 |
|------|---------|------|
| `/` | GET | Web UI |
| `/join-meeting` | POST | Bot を Meet に参加させる |
| `/info` | GET | サーバー情報（TTS provider, WSS URL 等） |
| WebSocket `/` | — | Attendee との音声ストリーム |
