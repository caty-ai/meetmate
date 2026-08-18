# Round 4 — Meeting Bot / WebRTC Revised Proposal

Role: Councilor 1, Meeting Bot / WebRTC Architect
Date: 2026-07-23
Decision scope: architecture adoption or maximum-two-candidate comparison PoC

## Revised position

**現時点で live avatar architecture は採用しない。最大2候補の comparison PoC を条件付きで承認する。**

比較候補は:

1. **A+E local** — Attendee Voice Agent page + bounded local canvas/viseme renderer
2. **A+LiveAvatar LITE** — 同じ Attendee page carrier + current Fish PCM を受ける managed video renderer

ただし、この2候補を構築する前に、avatar を含まない disposable **A carrier calibration** が current static baseline に対する audio hard gate を通ることを共通 prerequisite とする。A が carrier として失敗した場合、両候補を続行せず、C を自動代替せず、測定結果を council に戻す。

B は current Attendee contract 上 continuous live-video injection が存在しないため DQ。LiveAvatar FULL、Tavus FULL CVI、その他 vendor が ASR/LLM/TTS/turn を所有する FULL modes も DQ である。

## Round 1 から変わったこと

### 1. Option ではなく composite を評価する

Round 1 は A、C、D、E を一つの表で比較した。これは carrier と renderer を混在させた誤った精度だった。A/C は meeting carrier、E/LITE は renderer であり、比較可能な単位は A+E、A+LITE、C+E、C+LITE である。

この変更により、LITE の native 24 kHz contract に A の browser capture risk を負担させ、E の privacy/control 利点にも carrier risk を負担させる。

### 2. B は「unknown」から hard DQ になった

Round 1 初稿時点では `output_video` の realtime suitability を contract spike unknown と見た。その後の official evidence で、endpoint は public HTTPS MP4 URL と `loop` / `mute_video` を受ける queued prerecorded output だと確定した ([Attendee Output Video API](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video))。Repeated MP4 replacement は supported live stream ではない。新しい official continuous-camera API が出るまで実験しない。

### 3. LiveAvatar LITE の boundary confidence は上がった

[Official LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) により、raw PCM S16LE mono 24 kHz、`start`、`agent.speak`、`agent.speak_end`、`agent.interrupt`、video-only frontend、same upstream TTS tee が確認された。Current Fish default 24 kHz と一致し、second Fish/TTS と pre-ingress resampler は不要である。

一方、評価順位は上げ切らない。Reference の約400 ms first aggregation / guide の約600 ms と later 約1 second batching は renderer/meeting latency の測定値ではない。Split clock、remote queue、A/V alignment のための meeting-audio delay、cancel tail、explicit deletion、privacy、billing は unknown のままである。

### 4. A+E の前に A carrier を単独で反証する

Round 1 は A+E を最初の executable comparison とした。Round 3 を踏まえ、最初は avatar を作らず frozen PCM + deterministic canvas flash だけで A の browser audio/capture/WebRTC path を測る。A が audio hard gate を落とすなら、local renderer も LITE integration も作らない。

### 5. C は mandatory benchmark ではなく conditional diagnostic になった

Round 1 では C を cross-provider benchmark に置いた。現在は、A が diagnostics、platform parity、audio quality のいずれかで失敗した時だけ検討する。C は Google Meet/Zoom、15 fps、DevTools/CPU metrics、default/`web_4_core` 比較という価値を持つが、meeting provider、lifecycle、compute/cost を追加し、historical browser-output failure class を再び開く。

### 6. Generic Media Shell を先に作らない

Round 1 の Media Shell responsibility list は acceptance contract としては有用だが、generic runtime abstraction として実装するには早い。今共有するのは:

```text
render_session_id
generation
turn_id
sequence / first_sample_index
source timestamp / PCM format / PCM bytes
end / cancel / close
immutable output owner
```

だけでよい。A page と LITE adapter は concrete に保ち、remote queue や `health()` の偽の共通性を作らない。

### 7. Fallback の意味を狭めた

Round 1 の lifecycle は failure containment を含んでいたが、「static に戻す」が誤読され得た。安全に承認するのは:

- new session を vendor 非依存で static に戻す control-plane rollback;
- active live session の generation invalidation、queue flush、best-effort renderer close/delete、one bot leave、orphan incident 化。

Original live bot の absence を確認しない in-session static recreation は duplicate-bot mechanism なので PoC では禁止する。

## Hard gates

Weighted score より先に以下を適用する。

### DQ

- **B + any live renderer:** Attendee は continuous live camera injection を提供していない。
- **Any FULL managed mode:** vendor ASR/LLM/TTS/personality/memory/turn/tools を必要とする。
- second Fish generation または vendor replacement voice が必要。
- two audible output owners を排除できない。
- static startup/create/audio/leave が live credential、SDK、endpoint、health に依存する。
- cancel が local queued audio を flush できない、または stale generation を再生する。
- durable avatar secret を public page に置く必要がある。

### PoC prerequisite

- Current static Attendee + Fish 24 kHz の recorded baseline。
- Same frozen PCM、script、meeting observer、measurement vocabulary。
- Threshold は baseline 後に設定し、事前に未測定の数値を作らない。
- A carrier calibration が actual AudioContext rate/state、bounded queue、one-audio proof、cancel/reconnect、observer audio を取得して pass。
- Static regression が exact payload/image behavior と vendor-independent startup を確認。

## Composite scoring

### Method

指定 weight をそのまま100点満点の最大寄与として使う。

| Criterion | Weight |
|---|---:|
| Fish quality | 25 |
| Identity / memory / skills / tools | 20 |
| Static isolation / small diff | 15 |
| Latency / A-V sync | 15 |
| Meeting stability | 10 |
| Cost / privacy / operations | 10 |
| Vendor replaceability | 5 |
| **Total** | **100** |

Scores are evidence/readiness priors, not performance results. Unknown は中立点にせず減点した。Visual realism は user weight に含まれないため score に密輸せず、別 hard product prerequisite とする。

### Ranking

| Rank | Composite | Fish 25 | Identity 20 | Static/diff 15 | Latency/A-V 15 | Stability 10 | Cost/privacy/ops 10 | Replaceability 5 | Total /100 | Disposition |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | **A+E local** | 17 | 20 | 12 | 9 | 6 | 8 | 5 | **77** | PoC candidate 1 |
| 2 | **A+LiveAvatar LITE** | 17 | 18 | 11 | 5 | 5 | 3 | 3 | **62** | PoC candidate 2 |
| 3 | **C+E local** | 12 | 19 | 7 | 7 | 4 | 5 | 4 | **58** | Conditional diagnostic only |
| 4 | **C+LiveAvatar LITE** | 12 | 17 | 6 | 4 | 3 | 2 | 2 | **46** | Defer; too many unknown domains |
| — | **B+renderer** | — | — | — | — | — | — | — | **DQ** | MP4-only; no live injection |
| — | **FULL managed D** | — | — | — | — | — | — | — | **DQ** | Agent Core boundary violation |

### Score rationale

#### 1. A+E local — 77

- **Fish 17/25:** one Fish source and local lineage are strong, but A replaces the known realtime PCM egress with browser playback/capture/WebRTC. Actual resampling and observer quality are unknown.
- **Identity 20/20:** E needs no transcript, memory, skills, tools, gateway session, or vendor brain.
- **Static/diff 12/15:** separate pre-create live branch can isolate static; actual bootstrap/config isolation is not yet tested.
- **Latency/A-V 9/15:** local timestamps and cancel are controllable, but page capture and meeting codec remain unknown.
- **Stability 6/10:** avoids renderer vendor outage, yet Attendee page lifecycle, reconnect, browser clock, and Mac mini load are unmeasured.
- **Cost/privacy/ops 8/10:** no avatar vendor or per-minute renderer bill; engineering, asset licensing, and local resource cost remain.
- **Replaceability 5/5:** bounded local E can be removed without changing Agent Core.

#### 2. A+LiveAvatar LITE — 62

- **Fish 17/25:** native 24 kHz S16LE supports one-source tee, but meeting audio still crosses A and may require a deliberate delay.
- **Identity 18/20:** LITE is renderer-only at documented wire boundary; observed production behavior and data handling remain unproven.
- **Static/diff 11/15:** concrete adapter can remain live-only, but adds session credential, connected gate, interrupt, delete, and public-page handoff.
- **Latency/A-V 5/15:** split clocks and reference batching create the largest unresolved technical penalty.
- **Stability 5/10:** connected-state silent drops, remote queue, reconnect/idempotency, delete reliability, and second vendor availability are unknown.
- **Cost/privacy/ops 3/10:** voice PCM and likeness cross another processor; current total cost, retention, training, regions, orphan billing, and concurrency are unresolved.
- **Replaceability 3/5:** narrow adapter helps, but avatar assets, LiveKit/session API, credits, and output behavior are proprietary.

#### 3. C+E local — 58

- **Fish 12/25:** fresh bounded queue is better than historical code, but Recall browser output is the closest recurrence topology and no current observer result exists.
- **Identity 19/20:** local renderer preserves Agent Core; Recall adds meeting/session exposure but not agent authority.
- **Static/diff 7/15:** requires a second meeting-provider creation/input/output/lifecycle path.
- **Latency/A-V 7/15:** local renderer is observable; Recall page capture and 15 fps do not guarantee skew.
- **Stability 4/10:** provider switch, output-media restrictions, compute-tier sensitivity, reconnect, and historical recurrence exposure.
- **Cost/privacy/ops 5/10:** local rendering helps, but Recall minutes and possibly `web_4_core` add cost/data processing.
- **Replaceability 4/5:** E is portable; carrier-specific Recall lifecycle remains.

#### 4. C+LiveAvatar LITE — 46

This combines the two least-proven remote domains: Recall meeting carrier plus LiveAvatar render session. Native Fish compatibility does not compensate for two vendor lifecycles, webpage capture, split A/V clocks, compute tier, privacy, orphan billing, and attribution difficulty. It should not enter a maximum-two-candidate PoC.

## Explicit vote

**Vote: do not adopt a live-avatar architecture now. Approve a maximum-two-candidate comparison PoC only.**

Approved candidates:

1. **A+E local**
2. **A+LiveAvatar LITE**

This vote approves a comparison boundary, not production code or vendor procurement.

### Candidate-shared prerequisites

1. Record current static baseline with greeting, multiple turns, interruption, long response, reconnect, and exit.
2. Use one frozen current Fish 24 kHz PCM corpus and one scripted cancel/reconnect/failure sequence.
3. Run avatar-free A carrier calibration first; stop both lanes if it materially regresses baseline audio or cannot expose actual rate/queue/observer timing.
4. Prove one bot, one Fish generation, one output owner, sequence/generation rejection, bounded queue, and observer-side no-duplicate audio.
5. Preserve current static payload/image/audio/leave behavior and vendor-independent startup.
6. Set latency, A/V skew, cancel-tail, quality, CPU/memory, and reconnect thresholds only after baseline/calibration.
7. Keep implementation concrete: small media envelope, Attendee page, E code in page, one LITE adapter, test-only replay/observer harness. No provider registry or generic avatar framework.

### A+E-specific prerequisites

- Product owner states whether a bounded non-photorealistic 2D/viseme result could ship. If no, E remains calibration/control and is not a final product candidate.
- Cap E to a deliberately small design; no photorealistic local ML platform.
- Measure Mac mini and Attendee container CPU/memory together with audio underrun, response latency, and A/V skew.
- Local cancel must stop mouth motion and queued audio for the same turn/generation.

### A+LiveAvatar LITE-specific prerequisites

- Synthetic/consented likeness, non-confidential PCM, disposable project, server-side durable key, scoped short-lived browser/session token, hard duration/concurrency/retry/spend caps.
- Gate sends on connected; stop local send and issue `agent.interrupt`; explicitly delete and reconcile session state.
- Inspect network/media tracks: no transcript, prompt, memory, tool, stable user ID, vendor TTS, or second audible audio.
- Compare immediate meeting audio against one bounded delay condition; report added Fish-first-PCM→audible latency separately from A/V skew.
- Measure cancel→last audible sample and cancel→last matching video frame, reconnect/stale generation, remote failure containment, and delete failure.
- Before real-user data: approve retention, training/reuse, region, subprocessors, likeness/voice rights, deletion, concurrency, and effective total cost.

## Minority concern

The strongest minority concern is that **C should be one of the two candidates**, not merely conditional. Recall explicitly supports Google Meet and Zoom, exposes DevTools/CPU metrics, documents default and `web_4_core`, and can distinguish Attendee-specific container behavior from renderer behavior. If the decision requires cross-platform evidence immediately, selecting both A-based candidates risks learning the same carrier twice.

I do not adopt that minority position yet because an avatar-free A calibration isolates the shared carrier more cheaply, while A+E versus A+LITE isolates renderer effect under one carrier. A C run earns a slot only if:

- A cannot expose sufficient timing/CPU evidence;
- A fails a required meeting platform;
- A produces a reproducible baseline-relative defect;
- or the product explicitly requires an independent carrier comparison.

If any trigger occurs, return to council and replace—not add to—the maximum-two set. Do not silently expand to three candidates.

A second minority concern is Tavus Echo: synchronized returned A/V could avoid LITE's split-clock alignment. It is excluded because exact encoding, returned-audio authority, utterance cancel, meeting handoff, and observability remain less established. It can displace LITE only after those contracts are independently confirmed.

## Opinion changes after the council

- **Changed:** B moved from a theoretically attractive contract spike to immediate DQ.
- **Changed:** C moved from equal benchmark to conditional diagnostic.
- **Changed:** LITE moved from speculative “external TTS” candidate to a credible renderer-only wire protocol, but not to architecture winner.
- **Changed:** E moved from highest-scoring standalone option to A+E composite; its carrier and Mac mini risks now count.
- **Changed:** A+E is no longer the first build. Avatar-free A calibration is the first falsifier.
- **Changed:** “Media Shell” moved from proposed shared runtime architecture to a small event envelope plus concrete adapters.
- **Changed:** “fallback to static” now means new-session rollback and active-session containment, not seamless in-session bot replacement.
- **Unchanged:** Agent identity, memory, skills, tools, gateway selection, Soniox, Fish, turn/cancel, and static path remain Meetmate-owned.
- **Unchanged:** Historical Recall cause remains unknown; current instrumentation can improve attribution but cannot rewrite history.

## Final recommendation

Approve only the two-candidate PoC above, behind the avatar-free A carrier gate. The result must be a measured comparison, not a generalized avatar subsystem.

The winning candidate, if any, is the one that preserves one audible Fish stream, Agent Core ownership, static independence, bounded cancellation, meeting-observer audio quality, and acceptable A/V timing. Visual appeal cannot compensate for failure on any of those invariants.
