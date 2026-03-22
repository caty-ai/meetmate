# 🎙️ AI Meet Participant — Multi-Agent Voice System

AIエージェント（Caty, Claire, Sebas, Alec, Zoe, Eidra）がGoogle Meet / Zoom にリアルタイム参加して音声対話。
OpenClaw Gateway 連携により、Slack と **まったく同じ体験** を音声で提供。

> **📞 Twilio 電話機能は独立リポジトリ [`private-telephony-repo`](https://example.com/private-repo) に分離済み**

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
| v3 | Twilio 電話機能の独立化 (`private-telephony-repo`) | ✅ 完了 |
| v4 | Recall AI 移行 + ライブアバター + 仕上げ | 🚧 進行中 |
| LCM 最適化 | Lossless Claw auto モード対応（stream:true 復帰 + ingest 最適化） | ✅ 完了 (2026-03-23) |

## v4 ロードマップ

### A. 既存の仕上げ
- [x] ① meetmate から Twilio コード削除（`transport-twilio/` 除去）
- [ ] ② Meet/Zoom の「最初の挨拶」と「最後の処理」の被り修正

### B. Recall AI 移行 + ライブアバター
- [ ] ③ Attendee → Recall AI 移行（カメラ + スクリーンシェア同時制御）
- [ ] ④ ライブアバター実装（HeyGen 連携・リップシンク）
- [ ] ⑤ 映像モード切替（音声コマンドでアバター ⇔ 静止画）

### C. Twilio 電話 (`private-telephony-repo`)
- [ ] ⑥ S2S モード — 営業用エージェント（ゲートウェイなし・ナレッジベースのみ）
- [ ] ⑦ ゲートウェイモード — Caty たち用（現行ベースの拡張）

### D. 運用基盤
- [ ] ⑧ private-telephony-repo の本番整備（テスト・CI/CD・デーモン化）

#### アーキテクチャ方針（v4 で決定）
- **社内 AI 家族（Caty/Claire/Alec…）** → ゲートウェイ経由（ツール・memory・スキル活用）
- **営業・外部対応エージェント** → S2S + ナレッジのみ（軽量・安全・高速・情報漏洩リスクゼロ）

## LCM（Lossless Claw）最適化について

Meet の Chat Completions API 経由セッションでは、OpenClaw の LCM（Lossless Context Management）プラグインが
メッセージを記録・圧縮する。LCM の `ingestMode` 設定が Meet の動作に影響する：

| ingestMode | 動作 | Meet での挙動 |
|---|---|---|
| `normal` | 毎ターン自動 ingest | ⚠️ tool_result 重複エラーが発生しうる |
| `tag-only` | `[[[lcm:ingest]]]` タグ検出時のみ ingest | ✅ Meet は自動ではタグを送らないため安全 |
| `auto` | DM=normal / チャンネル・Meet=tag-only | ✅ 推奨。Meet は自動で tag-only になる |

**推奨設定:** `ingestMode: "auto"`（2026-03-23〜）

### 経緯
1. LCM `normal` モードで Meet の2ターン目以降が空レスポンスになる問題が発生
2. `tag-only` モードで回避 → しかし DM でも手動タグが必要になり不便
3. `auto` モードを新設：sessionKey パターンで DM/チャンネル/Meet を自動判定
4. `stream:true` に復帰（Gateway ストリーミング障害は別途解消済み）

### 関連コミット
- `614377c` — stream:false 暫定対応（LCM ingest 用）
- `fd30c52` — LCM ingest タイムアウト延長
- `04f2c04` — ハードタイムアウト削除 + Slack モニタリング

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

## 電話独立化（完了）

Twilio 電話機能は [`private-telephony-repo`](https://example.com/private-repo) に分離済み。
E2E テスト通過、454 秒の安定通話実績あり（2026-02-28）。

## 残タスク（v4）

→ [v4 ロードマップ](#v4-ロードマップ) を参照

### その他
- [ ] LaunchAgent plist for MBP servers + ngrok
- [ ] Token ローテーション（Alec のトークン露出分）
- [ ] Phase 3.1: Speech queue management（マルチエージェント同時発話管理）
- [ ] stickyMode（ウェイクワード省略での連続会話）

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
