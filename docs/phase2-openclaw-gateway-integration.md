# Phase 2: OpenClaw Gateway 連携 — 実装仕様書

## 概要
ブリッジサーバーの LLM 呼び出し先を OpenRouter → OpenClaw Gateway に変更する。
これにより「いつものCaty」が音声でそのまま使えるようになる。

## 検証済み
- `POST http://localhost:18789/v1/chat/completions` ✅
- `stream: true` (SSE) ✅
- Gateway Token 認証 ✅
- フルのCaty (SOUL/memory/tools/skills) が返答 ✅

## 変更ファイル

### 1. `src/llm.js` — LLM呼び出し先の切り替え

**変更内容:**
- OpenRouter の代わりに OpenClaw Gateway を呼び出す
- `OPENCLAW_GATEWAY_URL` と `OPENCLAW_GATEWAY_TOKEN` を使用
- SSEストリーミングは同じフォーマット（OpenAI互換）なので、パース処理は変更不要
- **system prompt を送らない**（OpenClawが SOUL.md/AGENTS.md を自動注入）
- `user` フィールドに meeting session ID を入れる（セッション分離のため）

**具体的なコード変更:**

```javascript
// 環境変数
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

// 接続先の切り替え
const useOpenClaw = !!OPENCLAW_GATEWAY_TOKEN;

// OpenClaw の場合
// - hostname: localhost, port: 18789, path: /v1/chat/completions
// - Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
// - system prompt は送らない（OpenClawが注入）
// - 代わりに voice-specific な追加指示を system role で最小限送る

// OpenRouter の場合（フォールバック）
// - 現在のコードそのまま
```

**Voice-specific system prompt 追加:**
OpenClawのSOUL.mdに加えて、音声固有の指示を追加する:
```
あなたは今Google Meetで音声会話中です。
- 短く話す（1回2〜3文まで）
- すべての文の先頭に感情タグを付ける: (happy), (nervous), (calm) 等
- ツール実行が必要な時は「ちょっと調べてみますね」等のつなぎを先に返す
- 音声会話モードなので、コードブロックや長いリスト、マークダウンは使わない
```

### 2. `src/pipeline.js` — セッション管理

**変更内容:**
- `user` フィールドに meeting session ID を渡す
- OpenClaw モードでは conversation history を送らない（OpenClawがセッション管理）
- OpenRouter モード（フォールバック）では従来通り history を送る

### 3. `src/config.js` — 設定追加

**新しい環境変数:**
```
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your-OPENCLAW_GATEWAY_TOKEN-here
```

### 4. `.env.example` — ドキュメント追記

## セッション管理

OpenClawの chatCompletions は `user` フィールドでセッションを分離できる:
```json
{
  "model": "anthropic/claude-opus-4-6",
  "stream": true,
  "user": "meet-session-abc123",
  "messages": [
    {"role": "system", "content": "[voice-specific instructions]"},
    {"role": "user", "content": "今日の予定教えて"}
  ]
}
```

- 1ミーティング = 1 `user` ID = 1 OpenClawセッション
- 会話履歴はOpenClawが自動管理（ブリッジサーバーは管理不要）

## 音声 UX

### ツール実行時のフロー
```
User: 「今日の予定教えて」
OpenClaw: [memory_search → calendar check → response]
         ストリーミングで最初のチャンク「えっと、」が来たら即TTS開始
         残りのチャンクも文ごとにTTSに流す
```

### 感情タグ
SOUL.md に感情タグの指示がないので、voice-specific system prompt で追加する。

## テスト手順

1. `.env` に `OPENCLAW_GATEWAY_TOKEN` 追加
2. サーバー再起動
3. Meet参加
4. 話しかける → OpenClawのフルCatyが音声で返答
5. 「今何時？」→ ツール(get_current_time)使用確認
6. 「前に話した〇〇覚えてる？」→ memory_search 使用確認

## 注意事項
- OpenClaw Gateway が落ちてる場合は OpenRouter にフォールバック
- Gateway token は .env に入れる（.gitignore 済み）
- モデルは OpenClaw 側の設定（anthropic/claude-opus-4-6）が使われる
- LLM コスト: OpenClaw 経由なので OpenClaw の課金に含まれる
