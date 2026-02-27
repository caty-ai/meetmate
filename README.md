# 🐱 AI Meet Participant — Caty Voice

AIアシスタント「Caty（ケイティ）」がGoogle Meetにリアルタイム参加して音声で対話するアプリ。
OpenClaw Gateway 連携により、Slack の Caty と **まったく同じ体験** を音声で提供。

## アーキテクチャ

```
Google Meet ←→ Attendee Bot (hosted)
                    ↕ WebSocket (PCM audio)
              Bridge Server (Node.js, port 5005)
              ├── Deepgram STT (Nova 3) — 音声認識
              ├── OpenClaw Gateway — LLM + ツール + メモリ
              └── Fish Audio TTS (S1) — 音声合成 + 感情表現
```

### OpenClaw Gateway 連携

Bridge Server は OpenClaw Gateway (`/v1/chat/completions`) を通じて LLM を呼び出す。
これにより Meet の Caty は Slack の Caty と **同一のエージェント**:

| 機能 | 説明 |
|------|------|
| 人格 | SOUL.md / AGENTS.md がそのまま適用 |
| 記憶 | memory_search で過去の会話を想起 |
| スキル | Slack連携、Web検索、GitHub操作、カレンダー、Todoist 等 |
| セッション管理 | OpenClaw が会話履歴を自動管理 |

Gateway 未設定時は OpenRouter（直接 Claude API）にフォールバック。

## 機能一覧

- 🎙️ リアルタイム音声対話（日本語 / 英語）
- 🐟 Fish Audio S1 による自然な日本語音声合成
- 🎭 感情タグ対応（(happy), (nervous), (excited) 等 64種類以上）
- 🔗 OpenClaw Gateway 連携（SOUL.md + memory + 全スキル・ツール）
- 🔔 ウェイクワード検出（名前呼びで反応、ミーティング中の選択的応答）
- 🖼️ Caty アバター表示（Slack アイコンを自動使用）
- 🛡️ エコーループ防止 + 割り込み対応
- 📝 会話ログ自動保存 (`logs/` + `memory/`)
- 🔄 OpenRouter フォールバック（Gateway 未設定時）

## クイックスタート

### 必要なもの

| サービス | 用途 | 必須 |
|---------|------|------|
| [Deepgram](https://console.deepgram.com/) | STT（音声認識） | ✅ |
| [Attendee](https://app.attendee.dev/) | Google Meet Bot | ✅ |
| [Fish Audio](https://fish.audio/) | TTS（音声合成） | ✅ |
| [ngrok](https://ngrok.com/) | WebSocket 外部公開 | ✅ |
| OpenClaw Gateway | フル Caty 体験 | 推奨 |
| [OpenRouter](https://openrouter.ai/) | LLM フォールバック | △ |

### 1. セットアップ

```bash
git clone https://github.com/caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env
# .env を編集して各 API キーを設定
```

### 2. ngrok トンネル起動

```bash
ngrok http 5005
```

### 3. サーバー起動

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

### 4. Meet に参加

1. ブラウザで `http://localhost:5005` を開く
   - Tailscale 経由: `http://<tailscale-ip>:5005`
2. Google Meet URL を貼り付け
3. 「🚀 Meetに参加させる」をクリック
4. 約30秒で Caty が Meet に参加して挨拶

## 環境変数

### 必須

| 変数 | 説明 |
|------|------|
| `DEEPGRAM_API_KEY` | Deepgram STT API キー |
| `ATTENDEE_API_KEY` | Attendee Bot API キー |
| `FISH_AUDIO_API_KEY` | Fish Audio TTS API キー |

### OpenClaw Gateway（推奨）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `OPENCLAW_GATEWAY_URL` | Gateway URL | `http://localhost:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 認証トークン | — |

設定すると OpenClaw 経由でフル Caty 体験（SOUL.md + memory + ツール）が有効に。
未設定時は OpenRouter（直接 Claude API）にフォールバック。

### LLM フォールバック

| 変数 | 説明 |
|------|------|
| `OPENROUTER_API_KEY` | OpenRouter API キー（Gateway 未設定時に使用） |

### TTS

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `TTS_PROVIDER` | `fish-audio` / `deepgram-agent` | `fish-audio` |
| `FISH_AUDIO_VOICE_ID` | Fish Audio 声モデル ID | — |
| `FISH_AUDIO_LATENCY` | `normal`（高品質） / `balanced`（低遅延） | `balanced` |

### 音声チューニング

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `SENTENCE_PAUSE_MS` | 文間の無音（ms） | `500` |
| `LISTEN_ENDPOINTING_MS` | 発話終了判定（ms） | `700` |
| `LISTEN_UTTERANCE_END_MS` | 発話区切り判定（ms） | `1800` |
| `AGENT_TEMPERATURE` | LLM の創造性 | `0.5` |
| `AGENT_MAX_TOKENS` | LLM 最大トークン数 | `300` |

### ウェイクワード

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `WAKE_MODE` | `off`（全発話に応答） / `wake`（名前呼び応答） | `off` |
| `WAKE_WORDS` | ウェイクワード（カンマ区切り） | `ケイティ,けいてぃ,caty,katie,ケイケイ` |

### セキュリティ

| 変数 | 説明 |
|------|------|
| `JOIN_SHARED_TOKEN` | `/join-meeting` 認証トークン |
| `WS_SHARED_TOKEN` | WebSocket 認証トークン |

## ファイル構成

```
meetmate/
├── src/
│   ├── index.js          # HTTP サーバー + WebSocket + セッション管理
│   ├── config.js         # 設定管理（環境変数読み込み）
│   ├── pipeline.js       # オーケストレーター（STT → LLM → TTS）
│   ├── stt.js            # Deepgram Nova 3 ストリーミング STT
│   ├── llm.js            # LLM（OpenClaw Gateway / OpenRouter デュアル）
│   ├── tts-fish.js       # Fish Audio REST TTS（PCM ストリーミング）
│   └── prompts/
│       └── caty-system.md  # 音声用システムプロンプト（フォールバック用）
├── public/
│   └── index.html        # Web UI（Meet URL 入力画面）
├── assets/
│   └── caty-avatar.png   # Caty アバター（自動ダウンロード/キャッシュ）
├── logs/                 # 会話ログ（自動生成）
├── docs/
│   ├── architecture.md   # 詳細アーキテクチャ
│   ├── setup-guide.md    # セットアップ手順書
│   └── phase2-openclaw-gateway-integration.md  # Gateway 連携仕様
├── .env.example          # 環境変数テンプレート
├── package.json
└── README.md
```

## 感情表現

Fish Audio S1 の感情タグにより、Caty は文脈に応じて声のトーンを変化:

| タグ | 表現 |
|------|------|
| `(happy)` | 嬉しい — 明るいトーン |
| `(nervous)` | 緊張 — 控えめなトーン |
| `(excited)` | 興奮 — テンション高め |
| `(empathetic)` | 共感 — 優しいトーン |
| `(laughing)` | 笑い声 |
| `(whispering)` | ささやき |

OpenClaw の VOICE_SYSTEM_ADDENDUM で自動的に感情タグ付与を指示。

## ウェイクワード検出

`WAKE_MODE=wake` を設定すると、名前を呼ばれた時だけ応答:

```bash
# .env
WAKE_MODE=wake
WAKE_WORDS=ケイティ,けいてぃ,caty,katie,ケイケイ
```

- 「ケイティ、今日の予定は？」→ ✅ 応答
- 「今日の天気はどう？」→ ❌ スルー（名前なし）

マルチエージェント参加時に必須の機能。

## ロードマップ

### ✅ 完了（v1）

| # | 内容 |
|---|------|
| 1 | MVP: Google Meet に参加して音声対話 |
| 2 | Fish Audio S1 TTS（自然な日本語音声） |
| 3 | 感情表現（64種類以上の感情タグ） |
| 4 | OpenClaw Gateway 連携（フル Caty 体験） |
| 5 | ウェイクワード検出（名前呼び応答） |
| 6 | アバター表示・会話ログ保存・エコー防止 |

### 🔜 次のステップ（v2）

| # | 内容 | 説明 |
|---|------|------|
| 1 | **マルチエージェント対応** | agents.json で全エージェント（Claire/Alec/Zoe/Eidra/Sebas）の Voice ID・OpenClaw ポート・アバターを定義。Agent Router が名前呼びで振り分け |
| 2 | **共有 Voice Bridge** | 1つのブリッジサーバーで全エージェント対応。個別セットアップ不要 |
| 3 | **エージェント選択 UI** | Meet 参加時にどのエージェントを招待するか選択可能 |
| 4 | **同時参加** | 複数 AI が1つの Meet に同時参加（ターン管理付き） |
| 5 | **VOICEVOX 対応** | ローカル TTS として VOICEVOX をサポート（Fish Audio と切替可能） |
| 6 | **ボイスクローニング** | Fish Audio で各エージェント固有の声を作成（15秒サンプルで生成可能） |

### マルチエージェント構成（v2 目標）

```
┌─────────────────────────────────────────┐
│       共有 Voice Bridge (1つ)            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐ │
│  │ Deepgram │  │ Agent   │  │ Fish    │ │
│  │ STT      │→ │ Router  │→ │ Audio   │ │
│  │ (共通)   │  │         │  │ TTS     │ │
│  └─────────┘  └────┬────┘  └─────────┘ │
└─────────────────────┼───────────────────┘
                      │ per-agent routing
          ┌───────────┼───────────┐
          ▼           ▼           ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Caty     │ │ Claire   │ │ Alec     │ ...
    │ OpenClaw │ │ OpenClaw │ │ OpenClaw │
    │ :18788   │ │ :18789   │ │ :19009   │
    └──────────┘ └──────────┘ └──────────┘
```

## ライセンス

Private — shojikumaru
