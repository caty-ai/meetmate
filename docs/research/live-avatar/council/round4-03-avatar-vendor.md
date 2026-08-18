# Round 4 — Revised Avatar / Vendor Proposal

Role: Councilor 3, Avatar / Vendor Integration Architect
Date: 2026-07-23
Scope: revised proposal after reading all five Round 3 adversarial submissions; research only

## 1. Revised opinion

My opinion changed in four material ways.

1. **I no longer rank renderers independently as production architectures.** My Round 1 scores overvalued LiveAvatar LITE’s native Fish contract and local E’s privacy/control while undercharging both for the unproven meeting carrier. This round ranks only complete carrier+renderer compositions.
2. **I no longer require a product-shaped A+E build before learning about LITE.** The smallest first discriminator is an avatar-free A calibration page. In parallel, frozen PCM can test E and LITE off-meeting. A+E still must precede A+LITE as the *meeting-observer control*, but not as a strict development dependency.
3. **E is mandatory instrumentation, not automatically a product candidate.** A deterministic canvas mouth/flash is enough to measure the carrier. E becomes a possible production renderer only if stakeholders explicitly allow a bounded non-photorealistic design and it passes Mac mini resource/visual gates.
4. **C is neither an equal automatic benchmark nor “only after obvious A failure.”** It earns a run only for a named carrier discriminator: Attendee lacks required diagnostics or platform parity, A shows a repeatable provider-specific defect, or an independent carrier cross-check is a decision requirement. It must replace—not silently expand—the maximum-two comparison.

One conclusion strengthened: LiveAvatar LITE is still the best-documented managed renderer candidate. Its [official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) proves raw 24 kHz mono S16LE ingest, external-TTS teeing, `agent.speak_end`, `agent.interrupt`, connected-state gating, and video-only frontend delivery. This resolves Fish compatibility and second-TTS ambiguity. It does not resolve meeting A/V timing, remote queue purge, privacy, cost, or failure cleanup.

## 2. Hard gates before scoring

### Disqualified

- **B — Attendee realtime audio plus separate live video:** disqualified. The current [`output_video` contract](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video) accepts an HTTPS MP4 file with loop/mute controls, not a continuous camera stream. Repeated MP4 replacement is not a comparison candidate.
- **LiveAvatar FULL/Embed, Tavus FULL CVI, current D-ID agent path, and any mandatory managed brain:** disqualified. These modes own ASR/STT, LLM, TTS, turn-taking, memory/session semantics, or inseparable agent behavior that belongs to Meetmate.
- **Tavus Text Echo:** disqualified because it invokes vendor TTS.

### Eligible but not necessarily ranked

- **LiveAvatar LITE:** renderer-only at the documented wire boundary; still experimental at the meeting, lifecycle, privacy, and cost boundaries.
- **Tavus Audio Echo:** plausibly renderer-only because [official Echo documentation](https://docs.tavus.io/sections/conversational-video-interface/echo-mode) bypasses every layer except Realtime Replica and accepts pre-generated audio. It is not ranked in the primary table because exact encoding/channels/cadence, utterance-scoped cancel, returned-audio authority, and meeting handoff remain less established than LITE.
- **Local bounded E:** renderer-only by construction, provided it remains a small canvas/viseme/envelope renderer rather than an unbounded photorealistic ML platform.
- **A and C:** eligible meeting carriers, not renderers.

No weighted total can compensate for a second TTS, second audible output, Agent Core leakage, changed static path, unbounded cancel queue, or absent live-video contract.

## 3. Required scoring method

Scale is 0–5:

- 5 = strong current contract/control evidence;
- 3 = plausible but materially unmeasured;
- 1–2 = major unknowns or adverse evidence;
- 0 = failed hard capability.

Unknowns are penalized; they do not receive a neutral “benefit of the doubt.” Scores are evidence/readiness priors, not latency, quality, or availability measurements.

Exact weights:

| Criterion | Weight |
|---|---:|
| Fish Audio continuity / one-source PCM | 25 |
| Agent identity, memory, skills, and turn boundary | 20 |
| Static isolation and smallest reversible diff | 15 |
| Response latency and A/V timing control | 15 |
| Meeting transport stability and observability | 10 |
| Cost, privacy, and operational evidence | 10 |
| Vendor replaceability | 5 |
| **Total** | **100** |

Weighted total is `Σ(score / 5 × weight)`.

## 4. Composite ranking

| Rank | Composite | Fish 25 | Identity 20 | Static/small diff 15 | Latency/A-V 15 | Meeting stability 10 | Cost/privacy/ops 10 | Replaceability 5 | Total /100 | Current disposition |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | **A + bounded E** | 3.5 | 5.0 | 3.5 | 3.0 | 2.5 | 4.0 | 4.5 | **74.5** | First composite control after A carrier passes |
| 2 | **A + LiveAvatar LITE** | 4.0 | 4.5 | 3.0 | 2.0 | 2.0 | 1.5 | 2.5 | **62.5** | Managed challenger after independent LITE bench |
| 3 | **C + bounded E** | 2.5 | 4.5 | 1.5 | 3.0 | 3.0 | 2.0 | 2.5 | **56.5** | Conditional Attendee-vs-Recall carrier diagnostic |
| 4 | **C + LiveAvatar LITE** | 3.0 | 4.0 | 1.0 | 1.5 | 2.5 | 1.0 | 1.5 | **47.0** | Defer; too many new failure and processor domains |

### Why A+E ranks first

E keeps renderer queue, frame timestamps, cancel, and likeness/voice processing local. That makes it the best way to attribute defects to A rather than a remote renderer. It still receives only 3.5/5 on Fish and 2.5/5 on meeting stability because A replaces the current Attendee WebSocket egress with browser playout, capture, WebRTC, and meeting codec. Actual browser rate, resampling, CPU, reconnect, and target-platform parity remain unknown. The score assumes **bounded E**, not photorealistic local inference.

### Why A+LITE ranks second

LITE receives the highest managed Fish/identity scores because its current protocol accepts Fish’s native format and need not receive text, transcript, memory, tools, or vendor TTS. It loses heavily on latency/A-V because page audio and remote video have separate clocks. Reference feed aggregation of roughly 400–600 ms initially and roughly one second later is not measured latency, yet it makes added meeting-audio delay a concrete risk. Cost/privacy/operations remain weak because LITE adds audio/likeness processing, a credential, a billable session that must be explicitly deleted, concurrency/plan terms, and an outage domain. [Published credits](https://docs.liveavatar.com/docs/faq/credits) show LITE at one credit per minute, not total cost.

### Why C combinations rank lower

[Recall Output Media](https://docs.recall.ai/docs/stream-media) has useful Google Meet/Zoom support, 15 fps page capture, DevTools/CPU metrics, and explicit compute variants. Those strengths raise observability but do not erase the largest change surface: replacing the meeting-bot provider, reintroducing the historical browser-output topology, accepting compute-tier cost sensitivity, and adding another privacy/lifecycle review. C+E is the clean diagnostic composition because E isolates the carrier. C+LITE changes carrier and renderer together and involves Recall plus LiveAvatar, so attribution, cost, and shutdown become worst among eligible combinations.

### Why Tavus Echo is not ranked yet

Tavus Audio Echo deserves contract discovery, not a comparison slot today. Its strongest possible advantage is a synchronized returned A/V stream, which might avoid LITE’s split-clock topology if that returned audio can become the **sole** meeting output. But the current council evidence does not establish exact PCM encoding/channels/cadence, deterministic queued cancel, byte/content lineage of returned audio, track separability, or how that synchronized A/V is handed through A without another audible copy. Scoring it now would reward an architectural possibility rather than current evidence.

It becomes rankable only after official/current answers establish:

1. accepted PCM encoding, rate, channels, cadence, and backpressure;
2. utterance/inference-scoped interrupt-to-last-audio/video behavior;
3. whether returned synchronized audio can be the one authoritative meeting egress;
4. current Echo pricing, concurrency, minimum billing, deletion, privacy, and region terms.

If those are answered favorably, the proper comparator is **A+Tavus Audio Echo**, replacing—not adding to—A+LITE in a maximum-two PoC.

## 5. What the scores do not prove

- A+E’s 74.5 does not prove baseline audio, low CPU, acceptable visuals, or target-platform stability.
- A+LITE’s native 24 kHz score proves only pre-transport source compatibility, not remote sample acceptance or observer-side waveform.
- A fixed audio delay is not proven to solve LITE A/V skew; render delay may vary and delayed audio may worsen response, echo gate, cancel tail, and exit.
- Recall `web_4_core` is a discriminator, not proof that CPU caused the historical issue or that the larger tier fixes it.
- Local control is not free: avatar design, model/assets licensing, Mac mini headroom, browser rendering, encoding, and maintenance are unpriced.
- A trust badge, DPA, or per-minute list price does not establish purpose limitation, training use, asset deletion, effective cost, or shutdown safety.

## 6. Vote

### Adopt now

**No.** The only production-qualified path on current evidence is the existing static-image Attendee bot. No live composite has measured observer-side audio quality, p50/p95 response latency, A/V skew, cancellation tail, reconnect, one-bot/one-audio behavior, or failure cleanup. Managed privacy/cost terms and local E resource/visual viability also remain unresolved.

### Maximum-two comparison PoC

**Yes, conditionally authorize exactly these two complete composites:**

1. **A + bounded E** — required local/carrier control.
2. **A + LiveAvatar LITE** — managed renderer challenger.

This is authorization for a comparison boundary, not permission to implement before prerequisites pass.

## 7. Prerequisites and stop conditions

### Shared prerequisites before either composite

1. Record the current static Attendee baseline using frozen current Fish 24 kHz PCM plus the scripted greeting, turns, interruption, long response, reconnect, exit, and leave conditions.
2. Define one-source lineage fields and observer metrics: generation, turn, sequence, first-sample index, PCM hash/count, actual browser rate/state, queue depth, underrun/clipping, first/last frame, one-audio detection, response latency, signed/absolute A/V skew, cancel tail, CPU/memory, bot count, and cleanup state.
3. Run an avatar-free **A carrier calibration page** with bounded playout and deterministic flashes. Existing WebSocket output must be disabled by construction for the live bot.
4. Preserve static with a separate pre-creation branch and prove that absent credentials/blackholed avatar endpoints cause no static import, validation, timer, network, payload, or lifecycle change.
5. Use only synthetic/consented assets and scripted non-confidential PCM; no prompt, transcript, memory, tools, stable user identity, or durable client secret crosses the renderer boundary.

If the A carrier fails baseline-relative audio, observability, single-output, cancel, or reconnect gates, **stop both primary composites**. Do not blame E or LITE. C+E may be proposed as one replacement diagnostic only after naming the Attendee-specific discriminator.

### A+E prerequisites

- Product owner states whether a bounded non-photorealistic renderer could ever ship. If no, E remains calibration-only and is not evaluated as a product choice.
- Cap the control to deterministic canvas/energy/viseme behavior; no photorealistic ML stack, generic avatar framework, or new dependency is justified.
- Measure Mac mini/page CPU, memory, frame timing, audio underruns, and observer-side A/V behavior.

Reject E as a product candidate—but retain it as control—if it misses the visual floor or harms the audio loop.

### A+LiveAvatar LITE prerequisites

- First pass an off-meeting sandbox with synthetic likeness and frozen PCM: connected gating, video-only track, no text/vendor brain/TTS, local send-stop plus `agent.interrupt`, measured last frame, explicit delete, and capped session/spend.
- Prove one Fish source and exactly one audible page route. Never run current Attendee WebSocket output, immediate audio, delayed audio, or a vendor audio track simultaneously.
- Compare immediate meeting audio with one bounded alignment policy; report added Fish-first-PCM→audible latency separately from skew.
- Reject on silent sample loss, stale post-interrupt motion, unbounded/variable alignment delay, duplicate audio, unobservable timing, orphan billing that cannot be contained, or unacceptable voice/likeness terms.

### C substitution rule

C is not a third PoC. If A fails because of a measured Attendee-specific carrier limitation or lacks a required platform/diagnostic property, the council may replace one or both A composites with **C+E first**. Only after C+E isolates the Recall carrier may C+LITE be considered. Default and `web_4_core` must be separate conditions; the historical branch must not be reused.

## 8. Minimal architecture for the approved comparison

The comparison requires present-purpose responsibilities, not a future avatar platform:

- test-only frozen fixture and meeting observer;
- one live-only source envelope with generation/turn/sequence/sample lineage;
- one concrete A live page/controller with bounded sole audio playout;
- one bounded local E control;
- one concrete LITE adapter mapping connected/start/speak/end/interrupt/delete.

Do not build provider discovery, an `AvatarProvider` hierarchy, generic vendor config, a universal lifecycle/health abstraction, automatic Attendee↔Recall failover, billing platform, persistent renderer memory, or Agent Core/profile changes. Extract shared code only after A+E and A+LITE demonstrate identical semantics in observed operation.

## 9. Minority concern

The strongest minority position, from the skeptic review, is that even “maximum-two PoC” sounds too feature-shaped. On current evidence the only justified immediate action may be a disposable avatar-free A carrier falsification harness. If A fails, the correct production/module count for this phase is zero, and no E/LITE integration should be built.

I preserve that concern as a binding sequencing rule: approval of A+E and A+LITE is **conditional scope authorization**, not a mandate to proceed past the carrier gate. The chair should describe the first funded action as “validate Attendee webpage media transport,” not “implement the live avatar.”

## 10. Final recommendation

Do not adopt a live avatar now. Approve at most two comparison composites—A+bounded E and A+LiveAvatar LITE—behind an immutable static baseline and an avatar-free A carrier gate. Keep C+E as the only first substitution when a named Attendee-specific question requires a second carrier. Keep Tavus Audio Echo out until its returned-audio/cancel/PCM contract is strong enough to replace LITE in the two-candidate cap. Keep B and every FULL/brain-owning mode disqualified.

The decision rule is deliberately asymmetric: a candidate advances only on observed evidence, but one hard-boundary failure rejects it immediately.
