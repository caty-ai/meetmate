# 🎙️ AI Meet Participant — Multi-Agent Voice System

AIエージェント（Caty, Claire, Sebas, Alec, Zoe, Eidra）がGoogle Meet / Zoom にリアルタイム参加して音声対話。
OpenClaw Gateway 連携により、Slack と **まったく同じ体験** を音声で提供。

> **📞 Twilio 電話機能は独立リポジトリ `private-telephony-repo` に分離予定**
> 詳細は [電話独立化計画](#電話独立化計画) を参照。

## プロジェクト状況

| Phase | 内容 | ステータス |
|-------|------|-----------|
| v1 | Google Meet 音声対話（MVP） | ✅ 完了 |
| v2 Phase 1 | Twilio 電話発信 | ✅ 完了 |
| v2 Phase 2 | Slack UI + 通話サマリー | ✅ 完了 |
| v2 UX | Barge-in + タイムアウト + Warm-up + 統合サーバー | ✅ 完了 |
| v2 Zoom | Zoom Meeting 対応 + Web UI 改善 | ✅ 完了 |
| v2 Phase 3 | マルチエージェント対応 + 独立インスタンス | ✅ 完了 (2026-03-01) |
| v2 Phase 3.1 | エージェント別ブランディング + バグ修正 | ✅ 完了 (2026-03-02) |
| v3 | Twilio 電話機能の独立化 (`private-telephony-repo`) | 📋 計画中 |

## 完了事項（v2 Phase 3.1 時点）

### マルチエージェント
- 6エージェント設定済み（agents.json）: Caty, Alec, Zoe, Eidra, Claire, Sebas
- ウェイクワードによるエージェント切替（グループモード）
- 1:1 モード / グループモードの切替 UI
- per-agent セッション ID（`meet-{sid}-{agentId}`）で履歴分離
- Gateway chatCompletions 有効化済み（全6エージェント）

### 独立インスタンス
- `AGENT_ID` 環境変数によるシングルエージェントモード
- ngrok カスタムドメイン対応（`--domain=xxx.ngrok.dev`）
- per-agent ボットアバター（`avatarUrl` in agents.json）
- per-agent Slack Bot Token（`${AGENT_ID}_SLACK_BOT_TOKEN`）
- per-agent Gateway URL（`${ENV_VAR}` 構文で環境別 URL 対応）
- Web UI 動的ブランディング（タイトル/サブタイトル/Bot名がエージェント毎に変化）
- 会話モード（ウェイクモード）をシングルエージェントモードでも表示

### UX
- Fish Audio TTS（感情タグ9種対応）
- Barge-in（割り込み検出 + ノイズフィルタ）
- 即時応答（ack）+ プログレスping
- LLM タイムアウト → 自動サブエージェント委譲
- Gateway ウォームアップ（セッション開始前に SOUL/MEMORY プリロード）
- 通話サマリー + 全文ログ Slack 投稿

### セキュリティ
- `${ENV_VAR}` 構文でトークン管理（agents.json に平文トークンなし）
- 平文トークン検出時の警告ログ
- `JOIN_SHARED_TOKEN` / `WS_SHARED_TOKEN` による認証

## デプロイ構成

### Mac mini（メイン）
```
your-domain.ngrok.app → localhost:5005
├── デフォルト: ケイティ
├── ウェイクワード切替: アレク / ゾーイ / アイドラ
├── Twilio 電話ブリッジ（※ 今後分離予定）
└── Gateway: Caty(:18789) Alec(:19009) Zoe(:19100) Eidra(:19200)
```

### MacBook Pro（Claire / Sebas）
```
your-domain.ngrok.dev → localhost:5005  (AGENT_ID=claire)
your-domain.ngrok.dev  → localhost:5006  (AGENT_ID=sebas)
└── Gateway: Claire(:18789) Sebas(:19011)
```

## セットアップ

```bash
git clone https://github.com/caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env  # 必要な API キーを設定
npm start             # http://localhost:5005
```

### 環境変数（必須）
| 変数 | 説明 |
|------|------|
| `DEEPGRAM_API_KEY` | Deepgram STT |
| `FISH_AUDIO_API_KEY` | Fish Audio TTS |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway トークン |
| `ATTENDEE_API_KEY` | Attendee API（Meet/Zoom ボット） |

### 環境変数（オプション）
| 変数 | 説明 |
|------|------|
| `AGENT_ID` | シングルエージェントモード（例: `claire`） |
| `PORT` | サーバーポート（デフォルト: 5005） |
| `SLACK_BOT_TOKEN` | Slack 通知用 Bot トークン |
| `SLACK_NOTIFY_CHANNEL` | Slack 通知チャンネル |
| `${AGENT_ID}_SLACK_BOT_TOKEN` | エージェント別 Slack トークン |
| `${AGENT_ID}_GATEWAY_URL` | エージェント別 Gateway URL |
| `${AGENT_ID}_GATEWAY_TOKEN` | エージェント別 Gateway トークン |
| `TWILIO_*` | Twilio 設定（電話機能、分離予定） |

## 感情タグ（Fish Audio TTS）

| タグ | 用途 | 使用頻度 |
|------|------|---------|
| `(calm)` | 説明・落ち着いた話 | 61% |
| `(happy)` | 挨拶・良い報告 | 16% |
| `(curious)` | 質問・興味 | 10% |
| `(soft tone)` | やわらかい | 8% |
| `(excited)` | テンション高い | 3% |
| `(nervous)` | 緊張 | <1% |
| `(grateful)` | 感謝 | <1% |
| `(laughing)` | 笑い | <1% |
| `(confident)` | 自信 | <1% |

## 電話独立化計画

### 背景
Meet/Zoom のボット参加と Twilio の電話は性質が異なる。独立させることで:
- 片方の変更がもう片方に影響しない
- デプロイ/障害切り分けが容易
- 電話固有の仕様（briefing 必須、アウトバウンドのみ）を自由に実装可能

### 方針
- **Shared nothing**: コード共有なし、完全独立
- **コピー → 削る**: リライトせず、外科的に不要部分を削除
- **アウトバウンドのみ**: インバウンド/IVR は将来検討
- **briefing 必須**: 電話の要件情報を必須パラメータにする

### 進め方
1. `private-telephony-repo` リポ作成（現行 Twilio 一式をコピー）
2. 疎通確認（`/health` + `/call-me`）
3. 実通話テスト（barge-in/timeout/Slack通知/サマリー）
4. Meet/Zoom/HTML/assets を削除
5. pipeline.js からマルチエージェント機能を外科的削除
6. 本リポ（`meetmate`）から Twilio を削除

### レビュー結果
- Alec: GO（技術面OK、outbound-only方針に同意）
- Zoe: GO（UX全項目維持可能、`summarizer.js` 追加必須）
- Eidra: GO（shared-nothing安全、移植→削除の順で）

## 残タスク

### このリポ（Meet/Zoom）
- [ ] Twilio 機能の削除（`private-telephony-repo` 完成後）
- [ ] LaunchAgent plist for MBP servers + ngrok
- [ ] Token ローテーション（Alec のトークン露出分）
- [ ] Phase 3.1: Speech queue management（マルチエージェント同時発話管理）
- [ ] stickyMode（ウェイクワード省略での連続会話）

### 新リポ（Phone）— v3 チャンネルで実施
- [ ] `private-telephony-repo` リポ作成
- [ ] briefing 必須化
- [ ] アウトバウンドのみに制限
- [ ] pipeline.js シンプル化（マルチエージェント削除）
- [ ] `.env.example` 最小化
- [ ] README 作成
- [ ] E2E テスト

## コミット履歴（Phase 3 〜 3.1）

| Hash | 内容 |
|------|------|
| `44a5867` | feat: per-agent Slack bot token |
| `4d5fef4` | fix: single-agent UI + plaintext token warning |
| `68de2a9` | fix: per-agent avatar + wake words + AGENT_ID warning |
| `048a6e0` | fix: gatewayUrl env var support + error logging |
| `8d96e68` | fix: per-agent branding + hasAgentSelection bug |
| `b41befb` | docs: README rewrite for Phase 3 |
| `65f4208` | fix: make Twilio optional |
| `1fd8e6c` | feat: single-agent mode + ngrok custom domain |
| `96fb734` | fix: Claire/Sebas via SSH tunnel |
| `3b99723` | feat: per-agent Attendee API keys |
| `ea27bec` | fix: enable chatCompletions on all gateways |
| `a24a69d` | feat: voice IDs for all agents |
| `34daec4` | feat: multi-agent support (Phase 3) |

## ライセンス

Private — shojikumaru
