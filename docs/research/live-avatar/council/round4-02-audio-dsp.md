# Round 4 — Realtime Audio / DSP Revised Proposal

Role: Councilor 2, realtime audio / DSP
Date: 2026-07-23
Decision scope: research conclusion and comparison-PoC vote; no implementation approval

## 1. Revised opinion

My opinion changed in four material ways across the council rounds.

1. **I no longer rank renderer modes independently of their meeting carrier.** My Round 1 score placed LiveAvatar LITE narrowly above E because LITE's 24 kHz mono S16LE ingress matches current Fish. Round 2/3 showed that this over-credited an ingress contract while omitting A's browser audio path, the second renderer clock, remote queue uncertainty, and meeting handoff. The decision unit is A+E versus A+LiveAvatar LITE, not E versus LITE.
2. **A carrier calibration must precede either composite.** Attendee webpage output shares the historical browser-output failure class: PCM conversion, actual browser clock, page capture, WebRTC, meeting codec, CPU, and reconnect. A frozen-PCM page with deterministic visual markers can reject A before avatar work.
3. **LiveAvatar LITE's renderer-only evidence is stronger than I first assumed, while its timing case is weaker.** The official starter establishes a real external-audio protocol—24 kHz mono S16LE, `start`, `agent.speak`, `agent.speak_end`, `agent.interrupt`, and video-only frontend—but not accepted-sample completeness, remote purge, render latency, or meeting A/V quality: [LiveAvatar overview](https://docs.liveavatar.com/), [official LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python).
4. **Safe “fallback” means containment plus static for new sessions.** It does not mean automatically starting a static bot while the live bot's absence is unconfirmed. The latter can create duplicate participants and audio.

I retain three positions:

- one Fish synthesis and one audible meeting owner are hard invariants;
- B and all FULL/brain-owning modes are disqualified;
- a small sample-lineage envelope and concrete adapters are justified, but a generic avatar/plugin framework is not.

## 2. Facts that limit the ranking

### Proven interface facts

- Current Fish defaults to 24 kHz and reaches one `onAudio(chunk)` seam (`src/config.js:9-16`, `350-363`; `src/pipeline.js:2207-2227`).
- Current static output sends one Attendee `realtime_audio.bot_output` stream (`src/transport-meet/meet-routes.js:1319-1329`).
- Attendee A captures a public webpage's audio and video into the meeting: [Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents).
- Attendee B's `output_video` accepts an HTTPS MP4, not continuous live frames/WebRTC; B does not satisfy the live requirement: [Attendee Output Video](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video).
- Recall C documents webpage Output Media, Google Meet/Zoom support, compute variants, and CPU diagnostics: [Recall Output Media](https://docs.recall.ai/docs/stream-media).
- LiveAvatar LITE's documented ingress matches Fish's nominal 24 kHz mono S16LE format and its reference frontend is video-only.
- FULL modes own conversational layers and violate the Meetmate Agent Core boundary.

### Still unknown

- Actual Attendee/Recall browser rate and state, resampling, capture buffering, codec path, observer-side audio quality, and A/V skew.
- Whether A preserves current direct meeting-input and echo/barge-in behavior while page playout is the sole output.
- LITE accepted-sample acknowledgement, remote queue/backpressure, render-delay distribution, `agent.interrupt` purge tail, reconnect, deletion reliability, privacy terms, and effective total cost.
- E's visual floor, implementation effort, asset/license choice, Mac mini CPU/GPU load, and encoding impact.
- Historical Recall symptoms and root cause.
- All baseline-derived acceptance thresholds.

The reference LITE aggregation of roughly 400–600 ms initially and roughly one second thereafter is not a measured renderer buffer or end-to-end meeting latency. No candidate below has measured performance.

## 3. Composite ranking

Scoring scale: points awarded directly up to each stated weight. Unknowns are penalized; documented format compatibility is not scored as measured quality. Hard disqualifications cannot be offset by totals.

Required weights, totaling 100:

| Criterion | Weight | What earns points now |
|---|---:|---|
| Fish preservation | 25 | One synthesis, source lineage, no required replacement voice; penalties for unmeasured browser/codec/resampling paths |
| Agent identity | 20 | Agent Core retains identity, memory, skills, tools, gateway, turn authority |
| Static/diff isolation | 15 | Separate live construction, unchanged static dependency/startup path, smaller attributable change surface |
| Latency/A-V evidence | 15 | Number/control of clocks and queues, cancelability, timestamp potential; no vendor latency claims counted |
| Meeting stability | 10 | Single output owner, reconnect/failure containment, provider/lifecycle change surface |
| Cost/privacy/operations | 10 | External processors, credentials, likeness/audio exposure, billing/session burden, local operational ownership |
| Replaceability | 5 | Renderer/carrier can be removed without Agent Core/static changes |

### Weighted score

| Rank | Composite candidate | Fish /25 | Identity /20 | Static/diff /15 | Latency/A-V /15 | Meeting stability /10 | Cost/privacy/ops /10 | Replaceability /5 | Total /100 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **A + bounded E** | 18 | 20 | 11 | 8 | 6 | 8 | 5 | **76** |
| 2 | **A + LiveAvatar LITE** | 18 | 18 | 10 | 5 | 5 | 3 | 3 | **62** |
| 3 | **C + bounded E** | 14 | 19 | 7 | 7 | 5 | 5 | 4 | **61** |
| 4 | **C + LiveAvatar LITE** | 14 | 17 | 5 | 4 | 4 | 2 | 2 | **48** |
| DQ | **B + any live renderer** | — | — | — | — | — | — | — | **Disqualified** |
| DQ | **Any FULL managed mode** | — | — | — | — | — | — | — | **Disqualified** |

### Why the scores differ

**1. A+E — 76/100.** This is the strongest diagnostic composite because E adds no remote renderer queue, second synthesis, or third-party Fish/likeness processor. It retains full Agent Core authority and is maximally replaceable. It loses substantial points because A replaces the known static audio egress with an unmeasured browser/capture/codec path, and E has no measured visual or Mac mini resource result. The score means “best control to test,” not “76% production ready.”

**2. A+LiveAvatar LITE — 62/100.** It preserves one Fish source and has the strongest managed renderer-only ingress evidence. It falls behind E because the audio and rendered video live on separate clocks, meeting-audio delay may be needed, remote queue/interrupt completion is unknown, and it adds credentials, likeness/voice processing, billing, deletion, and outage state. Its native 24 kHz ingress prevents one mandatory pre-renderer resampler; it does not prove acoustic equivalence after A and the meeting codec.

**3. C+E — 61/100.** E preserves the brain and renderer boundary, while Recall offers explicit platform/CPU diagnostics. The composition changes the meeting provider, inherits browser output, reopens the highest historical recurrence surface, and expands lifecycle/cost. It is scientifically useful only when a named discriminator requires a carrier comparison. Its one-point gap from A+LITE is not a performance claim.

**4. C+LiveAvatar LITE — 48/100.** This combines two external media providers, two remote lifecycle/cost domains, Recall browser capture, and LITE's split video clock before either carrier or renderer has passed independently. It has valid architectural seams but is a poor first experiment because a failure is difficult to attribute.

**B — disqualified.** Its hypothetical preservation of current Attendee PCM cannot compensate for the absence of a continuous live-video injection contract. Repeated MP4 replacement is not an admissible pseudo-stream.

**FULL — disqualified.** A vendor-controlled ASR, LLM, TTS, memory, turn-taking, or tools violates the brief regardless of measured visual or latency quality.

## 4. DSP adoption gates

No composite may advance beyond comparison unless all of the following are observed against the same frozen Fish fixture and scripted live-turn test:

- one Fish generation; turn/generation/sequence/first-sample lineage matches at both local adapter inputs;
- actual browser rate/state and every known local resampling/conversion boundary are retained;
- bounded queue depth, cumulative samples, underrun/overrun/clipping, reconnect, and stale-generation counters are retained;
- an independent meeting observer hears exactly one waveform, with no duplicate, echo, replay, wrong-speed, or unexplained missing-sample event;
- Fish-first-PCM → first audible meeting output is reported separately from A/V skew;
- signed p50/p95, absolute p95, maximum, and drift of observer-side A/V skew are reported;
- cancel request → last local sample, last audible meeting sample, and last matching frame are all measured;
- delayed meeting audio, if used for LITE alignment, is the sole output path, is bounded, flushes on cancel, and does not hide added latency;
- speaking/echo-gate transitions are correlated with observer-audible playout; an internal gate value is not proof of silence;
- static payload, startup, greeting/turn/cancel/exit/leave behavior remain independent with all live credentials absent and vendor endpoints unreachable.

Pass thresholds are set only after the static audio baseline and moving calibration control establish measurement precision and perceptual expectations.

## 5. Vote

### Adopt now

**No.** The only production-qualified path in present evidence is the current static participant. No live composite has measured meeting audio quality, latency, A/V skew, cancel tail, reconnect safety, or static isolation.

### Comparison PoC

**Yes, maximum two composite candidates:**

1. **A + bounded E** — mandatory local/control candidate.
2. **A + LiveAvatar LITE** — managed renderer challenger.

This is approval for a comparison experiment, not for a product-shaped live-avatar implementation or vendor selection.

### Prerequisites before composing the two candidates

1. Record the current static Attendee audio baseline and freeze the PCM/script corpus.
2. Run an avatar-free **A carrier calibration** with bounded audio playout and deterministic frame markers. Stop if A materially regresses blind audio, bounded queue behavior, cancel, reconnect, or observer timing.
3. Define one immutable live output owner; current `realtime_audio.bot_output` must not remain audible beside page playout.
4. Freeze the small media envelope: render session, generation, turn, sequence, first-sample index, source timestamp, 24 kHz S16LE PCM, end, cancel, and close.
5. Bench E's minimal moving control and LiveAvatar LITE independently with the same PCM. For LITE, use sandbox data, connected-state gating, local send-stop plus `agent.interrupt`, explicit deletion, hard duration/spend cap, and no prompt/transcript/memory/tools.
6. Predeclare observer metrics, negative duplicate-audio test, failure injections, and post-baseline decision thresholds before viewing candidate results.

Only after A and each renderer bench pass should A+E and A+LITE be composed and compared.

### Conditional reserve

C+E and C+LITE are not in the maximum-two PoC. Admit one only if:

- A fails for a repeatable Attendee-specific carrier reason;
- Attendee cannot expose enough browser/media evidence;
- required Google Meet/Zoom parity is not established; or
- a carrier-level cross-check is explicitly required.

If C is admitted, begin with C+E/default versus `web_4_core`; do not jump directly to C+LITE and do not reuse `origin/feat/recall-ai`.

## 6. Minority concern

I support the maximum-two comparison, but my minority concern is that **A+LiveAvatar LITE may be structurally incompatible with current conversational timing even when every byte-lineage check passes**.

The concern is the split clock:

```text
Fish PCM -> bounded page audio -> Attendee/meeting
        \-> LITE feed aggregation -> remote render -> video page -> Attendee/meeting
```

If LITE video consistently trails immediate meeting audio, delaying the sole audio path may improve lip sync but also delays response, adds an audible queue that must be purged, extends cancel/drain tail, and may shift the effective echo gate away from actual playout. A variable render delay may defeat a fixed audio delay; an adaptive delay may create drift correction artifacts or unbounded conversational latency.

The PoC must reject LITE rather than modify Agent Core semantics if acceptable p95 A/V skew requires:

- an unbounded or continuously growing meeting-audio queue;
- two simultaneous immediate/delayed audio paths;
- redefining wake/cancel/turn authority in the vendor;
- changing static behavior;
- or hiding added audible latency inside an improved skew score.

This concern does not oppose the LITE comparison. It explains why native 24 kHz input and a same-source tee are necessary but far from sufficient.

## 7. Final recommendation

Do not adopt a live avatar now. Authorize only the prerequisite-gated comparison of **A+bounded E** and **A+LiveAvatar LITE**, using the same Fish source, the same meeting observer, and the same failure script. Keep C conditional, B disqualified, and FULL modes outside the architecture.

The comparison should answer one question: can either live composition preserve Meetmate's one voice, one brain, unchanged static path, and current interruption behavior while adding a moving face? If the answer cannot be demonstrated at the meeting observer, the correct result is to retain static—not to select the least-bad score.
