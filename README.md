# 🐱 AI Meet Participant — Caty Voice

AIアシスタント「Caty（ケイティ）」がGoogle Meetにリアルタイム参加して音声で対話するアプリ。
**Twilio経由の電話発信**（Phone Transport）にも対応。
OpenClaw Gateway 連携により、Slack の Caty と **まったく同じ体験** を音声で提供。

## プロジェクト状況

| Phase | 内容 | ステータス |
|-------|------|-----------|
| v1 | Google Meet 音声対話（MVP） | ✅ 完了 |
| v2 Phase 1 | Twilio 電話発信（outbound call） | ✅ 完了 (2026-02-28) |
| v2 Phase 2 | Slack UI + 通話サマリー | ✅ 完了 (2026-02-28) |
| v2 UX | Barge-in + タイムアウト + Warm-up + 統合サーバー | ✅ 完了 (2026-03-01) |
| v2 Phase 3 | マルチエージェント展開（スキル化） | 📋 計画中 |
| v2 Phase 4 | 着信対応 + IVR | 📋 計画中 |

**最新コミット:** `9ce77a3` (unified server)

## アーキテクチャ

### 統合サーバー（推奨）

Meet と Twilio を **1つのサーバー・1ポート** で同時運用。ngrok 1本で両方通る。

```
                    ┌──────────────────────────────────┐
                    │  Unified Server (port 5005)       │
                    │  src/server.js                    │
                    │                                   │
  Google Meet ←───→ │  /join-meeting, / → Meet Routes   │
  (Attendee Bot)    │  WS /?sid=        → Meet Audio    │
                    │                                   │
  Twilio (PSTN) ←─→ │  /call-me         → Twilio Routes │
  (ngrok)           │  /twilio/*        → Twilio Audio  │
                    │                                   │
                    │  共通パイプライン:                  │
                    │  Deepgram STT → OpenClaw → Fish TTS│
                    └──────────────────────────────────┘
```

### URL ルーティング

| パス | 処理 |
|------|------|
| `GET /` | Meet UI (index.html) |
| `GET /info` | Meet info JSON |
| `POST /join-meeting` | Meet bot 起動 |
| `WS /?sid=xxx` | Meet 音声ストリーム |
| `GET /health` | Twilio health check |
| `POST /call-me` | Twilio 発信 |
| `POST /twilio/voice` | Twilio TwiML 応答 |
| `POST /twilio/status` | Twilio ステータスコールバック |
| `WS /twilio/stream/<token>` | Twilio 音声ストリーム |

### OpenClaw Gateway 連携

Bridge Server は OpenClaw Gateway (`/v1/chat/completions`) を通じて LLM を呼び出す。
これにより Meet/電話の Caty は Slack の Caty と **同一のエージェント**:

| 機能 | 説明 |
|------|------|
| 人格 | SOUL.md / AGENTS.md がそのまま適用 |
| 記憶 | memory_search で過去の会話を想起 |
| スキル | Slack連携、Web検索、GitHub操作、カレンダー、Todoist 等 |
| セッション管理 | OpenClaw が会話履歴を自動管理 |
| ツール委譲 | 軽い処理→直接実行、重い処理→sessions_spawn |

Gateway 未設定時は OpenRouter（直接 Claude API）にフォールバック。

## 機能一覧

### コア機能
- 🎙️ リアルタイム音声対話（日本語 / 英語）
- 🐟 Fish Audio S1 による自然な日本語音声合成
- 🎭 感情タグ対応（(happy), (nervous), (excited) 等 64種類以上）
- 🔗 OpenClaw Gateway 連携（SOUL.md + memory + 全スキル・ツール）
- 🔔 ウェイクワード検出（名前呼びで反応、ミーティング中の選択的応答）
- 🖼️ Caty アバター表示（Slack アイコンを自動使用）
- 📝 会話ログ自動保存 (`logs/` + `memory/calls/`)
- 🔄 OpenRouter フォールバック（Gateway 未設定時）

### UX 改善（v2）
- ⚡ **Barge-in**: ユーザー発話検知で TTS 即停止 + 残音フラッシュ
- 🎯 **ノイズフィルター**: 短い/低信頼度の interim をバージイン対象外に（`BARGE_IN_CONFIDENCE_MIN`）
- ⏱️ **LLM タイムアウト**: 応答遅延時の自動リカバリ + サブエージェント委譲（`LLM_RESPONSE_TIMEOUT_MS`）
- 🔥 **Gateway Warm-up**: 通話前にセッションを事前ロード（初回応答の高速化）
- 💬 **処理中 Ping**: 長時間処理中のつなぎフィードバック（上限 `PROGRESS_PING_MAX`）
- 🛡️ エコーループ防止

### Slack 連携（Phase 2）
- 📊 Slack 1メッセージ上書きステータス（受付→発信中→通話中→完了）
- 📋 通話後サマリー自動投稿（要約+決定事項+TODO）
- 📜 全文ログ Slack スレッド投稿
- 🚪 Meet 退出コマンド検知（「退出して」「今日はここまで」等）

### ツール委譲（音声通話中）
- 軽い処理（memory_search, 天気, 単発検索）→ 直接実行
- 重い処理（GitHub, exec, Deep Research）→ sessions_spawn で委譲
- タイムアウト時 → 自動でサブエージェントに切り替え

## クイックスタート

### 必要なもの

| サービス | 用途 | 必須 |
|---------|------|------|
| [Deepgram](https://console.deepgram.com/) | STT（音声認識） | ✅ |
| [Attendee](https://app.attendee.dev/) | Google Meet Bot | ✅ (Meet用) |
| [Fish Audio](https://fish.audio/) | TTS（音声合成） | ✅ |
| [ngrok](https://ngrok.com/) | WebSocket 外部公開 | ✅ |
| OpenClaw Gateway | フル Caty 体験 | 推奨 |
| [Twilio](https://www.twilio.com/) | 電話発信 | △ (電話用) |
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
# → Meet も Twilio もこの1本で OK
```

### 3. サーバー起動

```bash
# 統合サーバー（推奨 — Meet + Twilio 同時）
npm start
# or: node src/server.js

# Meet 単体起動
npm run start:meet

# Twilio 単体起動
npm run start:twilio
```

起動ログ:
```
🚀  Unified Meet + Twilio Server started: http://localhost:5005
📡  HTTP routing: /twilio/*,/call-me,/health -> Twilio, others -> Meet
🔌  WS routing: /twilio/stream/* -> Twilio, others -> Meet
🌐  ngrok WSS URL 検出: wss://xxx.ngrok-free.app
```

### 4. Meet に参加

1. ブラウザで `http://localhost:5005` を開く
   - Tailscale 経由: `http://<tailscale-ip>:5005`
2. Google Meet URL を貼り付け
3. 「🚀 Meetに参加させる」をクリック
4. 約30秒で Caty が Meet に参加して挨拶

### 5. 電話をかける

```bash
curl -X POST http://localhost:5005/call-me \
  -H "Authorization: Bearer $TWILIO_CALL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"to": "+81XXXXXXXXXX"}'
```

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

### UX チューニング

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `LLM_RESPONSE_TIMEOUT_MS` | LLM 応答タイムアウト（ms） | `25000` |
| `PROGRESS_PING_MAX` | 処理中 Ping の最大回数 | `3` |
| `BARGE_IN_CONFIDENCE_MIN` | Barge-in 発火の信頼度閾値 | `0.45` |

### ウェイクワード

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `WAKE_MODE` | `off`（全発話に応答） / `wake`（名前呼び応答） | `off` |
| `WAKE_WORDS` | ウェイクワード（カンマ区切り） | `ケイティ,けいてぃ,caty,katie,ケイケイ` |

### Twilio Phone Transport

| 変数 | 説明 | 必須 |
|------|------|------|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID | ✅ |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | ✅ |
| `TWILIO_PHONE_NUMBER` | Twilio 発信元番号（E.164） | ✅ |
| `TWILIO_CALL_SECRET` | `/call-me` API Bearer トークン | ✅ |
| `TWILIO_PUBLIC_URL` | ngrok 等の公開 HTTPS URL | ✅ |
| `TWILIO_ALLOWED_NUMBERS` | 発信先許可番号（カンマ区切り、E.164） | ✅ |

### Slack 通知（Phase 2）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `SLACK_BOT_TOKEN` | Slack Bot Token (xoxb-...) | — |
| `SLACK_NOTIFY_CHANNEL` | 既定の通知先チャンネル ID | — |
| `SLACK_SUMMARY_CHANNEL` | サマリー/全文ログ投稿先 | `SLACK_NOTIFY_CHANNEL` |
| `SLACK_STATUS_CHANNEL` | ステータス投稿先 | `SLACK_SUMMARY_CHANNEL` |
| `SLACK_NOTIFY_ENABLED` | Slack 通知の有効/無効 | `true` |
| `SUMMARY_ENABLED` | 通話後サマリーの有効/無効 | `true` |

### セキュリティ

| 変数 | 説明 |
|------|------|
| `JOIN_SHARED_TOKEN` | `/join-meeting` 認証トークン |
| `WS_SHARED_TOKEN` | WebSocket 認証トークン |

### Twilio セキュリティモデル

| レイヤー | 保護対象 | 方式 |
|---------|---------|------|
| `/call-me` | 発信API | Bearer token (`TWILIO_CALL_SECRET`) |
| `/twilio/voice` | TwiML応答 | Twilio署名検証 + `vtoken`(短TTL/単回) + `Direction=outbound-api` + `callSid` activeCalls照合 |
| `/twilio/stream/<stoken>` | WS接続 | `stoken`(短TTL/単回/callSid紐付け) — path-based |
| WS `start` event | 通話紐付け | `callSid` activeCalls照合 + token.meta.callSid一致（2段ガード） |

## ファイル構成

```
meetmate/
├── src/
│   ├── server.js              # 統合エントリポイント（HTTP + WS ルーティング）★推奨
│   ├── index.js               # Meet 単体 Bridge（port 5005、後方互換）
│   ├── config.js              # 設定管理（環境変数読み込み）
│   ├── pipeline.js            # オーケストレーター（STT → LLM → TTS + 退出検知 + タイムアウト）
│   ├── session-events.js      # セッションライフサイクル状態機械
│   ├── slack-notifier.js      # Slack ステータス通知 + サマリー投稿
│   ├── summarizer.js          # LLM 会話サマリー生成
│   ├── gateway-warmup.js      # Gateway セッション事前ウォームアップ
│   ├── stt.js                 # Deepgram Nova 3 ストリーミング STT（keywords fallback付き）
│   ├── llm.js                 # LLM（OpenClaw Gateway / OpenRouter デュアル）
│   ├── tts-fish.js            # Fish Audio REST TTS（PCM ストリーミング）
│   ├── transport-meet/
│   │   └── meet-routes.js     # Meet HTTP/WS ハンドラ（統合サーバー用）
│   ├── transport-twilio/
│   │   ├── twilio-routes.js   # Twilio HTTP/WS ハンドラ（統合サーバー用）
│   │   ├── twilio-bridge.js   # Twilio 単体 Bridge（port 5006、後方互換）
│   │   ├── call-manager.js    # Twilio REST API 発信管理
│   │   └── twilio-adapter.js  # μ-law ↔ PCM 変換
│   └── prompts/
│       └── caty-system.md     # 音声用システムプロンプト（フォールバック用）
├── public/
│   └── index.html             # Web UI（Meet URL 入力画面）
├── assets/
│   └── caty-avatar.png        # Caty アバター（自動ダウンロード/キャッシュ）
├── logs/                      # 会話ログ（自動生成）
├── docs/
│   ├── architecture.md
│   ├── setup-guide.md
│   ├── twilio-phase1-spec.md
│   ├── phase2-openclaw-gateway-integration.md
│   ├── task-reimplement-spec.md
│   ├── task-timeout-handoff-spec.md
│   └── task-unified-server-spec.md
├── .env.example
├── package.json
└── README.md
```

## 感情表現

Fish Audio S1 の感情タグにより、Caty は文脈に応じて声のトーンを変化。
OpenClaw の VOICE_SYSTEM_ADDENDUM で自動的に感情タグ付与を指示。

### 基本感情（24種類）
`(happy)` `(sad)` `(angry)` `(excited)` `(calm)` `(nervous)` `(confident)` `(surprised)` `(satisfied)` `(delighted)` `(scared)` `(worried)` `(upset)` `(frustrated)` `(depressed)` `(empathetic)` `(embarrassed)` `(disgusted)` `(moved)` `(proud)` `(relaxed)` `(grateful)` `(curious)` `(sarcastic)`

### 上級感情（25種類）
`(disdainful)` `(unhappy)` `(anxious)` `(hysterical)` `(indifferent)` `(uncertain)` `(doubtful)` `(confused)` `(disappointed)` `(regretful)` `(guilty)` `(ashamed)` `(jealous)` `(envious)` `(hopeful)` `(optimistic)` `(pessimistic)` `(nostalgic)` `(lonely)` `(bored)` `(contemptuous)` `(sympathetic)` `(compassionate)` `(determined)` `(resigned)`

### トーン・エフェクト
`(in a hurry tone)` `(shouting)` `(screaming)` `(whispering)` `(soft tone)` `(laughing)` `(chuckling)` `(sobbing)` `(crying loudly)` `(sighing)` `(groaning)` `(panting)` `(gasping)` `(yawning)` `(snoring)`

> ⚠️ **注意**: ボイスモデルによっては一部のタグが音声に反映されず、テキストとして読み上げられる場合があります。使用するボイスモデルでの動作確認を推奨します。

## ウェイクワード検出

`WAKE_MODE=wake` を設定すると、名前を呼ばれた時だけ応答:

```bash
WAKE_MODE=wake
WAKE_WORDS=ケイティ,けいてぃ,caty,katie,ケイケイ
```

- 「ケイティ、今日の予定は？」→ ✅ 応答
- 「今日の天気はどう？」→ ❌ スルー（名前なし）

マルチエージェント参加時に必須の機能。

## コミット履歴（v2 UX 改善）

```
9ce77a3  feat: unified server - single port for Meet + Twilio
e6362ac  feat: sequential warm-up for Twilio
04ebaf6  feat: Gateway session pre-warmup for faster first response
0870d1b  feat: voice tool delegation addendum + timeout auto-handoff
c6fc950  feat: add LLM response timeout, progress ping max, barge-in noise filter
b431262  feat: add barge-in, immediate ack, processing keepalive pings
```

## ロードマップ

### ✅ 完了

| Phase | 内容 | 完了日 |
|-------|------|--------|
| v1 | MVP: Google Meet 音声対話 | — |
| v1 | Fish Audio S1 TTS（感情表現 64種類以上） | — |
| v1 | OpenClaw Gateway 連携（フル Caty 体験） | — |
| v1 | ウェイクワード検出（fuzzy matching） | — |
| v1 | アバター表示・会話ログ保存・エコー防止 | — |
| v2 P1 | Twilio 電話発信（outbound call） | 2026-02-28 |
| v2 P2 | Slack 1メッセージ上書きステータス | 2026-02-28 |
| v2 P2 | 通話後サマリー自動投稿 + 全文ログ | 2026-02-28 |
| v2 P2 | Meet 退出コマンド検知 | 2026-02-28 |
| v2 UX | Barge-in + 即レスパターン | 2026-03-01 |
| v2 UX | LLM タイムアウト + 自動サブエージェント委譲 | 2026-03-01 |
| v2 UX | Gateway Warm-up（初回応答高速化） | 2026-03-01 |
| v2 UX | ツール委譲ルール（軽い→直接、重い→spawn） | 2026-03-01 |
| v2 UX | 統合サーバー（Meet+Twilio 1ポート） | 2026-03-01 |

### 🔜 次のステップ

| # | 内容 | 優先度 |
|---|------|--------|
| 1 | **感情タグ精査** — 現ボイスモデルで使えるタグの確認・最適化 | 高 |
| 2 | **Zoom テスト** — Zoom meeting 参加の動作確認 | 高 |
| 3 | **Phase 3: スキル化** — 全エージェント展開（ボイスクローニング） | 中 |
| 4 | **プロアクティブ通知** — サブエージェント完了時の自発音声通知 | 中 |
| 5 | **Phase 4: 着信対応 + IVR** | 低 |

### 📋 v2 Phase 3 — マルチエージェント展開

| # | 内容 |
|---|------|
| 1 | **スキル化** — Twilio電話機能をOpenClawスキルとして切り出し |
| 2 | **全エージェント対応** — Claire / Alec / Zoe / Eidra も独自の声で電話可能 |
| 3 | **ボイスクローニング** — Fish Audio で各エージェント固有の声を作成 |
| 4 | **Agent Router** — 共有 Voice Bridge + 名前呼びでエージェント自動振り分け |

### 📋 v2 Phase 4 — 着信対応 + 拡張

| # | 内容 |
|---|------|
| 1 | **着信対応** — Twilio番号への着信 → エージェントにルーティング |
| 2 | **IVR** — 音声メニュー（「ケイティに繋ぐ」等） |
| 3 | **スケジュール発信** — cron/Slackコマンドで定時発信 |
| 4 | **VOICEVOX 対応** — ローカル TTS として VOICEVOX をサポート |

## ライセンス

Private — shojikumaru
