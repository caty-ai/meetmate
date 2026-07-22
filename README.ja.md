# AI Meet Participant

[English](README.md) | **日本語** | [中文](README.zh.md) | [ไทย](README.th.md)

> この文書は [README.md](README.md)（英語・正本）の翻訳です。内容に乖離がある場合は英語版が優先されます。

[![Version](https://img.shields.io/badge/version-v7.9.0--rc.1-blue)](https://github.com/caty-ai/meetmate/releases)
[![Stable](https://img.shields.io/badge/stable-v7.8.0-brightgreen)](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
[![License: Apache--2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Google%20Meet%20%7C%20Zoom-4285F4)](#特徴)

AI エージェントを Google Meet / Zoom にリアルタイム参加させ、音声で対話するブリッジサーバー。OpenClaw Gateway 連携により、任意のエージェントを音声会議に接続できます。

```
STT (Soniox) → ウェイクワード検出 → LLM (OpenClaw Gateway 既定) → TTS (Fish Audio S2-Pro) → Meet / Zoom
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

**1 エージェント = 1 サーバーインスタンス。** `config.json` + `.env` + アバター画像だけで任意のエージェントが動作します。

入力側 STT は 16kHz、出力側 TTS / `bot_output` は 24kHz。Attendee の入力 leg と出力 leg は独立しています。

### 主要モジュール

| モジュール | 役割 |
|---|---|
| [`src/pipeline.js`](src/pipeline.js) | 音声パイプライン制御 |
| [`src/agent-profile.js`](src/agent-profile.js) | エージェント設定解決 |
| [`src/paths.js`](src/paths.js) | ホームディレクトリ契約（`AI_MEET_HOME`）— [データディレクトリ](#データディレクトリai_meet_home)参照 |
| [`src/llm-provider.js`](src/llm-provider.js) | LLM プロバイダ切替（OpenClaw 既定 / OpenAI 互換） |
| [`src/stt-provider.js`](src/stt-provider.js) | STT プロバイダ切替（soniox 既定 / deepgram） |
| [`src/stt-soniox.js`](src/stt-soniox.js) | Soniox STT（stt-rt-v5, WebSocket） |
| [`src/stt.js`](src/stt.js) | Deepgram STT（フォールバック） |
| [`src/tts-fish.js`](src/tts-fish.js) | Fish Audio TTS |
| [`src/speech-policy.js`](src/speech-policy.js) | NO_REPLY 抑制・テキスト浄化 |
| [`src/exit-handler.js`](src/exit-handler.js) | 退出検出・クリーンアップ |

詳細は [docs/architecture.md](docs/architecture.md) を参照してください。

## クイックスタート

### 前提条件

- Node.js 22 以上（`package.json` の `engines` 準拠）
- LLM プロバイダは `openclaw`（既定）または `openai-compatible`
  - `openclaw` は OpenClaw Gateway が必要。SOUL / memory / skills / tools を含む完全なエージェント体験を提供
  - `openai-compatible` は OpenAI 互換 API に接続し、OpenClaw Gateway は不要
- 各サービスの API キー（Soniox / Fish Audio / Attendee）
  - [Attendee](https://attendee.dev/) は Google Meet / Zoom に Bot を参加させる SaaS（self-host 版もあり）。Bot の入退室・音声入出力はすべて Attendee API 経由
  - Fish Audio の Voice ID は [fish.audio](https://fish.audio/) で使いたい声（自作 or 公開ボイス）のページを開き、URL 末尾の ID をコピー

### 方法 A: npm パッケージ（推奨）

> ℹ️ npm 初回リリース公開までは下の[方法 B](#方法-b-ソースから) を使ってください。

```bash
mkdir my-agent && cd my-agent
npm install ai-meet-participant
npx ai-meet init    # 3つの API キーを対話式で聞き、config.json と .env を生成
npx ai-meet start   # サーバーを起動し、設定 UI の URL を表示
```

`init` は同梱の `config.json.example` / `.env.example` を**カレントディレクトリ**へコピーし、入力した認証情報（`SONIOX_API_KEY`, `FISH_AUDIO_API_KEY`, `ATTENDEE_API_KEY`）を埋め込みます。既存ファイルがある場合は `--force` を付けない限り上書きを拒否します。生成後、`config.json` でエージェント名・ウェイクワード・固定文言を設定してください。

### 方法 B: ソースから

```bash
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env        # キーを記入
cp config.json.example config.json
npm start
```

ブラウザで http://localhost:5005 を開き、Meet / Zoom の URL を貼り付けて「参加させる」をクリックします。

> 💡 ウェイクワードの反応が悪い場合は、ブラウザから実際の発話で誤認識バリアントを収集する **wake-calibrate** 機能があります（`/calibrate`・`WAKE_CALIBRATE_ENABLED=1` で有効化）。手順は [docs/setup-guide.md](docs/setup-guide.md) を参照。

### データディレクトリ（`AI_MEET_HOME`）

サーバーが**書き込む**もの＋ユーザー設定は、1つの *home* ディレクトリに集約されます。既定は**カレントディレクトリ**、環境変数 `AI_MEET_HOME` で変更できます:

| パス（home 配下） | 内容 |
|---|---|
| `config.json` / `.env` | エージェント設定と認証情報 |
| `logs/` | 実行ログ・委譲 metrics（`metrics.jsonl`） |
| `assets/avatar.png` | アバター上書き（未配置なら同梱の既定画像にフォールバック） |
| `assets/tts-cache/` | 固定文言 TTS キャッシュ |

読み取り専用の同梱アセット（Web UI・既定アバター・filler 音声）は常にインストール済みパッケージ側から読まれます。`TTS_CACHE_DIR` / `METRICS_LOG_DIR` は明示上書きとして引き続き有効です。ソース checkout からの `npm start` はリポジトリ直下が home になるため、従来の挙動と変わりません。

### 環境変数（`.env`）

| 変数 | 用途 |
|---|---|
| `LLM_PROVIDER` | LLM プロバイダ（`openclaw`（既定）/ `openai-compatible`） |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL（`openclaw` で必須。例: `http://localhost:18789`） |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 認証トークン（`openclaw` で必須） |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI 互換 API のベース URL（`openai-compatible` で必須） |
| `OPENAI_COMPATIBLE_API_KEY` | OpenAI 互換 API キー（`openai-compatible` で必須） |
| `SONIOX_API_KEY` | STT 用（既定プロバイダ Soniox） |
| `FISH_AUDIO_API_KEY` | TTS 用 |
| `FISH_AUDIO_VOICE_ID` | TTS 音声 ID（声のクローン） |
| `ATTENDEE_API_KEY` | Meet / Zoom Bot API |

任意の変数（`PORT`、`AGENT_LANG`、Slack 連携など）とチューニング系 env の全リファレンスは [docs/operations.md](docs/operations.md) を参照。

### エージェント設定（`config.json`）

エージェント ID / 表示名 / ウェイクワード / 固定文言（greeting・ackVariants・progressPings など）/ TTS・STT・Slack・Attendee の設定をここに集約しています。`config.json.example` は emotion tag anchor 方式（S2-Pro 用）に揃えてあるので、コピーして変数を埋めれば動きます。

### LLM プロバイダ

| `llm.provider` / `LLM_PROVIDER` | 動作 |
|---|---|
| `openclaw` | 既定。OpenClaw Gateway 経由で SOUL / memory / skills / tools を利用 |
| `openai-compatible` | OpenAI 互換 API を直接利用。OpenClaw Gateway は不要 |

`openai-compatible` は、プレーンな LLM と組み込みのペルソナテンプレートで音声応答する縮退モードです。Gateway 未設定時の OSS としての最低保証であり、OpenClaw 固有の memory / skills / tools は利用できません。Claude モデルは OpenAI 互換プロキシ（例: LiteLLM）経由で利用します。Anthropic ネイティブアダプタはありません（[#114](https://github.com/caty-ai/meetmate/issues/114)）。

`config.json` 側で `openai-compatible` を選ぶ場合は `.env` の `LLM_PROVIDER` も合わせる（環境変数が `config.json` より優先）。`config.json` の `${...}` プレースホルダは**未解決（未設定・空欄）だと起動時にエラー終了する**ため、使わない機能の env（`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `SLACK_BOT_TOKEN` 等）も削除・空欄にせずダミー値のまま残す。残したくない場合は `config.json` から該当ブロックごと削除する。

`config.json` の `llm` スキーマは次のとおりです。

```json
{
  "llm": {
    "provider": "openclaw",
    "model": "openclaw",
    "temperature": 0.5,
    "maxTokens": 300,
    "historyMaxTurns": 12,
    "systemPrompt": "",
    "openaiCompatible": {
      "baseUrl": "",
      "apiKey": ""
    }
  }
}
```

`provider` / `temperature` / `maxTokens` / `openaiCompatible` の解決順は、セッションごとの overrides → agent 設定 → 環境変数 → `configJson.llm` → 既定値です。対応する環境変数は `LLM_PROVIDER`、`AGENT_TEMPERATURE`、`AGENT_MAX_TOKENS`、`OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_COMPATIBLE_API_KEY` です。`model` と `historyMaxTurns` は環境変数を参照せず、overrides → agent 設定 → `configJson.llm` → 既定値の順です。`openai-compatible` の `systemPrompt` は `overrides.prompt` → `configJson.llm.systemPrompt` → 組み込みペルソナの順で解決し、音声用ルールを付加して使います。

OpenAI 互換 API には `{baseUrl}/v1/chat/completions` を送信します。`baseUrl` のパスがすでに `/v1` で終わる場合は `/v1` を重ねません。未対応のプロバイダ名は警告後に `openclaw` へフォールバックします。

### MCP サーバー（コントロールプレーン）

薄い stdio MCP サーバーにより、LLM クライアント（Claude Code や他のエージェント）から会議参加を直接操作できます — 音声パイプライン本体は MCP のスコープ外のままです。登録:

```bash
claude mcp add ai-meet -- npx ai-meet mcp
```

環境変数: `AI_MEET_BASE_URL` が操作対象の REST API を指定（既定 `http://localhost:5005`）。`AI_MEET_JOIN_TOKEN` は任意で、`x-join-token` ヘッダと `joinToken` フィールドとして転送されます。`AI_MEET_JOIN_TIMEOUT_MS` は `join_meeting` の待ち時間（既定 60000 ms — join はサーバー側で最大 ~50 秒かかり得ます。他ツールは 15 秒）。

| ツール | 動作 |
|---|---|
| `join_meeting(meetingUrl, briefing?, conversationMode?)` | Meet / Zoom 会議に参加（`POST /join-meeting` を代理・WebSocket URL は自動導出） |
| `leave_meeting(sessionId?)` | アクティブセッション（または指定セッション）から退出 |
| `get_active_session()` | アクティブセッション一覧を JSON で取得 |
| `health()` | サービスヘルスチェック |

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
`.env` で `SONIOX_MAX_ENDPOINT_DELAY_MS=1000` を設定（未設定時は Soniox サーバー側既定の `2000`。必要なら `800`）してサーバーを再起動。途中で発話が区切られるようになったら `SONIOX_ENDPOINT_SENSITIVITY` を `0.0〜-0.2` に下げて調整します。詳細は [Soniox チューニング](docs/operations.md#stt-プロバイダ切替soniox-チューニング)。

**Q. Meet チャットへの投稿が失敗する**
絵文字・特殊文字が含まれると Attendee サーバー側で 400 拒否されます（"Message cannot contain emojis or rare script characters."）。送信失敗の warn は launchd 常駐時は `logs/meet-server.stderr.log` に出ます（素の `npm start` ではターミナルの stderr に出力）。まずそこを確認してください。

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
node --test                       # 全テスト（35 テストファイル）
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

実行ログは `logs/` 配下に出力されます。アプリ側の warn/error は `logs/meet-server.stderr.log`（launchd 常駐時。素の `npm start` ではターミナルに出力）、委譲ハーネスの metrics は `logs/metrics.jsonl` を参照してください。

## 開発ステータス

- **最新版**: `v7.9.0-rc.1`（2026-07-07・`GATEWAY_EVENTS_ENABLED=true` で実運用中）
- **安定版**: [`v7.8.0-stable`](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
- **進行中**: npm 配布・公開トラック（[#136](https://github.com/caty-ai/meetmate/issues/136) / [#107](https://github.com/caty-ai/meetmate/issues/107)）

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
