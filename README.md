# 🎙️ AI Meet Participant — Multi-Agent Voice System

AIエージェント（Caty, Claire, Sebas, Alec, Zoe, Eidra）がGoogle Meet / Zoom にリアルタイム参加して音声対話。
Twilio経由の電話発信にも対応。OpenClaw Gateway 連携により、Slack と **まったく同じ体験** を音声で提供。

## プロジェクト状況

| Phase | 内容 | ステータス |
|-------|------|-----------|
| v1 | Google Meet 音声対話（MVP） | ✅ 完了 |
| v2 Phase 1 | Twilio 電話発信 | ✅ 完了 |
| v2 Phase 2 | Slack UI + 通話サマリー | ✅ 完了 |
| v2 UX | Barge-in + タイムアウト + Warm-up + 統合サーバー | ✅ 完了 |
| v2 Zoom | Zoom Meeting 対応 + Web UI 改善 | ✅ 完了 |
| v2 Phase 3 | マルチエージェント対応 + 独立インスタンス | ✅ 完了 (2026-03-01) |
| v2 Phase 4 | 着信対応 + IVR | 📋 計画中 |

## デプロイ構成（本番）

### ハイブリッドアーキテクチャ

Mac mini（4エージェント共有）+ MacBook Pro（2エージェント独立）の2台構成。

```
┌─ Mac mini ─────────────────────────────────────────────┐
│                                                         │
│  your-domain.ngrok.app → localhost:5005                        │
│  ┌───────────────────────────────────────────────┐     │
│  │ Unified Server (server.js)                     │     │
│  │                                                │     │
│  │ デフォルト: ケイティ                              │     │
│  │ ウェイクワード切替: アレク / ゾーイ / アイドラ       │     │
│  │                                                │     │
│  │ STT(Deepgram) → LLM(各Gateway) → TTS(Fish)    │     │
│  │                                                │     │
│  │ + Twilio 電話ブリッジ（全エージェント共有）        │     │
│  └───────────────────────────────────────────────┘     │
│                                                         │
│  Gateway: Caty(:18789) Alec(:19009)                     │
│           Zoe(:19100)  Eidra(:19200)                    │
└─────────────────────────────────────────────────────────┘

┌─ MacBook Pro ──────────────────────────────────────────┐
│                                                         │
│  your-domain.ngrok.dev → localhost:5005                      │
│  ┌─────────────────────────────────────┐               │
│  │ Server (AGENT_ID=claire)             │               │
│  │ クレア専用 / Meet-only               │               │
│  └─────────────────────────────────────┘               │
│                                                         │
│  your-domain.ngrok.dev → localhost:5006                       │
│  ┌─────────────────────────────────────┐               │
│  │ Server (AGENT_ID=sebas)              │               │
│  │ セバス専用 / Meet-only               │               │
│  └─────────────────────────────────────┘               │
│                                                         │
│  Gateway: Claire(:18789)  Sebas(:19011)                 │
└─────────────────────────────────────────────────────────┘
```

### ngrok ドメイン（Hobby プラン）

| ドメイン | マシン | ポート | エージェント | モード |
|---------|--------|-------|------------|--------|
| `your-domain.ngrok.app` | Mac mini | 5005 | ケイティ（+ アレク/ゾーイ/アイドラ切替） | マルチエージェント |
| `your-domain.ngrok.dev` | MacBook Pro | 5005 | クレア | 単体（`AGENT_ID=claire`） |
| `your-domain.ngrok.dev` | MacBook Pro | 5006 | セバス | 単体（`AGENT_ID=sebas`） |

### エージェント一覧

| ID | 名前 | Gateway | 声 (Fish Audio) | Attendee | マシン |
|----|------|---------|-----------------|----------|--------|
| `caty` | ケイティ | `:18789` | `5161d41...` | Caty project | Mac mini |
| `alec` | アレク | `:19009` | `28f33b8...` | Alec project | Mac mini |
| `zoe` | ゾーイ | `:19100` | `49e17e2...` | Zoe project | Mac mini |
| `eidra` | アイドラ | `:19200` | `ba90f1a...` | Eidra project | Mac mini |
| `claire` | クレア | `:18789` | `0089dce...` | Claire project | MacBook Pro |
| `sebas` | セバス | `:19011` | `9b2e47c...` | Sebas project | MacBook Pro |

## 2つの動作モード

### マルチエージェントモード（Mac mini）

1つのサーバーで複数エージェントを切り替え。ウェイクワードで呼び分け。

- Web UI でエージェントを選択（1:1=ドロップダウン、グループ=チェックボックス）
- STT は1本共有、ウェイクワードでルーティング先を切替
- セッションIDはエージェント別: `meet-{sessionId}-{agentId}`
- 各エージェントの Gateway に個別接続 → 会話履歴は混ざらない
- Twilio 電話ブリッジも同じサーバーで動作

```bash
# マルチエージェントモード（AGENT_ID 未設定）
PORT=5005 npm start
```

### 単体エージェントモード（MacBook Pro）

`AGENT_ID` 環境変数でサーバーを特定のエージェント専用にする。

- Web UI にエージェント選択は表示されない
- `/agents` API はそのエージェントのみ返す
- Twilio 未設定時は自動で Meet-only モードになる

```bash
# クレア専用インスタンス
AGENT_ID=claire PORT=5005 node src/server.js

# セバス専用インスタンス
AGENT_ID=sebas PORT=5006 node src/server.js
```

## セットアップ

### 前提条件

| サービス | 用途 | 必須 |
|---------|------|------|
| [Deepgram](https://console.deepgram.com/) | STT（音声認識） | ✅ |
| [Attendee](https://app.attendee.dev/) | Meet/Zoom Bot | ✅ |
| [Fish Audio](https://fish.audio/) | TTS（音声合成） | ✅ |
| [ngrok](https://ngrok.com/) (Hobby) | WebSocket 外部公開 | ✅ |
| OpenClaw Gateway | フルエージェント体験 | ✅ |
| [Twilio](https://www.twilio.com/) | 電話発信 | △ (電話用) |
| [OpenRouter](https://openrouter.ai/) | LLM フォールバック | △ |

### Mac mini セットアップ（メイン）

```bash
# 1. リポジトリ
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install

# 2. 環境変数
cp .env.example .env
# .env を編集（全エージェントの Gateway トークン + Attendee APIキーを設定）

# 3. Gateway 設定（全エージェント）
# 各エージェントの OpenClaw config で chatCompletions を有効化：
#   gateway.http.endpoints.chatCompletions.enabled: true
# → Caty, Alec, Zoe, Eidra の Gateway を再起動

# 4. ngrok 起動
ngrok http 5005 --domain=your-domain.ngrok.app

# 5. サーバー起動
npm start
```

### MacBook Pro セットアップ（Claire / Sebas）

```bash
# 1. リポジトリ
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install

# 2. 環境変数（エージェントごとに .env ファイルを作成）
# .env.claire — AGENT_ID=claire, PORT=5005, Claire の Gateway/Attendee 設定
# .env.sebas  — AGENT_ID=sebas, PORT=5006, Sebas の Gateway/Attendee 設定
# 注意: Twilio 設定は不要（Meet-only モードで起動）

# 3. Gateway 設定
# Claire/Sebas の OpenClaw config で chatCompletions を有効化：
#   gateway.http.endpoints.chatCompletions.enabled: true

# 4. ngrok 起動（2本）
ngrok http 5005 --domain=your-domain.ngrok.dev &
ngrok http 5006 --domain=your-domain.ngrok.dev &

# 5. サーバー起動
cp .env.claire .env && AGENT_ID=claire PORT=5005 node src/server.js &
cp .env.sebas .env && AGENT_ID=sebas PORT=5006 node src/server.js &
```

### Gateway chatCompletions 有効化（必須）

各エージェントの OpenClaw Gateway で HTTP Chat Completions API を有効にする必要がある。

```json
// ~/.openclaw/openclaw.json (or ~/.openclaw-<agent>/openclaw.json)
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

設定後、Gateway を再起動:
```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

## agents.json

エージェント定義ファイル。プロジェクトルートに配置。

```json
{
  "caty": {
    "name": "Caty",
    "displayName": "ケイティ",
    "gatewayUrl": "http://localhost:18789",
    "gatewayToken": "${OPENCLAW_GATEWAY_TOKEN}",
    "attendeeApiKey": "${ATTENDEE_API_KEY}",
    "voiceId": "your-fish-audio-voice-id",
    "wakeWords": ["ケイティ", "けいてぃ", "caty", "katie"],
    "keyterms": ["ケイティ", "けいてぃ", "Caty", "Katie"],
    "greeting": "(happy) こんにちは！ケイティです。",
    "model": "anthropic/claude-sonnet-4-6",
    "default": true,
    "openclawSystemAddendum": null
  }
}
```

| フィールド | 説明 |
|-----------|------|
| `gatewayUrl` | OpenClaw Gateway の URL |
| `gatewayToken` | `${ENV_VAR}` 構文 → 環境変数から自動解決 |
| `attendeeApiKey` | `${ENV_VAR}` 構文 → Attendee API キー |
| `voiceId` | Fish Audio の声モデル ID |
| `wakeWords` | ウェイクワード（マルチエージェント時の呼び分け） |
| `keyterms` | Deepgram STT のキーターム（認識精度向上） |
| `greeting` | ミーティング参加時の挨拶 |
| `default` | デフォルトエージェント（挨拶担当） |
| `openclawSystemAddendum` | エージェント固有の音声ルール上書き（null=共通） |

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET /` | Web UI | Meet URL 入力画面 |
| `GET /agents` | エージェント一覧 | 利用可能エージェント（トークンは含まない） |
| `GET /active-session` | セッション状態 | アクティブなミーティングセッション |
| `POST /join-meeting` | Meet参加 | ボット起動（`agentIds` パラメータ対応） |
| `POST /leave-meeting` | Meet退出 | ボット強制退出 |
| `GET /health` | ヘルスチェック | Twilio ブリッジ状態 |
| `POST /call-me` | 電話発信 | Twilio 経由で発信 |
| `WS /?sid=xxx` | Meet音声 | Attendee Bot 音声ストリーム |
| `WS /twilio/stream/<token>` | Twilio音声 | Twilio 音声ストリーム |

## ファイル構成

```
meetmate/
├── agents.json                # エージェント定義（Gateway/声/ウェイクワード）
├── src/
│   ├── server.js              # 統合エントリポイント（Meet + Twilio）
│   ├── config.js              # 設定管理 + エージェントレジストリ
│   ├── pipeline.js            # STT → LLM → TTS パイプライン（マルチエージェント対応）
│   ├── stt.js                 # Deepgram Nova 3 STT（keyterm prompting）
│   ├── llm.js                 # LLM（OpenClaw Gateway / OpenRouter）
│   ├── tts-fish.js            # Fish Audio TTS
│   ├── gateway-warmup.js      # セッション事前ウォームアップ（マルチ対応）
│   ├── session-events.js      # セッションライフサイクル
│   ├── slack-notifier.js      # Slack 通知
│   ├── summarizer.js          # 会話サマリー生成
│   ├── transport-meet/
│   │   └── meet-routes.js     # Meet HTTP/WS（AGENT_ID対応 + /agents API）
│   ├── transport-twilio/
│   │   ├── twilio-routes.js   # Twilio HTTP/WS（グレースフルデグレ対応）
│   │   ├── call-manager.js    # 発信管理
│   │   └── twilio-adapter.js  # μ-law ↔ PCM
│   └── prompts/
│       └── caty-system.md     # 音声用システムプロンプト
├── public/
│   └── index.html             # Web UI（エージェント選択対応）
├── start-claire.sh            # Claire 起動スクリプト（MacBook Pro用）
├── start-sebas.sh             # Sebas 起動スクリプト（MacBook Pro用）
├── .env.claire                # Claire 用環境変数（MacBook Pro用）
├── .env.sebas                 # Sebas 用環境変数（MacBook Pro用）
├── docs/                      # 設計ドキュメント
└── logs/                      # 会話ログ（自動生成）
```

## 感情表現（Fish Audio）

動作確認済み9タグ:

| タグ | 意味 | 使用頻度 |
|------|------|---------|
| `(calm)` | 穏やか | 33% |
| `(happy)` | 嬉しい | 27% |
| `(curious)` | 好奇心 | 16% |
| `(soft tone)` | やわらかい | 10% |
| `(excited)` | 興奮 | 8% |
| `(nervous)` | 緊張 | 3% |
| `(grateful)` | 感謝 | 2% |
| `(laughing)` | 笑い | <1% |
| `(confident)` | 自信 | <1% |

## トラブルシューティング

### Gateway 405 エラー

```
❌ Pipeline error: OpenClaw Gateway error (405): Method Not Allowed
```

→ `chatCompletions` が有効化されていない。上記「Gateway chatCompletions 有効化」を参照。

### Twilio 未設定時

```
📞 Twilio bridge disabled (missing credentials). Meet-only mode.
```

→ 正常動作。Meet 機能は使える。電話が必要なら Twilio 環境変数を設定。

### エージェントが `/agents` に表示されない

```
⚠️ Agent "alec" skipped: gateway token not available
```

→ `.env` に該当エージェントの `XXXX_GATEWAY_TOKEN` が設定されていない。

### MacBook Pro の Gateway に接続できない

ClaireとSebasのGatewayは `bind=loopback` のため、ローカルマシン以外からアクセス不可。
独立インスタンスモードでは同じマシン上で動作するため問題なし。

## ライセンス

Private — shojikumaru
