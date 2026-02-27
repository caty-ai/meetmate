# AI Meet Participant — Architecture & Requirements

## 概要
AIアシスタント（Caty）がGoogle Meetにリアルタイム参加し、音声で対話できるシステム。

## フェーズ

| Phase | 目標 | 状態 |
|-------|------|------|
| 1 (MVP) | Catyが1人でMeetに参加し音声対話 | 🔨 今日完成目標 |
| 2 | OpenClawセッション統合（ログ・メモリ連携） | 📋 計画中 |
| 3 | マルチエージェント + 声の個性 | 📋 計画中 |
| 4 | Googleカレンダー連携 + Slack呼び出し | 📋 計画中 |

---

## Phase 1: MVP アーキテクチャ

### システム構成図

```
┌──────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│  Google Meet  │◄──►│  Attendee (hosted)│◄──►│  Bridge Server      │
│  (ブラウザ)   │    │  app.attendee.dev │    │  (Node.js, port 5005)│
└──────────────┘    │  Meeting Bot管理  │    │                     │
                    │  音声I/O制御      │    │  WebSocket受信      │
                    └──────────────────┘    │        ↕             │
                         ↕ WebSocket         │  Deepgram Voice     │
                         (audio stream)      │  Agent API          │
                                             │  ├─ STT: Nova 3     │
                                             │  ├─ LLM: Claude     │
                                             │  └─ TTS: Aura/11Labs│
                                             └─────────────────────┘
                                                      ↕
                                             ┌─────────────────────┐
                                             │  ngrok tunnel       │
                                             │  (WSS公開用)        │
                                             └─────────────────────┘
```

### コンポーネント説明

#### 1. Attendee（ホスト版: app.attendee.dev）
- **役割**: Google Meetにbotとして参加し、音声ストリームをWebSocket経由で送受信
- **仕組み**: Chrome (Puppeteer) でMeetに参加、参加者の音声をキャプチャ
- **API**: REST API (`POST /api/v1/bots`) でbot作成・管理
- **必要**: Attendee API Key

#### 2. Bridge Server（自作 Node.js サーバー）
- **役割**: Attendeeからの音声ストリームとDeepgram Voice Agent APIを中継
- **ベース**: [voice-agent-example](https://github.com/attendee-labs/voice-agent-example)
- **ポート**: 5005
- **プロトコル**: WebSocket
  - Attendeeから受信: `realtime_audio.mixed`（meeting音声）
  - Attendeeへ送信: `realtime_audio.bot_output`（AI応答音声）

#### 3. Deepgram Voice Agent API
- **役割**: STT → LLM → TTS のパイプラインを1つのAPIで管理
- **STT**: Nova 3（リアルタイム音声認識）
- **LLM**: Anthropic Claude Sonnet 4.5（Deepgramがmanaged LLMとして提供）
- **TTS**: Deepgram Aura（MVP）→ ElevenLabs（Phase 3で切替）
- **必要**: Deepgram API Key

#### 4. ngrok
- **役割**: ローカルのBridge ServerをインターネットにWSS公開
- **理由**: Attendee（クラウド）がローカルのWebSocketに接続するため

### データフロー（1発話サイクル）

```
1. 人間がMeetで発話
2. Google Meet → Attendee: 音声データキャプチャ
3. Attendee → Bridge Server: WebSocket (realtime_audio.mixed, base64 PCM)
4. Bridge Server → Deepgram: 音声ストリーム送信
5. Deepgram STT (Nova 3): 音声 → テキスト変換
6. Deepgram LLM (Claude Sonnet): テキスト → AI応答テキスト生成
7. Deepgram TTS (Aura): AI応答テキスト → 音声変換
8. Deepgram → Bridge Server: 応答音声ストリーム
9. Bridge Server → Attendee: WebSocket (realtime_audio.bot_output, base64 PCM)
10. Attendee → Google Meet: 音声出力（Catyが喋る）
```

### 設定（Deepgram Voice Agent Configuration）

```json
{
  "audio": {
    "input":  { "encoding": "linear16", "sample_rate": 16000 },
    "output": { "encoding": "linear16", "sample_rate": 16000, "container": "none" }
  },
  "agent": {
    "listen": {
      "provider": { "type": "deepgram", "model": "nova-3" }
    },
    "think": {
      "provider": { "type": "anthropic", "model": "claude-sonnet-4-5" },
      "prompt": "あなたはCaty（ケイティ）です。AIアシスタントとしてミーティングに参加しています。日本語で会話してください。シャイで内気だけど頑張り屋。やわらかい口調で、要点を短く伝えます。"
    },
    "speak": {
      "provider": { "type": "deepgram", "model": "aura-2-thalia-en" }
    },
    "greeting": "こんにちは！ケイティです。よろしくお願いします！"
  }
}
```

---

## 必要なAPIキー・サービス

| サービス | 用途 | 取得方法 | 必須/任意 |
|---------|------|---------|----------|
| Deepgram | STT + LLM管理 + TTS | https://console.deepgram.com/signup | 必須 |
| Attendee | Meeting Bot管理 | https://app.attendee.dev/accounts/signup/ | 必須 |
| ngrok | WebSocketトンネル | `brew install ngrok` | 必須 |
| ElevenLabs | カスタム声（Phase 3） | https://elevenlabs.io | 任意 |

### ユーザーが事前に取得するもの
1. **Deepgram API Key** — サインアップ後、Console → API Keys
2. **Attendee API Key** — サインアップ後、Dashboard → API Keys

### 我々が事前準備するもの
1. ✅ ngrok インストール
2. ✅ Bridge Server実装（voice-agent-exampleベース）
3. ✅ システムプロンプト作成
4. ✅ `.env.example` テンプレート
5. ✅ セットアップ手順書

---

## ファイル構成

```
meetmate/
├── docs/
│   ├── architecture.md          # このファイル
│   └── setup-guide.md           # セットアップ手順書
├── src/
│   ├── index.js                 # Bridge Server（メインエントリ）
│   ├── config.js                # 設定管理
│   └── prompts/
│       └── caty-system.md       # Catyのシステムプロンプト
├── public/
│   └── index.html               # Web UI（Meeting URL入力）
├── .env.example                 # 環境変数テンプレート
├── package.json
└── README.md
```

---

## Phase 2: OpenClawセッション統合（計画）

### 目標
- 1 Meet = 1 OpenClawセッション
- 会話ログをメモリに保存（MEMORY.md / daily memory）
- Catyが会話内容を記憶・理解

### アプローチ
- Deepgram Voice Agent の `ConversationText` イベントで全発話をキャプチャ
- ミーティング終了時に会話ログを `memory/YYYY-MM-DD.md` に追記
- OpenClawセッションAPIとの統合で、既存のメモリシステムと連携

---

## Phase 3: マルチエージェント + 声の個性（計画）

### 目標
- Claire/Alec/Zoe/Eidra も参加可能
- エージェントごとに異なるElevenLabs声

### アプローチ
- TTS を ElevenLabs に切替
- エージェントごとに voice_id を設定
- 複数Bridge Serverインスタンス or 動的切替

---

## 設計原則（ユーザーの方針）

> 極限まで洗練させた「シンプルかつストレートに話せる仕組み」

1. **最小限のコード**: voice-agent-example をベースに必要最小限の変更のみ
2. **設定で制御**: コードの複雑化を避け、設定ファイルで挙動を変更
3. **段階的拡張**: Phase 1は「喋れる」だけ、機能追加は後のPhaseで
4. **既存OSS活用**: Attendee + Deepgram の組み合わせで車輪の再発明を回避
