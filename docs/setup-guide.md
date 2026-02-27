# セットアップ手順書

## 事前準備（ユーザー用）

### 1. Deepgram API Key 取得
1. https://console.deepgram.com/signup にアクセス
2. アカウント作成（無料 $200 クレジット付き）
3. Dashboard → API Keys → Create API Key
4. キーをコピー

### 2. Attendee API Key 取得
1. https://app.attendee.dev/accounts/signup/ にアクセス
2. アカウント作成
3. サイドバー → API Keys → キーを作成
4. キーをコピー

### 3. .env ファイル設定
```bash
cd ~/meetmate
cp .env.example .env
# エディタで .env を開き、APIキーを入力
```

---

## テスト手順

### 1. ngrok 起動（ターミナル1）
```bash
ngrok http 5005
```
表示される `https://xxxxx.ngrok-free.app` の URL をメモ（`https://` → `wss://` に変えて使用）

### 2. Bridge Server 起動（ターミナル2）
```bash
cd ~/meetmate
npm install
node src/index.js
```

### 3. Google Meet 開始
1. ブラウザで http://localhost:5005 を開く
2. Google Meet のURLを入力
3. ngrok の WebSocket URL（wss://xxxxx.ngrok-free.app）を入力
4. 「Join Meeting」をクリック
5. 30秒ほどでBotがMeetに参加
6. さらに30秒ほどでCatyが挨拶を開始

### 4. テスト
- Meetで話しかけてみる
- Catyが日本語で応答するか確認
- コンソールログで会話テキストを確認

---

## トラブルシューティング

### Bot が参加しない
- Attendee API Key が正しいか確認
- Meet の URL が正しい形式か確認（`https://meet.google.com/xxx-xxxx-xxx`）

### 音声が聞こえない
- ngrok が起動しているか確認
- WebSocket URL が `wss://` で始まっているか確認
- Bridge Server のコンソールログを確認

### Catyが応答しない
- Deepgram API Key が正しいか確認
- コンソールログで Deepgram 接続状態を確認
