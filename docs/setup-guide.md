# セットアップガイド — AI Meet Participant v7

> **1エージェント = 1サーバーインスタンス。**
> `config.json` + `.env` + `assets/avatar.png` の3点で任意のエージェントが動作する。

---

## 事前準備

### 必要なアカウント・APIキー

| サービス | 取得先 | 用途 | 必須 |
|---------|--------|------|------|
| OpenClaw Gateway | 同一マシンで稼働 | LLM（SOUL/memory/tools/skills連携）。**現状の hard prerequisite**（汎用 LLM バックエンドは [#114](https://github.com/caty-ai/meetmate/issues/114) で設計中） | ✅ |
| Soniox | https://console.soniox.com/ | STT（音声認識・既定プロバイダ） | ✅ |
| Deepgram | https://console.deepgram.com/signup | STT（`STT_PROVIDER=deepgram` 切替時のみ） | 任意 |
| Attendee | https://app.attendee.dev/accounts/signup/ | Google Meet / Zoom Bot | ✅ |
| Fish Audio | https://fish.audio/ | TTS（音声合成） | ✅ |
| ngrok | `brew install ngrok` | WebSocket トンネル（外部接続用） | ✅ |
| Slack Bot | https://api.slack.com/apps | ステータス通知・サマリー投稿 | 任意 |

### 前提条件

- Node.js v22+（`package.json` の `engines` 準拠）
- OpenClaw Gateway が同一マシンで稼働中
  - Gateway URL: `http://localhost:<port>`（エージェントのポートに合わせる）
  - Gateway Token: `openclaw.json` の `gateway.token` を確認
- ngrok アカウント（authtoken 設定済み）

---

## セットアップ手順

### 1. リポジトリのクローン

```bash
git clone https://github.com/caty-ai/meetmate.git
cd meetmate
npm install
```

**2台目以降のエージェント** は別ディレクトリにクローン:
```bash
git clone https://github.com/caty-ai/meetmate.git meetmate-<agent-name>
cd meetmate-<agent-name>
git checkout <安定版タグ>   # Releases の最新 stable タグを推奨
npm install
```

### 2. config.json（エージェント設定）

```bash
cp config.json.example config.json
```

**必ず編集する項目:**

```jsonc
{
  "agent": {
    "id": "luca",                    // エージェントID（小文字英数字）
    "name": "Luca",                  // 内部名（英語、ログやAPI識別に使用）
    "displayName": "ルカ",           // 表示名（日本語OK、Meet UIに表示）
    "greeting": "(happy) こんにちは！ルカです！",  // 参加時の挨拶（感情タグ付き）
    "emotionTags": true,             // TTS用の感情タグを有効化（推奨: true）
    "model": "openclaw",             // ← 必ず "openclaw"（Gatewayに任せる）
    "wakeWords": ["ルカ", "luca"],   // ウェイクワード（名前）
    "keyterms": ["ルカ", "Luca"],    // STT キーワードブースト用（Soniox context terms / Deepgram keyterm）
    "sttWakeVariants": [],           // キャリブレーション後に自動追記される
    // ... 口調・メッセージをエージェントに合わせて編集
  },
  "gateway": {
    "url": "${OPENCLAW_GATEWAY_URL}",   // .env から読む（トップレベル。agent配下ではない）
    "token": "${OPENCLAW_GATEWAY_TOKEN}", // .env から読む
    "warmupTimeoutMs": 8000              // デフォルト8秒。遅いモデル(Grok等)は30000推奨
  },
  "tts": {
    "provider": "fish-audio",        // .env の TTS_PROVIDER が優先（フォールバック用）
    "voiceId": "${FISH_AUDIO_VOICE_ID}"
  },
  "stt": {
    "apiKey": "${DEEPGRAM_API_KEY}"  // .env の DEEPGRAM_API_KEY が優先（フォールバック用）
  },
  "server": {
    "port": 5006,                    // ⚠️ 他エージェントと被らないポートにする
    "ngrokDomain": "your-domain.ngrok-free.dev"  // ngrok固定ドメイン
  }
}
```

> ⚠️ `model` は必ず `"openclaw"` にすること。モデル名（`anthropic/claude-opus-4-6` 等）を直接書いても Gateway に無視される。

> 💡 **`emotionTags`** を `true` にすると、LLM の応答に `(happy)`, `(calm)`, `(excited)` 等の感情タグが付き、TTS の表現力が上がる。`greeting` にも同じ形式でタグを付けると参加時の挨拶が自然になる。使えるタグ: `(calm)`, `(happy)`, `(curious)`, `(soft tone)`, `(excited)`, `(nervous)`, `(grateful)`, `(laughing)`, `(confident)`

> 💡 `tts` / `stt` セクションは `.env` 側が未設定の場合のフォールバック。通常は `.env` 側が優先される（`config.js` で `process.env.* || config値` の順で解決）。STT の既定プロバイダは Soniox（`SONIOX_API_KEY`）で、`stt.apiKey` の `DEEPGRAM_API_KEY` は Deepgram 切替時のフォールバック用。

### 3. .env（APIキー・シークレット）

```bash
cp .env.example .env
```

**必須項目:**
```bash
# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=http://localhost:19300    # エージェントのGatewayポート
OPENCLAW_GATEWAY_TOKEN=your_gateway_token_here

# STT（既定プロバイダ Soniox）
SONIOX_API_KEY=your_soniox_key
# STT_PROVIDER=deepgram に切り替える場合のみ必須
# DEEPGRAM_API_KEY=your_deepgram_key

# Meet/Zoom Bot
ATTENDEE_API_KEY=your_attendee_key

# TTS
FISH_AUDIO_API_KEY=your_fish_audio_key
FISH_AUDIO_VOICE_ID=your_voice_id

# ⚠️ 重要: 必ず fish-audio にすること（"openai" だとレガシーモードになる）
TTS_PROVIDER=fish-audio
```

> ⚠️ **`TTS_PROVIDER=fish-audio` は必須。** `openai` にすると Deepgram Voice Agent（レガシーモード）で起動し、パイプラインが全く別のルートに入る。

> 💡 **`FISH_AUDIO_VOICE_ID` の取得方法**: [fish.audio](https://fish.audio/) にログインし、使いたい声（自分で作成したクローンボイス or 公開ボイス）のページを開くと、URL が `https://fish.audio/m/<voice-id>/` の形になっている。この `<voice-id>` をコピーして設定する。

### 4. アバター画像

エージェントの顔となる画像を配置する。Google Meet の参加者アイコンに表示される。

```bash
# エージェント固有の画像をコピー
cp /path/to/your-agent-avatar.png assets/avatar.png
```

> ⚠️ **クローンしたリポジトリの `assets/avatar.png` は元エージェント（Caty等）の画像がそのまま残っている。** 必ず差し替えること。

- ファイル名は `avatar.png` 固定（コードがこの名前で参照する）
- **⚠️ 必ず PNG 形式であること**（JPEG を `.png` にリネームしただけでは Attendee API が `400 - Data is not a valid PNG image` で拒否する）
- 推奨サイズ: 256x256px の正方形 PNG
- 丸くクロップされて表示されるため、顔が中央にあるとベスト

**PNG 形式の確認・変換方法:**
```bash
# 形式を確認（"PNG image data" と出ればOK）
file assets/avatar.png

# JPEG等の場合はPNGに変換 + 256x256リサイズ（macOS）
sips -s format png -z 256 256 assets/avatar.png --out assets/avatar.png
```

### 5. ngrok トンネル（固定ドメイン取得 → 起動）

#### 5-1. 固定ドメインの取得（初回のみ）

Meet Bot が外部から WebSocket 接続を受けるために、公開 URL が必要。
ngrok の固定ドメイン（無料プランで1つ）を使うと、再起動してもURLが変わらない。

1. https://dashboard.ngrok.com にログイン
2. 左メニュー「**Domains**」→「**Create Domain**」
3. 自動生成されたドメイン（例: `pretty-duckling-abc123.ngrok-free.dev`）をコピー
4. `config.json` の `server.ngrokDomain` に記入

> 💡 **無料プランは1ドメインまで。** 2台目以降のエージェントには別の ngrok アカウントを作成するか、有料プラン（$8/月〜）で追加ドメインを取得する。
> 別の方法として Tailscale + VPS 構成なら ngrok 自体が不要（後述）。

#### 5-2. ngrok の起動

```bash
# 固定ドメインの場合（推奨）
ngrok http 5006 --domain=your-domain.ngrok-free.dev

# ランダムドメインの場合（テスト用）
ngrok http 5006
```

- ポート番号は `config.json` の `server.port` に合わせる

#### 5-3. 同一マシンで複数エージェントを動かす場合

ngrok の API ポートがデフォルト（4040）だと、**他エージェントの ngrok と衝突**する。
2台目以降は専用の ngrok config ファイルで API ポートをずらす:

```yaml
# ~/.config/ngrok/ngrok-<agent-name>.yml
version: 3
authtoken: YOUR_AUTHTOKEN
agent:
  web_addr: 127.0.0.1:4041  # デフォルト4040と被らないように
```

```bash
ngrok http 5006 --domain=your-domain.ngrok-free.dev --config ~/.config/ngrok/ngrok-<agent-name>.yml
```

> ⚠️ `config.json` の `server.ngrokDomain` を**必ず明示**すること。自動検出（ngrok API port 4040）は同一マシンの最初の ngrok しか検出しない。

#### 5-4. ngrok 不要な構成

一例として、サーバーと Attendee（self-host）が同じ Tailscale ネットワーク上にある構成なら ngrok なしで直接接続できる。Attendee 側の WebSocket URL を Tailscale IP ベース（例: `wss://<tailscale-ip>:5006`）に向ければ、トンネルなしで動作する。

#### 5-5. PWA インストール用の HTTPS

ブラウザの「ホーム画面に追加」やインストール UI を使うには、ダッシュボードを HTTPS で開く必要がある。Tailscale で使う場合は MagicDNS と HTTPS 証明書を有効化したうえで、Tailnet のホスト名を使ってローカルの UI に転送する。

```bash
tailscale cert <your-tailnet-hostname>
tailscale serve --https=443 http://127.0.0.1:5006
```

その後、ブラウザで `https://<your-tailnet-hostname>` を開く。ngrok の `https://your-domain.ngrok-free.dev` 形式のトンネルは最初から HTTPS なので、PWA インストール用の追加設定は不要。

### 6. 起動

```bash
npm start
# または
node src/server.js
```

起動ログ例:
```
[luca] Agent profile resolved: ルカ
🖼️  Bot avatar loaded (local): avatar.png
🌐  ngrok WSS URL (config.json): wss://your-domain.ngrok-free.dev
🚀  Meet Server started: http://localhost:5006
```

### 7. 動作確認

1. ブラウザで `http://localhost:5006` を開く
2. Google Meet URL を貼り付けて「参加させる」をクリック
3. Meet 側で参加リクエストを承認
4. 約30秒で Bot が参加 → 挨拶が流れれば成功 ✅

---

## LaunchAgent（macOS 自動起動）

常駐サービスとして登録する場合:

```bash
./scripts/install-launchagent.sh \
  --label ai.openclaw.meet-<agent-name> \
  --dir "$(pwd)" \
  --port 5006
```

### 環境変数の追加

LaunchAgent で `WAKE_CALIBRATE_ENABLED=1` など追加の環境変数が必要な場合は、生成された plist を直接編集:

```bash
vi ~/Library/LaunchAgents/ai.openclaw.meet-<agent-name>.plist
```

`<key>EnvironmentVariables</key>` の `<dict>` 内に追加:
```xml
<key>WAKE_CALIBRATE_ENABLED</key>
<string>1</string>
```

再読み込み:
```bash
launchctl bootout gui/$(id -u)/ai.openclaw.meet-<agent-name>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.meet-<agent-name>.plist
```

---

## ウェイクワードキャリブレーション

初期 `sttWakeVariants` が空の場合、STT の誤認識バリアントを検出できずウェイクワードが反応しないケースがある。

### キャリブレーション手順

1. `.env` に `WAKE_CALIBRATE_ENABLED=1` を追加（またはLaunchAgent plist に設定）
2. サーバー再起動
3. ブラウザで `http://localhost:<port>/calibrate` を開く
4. 「録音開始」→ エージェントの名前を様々な言い方で30秒間繰り返す
5. 検出されたバリアントを確認 →「設定に保存」
6. `config.json` の `sttWakeVariants` に自動書き込みされる
7. 完了後 `WAKE_CALIBRATE_ENABLED` を削除してもOK（セキュリティ上推奨）

> 💡 環境（マイク・部屋）が変わった場合は再キャリブレーションすると精度が上がる。

---

## Slack 連携（任意）

会議のステータス・サマリー・全文ログを Slack に自動投稿できます。
デフォルトは **DM モード**（Bot → ユーザーへの DM）です。

### DM モード（推奨）

```jsonc
// config.json
"slack": {
  "botToken": "${SLACK_BOT_TOKEN}",
  "notifications": {
    "target": "dm",           // "dm" = DMに投稿（デフォルト）
    "dmUserId": "U0XXXXXXXXX" // 通知先の Slack User ID
  }
}
```

```bash
# .env
SLACK_BOT_TOKEN=xoxb-xxxxx
```

> **dmUserId の確認方法**: Slack でユーザーのプロフィールを開き「メンバーIDをコピー」

### チャンネルモード（大規模チーム向け）

```jsonc
// config.json
"slack": {
  "botToken": "${SLACK_BOT_TOKEN}",
  "notifications": {
    "target": "channel"       // "channel" = チャンネルに投稿
  },
  "statusChannel": "C0XXXXXXXXX",
  "summaryChannel": "C0XXXXXXXXX"
}
```

```bash
# .env（環境変数でも設定可能）
SLACK_BOT_TOKEN=xoxb-xxxxx
SLACK_STATUS_CHANNEL=C0XXXXXXXXX    # ステータス通知（参加/退出）
SLACK_SUMMARY_CHANNEL=C0XXXXXXXXX   # 会議サマリー + 全文ログ
```

---

## トラブルシューティング

### Bot が Meet に参加しない
- Meet URL が `https://meet.google.com/xxx-xxxx-xxx` 形式か確認
- Meet 側で「参加をリクエストしています」通知を承認
- `ATTENDEE_API_KEY` が正しいか確認
- ngrok が起動しているか確認

### Bot は参加するが音声応答しない
- **TTS_PROVIDER を確認** — `fish-audio` でないとパイプラインが動かない
- Fish Audio API キー・Voice ID が正しいか確認
- サーバーログに `🐟 Fish Audio パイプラインモード` が表示されているか確認
  - `🔊 Deepgram Voice Agent モード` が出ていたら TTS_PROVIDER が間違っている

### Gateway warm-up がタイムアウトする
- Gateway が起動しているか確認: `curl http://localhost:<port>/v1/models`
- モデルの初回応答が遅い場合（Grok等: ~18秒）は `config.json` の `gateway.warmupTimeoutMs` を延長（デフォルト8000ms、遅いモデルは30000ms推奨）
- Gateway Token が正しいか確認

### ウェイクワードに反応しない
- `config.json` の `wakeWords` にエージェント名が入っているか確認
- `sttWakeVariants` が空の場合、キャリブレーションを実行
- ログの `🔔 Pending wake word found` / `🔇 [会議音声・未指名]` で判別

### ngrok URL が別エージェントのものになる
- `config.json` の `server.ngrokDomain` を明示的に設定する
- 自動検出（ngrok API port 4040）は同一マシンの最初の ngrok のみ検出する

### アバターが違うエージェントの画像
- `assets/avatar.png` がクローン元のまま → エージェント固有の画像に差し替え

### Meet の会話がメインの Slack チャットに混入する
- OpenClaw の LCM 設定が必要。エージェントの `openclaw.json` → `plugins.entries.lossless-claw.config` に以下を追加:
  ```json
  {
    "statelessSessionPatterns": ["meet-*"],
    "ignoreSessionPatterns": ["cron-*", "heartbeat-*"]
  }
  ```
- 設定後 `openclaw gateway restart` で反映
- `statelessSessionPatterns: ["meet-*"]` により Meet セッションは LCM に保存されるがメインコンテキストに積み重ならない

---

## アーキテクチャ概要

```
STT(Soniox stt-rt-v5 既定 / Deepgram 切替可) → ウェイクワード検出 → OpenClaw Gateway(LLM) → TTS(Fish Audio) → Meet/Zoom
```

詳細は `docs/architecture.md` を参照。
