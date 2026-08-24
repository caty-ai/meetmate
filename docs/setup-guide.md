# セットアップガイド — Meetmate

> **1エージェント = 1サーバーインスタンス。**
> `config.json` + `.env` + `assets/avatar.png` の3点で任意のエージェントが動作する。

---

## 事前準備

### 必要なアカウント・APIキー

| サービス | 取得先 | 用途 | 設定名 | 必須度 | 費用メモ |
|---------|--------|------|--------|--------|---------|
| OpenClaw Gateway | 同一マシンで稼働 | 既定 LLM（SOUL/memory/tools/skills連携） | `LLM_PROVIDER=openclaw`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN` | 条件付き（既定） | 自前運用前提 |
| OpenAI互換 LLM / Gateway | 利用する endpoint に応じる | `openai-compatible` 時の voice brain | `LLM_PROVIDER=openai-compatible`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `llm.model` | 条件付き | 利用先ごとに異なる |
| Soniox | https://console.soniox.com/ | STT（音声認識・既定プロバイダ） | `STT_PROVIDER=soniox`, `SONIOX_API_KEY` | ✅ | 現在の free / paid は公式で確認 |
| Deepgram | https://console.deepgram.com/signup | STT（`deepgram` 切替時のみ） | `STT_PROVIDER=deepgram`, `DEEPGRAM_API_KEY` | 任意 | 現在の free / paid は公式で確認 |
| Attendee | https://app.attendee.dev/accounts/signup/ | Google Meet / Zoom Bot | `ATTENDEE_API_KEY` | ✅ | 現在の free / paid は公式で確認 |
| Fish Audio | https://fish.audio/ | TTS（音声合成） | `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID`, `TTS_PROVIDER=fish-audio` | ✅ | 現在の free / paid は公式で確認 |
| ngrok | https://ngrok.com/ | WebSocket トンネル（外部接続用） | `server.ngrokDomain` | 条件付き（一般的な構成） | 無料/有料とも内容は変わりうる |
| Tailscale | https://tailscale.com/ | ngrok代替の到達経路（self-hosted Attendee 等） | ネットワーク構成側の設定 | 任意 | 無料/有料とも内容は変わりうる |
| Zoom Marketplace | https://marketplace.zoom.us/ | Zoom Bot 権限・アプリ管理 | Zoom / Attendee 側アプリ設定 | 条件付き | プラン/権限要件は運用形態次第 |
| Slack Bot | https://api.slack.com/apps | ステータス通知・サマリー投稿 | `SLACK_BOT_TOKEN` | 任意 | Slack 側プラン条件を確認 |

> ⚠️ API key / token / Bearer / bot token はすべて秘密情報。`.env` の外に出さないこと。Git に commit しないこと。画面共有、ログ共有、Issue、スクリーンショットにも貼らないこと。
> ⚠️ tool 実行まで許可する OpenAI互換 gateway を使う場合も、その endpoint は **信頼できるローカル gateway** に限定すること。外部・不特定・未信頼 meeting では使わないこと。

### 前提条件

- Node.js v26+（`package.json` の `engines` 準拠）
- 既定の `openclaw` プロバイダでは OpenClaw Gateway が同一マシンで稼働中
  - Gateway URL: `http://localhost:<port>`（エージェントのポートに合わせる）
  - Gateway Token: `openclaw.json` の `gateway.token` を確認
- `LLM_PROVIDER=openai-compatible` を使う場合は OpenClaw Gateway 不要
- ngrok アカウント（authtoken 設定済み）

### 会議プラットフォームの前提

- **Google Meet**: まずはこれを基本経路にする。Bot 参加時に Meet 側の **「参加をリクエストしています」承認** が必要。
- **Zoom**: 現時点では **自分が主催・管理できる会議** を前提にする。外部主催 Zoom、OBF、managed OAuth を「対応済み」とは扱わない。
- **Zoom Marketplace**: Zoom 経路を使うなら、Attendee/運用側で必要な Marketplace 設定と権限付与が済んでいることを確認する。

---

## セットアップ手順（npm・推奨）

空のフォルダで3コマンド:

```bash
npm install meetmate
npx meetmate init     # ウィザードが API キー・ボイスID・LLM エンドポイントを対話で収集し、config.json / .env / AGENTS.md を生成
npx meetmate start    # サーバー起動。設定 UI の URL が表示される
```

- `init` は各キーの**取得先のヒントを1行ずつ表示**する。LLM は `openclaw` / `openai-compatible` のどちらかを選ぶと、必要な項目だけ聞かれる
- `JOIN_SHARED_TOKEN` / `WS_SHARED_TOKEN` は**自動生成**される（入力不要）
- 既にあるファイルは上書きされない（`--force` で作り直し。途中で中断しても再実行すれば足りないファイルだけ作られる）
- **手動のまま残る手順**: ngrok / Tailscale のトンネル（→ [5. ngrok トンネル](#5-ngrok-トンネル固定ドメイン取得--起動)）と、Meet 側の参加承認（→ [会議プラットフォームの前提](#会議プラットフォームの前提)）

2台目以降のエージェントは**別の空フォルダ**で同じ3コマンドを実行する（1エージェント = 1フォルダ = 1ポート）。

設定を細かく調整したい場合は、以下のリファレンス（config.json / .env の全項目）へ。

---

## 手動セットアップ・設定リファレンス（コントリビュータ向け）

### 1. リポジトリのクローン（from source — コントリビュータ向け）

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
    "wakeWords": ["ルカ", "luca"],   // ウェイクワード（名前）
    "keyterms": ["ルカ", "Luca"],    // STT キーワードブースト用（Soniox context terms / Deepgram keyterm）
    "sttWakeVariants": [],           // キャリブレーション後に自動追記される
    // ... 口調・メッセージをエージェントに合わせて編集
  },
  "llm": {
    "provider": "openclaw",         // 既定。代替は "openai-compatible"
    "model": "openclaw"             // OpenClaw では Gateway に任せる
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

> ⚠️ 既定の OpenClaw 構成では `llm.model` を `"openclaw"` にすること。`openai-compatible` ではプロキシ側のモデル ID を指定する。

> 💡 **`emotionTags`** を `true` にすると、LLM の応答に `(happy)`, `(calm)`, `(excited)` 等の感情タグが付き、TTS の表現力が上がる。`greeting` にも同じ形式でタグを付けると参加時の挨拶が自然になる。使えるタグ: `(calm)`, `(happy)`, `(curious)`, `(soft tone)`, `(excited)`, `(nervous)`, `(grateful)`, `(laughing)`, `(confident)`

> 💡 `tts` / `stt` セクションは `.env` 側が未設定の場合のフォールバック。通常は `.env` 側が優先される（`config.js` で `process.env.* || config値` の順で解決）。STT の既定プロバイダは Soniox（`SONIOX_API_KEY`）で、`stt.apiKey` の `DEEPGRAM_API_KEY` は Deepgram 切替時のフォールバック用。

### 3. .env（APIキー・シークレット）

```bash
cp .env.example .env
```

**必須項目（既定の OpenClaw 構成）:**
```bash
# OpenClaw Gateway
LLM_PROVIDER=openclaw
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

`LLM_PROVIDER=openai-compatible` の場合は `OPENAI_COMPATIBLE_BASE_URL` と `OPENAI_COMPATIBLE_API_KEY` を**追加**する。`config.json` の `${...}` プレースホルダは未解決（未設定・空欄）だと起動時にエラー終了するため、使わない機能の env（`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `SLACK_BOT_TOKEN` 等）も**削除・空欄にせずダミー値のまま残す**。残したくない場合は `config.json` から該当ブロックごと削除する。

> ⚠️ `.env` は実運用シークレットの置き場所。Git に commit しないこと。画面共有・ログ貼り付け・スクリーンショットにも token / API key / Bearer を含めないこと。

**OpenAI 互換で動かす最小構成**

```bash
LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:4000
OPENAI_COMPATIBLE_API_KEY=your_api_key
```

```json
"llm": { "provider": "openai-compatible", "model": "your-proxy-model-id" }
```

gateway の env 2行はダミーのまま残す（上記参照）。

**状態を持つ OpenAI互換 gateway（例: Claude Code bridge / resident agent gateway）**

同一 turn の自動再送が危険な gateway では、Meetmate 側のローカル履歴と空応答 retry を止める。

```bash
LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:4000
OPENAI_COMPATIBLE_API_KEY=your_gateway_bearer
LLM_RESPONSE_TIMEOUT_MS=60000
```

```json
{
  "llm": {
    "provider": "openai-compatible",
    "model": "your-gateway-model-id",
    "historyMaxTurns": 0,
    "openaiCompatible": {
      "baseUrl": "http://localhost:4000",
      "apiKey": "${OPENAI_COMPATIBLE_API_KEY}",
      "emptyResponseRetry": false,
      "trustedAgentTools": true
    }
  }
}
```

- `historyMaxTurns: 0` にすると、Meetmate は過去 turn を再送せず、現在の user turn だけを upstream に送る
- `emptyResponseRetry: false` にすると、空 SSE 1回 retry を止める。tool 実行済み turn の二重投入を避けたい gateway で使う
- `trustedAgentTools: true` にすると、Meetmate は `X-Caty-Agent-Trust: trusted` を送る。これは **信頼できるローカル tool-capable gateway** と **信頼できる meeting** の組み合わせでだけ使う
- `LLM_RESPONSE_TIMEOUT_MS` は upstream gateway の deadline より短くしすぎないこと。Claude/tool turn を使うなら 60 秒前後から始めるのが安全
- これは **既存の `openai-compatible` provider の設定**。Claude 専用 provider を追加するわけではない
- 外部主催 meeting、不特定参加者 meeting、未信頼 gateway では `trustedAgentTools` を有効にしないこと

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

### 7. 動作確認（画面つきウォークスルー）

1. ブラウザで `http://localhost:5006`（設定したポート）を開く。起動直後はこの画面。参加ボタンは会議情報を入れるまで無効のまま:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-ui-idle.png" alt="起動直後の設定画面。上に会議情報の貼り付け欄と無効状態の参加ボタン、右にセッション指標" width="100%">

2. 会議情報を貼り付ける。Meet / Zoom の URL 単体でもよいし、**Google カレンダーの招待文をまるごと貼っても URL だけ自動抽出される**。抽出に成功すると緑の「検出済み: <URL>」が出て、参加ボタンが有効になる:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-ui-invite-pasted.png" alt="招待文をまるごと貼り付けた状態。検出済みの緑表示と有効化された参加ボタン" width="100%">

3. 「Meet に参加させる」をクリックした瞬間に通話中カードが現れる。タイマーはクリック時点から回り始め、WS 接続状態とエージェント名もこの時点から表示される。状態表示は **🔄 起動中…** から始まり、Bot が Meet の入室許可を待っている間は **WS 未接続** のまま。入室が許可されると **WS 接続 OK** に変わる:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-ui-joining.png" alt="通話中カード。参加直後からタイマー・WS 状態・エージェント名が表示され、入室後に WS 接続 OK へ変わる" width="100%">

4. Meet 側に「〜が参加をリクエストしています」のダイアログが出るので**承認する**（ここだけは人間の手作業。アプリ側からは代行できない）:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/meet-ask-to-join.png" alt="Google Meet の参加リクエスト承認ダイアログ" width="480">

5. 約30秒で Bot が参加 → 挨拶が流れれば成功 ✅ あとはウェイクワードで呼びかければ応答する。

---

## LaunchAgent（macOS 自動起動）

常駐サービスとして登録する場合:

```bash
./scripts/install-launchagent.sh \
  --label ai-meet.<agent-name> \
  --dir "$(pwd)" \
  --port 5006
```

### 環境変数の追加

LaunchAgent で `WAKE_CALIBRATE_ENABLED=1` など追加の環境変数が必要な場合は、生成された plist を直接編集:

```bash
vi ~/Library/LaunchAgents/ai-meet.<agent-name>.plist
```

`<key>EnvironmentVariables</key>` の `<dict>` 内に追加:
```xml
<key>WAKE_CALIBRATE_ENABLED</key>
<string>1</string>
```

再読み込み:
```bash
launchctl bootout gui/$(id -u)/ai-meet.<agent-name>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-meet.<agent-name>.plist
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

### 起動時に `config.json has unresolved environment variables` で終了する
- `config.json` の `${...}` プレースホルダに対応する env が未設定・空欄。`.env` にダミー値を入れる（例: `SLACK_BOT_TOKEN=your_slack_bot_token`）か、使わない機能のブロックを `config.json` から削除する

### Gateway warm-up がタイムアウトする
- openai-compatible では join 時に Gateway warm-up エラーがログに出る既知問題あり（無害・修正は #140）。
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
STT(Soniox stt-rt-v5 既定 / Deepgram 切替可) → ウェイクワード検出 → LLM(OpenClaw Gateway 既定) → TTS(Fish Audio) → Meet/Zoom
```

詳細は `docs/architecture.md` を参照。
