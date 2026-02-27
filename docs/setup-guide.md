# セットアップ手順書

## テスト手順（ユーザー用）

すべてMac miniで実行。APIキーはすでに `.env` に設定済みです。

### 1. ngrok authtoken 設定（初回のみ）
```bash
ngrok config add-authtoken <YOUR_AUTHTOKEN>
```

### 2. ngrok 起動（ターミナル1）
```bash
ngrok http 5005
```
表示される URL（例: `https://abc123.ngrok-free.app`）をメモ。

### 3. Bridge Server 起動（ターミナル2）
```bash
cd ~/meetmate
node src/index.js
```
起動メッセージ:
```
🚀  AI Meet Participant Bridge Server 起動: http://localhost:5005
🐱  Caty（ケイティ）がMeetで待機中…
```

### 4. Google Meetに参加させる
1. ブラウザで http://localhost:5005 を開く
   - リモートアクセス時: `http://<tailscale-ip>:5005`（Tailscale経由）
2. **Meeting URL**: Google MeetのURLを入力
3. **WebSocket URL**: ngrokのURL入力（`https://` で貼ればOK、自動で `wss://` に変換）
4. **Bot名**: デフォルト「Caty (ケイティ)」のまま
5. **声モデル**: 好みで選択（Anime Girl / Japanese Woman / Sweet Lady）
6. **Join Token**: `.env` の `JOIN_SHARED_TOKEN` の値を入力
7. 「🚀 Meetに参加させる」をクリック

### 5. テスト
- 30秒ほどでBotがMeetに参加
- Catyが「こんにちは！ケイティです。よろしくお願いします！」と挨拶
- **日本語で話しかけてください**
- コンソールログで会話テキストを確認
- ミーティング終了時に `memory/YYYY-MM-DD.md` に会話サマリーが自動保存されます

---

## 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `DEEPGRAM_API_KEY` | Deepgram APIキー（必須） | - |
| `ATTENDEE_API_KEY` | Attendee APIキー（必須） | - |
| `AGENT_LANG` | 言語モード（`ja`/`en`） | `ja` |
| `CARTESIA_VOICE_ID` | 声のID | Anime Girl |
| `JOIN_SHARED_TOKEN` | /join-meeting 認証トークン | - |
| `WS_SHARED_TOKEN` | WebSocket 認証トークン | - |
| `OPENCLAW_WORKSPACE` | OpenClawワークスペースパス | `~/.openclaw/workspace` |

## 声の選択肢

| 名前 | Voice ID | 特徴 |
|------|----------|------|
| **Anime Girl** | `1001d611-b1a8-46bd-a5ca-551b23505334` | アニメ声。Catyのキャラに一番合う |
| **Japanese Woman** | `2b568345-1d48-4047-b25f-7baccf842eb0` | 落ち着いた日本人女性 |
| **Sweet Lady** | `e3827ec5-697a-4b7c-9704-1a23041bbc51` | 甘めの柔らかい女性 |

切替方法: `.env` の `CARTESIA_VOICE_ID` を変更して Bridge Server 再起動。

---

## トラブルシューティング

### Bot が参加しない
- Meet の URL が `https://meet.google.com/xxx-xxxx-xxx` 形式か確認
- Meetの「参加をリクエストしています」通知を承認してください
- 新しいMeetを作り直して試す

### 音声が聞こえない
- ngrok が起動しているか確認
- コンソールに `🟢 Deepgram Voice Agent 接続完了` が出ているか確認

### Catyが応答しない
- Deepgram API Key が正しいか確認
- `❌ Deepgram error` がないか確認

### エコー（Catyが自分の声に反応する）
- `💬 [agent]` が連続で同じ内容を繰り返していたらエコー問題
- エコーループ保護が有効か確認（コンソールに `🔇 Muting` が出るはず）
