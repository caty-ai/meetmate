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
| OpenClaw Gateway | https://openclaw.ai/ （同一マシンで稼働） | 既定 LLM（SOUL/memory/tools/skills連携） | 条件付き（既定） | 自前運用前提 |
| OpenAI互換 LLM / Gateway | 利用する endpoint に応じる | `openai-compatible` 選択時の voice brain | 条件付き | 利用先ごとに異なる |
| Soniox | https://console.soniox.com/ | STT（音声認識・既定プロバイダ） | ✅ | 現在の free / paid は公式で確認 |
| Deepgram | https://console.deepgram.com/signup | STT（`deepgram` 切替時のみ） | 任意 | 現在の free / paid は公式で確認 |
| Attendee | https://app.attendee.dev/accounts/signup/ | Google Meet / Zoom Bot | ✅ | 現在の free / paid は公式で確認 |
| Fish Audio | https://fish.audio/ | TTS（既定） | 条件付き（既定） | 現在の free / paid は公式で確認。試聴・接続テストにも同じキーの利用料がかかる |
| ElevenLabs | https://elevenlabs.io/ | TTS（`elevenlabs` 切替時） | 条件付き | API key・Voice ID が必要。料金は公式で確認 |
| OpenAI互換 TTS / ローカル TTS | 利用する endpoint に応じる | TTS（`openai-compatible` 切替時） | 条件付き | `api.openai.com` は API key 必須。既定外のローカル endpoint は key なしでも利用可 |
| ngrok | https://ngrok.com/ | WebSocket トンネル（外部接続用） | 条件付き（一般的な構成） | 無料/有料とも内容は変わりうる |
| Tailscale | https://tailscale.com/ | ngrok代替の到達経路（self-hosted Attendee 等） | 任意 | 無料/有料とも内容は変わりうる |
| Zoom Marketplace | https://marketplace.zoom.us/ | Zoom Bot 権限・アプリ管理 | 条件付き | プラン/権限要件は運用形態次第 |
| Slack Bot | https://api.slack.com/apps | ステータス通知・サマリー投稿 | 任意 | Slack 側プラン条件を確認 |
| Discord Developer Portal | https://discord.com/developers/applications | Discord 音声チャンネル参加用の Bot（[専用セクション](#discord-ボット音声チャンネル参加)参照） | 任意（Discord 利用時のみ） | Bot 作成は無料 |

> ⚠️ API key / token はすべて秘密情報。Git に commit しない、画面共有・ログ共有・Issue・スクリーンショットにも貼らないこと。保存場所は種類によって異なる — Soniox / Fish Audio / Attendee / Slack Bot token のようなベンダーキーは `config.json`（パーミッション 0600）、Gateway の URL/Token や OpenAI互換キーのような接続系の値は `.env`（環境変数）。ベンダーキーの入力先は `init` ウィザードか設定 UI。接続系の値だけは設定 UI から書けないため、`init` ウィザードで生成するか `.env` に直接書く。
> ⚠️ tool 実行まで許可する OpenAI互換 gateway を使う場合も、その endpoint は **信頼できるローカル gateway** に限定すること。外部・不特定・未信頼 meeting では使わないこと。

### 前提条件

- Node.js v26+（`package.json` の `engines` 準拠）
- 既定の `openclaw` プロバイダでは OpenClaw Gateway が同一マシンで稼働中
  - Gateway URL: `http://localhost:<port>`（Gateway のポートに合わせる）
  - Gateway Token: `openclaw.json` の `gateway.token` を確認
- `LLM_PROVIDER=openai-compatible` を使う場合は OpenClaw Gateway 不要
- ngrok アカウント（authtoken 設定済み）
- [事前録音 MP3](#事前録音-mp3)（任意機能）を使う場合は `ffmpeg` が PATH に必要（Ubuntu では標準で入っていない: `sudo apt install ffmpeg`。バイナリの場所は `FFMPEG` 環境変数でも指定できる）

### 会議プラットフォームの前提

- **Google Meet**: まずはこれを基本経路にする。Bot 参加時に Meet 側の **「参加をリクエストしています」承認** が必要。
- **Zoom**: 現時点では **自分が主催・管理できる会議** を前提にする。外部主催 Zoom、OBF、managed OAuth を「対応済み」とは扱わない。
- **Zoom Marketplace**: Zoom 経路を使うなら、Attendee/運用側で必要な Marketplace 設定と権限付与が済んでいることを確認する。
- **Discord**: **自分が管理するサーバー限定**で使う（guild allowlist が空のままだと全ての join を拒否する fail-closed 設計）。公式 Bot API 利用のため Attendee・ngrok は不要。セットアップは[専用セクション](#discord-ボット音声チャンネル参加)へ。

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

2. バナーに挙がった項目（エージェント ID・表示名・Wake Words・Soniox もしくは Deepgram のキー・選択した TTS プロバイダーの接続情報・Attendee のキーなど）を埋め、下部の **`変更を保存`** をクリックする。保存できると `設定を保存しました。` のトーストが出る。
3. サーバーを再起動する（`npx meetmate start` をもう一度、または常駐サービスなら再起動）。すべて揃っていればヘッダーのバッジが `読み込み済み` に変わり、setup mode のバナーが消える:

   <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/settings-page-basic.png" alt="設定完了後の基本タブ。読み込み済みバッジと緑の「設定は読み込み済みです」バナー" width="100%">

4. `/`（ダッシュボード）に移動し、会議 URL を貼り付けて参加させる。手順の画面つき詳細は [動作確認](#動作確認画面つきウォークスルー) を参照。

2人目以降のエージェントを増やす場合は [2人目のエージェントを増やす](#2人目のエージェントを増やすエクスポートインポート) を参照。設定項目の全体像は次章 [設定リファレンス](#設定リファレンスsettings-ui) にまとめてある。

### TTS プロバイダーを選ぶ

設定 UI の **音声合成プロバイダー** では次の3つだけを選べる。変更後は保存して Meetmate を再起動する。

- `fish-audio`（既定）: 既存の `tts.apiKey` / `tts.voiceId` / `tts.model` をそのまま使う。既存設定の編集は不要
- `elevenlabs`: API key、Voice ID、モデルを入力する。`tts_sample_rate` は ElevenLabs の PCM 対応値（8000 / 16000 / 22050 / 24000 / 44100 Hz）を指定する
- `openai-compatible`: Base URL、モデル、Voice を入力し、`tts_sample_rate` は `24000` にする。`api.openai.com` では API key が必須。既定外の Base URL では key を省略できる

ローカル OpenAI 互換サーバー（例: Irodori-TTS）を key なしで使う `config.json` の例:

```json
{
  "tts": {
    "provider": "openai-compatible",
    "sampleRate": 24000,
    "openaiCompatibleTts": {
      "baseUrl": "http://127.0.0.1:8080",
      "model": "irodori-tts",
      "voice": "default"
    }
  }
}
```

Meetmate はこの Base URL に `/v1/audio/speech` を付け、`response_format: "pcm"` で呼び出す。ローカルサーバー側も mono PCM16 / 24 kHz を返す必要がある。公開サーバーや `api.openai.com` へ key なしで接続するためのフォールバックはない。

---

## アバター画像を差し替える

設定 UI の **アバター** タブでは、静止画・フレームセット・2.5Dリグをまとめて確認できる。**静止画**カードで PNG を選択するとアップロード前にプレビューされ、登録後は次回の会議参加から Google Meet の参加者アイコンへ反映される。推奨は **256×256 px の正方形 PNG**。アップロード上限は 5 MiB だが、会議参加を軽く保つため 300 KB 以下を目安にする。

手動運用では、home（`AI_MEET_HOME` か カレントディレクトリ）配下の `assets/avatar.png` に同じ画像を配置できる（`init` は自動コピーしない）。

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

# Linux / WSL2（sips は macOS 専用）— ImageMagick か ffmpeg で代替（! と scale= は sips -z と同じ「正確に 256x256」指定）
convert input.jpg -resize '256x256!' <home>/assets/avatar.png      # ImageMagick 6（Ubuntu 24.04 の apt 標準。IM7 なら magick）
ffmpeg -y -i input.jpg -vf scale=256:256 <home>/assets/avatar.png  # ffmpeg
```

### 実験的なフレーム差し替えアバター

Fish Audio 構成では、発話マーカーに合わせて PNG を差し替える実験パスを利用できる。画像はパッケージに含まれないため、home 配下に次の6ファイルを自分で配置する。

```text
<home>/assets/avatar-frames/idle.png
<home>/assets/avatar-frames/talk1.png
<home>/assets/avatar-frames/talk2.png
<home>/assets/avatar-frames/talk3.png
<home>/assets/avatar-frames/blink.png
<home>/assets/avatar-frames/talk_blink.png
```

設定 UI の **フレームセット**カードから各ファイルを個別にプレビュー・登録・削除できる。推奨は **長辺 720〜1080 px、1枚 300 KB 以下**。サーバー上限は各 10 MiB、静止画を含むアバター素材全体で 64 MiB である。

公開 HTTPS origin / relay からは会議参加時に 6 枚を単一路で取りに行くため、実測で約 429 KB/s の経路では合計 11.5 MB の PNG セットが会議中に落ち切らず、1 枚あたり約 740 KB まで縮めると約 2 秒で見え始めた。
そのため frames モードのセッション生成時には、どれか 1 枚が 1 MiB 超または合計が 3 MiB 超なら `⚠️  avatar-frames:` を 1 行だけ記録する。
これはリサイズ推奨の警告だけで、セッション自体は通常どおり開始され、欠けたフレームや壊れたフレームのフォールバック規則もそのまま適用される。

ダッシュボードの **アバター表示**で「フレームセット」を選ぶか、`/join-meeting` のフォームデータへ `avatarExperiment=hybrid-local-frames` を追加すると、このページが選ばれる。「設定に従う」は設定 UI の既定方式を使い、「標準（静止画）」は今回の参加だけ静止画を明示する。Fish Audio 以外の TTS 構成、または公開 HTTPS origin が無い構成では参加リクエストは拒否される。

画像ルートは参加セッションごとの capability で保護され、保存・キャッシュされない。個別の発話・瞬きフレームが無い、壊れている、または読めない場合は `idle.png` へ戻り、`idle.png` も利用できない場合は暗い診断用キャンバスへ戻る。壊れた画像アイコンやスクリプトエラーを会議画面へ出さない fail-closed 動作である。

### 2.5Dリグ / フレームセットの背景

設定 UI の **アバター** タブでは、2.5Dリグとフレームセットの両方のタイル背景を次の2項目で指定できる。変更は次回の会議参加から反映され、参加中の背景は切り替わらない。

- `avatar_rig_background_mode`: `solid`（単色）、`image`（埋め込み画像）、`chroma`（クロマキー）のいずれか。既定は `solid`
- `avatar_rig_background_color`: `#rrggbb` 形式。既定は `#08111f`。単色と、埋め込み画像を読み込めない場合のフォールバックに使う

`chroma` は設定色を使わず、全面を `#00FF00` にする。`image` の画像は設定 home から読むのではなく、各ページのビルド時に埋め込む。リポジトリからローカル運用用ページを生成する場合は次のように指定する。

```bash
node scripts/build-local-avatar-rig.js \
  --background /path/to/background.png \
  --out /path/to/local-avatar.js \
  --frames-out /path/to/frames.js
```

`--out` は 2.5Dリグページ、`--frames-out` はフレームセットページを書き出す。どちらも背景画像を含む生成物は `--model` の出力と同じくオペレーターのローカル利用専用であり、コミットしない。各ページには 2.5 MB 未満という固定上限があり、超える画像はジェネレーターが拒否する。画質と余裕を保つため、元画像は約 200〜300 KB を目安にする。

`image` を選んでも対象ページに画像が埋め込まれていないビルドでは設定色へ戻る。このときの状態は「このビルドには背景画像が埋め込まれていません」であり、ネットワークから画像を取得することはない。画像のデコードに失敗した場合も同じく設定色へ戻る。

---

## ngrok / Tailscale トンネル（外部接続用）

### 固定ドメインの取得（初回のみ）

Meet Bot が外部から WebSocket 接続を受けるために、公開 URL が必要。
ngrok の固定ドメイン（無料プランで1つ）を使うと、再起動してもURLが変わらない。

1. https://dashboard.ngrok.com にログイン
2. 左メニュー「**Domains**」→「**Create Domain**」
3. 自動生成されたドメイン（例: `pretty-duckling-abc123.ngrok-free.dev`）をコピー
4. 設定 UI の **詳細** タブにある「ngrok ドメイン」に貼り付けて保存する（再起動が必要）

> 💡 **ngrok 側で必要なのは「固定 Domain」と「Authtoken」の2つだけ。** Dashboard に「Start Endpoint」等のボタンがあるが、押す必要はない — エンドポイントは手元で `ngrok http ...` を起動した時点で有効になる（次節）。Authtoken は Dashboard 左メニュー「Your Authtoken」からコピーし、`ngrok config add-authtoken <token>` で一度設定すればよい。

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

### WSL2 で使う場合（ngrok は WSL2 の中で動かす）

ngrok の自動検出は、サーバーと同じマシンの `localhost:4040`（ngrok のローカル API）を見る。ngrok を **Windows ホスト側**で動かすと、WSL2 内のサーバーからはこの API に届かないため（既定の NAT ネットワーク構成の場合）「ngrok が起動していない」扱いになり、bot に公開 WSS URL が渡らず参加に失敗する。

- 基本は **ngrok も WSL2 の中で起動する**（このガイドのコマンドをそのまま WSL2 内で実行する）
- ngrok を Windows 側で動かす構成を続けたい場合は、設定 UI の **詳細** タブ「ngrok ドメイン」（`server.ngrokDomain`）にドメインを明示して自動検出をバイパスする

### ngrok 以外のトンネル（Tailscale funnel など）

設定 UI の **詳細** タブ「公開オリジン」（`server.publicOrigin` / 環境変数 `PUBLIC_ORIGIN`）に `https://host:port` を設定する。
解決順は 公開オリジン → ngrok ドメイン → `PUBLIC_WSS_URL`（後方互換）→ ngrok 自動検出。
設定を保存した後は、サーバーの再起動が必要。

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

## Discord ボット（音声チャンネル参加）

> **プレビュー（ライブ検証前）** — この章の Discord 経路は、実サーバーでのライブ E2E 検証（[#138](https://github.com/caty-ai/meetmate/issues/138)）より先に出荷している。未確認の項目: 音声の退出コマンドで実機がチャンネルを抜けるか（[#139](https://github.com/caty-ai/meetmate/issues/139)）、複数話者の帰属が画面上で見えるか（[#140](https://github.com/caty-ai/meetmate/issues/140)）。#138 が PASS した時点でこの注記は外す。

Meetmate は Google Meet / Zoom に加えて、**Discord の音声チャンネルに Bot として参加**できる。 Discord 用のライブラリ（discord.js / @discordjs/voice と native の Opus・sodium）は `optionalDependencies` として通常の `npm install meetmate` で入る。`--omit=optional` で入れた環境では Discord 経路が `503 DISCORD_DEPENDENCY_MISSING` になる（Meet/Zoom は影響なし）。公式 Bot API（discord.js）を使うので、ヘッドレスブラウザも Attendee も ngrok も不要（Bot 側から Discord へ外向きに接続する）。**第1弾の対象は自分が管理するサーバーのみ** — 公開サーバーでの運用は対象外。

### Bot を作成する（Developer Portal）

1. https://discord.com/developers/applications → **New Application** → 名前を付ける。
2. 左メニュー **Bot** → **Reset Token** → 表示された token をコピーする（この画面を閉じると二度と表示されない）。
3. 同じ Bot ページの **Privileged Gateway Intents** は **すべて OFF のまま**にする（Presence / Server Members / **Message Content** のどれも不要）。Meetmate が使う `Guilds` / `GuildVoiceStates` は非特権 intent で、コード側の指定だけで動く。
4. **Bot のアイコン（アバター）はこの Developer Portal の Bot ページで設定する** — Meetmate の設定 UI にあるアバター設定は Meet/Zoom のタイル用で、Discord 側の見た目には反映されない。

### サーバーへ招待する（最小権限）

左メニュー **OAuth2 → URL Generator** で scope に `bot` を選び、Bot Permissions は次の **3つだけ**にチェックする:

| 権限 | 用途 |
|---|---|
| View Channel | チャンネルの存在を見る |
| Connect | 音声チャンネルへ接続 |
| Speak | 音声を再生 |

生成される招待 URL の permission integer は `3146752`。**これより多い権限を付けるのは「不要」ではなく「非対応」** — 管理者権限・テキスト送信・メンバーのミュート/移動などを付けた構成はサポートしない。

### Token を保存する

- 入力先は **設定 UI の `Discord Bot token`（masked フィールド）**。保存先は `config.json`（パーミッション 0600）で、設定エクスポートには**含まれない**。
- 環境変数 `DISCORD_BOT_TOKEN` の効き方は設定の4段優先（起動環境変数 → 設定ストア → `.env` シード → 既定値）に従う: **起動時のシェル環境変数は設定 UI の保存値より優先される**が、**`.env` の行は設定 UI に値があれば効かない**（ストアが空のときのシードとしてのみ働く）。どちらもローテーション時は掃除しておくこと（下記）。
- ⚠️ Bot token は**常在の身分証**: 会議ごとの参加キーと違い、漏れると次のローテーションまで「いつでも・Bot が居る全サーバーに対して」悪用できる。画面共有・ログ・Issue に貼らない。

### 参加を許可するサーバー（guild allowlist）

- 設定 UI の **Discord サーバー許可リスト**（`discord_guild_allowlist`）に、参加を許可するサーバー（guild）の ID を追加する。**空のままだと全ての join を拒否する**（安全側の既定）。
- 許可リストに ID を入れた時点で「Discord を使う設定」とみなされ、Bot token が空だとダッシュボードの `/health` と全体の readiness が setup mode になる（Meet/Zoom の join 自体は transport 別に判定されるので通る）。Discord をやめるときは許可リストも空に戻す。
- ID の取得: Discord クライアントの 設定 → 詳細設定 → **開発者モード** を ON → サーバー名/チャンネル名を右クリック → **ID をコピー**。

### 参加する・退出する

- ダッシュボード（`/`）で transport に **Discord** を選び、**guild ID と voice channel ID** を入力して **Join**。参加すると Bot は**最初に必ず入室アナウンス**を行い、アナウンス完了までは音声のキャプチャを開始しない。
- **TTS プロバイダの制約**: Discord 経路は現時点で **Fish Audio 前提**（他プロバイダ選択時は join が 503 になる）。TTS 出力レートも 24000 / 48000 Hz のみ対応。
- 退出は **Leave ボタン（`POST /api/discord/leave`）が確実な経路**。音声での退出コマンドの Discord 対応は現在確認中（[#139](https://github.com/caty-ai/meetmate/issues/139)）。
- `/api/discord/*` はセキュリティ上 **loopback（同一マシン）からのみ**受け付ける。ssh の `-L` 転送や素通しのプロキシは loopback に見えるため、Bot 操作 UI を他人と共有しない。

### 記録と同意について（運用ルール）

- **入室アナウンスは常に ON**（v1 では OFF にできない）。「wake word で応答する Bot であること・応答のために音声を文字起こしすること」を入室時に必ず伝える設計。
- 文字起こしの保持は既存の会議 transcript と同じ扱い。Slack サマリーも既存の `summary_enabled` 設定に従う。
- 長期記憶への取り込み（LCM ingest）は **Discord では行われない**（取り込み機能自体が Discord 経路では未実装。`discord_lcm_ingest_enabled` は将来の opt-in 用の予約フラグで既定 OFF — 現時点で ON にしても何も有効にならない）。
- Bot は**セッション単位で参加・退出**し、待機のために音声チャンネルに居座ることはない。
- 会話の途中から入ってきた人には、メンバー一覧の Bot 表示と入室済みアナウンスがその場の告知になる。**気になる場で使うときは、参加者に一言伝えてから使うこと。**

### Token のローテーション

1. Developer Portal → Bot → **Reset Token**（この瞬間から旧 token は無効 = Bot は停止扱い）。
2. 新しい token を設定 UI の masked フィールドに貼って保存。
3. **環境変数のコピーを消す**: 起動環境（シェル）に `DISCORD_BOT_TOKEN` が残っていると、再起動後もそちら（無効または漏えいした旧値）が設定 UI の新値より優先されてしまう。`.env` の行は設定 UI に値がある限り効かないが、将来ストアを空にしたときに古い値が復活しないよう、同時に消しておく。Meetmate は `.env` を書き換えないので、この削除は手作業。
4. Meetmate を再起動する（token の反映には再起動が必要）。
5. `discord` の接続テスト、または allowlist 済みサーバーで Bot がオンラインになることで確認。
6. 漏えい疑いでのローテーションなら、Portal 側で Bot の参加サーバー一覧も点検して、身に覚えのないサーバーからは退出させる（allowlist があるので勝手に稼働はしないが、membership 自体も掃除する）。

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
| デプロイ | 読み取り専用の診断情報 — 実際に bind されたポート（`server_port`）、解決済み home（`resolved_home`）、その他の環境診断値（例: AI 応答の待機時間 `llm_response_timeout_ms`）。環境診断値の各行は「名前 / 現在値 / 出所（`default` / `.env-seed` / `os-env`）」の3列（`server_port` と `resolved_home` の出所は `runtime`）。ここでは編集できない — 環境診断値の変更は home の `.env` か起動時の環境変数で行い、再起動で反映される（`resolved_home` だけは起動時の `AI_MEET_HOME`（未設定なら起動ディレクトリ）で決まり、`.env` では変えられない）。例は [AI 応答の待機時間](#ai-応答の待機時間タイムアウト) |
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

### AI 応答の待機時間（タイムアウト）

会議中に呼びかけてから AI の**最初の応答チャンク**が届くまでの待ち時間の上限（`LLM_RESPONSE_TIMEOUT_MS`）。既定は **35 秒**（`35000` ms）。時間内に最初のチャンクが届かないと、Meetmate はその turn を打ち切り、音声プリセットの「タイムアウト」文言を読み上げてフォールバックに進む（文字起こしがあればその後 handoff としてエージェントに引き継ぐ）。ログには `⏱️  LLM first-response timeout (…ms) — aborting [stage=…]` が出て、`stage=gateway_no_response`（HTTP 応答を受け取る前に時間切れ）/ `agent_no_output`（Gateway は応答したがストリームにイベントが来ない＝エージェント側がツール実行などで止まっている）/ `stream_no_content`（イベントは流れたが本文が無い）で切れた段階を判別できる。同じ値は会議サマリー生成リクエスト全体のタイムアウトにも使われる。

**`openclaw` provider（既定）にはもう 1 本、先に発火するタイマーがある。** `FIRST_TOKEN_DELEGATE_MS`（既定 **15 秒** = `15000`・`0` で無効）を超えても最初のチャンクが来ないと、Meetmate はその turn を打ち切ってバックグラウンド委譲（handoff）に回す（ログ `⏱️  LLM first-token delegate threshold (…ms) — aborting for handoff`・詳細は [operations.md](operations.md)）。つまり既定構成の実効的な待ち時間は 35 秒ではなく **15 秒**で、`LLM_RESPONSE_TIMEOUT_MS` だけを伸ばしても効かない。待ち時間を伸ばすときは**両方**を上げる（例: `FIRST_TOKEN_DELEGATE_MS=60000` と `LLM_RESPONSE_TIMEOUT_MS=60000`）。`openai-compatible` provider ではこのタイマーは動かず、`LLM_RESPONSE_TIMEOUT_MS` だけが効く。

| 項目 | 内容 |
|---|---|
| 環境変数 | `LLM_RESPONSE_TIMEOUT_MS`（ミリ秒・整数・`0`〜`3600000`）。`0` にすると会議中の first-response タイムアウトを無効化する（会議サマリー生成だけは固定の 30 秒に戻る）。`openclaw` provider では `FIRST_TOKEN_DELEGATE_MS` も併せて設定する |
| 現在値の確認 | 設定画面 → **デプロイ** タブ → `llm response timeout ms` 行（`openclaw` なら `first token delegate ms` 行も）。値と出所（`default` = コード既定値 / `.env-seed` = home の `.env` / `os-env` = 起動時の環境変数）が並ぶ。範囲外や小数の値はデプロイタブではその段が無効扱いになり次の段（最終的に `default`）の値が表示される一方、実行時はその値がそのまま使われて表示と実値がずれるので、必ず範囲内の整数を書くこと |
| 変更方法 | home（`resolved_home` に表示されるディレクトリ）の `.env` に `LLM_RESPONSE_TIMEOUT_MS=60000` のように書いて**再起動**する。起動時の環境変数で渡してもよい（こちらが `.env` より優先）。設定画面からは編集できない（読み取り専用の診断値） |
| 目安 | 接続先エージェントが天気・検索などの**ツールを呼ぶ turn** や、Claude/tool turn を使う gateway では、最初のチャンクまで 35 秒を超えることがある。まず **60 秒前後**（`60000`）から始め、上流 gateway 側の deadline より短くしすぎないこと |

会議参加中に `.env` を書き換えても反映されない。変更後は必ず Meetmate を再起動し、デプロイタブの出所が `.env-seed`（または `os-env`）に変わり、値が書いたとおりに表示されることを確認する。

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

ElevenLabs と OpenAI 互換 TTS は角括弧の感情タグを常に除去し、ライブで感情を音声に反映する機能は現時点では Fish Audio のみが対応している。

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
- 静止画とフレームセット（`assets/avatar.png` / `assets/avatar-frames/*.png`）
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

**接続テスト** タブには Soniox / Deepgram / Fish Audio / ElevenLabs / OpenAI-compatible TTS / Attendee / LLM / Tunnel / Slack / Discord のテストボタンがある。Slack 以外は実装済みで、TTS は選択前でも保存済みの接続情報を個別に確認できる。

- タイムアウト: 5秒
- 結果表示: `<サービス名>: <コード> — <説明> (<n> ms)`（コードは `CONNECTED` / `NOT_CONFIGURED` / `AUTH_FAILED` / `PAYMENT_REQUIRED` / `NOT_ENABLED` / `MISMATCH` / `RESTART_REQUIRED` / `UNREACHABLE` / `TIMEOUT` / `RATE_LIMITED` / `PROVIDER_ERROR` のいずれか。Discord のみ、Bot が許可リストのどのサーバーにも参加していないときに `ALLOWLIST_MISMATCH` が出る）
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
- アップロードされた MP3 の変換に `ffmpeg` を使う（PATH に必要 — [前提条件](#前提条件) 参照）
- 上限: 1ファイル 10MB、合計 128MB、最大32クリップ、1クリップ30秒まで
- **現在の音声設定と一致しない場合は自動再生されず、通常の TTS 読み上げにフォールバックする**

---

## 常駐サービス（自動起動）

macOS でも Linux / WSL2 でも、常駐サービスの登録は同じ1コマンド。OS を判定して、macOS では launchd の LaunchAgent、Linux / WSL2 では systemd user unit を設定する:

```bash
./scripts/install-service.sh \
  --label ai-meet.<agent-name> \
  --dir "$(pwd)" \
  --port <port>
```

`--port` はログ表示用の情報であり、サービス定義には埋め込まれない（実際に使うポートは起動時の `PORT` 環境変数か `config.json` の `server.port`。設定 UI からは変更できず、デプロイタブに実測値が表示されるのみ）。

どちらの OS でも、アプリ本体のログは `<dir>/logs/meet-server.stdout.log` / `meet-server.stderr.log` に追記される。ヘルスチェック + 自動再起動の watchdog（`./scripts/watchdog.sh --service ai-meet.<agent-name> --port <port>` — cron 等の定期実行から呼ぶ。既定値は `ai-meet.server` / `5005` なのでラベルとポートは明示する）も両 OS の常駐サービスに対応している。

### macOS（launchd / LaunchAgent）

macOS では `install-service.sh` が `install-launchagent.sh` に委譲し、`~/Library/LaunchAgents/ai-meet.<agent-name>.plist` を生成する（直接 `./scripts/install-launchagent.sh` を呼んでも同じ）。

#### 環境変数の追加

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

### Linux / WSL2（systemd user unit）

Linux では `~/.config/systemd/user/ai-meet.<agent-name>.service` が生成され、`systemctl --user enable` と起動・起動確認まで自動で行われる。前提は systemd の user manager が動いていること。

- **WSL2 の注意**: WSL2 で systemd が無効な環境ではインストーラが失敗し、次の案内を出す。その場合は `/etc/wsl.conf` に次を追記し、Windows 側で `wsl --shutdown` を実行してから WSL を開き直す:

  ```ini
  [boot]
  systemd=true
  ```

- **ログアウト後も動かし続ける**: 一度だけ次を実行する（SSH / cron だけの環境でもサービスが生存する。インストーラ末尾にも案内が出る）:

  ```bash
  loginctl enable-linger $USER
  ```

- **状態確認とログ**:

  ```bash
  systemctl --user status ai-meet.<agent-name>
  journalctl --user -u ai-meet.<agent-name>
  ```

  journal に載るのはサービスの起動 / 停止 / 失敗などライフサイクルのみ。アプリ本体の出力は `logs/meet-server.stdout.log` / `meet-server.stderr.log` に追記されるので、エラー調査はまず `logs/meet-server.stderr.log` を見る。

- **環境変数の追加**: 生成された unit ファイルの `[Service]` セクションに `Environment=WAKE_CALIBRATE_ENABLED=1` の形式で行を追記し、反映する（unit 内の `PATH` は node と `/usr/local/bin:/usr/bin:/bin` に固定されるため、これ以外の場所にある `ffmpeg` を使う場合は `Environment=FFMPEG=/path/to/ffmpeg` を同じ要領で追記する）:

  ```bash
  vi ~/.config/systemd/user/ai-meet.<agent-name>.service
  systemctl --user daemon-reload
  systemctl --user restart ai-meet.<agent-name>
  ```

  plist と同じく、unit ファイルはインストーラを再実行すると作り直されるため、追記した環境変数は再インストール後に入れ直す。

---

## ウェイクワードキャリブレーション

初期状態の「Wake Word の認識候補」が空の場合、STT の誤認識バリアントを検出できずウェイクワードが反応しないケースがある。

### キャリブレーション手順

1. `.env` に `WAKE_CALIBRATE_ENABLED=1` を追加（常駐サービスでも `.env` で足りる。LaunchAgent plist / systemd unit に設定してもよい — [常駐サービス](#常駐サービス自動起動) の「環境変数の追加」参照）— この機能フラグは環境変数専用で、設定 UI からは変更できない
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
- 設定 UI の基本タブで **音声合成プロバイダー** が意図した `fish-audio` / `elevenlabs` / `openai-compatible` になっているか確認
- 選択したプロバイダーの API キー・Voice ID・モデル・Base URL を確認（接続テストタブでも確認できる）
- サーバーログに選択したプロバイダー名の `TTS パイプラインモード` が表示されているか確認
  - `🔊 Deepgram Voice Agent モード` は、3つの対応プロバイダー以外の従来値を明示した場合だけ使われる。設定を対応値へ戻して再起動する

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
- `LLM_RESPONSE_TIMEOUT_MS` は upstream gateway の deadline より短くしすぎないこと。Claude/tool turn を使うなら 60 秒前後から始めるのが安全。現在値は設定画面のデプロイタブで確認できる（詳細は [AI 応答の待機時間](#ai-応答の待機時間タイムアウト)）
- これは **既存の `openai-compatible` provider の設定**。Claude 専用 provider を追加するわけではない
- 外部主催 meeting、不特定参加者 meeting、未信頼 gateway では `trustedAgentTools` を有効にしないこと

### Hermes background delegation

接続先が Hermes Agent の `api_server` である場合に限り、設定画面の `openai_session_header`（`config.json` では `llm.openaiCompatible.sessionHeader`）を `X-Hermes-Session-Id` に設定する。Meetmate はライブ会議ごとに安定した `meet-…`形式のセッション ID（エージェント切り替え後は `meet-…-<agentId>`）を、OpenAI body の `user` フィールドと同一の値でこのヘッダーへ送り、Hermes が background delegation の結果を後続の wake turn へ返せるようにする。

VPS 側では、Hermes profile で `delegation` toolset を有効にする必要がある（現時点では `[hermes-cli]` profile のみ）。さらに `API_SERVER_KEY` を server-side に設定してから `api_server` を起動すること。

> ⚠️ **非 Hermes endpoint には設定しないこと。** 設定すると、内部の meeting session ID がその endpoint への全リクエストで送信される。既定値は空で、空のままならヘッダーは送信されない。

ライブ E2E（会議 turn が即座に戻り、結果が後続の wake turn で届くこと）の確認は、上記 VPS prerequisite が有効になってから実施する。ライブ E2E は issue #119 で追跡する。

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
STT(Soniox stt-rt-v5 既定 / Deepgram 切替可) → ウェイクワード検出 → LLM(OpenClaw Gateway 既定) → TTS(Fish Audio 既定 / ElevenLabs / OpenAI互換) → Meet/Zoom
```

詳細は `docs/architecture.md` を参照。
