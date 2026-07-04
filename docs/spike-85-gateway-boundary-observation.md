# Spike #85: 委譲・完了イベントの Gateway 境界観測調査

- 調査日: 2026-07-04（architect agent による read-only コード調査、Alpha 書き起こし）
- 親 EPIC: #79（要件スペック: `docs/deep-interview-79-delegation-harness.md`）
- ステータス: **結論確定**（唯一の未検証点は #86 Step 0 に引き継ぎ）

## 1. TL;DR 結論

**推奨方式（1つに確定）: OpenClaw control-plane（WebSocket operator プロトコル、Gateway と同ポート 18789）に Caty から接続し、音声セッションを `sessions.subscribe` して `task_completion` 内部イベントを push 受信する。**

- 判定: **このリポ完結（条件付き）**。全コードは Caty 側に置け、OpenClaw のコード変更は不要（既存の push 契約を使う）。
- 唯一の前提 = 「Caty が持つ operator トークンに `sessions.subscribe` / `chat.history` の read scope があること」。**#86 の Step 0 として read-only 実機確認で Go/No-Go を切る**。
- scope 不足だった場合のみ案3（Gateway 協力）へエスカレーション（§4 に切り分けと Issue ドラフト）。
- **Caty が現在使う REST 経路（`POST /v1/chat/completions`）からは、LLM 自発の `sessions_spawn` 発火もサブエージェント完了も観測不可能**（コードで断定。explore 調査の「観測できない」は REST 経路に限れば正しい）。
  - ※ただし **C2 の機械強制委譲（`requestTimeoutHandoff`）は Caty 自身が発火主体**なので、この制約と無関係に発火回数をローカルで確定計測できる（→§5 #83）。観測不可なのは「LLM/サーバ起点の spawn 発火」と「完了」の2つ。

キー発見: **OpenClaw は既に、サブエージェント完了時に親（音声）セッションへ完了イベントを push している**。Caty がそれを listen していないだけ。

## 2. 検出経路の事実関係

> **引用の出所について**: `dist/...` の引用は本リポではなく、**ローカルインストールの OpenClaw Gateway 実体**（`openclaw 2026.4.5`, `~/.npm-global/lib/node_modules/openclaw/dist/`）のバンドル済み JS。ファイル名の build hash（`Cv5hzFG4` 等）と行番号は**バージョン更新で変わる**ため目安として扱うこと（挙動・スキーマの内容自体はコード確認済み）。`~/.openclaw/openclaw.json` の設定値（port/bind/auth.mode）は**このマシン固有**で、mini 側は #86 Step 0 で別途確認する。

### 2-1. REST 経路では観測不可（事実・コード確認済み）

- Caty→Gateway の通信は `POST /v1/chat/completions` のみ（`src/llm.js:148-149`、`src/gateway-warmup.js:98`、`src/pipeline.js:877`）。
- Caty の SSE パーサは `choices[0].delta.content` だけを抽出し、それ以外の data 行を全て破棄（`src/llm.js:203-204`, `:216-220`）。
- Gateway 側の chat/completions ストリーミングハンドラは、内部イベントバスのうち `assistant`（本文）と `lifecycle` の end/error だけをクライアントへ転送（`dist/server-Cv5hzFG4.js:22024-22055`）。内部バスには `tool` ストリーム（= `sessions_spawn` 発火）が存在するが転送されない。
- `/v1/responses`（新 API）の `function_call` 表出はクライアント宣言 tool 限定（`dist/server-Cv5hzFG4.js:22748`, `:22820-22837`）。`sessions_spawn` は内部エージェントツール（`dist/pi-embedded-DWASRjxE.js:16590`）のため表出しない。

### 2-2. 完了イベントの実体（事実）

- サブエージェント完了は **push 型 auto-announce** で親セッションに自発ターンとして注入される契約（`dist/pi-embedded-DWASRjxE.js:11035`。「polling するな、完了イベントは user message として届く」と明文化）。
- スキーマ = `AgentInternalEventSchema`（`dist/method-scopes-D4ep-GlN.js:273-368`）: `type:"task_completion"`, `source:"subagent"`, `childSessionKey`, `taskLabel`, `status:"ok"|"timeout"|"error"|"unknown"`, `result`（結果本文）, `mediaUrls?`, `statsLine?`, `replyInstruction`。
- REST run は `deliver:false` / `messageChannel:"webchat"`（`dist/server:21744`, `:21940`）のため、この自発ターンは Caty の HTTP レスポンスに乗らず、**現状 Caty から見て失われている**（※アーキテクチャからの推論。runtime トレース未取得）。

### 2-3. 観測可能な唯一の経路 = control-plane WS（事実＋一部要確認）

- Gateway は同ポート 18789 で WebSocket control-plane を提供（`dist/server-Cv5hzFG4.js` の `on("upgrade")` / `connect.challenge`。ローカル設定 `~/.openclaw/openclaw.json` = `port:18789`, `bind:"lan"`, `auth.mode:"token"`）。
- operator メソッドに `sessions.subscribe` / `sessions.changed` / `sessions.list` / `sessions.get` / `chat.history` / `chat.side_result` が存在。親セッション購読で `task_completion` を push 受信できる。
- Caty のトークンが `chat.send` scope を持つのは確定（REST が動作している事実）。**`sessions.subscribe` / `chat.history` scope の有無だけが未確認**。device-auth 材料は既存（`~/.openclaw-caty/identity/device.json`）。

## 3. 候補比較表

| 方式 | このリポ完結 | 検出遅延 | 取りこぼし/誤検知 | 実装コスト | 備考 |
|------|:---:|------|------|------|------|
| **A. control-plane WS `sessions.subscribe`（推奨）** | ○（scope 前提） | 低（push・秒未満） | 低（result 全文取得可） | 中〜大（WS operator クライアント新規: challenge ハンドシェイク/device-auth/購読管理） | `task_completion` を直接受信 |
| B. `chat.history` ポーリング | ○（同上） | 中（間隔依存） | 中（compaction で消失リスク） | 中 | operator からの参照は可だが push に劣る |
| C. Slack 監視 | △（Slack 基盤に結合） | 中〜高 | 高（宛先/形式が不確実） | 中 | 音声セッションから切れており C3 の会議還流に不向き |
| D. REST 再問い合わせ（reap） | ◎ | 中 | 高（エージェント協力頼み、NO_REPLY 禁止と衝突） | 小 | 堅牢性低の hack |
| E. 案3 Gateway allow-list / webhook | ✕（Gateway 改修） | 低（push） | 低 | 大（別リポ/別EPIC） | A/B の scope 全滅時のみ |

※「このリポ完結」列は **cross-repo 改修の有無だけ**を表す（◎=既存 REST のみで完結）。方式の質は他列で判断すること — D の◎は堅牢性の低さを打ち消さない。

## 4. 案3（Gateway 協力）の切り分け

**切り分け基準（#86 Step 0）**: 単なる scope 確認ではなく、**方式 A の全パスを実セッションで end-to-end に read-only 検証**する。検査項目は3つ（いずれも独立の失敗モード）:

1. **WS ハンドシェイク**: mini から control-plane WS へ `connect.challenge`（token ＋ device-auth）で接続できるか。REST の Bearer token が通る事実は HTTP 経路の証明でしかなく、WS challenge/device-auth は別物
2. **session key 解決**: Caty が持つのは REST `user` フィールドの `sessionUser`（`meet-${id}-${agentId}`、`src/pipeline.js:467` / `src/index.js:890`）のみで、**Gateway 内部の session key は持っていない**。`sessions.list` 等から sessionUser→sessionKey を解決できるか（購読先を特定できなければ scope があっても方式 A は成立しない）
3. **subscribe 実受信**: 解決した親セッションを実際に `sessions.subscribe` し、テスト委譲を1回流して `task_completion` が届くこと（`sessions.list` が通っても subscribe scope は独立に拒否されうる）

- 3項目とも成功 → 方式 A でこのリポ完結。**案3 は不要**（将来の best-effort 強化としてのみ保留）。
- いずれかが scope/機能不足で失敗 → 案3 必須。OpenClaw 側変更範囲: ①`task_completion` の HTTP webhook 転送 hook ②webhook 先/署名/allow-list の config ③（最優先で先に確認）operator トークンへの read/subscribe scope 付与設定 — ③が可能なら案3 実装自体が不要になり方式 A に回収される。

<details><summary>OpenClaw 側 Issue ドラフト（scope 不足だった場合に起票・英語）</summary>

**Title:** Expose sub-agent `task_completion` to external operators (read scope or completion webhook)

**Body:**
Context: A front-end voice client (Caty / meetmate) drives an OpenClaw agent through the OpenAI-compat `POST /v1/chat/completions` surface. When the agent delegates heavy work via `sessions_spawn`, the sub-agent's `task_completion` is auto-announced back to the *parent session* as a push (per the sub-agent contract), but a request/response REST client has no way to receive it, and REST SSE only forwards `assistant`/`lifecycle` streams (tool/completion events are dropped server-side).

We need one of the following so an external client can detect delegation completion without polling and without a persistent agent turn:

1. **(Preferred) Operator read scope**: allow a token that already holds `chat.send` to also call `sessions.subscribe` / `chat.history` (read-only) over the control-plane WS, so the client can subscribe to its own session and receive `task_completion` internal events. Document the required scope grant.
2. **(Alternative) Completion webhook**: add config (e.g. `tools.sessions_spawn.completionCallback`) to POST the `task_completion` payload (`childSessionKey`, `taskLabel`, `status`, `result`, `mediaUrls`) to an allow-listed HTTPS endpoint when a spawned child finishes, scoped per parent session key.

Acceptance:
- An external client authenticated with the gateway token can reliably observe "delegation completed" for a given session, with the result payload, at < 2s latency, without polling.
- No change required to the OpenAI-compat request path.

Scope: gateway control-plane auth/scope config **or** sub-agent announce hook. No client-side change in this repo.

</details>

## 5. #86 / #83 への含意

### #86（C3 完了時報告）
- Step 0 = §4 の3項目（WS ハンドシェイク / sessionUser→sessionKey 解決 / subscribe 実受信）を mini から read-only 実機確認して Go/No-Go。
- Go の場合に触るファイル:
  - 新規 `src/gateway-events.js`: WS operator クライアント（`connect.challenge` → token + device-auth → `sessions.subscribe` → `task_completion` デマルチプレクス）
  - `src/pipeline.js`: アクティブ `sessionUser` の購読登録/解除。受信時 (a) Meet チャット即時投稿 = `sendAttendeeChatMessage`（#68/PR #80 経路）(b) 音声は沈黙ギャップ待ちキューへ
  - `src/index.js`: ライフサイクル配線（`src/session-events.js` の `session_start`/`session_end` にフック）
  - `src/config.js`: `GATEWAY_EVENTS_ENABLED`（既定 off）＋既存 `OPENCLAW_GATEWAY_URL/TOKEN` 再利用
- `task_completion.status`（ok/timeout/error/unknown）で報告文面を出し分け可。`result` 本文がそのまま C3 のチャット要約素材。

### #83（C1 委譲率計測）— 二段構え
- **機械強制委譲（C2、`requestTimeoutHandoff` `src/pipeline.js:825-912`）は Caty 自身が発火主体 → 発火回数・タイミングはローカルで確定計測できる**（#83 の実装スコープ内で成立。委譲率の主分母はここで取れる）。なお同関数は Gateway への POST であり、成否判定は HTTP status のみ＝**委譲の「受理」までしか分からず「完了」は観測できない**（完了観測は #86 の方式 A 待ち）。
- **LLM 自発の `sessions_spawn` は REST から観測不可** → 数えるなら方式 A の購読に相乗り（#86 と同じ WS クライアントで計測点を共有）。#83 では欠測として扱い、#86 導入時に補完する。

## 事実と推測の区別

- §2-1, 2-2 のスキーマ・ハンドラ挙動・メソッド存在: **コード確認済みの事実**。ただし Gateway 側（`dist/` 引用）は本リポ外＝ローカル `openclaw 2026.4.5` のバンドルに基づく（§2 冒頭の出所注記参照。バージョン更新で行番号は変わる）。
- 「完了ターンが現状 Caty から失われている」（§2-2）、「Caty トークンに subscribe/history scope があるか」「WS challenge/device-auth が通るか」「sessionUser→sessionKey を解決できるか」（§2-3, §4）: **未検証の推論** → #86 Step 0 の read-only 実機確認（§4 の3項目）で確定させる。
