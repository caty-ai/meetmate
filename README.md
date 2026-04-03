# 🎙️ AI Meet Participant

AIエージェントがGoogle Meet / Zoomにリアルタイム参加して音声で対話するブリッジサーバー。
OpenClaw Gateway連携により、Slackとまったく同じ体験を音声で提供。

## 特徴
- Google Meet / Zoom 対応
- OpenClaw Gateway連携（SOUL/memory/skills/tools完全対応）
- ウェイクワード検出（マルチエージェント対応）
- バージイン（割り込み）対応
- TTS: Fish Audio / Deepgram Voice Agent
- STT: Deepgram
- LCM（Lossless Context Management）自動記録
- Slack連動（ステータス通知・サマリー・全文ログ）

## セットアップ

### 1. リポジトリのクローン
```bash
git clone <repo-url>
cd ai-meet-participant
npm install
```

### 2. 設定ファイルの準備

#### config.json
`cp config.json.example config.json` で作成し、エージェント情報を設定。

#### .env
`cp .env.example .env` で作成し、APIキーを設定。

必須:
- `DEEPGRAM_API_KEY`
- `ATTENDEE_API_KEY` (or config.json `attendee.apiKey`)

#### アバター
`assets/avatar.png` にエージェントのアバター画像を配置。

### 3. 起動
```bash
npm start
```

### 4. 使い方
ブラウザで http://localhost:5005 を開き、Meet/Zoom URLを貼り付けて「参加させる」をクリック。

## アーキテクチャ

1エージェント = 1サーバーインスタンス。
各エージェントが独立したconfig.json + .env + avatar.pngで動作。

### 音声パイプライン
```
STT(Deepgram) → ウェイクワード検出 → OpenClaw Gateway(LLM) → TTS(Fish Audio) → Meet/Zoom
```

### 主要モジュール
- `agent-profile.js`: エージェント設定解決
- `speech-policy.js`: NO_REPLY抑制・テキスト浄化
- `exit-handler.js`: 退出検出・クリーンアップ
- `pipeline.js`: 音声パイプライン制御
- `llm.js`: Gateway Chat Completions連携
- `stt.js`: Deepgram STT
- `tts-fish.js`: Fish Audio TTS

## LCM（Lossless Context Management）

MeetセッションはOpenClawのLCMで自動記録。セッション終了時にingestされ、長期記憶に保存。

推奨設定: `ingestMode: "auto"`

## ライセンス
Private
