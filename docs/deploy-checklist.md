# デプロイチェックリスト — 新エージェント展開用

> 新しいエージェントを Meetmate に展開する際のチェックリスト。
> ルカ展開時の教訓を反映（2026-04-04）。

---

## Phase 1: 事前準備

- [ ] OpenClaw Gateway がエージェント用に稼働中（ポート・トークン確認）
  ```bash
  curl -s http://localhost:<gateway-port>/v1/models | head -5
  ```
- [ ] Deepgram API キー取得済み
- [ ] Attendee API キー取得済み
- [ ] Fish Audio API キー取得済み
- [ ] Fish Audio Voice ID 決定済み（https://fish.audio/ で試聴）
- [ ] ngrok 固定ドメイン取得済み（https://dashboard.ngrok.com → Domains → Create Domain）
  - 無料プラン: 1ドメイン/アカウント。2台目以降は別アカウントか有料プラン
  - Tailscale+VPS構成なら ngrok 不要
- [ ] エージェントのアバター画像準備済み（PNG推奨、256x256px以上の正方形）
  - ⚠️ クローン元の画像がそのまま残るため、必ず差し替え
- [ ] 使用ポート番号決定済み（既存エージェントと衝突しないこと）
  ```bash
  lsof -i :<port> 2>/dev/null  # 空いていることを確認
  ```

---

## Phase 2: リポジトリ準備

- [ ] リポジトリクローン（**既存エージェントとは別ディレクトリに**）
  ```bash
  git clone https://github.com/caty-ai/meetmate.git \
    meetmate-<agent-name>
  cd meetmate-<agent-name>
  git checkout v7.2.0  # 安定版タグ（Wake Calibration含む）
  npm install
  ```

- [ ] `config.json` 作成・編集
  ```bash
  cp config.json.example config.json
  ```
  - [ ] `agent.id` — エージェントID（小文字英数字、例: `luca`）
  - [ ] `agent.name` — 内部名（例: `Luca`）
  - [ ] `agent.displayName` — 表示名（例: `ルカ`）
  - [ ] `agent.greeting` — 参加時の挨拶テキスト（感情タグ付き推奨: `(happy) こんにちは！`）
  - [ ] `agent.emotionTags` — `true` にする（TTS感情表現の有効化）
  - [ ] `agent.model` — **必ず `"openclaw"`**（モデル名を直接書かない）
  - [ ] `agent.wakeWords` — ウェイクワード配列（エージェント名のバリエーション）
  - [ ] `agent.keyterms` — Deepgram キーワードブースト用
  - [ ] `agent.sttWakeVariants` — 初期は `[]`（キャリブレーション後に更新）
  - [ ] `agent.ackVariants`, `exitFarewell`, `cancelAck`, `progressPings`, `timeoutFallback` — エージェントの口調に合わせる
  - [ ] `gateway.url` — `${OPENCLAW_GATEWAY_URL}`（.envから読む）
  - [ ] `gateway.token` — `${OPENCLAW_GATEWAY_TOKEN}`（.envから読む）
  - [ ] `server.port` — 他エージェントと被らないポート
  - [ ] `server.ngrokDomain` — ngrok 固定ドメイン（**自動検出に頼らない**）
  - [ ] `slack.botToken` — 必要なら設定
  - [ ] `slack.statusChannel` / `summaryChannel` — 通知先チャンネル

- [ ] `.env` 作成・編集
  ```bash
  cp .env.example .env
  ```
  - [ ] `OPENCLAW_GATEWAY_URL` — Gateway URL（例: `http://localhost:19300`）
  - [ ] `OPENCLAW_GATEWAY_TOKEN` — Gateway トークン
  - [ ] `DEEPGRAM_API_KEY` — STT用
  - [ ] `ATTENDEE_API_KEY` — Meet Bot用
  - [ ] `FISH_AUDIO_API_KEY` — TTS用
  - [ ] `FISH_AUDIO_VOICE_ID` — TTS音声ID
  - [ ] ⚠️ **`TTS_PROVIDER=fish-audio`** — 必ず確認（`openai` だとレガシーモードに入る）
  - [ ] `PORT` — `config.json` の `server.port` と一致させる（片方だけでOKだが整合性のため）

> 💡 `.env` と `config.json` に重複する設定（`tts.provider`, `stt.apiKey` 等）がある場合、`.env` 側が優先される。`config.json` 側はフォールバック。

- [ ] アバター配置（**必ず PNG 形式** — JPEG を .png にリネームしただけでは 400 エラーになる）
  ```bash
  cp /path/to/agent-avatar.png assets/avatar.png
  # PNG確認: "PNG image data" と出ればOK
  file assets/avatar.png
  # JPEG等の場合は変換 + リサイズ
  sips -s format png -z 256 256 assets/avatar.png --out assets/avatar.png
  ```

---

## Phase 3: ngrok

- [ ] ngrok トンネル起動
  ```bash
  ngrok http <port> --domain=<your-domain>.ngrok-free.dev
  ```
- [ ] **ngrok API ポートが衝突していないか確認**
  - 同一マシンの 2台目以降: 専用 config ファイルで API ポートをずらす
    ```yaml
    # ~/.config/ngrok/ngrok-<agent-name>.yml
    version: 3
    authtoken: YOUR_AUTHTOKEN
    agent:
      web_addr: 127.0.0.1:4041  # デフォルト4040と被らない値
    ```
    ```bash
    ngrok http <port> --domain=<domain> --config ~/.config/ngrok/ngrok-<agent-name>.yml
    ```
  - または `config.json` の `server.ngrokDomain` で明示指定（推奨）
- [ ] 外部からアクセス確認
  ```bash
  curl -s https://<your-domain>.ngrok-free.dev/health
  ```

---

## Phase 4: 起動・検証

- [ ] サーバー起動
  ```bash
  npm start
  ```

- [ ] 起動ログ確認（以下が全て表示されること）:
  - [ ] `[<agent-id>] Agent profile resolved: <表示名>`
  - [ ] `🖼️  Bot avatar loaded (local): avatar.png`
  - [ ] `🌐  ngrok WSS URL (config.json): wss://<your-domain>`（⚠️ 別エージェントのURLでないこと）
  - [ ] `🚀  Meet Server started: http://localhost:<port>`
  - [ ] **`🐟  Fish Audio パイプラインモード`**（⚠️ `🔊 Deepgram Voice Agent モード` が出たら TTS_PROVIDER 誤り）

- [ ] `/health` エンドポイント確認
  ```bash
  curl http://localhost:<port>/health
  # → {"ok":true,"service":"<agent-id>","agentId":"<agent-id>",...}
  ```

- [ ] Gateway 接続テスト（ポートは `.env` の `OPENCLAW_GATEWAY_URL` のポート部分）
  ```bash
  curl -s -m 60 -X POST http://localhost:<gateway-port>/v1/chat/completions \
    -H "Authorization: Bearer <token>" \
    -H "Content-Type: application/json" \
    -d '{"model":"openclaw","messages":[{"role":"user","content":"テスト。1+1は？"}],"max_tokens":50,"stream":false}'
  ```
  - [ ] レスポンスが返ること（モデルによって5〜30秒かかることがある）
  - [ ] レスポンス時間がwarm-upタイムアウト（デフォルト8秒）以内か確認
    - 超える場合: `config.json` の `gateway.warmupTimeoutMs` を `30000` に設定

---

## Phase 5: Meet ライブテスト

- [ ] ブラウザで `http://localhost:<port>` を開く
- [ ] Google Meet URL を貼り付け → 「参加させる」
- [ ] Meet 側で参加リクエスト承認
- [ ] Bot が参加（~30秒）
- [ ] 挨拶が流れる
- [ ] ウェイクワードで呼びかけ → 応答がある
- [ ] 名前を呼ばずに話す → 無視される（wake モード時）
- [ ] 「退出して」→ 退出メッセージ後に退出

---

## Phase 6: 仕上げ（任意）

- [ ] **OpenClaw LCM 設定**（Meet セッションがメインコンテキストに混入しないための必須設定）
  - エージェントの `openclaw.json` → `plugins.entries.lossless-claw.config` に以下を追加:
  ```json
  {
    "statelessSessionPatterns": ["meet-*"],
    "ignoreSessionPatterns": ["cron-*", "heartbeat-*"]
  }
  ```
  - `statelessSessionPatterns: ["meet-*"]` — Meet セッションを LCM に保存するがメインコンテキストには混入させない
  - `ignoreSessionPatterns: ["cron-*", "heartbeat-*"]` — cron/heartbeat を LCM 保存対象外に
  - 設定後 Gateway を再起動（`openclaw gateway restart` or SIGUSR1）
  - ⚠️ 未設定だと Meet の会話（warm-up 含む）がメインの Slack チャットに流入してコンテキストが膨張する

- [ ] LaunchAgent 登録（常駐化）
  ```bash
  ./scripts/install-launchagent.sh \
    --label ai-meet.<agent-name> \
    --dir "$(pwd)" \
    --port <port>
  ```
  - [ ] LaunchAgent plist に追加の環境変数（`WAKE_CALIBRATE_ENABLED` 等）を必要に応じて追加
- [ ] ウェイクワードキャリブレーション実行（`/calibrate` UI）
- [ ] watchdog 設定（任意）
  ```bash
  ./scripts/watchdog.sh --service ai-meet.<agent-name> --port <port>
  ```
- [ ] Slack 通知チャンネルの動作確認

---

## よくある罠（Lessons Learned）

| 罠 | 症状 | 原因 | 対策 |
|----|------|------|------|
| TTS_PROVIDER 誤り | Bot参加するが無音 / Deepgramエラー | `TTS_PROVIDER=openai` → レガシーモード | `.env` で `TTS_PROVIDER=fish-audio` を明示 |
| Gateway タイムアウト | warm-up timeout ログ + 会話開始しない | モデル応答が8秒超 | `config.json` の `gateway.warmupTimeoutMs` を `30000` に設定 |
| ngrok URL 誤検出 | 別エージェントのngrok URLでWSS接続 | auto-detect が port 4040 の最初のngrokを拾う | `config.json` に `ngrokDomain` を明示 |
| ngrok API ポート衝突 | 2台目の ngrok が起動失敗 | デフォルト API port 4040 が被る | 専用 config yml で `agent.web_addr` を変更。または Tailscale+VPS なら ngrok 不要 |
| アバター不一致 | 別エージェントのアイコン表示 | clone元の `assets/avatar.png` がそのまま | 必ず差し替え（Phase 2 でチェック） |
| アバター形式エラー | `400 - Data is not a valid PNG image` | JPEG を `.png` にリネームしただけ | `file assets/avatar.png` で確認、JPEG なら `sips -s format png -z 256 256` で変換 |
| model に具体名 | Gateway が無視、意図しないモデルで応答 | Gateway は agent config 側のモデルを使用 | `"openclaw"` 固定 |
| sttWakeVariants 空 | ウェイクワードに反応しない | STT誤認識バリアント未登録 | キャリブレーション実行（Phase 6） |
| greeting / name 未設定 | 参加時無言 / ログで名前不明 | config.json で設定漏れ | greeting + name + emotionTags を設定 |
| ngrok ドメイン未取得 | 毎回URL変わる / 手動設定が面倒 | ランダムドメインで起動 | dashboard で固定ドメイン取得 → config に記載 |

---

## ポート設計（参考）

| エージェント | Meet Server | OpenClaw Gateway | ngrok API |
|-------------|-------------|-----------------|-----------|
| Caty | 5005 | 18789 | 4040（デフォルト） |
| Luca | 5006 | 19300 | 4041 |
| （次） | 5007 | — | 4042 |
