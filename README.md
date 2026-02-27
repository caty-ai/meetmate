# AI Meet Participant

- channel: #proj-ai-meet-participant-v1
- channelId: C0XXXXXXXXX
- ulid: 01KJERSHSWRPFKX9MSCDD24W5R
- family-memory: projects/ai-meet-participant/index.md

## Overview

AIアシスタント（Caty, Claire, Alec, Zoe, Eidra）がGoogle Meetにリアルタイム参加し、
音声で対話できるアプリ。1ミーティング＝1 OpenClawセッションとして、
Slackセッションと同等の体験を実現する。

## Tech Stack

- **Attendee (OSS)** — Meeting bot管理（Docker / self-hosted）
- **STT** — Deepgram / Whisper（リアルタイム音声→テキスト）
- **TTS** — ElevenLabs（テキスト→音声 / エージェントごとの声）
- **OpenClaw** — AIセッション管理

## Phases

1. MVP: Caty 1人が Meet で音声対話（TTS制約により英語運用）
2. OpenClawセッション統合（ログ・メモリ連携）
3. マルチエージェント + 声の個性
4. Googleカレンダー連携 + Slack呼び出し
