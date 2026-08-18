# Round 2 — Meeting Bot / Media Integration Architect

Date: 2026-07-23  
Scope: cross-review and adjudication only; no implementation

## Revised position

My Round 1 proposal put Hybrid H, L0, and L1 behind successive gates in one
issue. The other proposals expose two reasons to narrow that issue:

1. hosted Attendee coexistence is still a topology hypothesis, not an
   implementation detail; and
2. Meetmate's current `onAudio(Buffer)` callback does not carry the lifecycle
   identity needed to make mouth cancellation and reconnect rejection
   authoritative.

I therefore change my vote:

- **YES** to one H0 coexistence-probe issue;
- **NO** to a combined H → L0 → L1 implementation issue today;
- **NO** to including L2;
- **YES later** to a separate H + L1 issue only after H0 passes, the output
  lifecycle seam is explicit, and frame rights are cleared.

H0 may prove a deterministic transient-to-flash carrier and failure isolation.
It must not quietly grow frame assets, Caty rendering, WebGL, or Full-page A.

## Cross-review of the other Round 1 proposals

### Round 1-02 — Audio/DSP

**Strongest point.** The same-sample contract is the most rigorous proposal for
preventing network chunks from becoming animation timing:
`renderer_session_id`, `utterance_id`, `cancel_epoch`, source sample ranges, and
PCM hashes; 20 ms RMS windows with 10 ms hops; causal smoothing; and calibration
from frozen Fish fixtures. It correctly rejects copying Caty's `-50...-10 dB`
normalization and `0.2/0.7` thresholds as if they were portable facts. It also
states the essential limitation of H: the server can prove common source bytes,
but not remote playout time, so synchronized observer capture remains the
acceptance authority.

**Strongest objection.** Its proposed file set implements H, A, L0, L1, optional
L2, calibration, and an A-only AudioWorklet. That is not the smallest issue
while H is unproved. Including even a disabled L2 fixture creates WebGL,
licensing, and asset work before the carrier decision. The calibration contract
is appropriate for L1, but unnecessary for a coexistence-only H0 flash probe.

**Effect on my view.** Material. I withdraw my Round 1 suggestion of using Caty's
60 ms meter and fixed thresholds as the L1 production starting point. A later L1
must use chunk-invariant source-sample windows and frozen calibration. This does
not justify putting that DSP implementation into H0.

### Round 1-03 — Local renderer

**Strongest point.** It gives the clearest renderer comparison: L1 is a
deterministic diagnostic and visual fallback, while L2 is a two-pose,
WebGL/grid-warp visual upgrade whose value must be demonstrated separately.
Its proposed L2 failure containment—fall back visually without recreating the
page, bot, or audio path—is the right rule if L2 is ever authorized.

**Strongest objection.** Putting L1 and L2 in the same PoC still weakens causal
attribution and pulls a roughly 1.9 MB rig, WebGL context recovery, generated
assets, randomness controls, and MIT/provenance work into the first local
renderer issue. More importantly, an H page must not create a muted or
zero-gain audio graph merely to obtain a clock. Such a graph or captured audio
track makes “one audible owner” ambiguous, and its `AudioContext` would not be
the realtime-audio manager's meeting playout clock anyway.

**Effect on my view.** It confirms that L1 is the right first product renderer
and that a later L2 can reuse the same concrete state record without a provider
framework. It does not overcome the experimental-confounding argument for
separate issues.

### Round 1-04 — Module boundary / test contract

**Strongest point.** It identifies the actual blocking interface fact:
`meet-routes.js` receives Fish PCM, but the transport-visible handler boundary
has no authoritative output epoch/cancel notification. Its static contract is
also precise: default payload and one `bot_output` send remain unchanged; input,
echo gate, connection replacement, exit, and leave behavior are locked; and
static mode must not even initialize the live module.

**Strongest objection.** The proposed later L1 boundary says `pipeline.js` is out
of scope and requires another prerequisite to deliver cancel at the handler
API. That is a useful ownership constraint, but it leaves the end-to-end design
incomplete unless the separate LA-03 work is guaranteed. `turnState` polling or
audio inactivity cannot fill the gap. A later implementation issue must name
the exact observer-only lifecycle event it consumes, even if that event is
landed by a dependency.

**Effect on my view.** Decisive. My Round 1 wording made a pipeline cancel hook
optional; it is not optional for a real L1. Agent Core semantics can remain
unchanged, but the authoritative abort/end boundary must emit enough identity
for the visual consumer.

### Round 1-05 — Skeptic

**Strongest point.** It separates topology proof from renderer proof and shows
why one large gated issue is still an epic in practice. Its “truly silent”
definition is correct: no audio element, oscillator, `AudioContext`,
destination node, captured audio track, or vendor page audio. It also supplies
opposing evidence that hashes and commits do not establish rights: the Caty
mouth images were described as rescued from a previously untracked directory,
with no adjacent artist, consent, redistribution, or public-display grant.

**Strongest objection.** H0 still needs disciplined generation and reconnect
identity for its marker stream; “do not edit pipeline.js” cannot by itself prove
authoritative speech cancellation. The narrow probe should distinguish page
session cancellation—which it can own—from Agent Core utterance cancellation,
which it cannot claim to validate through the current callback.

**Effect on my view.** Decisive on issue shape. I now support an H0-only first
issue and separate L1 authorization. The provenance evidence independently
prevents importing the current Caty likeness frames into that first issue.

## Adjudication

### 1. One Issue H probe only versus gated H → L0 → L1

Choose **one H0 probe-only issue**.

It should perform the static baseline checks and then exercise one combined
hosted Attendee payload with:

- the unchanged `websocket_settings.audio` object;
- a `voice_agent_settings.url` that renders only deterministic flashes and
  diagnostics;
- no page audio capability;
- one transient/flash fixture for observable A/V mapping;
- page crash, reload, disconnect, meeting reconnect, cancel, exit, and leave
  injection.

The issue ends with a recorded H pass or fail. H failure must not select A.
Full-page A is a new architecture decision because it replaces the existing
audible path.

H0 proves carrier coexistence and page-session lifecycle isolation. For any
cancel test driven only by the current transport callback, the result must be
labelled non-authoritative for utterance cancellation. It may still prove that
page/session invalidation cannot replay stale markers or affect current audio.

### 2. Whether L2 belongs

**No.** L2 belongs in neither H0 nor the first L1 issue.

It earns a later issue only if:

- H and L1 pass their carrier, timing, cancel, reconnect, static, and 30-minute
  gates;
- a predeclared visual question says what L2 must improve;
- L1 does not already meet the product floor;
- Caty/WebRig code and generated-asset provenance are resolved;
- randomness is disabled or deterministically seeded for measurement;
- WebGL loss cannot revive stale state and has a closed-mouth fallback;
- CPU/GPU/thermal headroom passes on the target environment.

This is not a rejection of the renderer. It is rejection of an unearned
experimental variable.

### 3. Exact smallest module/file set

For the **H0 issue only**, the smallest boundary is:

| File | Sole responsibility |
|---|---|
| `src/transport-meet/live-avatar-probe.js` | Own one ephemeral H probe session, one-time page credential, connection generation, bounded marker/control delivery, stale-generation rejection, page telemetry, idempotent close, and exact H payload augmentation. It does not import Agent Core, Fish, Soniox, gateways, or profile logic. |
| `public/live-avatar-probe.html` | Fixed 1280×720 captured page with canvas/status only and no audio-capable element or graph. |
| `public/live-avatar-probe.js` | Authenticate the page socket, render deterministic source-indexed flashes, start idle after reload, reject stale generations, and report structured silence/render telemetry. |
| `test/live-avatar-probe.test.js` | Test payload augmentation, credentials, source sequence, bounds, generation invalidation, reconnect, close, and no replay. |
| `test/live-avatar-static-isolation.test.js` | Lock the default payload, single unchanged PCM send, input/echo path, connection/leave behavior, and zero live-probe initialization when the experiment is absent. |

Thin wiring belongs in:

- `src/transport-meet/meet-routes.js` for explicit experiment selection, the
  combined H payload, exact probe HTTP/WS dispatch, the marker tee, and closure
  with the existing meeting lifecycle.

No `server.js`, `pipeline.js`, `config.js`, TTS, Soniox, gateway, profile, memory,
or Agent Core change belongs in H0. The probe module can serve its two exact
public files through the route; it must not create a recursive static server.
No new dependency is justified.

A later **L1 issue** may extend the concrete session with a calibrated
sample-lineage envelope and add one L1 page script, approved frames, a provenance
manifest, and their focused tests. It should not introduce a `LiveAvatar`,
provider registry, renderer SDK, factory, or cross-repository package.

### 4. Hosted Attendee proof and one-audible-owner rule

The cited Attendee source commit is supportive but insufficient. Hosted proof
must use the deployed target environment and show:

1. one bot accepts both settings and both managers remain healthy;
2. meeting input/output continues through the current realtime-audio manager;
3. the page exposes no audio track or audio graph;
4. an independent observer records exactly one waveform, with no duplicate,
   comb-filtered, delayed, or level-shifted copy;
5. page load, crash, reload, and disconnect cannot stop, replace, replay, or
   delay current audio;
6. reconnect, exit, leave, and failed remote cleanup leave no second bot, page,
   socket, timer, or stale marker;
7. source transient/flash to observer A/V skew and drift stay within gates frozen
   from the baseline.

Google Meet is mandatory first. Zoom is not claimed without the same evidence.
Muting a second page graph is not evidence of one owner; the graph must not exist.

### 5. Static, cancel, and reconnect tests

**Static isolation**

- With the experiment absent, normalized launch payload equals today's static
  payload and contains no `voice_agent_settings`.
- `bot_output` is sent once with identical base64 PCM and sample rate.
- meeting input and the echo gate produce the same handler calls.
- connection replacement, `exit_requested`, leave, and delayed cleanup remain
  unchanged.
- the probe module, assets, token generation, timers, and sockets are not loaded
  or initialized.

**H0 page/session cancellation**

- cancel/close before first marker, mid-sequence, and at final drain;
- two rapid generations;
- late old-generation marker after cancel;
- lost or reordered marker;
- page socket loss and failed remote cleanup;
- immediate idle state, bounded queue cleared, no old marker replay, and no
  effect on realtime audio.

These tests must not be reported as proof of Agent Core utterance cancellation
until the lifecycle seam below exists.

**Reconnect and reload**

- reload during silence and during a marker sequence;
- reconnect to the same meeting after page loss;
- replacement of an existing page socket;
- credential reuse, expiry, and cross-session rejection;
- new generation starts idle and receives only a current snapshot, never
  history;
- old connections cannot draw, close, or mutate the new generation;
- timer/listener/socket counts return to zero after close.

The hosted test also needs synchronized observer media, bot/page counts, source
and presentation timestamps, audio gaps/cuts/duplicates, resource telemetry, and
a 30-minute run. Page console success alone is not acceptance evidence.

### 6. Does the current output callback expose enough utterance/cancel state?

**No.**

The current `createPipeline(..., onAudio)` callback exposes raw PCM buffers. It
does not expose:

- `utterance_id` or generation identity;
- output start and authoritative end;
- sample start/count across callbacks;
- cancel/abort epoch and reason;
- the instant at which the abort authority invalidates queued output;
- transport admission or remote playout acknowledgement.

`turnState.isAgentSpeaking` is mutable state, not an ordered media lifecycle
contract, and it describes local generation/send activity rather than observer
playout. Silence timeouts, chunk gaps, and WebSocket close inference are likewise
not valid substitutes.

Before L1, the handler boundary needs a minimal observer-only event from the
existing output authority, for example:

```text
output_start({ utteranceId, cancelEpoch, sampleRate })
output_audio({ utteranceId, cancelEpoch, sampleStart, sampleCount, bytes })
output_end({ utteranceId, cancelEpoch })
output_cancel({ utteranceId, cancelEpoch, reason })
```

The exact names are less important than atomic ordering at the existing
generation/abort authority. This must not move avatar policy into Agent Core or
change TTS, dialogue, turn ownership, or meeting-audio ownership. A prerequisite
change may expose the event; the later L1 issue consumes it.

H still cannot obtain authoritative remote playout time from this contract.
Observer capture remains mandatory for A/V skew, audio tail, and drift.

## Compromise proposal

The council can converge on three bounded decisions:

1. **Issue H0 now:** exact silent-page coexistence probe, static isolation,
   hosted one-waveform proof, deterministic transient/flash mapping, and
   page-session failure tests. No Caty assets, L1, L2, A, or pipeline change.
2. **Dependency before L1:** expose and test the minimal authoritative output
   lifecycle/epoch event; freeze DSP calibration and acceptance gates; select a
   synthetic or explicitly cleared frame set.
3. **Issue L1 only after H0 passes:** one H-specific session, one calibrated
   envelope, one deterministic frame renderer, and observer/static/lifecycle
   verification. H failure returns to a separately reviewed A decision. L2
   requires a later explicit product hypothesis.

## Preliminary vote

| Decision | Vote |
|---|---|
| File one H0 coexistence-probe issue | **YES** |
| File one combined H → L0 → L1 implementation issue now | **NO** |
| Treat current `onAudio(Buffer)` as sufficient for L1 cancel correctness | **NO** |
| Use Full-page A automatically if H fails | **NO** |
| Include L2 in H0 or the first L1 issue | **NO** |
| File a separate H + L1 issue after H0, lifecycle, calibration, and asset prerequisites pass | **YES** |

The opposing evidence changed my Round 1 vote. The smallest defensible next step
is the carrier probe, not the avatar renderer.
