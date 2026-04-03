# 🎙️ AI Meet Participant

AIエージェントをGoogle Meet / Zoomにリアルタイム参加させ、音声で対話するブリッジサーバー。
OpenClaw Gateway連携により、任意のエージェントを音声会議に接続可能。

## 特徴
- Google Meet / Zoom 対応
- OpenClaw Gateway連携（SOUL/memory/skills/tools完全対応）
- ウェイクワード検出
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

### 2. config.json（エージェント設定の単一ソース）
```bash
cp config.json.example config.json
```
エージェントID・表示名・ウェイクワード・TTS設定などを記述。
詳細は `config.json.example` を参照。

### 3. .env（APIキー・シークレット）
```bash
cp .env.example .env
```
必須:
- `DEEPGRAM_API_KEY` — STT用
- `FISH_AUDIO_API_KEY` — TTS用
- `FISH_AUDIO_VOICE_ID` — TTS音声ID（config.json `tts.voiceId` が参照）
- `ATTENDEE_API_KEY` — Meet/Zoom Bot API（config.json `attendee.apiKey` でも可）

### 4. アバター
`assets/avatar.png` にエージェントのアバター画像を配置。

### 5. 起動
```bash
npm start
```
ブラウザで http://localhost:5005 を開き、Meet/Zoom URLを貼り付けて「参加させる」をクリック。

## アーキテクチャ

**1エージェント = 1サーバーインスタンス。**
`config.json` + `.env` + `assets/avatar.png` だけで任意のエージェントが動作する。

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
