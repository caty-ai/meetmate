# Round 3 final vote — Audio/DSP

Date: 2026-07-23  
Scope: final issue-shape decision only; no implementation

## Changed view from Round 2

In Round 2 I voted for an executable H0/L0 issue followed by a separate H + L1
issue. I now accept **one experiment issue containing both H0 and conditional
L1**, because the common compromise makes source scope—not issue count—the
enforcement boundary:

- the issue can be drafted now as one falsification ledger;
- M0 must lock behavior and prove the minimum cancel/output-epoch seam;
- only H0 files may exist before the hosted H pass is recorded;
- L1 code, calibration, and synthetic frame assets remain prohibited until the
  gate owner approves the retained H0 evidence; and
- an H0 stop closes the issue successfully without A or renderer code.

This changes issue organization, not the audio conclusion. Hybrid H still has no
observable Attendee/Meet playout clock. PCM generation time, WebSocket send time,
cumulative sample duration, server/page clock synchronization, or a muted page
audio graph cannot prove lip sync. Synchronized observer media remains the
acceptance authority.

## Final vote table

| Decision | Vote | Binding qualification |
|---|---:|---|
| **A. Draft the experiment issue now** | **YES** | Issue-ready, not code-start-ready. Drafting authorizes only the stated gates and file ceiling. |
| **B. Use one issue for M0 → H0 → conditional L1** | **YES** | Each milestone is a separate reviewed checkpoint; no L1 file/task starts before a recorded H0 pass. |
| **C. Keep L2 out** | **YES** | No WebRig, WebGL, selector, fallback, rig asset, notice package, or dormant L2 code. |
| Keep Full-page A fallback out | **YES** | H failure closes the issue and returns to a new architecture decision. |
| Keep Caty art out | **YES** | L0 is geometric; conditional L1 uses only newly created synthetic/non-personal frames with provenance. |
| Keep LiveAvatar/Recall out | **YES** | No adapter, provider interface, vendor config, or comparison implementation. |
| Start M0 code before its regression/test contract is reviewed | **NO** | Tests and the exact additive event contract are the code-start gate. |
| Start H0 before M0 passes | **NO** | Static parity and semantic-neutral cancel observation must pass first. |
| Start L1 before H0/security/cancel baselines pass | **NO** | The approval comment and linked artifacts are mandatory. |
| Treat H source/send time as actual audio presentation | **NO** | Only observer capture can accept the H A/V relationship. |

## Exact issue title

**Experiment: qualify Attendee Hybrid H with L0 and conditionally add
deterministic L1 frame lip sync**

“Experiment” is mandatory. The issue must not be labeled feature, production
avatar, or rollout.

## D. Prerequisites and milestone contract

### M0 — behavior lock and minimum authoritative seam

Before H0 code begins:

1. Freeze static request/config fixtures and the Issue #62 observer scenario.
2. Lock the existing static payload, one 24 kHz Fish `bot_output`, mixed-input
   echo gate, greeting/turn/cancel/reconnect/exit/leave behavior, and absence of
   live-module initialization.
3. Review the exact optional playback-cancel callback below.
4. Prove it fires synchronously for every existing authoritative abort path
   without altering abort ordering or outcomes.
5. Freeze the observer capture method and the rule for deriving numeric gates
   after baseline characterization but before candidate results are revealed.

The M0 seam is justified because `onAudio(Buffer)` exposes PCM only. Silence,
missing chunks, `turnState` polling, and socket close cannot authoritatively
invalidate queued visual state.

The minimum additive contract is:

```text
onPlaybackCancelled({
  outputEpoch,   // monotonically increases for this handler
  reason,
  monotonicTime
})
```

- `outputEpoch` starts at zero and increments synchronously at each existing
  authoritative abort that may invalidate current/future local playback state.
- The optional observer callback is invoked at that authority boundary before a
  later PCM callback can be observed.
- The existing `onAudio(buffer)` signature and byte delivery remain unchanged.
- The transport tags copied visual data with the latest `outputEpoch`.
- Missing listeners are a no-op; listener exceptions are contained and cannot
  delay, suppress, or replace the abort.
- The event contains no transcript, prompt, user data, avatar policy, meeting
  secret, or remote-playout claim.
- It means **local output generation was invalidated**, not “participants can no
  longer hear audio.” H cannot retract bytes already handed to Attendee.

If a single emission-only event cannot cover every authoritative abort without
refactoring Agent Core, M0 stops and the issue returns to architecture review.

### H0 — hosted Hybrid coexistence and L0

H0 begins only after M0 passes. It must prove on the hosted target:

- one bot accepts both `websocket_settings.audio` and
  `voice_agent_settings.url`;
- the existing realtime WebSocket remains the sole meeting input and audible
  output owner;
- the visual page creates no `AudioContext`, `AudioWorklet`, audio/media element,
  oscillator, destination, microphone-to-output connection, or audio track;
- a synthetic, deterministic sample-indexed flash can be observed beside known
  PCM transients;
- page load, kill, reload, socket loss, capability expiry, reconnect, cancel,
  exit, and leave do not stop, replace, duplicate, delay, or replay realtime
  audio;
- the public page capability, CSP, cache, origin, replay, size/rate, and log
  redaction controls pass; and
- static behavior remains unchanged with the experiment absent and the live
  endpoint missing, invalid, or blackholed.

H0 failure closes the issue. It never enables Full-page A or L1.

### Conditional L1 — deterministic local frames

L1 becomes code-start-ready only after a named gate owner records the H0 pass and
links all retained artifacts. Before the first L1 file is added:

- the authoritative output-epoch seam remains green;
- H observer skew/drift is bounded by one frozen mapping;
- exactly one bot and one waveform are proven;
- baseline-derived audio, cancel, reconnect, resource, and security gates pass;
- the DSP calibration corpus and procedure are approved;
- the L1 visual floor is written before blinded review; and
- three synthetic/non-personal frames and their distribution rights/provenance
  are pinned.

No Caty likeness, Caty frame, Swift code, WebRig, or WebGL work is permitted.

## Frozen DSP geometry

The L1 analysis geometry is fixed before candidate measurement:

| Item | Frozen value/rule |
|---|---|
| Source format | Fish mono S16LE, 24,000 samples/s |
| Source coordinate | Monotonic sample index within `outputEpoch`; invariant to Fish/WebSocket rechunking |
| Window | 480 samples = 20 ms |
| Hop | 240 samples = 10 ms |
| Preprocessing | Convert `s16 / 32768`, remove each window's mean |
| Energy | `rms = sqrt(mean((x - mean(x))²))` |
| dBFS | `20 log10(max(rms, 1/32768))` |
| Network chunks | Never define a DSP window or presentation time |
| Renderer input | Timestamped source sample range, epoch, RMS/dBFS, and frozen normalized level |
| Mouth model | Deterministic closed/half/open amplitude state; no frequency, phoneme, viseme, AGC, lookahead, or randomness |
| Cancel | Bypasses smoothing, clears pending state, and closes before the next presented frame |

Normalization, closed/half/open thresholds, hysteresis, and attack/decay are
**not Caty constants**. They are numeric outputs of a versioned calibration
artifact generated from hashed current Fish Japanese speech, exact silence, and
exact comfort-noise fixtures. The artifact records sample rate, extractor
version, fixture hashes/labels, speech/noise distributions, thresholds,
smoothing values, and approver.

The calibration must demonstrate:

- comfort noise and silence never open the mouth;
- speech has sufficient measured separation from the non-speech distribution;
- the same PCM and epoch produce an identical envelope/frame trace;
- arbitrary chunk boundaries produce the same trace; and
- all numbers are frozen before candidate labels or subjective results are
  revealed.

Caty's 60 ms cadence, `-50...-10 dB`, `-35/-20 dB`, `0.2/0.7`, WebRig
attack/decay, random syllable/rest rules, and 80 ms lookback are reference
evidence only and are not copied.

## Exact metrics and acceptance records

### Source and transport

Record per run/turn/output epoch:

- PCM byte hash, source sample count, sample-range gaps/duplicates/reordering,
  clipping, and odd-byte carry;
- Fish callback and `bot_output` handoff timestamps;
- visual message send/arrival/drop/late/coalesce counts and queue age/depth;
- connection generation, output epoch, cancel reason, and stale-message reject
  counts.

Source/send timestamps are diagnostic predictors only. They are never labelled
audible presentation.

### Observer audio

From synchronized independent observer media, report:

- exactly one correlated audible waveform and one bot;
- missing, duplicated, repeated, clipped, and reordered regions;
- start-cut and mid-response-cut incidence, location, and duration;
- response-to-first-audible-sample p50/p95;
- cancel request to last audible sample p50/p95/max;
- level/noise change, comb-filter/echo evidence, and blind baseline comparison;
- duration drift against the source over each utterance and 30-minute run.

Duplicate bot/audio, a second correlated waveform, or stale audio replay has
zero tolerance.

### Observer A/V

Define signed skew as:

```text
visible observer transition time - audible observer transition time
```

Positive means video lags. For L0 transients/flashes and later L1
onsets/offsets, report:

- signed and absolute skew p50/p95/max;
- residual skew after at most one predeclared fixed offset;
- skew variance and drift slope in milliseconds/minute;
- onset and offset separately;
- discontinuities at utterance boundaries, cancel, reconnect, reload, and final
  drain;
- missed/extra transitions and false mouth openings;
- cancel request to last non-closed observer frame p50/p95/max.

No dynamic observer-following correction is allowed. If a single fixed mapping
cannot keep residual skew/drift inside the frozen gate, H fails as a lip-sync
carrier even if simultaneous settings coexist.

### Browser and host resources

Report:

- requested versus actually presented marker/frame timestamps;
- page FPS, p50/p95/p99 frame interval, long-frame count, hidden/throttled
  intervals, and dropped frames;
- visual queue/history maximum and slope;
- page reload/socket reconnect/auth failures and orphan timers/listeners/sockets;
- Mac mini CPU, memory slope, event-loop delay, and thermal state;
- 30-minute one-bot/one-waveform/resource results.

Unavailable remote-container metrics are recorded as `unknown`, never zero.

### How numeric gates are frozen

Zero-tolerance invariants are fixed now: no second bot/audio owner, no stale
old-epoch presentation, no credential leak, no static dependency, no unbounded
queue/retry, no Agent Core semantic change, and no L1 file before H0 approval.

All non-zero latency, skew, drift, audio-quality, cut-rate, frame, and resource
limits follow `04-comparison-poc-spec.md`: characterize the unchanged static
baseline, approve numeric limits, freeze them, and only then reveal candidate
results. This final vote does not invent unsupported millisecond or CPU
thresholds.

## E. Exact minimal file ceiling

The issue may touch at most these **16 named files**. Files 1–11 are the M0/H0
ceiling. Files 12–16 are forbidden until H0 approval.

### M0/H0 — maximum 11 files

1. `src/pipeline.js` — add only the optional, synchronous, emission-only
   `onPlaybackCancelled` event and output epoch.
2. `src/transport-meet/meet-routes.js` — select the explicit non-default H
   experiment, preserve the existing audio owner/send, augment the proven
   payload, forward PCM timing/cancel events, route the exact visual connection,
   and close it with existing lifecycle.
3. `src/transport-meet/local-avatar-session.js` — own one bounded H visual
   session, ephemeral capability, connection generation, output epoch,
   sample-index marker sequence, stale rejection, fail-closed behavior, and
   telemetry.
4. `src/ui-routes.js` — allowlist only the exact local-avatar HTML/JS and
   conditional approved frame paths.
5. `public/local-avatar/index.html` — fixed 1280×720 dependency-free canvas page
   with strict CSP and no audio-capable surface.
6. `public/local-avatar/local-avatar.js` — authenticate, clear the URL fragment,
   map source predictions to `performance.now()`, present L0 markers, reject
   stale state, fail closed, and expose deterministic test telemetry.
7. `test/playback-cancelled.test.js` — prove all authoritative abort paths emit
   exactly one ordered epoch event and listener behavior is semantic-neutral.
8. `test/local-avatar-session.test.js` — prove capability, bounds, source
   sequence, epochs, reconnect, late drop/coalesce, close, and no replay.
9. `test/local-avatar-page-contract.test.js` — prove audio-free page, CSP/cache
   contract, deterministic marker presentation, stale rejection, and closed
   failure state.
10. `test/local-avatar-static-regression.test.js` — lock exact default payload,
    PCM/input/lifecycle behavior, and zero live initialization.
11. `test/fixtures/local-avatar-timeline.json` — frozen transient PCM identity,
    source sample markers, expected trace, and observer correlation IDs.

`src/server.js`, `src/config.js`, Fish, Soniox, gateways, profiles, memory,
skills, tools, package manifests, README, and deployment files are outside the
ceiling.

### Conditional L1 — five additional files

12. `test/fixtures/local-avatar-calibration.json` — frozen calibration values,
    corpus hashes, extractor version, and approval metadata; it is an experiment
    artifact, not product config.
13. `public/local-avatar/assets/closed.png` — synthetic/non-personal closed frame.
14. `public/local-avatar/assets/half.png` — synthetic/non-personal half-open frame.
15. `public/local-avatar/assets/open.png` — synthetic/non-personal open frame.
16. `public/local-avatar/assets/PROVENANCE.md` — creator/source, hashes,
    transformation, public-display, redistribution/modification, and approval
    record.

L1 modifies the already allowed session/page/tests. It adds no renderer module,
blink asset, config surface, dependency, provider interface, registry, factory,
AudioWorklet, or fallback architecture.

## F. Hard pass and stop gates

### M0 pass

Pass only if:

- all existing static behavior locks pass;
- every authoritative abort path emits one ordered `outputEpoch` increment;
- listener absence/failure does not alter abort, PCM, turn, exit, or gateway
  behavior; and
- no renderer concept or dependency enters Agent Core.

Otherwise stop before H0.

### H0 pass

Pass only if:

- the hosted combined payload works with current input/output intact;
- the page is structurally and observably audio-free;
- exactly one bot, audio owner, and observer waveform exist;
- page/auth/socket failures are isolated from realtime audio;
- L0 observer skew/drift is complete, stable under one frozen offset, and within
  the baseline-derived gate;
- Issue #62 cut/dropout, response latency, cancel tail, reconnect, leave, and
  resource metrics are non-inferior under the frozen rules;
- output epochs, connection generations, queue bounds, and stale rejection pass;
- public-page security and static isolation pass; and
- the complete 30-minute artifact set exists.

Any missing observer media/timestamp is a failed gate, not zero or “looks good.”
Any second owner/waveform, stale replay, unbounded queue/retry, credential leak,
static regression, unstable A/V mapping, or manager coupling stops the issue.
H0 failure closes it without L1 or A.

### Conditional L1 pass

Pass only if:

- H0 remains green after L1 is added;
- the frozen 20/10 ms geometry and calibration reproduce identical traces across
  rechunking/repeats;
- silence/comfort noise never opens the mouth;
- cancel closes before the next presented frame and no old epoch reopens;
- observer onset/offset/skew/drift and cancel tails meet frozen gates;
- the predeclared blinded visual floor passes;
- synthetic frame provenance and public distribution rights are complete;
- audio, static, security, browser, and 30-minute resource metrics remain
  non-inferior.

Stop L1 on any carrier, clock, cancel, stale-state, false-opening, visual,
security, provenance, audio, or resource failure. The issue records the smallest
falsified assumption and does not widen scope.

## Five-line binding decision

1. Draft the issue now under the exact experiment title; drafting does not authorize code.
2. M0 may start only after its regression tests and emission-only output-epoch contract are reviewed.
3. H0 must prove hosted coexistence, a truly audio-free page, one owner/waveform, and observer-bounded A/V behavior.
4. L1 may start only after the recorded M0/H0/security/cancel pass and uses frozen 20/10 ms DSP plus synthetic frames.
5. H0 failure closes the issue; L2, Full-page A, WebGL, Caty art, LiveAvatar, Recall, and production rollout remain out.
