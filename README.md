# 🎙️ AI Meet Participant

AIエージェントをGoogle Meet / Zoomにリアルタイム参加させ、音声で対話するブリッジサーバー。
OpenClaw Gateway連携により、任意のエージェントを音声会議に接続可能。

> **現在の安定版: [`v7.5.0-stable`](https://github.com/caty-ai/meetmate/releases/tag/v7.5.0-stable) (2026-05-04)**
> Fish Audio S2-Pro + emotion tag anchor 方式で stabilize 済。

## 特徴
- Google Meet / Zoom 対応
- OpenClaw Gateway連携（SOUL/memory/skills/tools完全対応）
- ウェイクワード検出 + バージイン（割り込み）対応
- TTS: Fish Audio S2-Pro（emotion tag anchor 方式）
- STT: Deepgram
- LCM（Lossless Context Management）自動記録
- Slack連動（ステータス通知・サマリー・全文ログ）

## セットアップ

### 1. リポジトリのクローン
```bash
git clone <repo-url>
cd meetmate
npm install
```

### 2. `.env`（APIキー・シークレット）
```bash
cp .env.example .env
```

#### 必須
| 変数 | 用途 |
|---|---|
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL（例: `http://localhost:18789`） |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 認証トークン |
| `DEEPGRAM_API_KEY` | STT用 |
| `FISH_AUDIO_API_KEY` | TTS用 |
| `FISH_AUDIO_VOICE_ID` | TTS音声 ID（声のクローン） |
| `ATTENDEE_API_KEY` | Meet/Zoom Bot API |

#### 任意（デフォルトのまま運用可）
| 変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | `5005` | サーバーポート |
| `AGENT_LANG` | `ja` | 言語（`ja` / `en`） |
| `SLACK_BOT_TOKEN` | （未使用） | Slack 通知 |
| `SLACK_NOTIFY_CHANNEL` | | DM モードなら不要 |

詳細・緊急 rollback 用の env は[音声プロファイル](#音声プロファイル)を参照。

### 3. `config.json`（エージェント設定の単一ソース）
```bash
cp config.json.example config.json
```
- エージェント ID / 表示名 / ウェイクワード
- 固定文言（greeting / ackVariants / progressPings / exitFarewell / timeoutFallback）
- TTS / STT / Slack / Attendee の設定

`config.json.example` は **emotion tag anchor 方式（S2-Pro 用）** に揃えてあるので、コピーして変数を埋めれば即動きます。

### 4. アバター
`assets/avatar.png` にエージェントのアバター画像を配置。

### 5. 起動
```bash
npm start
```
ブラウザで http://localhost:5005 を開き、Meet/Zoom URL を貼り付けて「参加させる」をクリック。

## アーキテクチャ

**1エージェント = 1サーバーインスタンス。**
`config.json` + `.env` + `assets/avatar.png` だけで任意のエージェントが動作する。

### 音声パイプライン
```
STT(Deepgram) → ウェイクワード検出 → OpenClaw Gateway(LLM) → TTS(Fish Audio S2-Pro) → Meet/Zoom
```

### 主要モジュール
- `agent-profile.js`: エージェント設定解決
- `speech-policy.js`: NO_REPLY抑制・テキスト浄化
- `exit-handler.js`: 退出検出・クリーンアップ
- `pipeline.js`: 音声パイプライン制御
- `llm.js`: Gateway Chat Completions連携
- `stt.js`: Deepgram STT
- `tts-fish.js`: Fish Audio TTS

## 音声プロファイル

v7.5.0 以降、Fish Audio **S2-Pro** をデフォルトモデルにしています。S2-Pro は `[bracket]` + 自然言語タグ syntax を使い、タグなしの発話だと声質が暴走しやすいので、**全発話に必ず 1 個タグを入れる「アンカー方式」** で安定化しています。

### 既定タグ運用
- 通常の固定文言: `[soft voice]`（優しい声、デフォルトアンカー）
- 謝罪場面: `[empathetic, unhurried]`
- お別れ場面: `[warm]`
- LLM addendum でも「必ず 1 個」「迷ったら `[soft voice]`」を指示

### 緊急 rollback 用 env（既定運用では不要）
真実は code の default 1 箇所、env はあくまで escape hatch。

| env | 効果 |
|---|---|
| `FISH_AUDIO_MODEL=s1` | S1 model に戻す |
| `FISH_AUDIO_SPEED=0.9` | speech rate を 0.9 に（既定 1.0） |
| `ENABLE_IMMEDIATE_ACK=false` | always-ack を OFF |
| `LLM_RESPONSE_TIMEOUT_MS=0` | first-audio timeout を OFF |
| `FISH_AUDIO_RETRY_MAX=0` | Fish Audio 429/5xx retry を OFF |
| `TTS_GAP_MS=0` | TTS 息継ぎ gap を OFF |

## LCM（Lossless Context Management）

MeetセッションはOpenClawのLCMで自動記録。セッション終了時にingestされ、長期記憶に保存。

推奨設定: `ingestMode: "auto"`

## ライセンス
Private
