# Live Avatar Architecture Council — Round 5 decision

Date: 2026-07-23
Status: research decision; no production architecture adopted
Scope: Issue #69, while preserving the current Attendee static-image bot, Fish Audio, and Agent Core

## Executive decision

The council does **not** recommend adopting a live-avatar production architecture now.
It unanimously authorizes only a staged, instrumented comparison PoC:

1. characterize the current static baseline;
2. run an **avatar-free Attendee Voice Agent carrier probe** using frozen Fish-format
   PCM, deterministic speech/tone fixtures, and a visual timing marker;
3. stop if that carrier fails a baseline-derived audio, cancellation, duplication,
   reconnect, resource, or observability gate;
4. only after it passes, compare at most:
   - **A + bounded E**: Attendee Voice Agent webpage plus a deliberately simple local
     renderer; and
   - **A + LiveAvatar LITE**: the same Attendee carrier and the same Fish PCM, with
     LiveAvatar used only as a renderer.

The current static path remains the only production-qualified path and the default.
There is no automatic same-meeting failover between live and static modes. A failed
live session must fail closed, remove its bot, prove absence, and allow static only
in a subsequent clean session.

## What the names mean

- **A** — Attendee Voice Agent webpage captured as the meeting bot's audio/video.
- **B** — Attendee `output_video`.
- **C** — Recall.ai Output Media webpage captured as the meeting bot's audio/video.
- **D** — a vendor-managed full conversational avatar pipeline.
- **E** — a bounded local renderer driven by the existing Fish PCM/utterance timing;
  it is a calibration/control implementation, not a promise of photorealism.
- **LITE** — LiveAvatar renderer-only mode. Existing STT, Agent Core, Fish TTS,
  memory, skills, and tools remain authoritative.

## Council execution

Five independent Codex-native specialist agents produced blind Round 1 proposals:

1. meeting-bot architecture;
2. audio/DSP;
3. avatar-vendor integration;
4. Agent Core and change-boundary protection;
5. skeptical security, privacy, cost, and operations review.

They then read all other proposals, produced Round 2 cross-reviews, answered the same
nine adversarial questions in Round 3, and submitted revised scores and explicit
votes in Round 4. The requested Claude, Fable, Kimi, GLM, and Fugu models were not
available in this environment; the council therefore used five role-separated
Codex agents rather than pretending those models were consulted. Full artifacts are
under [`council/`](./council/).

## Vote

| Question | Result |
|---|---|
| Adopt a production live-avatar architecture now? | **No, 5–0** |
| Preserve the current static implementation as default and independent? | **Yes, 5–0** |
| Require an avatar-free A carrier probe first? | **Yes, 5–0** |
| If A passes, compare A+E and A+LiveAvatar LITE? | **Yes, 5–0** |
| Include Recall C in the first comparison? | **No, 5–0** |
| Use B as a live stream path? | **No; disqualified, 5–0** |
| Use a FULL managed conversational mode? | **No; disqualified, 5–0** |
| Build a generic provider framework before evidence exists? | **No, 5–0** |

## Required weighted evaluation

These are evidence/readiness priors, not measured performance. Each specialist used
the required weights independently. Unknowns were penalized; a published ingress
format did not receive credit for unmeasured observer quality or latency.

| Candidate | Meeting bot | DSP | Vendor | Boundary | Skeptic | Mean /100 | Rank |
|---|---:|---:|---:|---:|---:|---:|---:|
| **A + bounded E** | 77 | 76 | 74.5 | 66 | 69.5 | **72.6** | 1 |
| **A + LiveAvatar LITE** | 62 | 62 | 62.5 | 53 | 56.5 | **59.2** | 2 |
| **C + bounded E** | 58 | 61 | 56.5 | 52.5 | 49.5 | **55.5** | 3 |
| **C + LiveAvatar LITE** | 46 | 48 | 47 | 45.5 | 40.5 | **45.4** | 4 |
| **B + live renderer** | DQ | DQ | DQ | DQ | DQ | **DQ** | — |
| **Any FULL managed mode** | DQ | DQ | DQ | DQ | DQ | **DQ** | — |

Required weights:

| Criterion | Weight |
|---|---:|
| Preserve current Fish Audio quality and one-source PCM | 25 |
| Preserve identity, memory, skills, tools, and turn authority | 20 |
| Isolate static mode and keep the change small/reversible | 15 |
| Response latency and A/V timing control | 15 |
| Meeting stability and observability | 10 |
| Cost, privacy, and operations | 10 |
| Vendor replaceability | 5 |

The table ranks what is worth testing. It does not mean A+E is 72.6% production
ready or visually acceptable.

## Why this decision

### Fish Audio remains the sole speech source

The current application produces raw mono 16-bit PCM through Fish at 24 kHz by
default. LiveAvatar LITE's documented backend protocol accepts raw mono S16LE at
24 kHz, so the same PCM bytes can be forked to the renderer without a second TTS or
a mandatory pre-renderer resampler. That is a useful contract match, not proof of
meeting-observer quality: A introduces browser playout/capture, WebRTC, and the
meeting codec, while LITE introduces a remote render queue and a second clock.

### The shared carrier is the first unknown

Both selected candidates depend on Attendee capturing a webpage. If the carrier
already degrades Fish audio, duplicates playback, cannot cancel cleanly, or lacks
enough telemetry, building either renderer teaches little. The first executable
experiment therefore contains no avatar.

### A bounded local renderer is a scientific control

E keeps queueing, frame timing, cancellation, CPU, and failure injection locally
observable. It helps separate carrier faults from managed-renderer faults. Its
selection does not claim it can meet a polished human-likeness bar. If that visual
bar makes E non-shippable, E can remain a capped calibration artifact.

### LITE is the only managed candidate currently inside the boundary

LITE can be fed audio without giving a vendor text, transcript, memory, tools, or
turn authority. FULL modes would duplicate or replace core cognition/TTS and are
therefore disqualified. LITE still adds credentials, voice/likeness processing,
billing lifecycle, deletion obligations, outage behavior, and A/V synchronization
risk.

## Disqualified and deferred alternatives

### B — Attendee `output_video`: disqualified

The documented endpoint accepts an HTTPS MP4 URL for queued playback. It is not a
continuous live-camera injection API. Repeatedly swapping MP4 files would be an
unsupported, latency-heavy mechanism with poor cancellation and no defensible
real-time contract.

### FULL managed avatar modes: disqualified

A service that performs STT, LLM, memory, tools, dialogue policy, or vendor TTS
would violate the frozen Agent Core and Fish constraints. A visual demo is not
worth creating two conversational authorities.

### C — Recall.ai Output Media: deferred diagnostic

Recall documents Google Meet/Zoom page capture, 15 fps output, DevTools/CPU metrics,
and larger compute variants. Those are useful diagnostics. However, C replaces the
meeting provider and reopens the same browser-output topology as the abandoned
historical attempt. Its past failure is not attributable from the surviving
evidence. Run **C+E as a separately approved diagnostic**, not as a first-round
candidate, only if A fails because of a reproducible Attendee-specific limitation
or insufficient telemetry. Do not run C+LITE until each layer has passed alone.

### Tavus Audio Echo: contract discovery only

Echo may eventually offer a synchronized renderer output, but the current evidence
does not establish its exact PCM/cadence, deterministic cancel semantics, returned
audio ownership, meeting handoff, price, retention, or deletion contract. It earns
no comparison slot yet.

### D-ID and other full pipelines: no current lead

No reviewed option offered a stronger renderer-only, single-Fish boundary with
enough current evidence to displace the two selected controls.

## Concrete PoC responsibility boundaries

Do not introduce `AvatarProvider`, a plugin registry, dependency-injection layer,
generic media shell, automatic provider failover, or a new lifecycle framework.
The maximum initial live PoC shape is:

1. **Attendee carrier page/bridge** — consumes already-produced PCM, owns browser
   playback/capture and deterministic visual markers, emits measurements.
2. **Bounded local renderer** — consumes utterance/timing controls, produces only
   visuals, and has explicit start/cancel/stop.
3. **LiveAvatar LITE adapter** — added only after the carrier gate passes; receives
   the same PCM and minimal lifecycle controls, never Agent Core semantics.
4. **PoC harness/telemetry** — fixtures, correlation IDs, observer recordings,
   resource sampling, and failure injection. It is test equipment, not a product
   framework.

Shared abstractions may be extracted only after two passing implementations reveal
an actually identical contract.

## Non-negotiable invariants

- One Agent Core and one turn decision.
- One Fish TTS generation per utterance.
- Exactly one audible waveform in the meeting.
- No second STT, LLM, TTS, memory, skill, or tool executor.
- Static bot payload and behavior remain unchanged when live mode is absent.
- A live dependency failure cannot create a second bot or silently switch media
  owners within the meeting.
- Every utterance carries a correlation ID, sample count, monotonic timestamps,
  cancel epoch, and final state.
- Cancellation stops local sends first; remote cleanup is attempted but cannot
  block local termination indefinitely.
- Vendor credentials never enter the captured browser page.
- No real participant data or custom likeness is used before privacy/rights review.

## Minority opinions retained

The skeptic's strongest concern remains binding: even a two-candidate PoC may become
prematurely feature-shaped. The carrier-only and off-meeting LITE probes must remain
true prerequisites; failed probes end the experiment before composition.

The vendor reviewer notes that local E can win a diagnostic score while failing the
actual visual product requirement. A visual acceptance floor must therefore be
declared before candidate results are shown.

The DSP reviewer rejects “same input bytes” as proof of preserved audio. Only the
observer-side decoded recording, blind comparison, and measured timing can support
that claim.

The meeting-bot reviewer preserves Recall as a possible carrier discriminator,
because a failed A test alone cannot prove all webpage carriers are unsuitable.

## Unresolved risks

- Actual sample rate and resampling chain inside the target browser.
- Browser scheduling, autoplay, buffer cadence, capture, WebRTC, and codec effects.
- Google Meet versus Zoom parity.
- Mac mini CPU/memory/thermal headroom under page capture and rendering.
- Stable A/V skew and drift; whether audio delay helps or merely hides variable lag.
- LITE accepted-sample/backpressure visibility, interrupt tail, reconnect, and
  delete/orphan-billing behavior.
- The exact visual quality floor and whether bounded E can ever ship.
- DPA, subprocessors, region, retention, training/reuse, biometric/likeness consent,
  deletion proof, concurrency, and effective LiveAvatar plan cost.
- Missing historical Recall recordings, logs, browser rate, compute variant, and
  human reason for revert.

## Council conclusion

Proceed to the staged comparison PoC specification, not product implementation.
The static bot remains the release architecture until measured evidence supports a
new ADR.
