# 🐱 AI Meet Participant — Caty Voice

AIアシスタント「Caty（ケイティ）」がGoogle Meetにリアルタイム参加して音声で対話するアプリ。
加えて、**Twilio経由の電話発信**（Phone Transport）にも対応。
OpenClaw Gateway 連携により、Slack の Caty と **まったく同じ体験** を音声で提供。

## プロジェクト状況

| Phase | 内容 | ステータス |
|-------|------|-----------|
| v1 | Google Meet 音声対話（MVP） | ✅ 完了 |
| v2 Phase 1 | Twilio 電話発信（outbound call） | ✅ 完了 (2026-02-28) |
| v2 Phase 2 | Slack UI + 通話サマリー | ✅ 完了 (2026-02-28) |
| v2 Phase 3 | マルチエージェント展開（スキル化） | 📋 計画中 |
| v2 Phase 4 | 着信対応 + IVR | 📋 計画中 |

**最新コミット:** `18007ab` (Phase 2 complete)

## アーキテクチャ

### Google Meet Transport (port 5005)
```
Google Meet ←→ Attendee Bot (hosted)
                    ↕ WebSocket (PCM audio)
              Bridge Server (Node.js, port 5005)
              ├── Deepgram STT (Nova 3) — 音声認識
              ├── OpenClaw Gateway — LLM + ツール + メモリ
              └── Fish Audio TTS (S1) — 音声合成 + 感情表現
```

### Twilio Phone Transport (port 5006) — Phase 1 完了
```
Twilio (PSTN) ←→ ngrok (https/wss)
                       ↕
              Twilio Bridge (Node.js, port 5006)
              ├── /call-me — 発信 API (Bearer auth)
              ├── /twilio/voice — TwiML 応答 (署名検証)
              ├── /twilio/stream/<stoken> — Media Stream WS
              │     ├── stoken: 短TTL + 単回消費 (upgrade gate)
              │     └── callSid: activeCalls照合 (start event gate)
              ├── Deepgram STT (Nova 3, keywords fallback)
              ├── OpenClaw Gateway — LLM + ツール + メモリ
              └── Fish Audio TTS → μ-law 変換 → Twilio
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
- 📝 会話ログ自動保存 (`logs/` + `memory/` + `memory/calls/`)
- 📊 Slack 1メッセージ上書きステータス（受付→発信中→通話中→完了）
- 📋 通話後サマリー自動投稿（要約+決定事項+TODO）
- 📜 全文ログ Slack スレッド投稿
- 🚪 Meet 退出コマンド検知（「退出して」「今日はここまで」等）
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
| `SLACK_NOTIFY_CHANNEL` | 既定の通知先チャンネル ID（フォールバック） | — |
| `SLACK_SUMMARY_CHANNEL` | サマリー/全文ログ投稿先（未設定時は `SLACK_NOTIFY_CHANNEL`） | — |
| `SLACK_STATUS_CHANNEL` | ステータス投稿先（未設定時は `SLACK_SUMMARY_CHANNEL` → `SLACK_NOTIFY_CHANNEL`） | — |
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
│   ├── index.js          # Meet Bridge: HTTP + WebSocket + セッション管理 (port 5005)
│   ├── config.js         # 設定管理（環境変数読み込み）
│   ├── pipeline.js       # オーケストレーター（STT → LLM → TTS + 退出コマンド検知）
│   ├── session-events.js # セッションライフサイクル状態機械（Phase 2）
│   ├── slack-notifier.js # Slack ステータス通知 + サマリー投稿（Phase 2）
│   ├── summarizer.js     # LLM 会話サマリー生成（Phase 2）
│   ├── stt.js            # Deepgram Nova 3 ストリーミング STT（keywords fallback付き）
│   ├── llm.js            # LLM（OpenClaw Gateway / OpenRouter デュアル）
│   ├── tts-fish.js       # Fish Audio REST TTS（PCM ストリーミング）
│   ├── transport-twilio/
│   │   ├── twilio-bridge.js    # Twilio Bridge: HTTP + WS (port 5006) — 発信専用
│   │   ├── call-manager.js     # Twilio REST API 発信管理
│   │   └── twilio-adapter.js   # μ-law ↔ PCM 変換
│   └── prompts/
│       └── caty-system.md  # 音声用システムプロンプト（フォールバック用）
├── public/
│   └── index.html        # Web UI（Meet URL 入力画面）
├── assets/
│   └── caty-avatar.png   # Caty アバター（自動ダウンロード/キャッシュ）
├── logs/                 # 会話ログ（自動生成）
├── docs/
│   ├── architecture.md             # 詳細アーキテクチャ
│   ├── setup-guide.md              # セットアップ手順書
│   ├── twilio-phase1-spec.md       # Twilio Phase 1 仕様書
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

### ✅ 完了

| Phase | 内容 | 完了日 |
|-------|------|--------|
| v1 | MVP: Google Meet 音声対話 | — |
| v1 | Fish Audio S1 TTS（感情表現 64種類以上） | — |
| v1 | OpenClaw Gateway 連携（フル Caty 体験） | — |
| v1 | ウェイクワード検出（fuzzy matching） | — |
| v1 | アバター表示・会話ログ保存・エコー防止 | — |
| v2 Phase 1 | **Twilio 電話発信**（outbound call） | 2026-02-28 |
| v2 Phase 1 | Deepgram STT keywords fallback | 2026-02-28 |
| v2 Phase 1 | Path-based stream token（セキュリティ強化） | 2026-02-28 |
| v2 Phase 2 | **Slack 1メッセージ上書きステータス** | 2026-02-28 |
| v2 Phase 2 | **通話後サマリー自動投稿** | 2026-02-28 |
| v2 Phase 2 | **全文ログ Slack スレッド投稿** | 2026-02-28 |
| v2 Phase 2 | **Meet 退出コマンド検知** | 2026-02-28 |
| v2 Phase 2 | **通話ログファイル保存 + memory_search 対応** | 2026-02-28 |

### ✅ v2 Phase 2 — Slack UI + 通話サマリー（完了 2026-02-28）

| # | 内容 | ステータス |
|---|------|-----------|
| 1 | **セッションライフサイクル状態機械** | ✅ `session-events.js` |
| 2 | **Slack 1メッセージ上書きステータス** | ✅ `slack-notifier.js` |
| 3 | **通話後サマリー自動投稿** | ✅ `summarizer.js` |
| 4 | **Twilio統合（lifecycle + Slack + summary）** | ✅ |
| 5 | **Meet統合（lifecycle + Slack + 退出コマンド検知）** | ✅ |
| 6 | **全文ログ Slack スレッド投稿** | ✅ |
| 7 | **通話ログファイル保存（JSON + MD）** | ✅ |
| 8 | **memory/calls/ 保存（memory_search 対応）** | ✅ |

### 🔜 次のステップ

| # | 内容 | 優先度 |
|---|------|--------|
| 1 | **専用チャンネル化** — 通話サマリー/ログの投稿先を専用チャンネルに分離 | 高（軽め） |
| 2 | **UX改善** — 割り込み抑制(barge-in) + 即レスパターン + 無音ガード | 高（重め） |
| 3 | **Phase 3: スキル化** — 全エージェント展開 | 中 |

### UX改善 Issue（#8〜#10）

| Issue | 内容 | 詳細 |
|-------|------|------|
| #8 | **Barge-in** | ユーザー発話検知でTTS即停止 + 発話終了後0.5秒バッファ |
| #9 | **即レスパターン** | 0.5秒以内に「了解！」→ 処理中フィードバック → 本回答 |
| #10 | **無音ガード** | 長時間処理中に10秒ごとの生存メッセージ |

### 📋 v2 Phase 3 — マルチエージェント展開

| # | 内容 | 詳細 |
|---|------|------|
| 1 | **スキル化** | Twilio電話機能をOpenClawスキルとして切り出し（全エージェント共用） |
| 2 | **全エージェント対応** | Claire / Alec / Zoe / Eidra もそれぞれ独自の声で電話可能 |
| 3 | **ボイスクローニング** | Fish Audio で各エージェント固有の声を作成（15秒サンプルで生成） |
| 4 | **Agent Router** | 共有 Voice Bridge + 名前呼びでエージェント自動振り分け |

### 📋 v2 Phase 4 — 着信対応 + 拡張

| # | 内容 | 詳細 |
|---|------|------|
| 1 | **着信対応** | Twilio番号への着信 → 適切なエージェントにルーティング |
| 2 | **IVR** | 音声メニュー（「ケイティに繋ぐ」等） |
| 3 | **スケジュール発信** | cronやSlackコマンドで定時発信 |
| 4 | **VOICEVOX 対応** | ローカル TTS として VOICEVOX をサポート |

### マルチエージェント構成（v2 Phase 3 目標）

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
    │ :18789   │ │ :18789   │ │ :19009   │
    └──────────┘ └──────────┘ └──────────┘
```

## ライセンス

Private — shojikumaru
