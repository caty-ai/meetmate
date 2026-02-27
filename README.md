# 🐱 AI Meet Participant — Caty

AIアシスタント「Caty（ケイティ）」がGoogle Meetにリアルタイム参加して音声で対話するアプリ。

## アーキテクチャ

```
Google Meet ←→ Attendee Bot (hosted)
                    ↕ WebSocket (audio)
              Bridge Server (Node.js)
              ├── Deepgram STT (Nova 3) — 音声認識
              ├── OpenClaw Gateway — LLM (フルCaty体験)
              └── Fish Audio TTS (S1) — 音声合成 + 感情表現
```

**OpenClaw Gateway 連携**により、MeetのCatyは Slack のCatyとまったく同じ:
- 同じ人格 (SOUL.md / AGENTS.md)
- 同じ記憶 (memory_search)
- 同じスキル (Slack連携、Web検索、GitHub操作、カレンダー等)
- 会話履歴もOpenClawが自動管理

## 機能

- 🎙️ リアルタイム音声対話（日本語 / 英語）
- 🐟 Fish Audio S1 による自然な音声合成
- 🎭 感情タグ対応（(happy), (nervous), (excited) 等 64種類以上）
- 🖼️ Catyアバター表示（Slackアイコンを自動使用）
- 🔗 OpenClaw Gateway 連携（フルエージェント体験）
- 🔔 ウェイクワード検出（ミーティング中の選択的応答）
- 🛡️ エコーループ防止
- 📝 会話ログ自動保存 (logs/ + memory/)
- 🔄 OpenRouter フォールバック（Gateway未設定時）

## セットアップ

### 必要なもの
- Node.js 20+
- [Deepgram](https://console.deepgram.com/) API Key（STT）
- [Attendee](https://app.attendee.dev/) API Key（Meet Bot）
- [Fish Audio](https://fish.audio/) API Key（TTS）
- [ngrok](https://ngrok.com/) (外部WebSocket接続用)
- OpenClaw Gateway Token（フルCaty体験に必要）

### 1. 依存関係インストール

```bash
cd meetmate
npm install
```

### 2. 環境変数設定

```bash
cp .env.example .env
# .env を編集して各APIキーを設定
```

主要な環境変数:
| 変数 | 説明 | 必須 |
|------|------|------|
| `DEEPGRAM_API_KEY` | Deepgram STT | ✅ |
| `ATTENDEE_API_KEY` | Attendee Bot | ✅ |
| `FISH_AUDIO_API_KEY` | Fish Audio TTS | ✅ |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL | 推奨 |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway Token | 推奨 |
| `OPENROUTER_API_KEY` | OpenRouter（フォールバック用） | △ |
| `FISH_AUDIO_VOICE_ID` | Fish Audio Voice Model ID | 任意 |
| `WAKE_MODE` | `off` / `wake` | 任意 |
| `WAKE_WORDS` | ウェイクワード（カンマ区切り） | 任意 |

### 3. ngrok トンネル起動

```bash
ngrok http 5005
```

### 4. サーバー起動

```bash
node src/index.js
```

### 5. Meetに参加

ブラウザで `http://localhost:5005` を開き、Google Meet URLを貼って「🚀 Meetに参加させる」をクリック。

## ファイル構成

```
src/
├── index.js        — HTTPサーバー + WebSocket + セッション管理
├── config.js       — 設定管理（環境変数）
├── pipeline.js     — オーケストレーター（STT → LLM → TTS）
├── stt.js          — Deepgram Nova 3 ストリーミングSTT
├── llm.js          — LLM (OpenClaw Gateway / OpenRouter)
├── tts-fish.js     — Fish Audio REST TTS (PCMストリーミング)
└── prompts/
    └── caty-system.md — 音声用システムプロンプト（OpenRouter用）

public/
└── index.html      — Web UI（Meet URL入力画面）

assets/
└── caty-avatar.png  — Catyアバター（自動ダウンロード/キャッシュ）

logs/                — 会話ログ（自動生成）
docs/                — 設計書・仕様書
```

## TTS Provider

`TTS_PROVIDER` 環境変数で切り替え:

| Provider | 説明 |
|----------|------|
| `fish-audio` (デフォルト) | 分解パイプライン（STT → LLM → Fish Audio TTS） |
| `deepgram-agent` | レガシー（Deepgram Voice Agent API オールインワン） |

## ウェイクワード検出

`WAKE_MODE=wake` に設定すると、ウェイクワード（「ケイティ」等）が含まれる発話にだけ応答します。

```env
WAKE_MODE=wake
WAKE_WORDS=ケイティ,けいてぃ,caty,katie,ケイケイ
```

ミーティングで他の参加者の会話には反応せず、名前を呼ばれた時だけ応答します。

## 感情表現

Fish Audio S1 の感情タグシステムにより、Catyは文脈に応じて声の抑揚を変えます:

- `(happy)` 嬉しい — 明るいトーン
- `(nervous)` 緊張 — 控えめなトーン
- `(excited)` 興奮 — テンション高め
- `(empathetic)` 共感 — 優しいトーン
- `(laughing)` 笑い声
- `(whispering)` ささやき

## 音声チューニング

| 環境変数 | デフォルト | 説明 |
|----------|-----------|------|
| `SENTENCE_PAUSE_MS` | 500 | 文間の無音（ms） |
| `LISTEN_ENDPOINTING_MS` | 700 | 発話終了判定（ms） |
| `LISTEN_UTTERANCE_END_MS` | 1800 | 発話区切り判定（ms） |
| `FISH_AUDIO_LATENCY` | balanced | `normal`（高品質）/ `balanced`（低遅延） |
| `AGENT_TEMPERATURE` | 0.5 | LLMの創造性 |
| `AGENT_MAX_TOKENS` | 300 | LLMの最大トークン数 |

## 開発

```bash
# 構文チェック
node -c src/index.js

# 起動
node src/index.js

# ngrok (別ターミナル)
ngrok http 5005
```

## ライセンス

Private — shojikumaru
