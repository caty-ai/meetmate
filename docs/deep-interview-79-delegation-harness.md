# Deep Interview Spec: #79 委譲強制ハーネス EPIC

## Metadata
- Interview ID: di-79-delegation-harness-20260704
- Rounds: 5 (+ Round 0 topology gate)
- Final Ambiguity Score: 20%
- Type: brownfield
- Generated: 2026-07-04
- Threshold: 0.2 / Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.35 | 0.30 |
| Constraint Clarity | 0.75 | 0.25 | 0.19 |
| Success Criteria | 0.85 | 0.25 | 0.21 |
| Context Clarity | 0.70 | 0.15 | 0.11 |
| **Total Clarity** | | | **0.80** |
| **Ambiguity** | | | **0.20** |

## Topology
ユーザーはトポロジー決定を Alpha に委任（「実装の中身は分からない。シンプル・ストレート最優先、機能が満たされれば組み方は Alpha 推奨で」）。過去の全失敗歴を踏まえ、最重量の案4からではなく最小の機械層で体感を変える構成を採用。

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| C1 計測基盤 | active | 体感応答時間・委譲イベントの構造化ログと事後集計 | AC-1, AC-5 |
| C2 案1 タイムアウト強制委譲 | active | first-token 閾値超過で LLM ターン打ち切り→自動委譲＋実収録ack即答 | AC-2 |
| C3 案2 完了時報告 | active | チャット即時投稿＋音声は発話ギャップ待ち | AC-3, AC-4 |
| C4 案3 Gateway allow-list | **deferred** | OpenClaw 跨ぎ。spike（境界調査）のみ子Issue化、実装は別リポ/別EPIC | 委任判断。spike 子Issueで切り分け文書化 |
| C5 案4 fast/work lane + CatyPhone lane 整合 | **deferred** | 北極星。EPIC に設計制約として記載のみ、実装子Issueは切らない | 委任判断。C1-C3 は lane 二段構成へ将来接続可能な形に |

## Goal
フロント Caty を対話に専念させ、重作業をハーネス（機械層）が強制的にバックグラウンド委譲する。プロンプト指示（voice addendum【ツール実行ルール】）は破られる前提とし、#74 で確立した「プロンプト＋機械層」2層哲学に従う。

ユーザーが特定した実症状（Round 1）: **「沈黙が長い」の正体は「LLM が自分で重作業を始めて黙る」**（委譲がプロンプト頼みで発火しない）。委譲成功時も**完了後の音沙汰なし**が第二の痛み。→ 根治=C2（発火をプロンプトに任せない）、秘書感=C3（報告を機械層でトリガー）。

成功した状態: どんな依頼でも Caty の可聴応答が即時に返り（実収録 ack 含む）、重作業は voice ターンを一切ブロックせず、完了は必ず会議に還流する。

## Constraints
- 誤委譲は寛容（安全側）: 会話停止ゼロが最優先。軽い質問が時々裏に流れて答えが数十秒遅れるのは許容。閾値は短く攻める（first-token 3-5s 目安）
- 閾値は env 可変にする（`LLM_RESPONSE_TIMEOUT_MS` と同様のパターン）。初期値で入れて実機で調整
- 完了報告は会議を遮らない: チャットは即時（#68 の send_chat_message 経路再利用）、音声は発話ギャップ（沈黙N秒、Nはチューニング項目）を待って短く一言。白熱中に音声機会を失ってもチャットに残っていれば良い
- OpenClaw Gateway 側のコード変更は今回スコープ外。このリポで完結する範囲のみ実装（Gateway 跨ぎの要否は spike で文書化し、必要なら別リポ Issue に切り出す）
- 数値目標は合否ゲートにしない（計測実装を重くしない）。委譲率・誤委譲率・体感応答時間は観測指標として記録し運用で調整
- 各段階に実機検証ゲート必須（このリポの流儀）
- 既存の 35s timeoutFallback は外側の安全網として残す（置換ではなく手前に新レイヤを追加）

## Non-Goals
- 案3（Gateway ツール allow-list）の実装 — spike による切り分けのみ
- 案4（fast/work lane 二段構成）の実装 — 設計制約の記載のみ
- CatyPhone gateway lane との共通化実装 — 将来接続の設計配慮のみ
- 委譲率・誤委譲率の数値 SLO 達成
- プロンプト（voice addendum）の大改修 — 2層哲学のプロンプト側は現状維持ベース

## Acceptance Criteria
- [ ] AC-1: 体感応答時間（発話終了→Caty 可聴応答開始、実収録 ack を応答としてカウント）・委譲イベント・誤委譲ヒューリスティックが構造化ログに記録され、事後集計できる
- [ ] AC-2: 重い依頼で first-token が閾値（env 可変、初期 3-5s）を超えたら LLM ターンが機械的に打ち切られ、実収録「やっておくね」系 ack が即時再生され、既存 handoff 経路で委譲が発火する。会話は継続可能
- [ ] AC-3: 委譲タスク完了時、結果要約が Meet チャットへ即時投稿される
- [ ] AC-4: 音声の完了報告は発話ギャップを待って短く行われ、会議の発話に割り込まない
- [ ] AC-5: 各子Issue は 1人Meet スモーク（代表シナリオ: 重い依頼／軽い質問／委譲中の会話継続）で合格、EPIC 完了は社内MT実戦1回＋観測ログのレビューで判定

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| EPIC の4段階案（1→2→3→4）をそのまま子Issue化する | Round 0: トポロジー自体を検証対象に | ユーザーが構成を Alpha に委任。案3=spike のみ、案4=北極星化。実装は計測+案1+案2 に絞る |
| 「沈黙が長い」と「自分で作業を始める」は別symptom | Round 1: 一番痛い症状の特定 | 同一因果と判明（自己実行→沈黙）。強制委譲が根治、完了報告が第二の柱 |
| 体感応答時間 = first-token（EPIC 原案） | Round 2: ack を応答に数えるか | 可聴応答開始基準に変更。実収録 ack もカウント（PCM キャッシュ済みで1秒以内可能） |
| 誤委譲は避けるべき | Round 3: 安全側トレードオフの明示 | 誤委譲寛容で確定。閾値は攻める、誤委譲率は観測のみ |
| 完了は音声で自発報告（案2原案） | Round 4 Contrarian: 音声不要説 | 棄却しつつ修正: チャット即時＋音声は沈黙待ちのハイブリッド（#68 資産の再利用） |
| 検証は数値ゲートが必要 | Round 5: ゲートの重さ | スモーク＋実戦＋観測ログ。数値は合否にしない |

## Technical Context (explore 調査 2026-07-04)
- `LLM_RESPONSE_TIMEOUT_MS=35_000`（src/config.js:44）: first-chunk 未着で `maybeSpeakLlmTimeoutFallback()`（src/pipeline.js:914-953）→ timeoutFallback 音声＋`requestTimeoutHandoff()`（Slack/sessions_spawn 委譲指示）が既に自動発火。**案1は新規機構ではなく「35s の救済 fallback を 3-5s の標準経路に変える」意思決定**
- first-token latency の明示計測は存在しない（`firstChunkSeen` フラグと diag ログのみ、pipeline.js:1076-1080）
- 委譲指示はプロンプトのみ: `buildVoiceAddendum()`【ツール実行ルール】（src/llm.js:31-45）
- 実収録 ack 9種＋ping 3種＋timeout 1種（assets/fillers/、#75）。PCM ディスクキャッシュで TTS API 呼び出しゼロの即時再生可（`pickImmediateAck()`, pipeline.js:374-385）
- `sessions_spawn` は Gateway 側ツール定義で**このリポからツール呼び出し・完了イベントを直接観測できない**（→ spike の主題）
- barge-in / cancel は AbortController で実装済み（pipeline.js:593-617, 520-542）— 案1 の「打ち切り」は同パターン再利用可
- チャット投稿経路: `extractChatTags()`（speech-policy.js）→ `sendAttendeeChatMessage()`（#68, PR #80）
- 北極星（案4）設計制約: C1-C3 の委譲判定・計測点は、将来 intent 分類器による fast/work lane 分岐（CatyPhone internal-project #72 の lane 概念と共通化）に差し替え可能な位置に置く

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| フロント Caty | core domain | voice pipeline, addendum | 委譲を発火し ack/報告を発話する |
| 委譲 (sessions_spawn) | core domain | Gateway 側ツール, 観測不可 | サブエージェントを生む |
| 強制委譲変換 | core domain | first-token 閾値 (env), abort, ack | タイムアウトを委譲に変換する (C2) |
| 完了イベント検知 | core domain | Gateway 境界, spike 対象 | 完了報告をトリガーする |
| 完了報告 | core domain | チャット即時+音声沈黙待ち | #68 チャット経路を再利用 (C3) |
| 体感応答時間 | supporting | 発話終了→可聴応答開始, ack カウント | C1 の第1指標 |
| 誤委譲 | supporting | 寛容・観測のみ | 閾値設計のトレードオフ相手 |
| 計測基盤 | supporting | 構造化ログ, 事後集計 | 全検証ゲートの土台 (C1) |
| 実収録 ack | supporting | PCM キャッシュ, 9 variants | 即答感の担い手 |
| Gateway (OpenClaw) | external system | tool routing, allow-list(将来) | 変更はスコープ外 |
| サブエージェント | supporting | Slack 報告 | 委譲の受け手 |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 8 | 8 | - | - | N/A |
| 2 | 9 | 1 | 0 | 8 | 100% |
| 3 | 10 | 1 | 0 | 9 | 100% |
| 4 | 10 | 0 | 0 | 10 | 100% |
| 5 | 11 | 1 | 0 | 10 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (Round 0 + 5 rounds)</summary>

### Round 0（トポロジー確認）
**Q:** EPIC を6コンポーネント（計測/案1/案2/案3/案4/CatyPhone整合）と読んだが合っているか？案3・案4のスコープが分岐点
**A:** 実装の中身は分からない。過去一度もうまくいったことがないから、シンプル・ストレートに機能が満たされるなら組み方は Alpha 推奨で
→ トポロジー委任。C1-C3 active / C4-C5 deferred で確定

### Round 1
**Q:** 過去の失敗時、会議で実際に何が起きていた？一番痛い症状は？
**A:** 自分で作業を始めることと委譲後の音沙汰なし。沈黙が長いのは自己作業開始が原因と思っていた。委譲自体プロンプト頼みで発火しないことも多かった
**Ambiguity:** 50% (Goal 0.65 / Constraints 0.35 / Criteria 0.30 / Context 0.70)

### Round 2
**Q:** 体感応答時間の定義: 実収録 ack 1秒以内で「即答感達成」と呼べるか？
**A:** ack 即応で成功と数える
**Ambiguity:** 41% (0.70 / 0.40 / 0.55 / 0.70)

### Round 3
**Q:** 誤委譲（軽い質問が裏に流れる）の許容度は？
**A:** 安全側＝誤委譲寛容
**Ambiguity:** 35% (0.75 / 0.55 / 0.60 / 0.70)

### Round 4（Contrarian: 音声自発報告は本当に必要か？）
**Q:** 会議の真っ最中に委譲タスクが完了したら Caty はどう振る舞う？
**A:** チャット即時＋音声は沈黙待ち
**Ambiguity:** 28% (0.85 / 0.70 / 0.65 / 0.60)

### Round 5
**Q:** 実機検証ゲートの重さ: 子Issue の Done 条件のレベルは？
**A:** スモーク＋実戦＋観測ログ（数値は合否にしない）
**Ambiguity:** 20% (0.85 / 0.75 / 0.85 / 0.70) — 閾値到達

</details>
