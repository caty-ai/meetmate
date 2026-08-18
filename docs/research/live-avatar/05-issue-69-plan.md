# Issue #69 update and child-issue plan

## Postable update for Issue #69

> 調査と5者のArchitecture Councilを完了しました。現時点ではライブアバターの
> 本番採用は行わず、現在の Attendee + static image + Fish Audio を唯一の
> production-qualified 構成として維持します。
>
> 過去の Recall.ai 試行は、browser PCM再生、ScriptProcessor/手動downsample、
> AudioWorklet、Recall raw inputとのhybridなど複数方式が混在した後にrevert
> されています。残存diffだけでは、実際に聞こえた症状、browser sample rate、
> CPU、Recall compute variant、会議条件、revert理由を特定できません。
> したがって「Recall固有の音質問題」とは断定しません。
>
> 次に許可するのは実装採用ではなく、段階的な比較PoCのみです。
>
> 1. 現行staticを30分計測して基準を固定
> 2. avatarなしのAttendee Voice Agent carrierを frozen PCM + timing markerで検証
> 3. carrierがhard gateを通った場合だけ、(a) bounded local renderer と
>    (b) LiveAvatar LITE renderer の最大2案を比較
> 4. RecallはAttendee固有の失敗が再現した場合の別承認diagnosticに限定
>
> Attendee `output_video` はHTTPS MP4再生でありlive injectionではないため対象外、
> vendor FULL modeはAgent Core/Fish境界を壊すため対象外です。同一meeting内の
> live→static自動fallback、generic provider framework、二重TTSも作りません。
>
> 詳細: evidence pack / failure dossier / council decision / ADR / PoC spec を
> `docs/research/live-avatar/` に作成済みです。次のセッションはまず計測仕様と
> carrier-only gateを実装し、失敗時はrenderer実装へ進まない方針です。

## Proposed child issues

The requested issue granularity maps as follows:

| Requested work item | Proposed issue |
|---|---|
| static-image回帰契約テスト | LA-02 and LA-09 |
| Media Bridge PoC | LA-03 and LA-04 |
| Avatar Renderer PoC | LA-06, LA-07, and LA-08 |
| 音質・A/V同期計測 | LA-02, LA-03, and LA-10 |
| provider選定 | LA-10; LA-11 only if triggered |
| privacy・契約・APIキー整理 | LA-05 |
| liveモード実装 | LA-12 |
| Google Meet E2E | LA-13 |
| 自分主催Zoom E2E | LA-14 |
| 初心者向けREADME | LA-15 |

### LA-01 — Recover and index historical Recall evidence

Dependencies: none
Scope:

- locate old recordings, logs, notes, screenshots, meeting platform/account, browser
  version/rate, Mac load, Recall variant, and revert rationale;
- map each artifact to the exact historical commit/topology;
- label absent evidence as unknown.

Acceptance:

- evidence index is dated and reproducible;
- no causal claim is made from a code diff alone;
- unresolved items have named owners or are explicitly closed as unavailable.

### LA-02 — Freeze current static baseline protocol

Dependencies: none
Scope:

- freeze the 30-minute script, Fish inputs/config, meeting conditions, observer
  capture method, and randomization;
- define metric semantics and threshold-setting procedure;
- verify instrumentation does not materially change current behavior.

Acceptance:

- repeatable baseline manifests and observer artifacts exist;
- thresholds can be written before candidate labels/results are revealed;
- current static payload and output regression are captured.

### LA-03 — Build PoC telemetry and correlation harness

Dependencies: LA-02
Scope:

- source/chunk/frame/cancel/session correlation;
- monotonic timestamps, queue counters, resources, cleanup, and observer alignment;
- privacy-safe artifact retention.

Acceptance:

- missing measurements are reported as unknown;
- one utterance can be traced from Fish request through observer audio/video;
- harness works with static baseline without changing production defaults.

### LA-04 — Run avatar-free Attendee carrier calibration

Dependencies: LA-02, LA-03, Attendee contract confirmation
Scope:

- deterministic frozen PCM/tone/transient playback;
- deterministic visual timing marker;
- browser rate/playback/capture/WebRTC/observer measurements;
- cancel, reconnect, reload, network, and CPU failure injection.

Acceptance:

- 30-minute carrier result is evaluated against frozen gates;
- audio lineage, duplicate count, cancellation tail, resources, and timing are known;
- explicit pass/stop decision is recorded.

### LA-05 — Confirm LiveAvatar LITE commercial/privacy contract

Dependencies: none
Scope:

- API/plan access, credits, maximum session, concurrency, billing, timeout;
- region, subprocessors, retention/training, deletion proof, DPA;
- custom-likeness authorization and biometric/consent requirements;
- orphan-session reconciliation and spend caps.

Acceptance:

- a single uninterrupted 30-minute test is contractually possible or the protocol
  is explicitly changed before testing;
- synthetic asset is selected until real-person approval exists;
- responsible operator and cleanup procedure are named.

### LA-06 — Qualify LiveAvatar LITE off-meeting

Dependencies: LA-03, LA-05
Scope:

- raw mono S16LE 24 kHz Fish-format fixture;
- connect/send/speak-end/interrupt/stop/delete behavior;
- accepted/dropped samples, queue/backpressure, timing, reconnect, 429/5xx;
- verify no text, transcript, memory, tools, stable ID, or audible frontend track.

Acceptance:

- renderer-only boundary is demonstrated;
- cancel-to-last-frame and cleanup bounds are measured;
- failure or commercial gate stops A+LITE composition.

### LA-07 — Implement and measure bounded local renderer control

Dependencies: LA-04 pass, visual floor declared
Scope:

- smallest deterministic amplitude/viseme visual renderer;
- explicit frame timing, cancel, stop, and resource metrics;
- no photorealistic model or generic provider abstraction.

Acceptance:

- A+E completes the frozen 30-minute and failure protocol;
- CPU/memory/thermal and A/V skew are measured;
- result is labelled calibration-only if it misses the visual floor.

### LA-08 — Compose and measure A + LiveAvatar LITE

Dependencies: LA-04 pass, LA-05 pass, LA-06 pass
Scope:

- fork the same one-source Fish PCM to meeting audio and renderer;
- video-only frontend;
- immediate audio versus one predeclared bounded-delay condition;
- full cancel/reconnect/delete/failure protocol.

Acceptance:

- A+LITE completes the frozen 30-minute test;
- response latency and A/V improvement/tradeoff are reported separately;
- no second audible owner, semantic leakage, or orphan session remains.

### LA-09 — Static isolation and live-failure regression

Dependencies: LA-07 and/or LA-08 implementation
Scope:

- static with live credentials absent, invalid, DNS blackholed, and vendor 5xx;
- prove live modules do not initialize in static mode;
- prove no same-meeting live→static fallback or duplicate bot.

Acceptance:

- current static behavior remains regression-equivalent;
- failed live bot leaves and absence is confirmed;
- a subsequent clean static meeting succeeds.

### LA-10 — Blind evaluation and final adoption ADR

Dependencies: LA-02 through all executed candidates
Scope:

- blind audio comparison, visual-floor review, metrics, failure results;
- cost/privacy/operations scorecard;
- choose reject, one production-design candidate, or one named diagnostic.

Acceptance:

- no thresholds are moved after unblinding;
- hard gates override weighted scores;
- a final ADR records evidence, remaining risks, and explicit non-goals.

### LA-11 — Conditional Recall C + E carrier diagnostic

Dependencies: LA-04 failed for a reproducible Attendee-specific reason or telemetry
gap; separate written approval
Scope:

- one exact hypothesis;
- frozen E and fixtures;
- default versus larger Recall compute only if required by the hypothesis;
- no LITE composition.

Acceptance:

- the run answers the named discriminator;
- cost and privacy differences are recorded;
- it does not silently become a provider migration.

### LA-12 — Implement the selected live mode

Dependencies: LA-10 adopts one architecture in a new ADR
Scope:

- implement only the selected concrete carrier/renderer modules;
- keep `meet-routes.js` changes to thin mode selection/wiring;
- retain static as the default without importing or initializing live code;
- add bounded startup, cancel, stop, cleanup, and operational telemetry;
- do not add a generic provider framework until an observed second production
  provider proves the need.

Acceptance:

- all static and live unit/integration contracts pass;
- exactly one Agent Core, Fish generation, bot, and audible owner are proven;
- failure is closed and cannot switch to static inside the same meeting;
- security/privacy review and production-readiness ADR are approved.

### LA-13 — Google Meet live-mode E2E

Dependencies: LA-12
Scope:

- run the frozen greeting, multi-turn, barge-in, long response, reconnect, and exit
  scenario in Google Meet;
- include the 30-minute soak and observer-side audio/video capture;
- inject vendor and network failure without creating a second bot/audio owner.

Acceptance:

- all adopted PoC thresholds pass in the production-shaped path;
- meeting admission/leave, cancel, reconnect, cleanup, and static isolation pass;
- artifacts and run manifest are attached to the issue.

### LA-14 — Host-owned Zoom live-mode E2E

Dependencies: LA-12 and a Zoom meeting/account owned by the test operator
Scope:

- repeat the qualifying Google Meet scenario in an operator-hosted Zoom meeting;
- record platform-specific permissions, participant behavior, media timing, and
  disconnect/reconnect behavior;
- do not generalize Google Meet results to Zoom.

Acceptance:

- Zoom observer audio/video and metrics meet the same frozen gates or a documented
  platform-specific rejection is recorded;
- no duplicate bot/audio and no stale media after cancel/exit;
- operational prerequisites are documented.

### LA-15 — Beginner-facing live-avatar README

Dependencies: LA-12 through LA-14 and final operational decision
Scope:

- explain prerequisites, synthetic-versus-custom likeness, credentials, costs,
  start/stop, expected meeting behavior, failure recovery, and cleanup;
- clearly state static default and unsupported combinations;
- link to the final ADR and avoid exposing secrets.

Acceptance:

- a new contributor can run the approved mode and return to static safely;
- plan/session limits and orphan-session cleanup are explicit;
- commands and screenshots are verified against the released implementation.

## Suggested ordering

`LA-01` and `LA-05` can proceed independently while `LA-02 → LA-03 → LA-04`
forms the research critical path. A failed LA-04 closes LA-07/08 and may open
LA-11. A passing LA-04 allows LA-07; LA-08 additionally requires LA-05/06. LA-09
and LA-10 follow only the candidates that pass their prerequisites. Production work
is `LA-10 → LA-12 → LA-13/LA-14 → LA-15`; none of it is authorized by this
research decision alone.
