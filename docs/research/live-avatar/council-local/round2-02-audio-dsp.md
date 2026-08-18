# Round 2 cross-review — Audio/DSP

Date: 2026-07-23  
Scope: specification only; no implementation

## Cross-review of the five Round 1 proposals

### 01 — Meeting Bot / WebRTC

**Strongest point:** It states the carrier ownership rule plainly: H keeps the
existing realtime WebSocket as the sole input/output owner, A is a separate
architecture, and observer-side A/V skew—not a page timestamp—is the H gate. Its
staged H → L0 → L1 shape and no-automatic-A-fallback rule are operationally
sound.

**Strongest objection:** The proposed 60 ms source windows and direct reuse of
`-50...-10 dB`, `0.2`, and `0.7` are Caty implementation constants, not
Meetmate calibration evidence. Sixty milliseconds is also too coarse as the
primary extraction cadence for onset/offset measurement. More importantly,
“source sample index plus measured page delay” remains only a predictor of
Attendee playout. It cannot become a playback clock by clock-syncing the server
and page.

### 02 — Audio/DSP

**Strongest point:** It gives the most complete same-sample lineage: 20 ms RMS,
10 ms hop, chunk-boundary carry, corpus-derived normalization, causal smoothing,
source sample indices, diagnostic hashes, cancel epochs, and separate H/A clock
claims. It explicitly says that H has no playout acknowledgement.

**Strongest objection:** Allowing optional L2 files in the same implementation
issue is broader than the evidence permits. It also listed A-only playback files
inside a proposal whose first carrier is H. H can prove that the envelope came
from the bytes handed to `realtime_audio.bot_output`; it cannot prove that those
bytes were admitted to, retained by, or presented from Attendee's actual playout
queue. The final contract must use that narrower wording.

### 03 — Local Renderer / Caty Asset

**Strongest point:** It distinguishes L1's diagnostic value from L2's polish and
identifies the real L2 risks: WebGL/context lifecycle, an additional 80 ms
lookback, nondeterministic motion, asset size, and separate runtime/art
provenance. Its fail-closed visual behavior and provenance manifest are valuable.

**Strongest objection:** A silent H page must not run a tee through an
AudioWorklet, even at zero gain, to manufacture an “analysis clock.” Such a clock
would be the page's clock, not the realtime-audio manager's playout clock, and an
active graph/track may violate the silent-page and one-owner experiment.
The proposal also reuses Caty's `-50...-10 dB` and `0.2/0.7` values before corpus
calibration. Putting L2 and WebGL fallback into the same first issue mixes
renderer quality with the still-unproved carrier.

### 04 — Module Boundary / Test Contract

**Strongest point:** It exposes the most important missing control boundary:
`createPipeline(..., onAudio)` exposes PCM but not a transport-visible
authoritative output/cancel epoch. Its `connection + epoch + firstSample`
protocol, stale-message rejection, bounded visual queue, static isolation, and
rule that L1 must not poll mutable turn state are the right safety contract.

**Strongest objection:** Mapping `originServerMonoMs + sampleIndex / 24000` into
the page clock is useful for issuing visual predictions, but it is not evidence
of audible presentation. The current server emits Fish callbacks without an
explicit playout pacer, while Attendee/Meet may buffer, resample, gate, or drop
audio. The proposal correctly calls observer skew a gate, but parts of its
wording still call the mapped timeline an “envelope playback schedule.” It should
be named a **predicted visual schedule** in H and must be rejected if one fixed
calibration cannot bound residual skew/drift. Its fixed Caty dB/frame constants
also need corpus calibration.

### 05 — Skeptic / Security / Operations

**Strongest point:** It draws the safest issue boundary: first characterize the
already-unstable Issue #62 baseline, then run an avatar-free H0 coexistence
probe, and only afterward authorize L1. It also correctly distinguishes file
identity from art rights, requires a truly audio-free H page, and documents why
the current WebRig is not deterministic under identical PCM.

**Strongest objection:** “Consumed/scheduled sample positions” is correct for A
but must not leak into the H description. In H, Meetmate observes neither
consumption nor scheduling inside Attendee; it has source indices, send events,
page presentation events, and independent observer media. Also, an H0 issue is
useful only if it includes repeated marker measurements across utterance
boundaries, reconnect, cancel, and a 30-minute run. A one-shot coexistence proof
would establish topology but not a usable lip-sync relationship.

## Resolutions

### 1. H probe only versus gated H → L0 → L1

Use two levels of planning:

- A tracking issue may describe the full decision ladder:
  static baseline → H0/L0 → L1 → later L2 decision.
- The **first executable implementation issue is H0/L0 only**. It creates a
  public audio-free page with deterministic sample-indexed flashes, the minimal
  visual relay/control contract, static-regression tests, and observer
  instrumentation.
- A separate L1 issue may be drafted in advance but stays blocked. It opens for
  execution only after H0 proves hosted coexistence, a truly silent page, exactly
  one audible owner, lifecycle isolation, and a stable observer-measured mapping.

This is not process for its own sake. Whether H can support lip sync is presently
unknown because Attendee's actual audio playout clock is not observable. It is
premature to import avatar art or implement mouth thresholds before L0 answers
that question.

If H0 fails, close the H issue with evidence. Do not turn it into Full-page A.
A needs a new decision and must remove the realtime WebSocket as an audible
owner.

### 2. L2 scope

Defer L2 to a separate issue and decision after L1 evidence is frozen. The first
L1 implementation should contain one direct three-state draw function, not a
renderer registry or dormant WebRig.

L2 is eligible only if:

- L1 passes carrier, clock, cancel, reconnect, static, resource, and provenance
  gates;
- L1 misses only a predeclared visual-naturalness/product floor that L2 could
  plausibly improve;
- art rights and the MIT-derived runtime manifest are complete;
- random mouth behavior is disabled or deterministically seeded;
- context restoration cannot revive old epochs; and
- the target Attendee browser survives the 30-minute WebGL test.

L1 may later serve as L2's closed-mouth fallback, but that future relationship
does not justify bundling L2 now.

### 3. RMS window, cadence, and constants

Adopt **20 ms RMS windows with a 10 ms hop at 24 kHz**:

- window: 480 S16LE samples;
- hop: 240 samples;
- continuous carry across arbitrary Fish and WebSocket chunk boundaries;
- mean removal, then RMS and dBFS;
- no dominant-frequency or phoneme inference.

This cadence gives deterministic 10 ms source coordinates for onset/offset and
enough density for a 60 Hz visual renderer. Caty's 60 ms meter is evidence that
amplitude animation is viable, not the correct transport/DSP cadence.

Do not copy Caty's `-50...-10 dB`, `-35/-20 dB`, `0.2/0.7`, WebRig
attack/decay, 80 ms lookback, random rest, or syllable constants. Generate a
versioned calibration artifact from frozen current Fish Japanese speech,
generated silence, and the exact comfort-noise implementation. At minimum it
records:

- `noise_ceiling_db = P95(non-speech dBFS)`;
- voiced low/high percentiles and their usable spread;
- closed/half/open boundaries derived from the voiced distribution;
- attack/decay and hysteresis selected before blinded candidate review;
- sample rate, extractor version, fixture hashes, and labels.

The 20/10 ms analysis geometry is fixed now. Normalization, thresholds,
attack/decay, and visual lookback become numeric only after corpus and baseline
measurement, then remain frozen throughout comparison. Per-utterance AGC,
lookahead normalization, and post-result tuning are forbidden.

### 4. What is and is not observable in H

H exposes:

- exact Fish PCM at the Meetmate output seam;
- source sample indices and hashes;
- the local time at which Meetmate handed each `bot_output` message to its
  realtime WebSocket;
- server/page clock-offset estimates;
- the page's requested and actual animation-frame presentation times; and
- synchronized observer audio/video.

H does **not** expose:

- Attendee's realtime output queue admission;
- resampler position;
- VAD/noise-suppression decisions;
- WebRTC packetization;
- Meet receive/playout position; or
- an acknowledgement that source sample `N` was audible at time `T`.

Therefore:

> No proposal may infer A/V sync from PCM generation time, WebSocket send time,
> cumulative sample duration, server/page clock sync, or a muted page
> AudioContext.

Those values can schedule a prediction and diagnose drift, but only synchronized
observer media can accept H. Issue #62 makes this distinction material: callbacks
were sent without recorded abort/stall errors while speech still arrived cut.

L0 must use repeated, recognizable transients and corresponding flashes at the
start, middle, and end of long fixtures and across utterance boundaries. Report
residual signed skew, absolute skew, variance, and drift after applying at most
one predeclared fixed offset. Do not dynamically chase observer results or add an
audio delay to make a failed relationship appear synchronized.

If no single fixed mapping remains bounded under baseline, 30-minute, cancel, and
reconnect scenarios, H may still be a valid video-plus-audio topology but it is
rejected as the amplitude lip-sync carrier.

In A, by contrast, the sole audible page `AudioWorkletProcessor` can report the
source sample dequeued at its render clock. Even that is scheduled browser
presentation rather than remote participant playout, so observer capture remains
the end-to-end gate.

### 5. Envelope timestamps, cancel epoch, and stale replay

The H0/L1 visual contract carries:

```text
{
  session_generation,
  page_connection,
  utterance_id,
  cancel_epoch,
  first_sample,
  window_samples,
  sample_rate,
  rms_dbfs,
  normalized_level
}
```

Rules:

1. `first_sample` is continuous over the exact PCM copied at the existing output
   seam and is invariant to rechunking.
2. A `page_connection` increase invalidates all earlier connection messages.
3. `cancel_epoch` increases synchronously at the authoritative local abort before
   a newer utterance can be admitted.
4. Cancel/stop immediately clears pending visual state and draws closed; it does
   not wait for attack/decay or a network window.
5. Every lower epoch and prior-generation message is rejected before scheduling
   or drawing.
6. Reconnect starts closed and receives only current state. No historical
   envelope or PCM is replayed.
7. The visual queue is bounded by source duration. Overflow drops visual data,
   records the exact sample range, and never backpressures Fish, Agent Core, or
   realtime audio.
8. Late windows whose predicted presentation deadline has passed are dropped or
   coalesced to the current state; they are never replayed in a burst.

The missing transport-visible cancel epoch identified by proposal 04 is a
prerequisite. It should be provided by a narrow handler/control callback adjacent
to the existing abort authority. Polling `turnState`, guessing from PCM silence,
or treating a WebSocket close as cancel is not acceptable.

H cannot retract audio already handed to Attendee. Consequently report two
separate cancel tails:

- request → last non-closed observer video frame; and
- request → last audible observer sample.

Immediate visual close does not prove immediate audio cancellation.

### 6. Deterministic tests and observer gates

#### Unit and fixture tests

- exact RMS/dBFS for zero, DC-offset, known-amplitude sine, low noise, clipped
  samples, odd-byte splits, and arbitrary rechunking;
- exact 480-sample windows and 240-sample hops with invariant sample indices;
- frozen PCM produces byte-identical envelope and frame traces on repeat runs;
- calibration artifact rejects wrong sample rate, missing fixture hashes,
  insufficient speech/noise spread, and comfort-noise false openings;
- connection/generation/epoch ordering, duplicates, gaps, overflow, late
  coalescing, rapid repeated cancel, and immediately following utterances;
- attack/decay is deterministic in source-sample time and cancel bypasses it;
- H payload has one realtime audio owner and the H page has no audio element,
  `AudioContext`, oscillator, media audio track, or audio destination;
- default static mode neither loads nor depends on live modules/assets.

#### Actual-browser tests

- deterministic marker/frame trace under delayed, reordered, and batched visual
  delivery;
- `requestAnimationFrame` slowdown, hidden page, reload, socket loss, and new
  connection;
- cancel closes before the next presented frame and stale state never reopens;
- asset failure produces a closed fallback;
- browser telemetry distinguishes scheduled from actually presented frames;
- no console error, unhandled rejection, retry storm, or unbounded state history.

Do not test H's audio clock with an AudioContext: H intentionally has none.

#### Hosted carrier and observer gates

Before L1:

- hosted Attendee accepts and sustains both settings;
- current realtime input and output remain functional;
- the page contributes no audio track/energy and observer analysis finds exactly
  one waveform, with no new comb filtering, level/gating change, or duplicate bot;
- page kill/reload/socket loss does not stop, replace, delay, or replay audio;
- blind and objective start/mid-cut behavior is non-inferior to the frozen static
  baseline;
- L0 source markers, presented flashes, and observer transients have complete
  timestamps;
- signed/absolute skew p50/p95/max, residual variance, and drift meet the numeric
  gates frozen after baseline and before candidate results;
- cancel, reconnect, leave, queue/resource, and 30-minute gates pass.

Numerical limits must follow `04-comparison-poc-spec.md`: characterize the
unchanged baseline first, approve limits, then freeze them before revealing
candidate labels/results. This review intentionally does not invent p95
milliseconds or CPU percentages without measurements.

Before L2, L1 must additionally pass its deterministic mouth-state trace,
observer visual floor, cancel-to-last-visible-frame, FPS/long-frame,
memory/resource slope, and art-rights gates. L2 must show a material blinded
visual improvement without worsening any frozen media or operational gate.

## Compromise scope

1. **Now:** draft one executable **H0/L0 carrier issue**. It contains baseline
   instrumentation, the non-default combined payload, an audio-free marker page,
   same-sample lineage, the narrow cancel-epoch/control seam, observer capture,
   static isolation, and failure injection. No Caty asset, L1 thresholds,
   AudioWorklet, A code, or L2 code.
2. **After H0 passes:** execute a separately scoped **H + L1 issue** using the
   frozen 20/10 ms extractor and corpus calibration artifact. It adds only the
   cleared three-state frames and deterministic mapping.
3. **If H0 fails:** return to an explicit A decision. Do not preserve the H
   visual scheduling assumptions or run both audible paths.
4. **After L1 passes:** consider a separate L2 issue only for a declared visual
   hypothesis, with deterministic test mode, provenance, WebGL/resource gates,
   and L1 closed fallback.

This compromise preserves proposal 01's useful decision ladder, proposal 02's
DSP rigor, proposal 03's renderer/provenance insights, proposal 04's boundary and
epoch contract, and proposal 05's minimal falsification order.

## Vote

**YES** to filing and executing one H0/L0 carrier issue with the prerequisites
and stop gates above.

**NO** to including L1, L2, Full-page A, Caty assets, or a silent AudioWorklet in
that first executable issue.

**Conditional YES** to a subsequent H + L1 issue only after observer evidence
proves that H has a bounded, stable A/V relationship and the cancel-epoch and
asset/calibration prerequisites are complete.

**NO** to L2 in the L1 issue; L2 requires a later evidence-backed decision.
