# 設計: ユーザー向け診断 ID（#75 (ii)・v1）

- 状態: **決裁済み（2026-09-05・#75 Owner decision: 推奨 3 点すべて Yes）**。実装 Issue= #197「診断 ID v1」（本書はその PR に同梱）。
- 実装時の補足（#197）: blockers / systems の `system` は常にプローブ系（`soniox` 等）なので、静的検証コード（`VALUE_REQUIRED` 等）も **`system` 由来の AREA を優先**する（例: `soniox` × `VALUE_REQUIRED` → `MM-STT-002`）。`SET` は `system` が無い・未知のときの静的検証コードの受け皿。
- v1 出荷範囲の注記（#197）: 設定画面の接続テスト結果行の ID 表示と、メイン画面行の「対処法」docs アンカーリンクは v1 では未実装（`connectionResult()` が `src/settings/routes.js` にあり宣言外・後続 Issue）。§3/§4 の該当記述は v1 以降の目標として残す。
- 根拠: `origin/main` @ `a6b6d4a`（v8.13.5 + #193）の実測。コード変更なし。
- 親: #75（横断提案「エラーを処理段階ごとに分類する」）。関連: #84（readiness gate）・#74（timeout stage ログ・v8.13.5）・#87（実キー分類検証）。

## 1. 何を解くか

今の meetmate は「どこが・なぜ・次に何をするか」を **内部的にはもう持っている**（readiness の `system` × `code` × `fieldId` × `message`）。足りないのは、その組を **ユーザーが読み上げ・貼り付け・検索できる 1 つの短い ID** にすること。ID があると:

- 非技術ユーザーが「`MM-STT-101` と出ました」と伝えるだけで、支援側（Issue・家族 AI・ドキュメント）が原因と次の操作を特定できる。
- 設定画面・メイン画面・operator ログ・Issue テンプレートで **同じ語彙** を使える（今は画面ごとに文言表が別: `readiness.js` の `MESSAGES` / `settings.js` の `CONNECTION_EXPLANATIONS` / `ISSUE_LABELS`）。
- 会議中の失敗（#74 の stage）を参加前診断と同じ体系に載せられる。

## 2. ID 体系

```
MM-<AREA>-<NNN>
   │       └ 原因番号（3 桁・百の位＝「誰が直すか」の層）
   └ 領域（3 文字・ユーザーが役割で認識する単位）
例: MM-STT-101  = 音声認識（Soniox/Deepgram）の支払い状態エラー
    MM-LLM-103  = OpenClaw 側で chatCompletions endpoint が無効
    MM-LLM-511  = 会議中: Gateway は応答したがエージェントが出力しないままタイムアウト
```

### 2.1 領域（AREA）= readiness の `system` から決定論で写像

| AREA | 対象 `system` | 意味（ユーザー語） | 備考 |
|---|---|---|---|
| `SET` | 静的検証（`envelope.issues`） | 初期設定 | `VALUE_REQUIRED` 等の 7 コード（`public/settings.js:214-220`） |
| `STT` | `soniox` / `deepgram` | 音声認識 | プロバイダー名は **文言側** に入れる（ID は役割固定） |
| `TTS` | `fish-audio` / `elevenlabs` / `openai-compatible` | 音声合成 | 同上 |
| `LLM` | `llm` | AI（OpenClaw / OpenAI 互換） | 会議中の応答タイムアウトもここ |
| `ATT` | `attendee` | Meet 参加ボット（Attendee） | |
| `TUN` | `tunnel` | 公開 URL（ngrok 等） | |
| `DSC` | `discord` | Discord | `ALLOWLIST_MISMATCH` を含む |
| `SLK` | `slack` | Slack | 現状 gate 外・接続テストのみ |
| `MMT` | `settings` / meetmate 本体 | meetmate 本体 | `RESTART_REQUIRED` など |

領域を **プロバイダー別（SON/DGM/…）にしない理由**: ユーザーは「音声認識が止まった」と役割で認識する・プロバイダーは設定で切り替わる・支援側の表が 2 倍に膨らむ。プロバイダー名は文言の先頭（`CONNECTIONS` の表示名）で示す。

### 2.2 原因番号（NNN）= readiness の `code` と 1:1 の固定表

百の位で「誰が直すか」を表す。**HTTP ステータスは使わない**（404 が `llm` では `NOT_ENABLED`、他では `PROVIDER_ERROR` に分岐する・ネットワーク系は HTTP を持たない・ユーザーが HTTP 番号と誤読する）。HTTP は文言の detail に併記する。

| NNN | readiness `code` | 層 | 発生源（実測） |
|---|---|---|---|
| **0xx = 入力・設定（ユーザーが設定画面で直す）** | | | |
| 001 | `NOT_CONFIGURED` | hard | probes（キー未設定）・tunnel ドメイン未設定 |
| 002 | `VALUE_REQUIRED` | 静的 | `envelope.issues` |
| 003 | `VALUE_INVALID` | 静的 | 〃 |
| 004 | `PROVIDER_DEPENDENCY_REQUIRED` | 静的 | 〃 |
| 005 | `LLM_CONNECTION_ENV_REQUIRED` | 静的 | 〃 |
| 006 | `AGENT_ID_RECONCILIATION_REQUIRED` | 静的 | 〃 |
| 007 | `LEGACY_CONNECTION_CONFIG_PRESENT` | 静的 | 〃 |
| 008 | `CONFIG_DOCUMENT_INVALID` | 静的 | 〃 |
| **1xx = プロバイダー側の拒否（ユーザーがプロバイダーの管理画面で直す）** | | | |
| 100 | `AUTH_FAILED` | hard | HTTP 401（attendee/discord は 403 も） |
| 101 | `PAYMENT_REQUIRED` | hard | HTTP 402 |
| 102 | `RATE_LIMITED` | soft | HTTP 429 |
| 103 | `NOT_ENABLED` | hard | HTTP 404 かつ `llm`+`openclaw` |
| 104 | `ALLOWLIST_MISMATCH` | hard | discord のみ |
| **2xx = 到達性・応答（一時的な可能性・再試行か URL 確認）** | | | |
| 200 | `UNREACHABLE` | soft | ECONNREFUSED / ENOTFOUND ほか・`/health` 非 JSON |
| 201 | `TIMEOUT` | soft | probe の時間切れ |
| 202 | `MISMATCH` | hard | tunnel の instanceId 不一致 |
| 209 | `PROVIDER_ERROR` | soft | 上記以外の HTTP・不明エラー（既定の受け皿） |
| **3xx = meetmate 本体の状態** | | | |
| 300 | `RESTART_REQUIRED` | hard | class-2 変更の保存後 |
| 301 | `PENDING` | — | 確認中（ID は表示するが赤にしない） |
| **5xx = 会議中の失敗（#74 の stage・ログ由来）** | | | |
| 510 | `gateway_no_response` | 会議中 | LLM timeout: request は出たが HTTP 応答なし |
| 511 | `agent_no_output` | 会議中 | Gateway は応答・SSE イベントなし（tool 実行中 or 停滞） |
| 512 | `stream_no_content` | 会議中 | イベントは来たが content なし |

- `CONNECTED` は ID を持たない（正常）。
- 表にない `code` が来たら `MM-<AREA>-209` に落とす（`readiness.js:209` の `PROVIDER_ERROR` 既定と同じ姿勢）。**必ず何かの ID が出る** ことを保証する。
- 番号は **追記のみ・再利用禁止**（ID は外部に貼られるので意味を変えない）。

### 2.3 会議中の失敗を同じ体系に載せるか → **載せる（v1 は 2 種類だけ）**

| 会議中の事象 | 今の実装 | v1 での扱い |
|---|---|---|
| STT 実行時の 401/402/403/404/429 | `stt-soniox.js` → `reportRuntimeFailure` → readiness に同じ `code` で反映（#84 DW6） | **追加実装なし**で参加前診断と同じ ID（`MM-STT-100/101/102/209`）が付く |
| LLM 応答タイムアウトの stage | `pipeline.js:2323` の `[stage=…]` ログ（v8.13.5） | ログ行に `diagnostic=MM-LLM-51x` を **1 トークン追記**。発話（`timeoutFallback`「ごめん、ちょっと時間がかかってるね」）は変えない＝会議中に ID を読み上げない |
| LLM 実行時の 404/401（#75 時系列 6） | 参加前 probe で捕捉済み（`NOT_ENABLED` / `AUTH_FAILED`）。会議中の分類は未実装 | v1 では対象外（`reportRuntimeFailure` を llm にも広げるのは別 Issue・#74 案 2 と一緒に） |
| Tool / TTS 段の失敗 | 段の判別ログなし | v1 では対象外（5xx の番号は予約: 52x=tool, 53x=tts） |

理由: 会議中に ID を音声で読み上げても誰もメモできない。会議中の ID は **operator ログとメイン画面の「最後の失敗」行**（後者は (i) 専用診断画面の範囲）に出す。

## 3. 対応表: ID × 文言（日本語 / 英語）× 次の操作

- **画面は日本語のみ**（`settings.html` / `index.html` とも `lang="ja"`・UI の i18n 基盤なし）。英語文言は **ドキュメント側の一覧表**（`docs/diagnostic-ids.md`）に載せ、README 4 言語からリンクする。UI 英語化は本 Issue の範囲外。
- 「次の操作」= 既存の `fieldId` → `http://127.0.0.1:<port>/settings#field-<fieldId>` / `#panel-connections`（`public/app.js:180` の `localSettingsUrlFor`）をそのまま使う。加えて docs の `#mm-xxx-nnn` アンカーへのリンクを 1 つ足す。
- 表示形式（案）: `[MM-STT-101] Soniox: 支払い状態を確認してください → 設定を開く / 対処法`

| ID | 日本語（UI・既存文言を踏襲） | English（docs） | 次の操作（fieldId / 外部） |
|---|---|---|---|
| `MM-*-001` | `{provider}` の必要な接続設定が未入力です | `{provider}` connection settings are missing | `DEFAULT_FIELDS[system]` |
| `MM-SET-002…008` | `ISSUE_LABELS` の既存 7 文言 | Required value missing / Saved value invalid / Provider dependency missing / LLM connection info missing / Agent ID needs reconciling / Legacy connection config present / Config file unreadable | `issue.fieldId` |
| `MM-*-100` | `{provider}` の認証情報を確認してください（HTTP 401） | `{provider}` rejected the API key (HTTP 401). Re-check the key | API キー欄 + プロバイダー取得先 URL（v8.3.1 のリンク） |
| `MM-*-101` | `{provider}` の支払い状態を確認してください（HTTP 402） | `{provider}` reports payment required (HTTP 402). Top up or check billing | API キー欄 + 課金ページ |
| `MM-*-102` | `{provider}` のレート制限に達しました。しばらく待って再チェック | `{provider}` rate limit reached (HTTP 429). Wait and re-check | 再チェックボタン |
| `MM-LLM-103` | OpenClaw 側で `gateway.http.endpoints.chatCompletions.enabled` を有効にしてください | Enable `gateway.http.endpoints.chatCompletions.enabled` on the OpenClaw gateway | `panel-connections` + setup-guide の OpenClaw 節 |
| `MM-DSC-104` | 許可済みの Discord サーバーに Bot が参加していません | The bot is not in any allow-listed Discord server | `discord_guild_allowlist` |
| `MM-*-200` | `{provider}` へ到達できませんでした。URL とネットワークを確認 | Could not reach `{provider}`. Check the URL and network | base URL 欄 |
| `MM-*-201` | `{provider}` の接続確認がタイムアウトしました。再チェック | Connection check to `{provider}` timed out. Re-check | 再チェック |
| `MM-TUN-202` | 公開 URL は別の meetmate インスタンスを指しています | The public URL points at a different meetmate instance | `server_ngrok_domain` |
| `MM-*-209` | `{provider}` の応答を確認できませんでした（HTTP `{status}`） | Unexpected response from `{provider}` (HTTP `{status}`) | base URL / モデル名欄 |
| `MM-MMT-300` | 保存済み・meetmate の再起動が必要です | Saved. Restart meetmate to apply | 再起動手順（setup-guide） |
| `MM-*-301` | 確認中… | Checking… | — |
| `MM-LLM-510` | （ログのみ）AI ゲートウェイから応答がありませんでした | Gateway did not answer before the timeout | `openai_base_url` / timeout 設定（#74 案 1） |
| `MM-LLM-511` | （ログのみ）AI は受け付けましたが応答が始まりませんでした（ツール実行中の可能性） | Gateway accepted the request but the agent produced no output (a tool may still be running) | timeout 設定（60 s 目安）・#74 案 2 |
| `MM-LLM-512` | （ログのみ）AI の応答に内容がありませんでした | Stream delivered events but no content | `llm_model` / agent 設定 |

`{provider}` = `CONNECTIONS` の表示名（Soniox / Deepgram / Fish Audio / …）。billing 系 hard code に付く既存の補足文（「メイン画面の再チェックでは確認できません…」）はそのまま残す。

## 4. どこに出すか（v1 の露出面）

| 面 | 今 | v1 |
|---|---|---|
| `/readiness` JSON | `systems[].code` / `blockers[].{system,code,fieldId,message}` | 両方に `diagnosticId` を追加（**既存フィールドは不変**・後方互換） |
| Join 失敗 `MEETING_NOT_READY` / `MEETING_SETUP_REQUIRED`（`src/transport-meet/meet-routes.js:1177,1270,1284`） | blockers / issues を同梱 | 同じオブジェクトなので自動で ID が乗る |
| メイン画面 readiness 行（`public/app.js:185` `readinessDisplayRows`） | `message` + 設定リンク | 先頭に `[MM-…]`・末尾に「対処法」リンク（docs アンカー） |
| 設定画面 接続テスト結果（`public/settings.js:1131`）・readiness サマリ（`:129`） | `label: CODE — 説明` | `label: [MM-…] 説明` |
| operator ログ（timeout 行 `src/pipeline.js:2323`・STT runtime 失敗行） | `[stage=…]` | `diagnostic=MM-LLM-51x` を追記 |
| docs | なし | `docs/diagnostic-ids.md`（ID → 意味 → 次の操作・ja/en）+ README 4 言語の Documentation 節に 1 行 |

**v1 でやらないこと**: 専用 1 画面（(i)）・コピーボタン・UI 英語化・Tool/TTS 段の判別・LLM 実行時失敗の readiness 反映・Issue テンプレートの自動生成。

## 5. 実装の形（別 Issue「診断 ID v1」の触るファイル予測）

- 新規 `src/settings/diagnostic-id.js`: `AREA_BY_SYSTEM` / `CAUSE_BY_CODE` の 2 表と `diagnosticIdFor(system, code)`（純関数・未知 code → `209`）・`describe(id)`（文言表）。**表は 1 か所**にし、`readiness.js` の `MESSAGES` と `settings.js` の `CONNECTION_EXPLANATIONS` はこの表から参照する方向へ寄せる（v1 では重複を残してもよいが、追加は新表にのみ）。
- `src/settings/readiness.js`: `getReadiness()` の `systems[]` / `blockers[]` に `diagnosticId`（`process.env` 読みなし → `docs/settings-env-inventory.json` の pin 影響なし）。
- `src/pipeline.js`: `buildLlmTimeoutStageSummary` に `diagnostic=` 追記（env 読みは :56-62 で上流 → pin 不変）。**risk path**（`risk-reviewed` ラベル）。
- `public/app.js` / `public/settings.js`: 表示 2 か所。
- `docs/diagnostic-ids.md`（新規）/ `docs/design/diagnostic-id.md`（本書）/ `README.md` + `docs/i18n/README.{ja,th,zh}.md` 各 1 行。
- テスト: 新規 `test/diagnostic-id.test.js`（全 system × 全 code で ID が出る・重複なし・表のスナップショット）+ `test/readiness.test.js` / `test/readiness-routes.test.js` / `test/join-ux.test.js` / `test/settings-ui.test.js` に行追加。`test/pipeline-timeout-stage.test.js` に `diagnostic=` 1 行。
- 触らない: `src/settings/registry.js` / `schemas.js` / `probes.js`（probe の `code` は不変）・`docs/settings-env-inventory.json`。

サイズ **M**（複数ファイルだが境界変更なし・JSON は追加のみ）。席= `loom-seats --size M`（異種 3）。出荷相当（UI 文言・ログ・docs）→ 次の bump v8.13.6 に同梱。

## 6. 翔さんに決めてほしい 3 点

1. **ID の形** `MM-<AREA>-<NNN>`（領域 3 文字・原因 3 桁・百の位＝誰が直すか）で Yes/No。代案 B= 原因番号を HTTP に寄せる（`MM-STT-402`）。B を採らない理由は §2.2。
2. **会議中の失敗を v1 に含めるか**: 推奨= 含める（LLM timeout の `51x` をログ行に追記するだけ・発話は不変）。No なら `pipeline.js` を触らず risk-reviewed 不要になる。
3. **英語は docs のみ**（UI は日本語のまま）で Yes/No。
