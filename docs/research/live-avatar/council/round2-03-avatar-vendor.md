# Round 2 — Avatar / Vendor Cross-Review

Role: Councilor 3, Avatar / Vendor Integration Architect
Date: 2026-07-23
Scope: cross-review of all five Round 1 proposals; research only

## 1. Revised position

The council has broad agreement on the hard boundaries:

- preserve the current static Attendee path;
- fork once after current Fish PCM generation;
- keep Soniox, Agent Core, gateway/session identity, memory, skills, tools, turn-taking, and exit semantics outside the renderer;
- permit exactly one audible meeting-output owner;
- reject Attendee Option B under the current MP4-only `output_video` contract;
- reject LiveAvatar FULL, Tavus FULL CVI, and other mandatory end-to-end agent pipelines;
- treat the historical Recall branch as an uninstrumented, confounded experiment rather than a vendor verdict.

My Round 1 preference remains **E as the control, then A+LiveAvatar LITE as the managed challenger**, but with lower confidence. The strongest evidence for LITE is real: its [official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) accepts base64 raw PCM S16LE mono at 24 kHz, exposes `agent.speak_end` and `agent.interrupt`, tees the same TTS frames to ordinary downstream audio, and presents video-only to the frontend. The weakness is equally real: this is only the renderer contract. The production-shaped candidate is the composition **Fish → two clocks → LiveAvatar video + Attendee page audio/video capture → meeting**, with two vendor sessions and no proven shared presentation clock.

Consequently, no managed candidate should be called “best” before two contract-elimination probes:

1. Can Option A carry a local E control with baseline-quality audio, deterministic cancel, and measured A/V timestamps?
2. Can LITE video be aligned to the single meeting-audio route without its documented buffering causing unacceptable response delay, interruption tail, or drift?

If the first fails, managed-renderer comparison inside A is premature. If the second fails, native Fish format compatibility does not save LITE.

## 2. Cross-review of the other Round 1 proposals

### 2.1 Councilor 1 — Meeting Bot / WebRTC

**Strongest point.** The proposal correctly makes static/live bot construction structurally separate before bot creation and defines an explicit lifecycle from bot creation through renderer readiness, cancellation, leave, and close. This is stronger than a feature flag placed inside the existing payload builder: the current static payload and single-bot leave behavior stay outside the experimental media shell. Its treatment of C as a cross-provider benchmark rather than a branch revival is also well grounded.

**Strongest rebuttal.** It sometimes treats A, D, and E as if they were peer end-to-end options when they are different layers. E and LiveAvatar LITE still require a meeting carrier; in the proposed executable path that carrier is A. Thus “A+E versus A+LITE” is the true comparison, while “D renderer-only” is not independently deployable. The preliminary option score gives D strong static/audio preservation without charging it for A’s browser capture, second vendor session, and lack of a shared A/V clock. Cross-platform confidence is also incomplete: Recall documents Google Meet and Zoom, while the retrieved Attendee evidence does not establish equivalent A behavior on both.

### 2.2 Councilor 2 — Realtime Audio / DSP

**Strongest point.** This is the strongest measurement discipline in the council: immutable source PCM, turn/chunk/first-sample indices, rolling hashes, cumulative sample accounting, bounded clock-driven buffering, cancellation tail, and both renderer-boundary and meeting-observer A/V measurement. It directly repairs the historical Recall branch’s absence of media clocks, underrun counters, actual AudioContext rates, and meeting-side playout evidence.

**Strongest rebuttal.** A source-side rolling hash proves what Meetmate attempted to send; it does not prove a remote renderer accepted, decoded, or rendered the same samples unless the vendor acknowledges sequence/sample ranges. Candidate-specific rechunking is also legitimate after source stamping—LiveAvatar’s reference batching and Simli’s preferred chunk size make it unavoidable—so “immutable chunk” must mean immutable PCM/sample lineage, not identical network packets. Finally, a flash/tone calibration can measure the local/meeting carrier but may not be injectable into a closed photoreal renderer. For managed vendors, the PoC still needs vendor presentation events or an observer-side mouth/audio correlation, with the limitation stated.

### 2.3 Councilor 4 — Agent Identity / Memory / Skills Boundary

**Strongest point.** The ownership table and deliberately weak renderer capability are the cleanest architectural defense against provider leakage. Separate namespaces for meeting session, gateway session, bot ID, and renderer session, plus an interface limited to `open`, `pushPcm`, `flush`, `close`, and media health, prevent an avatar integration from quietly becoming a second agent platform. The warning against a generic plugin marketplace is appropriate for a comparison PoC.

**Strongest rebuttal.** “A renderer outage degrades to the unchanged static path” is not automatically achievable mid-session. The live bot and static bot have different construction paths; automatic recovery can create two participants or depend on the failed vendor to shut down. The skeptic and meeting-bot proposals correctly require stop/leave/verify before starting any replacement. Static is an independent rollback for the next session, not a magical in-place degradation mode. The Round 1 unknown list also asks whether `output_video` supports sustained realtime injection even though current official evidence has already answered no; only a future distinct API remains unknown.

### 2.4 Councilor 5 — Skeptic / Security / Operations

**Strongest point.** The proposal correctly expands “minimal” beyond glue-code size to processors, credentials, session owners, billing meters, shutdown dependencies, and rollback steps. Its rules for short-lived browser tokens, no durable secrets in the public page, synthetic/consented likenesses, local spend caps, orphan-session reconciliation, and vendor-independent static rollback should be hard gates, not later polish.

**Strongest rebuttal.** “No managed option is ready for adoption” is correct for production but too broad if read as blocking a sandbox contract probe. A synthetic likeness, scripted non-confidential PCM, strict minute cap, and disposable vendor project can safely test format, cancel, and timing before every enterprise DPA term is negotiated. The right split is: security architecture and client-secret rules before any PoC; full retention/region/subprocessor/rights approval before real-user or production-like data. Otherwise procurement uncertainty can prevent gathering the technical evidence needed to decide whether procurement is worthwhile.

## 3. Evidence against my own Round 1 proposal

My Round 1 document had three biases.

First, it scored **renderer modes** and **meeting options** separately, then described LiveAvatar LITE as the leading managed candidate without fully charging the composition for Option A. LITE’s 24 kHz contract removes a resampler and second TTS, but it does not remove Attendee browser capture, Web Audio playout, WebRTC/meeting encoding, public-page lifecycle, or the second vendor’s session and billing state. The appropriate unit of evaluation is A+LITE versus A+E, not LITE versus E in isolation.

Second, I treated LITE’s video-only frontend as almost sufficient to solve duplicate audio. It solves one ownership problem but creates a timing problem: direct meeting Fish audio has no shared playout clock with remotely rendered video. The official reference buffers roughly 400 ms initially (guide: 600 ms) and roughly one second thereafter. Delaying meeting audio may align the first frame while worsening response latency, echo-gate duration, interruption tail, and exit drain. A fixed delay may also fail if render delay varies. No measurement yet proves bounded p95 skew.

Third, my high E score understated that E still needs a supported meeting video path. Under current Attendee contracts that is A’s webpage capture, so E avoids avatar-vendor audio/likeness disclosure but not browser/container resampling, encoding, autoplay, page reconnect, or meeting A/V uncertainty. E is the best renderer control, not automatically a 91/100 end-to-end architecture.

Additional evidence against my vendor ordering:

- Tavus Audio Echo may return synchronized A/V and therefore could provide a better internal A/V clock than LITE, while my Round 1 score penalized its returned audio mainly as duplication risk. If its returned track can be the sole meeting audio and its cancel contract is deterministic, it could outperform LITE’s split-clock topology.
- Simli’s explicit 16 kHz contract is operationally clear, but its preferred 6000-byte chunks contain 187.5 ms of mono S16LE audio. Smaller chunks are allowed, yet neither end-to-end latency nor cancel tail is measured. Its required 24→16 kHz conversion reintroduces a class of risk the historical Recall experiment failed to measure.
- Local E can become the most expensive option in engineering time if “lightweight” expands to photorealistic ML inference, custom video encoding, or avatar authoring. It must remain a bounded 2D/canvas/viseme control.

These points reduce confidence, but do not yet reverse my PoC vote.

## 4. Every candidate compared with historical Recall

The historical reference is not “Recall the vendor.” It is the actual branch topology: browser output, initially browser input, assumed/requested sample rates, one `AudioBufferSourceNode` per network chunk, no bounded jitter queue or A/V clock, multiple simultaneous input/output/Fish changes, no retained symptom mapping, and no specified Recall compute variant.

| Candidate | Material improvement over historical Recall | Same or new recurrence risk | Honest conclusion |
|---|---|---|---|
| A — Attendee voice-agent page | Keeps the current meeting vendor/lifecycle and can hold Soniox/Agent Core/Fish fixed; the new shell would add actual-rate, queue, cancel, and observer telemetry | Still sends Fish through browser conversion/playout, page capture, WebRTC, and meeting codec. Attendee container rate, autoplay, resampling, CPU, reconnect, and Google Meet/Zoom parity remain unknown | Less provider churn, not inherently better audio. It must beat the same browser-class failure modes with evidence |
| B — current audio + separate video | Would preserve the proven current 24 kHz Attendee PCM route | The necessary continuous video API does not exist; repeated MP4 replacement would add worse discontinuity and queue ambiguity than old Recall | Rejected, not “the safe alternative” |
| C — fresh Recall Output Media | Current Fish is 24 kHz S2-Pro; output queue would be bounded; actual rates/CPU/A/V timestamps retained; default and `web_4_core` explicitly compared; input and output varied separately | Same meeting vendor and webpage-output class as the old branch; compute tier, browser scheduling, capture, codec, reconnect, and billing remain live variables | Best historical falsification, highest recurrence exposure; neither condemned nor exonerated |
| D — LiveAvatar LITE inside A/C | Native 24 kHz S16LE, explicit speak/end/interrupt, video-only frontend, identical source tee, current API rather than obsolete HeyGen examples | Adds a separate renderer WebSocket/WebRTC session, renderer batching, connection-state silent drops, orphan billing, and split meeting-audio/video clocks; still inherits A or C carrier risks | Stronger renderer contract than the old HeyGen/Recall attempt, but no meeting-side performance proof |
| D — Tavus Audio Echo inside A/C | Explicitly bypasses all layers except replica and accepts pre-generated base64 audio | Exact encoding/cadence/cancel semantics and whether synchronized returned audio can be the sole meeting track remain unresolved; adds Daily/vendor lifecycle | Potentially better A/V clock ownership than LITE, but presently less contract certainty |
| D — Simli inside A/C | Published PCM16/mono/16 kHz contract, WebRTC audio-to-video focus, `syncAudio` control, explicit overload warning | Mandatory resampling from current 24 kHz and managed capacity; its preferred chunk size adds buffering; returned-audio authority still needs proof | Better specified than historical browser assumptions, but deliberately reopens measured-resampling risk |
| D — FULL LiveAvatar/Tavus/current D-ID agent | Vendor may optimize its own integrated latency and A/V | Moves ASR/LLM/TTS/turn/session state outside Meetmate, a larger architectural regression than the Recall branch, which at least intended to retain STT→LLM→TTS | Reject without PoC regardless of demo quality |
| E — bounded local renderer inside A | No external renderer session, no second audio, deterministic local flush, full render telemetry, same source PCM | Still inherits A’s browser page/capture/codec path; Mac mini contention and local video timing replace Recall compute-tier risk | Best isolation/control; not evidence that the final transport is clean |

The critical lesson is unchanged: a new candidate is not safer merely because its API is newer. It is safer only when one variable changes at a time and retained measurements locate failure.

## 5. Renderer-only API audit

| Candidate | What official evidence proves | What remains unproven | Renderer-only verdict |
|---|---|---|---|
| LiveAvatar LITE | [Overview](https://docs.liveavatar.com/) assigns STT/LLM/TTS/WebRTC to the customer; [official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) uses 24 kHz mono S16LE base64, `start`, `agent.speak`, `agent.speak_end`, `agent.interrupt`, identical TTS tee, and video-only frontend | Acceptance acknowledgement, queue/backpressure limits, render timestamps/distribution, reconnect/idempotency, interrupt-to-last-frame tail, exact inactivity behavior | **Yes at the wire boundary; unproven at meeting/lifecycle quality** |
| LiveAvatar FULL/Embed | Vendor owns the conversational pipeline | Whether optional BYO components disable every other brain/turn layer is irrelevant because default ownership conflicts | **No** |
| Tavus Audio Echo | [Echo Mode](https://docs.tavus.io/sections/conversational-video-interface/echo-mode) says audio bypasses all layers except Realtime Replica and accepts base64 audio with sample rate/inference/end fields | PCM encoding/channels/cadence, backpressure, queued cancel, returned-audio byte lineage/separability, meeting handoff | **Plausible, conditional** |
| Tavus Text/Microphone Echo | Text invokes vendor TTS; Microphone Echo places interrupt logic in the caller’s stream/transport | Deterministic compatibility with existing turn/cancel semantics | **Text: no; microphone: not first PoC** |
| Tavus FULL CVI | Vendor perception, turn-taking, STT, LLM, TTS, rendering | None needed for boundary decision | **No** |
| Simli audio-to-video | [WebRTC docs](https://docs.simli.com/api-reference/simli-webrtc) specify PCM Int16 mono 16 kHz and chunk guidance; [session endpoint](https://docs.simli.com/api-reference/endpoint/webrtc/startAudioToVideoSession) exposes PCM format, `syncAudio`, batching, silence/session controls | Cancel/flush semantics, exact output audio/video ownership, timestamps, overload/SLA, best chunk cadence | **Yes in purpose, conditional in control plane** |
| Current D-ID realtime agent | [Realtime overview](https://docs.d-id.com/docs/realtime-overview) describes STT, turn detection, LLM, TTS, and avatar | A current, supported, low-level Fish-PCM renderer-only mode was not established in the evidence | **No for this shortlist** |
| Local bounded E | Meetmate owns input, renderer, queues, clocks, and output | Visual floor, CPU/GPU/encoding load, asset/model licensing | **Yes by construction if kept bounded** |

Product names do not decide this table. A mode passes only when wire behavior and observed packets show no text, second TTS, hidden turn owner, or inseparable second audio.

## 6. Cost, privacy, and lock-in audit

| Candidate | Known cost shape | Unresolved cost | Privacy boundary | Lock-in |
|---|---|---|---|---|
| A | Existing Attendee relationship plus voice-agent/container use | Current voice-agent minute/concurrency/egress pricing and whether higher resources are needed | Public HTTPS page; any remote renderer receives Fish audio/likeness; page tokens must be short-lived | Moderate: Attendee page lifecycle/capture contract, but renderer page is portable |
| B | No valid live candidate | N/A | Lowest incremental disclosure only for prerecorded MP4 | Rejected capability |
| C | Recall Output Media plus selected `web`/`web_4_core`/GPU resource and meeting-bot minutes | Current price delta, minimums, retries, egress, idle/reconnect billing | Recall sees meeting/page media; a remote renderer adds another processor | High: Recall bot/output-media payload, compute variants, lifecycle, and browser carrier |
| LiveAvatar LITE | [1 credit/minute](https://docs.liveavatar.com/docs/faq/credits); plans/overage vary; explicit deletion needed to avoid orphan billing | Procurement-time plan, rounding/minimums, concurrency, custom avatar, region/SLA, retries | Fish voice audio, likeness/face asset, session metadata leave Meetmate | High around avatar asset, WebSocket/LiveKit session API, credits and availability; bounded in code by an adapter |
| Tavus Echo | [Current pricing](https://www.tavus.io/pricing) is plan/minute/concurrency based, with free PoC allowance, monthly tiers, overage and minimum charge | Echo-specific applicability, replica training, Daily usage, region/SLA, orphan/retry billing | Fish audio and replica/likeness leave Meetmate; Tavus publishes a [Trust Center](https://trust.tavus.io/) but project-specific retention still needs review | High around Replica, Daily/Interactions Protocol, tiers and concurrency |
| Simli | Official site describes free/paid usage and volume/PAYG; a [DPA](https://www.simli.com/legal/data-processing-agreement) exists | Exact per-minute/dedicated-slot price, overload economics, concurrency, custom face, egress | Fish audio and face ID/asset leave Meetmate | Moderate: narrow PCM adapter is portable; face assets, session API and dedicated capacity are proprietary |
| Local E | No avatar-vendor per-minute fee | Engineering, design/avatar authoring, Mac mini capacity, video encoding/hosting/maintenance | Strongest data control; local asset/model licensing still matters | Low vendor lock-in, potentially high code/operations ownership |

No Round 1 proposal establishes a complete total cost of ownership. A+LITE and C+LITE pay for both a meeting carrier and an avatar renderer. C may additionally require `web_4_core` for acceptable quality. Idle, reconnect, cancellation, and orphan time must be locally reconciled against vendor bills. “One credit/minute” and “free PoC minutes” are procurement inputs, not cost conclusions.

## 7. A/V claim audit

The following claims are supported:

- LiveAvatar LITE returns video-only in the official reference and batches renderer input; therefore immediate independent Fish playout can lead the face.
- Tavus documents synchronized returned A/V for its renderer integration, but this does not prove that Meetmate can extract/use it as the sole meeting stream while preserving cancellation.
- Recall Output Media captures a webpage at 15 fps; this is a frame-rate contract, not an A/V skew guarantee.
- Attendee Voice Agents capture a page’s audio and video; this is a capture capability, not proof of a shared exposed clock, fixed resampler, or meeting-side synchronization.
- A local renderer permits source-side timestamps; it does not control the meeting provider’s later encoding/capture delay.

The following claims remain unsupported and must not appear as conclusions:

- LiveAvatar’s 400–600 ms/1 s batching equals end-to-end renderer latency.
- Delaying meeting audio by a fixed amount will keep p95 A/V skew acceptable.
- Tavus returned A/V is byte-identical to Fish or immediately suitable as Attendee page output.
- Simli’s marketed sub-300 ms speech-to-video figure will hold in Meetmate.
- `web_4_core` will fix historical Recall symptoms.
- A/V sync observed in the browser equals A/V sync observed by meeting participants.

Required proof is source-sample lineage plus observer-side recording: Fish first PCM; renderer ingestion/acknowledgement where available; browser/page scheduled and actual playout; first corresponding rendered frame; meeting-observer audio and frame timestamps; p50/p95/max offset and drift; cancellation-to-last-audio and cancellation-to-last-frame. Where a vendor exposes no presentation timestamp, record that observability deficit rather than manufacturing one from send time.

## 8. Consensus, remaining disagreement, and Round 2 vote

The practical consensus is:

1. Measure the current static baseline.
2. Record B as contract-rejected.
3. Run A+E first as the local transport/render control.
4. If A passes, run A+LiveAvatar LITE with identical Fish PCM, explicit `connected` gating, local send-stop plus `agent.interrupt`, `speak_end`, and explicit deletion.
5. Keep Tavus Audio Echo as the managed challenger if its PCM/cancel/returned-track contract is clarified; keep Simli as a resampling-aware fallback.
6. Run C last, fresh, as a deliberate historical falsification on default and `web_4_core`, not as the presumed production path.
7. Never run a FULL managed brain under this brief.

My Round 2 vote is therefore unchanged in direction but narrower: **approve only a staged comparison of A+E and A+LiveAvatar LITE; do not select a production vendor.** A+E is a prerequisite, not merely another candidate. LITE advances because its renderer wire contract is currently strongest, not because its latency, privacy, cost, or meeting A/V behavior is proven.

## 9. Conditions that would change my vote

I would move from LITE to Tavus Audio Echo if Tavus officially confirms current PCM encoding/rates/cadence, deterministic utterance-scoped cancel, and a returned synchronized track that can be the sole meeting audio with measured better p95 response latency/A-V skew than LITE.

I would move from LITE to Simli if 24→16 kHz blind A/B is not materially worse, smaller-chunk streaming and cancel tail pass, video/audio ownership is unambiguous, and measured availability/cost is better.

I would vote for E as the production choice if the bounded local renderer meets the explicit visual-quality floor and Mac mini CPU/memory limits while A preserves baseline audio. I would drop E as a final candidate—but retain it as the control—if it misses that visual floor or expands into an unbounded photorealistic ML project.

I would reject LITE if any of the following occurs: unacceptable p95 delay/skew after alignment; stale video after `agent.interrupt`; silent media loss around connection/reconnect; inability to expose enough timing/queue evidence; orphan billing that cannot be bounded; unacceptable retention/region/training/likeness terms; or a required vendor brain/TTS feature.

I would promote C earlier only if A fails for an Attendee-specific, measured carrier limitation and a new Recall default-versus-`web_4_core` test demonstrates better meeting-observer audio/A-V results with acceptable total cost. I would reject C if it reproduces unexplained historical defects or requires unaffordable compute.

I would reopen B only after Attendee publishes a supported continuous live camera-output API with timestamps/backpressure/cancel semantics and coexistence with current realtime 24 kHz audio. Sales assurance without a new official contract is insufficient.

I would reverse the entire live-avatar vote if the static baseline is not reproducible, if stakeholders cannot state a minimum visual requirement, or if no candidate can expose enough evidence to distinguish renderer, browser, meeting transport, and Fish. In that case the correct outcome is to keep the static image, not to choose the least-understood vendor.
