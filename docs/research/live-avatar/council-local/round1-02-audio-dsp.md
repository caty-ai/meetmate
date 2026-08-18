# Round 1 — Audio/DSP specialist

## Verdict

**L1 is the smallest renderer that produces useful product evidence.** Build the
deterministic L0 carrier marker first, then L1. L2 may be kept as a bounded,
test-only renderer fixture in the same issue, but it must remain disabled until
L1 passes. L1 and L2 must consume the same timestamped PCM-energy contract; L2
is not a second media architecture.

The preferred carrier experiment is **Hybrid H**:

- `websocket_settings.audio` remains the only meeting audio input/output;
- `voice_agent_settings.url` supplies video from a page that is demonstrably
  silent.

Current Attendee source at commit
`ba74253c3c27a10bc10c5ded67a34eddc82b915d` is positive implementation
evidence: it accepts both settings and independently constructs the realtime
WebSocket and webpage-streamer managers, with no visible mutual exclusion.
That is **not** proof of the hosted runtime, the deployed version, lifecycle
behavior, or a truly silent page. H therefore remains a carrier hypothesis until
the sandbox and observer tests below pass.

Full-page A is not a transparent fallback inside this issue. A replaces the
currently audible path. If H fails, record the failed assumption and return to
the architecture decision; proceed with A only under an explicitly approved
carrier branch whose avatar-free L0 passes.

## Proposed PCM-energy contract

### Same-sample lineage

The authoritative source coordinate is a monotonically increasing sample index
over the exact 24 kHz mono S16LE bytes admitted to the selected audible path.
Fish/network chunk boundaries have no DSP meaning.

At the single current audio seam, assign:

- `renderer_session_id`
- `utterance_id`
- `cancel_epoch`
- `sample_start`
- `sample_count`
- a diagnostic hash of the PCM bytes

The incremental extractor carries incomplete samples and incomplete windows
across callbacks. It must never reset merely because Fish emitted another chunk.
It emits:

```text
{
  renderer_session_id,
  utterance_id,
  cancel_epoch,
  window_start_sample,
  window_center_sample,
  sample_count,
  rms_dbfs,
  level
}
```

For A, “admitted” means bytes accepted into the page's one bounded playback
queue; admission records both the source range and its scheduled
`AudioContext.currentTime`. For H, the PCM fork and envelope are made at the
same server seam as the bytes sent as `realtime_audio.bot_output`. The server
can prove common source samples in H, but cannot prove when Attendee/Meet made
them audible because the current path provides no playout acknowledgement.

Any dropped audio range must also drop its envelope range. It is invalid to
animate bytes that were rejected by the audio queue. Hash/sample-count
reconciliation at the fork and page admission is diagnostic evidence, not a
new content protocol.

### Window, cadence, and energy

Use a **20 ms RMS window (480 samples) and 10 ms hop (240 samples) at 24 kHz**.
This produces a 100 Hz envelope that can be interpolated by a typical 60 Hz
render loop without tying state to network arrivals.

For each window:

1. convert S16LE to `x = sample / 32768`;
2. remove the window mean;
3. compute `rms = sqrt(mean((x - mean(x))^2))`;
4. compute `rms_dbfs = 20 * log10(max(rms, 1 / 32768))`.

A rectangular window is sufficient for energy. Do not estimate dominant
frequency: it is neither a Japanese viseme model nor a reliable mouth-opening
signal.

### Normalization and calibration

Do not copy Caty's fixed `-50...-10 dB`, `-35/-20 dB`, or normalized
`0.2/0.7` thresholds. They describe a different player, meter, corpus, and
acoustic chain. Produce and version a calibration JSON from the frozen current
Fish fixtures plus the exact generated silence/comfort-noise fixtures:

```text
noise_ceiling_db = P95(non-speech window dBFS)
speech_floor_db  = max(noise_ceiling_db + 6 dB, P10(voiced window dBFS))
speech_high_db   = P90(voiced window dBFS)
level            = clamp(
                     (rms_dbfs - speech_floor_db)
                     / (speech_high_db - speech_floor_db),
                     0, 1)
```

Calibration is invalid if `speech_high_db - speech_floor_db < 12 dB`, if the
fixture labels/sample rate do not match runtime, or if comfort noise opens the
mouth. These are calibration stop conditions, not values to tune during a
blind comparison.

L1 uses calibration-derived discrete boundaries:

- `half_threshold = P35(level | voiced calibration windows)`
- `open_threshold = P75(level | voiced calibration windows)`
- speech becomes active at `speech_floor_db`;
- it becomes inactive below `speech_floor_db - 3 dB`.

Persist the resulting numeric values, fixture hashes, extractor version, and
sample rate. Freeze them before the blinded run. Do not run per-utterance AGC
or normalize with future samples; both cause pumping and make live timing
non-causal.

The `6 dB`, `12 dB`, percentile, and `3 dB` values above are a predeclared
starting calibration rule, not Caty constants or an assertion about current
Fish output. Change them only from recorded calibration evidence and then
refreeze the comparison.

### Attack, decay, and renderer behavior

Apply a causal one-pole smoother in **source-sample time**, after normalization:

```text
alpha = 1 - exp(-hop_seconds / tau)
y[n]  = y[n-1] + alpha * (x[n] - y[n-1])
```

Start with `tau_attack = 20 ms` and `tau_decay = 70 ms`; freeze the values after
the Japanese fixture calibration. Cancel bypasses smoothing and sets the
rendered level to zero immediately.

Caty's WebRig coefficients (`attackK = 25`, `decayK = 8`), 70–180 ms random
syllable timing, voiced thresholds `0.015/0.009`, 22% random rests, 80 ms
lookback, 24-sample history, shape probabilities, and snap/hysteresis values
must be recalibrated or disabled, not copied. Random mouth rests and
syllable/shape perturbation are disabled during L0/L1/L2 measurement because
they obscure source-to-observer correlation. If later retained for L2, seed
them from `(utterance_id, window_start_sample)` and show that they do not
worsen the frozen skew gate.

### Playback clock and jitter

Envelope arrival time never drives the mouth.

For **A**, the already-proven bounded page player must expose one continuous
mapping from source sample ranges to scheduled AudioContext time. The render
loop reads `AudioContext.currentTime`, converts it to the currently presented
source sample, and linearly interpolates the two adjacent envelope events.
Schedule a continuous ring/worklet queue, not one `AudioBufferSourceNode` per
Fish or WebSocket chunk. Browser resampling is allowed only after the 24 kHz
source-domain sample coordinate has been recorded.

There is exactly one audio jitter buffer: the carrier player's bounded PCM
queue. The renderer holds timestamped envelope history but does not add audio
delay. Size the visual history from measured envelope-arrival lateness:

```text
lookback = clamp(P99(arrival_lateness) + one_render_interval, 20 ms, 120 ms)
history  = lookback + 250 ms
```

Freeze the measured lookback before comparison; stop if the required value
exceeds 120 ms or the history would become unbounded. Caty's 80 ms is evidence
that a timestamped lookback works, not a Meetmate default.

For **H**, do not invent an AudioContext clock or a second audio queue. Use the
nominal source sample/send timeline for the silent video page and measure its
offset against observer-captured audible audio. The page may use the same
bounded envelope-history rule, but H passes only if observer skew and drift
stay within the frozen gate. If actual Attendee/Meet playout jitter makes that
mapping unstable, H is rejected even though it preserves the current audio
route.

The current H audio route sends Fish callbacks immediately and has no explicit
pacer. Issue #62 reports improved quality at 24 kHz but remaining cut speech
starts/mid-response. Therefore H must not be described as clean audio or
sample-accurate playback. Its advantage is preservation of the current
baseline, not removal of its known defects.

### Cancel and reconnect

Increment `cancel_epoch` at the authoritative local abort before any subsequent
utterance is admitted. Every queued PCM range and envelope event carries the
epoch.

On cancel:

1. stop accepting old-epoch PCM/envelopes;
2. in A, flush old-epoch PCM from the bounded playback queue;
3. clear the source-sample-to-playback-clock mapping and envelope history;
4. force the mouth closed before the next animation frame;
5. reject every late old-epoch event.

In H, already handed-off Attendee audio cannot be retracted by the page; close
video immediately and measure the residual audible tail at the observer. A
reconnect or page reload receives only the current epoch and current live
state—never a replay buffer. Rapid repeated cancel and an immediately following
utterance must not let an earlier epoch close or animate the newer one.

### Observer metrics

Define signed A/V skew as:

```text
visible transition time - audible transition time
```

Positive values mean video lags audio. Capture synchronized observer media and
report, separately for onset and offset:

- signed and absolute skew p50/p95/max;
- skew drift slope over each utterance and the 30-minute run;
- discontinuities at utterance boundaries, cancel, reconnect, and reload;
- source sample, page schedule, animation-frame presentation, and observer
  timestamps where the carrier exposes them;
- cancel request to last audible sample and last non-closed visual frame;
- missed/extra mouth transitions and false openings during silence/comfort
  noise;
- PCM missing/duplicate/reordered/clipped ranges, queue depth,
  underrun/overrun, and maximum gap;
- render FPS, missed animation intervals, memory slope, CPU, and thermal state;
- count of audible owners and duplicate observer waveforms.

L0 uses frozen PCM transients paired with sample-position visual flashes. L1
uses predeclared energy bursts and expected closed/half/open transitions. A
screen-only timestamp or page log is insufficient observer evidence.

## Answers to the council questions

### 1. Smallest useful implementation

L1. L0 is a required carrier falsification fixture but is not an avatar. L1
proves same-sample energy, discrete mouth movement, actual A/V skew, cancel, and
resource cost with much less renderer uncertainty than L2.

### 2. Ordering of L1 and L2

L1 must pass before L2 is exercised. One bounded implementation issue may contain
both concrete renderer fixtures only if L2 is a direct swap behind a test
selection and consumes the identical envelope contract. Do not build a provider
registry, renderer SDK, or general plugin framework.

### 3. Extraction and clock tie

Extract incrementally at the single server PCM seam after Fish output and before
the selected carrier's resampling. Preserve source sample indices across
callbacks. In A, reconcile those indices at page queue admission and render from
the continuous AudioContext schedule. In H, render from the nominal source
timeline and require observer proof because no audible-playout clock is exposed.
Never schedule or animate per network chunk.

### 4. Exact runtime modules/files

The proposed implementation should be limited to:

- `src/live-avatar/pcm-envelope.js` — incremental 24 kHz S16LE RMS extraction,
  frozen normalization, smoothing, and sample-index events.
- `src/transport-meet/local-avatar-session.js` — one selected H/A session's
  sample lineage, cancel epoch, bounded state delivery, and reconnect rejection.
- `public/local-avatar/index.html` — minimal Attendee-captured 1280×720 page and
  explicit L0/L1/L2 fixture selection.
- `public/local-avatar/local-avatar.js` — state transport, playback-clock
  interpolation, cancel/reconnect handling, L0 marker, and L1 frame selection.
- `public/local-avatar/pcm-player-worklet.js` — A-only continuous bounded PCM
  playback and source-sample/AudioContext schedule reporting; it is absent or
  inert in H.
- `public/local-avatar/assets/frames/` — approved L1 frame assets plus an asset
  manifest with hashes and provenance.
- `public/local-avatar/webrig/` — optional gated L2 copied/adapted runtime, baked
  rig, source manifest, and preserved `NOTICE.md`.
- `config/live-avatar-envelope.json` — frozen calibration output and fixture
  hashes, not hand-tuned runtime policy.

Test files should mirror these responsibilities:

- `test/pcm-envelope.test.js`
- `test/local-avatar-session.test.js`
- `test/local-avatar-browser.test.js`
- `test/local-avatar-static-regression.test.js`
- `test/fixtures/live-avatar/`

Names may follow an existing repository naming convention during implementation,
but responsibilities must not be combined into a future-provider abstraction.

### 5. Thin wiring in existing static/core files

Only `src/transport-meet/meet-routes.js` should select the experimental payload,
fork the existing `onAudio` bytes into the selected local-avatar session, and
forward the authoritative abort/cancel epoch. The route already owns bot payload
construction and the final `realtime_audio.bot_output` send.

If the route cannot currently observe the exact instant of every pipeline abort,
add one optional, synchronous playback-cancel notification at the existing
`currentAbort.abort()` authority in `src/pipeline.js`; do not rewrite cancellation,
TTS, dialogue, or turn ownership. This is the sole acceptable core seam.

`src/config.js` may parse a default-off experimental configuration block if that
cannot remain route-local. With the block absent, the static payload, timing,
audio callback, and dependencies must be byte/behavior equivalent to the current
path.

### 6. Caty reuse and provenance

- Adapt the RMS-to-envelope behavior and timestamped-state idea; do not import
  Swift/iOS application code.
- Use frame assets only after rights and origin are recorded in the asset
  manifest. Adapt frame-state semantics rather than copying
  `CatyController.swift` or `FrameAvatarView.swift`.
- L2 may copy/adapt the browser WebRig and consume the baked rig as a versioned
  generated asset. Pin the exact source commit/object hashes, mark derived files,
  and preserve the Anime2.5DRig MIT `NOTICE.md`.
- Reference existing rig-generation tools as an offline asset pipeline; do not
  make them a Meetmate runtime dependency.
- Recalibrate every Caty audio/timing constant listed above. Blink, breath, and
  body motion may remain renderer-local only after mouth timing is deterministic.

### 7. Mandatory tests

**Unit:** odd-byte handling; PCM chunk-boundary invariance; window/hop indices;
DC removal; zero, comfort-noise, full-scale, clipped, and frozen speech fixtures;
calibration validation; normalized thresholds; exact attack/decay progression;
sample/hash reconciliation; epoch increment, flush, and late-event rejection.

**Browser:** one continuous worklet queue in A; source-sample/AudioContext mapping
under browser resampling; bounded underrun/overrun behavior; render interpolation
independent of WebSocket arrival; H page emits no audio; cancel closes before the
next frame; reload/reconnect cannot replay; WebGL loss is contained to L2.

**Carrier:** H payload with both settings on the hosted sandbox; realtime
input/output still works; page failure cannot stop, replace, or replay realtime
audio; exactly one observer waveform. Test Google Meet first and the Zoom web
adapter before any Zoom claim. For A, run avatar-free L0 and all frozen audio
quality gates before an avatar.

**Thirty-minute:** identical fixture order, PCM where applicable, lifecycle and
failure injections; complete synchronized observer media and telemetry; no
unbounded queue/history, memory slope, thermal throttling, drift, stale state, or
duplicate audio.

**Cancel/reconnect:** cancel during initial audio, mid-utterance, and final drain;
rapid repeated cancel; immediate next utterance; lost state message; page crash,
reload, and reconnect; late old-epoch packets; failed remote cleanup.

**Static regression:** experimental config absent and experimental endpoint
blackholed; exact existing bot payload/audio behavior; no new required service,
page, credential, or runtime dependency.

All numerical acceptance gates must be approved after repeatable baseline
characterization and frozen before the blinded comparison, as required by the
existing PoC spec.

### 8. Immediate-stop conditions

Stop before L1 if:

- hosted H does not accept or sustain both settings;
- the H page exposes audible energy/a meeting audio track, or the observer finds
  more than one audible owner;
- page failure affects realtime audio lifecycle;
- H cannot meet a frozen observer skew/drift bound because no playout clock is
  available;
- A is selected but avatar-free L0 worsens a non-waived frozen carrier gate;
- sample lineage cannot reconcile, the queue/history is unbounded, state is
  driven by arrival, or cancel/reconnect admits an old epoch;
- calibration fails its spread/noise checks or observer timestamps cannot be
  correlated.

Stop before L2 if:

- L1 misses the frozen A/V, cancel, visual-floor, FPS, resource, or 30-minute
  gates;
- L2 requires a new media path or changes the frozen envelope contract;
- random WebRig motion prevents deterministic measurement;
- WebGL loss, CPU/thermal cost, or resource slope exceeds its frozen gate;
- asset rights, exact derivation, or required MIT attribution is unresolved.

Also stop either branch on static-mode regression, duplicate bot/audio, stale
media after cancel, or worsened missing/cut/repeated audio versus baseline.

### 9. Abstraction check

Yes. The proposal contains a concrete PCM extractor, one Meet transport session,
one page, and two bounded render fixtures. It introduces no LiveAvatar, Recall,
generic avatar-provider, phoneme, or shared cross-repository abstraction. L2
reuses the L1 state contract rather than anticipating future providers.

### 10. Vote and prerequisites

**Vote: YES, ready to become one gated implementation issue; NO to starting
production renderer implementation before its prerequisites pass.**

Prerequisites are:

1. a hosted sandbox H coexistence test or vendor confirmation, followed by proof
   of a silent page, one audible owner, and lifecycle isolation;
2. if H is falsified, a new architecture decision before pursuing A, then an
   avatar-free A/L0 carrier pass;
3. repeatable baseline characterization and frozen numeric audio, A/V, cancel,
   reconnect, resource, and visual-floor gates;
4. frozen envelope calibration JSON with fixture hashes;
5. synchronized observer capture and correlatable timestamps;
6. approved L1 asset rights/provenance and, before L2, pinned WebRig derivation
   plus preserved MIT notice;
7. an explicit default-off static regression test.

This issue should end at the first falsified carrier or renderer assumption
rather than silently switching H to A or L1 to L2.
