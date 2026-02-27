# セットアップ手順書

## テスト手順（ユーザー用）

すべてMac miniで実行。APIキーはすでに `.env` に設定済みです。

### 1. ngrok authtoken 設定（初回のみ）
```bash
# ngrok アカウント作成: https://dashboard.ngrok.com/signup
# ダッシュボードから authtoken をコピーして:
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
2. **Meeting URL**: Google MeetのURLを入力（`https://meet.google.com/xxx-xxxx-xxx`）
3. **WebSocket URL**: ngrokのURL入力（`https://` で貼ればOK、自動で `wss://` に変換される）
4. **Bot名**: デフォルト「Caty (ケイティ)」のまま
5. **声モデル**: お好みで選択（デフォルト: Thalia - 明るい女性声）
6. **Join Token**: `.env` の `JOIN_SHARED_TOKEN` の値を入力
7. 「🚀 Meetに参加させる」をクリック

### 5. テスト
- 30秒ほどでBotがMeetに参加
- さらに30秒ほどでCatyが "Hi! I'm Caty. Nice to meet you!" と挨拶
- 英語で話しかけてみてください
- コンソールログで会話テキストを確認

---

## 日本語TTSについて
現時点ではDeepgram Aura-2の日本語モデルがEarly Access制限のため、MVPは英語での会話になります。

日本語を有効化するには:
1. Deepgram Consoleにログイン
2. Settings → Billing で支払い情報を追加（もしくはEA申請）
3. 日本語モデル（例: `aura-2-sakura-ja`）へのアクセスが開いたらconfig変更

---

## トラブルシューティング

### Bot が参加しない
- Attendee API Key が正しいか確認（`.env`）
- Meet の URL が `https://meet.google.com/xxx-xxxx-xxx` 形式か確認
- ngrok が起動しているか確認

### 音声が聞こえない
- ngrok が起動しているか確認
- WebSocket URL が正しいか確認
- Bridge Server のコンソールログで Deepgram 接続状態を確認

### Catyが応答しない
- Deepgram API Key が正しいか確認
- コンソールに `🟢 Deepgram Voice Agent 接続完了` が出ているか確認
- `❌ Deepgram error` がないか確認

### エコー（Catyが自分の声に反応する）
- Deepgram のVADが自己発話を除外するはずだが、問題が起きた場合はコンソールログで確認
- `💬 [agent]` が連続で同じ内容を繰り返していたらエコー問題
