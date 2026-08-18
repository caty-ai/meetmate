# Round 3 — Local Renderer Final Vote

Date: 2026-07-23  
Role: local renderer / browser runtime  
Scope: final council decision only; no implementation

## Changed view from Round 2

In Round 2 I required an H0 issue to close before a separate L1 issue opened. I
now accept **one issue containing M0, H0, and conditional L1**.

The other Round 2 reviews establish that issue count is not the safety boundary.
A single issue is responsible when it is an experiment ledger with enforceable
source gates:

- creating the issue does not authorize code;
- M0/H0 and L1 are separate reviewed checkpoints;
- no L1 renderer, calibration, or asset file exists before an H0 pass artifact
  and named gate-owner approval;
- an M0 or H0 stop closes the issue successfully with evidence;
- failure never widens the issue to Full-page A, L2, WebGL, Caty art, or
  LiveAvatar.

This changes my process conclusion, not my technical conclusion. H remains
unproved hosted behavior, L1 remains conditional, and static remains the sole
production-qualified default.

## Final vote

| Decision | Vote | Binding interpretation |
|---|---|---|
| **A. Draft the experiment issue now** | **YES** | Issue creation records scope, prerequisites, gates, owners, and evidence locations; it authorizes no source edit. |
| **B. Use one issue for H0 → conditional L1** | **YES** | M0/H0 and L1 are separate checkpoints; L1 files/tasks stay locked until every H0 and prerequisite gate passes. |
| **C. Keep L2 out** | **YES** | No WebRig, rig asset, selector, fallback, WebGL code/test, dormant fixture, or L2 notice appears in this issue. |
| Full-page A fallback in this issue | **NO** | H failure closes the issue; A changes the audible owner and requires a new architecture decision. |
| Caty art in this issue | **NO** | L1 uses only newly created synthetic/non-personal frames with complete rights records. |
| LiveAvatar/Recall/provider abstraction | **NO** | No provider interface, renderer registry, SDK, factory, DI layer, or future-vendor configuration. |
| Code-start today | **NO** | Code starts only after the prerequisites in section D are recorded and approved. |
| Static remains the default | **YES** | The experiment is explicit, non-default, and never becomes an in-meeting fallback. |

## Exact issue title

> **Experiment: qualify Attendee Hybrid H with an audio-free L0 page, then conditionally add deterministic L1 frame lip sync**

“Experiment” and “conditionally” are required. The title must not say “ship,”
“integrate avatar,” “production,” or imply that hosted coexistence is already
known.

## D. Prerequisites before any code starts

The issue may be drafted immediately, but its first source edit is blocked until
all of the following are linked from the issue:

1. **Static baseline plan:** the frozen Issue #62 scenario, source and independent
   observer capture method, start/mid-cut measures, cancel/reconnect/leave cases,
   30-minute resource collection, and the process for freezing numeric gates
   before candidate results are revealed.
2. **M0 boundary decision:** a call-site map of every authoritative output
   start/abort path and an approved minimal additive event contract. If existing
   ordered metadata already proves the same facts, M0 adds tests only and does
   not edit `src/pipeline.js`.
3. **Hosted-test access:** a target Attendee sandbox, Google Meet observer,
   synchronized A/V capture, bot/page counting, cleanup authority, and an
   orphan-incident procedure.
4. **Public-page threat contract:** short-lived capability design, exact routes,
   CSP, `Cache-Control: no-store`, log/redaction rules, origin/session binding,
   size/rate/replay limits, and failure-closed behavior.
5. **Gate ownership:** named approvers for M0 semantic neutrality, H0 carrier
   evidence, security, and conditional L1 entry.
6. **L1 product question:** a predeclared blinded visual floor describing when a
   three-state illustrated avatar is useful rather than merely a fixture.

Frame art, calibration values, and L1 tasks are not code-start prerequisites
because they are forbidden until H0 passes. They are mandatory prerequisites for
the separate L1 checkpoint.

## M0 contract: behavior lock and minimum authoritative seam

M0 first locks current static payload, PCM output, input/echo gate, cancellation,
reconnect, exit, leave, and module non-loading behavior.

Only if those tests show that the current boundary cannot identify an output and
its authoritative invalidation may `src/pipeline.js` add this observer-only,
optional lifecycle callback:

```text
output_started({
  outputEpoch,
  sampleRate,
  monotonicTime
})

playback_cancelled({
  outputEpoch,
  reason,
  monotonicTime
})
```

The ordered existing `onAudio(Buffer)` callbacks belong to the current
`outputEpoch`; the visual session assigns continuous source sample indices. The
epoch increases at the existing output-generation authority before the first
PCM callback. `playback_cancelled` is emitted synchronously at every existing
authoritative abort before a later output can start.

This seam:

- contains no avatar policy, transcript, prompt, meeting credential, or renderer
  state;
- does not add or change an abort condition;
- is a no-op when no listener exists;
- contains listener failure so it cannot alter the abort;
- does not claim remote Attendee/Meet queue admission or playout;
- does not require a new event framework.

Natural drain does not fabricate a cancellation. L1 closes from its final
scheduled envelope/idle rule. If one complete emission-only seam cannot cover
all current abort paths without changing turn, TTS, gateway, or cancellation
semantics, **stop at M0**.

## E. Exact minimal file ceiling

The ceiling is **15 files total**, including existing files touched. A file not
listed here requires council review.

### M0 + H0: files 1–10

| # | File | Sole responsibility |
|---:|---|---|
| 1 | `src/pipeline.js` | Optional M0-only additive output-start/cancel observation; untouched if existing facts suffice. |
| 2 | `src/transport-meet/meet-routes.js` | Lazily select the exact non-default H experiment, preserve current realtime audio ownership, tee source timing, forward lifecycle facts, route the visual session, and close it with the existing meeting lifecycle. |
| 3 | `src/ui-routes.js` | Allowlist only the exact page/script and, after the L1 gate, exact frame/manifest paths. |
| 4 | `src/transport-meet/local-avatar-session.js` | Own one H visual session, capability validation, connection/output/cancel generations, sample/marker sequence, bounded visual queue, stale rejection, close, and telemetry. |
| 5 | `public/local-avatar/index.html` | Fixed 1280×720 dependency-free canvas/status page with strict CSP and no audio-capable element or graph. |
| 6 | `public/local-avatar/local-avatar.js` | Authenticate the visual socket, render L0 markers, map predicted source timing, reject stale state, idle on failure, and expose a narrow test-only diagnostic surface. |
| 7 | `test/local-avatar-session.test.js` | State, capability, bounds, lifecycle, cancel, reconnect, close, and validation tests. |
| 8 | `test/local-avatar-page-contract.test.js` | Deterministic presentation, true page silence, CSP/cache, stale-state, asset-failure, and browser telemetry tests. |
| 9 | `test/local-avatar-static-regression.test.js` | Golden static payload/PCM/lifecycle behavior and zero live-module initialization. |
| 10 | `test/fixtures/local-avatar-timeline.json` | Frozen transient, sample-index, output/cancel epoch, marker, and expected-presentation trace. |

`src/server.js` is not edited; existing route delegation is used. No new npm
dependency, configuration schema, recursive static server, service worker, CDN,
source map with secrets, or page audio path is allowed.

### Conditional L1: files 11–15

These files may be created only after the retained H0 pass artifact and approval
comment:

| # | File | Sole responsibility |
|---:|---|---|
| 11 | `src/transport-meet/local-avatar-calibration.json` | Frozen 24 kHz fixture hashes, extractor version, 20 ms window/10 ms hop, normalization, thresholds, hysteresis, and attack/decay selected before blinded L1 review. |
| 12 | `public/local-avatar/assets/closed.png` | Newly created synthetic/non-personal closed-mouth frame. |
| 13 | `public/local-avatar/assets/half.png` | Newly created synthetic/non-personal half-open frame. |
| 14 | `public/local-avatar/assets/open.png` | Newly created synthetic/non-personal open-mouth frame. |
| 15 | `public/local-avatar/assets/PROVENANCE.md` | Per-asset authorship, source, generation method, rights, hashes, transformations, approval, and likeness statement. |

L1 modifies files 2–10 as necessary but adds no renderer module. One concrete
`drawL1(level)` function in `local-avatar.js` replaces the marker draw. No blink
asset or random mouth alternative is needed for the first product question.

## Exact renderer contract

L1 is a deterministic three-state 2D renderer:

- input is the exact 24 kHz mono S16LE PCM copied beside the unchanged
  `realtime_audio.bot_output`;
- extraction uses continuous sample indices, mean-removed 20 ms RMS windows and
  10 ms hops across arbitrary callback boundaries;
- normalization, closed/half/open thresholds, hysteresis, and causal smoothing
  come only from the frozen calibration artifact;
- Caty's `-50...-10 dB`, `0.2/0.7`, 60 ms cadence, WebRig smoothing, and random
  rests/shapes are not defaults;
- network arrival time never drives a frame;
- H scheduling is explicitly a **predicted visual schedule**, not an audible
  playout clock, and synchronized observer media is the acceptance authority;
- cancel bypasses smoothing and presents closed immediately;
- queue overflow, expired presentation, missing/corrupt asset, auth failure, or
  protocol error forces closed and reports the failure; visual flow never
  backpressures realtime audio;
- identical PCM, calibration, lifecycle trace, and browser fixture produce the
  same frame trace. `Math.random()` cannot affect mouth state or timing.

No `AudioContext`, `AudioWorklet`, `<audio>`, oscillator, media destination,
audio track, or muted/zero-gain graph exists on the H page.

## Exact state contract

Every visual message that can affect presentation carries:

```text
{
  rendererSessionId,
  connectionGeneration,
  outputEpoch,
  cancelEpoch,
  firstSampleIndex,
  sampleCount,
  sampleRate,
  sourceMonotonicTime,
  levelOrMarker
}
```

Rules:

1. `connectionGeneration` increments on every authenticated page replacement;
   the prior socket and its messages become invalid.
2. `outputEpoch` comes from the authoritative output boundary and cannot be
   inferred from silence or mutable turn state.
3. `cancelEpoch` increments synchronously when the visual session receives
   `playback_cancelled`, clears queued state, and closes the renderer before later
   output is admitted.
4. `firstSampleIndex` is continuous within `outputEpoch` and invariant to PCM
   rechunking.
5. Page startup/reconnect begins closed and receives only a current snapshot, no
   historical PCM, marker, or envelope replay.
6. Old session, connection, output, or cancel identities are rejected before
   scheduling or drawing. A delayed old cancel cannot close a newer output.
7. The queue is duration-bounded. Overflow or excessive lateness closes rather
   than leaving a stale open mouth; it is a failed gate, never silent recovery.
8. Source/page clock mapping is diagnostic prediction only. H never claims
   Attendee queue admission, resampler position, WebRTC packetization, or remote
   playout acknowledgement.

## Exact public-page and asset-rights contract

The configured Voice Agent URL and all assets are assumed visible and
extractable by Attendee and outsiders.

- Use a random public `visualId` unrelated to meeting/user/gateway identifiers
  and a short-lived, narrowly scoped capability bound to visual session and
  generation.
- Assume Attendee may retain the entire configured URL, including fragments.
  The fragment is consumed once, removed with `history.replaceState`, never
  stored, logged, reported, used in asset URLs, or treated as a durable secret.
- Store only the capability hash; compare safely; enforce exact `Origin`,
  unauthenticated timeout, expiry, replay rejection, and strict message
  size/rate/history limits.
- Send no transcript, prompt, microphone audio, internal ID, meeting URL, Fish,
  gateway, or Attendee credential to the page.
- Serve exact allowlisted files with `Cache-Control: no-store` and restrictive
  CSP (`default-src 'none'`, only the exact same-origin resources and visual
  WebSocket required). No analytics, external font, CDN, directory listing,
  persistent storage, or service worker.
- L1 assets are newly authored synthetic/non-personal images. `PROVENANCE.md`
  records creator, generation method and inputs, ownership/license, public
  meeting/web display right, redistribution and modification right,
  source/destination SHA-256, transformations, approver/date, and an explicit
  “no real-person likeness” conclusion.
- Caty commits, PNGs, likeness, rig textures, WebRig code, LICENSE, and NOTICE
  are absent from this issue. A hash proves identity, not distribution rights.

Capability expiry or asset failure closes only the visual. It cannot affect
realtime audio, create a bot, invoke Agent Core, or select static/A in the same
meeting.

## F. Hard pass and stop gates

### M0 pass

- Frozen static fixtures prove byte/semantic-equivalent Attendee payload,
  identical one-time `bot_output` PCM/sample rate, unchanged mixed input/echo
  decisions, abort order, reconnect, exit grace, leave, and connection
  replacement.
- Static mode loads no live module, token, asset, timer, socket, or route state
  and passes with live host/assets absent or blackholed.
- Every authoritative output start/abort path emits the approved ordered facts
  exactly once, synchronously, with listener absence/failure behavior-neutral.
- No Agent Core, TTS, Fish, Soniox, gateway, prompt, memory, or turn-policy
  semantics change.

**Stop:** any missing abort path, reordered abort, new behavior, required
framework, or inability to contain the observer listener.

### H0 pass

- Hosted Attendee accepts simultaneous `websocket_settings.audio` and
  `voice_agent_settings.url`; one bot and both required managers remain healthy.
- Current realtime WebSocket remains the sole input/output and audible owner.
  The page has no audio graph/track; the observer detects exactly one waveform
  with no duplicate, comb filtering, echo, level/gating change, or non-waived
  Issue #62 cut regression.
- Page load, kill, reload, auth expiry, WebSocket loss, delayed/reordered data,
  and visual server failure cannot stop, replace, delay, duplicate, or replay
  realtime audio.
- Reconnect, cancel, exit, leave, failed cleanup, and server/page replacement
  leave no second bot, orphan socket/timer/page, or stale marker.
- Repeated start/middle/end transients and L0 markers have complete source,
  page-presentation, and synchronized observer timestamps. Signed/absolute
  p50/p95/max skew, variance, and 30-minute drift remain inside gates frozen from
  the baseline using at most one predeclared fixed offset.
- CPU, memory slope, event-loop delay, thermal state, page frame/long-task
  telemetry, queue age, retries, and 30-minute stability pass.
- Public capability, CSP/cache, log-redaction, origin, expiry, replay,
  oversized/rate-limit, and static-isolation tests pass.

**Stop:** hosted combination rejection/ambiguity; any second audio owner/bot;
unbounded or unobservable A/V relation; page/audio-manager coupling; stale replay;
credential leak; static dependency/regression; unbounded queue/retry/resource
growth; cleanup failure without a contained incident record. H0 failure closes
the issue—no A or L1 work begins.

### Conditional L1 entry and pass

Before L1 files exist:

- M0 and every H0 gate have retained artifacts and named approvals;
- calibration fixtures and numeric values are frozen before blinded results;
- the three synthetic frames and complete rights manifest are approved;
- the product visual floor, cancel bound, resource floor, and observer protocol
  are frozen.

L1 passes only when:

- zero/DC/noise/tone/clipped/odd-split/rechunked/Japanese fixtures produce exact,
  repeatable sample indices, envelopes, and closed/half/open traces;
- silence and comfort noise never open the mouth, and missing/corrupt assets fail
  closed;
- cancel at onset/middle/drain, rapid cancel/new output, reload, duplicate,
  reorder, lateness, and overflow never show an old-epoch or stale open frame;
- observer onset/offset/cancel skew, missed/extra transitions, blinded
  usefulness/distraction floor, FPS/long frames, 30-minute host/page resources,
  audio cuts, one-waveform, and one-bot gates pass;
- H0 and static results remain non-inferior with the renderer enabled.

**Stop:** post-result tuning, comfort-noise opening, nondeterministic mouth trace,
stale state, asset-rights gap, visual floor miss, resource/audio/lifecycle
regression, or any need for WebGL/L2/A/provider abstraction. A stopped L1 remains
an informative experiment; it does not widen scope.

## Five-line binding decision

1. **Draft one experiment issue now; drafting is not authorization to edit source.**
2. **After prerequisites, M0 may lock behavior and add only the proven-minimum authoritative output/cancel observation.**
3. **H0 must prove hosted Hybrid H, a truly audio-free page, one audible owner, observer-bounded timing, security, lifecycle, and static isolation.**
4. **Only an approved H0 pass unlocks deterministic L1 with three newly authored rights-cleared frames; Caty art, L2, WebGL, Full-page A, and LiveAvatar remain absent.**
5. **Any hard-gate failure closes the experiment with evidence; static remains the sole production-qualified default.**
