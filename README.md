# AI Meet Participant

[![Version](https://img.shields.io/badge/version-v7.9.0--rc.1-blue)](https://github.com/caty-ai/meetmate/releases)
[![Stable](https://img.shields.io/badge/stable-v7.8.0-brightgreen)](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
[![License: Apache--2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Google%20Meet%20%7C%20Zoom-4285F4)](#特徴)

AI エージェントを Google Meet / Zoom にリアルタイム参加させ、音声で対話するブリッジサーバー。OpenClaw Gateway 連携により、任意のエージェントを音声会議に接続できます。

```
STT (Soniox) → ウェイクワード検出 → OpenClaw Gateway (LLM) → TTS (Fish Audio S2-Pro) → Meet / Zoom
```

## 目次

- [特徴](#特徴)
- [スクリーンショット](#スクリーンショット)
- [アーキテクチャ](#アーキテクチャ)
- [クイックスタート](#クイックスタート)
- [設定](#設定)
- [トラブルシューティング](#トラブルシューティング)
- [ドキュメント](#ドキュメント)
- [開発](#開発)
- [開発ステータス](#開発ステータス)
- [コントリビュート](#コントリビュート)
- [謝辞](#謝辞)
- [ライセンス](#ライセンス)

## 特徴

- **Google Meet / Zoom 対応** — Attendee Bot API 経由で会議に参加
- **OpenClaw Gateway 連携** — SOUL / memory / skills / tools を完全サポート
- **ウェイクワード検出 + バージイン**（発話への割り込み）対応
- **低遅延 STT** — Soniox `stt-rt-v5`（既定）。`STT_PROVIDER=deepgram` で Deepgram にも切替可
- **感情表現つき TTS** — Fish Audio S2-Pro（emotion tag anchor 方式で声質を安定化）
- **固定文言 TTS キャッシュ** — ack / ping / greeting / farewell 等を PCM ディスクキャッシュから即時再生。実収録テイクの事前シードにも対応
- **委譲強制ハーネス** — 重い処理はバックグラウンドの delegate セッションへ強制委譲し、フロントは対話に専念（[#79](https://github.com/caty-ai/meetmate/issues/79)）
- **会議チャット投稿** — LLM 応答内の `[[[chat: ...]]]` タグを読み上げずに Meet チャットへ投稿
- **絵文字ガード** — LLM プロンプト禁止 + TTS 直前の機械 strip の 2 層構成
- **LCM（Lossless Context Management）自動記録** / **Slack 連動**（ステータス通知・サマリー・全文ログ）

## スクリーンショット

<!-- TODO: 画像を docs/images/ に配置したらコメントを外す
![操作 UI](docs/images/ui-join.png)
![会議参加中](docs/images/in-meeting.png)
-->

ブラウザで http://localhost:5005 を開くと操作 UI が表示され、Meet / Zoom の URL を貼り付けるだけでエージェントが会議に参加します。参加中はアバター（`assets/avatar.png`）が会議の参加者タイルとして表示され、ウェイクワードで呼びかけると音声で応答します。

> 📸 スクリーンショット・デモ GIF は準備中です。

## アーキテクチャ

**1 エージェント = 1 サーバーインスタンス。** `config.json` + `.env` + `assets/avatar.png` だけで任意のエージェントが動作します。

入力側 STT は 16kHz、出力側 TTS / `bot_output` は 24kHz。Attendee の入力 leg と出力 leg は独立しています。

### 主要モジュール

| モジュール | 役割 |
|---|---|
| [`src/pipeline.js`](src/pipeline.js) | 音声パイプライン制御 |
| [`src/agent-profile.js`](src/agent-profile.js) | エージェント設定解決 |
| [`src/llm.js`](src/llm.js) | Gateway Chat Completions 連携 |
| [`src/stt-provider.js`](src/stt-provider.js) | STT プロバイダ切替（soniox 既定 / deepgram） |
| [`src/stt-soniox.js`](src/stt-soniox.js) | Soniox STT（stt-rt-v5, WebSocket） |
| [`src/stt.js`](src/stt.js) | Deepgram STT（フォールバック） |
| [`src/tts-fish.js`](src/tts-fish.js) | Fish Audio TTS |
| [`src/speech-policy.js`](src/speech-policy.js) | NO_REPLY 抑制・テキスト浄化 |
| [`src/exit-handler.js`](src/exit-handler.js) | 退出検出・クリーンアップ |

詳細は [docs/architecture.md](docs/architecture.md) を参照してください。

## クイックスタート

### 前提条件

- Node.js 18 以上
- 各サービスの API キー（OpenClaw Gateway / Soniox / Fish Audio / Attendee）

### 1. インストール

```bash
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install
```

### 2. 環境変数（`.env`）

```bash
cp .env.example .env
```

| 変数 | 用途 |
|---|---|
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL（例: `http://localhost:18789`） |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 認証トークン |
| `SONIOX_API_KEY` | STT 用（既定プロバイダ Soniox） |
| `FISH_AUDIO_API_KEY` | TTS 用 |
| `FISH_AUDIO_VOICE_ID` | TTS 音声 ID（声のクローン） |
| `ATTENDEE_API_KEY` | Meet / Zoom Bot API |

任意の変数（`PORT`、`AGENT_LANG`、Slack 連携など）とチューニング系 env の全リファレンスは [docs/operations.md](docs/operations.md) を参照。

### 3. エージェント設定（`config.json`）

```bash
cp config.json.example config.json
```

エージェント ID / 表示名 / ウェイクワード / 固定文言（greeting・ackVariants・progressPings など）/ TTS・STT・Slack・Attendee の設定をここに集約しています。`config.json.example` は emotion tag anchor 方式（S2-Pro 用）に揃えてあるので、コピーして変数を埋めれば動きます。

### 4. アバターの配置と起動

```bash
# assets/avatar.png にエージェントのアバター画像を配置してから
npm start
```

ブラウザで http://localhost:5005 を開き、Meet / Zoom の URL を貼り付けて「参加させる」をクリックします。

## 設定

よく使う調整ポイントの入口だけまとめます。全項目は [docs/operations.md](docs/operations.md) にあります。

| やりたいこと | 見る場所 |
|---|---|
| 応答の戻りを速くしたい | [Soniox チューニング](docs/operations.md#stt-プロバイダ切替soniox-チューニング) |
| 声・話速・TTS 挙動を変えたい | [音声プロファイル](docs/operations.md#音声プロファイルtts) |
| 挙動がおかしいとき旧設定へ戻したい | [緊急 rollback 用 env](docs/operations.md#緊急-rollback-用-env) |
| 重作業のバックグラウンド委譲を使いたい | [委譲強制ハーネス](docs/operations.md#委譲強制ハーネス79) |
| 実収録音声を TTS キャッシュに流し込みたい | [実収録テイクのシード](docs/operations.md#実収録テイクのシード72--75) |

## トラブルシューティング

**Q. こちらが話し終えてから応答が返るまで遅い**
`SONIOX_MAX_ENDPOINT_DELAY_MS` を `1500` → `1000`（必要なら `800`）に下げて meet-server を再起動。途中で発話が区切られるようになったら `SONIOX_ENDPOINT_SENSITIVITY` を `0.0〜-0.2` に下げて調整します。詳細は [Soniox チューニング](docs/operations.md#stt-プロバイダ切替soniox-チューニング)。

**Q. Meet チャットへの投稿が失敗する**
絵文字・特殊文字が含まれると Attendee サーバー側で 400 拒否されます（"Message cannot contain emojis or rare script characters."）。送信失敗の warn は `logs/meet-server.stderr.log` に出るので、まずそこを確認してください。

**Q. TTS の声質が不安定・暴走する**
S2-Pro はタグなし発話で声質が暴走しやすいため、全発話に感情タグを 1 個入れる「アンカー方式」を前提にしています（[音声プロファイル](docs/operations.md#音声プロファイルtts)）。それでも不安定なら `FISH_AUDIO_MODEL=s1` で旧モデルへ即時ロールバックできます。

**Q. STT の認識が急に悪くなった**
`.env` で `STT_PROVIDER=deepgram` にして再起動すると Deepgram へ即時切替できます。人名・専門用語の誤認識は `SONIOX_CONTEXT_TERMS` にカンマ区切りで登録すると改善します。

**Q. 固定文言（相槌など）の声がいつもと違う**
TTS キャッシュがヒットせず live synthesis に戻っています。cache key は `voiceId` / `FISH_AUDIO_SPEED` / `FISH_AUDIO_MODEL` / `TTS_SAMPLE_RATE` に依存するので、これらを変更したら `node scripts/seed-tts-cache-from-fillers.js` を再実行してください（[シード手順](docs/operations.md#実収録テイクのシード72--75)）。

**Q. 委譲ハーネスが動いているか確認したい**
`logs/metrics.jsonl` に JSONL で記録されます。`node scripts/aggregate-metrics.js logs/metrics.jsonl` で集計できます。

解決しない場合は [Issues](https://github.com/caty-ai/meetmate/issues) へ、ログ（`logs/` 配下）と再現手順を添えて報告してください。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/setup-guide.md](docs/setup-guide.md) | セットアップ詳細ガイド |
| [docs/architecture.md](docs/architecture.md) | アーキテクチャ解説 |
| [docs/operations.md](docs/operations.md) | 運用・チューニング全リファレンス |
| [docs/deploy-checklist.md](docs/deploy-checklist.md) | デプロイチェックリスト |
| [docs/deep-interview-79-delegation-harness.md](docs/deep-interview-79-delegation-harness.md) | 委譲強制ハーネスの設計スペック |

## 開発

### 開発サーバー

```bash
npm run dev   # node --watch で自動リロード起動
```

### テスト

Node.js 標準の test runner（`node:test`）を使用しています。外部依存なしで数秒で完走します。

```bash
node --test test/*.test.js        # 全テスト（16 スイート / 192 テスト）
npm run test:meet:repro           # Meet 複数参加者の再現テストのみ
```

### スモーク・運用スクリプト

| スクリプト | 用途 |
|---|---|
| [`scripts/soniox-smoke.js`](scripts/soniox-smoke.js) | Soniox STT の疎通確認 |
| [`scripts/seed-tts-cache-from-fillers.js`](scripts/seed-tts-cache-from-fillers.js) | 実収録テイクから TTS キャッシュを事前生成 |
| [`scripts/aggregate-metrics.js`](scripts/aggregate-metrics.js) | 委譲ハーネス metrics の集計 |
| [`scripts/install-launchagent.sh`](scripts/install-launchagent.sh) | macOS launchd 常駐化（watchdog 付き） |

### ログ

実行ログは `logs/` 配下に出力されます。アプリ側の warn/error は `logs/meet-server.stderr.log`、委譲ハーネスの metrics は `logs/metrics.jsonl` を参照してください。

## 開発ステータス

- **最新版**: `v7.9.0-rc.1`（2026-07-07・Mac mini 稼働中・`GATEWAY_EVENTS_ENABLED=true`）
- **安定版**: [`v7.8.0-stable`](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
- **直近の完了**: [#79 委譲強制ハーネス](https://github.com/caty-ai/meetmate/issues/79) Phase 1（PR #94 / #96 / #97、実機スモーク 2 回で全機能実証済み）
- **次の開発**: [#87 実戦ゲート](https://github.com/caty-ai/meetmate/issues/87)（社内 MT 実投入・閾値チューニング）、[#98 compact 実圧縮](https://github.com/caty-ai/meetmate/issues/98)（優先度低）

## コントリビュート

コントリビュートを歓迎します。Issue 起点の開発フロー・ブランチ運用・PR の書き方は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## 謝辞

本プロジェクトは以下のサービス・プロジェクトの上に成り立っています。

- [Attendee](https://attendee.dev/) — Google Meet / Zoom への Bot 参加 API
- [Soniox](https://soniox.com/) — リアルタイム音声認識（`stt-rt-v5`）
- [Fish Audio](https://fish.audio/) — 感情表現つき音声合成（S2-Pro）
- OpenClaw Gateway — エージェント基盤（SOUL / memory / skills / tools）

## ライセンス

[Apache License 2.0](LICENSE) — 詳細は [NOTICE](NOTICE) も参照
