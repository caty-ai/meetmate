# Live Avatar comparison PoC specification

Status: ready for a future implementation session; no implementation in this worktree

## Objective

Determine whether a live visual renderer can be added without materially degrading
the current Fish voice, Agent Core behavior, meeting stability, response latency,
static-mode isolation, privacy, or operations. The PoC is designed to falsify
unsafe paths, not to maximize demo polish.

## Frozen constraints

- Current Agent Core, personality, memory, skills, tools, and turn policy are not
  modified.
- Current Fish configuration and one-generation-per-utterance behavior are frozen.
- Current static bot payload and runtime remain the default and receive no live
  imports, credentials, initialization, timers, or fallback logic.
- No README, package, dependency, configuration, release, or production deployment
  change is part of the research session.
- Future PoC code must live behind an explicit non-default experiment entry point.
- No second STT, LLM, TTS, voice, bot, or audible meeting-output owner.

## Candidate ceiling

### Gate 0 — current static baseline

Run the current Attendee static-image/Fish system unchanged.

### Gate 1 — avatar-free A carrier

Attendee Voice Agent webpage only. Play deterministic frozen fixtures through the
page, show deterministic flash/frame markers, and measure what a remote meeting
observer receives. No avatar renderer is present.

**Hard stop:** if A fails any non-waived carrier gate, do not build A+E or A+LITE.

### Candidate 1 — A + bounded local E

Use the passing A carrier plus a simple local visual control. E may use amplitude,
viseme/timing metadata, or deterministic mouth states, but may not synthesize
speech, infer dialogue, or introduce a large local model. It must expose frame and
cancel timestamps.

### Candidate 2 — A + LiveAvatar LITE

Use the same passing A carrier and the same Fish PCM. Feed LITE only raw audio and
minimal lifecycle/control messages. The frontend is video-only; it must never
produce an audible track. Do not send text, transcript, prompt, memory, tools,
stable user ID, or internal turn state.

### Conditional diagnostic — C + bounded E

Not part of the first comparison. It requires a new written decision identifying
the Attendee-specific limitation or missing telemetry being tested. C+LITE is out
of scope.

## Before code: evidence and commercial prerequisites

1. Recover any old Recall meeting recordings, logs, browser sample rate, compute
   variant, CPU trace, platform, and revert rationale.
2. Record current vendor API versions and dated links.
3. Confirm Attendee Voice Agent availability, pricing, retention, region, deletion,
   and Google Meet/Zoom account constraints.
4. Confirm LiveAvatar LITE API access, credit rate, per-session maximum, concurrency,
   minimum billing, timeout, explicit-delete behavior, region, subprocessors,
   retention/training, deletion proof, and outage support.
5. Confirm that the selected LiveAvatar plan permits the test. Published examples
   have plan-specific maximum session durations; an uninterrupted 30-minute run
   must not be silently split if the acceptance protocol requires continuity.
6. For custom likeness, obtain documented authorization/consent and complete
   biometric/likeness review. Use synthetic/non-personal assets before that.
7. Name the operator responsible for detecting and reconciling orphan sessions and
   unexpected spend.

## Test environment

Record for every run:

- git commit, experiment ID, candidate, provider API version, plan/tier, region;
- machine model, OS, CPU cores, memory, thermal state, power mode;
- browser and version, actual `AudioContext.sampleRate`, page visibility/focus;
- meeting platform, account tier, meeting region if observable, participant count;
- wired/Wi-Fi network, RTT/jitter/loss, tunnel/proxy, and wall-clock synchronization;
- Fish model, sample rate, encoding, voice/reference ID hash, chunk settings;
- bot IDs, renderer session ID hash, correlation IDs, start/stop/delete results.

Use the same target Mac mini and a separate remote observer machine. Run Google Meet
first; repeat the qualifying path on Zoom before any cross-platform claim.

## Fixtures and script

Freeze the inputs before candidate results:

1. calibration tones and transient clicks for waveform/timing analysis;
2. silence and low-level noise segments;
3. short, medium, and long Japanese Fish utterances;
4. numbers, acronyms, punctuation, and rapid phoneme transitions;
5. overlapping participant speech and barge-in;
6. cancel during initial audio, mid-utterance, and final drain;
7. two rapid consecutive utterances;
8. reconnect during silence and during output;
9. explicit exit/leave;
10. idle intervals sufficient to expose leaks or orphan sessions.

The 30-minute scenario uses identical order, text, source PCM fixtures where
applicable, participant actions, and timing windows for baseline and candidates.
Randomize candidate labels for subjective evaluation.

## Instrumentation contract

For each utterance, emit structured events with:

- experiment, run, turn, utterance, bot, carrier, renderer, and cancel-epoch IDs;
- monotonic and synchronized wall timestamps;
- Fish request start/first-byte/end;
- source PCM byte/sample count, duration, hash, rate, channels, encoding;
- per-chunk sequence number, enqueue/dequeue/send/accept/drop timestamps;
- browser scheduled/playback/capture timestamps, `AudioContext` state, and actual
  sample rate;
- every resampling and codec-conversion boundary known to the application;
- visual marker/rendered-frame/presented-frame timestamps;
- meeting observer decoded-audio and captured-video timestamps;
- queue depth, underrun, overrun, late/drop/replay counters;
- barge-in/cancel request, local send stop, last audible sample, last visible frame;
- reconnect/page reload/vendor error/retry/state transition;
- CPU, memory, event-loop lag, encoder load if exposed, and thermal indicators;
- session create/connect/stop/delete results, duration, credits/cost estimate.

Unknown or unavailable measurements must be explicit, not zero.

## Measured outcomes

### Audio continuity and quality

- prove exactly one Fish generation and one audible observer waveform;
- source-to-observer duration ratio and sample continuity;
- missing, duplicated, reordered, clipped, or repeated regions;
- underrun/overrun count and maximum gap;
- level, clipping rate, noise/silence behavior, and objective spectral comparison;
- randomized blind listener rating against the unchanged static baseline.

Do not claim “same Fish quality” from matching source bytes alone.

### Latency

- turn-ready to Fish request;
- Fish request to first source PCM;
- source PCM to page playback;
- page playback to remote first audible sample;
- utterance/phoneme marker to remote visible response;
- end-to-end response-to-first-audio p50/p95;
- cancel request to last audible sample and last visible frame.
- barge-in attempts, accepted interruptions, false triggers, and success rate.

### A/V timing

- signed and absolute audio-versus-visual marker skew;
- p50/p95/max skew and drift over each utterance and the full run;
- discontinuities at utterance boundaries, cancel, reconnect, and page reload.

For LITE, compare immediate meeting audio with at most one predeclared bounded-delay
condition. Report added response latency separately; do not tune delay repeatedly
after seeing results.

### Meeting stability and operations

- bot admission and leave success;
- unexpected disconnect/reconnect/page reload;
- duplicate bot or duplicate audio count;
- 30-minute memory/resource slope and thermal throttling;
- stale queue/media after cancel;
- local stop time even when remote cleanup fails;
- remote session deletion confirmation and billed/observed duration.

### Static isolation

- existing static payload/observer output remains regression-equivalent;
- live code/dependencies are not imported or initialized in static mode;
- static works with live credentials absent;
- static works with renderer DNS blackholed/vendor returning 5xx;
- failed live execution never starts static in the same meeting;
- a later static session starts only after prior live-bot absence is proven.

## Threshold protocol

Numerical gates must be written and approved **after baseline characterization but
before revealing candidate labels/results**. Use baseline distribution, measurement
error, and product requirements—not convenient round numbers—to set:

- allowed blind-audio non-inferiority margin;
- response-latency and cancellation-tail bounds;
- maximum A/V skew and drift;
- underrun, duplicate, reconnect, and crash tolerances;
- CPU/memory/thermal budgets;
- visual acceptance floor;
- maximum session leakage and cost variance.

Some invariants have zero tolerance regardless of baseline: second TTS, second
audible owner, duplicate bot, Agent Core semantic leakage, static-mode dependency,
or unbounded local shutdown.

## Gate decisions

### Gate 0 passes when

- the 30-minute baseline is repeatable;
- instrumentation itself does not alter the baseline materially;
- the team can identify source and observer timestamps and set thresholds.

### Gate 1 passes when

- A meets the frozen carrier thresholds;
- observer audio lineage is complete and singular;
- cancel/reconnect/page lifecycle are bounded;
- resource use fits the target host;
- enough evidence exists to attribute later renderer faults.

If it fails, record the smallest falsified assumption and stop. Consider C+E only
through a new decision with an explicit discriminator.

### Candidate passes when

- it passes all hard invariants and baseline-derived gates;
- visual quality meets the predeclared floor;
- 30-minute telemetry and observer media are complete;
- injected failures leave no duplicate/stale output;
- cost/privacy/lifecycle prerequisites are satisfied.

## Failure injection

Run, at minimum:

- carrier websocket disconnect and reconnect;
- page reload and hidden/background page;
- renderer connect timeout and mid-utterance disconnect;
- vendor 429/5xx and delayed/absent acknowledgements;
- lost stop/delete response and orphan-session reconciliation;
- rapid repeated cancel and a new utterance immediately after cancel;
- meeting bot reconnect during speech;
- CPU contention and constrained network;
- live credential absent/invalid and live DNS blackholed;
- operator process termination and restart.

No retry may replay an already-audible utterance.

## Decision rule

At PoC completion, choose exactly one:

1. **reject live avatar** and retain static;
2. **adopt one bounded architecture for a production-design phase**, backed by a
   new ADR and security/privacy review;
3. **run one named diagnostic**, such as C+E for a proven Attendee-specific carrier
   question.

Do not conclude “both seem promising” without assigning a failed/unresolved gate.
A higher weighted prior cannot override a hard failure.

## Deliverables

- immutable run manifest and fixture hashes;
- structured event logs and metric definitions;
- observer audio/video artifacts with privacy-safe retention;
- baseline and candidate scorecards;
- blind-listening results and visual-floor results;
- failure-injection report;
- cost/session/deletion reconciliation;
- static regression evidence;
- go/reject/diagnostic decision and updated ADR.
