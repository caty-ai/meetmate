# セットアップガイド — Meetmate

> **1エージェント = 1サーバーインスタンス。**
> `npx meetmate init` が生成する `config.json` + `.env` + `AGENTS.md` の3点と、自分で配置する `assets/avatar.png` で任意のエージェントが動作する。
> 設定はブラウザの **設定 UI**（`/settings`）から行う。リポジトリのファイルを直接編集する必要はない。

---

## 事前準備

### 必要なアカウント・APIキー

`npx meetmate init` のウィザードが、これらのキーを対話式に順番に尋ねる（取得先のヒントも1行ずつ表示される）。ここでは事前にアカウントだけ用意しておく。

| サービス | 取得先 | 用途 | 必須度 | 費用メモ |
|---------|--------|------|--------|---------|
| OpenClaw Gateway | 同一マシンで稼働 | 既定 LLM（SOUL/memory/tools/skills連携） | 条件付き（既定） | 自前運用前提 |
| OpenAI互換 LLM / Gateway | 利用する endpoint に応じる | `openai-compatible` 選択時の voice brain | 条件付き | 利用先ごとに異なる |
| Soniox | https://console.soniox.com/ | STT（音声認識・既定プロバイダ） | ✅ | 現在の free / paid は公式で確認 |
| Deepgram | https://console.deepgram.com/signup | STT（`deepgram` 切替時のみ） | 任意 | 現在の free / paid は公式で確認 |
| Attendee | https://app.attendee.dev/accounts/signup/ | Google Meet / Zoom Bot | ✅ | 現在の free / paid は公式で確認 |
| Fish Audio | https://fish.audio/ | TTS（音声合成） | ✅ | 現在の free / paid は公式で確認。試聴・接続テストにも同じキーの利用料がかかる |
| ngrok | https://ngrok.com/ | WebSocket トンネル（外部接続用） | 条件付き（一般的な構成） | 無料/有料とも内容は変わりうる |
| Tailscale | https://tailscale.com/ | ngrok代替の到達経路（self-hosted Attendee 等） | 任意 | 無料/有料とも内容は変わりうる |
| Zoom Marketplace | https://marketplace.zoom.us/ | Zoom Bot 権限・アプリ管理 | 条件付き | プラン/権限要件は運用形態次第 |
| Slack Bot | https://api.slack.com/apps | ステータス通知・サマリー投稿 | 任意 | Slack 側プラン条件を確認 |

> ⚠️ API key / token はすべて秘密情報。Git に commit しない、画面共有・ログ共有・Issue・スクリーンショットにも貼らないこと。保存場所は種類によって異なる — Soniox / Fish Audio / Attendee / Slack Bot token のようなベンダーキーは `config.json`（パーミッション 0600）、Gateway の URL/Token や OpenAI互換キーのような接続系の値は `.env`（環境変数）。ベンダーキーの入力先は `init` ウィザードか設定 UI。接続系の値だけは設定 UI から書けないため、`init` ウィザードで生成するか `.env` に直接書く。
> ⚠️ tool 実行まで許可する OpenAI互換 gateway を使う場合も、その endpoint は **信頼できるローカル gateway** に限定すること。外部・不特定・未信頼 meeting では使わないこと。

### 前提条件

- Node.js v26+（`package.json` の `engines` 準拠）
- 既定の `openclaw` プロバイダでは OpenClaw Gateway が同一マシンで稼働中
  - Gateway URL: `http://localhost:<port>`（Gateway のポートに合わせる）
  - Gateway Token: `openclaw.json` の `gateway.token` を確認
- `LLM_PROVIDER=openai-compatible` を使う場合は OpenClaw Gateway 不要
- ngrok アカウント（authtoken 設定済み）

### 会議プラットフォームの前提

- **Google Meet**: まずはこれを基本経路にする。Bot 参加時に Meet 側の **「参加をリクエストしています」承認** が必要。
- **Zoom**: 現時点では **自分が主催・管理できる会議** を前提にする。外部主催 Zoom、OBF、managed OAuth を「対応済み」とは扱わない。
- **Zoom Marketplace**: Zoom 経路を使うなら、Attendee/運用側で必要な Marketplace 設定と権限付与が済んでいることを確認する。

---

## クイックスタート（推奨）

空のフォルダで2コマンド:

```bash
npm install meetmate
npx meetmate init     # ウィザードが対話式にキー等を集め、config.json / .env / AGENTS.md を生成
npx meetmate start    # サーバー起動。設定 UI の URL が表示される
```

### `init` が行うこと

- 書き込み先（**home**）は `AI_MEET_HOME` 環境変数（起動シェルで設定したもの。`.env` 内の `AI_MEET_HOME=` は効かない）が優先、なければ実行時の `カレントディレクトリ`。
- その home に3つのファイルを生成する: **① `config.json`**（エージェント設定・ベンダーキー）**② `.env`**（Gateway 接続情報などの環境専用値）**③ `AGENTS.md`**（OpenClaw 向けのエージェント説明）。
- ウィザードは今回書き込むファイルに必要な項目だけを順番に尋ねる: `SONIOX_API_KEY` → `FISH_AUDIO_API_KEY` → `FISH_AUDIO_VOICE_ID` → `ATTENDEE_API_KEY` → LLM プロバイダー（`openclaw` / `openai-compatible`、選んだ方の追加項目）。各質問には「取得先」のヒントが1行表示される。
- `JOIN_SHARED_TOKEN` / `WS_SHARED_TOKEN` は自動生成（入力不要）。
- 既にあるファイルは上書きしない（`--force` で作り直し。途中で中断しても再実行すれば足りないファイルだけ作られる）。`AGENTS.md` は「meetmate 生成」の目印がある場合のみ `--force` で再生成される。目印のない既存 `AGENTS.md` は変更しない。
- 最後に案内が出る: `Remaining manual steps: configure ngrok or Tailscale, then admit Meetmate to Google Meet.`（この2つだけは手動のまま — [ngrok / Tailscale トンネル](#ngrok--tailscale-トンネル外部接続用) と [会議プラットフォームの前提](#会議プラットフォームの前提)）。

### `start` してブラウザを開く

`npx meetmate start` は必ず1行、次の形式の URL をログに出す:

```
Settings UI: http://localhost:<port>/settings
```

`config.json` がまだ無い状態で `start` しても、サーバーはエラー終了せず setup mode で起動し、同じ1行を表示する。つまり `init` を飛ばしていきなり `start` しても、ベンダーキーや基本項目はブラウザから埋められる。ただし **LLM 接続情報（`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`、または `OPENAI_COMPATIBLE_API_KEY`）だけは設定 UI から書けない** — `init` ウィザードが `.env` に書き込む値なので、`init` を飛ばした場合は `.env` に自分で用意する。

1. 表示された URL をブラウザで開く。未設定の項目がある間はヘッダーのバッジが **`セットアップ中`**、黄色の `setup mode` バナー（`必須設定を入力して保存すると、ミーティングを開始できる状態へ進めます。`）と、`設定の確認が必要です` バナー（未設定・不正な項目が `<項目名>: <理由>` の形式で並ぶ。例: `必須値が未設定です`, `LLM 接続情報が不足しています`）が出る:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/setup-mode-settings.png" alt="setup mode の設定画面。セットアップ中バッジと2つの黄色バナー、空欄の必須項目が並んでいる" width="100%">

2. バナーに挙がった項目（エージェント ID・表示名・Wake Words・Soniox もしくは Deepgram のキー・Fish Audio のキーと Voice ID・Attendee のキーなど）を埋め、下部の **`変更を保存`** をクリックする。保存できると `設定を保存しました。` のトーストが出る。
3. サーバーを再起動する（`npx meetmate start` をもう一度、または常駐サービスなら再起動）。すべて揃っていればヘッダーのバッジが `読み込み済み` に変わり、setup mode のバナーが消える:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-page-basic.png" alt="設定完了後の基本タブ。読み込み済みバッジと緑の「設定は読み込み済みです」バナー" width="100%">

4. `/`（ダッシュボード）に移動し、会議 URL を貼り付けて参加させる。手順の画面つき詳細は [動作確認](#動作確認画面つきウォークスルー) を参照。

2人目以降のエージェントを増やす場合は [2人目のエージェントを増やす](#2人目のエージェントを増やすエクスポートインポート) を参照。設定項目の全体像は次章 [設定リファレンス](#設定リファレンスsettings-ui) にまとめてある。

---

## アバター画像を差し替える

エージェントの顔となる画像は、home（`AI_MEET_HOME` か カレントディレクトリ）配下の `assets/avatar.png` に自分で配置する（`init` は自動コピーしない）。Google Meet の参加者アイコンに表示される。

```bash
cp /path/to/your-agent-avatar.png <home>/assets/avatar.png
```

- ファイル名は `avatar.png` 固定
- **必ず PNG 形式であること**（JPEG を `.png` にリネームしただけでは Attendee API が `400 - Data is not a valid PNG image` で拒否する）
- 推奨サイズ: 256x256px の正方形 PNG（丸くクロップされて表示されるため、顔が中央にあるとベスト）
- 未配置の場合は既定のアバターにフォールバックする

**PNG 形式の確認・変換方法:**
```bash
# 形式を確認（"PNG image data" と出ればOK）
file <home>/assets/avatar.png

# JPEG等の場合はPNGに変換 + 256x256リサイズ（macOS）
sips -s format png -z 256 256 <home>/assets/avatar.png --out <home>/assets/avatar.png
```

---

## ngrok / Tailscale トンネル（外部接続用）

### 固定ドメインの取得（初回のみ）

Meet Bot が外部から WebSocket 接続を受けるために、公開 URL が必要。
ngrok の固定ドメイン（無料プランで1つ）を使うと、再起動してもURLが変わらない。

1. https://dashboard.ngrok.com にログイン
2. 左メニュー「**Domains**」→「**Create Domain**」
3. 自動生成されたドメイン（例: `pretty-duckling-abc123.ngrok-free.dev`）をコピー
4. 設定 UI の **詳細** タブにある「ngrok ドメイン」に貼り付けて保存する（再起動が必要）

> 💡 **無料プランは1ドメインまで。** 2台目以降のエージェントには別の ngrok アカウントを作成するか、有料プラン（$8/月〜）で追加ドメインを取得する。
> 別の方法として Tailscale + VPS 構成なら ngrok 自体が不要（後述）。

### ngrok の起動

サーバーが使っているポート番号は、設定 UI の **デプロイ** タブ（`server_port`、読み取り専用の実測値）か、起動ログの `Settings UI: http://localhost:<port>/settings` の `<port>` 部分で確認できる。

```bash
# 固定ドメインの場合（推奨）
ngrok http <port> --domain=your-domain.ngrok-free.dev

# ランダムドメインの場合（テスト用）
ngrok http <port>
```

### 同一マシンで複数エージェントを動かす場合

ngrok の API ポートがデフォルト（4040）だと、**他エージェントの ngrok と衝突**する。
2台目以降は専用の ngrok config ファイルで API ポートをずらす:

```yaml
# ~/.config/ngrok/ngrok-<agent-name>.yml
version: 3
authtoken: YOUR_AUTHTOKEN
agent:
  web_addr: 127.0.0.1:4041  # デフォルト4040と被らないように
```

```bash
ngrok http <port> --domain=your-domain.ngrok-free.dev --config ~/.config/ngrok/ngrok-<agent-name>.yml
```

> ⚠️ 設定 UI の「ngrok ドメイン」を**必ず明示**すること。自動検出（ngrok API port 4040）は同一マシンの最初の ngrok しか検出しない。

### ngrok 不要な構成

一例として、サーバーと Attendee（self-host）が同じ Tailscale ネットワーク上にある構成なら ngrok なしで直接接続できる。Attendee 側の WebSocket URL を Tailscale IP ベース（例: `wss://<tailscale-ip>:<port>`）に向ければ、トンネルなしで動作する。

### PWA インストール用の HTTPS

ブラウザの「ホーム画面に追加」やインストール UI を使うには、ダッシュボードを HTTPS で開く必要がある。Tailscale で使う場合は MagicDNS と HTTPS 証明書を有効化したうえで、Tailnet のホスト名を使ってローカルの UI に転送する。

```bash
tailscale cert <your-tailnet-hostname>
tailscale serve --https=443 http://127.0.0.1:<port>
```

その後、ブラウザで `https://<your-tailnet-hostname>` を開く。ngrok の `https://your-domain.ngrok-free.dev` 形式のトンネルは最初から HTTPS なので、PWA インストール用の追加設定は不要。

---

## 動作確認（画面つきウォークスルー）

以下は設定が完了した状態（`変更を保存` → 再起動 → `読み込み済み`）から、ダッシュボード（`/`）で実際に会議に参加させるまでの流れ。設定 UI（`/settings`）とは別画面。

1. ブラウザでダッシュボード（`/`）を開く。起動直後はこの画面。参加ボタンは会議情報を入れるまで無効のまま:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-ui-idle.png" alt="起動直後のダッシュボード。上に会議情報の貼り付け欄と無効状態の参加ボタン、右にセッション指標、ヘッダーに⚙設定へのリンク" width="100%">

2. 会議情報を貼り付ける。Meet / Zoom の URL 単体でもよいし、**Google カレンダーの招待文をまるごと貼っても URL だけ自動抽出される**。抽出に成功すると緑の「検出済み: <URL>」が出て、参加ボタンが有効になる:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-ui-invite-pasted.png" alt="招待文をまるごと貼り付けた状態。検出済みの緑表示と有効化された参加ボタン" width="100%">

3. 「Meet に参加させる」をクリックした瞬間に通話中カードが現れる。タイマーはクリック時点から回り始め、WS 接続状態とエージェント名もこの時点から表示される。状態表示は **🔄 起動中...** から始まり、Bot が Meet の入室許可を待っている間は **WS 未接続** のまま。入室が許可されると **WS 接続 OK** に変わる:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-ui-joining.png" alt="通話中カード。入室許可待ちの状態で、タイマー・WS 状態（未接続）・エージェント名が表示されている" width="100%">

4. Meet 側に「〜が参加をリクエストしています」のダイアログが出るので**承認する**（ここだけは人間の手作業。アプリ側からは代行できない）。

5. 約30秒で Bot が参加 → 挨拶が流れれば成功 ✅ あとはウェイクワードで呼びかければ応答する。

---

## 設定リファレンス（settings UI）

`/settings` のヘッダーには `Meetmate の設定を確認・編集します。資格情報の値は、この画面には表示されません。` とある通り、一度保存したキー類は画面に再表示されない（マスク表示）。タブは6つ:

| タブ | 内容 |
|---|---|
| 基本 | 日常的に使う設定 — エージェント ID / エージェント名 / 表示名 / 言語 / Wake Words / LLM プロバイダー / LLM モデル / Soniox・Deepgram の API key と音声認識プロバイダー / Fish Audio の API key・Voice ID と音声合成プロバイダー / Attendee API key / Slack Bot token・Slack 通知・Slack 通知先 / 会議サマリー（あいさつ・感情タグは音声プリセットタブ側） |
| 音声プリセット | 会話中の定型文と感情表現（`ライブ設定` バッジつき＝保存後すぐ反映）— 感情タグ toggle、あいさつ、応答確認、進捗 Ping、退出あいさつ、キャンセル確認、タイムアウト、固定の感情タグ（読み取り専用）、Fish Audio プレビュー、事前録音 MP3 |
| 詳細 | Soniox のチューニング・endpointing、Fish のモデル/速度/レイテンシ/サンプルレート/キャッシュ、Attendee host、Slack チャンネル、gateway warmup、ngrok ドメイン、feature flags など。多くは再起動が必要 |
| デプロイ | 読み取り専用の診断情報 — 実際に bind されたポート（`server_port`）、解決済み home（`resolved_home`）、その他の環境診断値。ここでは編集できない |
| 接続テスト | 各サービスへの疎通確認（詳細は [接続テスト・試聴・MP3](#接続テスト試聴mp3)） |
| エクスポート・インポート | 非機密設定の書き出し／取り込み、8.x からのベンダー値移行（詳細は [8.x からの移行](#8x-からの移行) / [2人目のエージェントを増やす](#2人目のエージェントを増やすエクスポートインポート)） |

### ライブ設定 と 再起動待ち

各項目には `すぐに反映` か `次回起動時に反映` のバッジが付いている。再起動が必要な項目を保存すると `保存済み・再起動待ち` のバナーが出て、対象の項目が並ぶ。

### 値の出どころ（source badge）

各項目には値がどこから来ているかのバッジが付く: `保存値`（設定 UI から保存済み）/ `.env seed`（home の `.env` から読んだ値）/ `既定値` / `未設定` / `<ENV名> · os-env`（起動時の環境変数がその項目を上書きしている）。`os-env` の場合は「`<ENV名>` が現在の実行値を上書きしています。保存した値を反映するには、この環境変数を外して再起動してください。」という注意が出る。

優先順位は「.env が常に優先」ではなく4段階: **①起動前からシェル/OSに設定されていた環境変数 → ②`config.json`（設定 UI の保存先） → ③resolved home の `.env` の値 → ④コード既定値**。設定 UI で保存しても①のシェル環境変数がそれより優先されるので、反映されない値がある場合はまず `os-env` バッジを疑う。

### アクセス制限

`/settings` と `/api/settings*` は **ループバックからのみ**アクセスできる（`localhost` / `127.0.0.1` / `[::1]` への直接アクセスに限定）。ngrok などのトンネル越しにアクセスすると 404 になる — これは仕様であり、設定画面は必ずサーバーと同じマシンのブラウザから開くこと。設定の変更（POST/PUT 等）はさらに同一オリジンからのリクエストであることも求められる。

### Gateway URL の制約

`OPENCLAW_GATEWAY_URL` は `http://` または `https://` で始まる URL であること。ユーザー情報やフラグメント（`#`）を含めることはできない。`ws://` はここでは無効な値として扱われる。

---

## 感情タグ

感情タグは、次の5種類に固定されている（読み取り専用 — ユーザーが追加・編集することはできない）:

| タグ | 意味 |
|---|---|
| `[soft voice]` | デフォルト・優しい声（fallback） |
| `[warm]` | 温かみ |
| `[friendly, warm]` | 親しみ＋温かみ |
| `[empathetic, unhurried]` | 謝罪・落ち着き |
| `[thoughtful]` | 考え深く |

ユーザーが変更できるのは、**感情タグ** の on/off トグル（音声プリセットタブ、ライブ設定、デフォルト有効）と、自由記述の**あいさつ**（同じくライブ設定）。あいさつの書式は角括弧タグを文頭に置く形:

```
[warm] こんにちは！よろしくお願いします！
```

旧バージョンにあった丸括弧形式のタグは現在使われていない。設定するとそのまま読み上げられてしまうため、必ず角括弧5種のいずれかを使うこと。

<img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-voice-presets.png" alt="音声プリセットタブ。感情タグトグルがON、[warm]の挨拶、ライブ設定バッジが表示されている" width="100%">

---

## 8.x からの移行

設定 UI 導入前のバージョン（公開済みの 8.x 系）では `init` が `.env` にベンダーキーを書いていたが、本バージョンからは `config.json` に書く。移行は次の手順:

1. 同じ home で `meetmate init` を再実行する（`config.json` / `.env` が既にある場合、資格情報の質問は出ず `AGENTS.md` だけが対象になる。既存の `AGENTS.md` に meetmate 生成の目印があれば据え置き、無ければ変更しない — 作り直したい場合のみ `--force`）
2. `meetmate start` する
3. 設定 UI の **エクスポート・インポート** タブを開く。「**従来の `.env` ベンダー値を移行**」カードに次の説明が出る:

   > 保存先が未設定のベンダー値だけを設定ファイルへ移します。Meetmate は `.env` を編集・削除しません。再起動を確認した後、不要な従来行はオペレーターが手動で削除してください。

   **`ベンダー値を移行`** ボタンを押す。`config.json` にまだ値が無い項目にだけ、`.env` の値がコピーされる（既に設定 UI から入れた値は上書きされない）。

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-transfer.png" alt="エクスポート・インポートタブ。従来の.envベンダー値を移行カードとベンダー値を移行ボタン" width="100%">

4. 保存内容を確認し、再起動する
5. 再起動後、**`.env` の中の旧ベンダー行（`SONIOX_API_KEY` / `FISH_AUDIO_API_KEY` / `FISH_AUDIO_VOICE_ID` / `ATTENDEE_API_KEY` / `SLACK_BOT_TOKEN` 等）は不要になる。Meetmate は `.env` を自動編集しないので、オペレーターが手動で削除する**

### `.env` に残る値（class-2 = 接続系）

これらは移行の対象外で、そのまま `.env` の環境変数として使い続ける: `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `LLM_PROVIDER` / `OPENAI_COMPATIBLE_API_KEY` / `JOIN_SHARED_TOKEN` / `WS_SHARED_TOKEN`。

`config.json` の `gateway.url` / `gateway.token` / `llm.openaiCompatible.apiKey`（旧バージョンで手書きしていたフィールド）は、本バージョンでは**無視される**。もし残っていると起動時に次のような警告が出る:

```
Legacy connection settings were ignored and must be supplied through the environment: <path> -> <ENV>
```

これらの値は `.env` の環境変数からのみ読まれる。

---

## 2人目のエージェントを増やす（エクスポート・インポート）

1台目の設定 UI で **エクスポート・インポート** タブを開き、**`設定をエクスポート`** を押す。`meetmate-settings.json` がダウンロードされる（`{"format":"meetmate-settings","version":1,"exportedAt":<日時>,"settings":{…}}` の形）。

**エクスポートに含まれないもの**（＝2台目で自分で用意する必要があるもの）:

- Soniox / Deepgram / Fish Audio / Attendee / Slack Bot token などの資格情報（class-1）
- Gateway 接続情報（class-2 = `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `OPENAI_COMPATIBLE_API_KEY` — そもそも設定ストアに存在せず `.env` 側）
- 共有トークン（class-3 = `JOIN_SHARED_TOKEN` / `WS_SHARED_TOKEN` — 2台目の home で `npx meetmate init` を実行すれば自動で再生成される）
- 事前録音 MP3（`audio_clips`）
- 実際に bind されたポート番号（`server_port`）
- home のパス（`resolved_home`）

<img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-transfer.png" alt="エクスポート・インポートタブ。エクスポート・インポート・ベンダー値移行の3カード（ファイル選択とインポートボタンを含む）" width="100%">

手順:

1. **別の空フォルダ**（＝別の home）で `npx meetmate init` → `npx meetmate start`。資格情報は自分で用意する（1台目とキーを使い回すか、別アカウントで新規発行するかは運用次第）。**ポートは1台目と衝突しない値にする** — ポートは設定 UI からは変更できないので、起動時の `PORT` 環境変数（例: `PORT=5006 npx meetmate start`）か、home の `config.json` の `server.port` で指定する（実際に bind されたポートはデプロイタブで確認できる）
2. 2台目の設定 UI → **エクスポート・インポート** タブ → 1台目でダウンロードした `meetmate-settings.json` をインポートする。フォーマット/バージョンが合わない場合は失敗する。結果は「インポート済み: `<項目名...>` / スキップ: `<項目名...>`」（値が既に同じ項目はスキップ、空欄なら「なし」）の形で表示される
3. 2台目用のアバター画像を `<2台目のhome>/assets/avatar.png` に配置する（[アバター画像を差し替える](#アバター画像を差し替える)）

---

## 接続テスト・試聴・MP3

### 接続テスト

**接続テスト** タブには Soniox / Deepgram / Fish Audio / Attendee / Slack それぞれのテストボタンがある。**現在実装されているのは Soniox と Fish Audio のみ**。それ以外を押すと「この接続テストは現在未実装です。」と表示される。

- タイムアウト: 5秒
- 結果表示: `<サービス名>: <コード> — <説明> (<n> ms)`（コードは `CONNECTED` / `NOT_CONFIGURED` / `AUTH_FAILED` / `UNREACHABLE` / `TIMEOUT` / `RATE_LIMITED` / `PROVIDER_ERROR` のいずれか）
- レート制限: 同じサービスに対して1秒に1回まで。連打すると「接続テストの間隔が短すぎます。少し待ってから再試行してください。」と出る

### Fish Audio プレビュー（試聴）

音声プリセットタブの「Fish Audio プレビュー」は、`現在このプロセスが使用している音声設定で試聴します。`

> ⚠️ プレビューは、オペレーター自身の Fish Audio キー／アカウントの利用となり、Fish Audio の利用量・料金が発生します。Meetmate の共通キーや料金補助はありません。

- テキストは 1〜500文字
- タイムアウト 30秒、再生は最大15秒でカット
- プロセス全体で 1回 / 2秒 の間隔制限

### 事前録音 MP3

同じくタブ内「事前録音 MP3」は、`定型文に合わせた MP3 を登録すると、現在の音声設定と一致する場合だけ自動再生します。`

- 登録できる役割: 応答確認 / 進捗 / あいさつ / 退出 / タイムアウト
- 上限: 1ファイル 10MB、合計 128MB、最大32クリップ、1クリップ30秒まで
- **現在の音声設定と一致しない場合は自動再生されず、通常の TTS 読み上げにフォールバックする**

---

## LaunchAgent（macOS 自動起動）

常駐サービスとして登録する場合:

```bash
./scripts/install-launchagent.sh \
  --label ai-meet.<agent-name> \
  --dir "$(pwd)" \
  --port <port>
```

`--port` はログ表示用の情報であり、plist には埋め込まれない（実際に使うポートは起動時の `PORT` 環境変数か `config.json` の `server.port`。設定 UI からは変更できず、デプロイタブに実測値が表示されるのみ）。

### 環境変数の追加

LaunchAgent で `WAKE_CALIBRATE_ENABLED=1` など追加の環境変数が必要な場合は、生成された plist を直接編集:

```bash
vi ~/Library/LaunchAgents/ai-meet.<agent-name>.plist
```

`<key>EnvironmentVariables</key>` の `<dict>` 内に追加:
```xml
<key>WAKE_CALIBRATE_ENABLED</key>
<string>1</string>
```

再読み込み:
```bash
launchctl bootout gui/$(id -u)/ai-meet.<agent-name>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-meet.<agent-name>.plist
```

---

## ウェイクワードキャリブレーション

初期状態の「Wake Word の認識候補」が空の場合、STT の誤認識バリアントを検出できずウェイクワードが反応しないケースがある。

### キャリブレーション手順

1. `.env` に `WAKE_CALIBRATE_ENABLED=1` を追加（またはLaunchAgent plist に設定）— この機能フラグは環境変数専用で、設定 UI からは変更できない
2. サーバー再起動
3. ブラウザで `http://localhost:<port>/calibrate` を開く
4. 「録音開始」→ エージェントの名前を様々な言い方で30秒間繰り返す
5. 検出されたバリアントを確認 →「設定に保存」
6. 設定の **Wake Word の認識候補**（詳細タブ）に自動保存される。この項目は詳細タブから直接編集・削除もできる
7. 完了後 `WAKE_CALIBRATE_ENABLED` を削除してもOK（セキュリティ上推奨）。デプロイタブの診断情報には現在の値が読み取り専用で表示される

> 💡 環境（マイク・部屋）が変わった場合は再キャリブレーションすると精度が上がる。

---

## Slack 連携（任意）

会議のステータス・サマリー・全文ログを Slack に自動投稿できる。デフォルトは **DM モード**（Bot → ユーザーへの DM）。

設定はすべて設定 UI から行う（`.env` や `config.json` を手で編集する必要はない）:

- **基本** タブ: `Slack Bot token`（xoxb- で始まるトークン）、`Slack 通知`（有効/無効）、`Slack 通知先`（DM かチャンネルか、DM の場合は宛先ユーザー ID）、`会議サマリー`
- **詳細** タブ: チャンネルモードで使うステータス通知先・サマリー投稿先のチャンネル ID

> 💡 **dmUserId の確認方法**: Slack でユーザーのプロフィールを開き「メンバーIDをコピー」。チャンネル ID も同様にチャンネル詳細から確認できる。

保存後、Slack 関連の項目は多くが再起動後に反映される（各項目のヘルプ文言で `再起動後に反映` かどうかを確認できる）。

---

## トラブルシューティング

### Bot が Meet に参加しない
- Meet URL が `https://meet.google.com/xxx-xxxx-xxx` 形式か確認
- Meet 側で「参加をリクエストしています」通知を承認
- 設定 UI の基本タブで `Attendee API key` が正しいか確認（Attendee の接続テストは現在未実装のため、キー再入力→保存→再起動で確認する）
- ngrok が起動しているか確認

### Bot は参加するが音声応答しない
- 設定 UI の基本タブで **音声合成プロバイダー** が `fish-audio` になっているか確認（現時点でこれ以外の値は受け付けない）
- Fish Audio の API キー・Voice ID が正しいか確認（接続テストタブでも確認できる）
- サーバーログに `🐟 Fish Audio パイプラインモード` が表示されているか確認
  - `🔊 Deepgram Voice Agent モード` が出ていたら音声合成プロバイダーの設定が間違っている

### Gateway warm-up がタイムアウトする
- openai-compatible では join 時に Gateway warm-up エラーがログに出る既知問題あり（無害・修正は #140）。
- Gateway が起動しているか確認: `curl http://localhost:<port>/v1/models`
- モデルの初回応答が遅い場合（Grok等: ~18秒）は設定 UI の**詳細**タブで gateway warmup のタイムアウト（既定8000ms）を延長する（遅いモデルは30000ms推奨）
- Gateway Token が正しいか確認（`.env` の `OPENCLAW_GATEWAY_TOKEN`）

### ウェイクワードに反応しない
- 設定 UI の基本タブで `Wake Words` にエージェント名が入っているか確認
- 「Wake Word の認識候補」（詳細タブ）が空の場合、[ウェイクワードキャリブレーション](#ウェイクワードキャリブレーション)を実行
- ログの `🔔 Pending wake word found` / `🔇 [会議音声・未指名]` で判別

### ngrok URL が別エージェントのものになる
- 設定 UI の詳細タブで「ngrok ドメイン」を明示的に設定する
- 自動検出（ngrok API port 4040）は同一マシンの最初の ngrok のみ検出する

### アバターが違うエージェントの画像
- `<home>/assets/avatar.png` が別エージェントのまま、または未配置 → [アバター画像を差し替える](#アバター画像を差し替える)

### Meet の会話がメインの Slack チャットに混入する
- OpenClaw の LCM 設定が必要。エージェントの `openclaw.json` → `plugins.entries.lossless-claw.config` に以下を追加:
  ```json
  {
    "statelessSessionPatterns": ["meet-*"],
    "ignoreSessionPatterns": ["cron-*", "heartbeat-*"]
  }
  ```
- 設定後 `openclaw gateway restart` で反映
- `statelessSessionPatterns: ["meet-*"]` により Meet セッションは LCM に保存されるがメインコンテキストに積み重ならない

---

## 手動セットアップ・設定リファレンス（コントリビュータ向け）

ここから先は、npm パッケージではなくリポジトリから直接動かす／コードを触るコントリビュータ向け。通常の利用者は上のクイックスタートと設定 UI だけで完結する。

### 1. リポジトリのクローン

```bash
git clone https://github.com/caty-ai/meetmate.git
cd meetmate
npm install
```

**2台目以降のエージェント** は別ディレクトリにクローン:
```bash
git clone https://github.com/caty-ai/meetmate.git meetmate-<agent-name>
cd meetmate-<agent-name>
git checkout <安定版タグ>   # Releases の最新 stable タグを推奨
npm install
```

### 2. config.json（エージェント設定・ベンダーキー）

```bash
cp config.json.example config.json
```

`config.json` の値は設定 UI の書き込み先と同じファイルなので、手で編集した内容もそのまま設定 UI に反映される。環境変数を展開して読み込むプレースホルダ構文は使わない — 値は直接書く。

```jsonc
{
  "agent": {
    "id": "luca",                    // エージェントID（小文字英数字）
    "name": "Luca",                  // 内部名（英語、ログやAPI識別に使用）
    "displayName": "ルカ",           // 表示名（日本語OK、Meet UIに表示）
    "greeting": "[warm] こんにちは！ルカです！",  // 参加時の挨拶（感情タグは角括弧5種のみ→ #感情タグ）
    "emotionTags": true,             // TTS用の感情タグを有効化（推奨: true）
    "wakeWords": ["ルカ", "luca"],   // ウェイクワード（名前）
    "keyterms": ["ルカ", "Luca"],    // STT キーワードブースト用（Soniox context terms / Deepgram keyterm）
    "sttWakeVariants": []            // キャリブレーション後に自動追記される（詳細タブでも直接編集可）
    // ... 口調・メッセージをエージェントに合わせて編集
  },
  "llm": {
    "provider": "openclaw",         // 既定。代替は "openai-compatible"
    "model": "openclaw"             // OpenClaw では Gateway に任せる
  },
  "gateway": {
    "warmupTimeoutMs": 8000          // デフォルト8秒。遅いモデル(Grok等)は30000推奨
  },
  "tts": {
    "provider": "fish-audio",
    "apiKey": "",                    // 設定 UI から保存すると入る（手書きでも可）
    "voiceId": ""
  },
  "stt": {
    "provider": "soniox",
    "sonioxApiKey": ""
  },
  "attendee": {
    "apiKey": ""
  },
  "server": {
    "port": 5005,                    // ⚠️ 他エージェントと被らないポートにする
    "ngrokDomain": "your-domain.ngrok-free.dev"
  }
}
```

> ⚠️ `gateway.url` / `gateway.token` / `llm.openaiCompatible.apiKey` は `config.json` に**書かない**こと。書いても起動時に無視され、警告ログが出る。これらは `.env` の環境変数（`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `OPENAI_COMPATIBLE_API_KEY`）からのみ読まれる。
> ⚠️ 既定の OpenClaw 構成では `llm.model` を `"openclaw"` にすること。`openai-compatible` ではプロキシ側のモデル ID を指定する。

### 3. .env（Gateway 接続情報・環境専用値）

```bash
cp .env.example .env
```

`.env` に置くのは、環境ごとに変わる「接続系」の値だけ。ベンダーキー（Soniox / Fish Audio / Attendee / Slack Bot token）は上の `config.json` 側に書く。

**必須項目（既定の OpenClaw 構成）:**
```bash
# OpenClaw Gateway（接続系＝.envのみ）
LLM_PROVIDER=openclaw
OPENCLAW_GATEWAY_URL=http://localhost:19300    # エージェントのGatewayポート
OPENCLAW_GATEWAY_TOKEN=<gateway-token>

# Shared tokens（meetmate init が自動生成する値と同じ役割）
JOIN_SHARED_TOKEN=
WS_SHARED_TOKEN=
```

`LLM_PROVIDER=openai-compatible` の場合は `OPENAI_COMPATIBLE_API_KEY` を追加する（base URL とモデル ID は `config.json` の `llm.openaiCompatible.baseUrl` / `llm.model` 側）。

> ⚠️ `.env` は実運用シークレットの置き場所。Git に commit しないこと。画面共有・ログ貼り付け・スクリーンショットにも token / API key / Bearer を含めないこと。

**OpenAI 互換で動かす最小構成**

```bash
LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=your_api_key
```

```json
"llm": {
  "provider": "openai-compatible",
  "model": "your-proxy-model-id",
  "openaiCompatible": { "baseUrl": "http://localhost:4000" }
}
```

**状態を持つ OpenAI互換 gateway（例: Claude Code bridge / resident agent gateway）**

同一 turn の自動再送が危険な gateway では、Meetmate 側のローカル履歴と空応答 retry を止める。

```bash
LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=<gateway-bearer>
LLM_RESPONSE_TIMEOUT_MS=60000
```

```json
{
  "llm": {
    "provider": "openai-compatible",
    "model": "your-gateway-model-id",
    "historyMaxTurns": 0,
    "openaiCompatible": {
      "baseUrl": "http://localhost:4000",
      "emptyResponseRetry": false,
      "trustedAgentTools": true
    }
  }
}
```

- `historyMaxTurns: 0` にすると、Meetmate は過去 turn を再送せず、現在の user turn だけを upstream に送る
- `emptyResponseRetry: false` にすると、空 SSE 1回 retry を止める。tool 実行済み turn の二重投入を避けたい gateway で使う
- `trustedAgentTools: true` にすると、Meetmate は `X-Caty-Agent-Trust: trusted` を送る。これは **信頼できるローカル tool-capable gateway** と **信頼できる meeting** の組み合わせでだけ使う
- `LLM_RESPONSE_TIMEOUT_MS` は upstream gateway の deadline より短くしすぎないこと。Claude/tool turn を使うなら 60 秒前後から始めるのが安全
- これは **既存の `openai-compatible` provider の設定**。Claude 専用 provider を追加するわけではない
- 外部主催 meeting、不特定参加者 meeting、未信頼 gateway では `trustedAgentTools` を有効にしないこと

### 4. 起動

```bash
node src/server.js
```

ログに次の1行が出れば起動成功:
```
Settings UI: http://localhost:<port>/settings
```

以降は [クイックスタート](#クイックスタート推奨) の「`start` してブラウザを開く」以降と同じ。

---

## アーキテクチャ概要

```
STT(Soniox stt-rt-v5 既定 / Deepgram 切替可) → ウェイクワード検出 → LLM(OpenClaw Gateway 既定) → TTS(Fish Audio) → Meet/Zoom
```

詳細は `docs/architecture.md` を参照。
