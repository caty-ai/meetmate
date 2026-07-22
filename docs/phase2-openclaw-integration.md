# Phase 2: OpenClaw連携 — アーキテクチャ設計

## 目標
Catyが音声会話中にツールを使えるようにする。
「Slackで〇〇さんにメッセージ送って」「今日の予定教えて」「〇〇を調べて」→ 実際に実行 → 結果を音声で報告

## アーキテクチャ選定

### 検討した選択肢

| # | 方式 | メリット | デメリット |
|---|------|----------|-----------|
| A | OpenClaw Gateway HTTP API | フル機能 | API未成熟・レイテンシ不明 |
| B | **ブリッジサーバー直接ツール実行** | 低レイテンシ・シンプル・確実 | ツール個別実装必要 |
| C | Caty中継（sessions_send経由） | フル機能 | レイテンシ大・複雑 |

### 採用: **Option B — ブリッジサーバー直接ツール実行**

理由:
- 音声会話はレイテンシが命。外部APIを経由するとレスポンスが遅くなる
- Claude (OpenRouter) は function calling をサポート
- 必要なツールは限定的（5〜6個）で個別実装可能
- 将来的にOption A に移行も容易（ツール層の差し替えだけ）

## アーキテクチャ

```
音声入力 (Google Meet)
   ↓
Deepgram STT (Nova 3)
   ↓ テキスト
Claude LLM (OpenRouter, function calling 有効)
   ↓ テキスト or ツール呼び出し
   ├── テキスト → Fish Audio TTS → 音声出力
   └── ツール呼び出し → ツール実行 → 結果をClaudeに返す → テキスト → TTS
```

### ツール呼び出しフロー

```
1. ユーザー: 「Slackでユーザーにお疲れ様ですって送って」
2. STT → テキスト
3. Claude → tool_call: send_slack_message(channel="DM:ユーザー", text="お疲れ様です")
4. ツール実行 → 成功
5. Claude → "(happy) 送りました！ユーザーに「お疲れ様です」とSlackでDMしましたよ。"
6. TTS → 音声出力
```

## 実装するツール（Phase 2 MVP）

### 1. `search_web` — Web検索
```json
{
  "name": "search_web",
  "description": "Webで情報を検索する",
  "parameters": {
    "query": "検索クエリ"
  }
}
```
- 実装: Brave Search API (既存キー利用)
- 戻り値: 上位3件のタイトル+スニペット

### 2. `send_slack_message` — Slackメッセージ送信
```json
{
  "name": "send_slack_message",
  "description": "Slackチャンネルまたはユーザーにメッセージを送信する",
  "parameters": {
    "target": "チャンネル名またはユーザー名",
    "message": "送信するメッセージ"
  }
}
```
- 実装: Slack Web API (Bot Token)
- ターゲット解決: 名前 → ID変換（よく使うIDはハードコード）

### 3. `get_calendar` — カレンダー確認
```json
{
  "name": "get_calendar",
  "description": "今日〜明日の予定を確認する",
  "parameters": {
    "days": "確認する日数 (default: 1)"
  }
}
```
- 実装: `gogcli calendar list` (CLI経由)

### 4. `read_memory` — メモリ検索
```json
{
  "name": "read_memory",
  "description": "過去の記録や情報を検索する",
  "parameters": {
    "query": "検索キーワード"
  }
}
```
- 実装: memory/ ディレクトリのファイルをgrep

### 5. `get_current_time` — 現在時刻
```json
{
  "name": "get_current_time",
  "description": "現在の日時を取得する"
}
```
- 実装: システムローカル時刻の `new Date()`

### 6. `take_note` — メモ記録
```json
{
  "name": "take_note",
  "description": "会議メモを記録する",
  "parameters": {
    "note": "記録する内容"
  }
}
```
- 実装: memory/YYYY-MM-DD.md に追記

## ファイル構成

### 新規ファイル
- `src/tools.js` — ツール定義（JSON Schema）+ 実行ハンドラー
- `src/tools/slack.js` — Slack API ラッパー
- `src/tools/search.js` — Brave Search ラッパー
- `src/tools/calendar.js` — カレンダー（gogcli wrapper）
- `src/tools/memory.js` — メモリ読み書き

### 変更ファイル
- `src/llm.js` — function calling 対応（tools パラメータ追加、tool_call レスポンス処理）
- `src/pipeline.js` — ツール実行ループ追加（Claude → tool_call → 実行 → Claude → テキスト）

## 音声 UX 設計

### ツール実行中の会話フロー
1. Claude が「調べてみますね」等のつなぎを先に返す
2. ツール実行（1〜5秒）
3. 結果を元に最終回答を音声で返す

### 確認フロー（外部送信時）
```
ユーザー: 「ユーザーにSlackで報告送って」
Caty: "(curious) ユーザーに送る内容を教えてもらえますか？"
ユーザー: 「進捗50%です」
Caty: "(calm) ユーザーに「進捗50%です」と送りますね。いいですか？"
ユーザー: 「お願い」
Caty: [send_slack_message 実行]
Caty: "(happy) 送りました！"
```

## 環境変数（追加）
```
# Slack Bot Token (for tool use)
SLACK_BOT_TOKEN=xoxb-...
# Brave Search API Key
BRAVE_SEARCH_API_KEY=...
```

## 実装順序
1. `src/tools.js` — ツール定義 + シンプルなディスパッチャー
2. `src/llm.js` — function calling 対応
3. `src/pipeline.js` — ツール実行ループ
4. 個別ツール実装: get_current_time → search_web → send_slack_message → others
5. テスト

## レビュー観点（Zoe + Eidra向け）
- [ ] セキュリティ: Slack送信は確認フロー必須か？
- [ ] UX: ツール実行中の待ち時間対策は十分か？
- [ ] エラーハンドリング: ツール失敗時の音声フィードバック
- [ ] レイテンシ: ツール実行がボイスUXを壊さないか？
