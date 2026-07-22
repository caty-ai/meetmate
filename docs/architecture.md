# AI Meet Participant — アーキテクチャ

## 概要

AIアシスタントがGoogle Meetにリアルタイム参加し、音声で対話するシステム。
OpenClaw Gateway 連携により、Slack等のチャットと**同一のエージェント体験**を音声で提供。

## システム構成図

```
┌──────────────┐
│  Google Meet  │  ← 人間が参加
│  (ブラウザ)   │
└──────┬───────┘
       │ Meet内部プロトコル
       ▼
┌──────────────────┐
│  Attendee (hosted)│  ← クラウドサービス (app.attendee.dev)
│  Meeting Bot管理  │     Chrome (Puppeteer) でMeetに参加
│  音声 I/O 制御    │     参加者の音声をキャプチャ
└──────┬───────────┘
       │ WebSocket (PCM audio stream)
       │ ↕ realtime_audio.mixed / bot_output
       ▼
┌─────────────────────────────────────────────────────────┐
│  Bridge Server (Node.js, port 5005)                      │
│                                                           │
│  ┌──────────┐  ┌─────────────────┐  ┌──────────────────┐│
│  │ stt.js   │  │ llm-provider.js │  │ tts-fish.js      ││
│  │ Soniox   │→ │ LLM             │→ │ Fish Audio S1    ││
│  │ stt-rt-v5│  │ provider        │  │ (REST streaming) ││
│  │ (stream) │  │ (SSE)           │  │                  ││
│  └──────────┘  └─────────────────┘  └──────────────────┘│
│                                                           │
│  pipeline.js — オーケストレーター                           │
│  ├─ STT → LLM → TTS パイプライン管理                      │
│  ├─ 文ごとの分割＆即時 TTS 送出（低遅延）                   │
│  ├─ 割り込み検出＆処理                                     │
│  ├─ ウェイクワード検出                                     │
│  └─ エコーループ防止                                       │
│                                                           │
│  server.js → transport-meet/meet-routes.js                 │
│  ├─ /join-meeting — Meet 参加 API                          │
│  ├─ /info — サーバー情報（TTS provider, WSS URL等）         │
│  └─ WebSocket ↔ Attendee 音声中継                          │
└─────────────────────────────────────────────────────────┘
       │
       │ ngrok tunnel (WSS 公開)
       ▼
  インターネット ← Attendee からの接続
```

## コンポーネント詳細

### 1. Attendee（クラウドサービス）
- **役割**: Google Meet に Bot として参加、音声ストリーム送受信
- **仕組み**: Chrome (Puppeteer) で Meet に参加、参加者音声をキャプチャ
- **API**: REST (`POST /api/v1/bots`) で Bot 作成・管理
- **データ形式**: PCM 16-bit signed LE, 16kHz

### 2. Bridge Server（自作 Node.js）
分解パイプラインで構成:

#### stt-provider.js — 音声認識（Soniox 既定 / Deepgram フォールバック）
- Soniox stt-rt-v5 ストリーミング STT（既定。Deepgram はフォールバック）
- WebSocket でリアルタイム transcription
- `smart_format: true` で自然な句読点付与

#### llm-provider.js — LLM（デュアルバックエンド）
- **既定**: OpenClaw Gateway（`src/llm-openclaw.js`、`/v1/chat/completions`、SSE streaming）
  - SOUL.md / AGENTS.md が自動注入
  - memory_search, Slack, Web検索, GitHub, Todoist 等の全ツール利用可能
  - 会話履歴は OpenClaw が自動管理
  - `VOICE_SYSTEM_ADDENDUM` で音声固有の指示（短く話す、感情タグ付与等）を追加
- **代替**: OpenAI 互換 API（`src/llm-openai.js`、`LLM_PROVIDER=openai-compatible`）
  - OpenClaw Gateway は不要。自動切替ではなく明示設定
  - `llm.systemPrompt`（未設定時は組み込みペルソナテンプレート）を使用
  - 会話履歴はローカル管理

#### tts-fish.js — 音声合成
- Fish Audio S1 REST API（ストリーミング）
- PCM 16-bit signed LE, 16kHz 出力
- **PCM バイトアラインメントバッファ**: 奇数バイトチャンクによるノイズ防止
- 感情タグ（`(happy)`, `(nervous)` 等）を自動解釈

#### pipeline.js — オーケストレーター
- STT → LLM → TTS パイプラインの全体制御
- **文ごとの分割**: 最初の文が完成した時点で即 TTS 開始（低遅延）
- **割り込み対応**: ユーザーが発話を始めたら現在の応答を中断
- **ウェイクワード検出**: `WAKE_MODE=wake` で名前呼び応答
- **エコーループ防止**: エコークールダウン + 無音検出
- **文間ポーズ**: `SENTENCE_PAUSE_MS` で自然なリズム

### 3. ngrok
- ローカルの Bridge Server を WSS でインターネット公開
- Attendee（クラウド）がローカル WebSocket に接続するために必要
- サーバー起動時に `localhost:4040/api/tunnels` から URL 自動取得

## データフロー（1発話サイクル）

```
1. 人間が Meet で発話
2. Google Meet → Attendee: 音声データキャプチャ
3. Attendee → Bridge: WebSocket (realtime_audio.mixed, PCM)
4. Bridge (stt.js): PCM → Deepgram → テキスト
5. Bridge (pipeline.js): ウェイクワード判定 → テキストを LLM に送信
6. Bridge (llm-provider.js): 設定した LLM プロバイダに SSE リクエスト
   └─ OpenClaw: SOUL.md 注入 → memory検索 → ツール実行 → 応答生成
7. Bridge (pipeline.js): SSE チャンクを文ごとに分割
8. Bridge (tts-fish.js): 文 → Fish Audio → PCM 音声（文ごとに即時開始）
9. Bridge → Attendee: WebSocket (realtime_audio.bot_output, PCM)
10. Attendee → Google Meet: 音声出力（エージェントが喋る）
```

## セキュリティ

| 対策 | 説明 |
|------|------|
| WebSocket Token | `WS_SHARED_TOKEN` で認証 |
| Join Token | `JOIN_SHARED_TOKEN` で `/join-meeting` を保護 |
| Gateway Token | `OPENCLAW_GATEWAY_TOKEN` で OpenClaw API を保護 |
| ログマスク | トークンをコンソールログに出力しない |
| `.gitignore` | `.env` / `logs/` / `assets/` を Git に含めない |

## 音声フォーマット

全コンポーネントで統一:
- **エンコーディング**: PCM 16-bit signed little-endian
- **サンプルレート**: 16,000 Hz
- **チャンネル**: モノラル

## 進化の経緯

| 段階 | 構成 | 状態 |
|------|------|------|
| MVP | Deepgram Voice Agent（オールインワン STT+LLM+TTS） | ✅ 完了・廃止 |
| Pipeline v1 | 分解パイプライン（STT + OpenRouter + Fish Audio） | ✅ 完了 |
| Pipeline v2 | 分解パイプライン（STT + **OpenClaw Gateway** + Fish Audio） | ✅ **現行** |

**MVP → Pipeline v1 の理由**: Deepgram Voice Agent は 4 TTS プロバイダしかサポートしておらず、Fish Audio が使えなかった

**Pipeline v1 → v2 の理由**: OpenRouter 直接呼び出しでは SOUL.md・memory・ツールが使えず、Meet の Caty と Slack の Caty が別人になってしまう
