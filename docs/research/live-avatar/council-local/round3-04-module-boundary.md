# Round 3 Final Vote — Module Boundary / Test Contract

Date: 2026-07-23  
Role: Module Boundary / Test Contract Architect  
Scope: final council vote and binding issue boundary; no implementation

## Changed view from Round 2

My Round 2 conclusion survives: one issue may hold H0 and a conditional L1 when
the gate controls when source files exist, not merely when a checkbox changes.
The other Round 2 reviews change three details.

First, the previous **10 + 6** ceiling was still too large. The common compromise
excludes Caty art, so L1 does not need four imported PNGs, a Caty provenance file,
or a separate runtime calibration JSON. The existing H0 canvas can draw an
original synthetic closed/half/open face, and the frozen fixture can record the
approved experimental calibration. Conditional L1 therefore adds **zero new
files**.

Second, the output seam must be smaller than a general utterance lifecycle API.
For this experiment, the minimum is the existing `onAudio(Buffer)` ordering plus
one synchronous `playback_cancelled` event carrying the newly authoritative
output epoch. It does not require `output_start`, `output_end`, provider metadata,
or an avatar protocol inside the pipeline.

Third, the URL-fragment capability is visible to Attendee's control plane even
though it is absent from the browser's HTTP request. It must be short-lived,
single-use, audience-bound, cleared before telemetry, and treated as provider-
visible. Same-page socket reconnect may use a separately issued in-memory ticket;
a full page reload starts closed and may fail visual-only rather than reusing
history or a durable credential.

I therefore change from “ten files before H0 plus six afterward” to **ten files
maximum for the entire issue**.

## Final YES/NO table

| Decision | Final vote | Binding interpretation |
|---|---|---|
| **A. Draft the experiment issue now** | **YES** | Issue creation is a coordination decision, not code authorization. |
| **B. Keep H0 and conditional L1 in one issue** | **YES** | M0 and H0 execute first; L1 edits are locked until a retained H0 approval artifact exists. |
| **C. Keep L2 out** | **YES** | No WebGL, WebRig, renderer selector, dormant fixture, L1 fallback design, license package, or L2 asset. |
| **D. Make the listed prerequisites binding before code-start** | **YES** | Failure to satisfy them leaves the issue drafted but blocked. |
| **E. Enforce the exact ten-file ceiling** | **YES** | L1 reuses and edits the H0 files; it creates no eleventh file. |
| **F. Enforce the hard pass/stop gates** | **YES** | A failed gate closes the experiment with evidence; scope may not widen to Full-page A or another renderer. |

Full-page A fallback, Caty art, LiveAvatar, Recall, production rollout, and a
second audible owner receive an implicit and explicit **NO** in this issue.

## Exact issue title

> **Experiment: prove Attendee Hybrid H, then gate deterministic L1 frame lip-sync**

The issue description must call static the only production-qualified/default
path and must state that an H0 rejection is a successful experimental outcome.

## D. Binding prerequisites before any code starts

1. The unchanged Issue #62/static baseline run, observer capture, fixture hashes,
   and numeric/non-numeric acceptance procedure are recorded. Start/mid-response
   cut incidence is not hidden inside a permissive average.
2. The target hosted Attendee sandbox, public HTTPS origin, deployed API version,
   Google Meet test account, remote observer, synchronized capture method, and
   named gate approver are available.
3. The issue records that Attendee OSS commit `ba74253...` supports independent
   manager construction but does not prove hosted coexistence.
4. The static source/payload golden fixtures and current cancel-path regression
   cases are approved before `meet-routes.js` or `pipeline.js` changes.
5. The M0 seam audit names every authoritative `currentAbort.abort()` path and
   demonstrates why mutable `turnState`, silence timeout, chunk gap, and socket
   close are insufficient substitutes.
6. Public-page controls are specified: exact allowlist, no-store, strict CSP,
   capability expiry/audience, single-use bootstrap, constant-time comparison,
   origin check, input size/rate bounds, log redaction, and visual-only failure.
7. H0 numerical gates are frozen before candidate results are revealed: one
   waveform/bot, audio continuity and cut non-inferiority, marker/audio skew and
   drift, cancel/reconnect bounds, resource slope, and 30-minute stability.
8. The L1 product question and visual floor are written but remain locked. L1
   uses an original synthetic geometric face rendered by the existing canvas;
   no Caty image, likeness, runtime, or derived asset is eligible.

These prerequisites permit M0 to start. They do not pre-approve H or L1.

## E. Exact minimal file ceiling: ten total

### New runtime/page files

1. `src/transport-meet/local-avatar-session.js`  
   Owns one H visual session: visual ID, capability/ticket validation, connection
   generation, authoritative output epoch received from the handler, source
   sample/marker sequence, bounded visual queue, clock mapping, stale rejection,
   telemetry, and idempotent close.

2. `public/local-avatar/index.html`  
   Declares the fixed 1280×720 canvas/status page, external same-origin script,
   strict CSP-compatible structure, and no audio/media element.

3. `public/local-avatar/local-avatar.js`  
   Authenticates the visual socket, removes the fragment, presents H0 markers on
   the predicted source timeline, starts/fails closed, reports presentation
   telemetry, and—only after H0 approval—draws the original deterministic L1
   closed/half/open canvas states.

### Existing files with thin edits

4. `src/transport-meet/meet-routes.js`  
   Recognizes only the explicit experiment value, lazily constructs the visual
   session, augments the H payload, copies timing beside the unchanged realtime
   audio send, forwards the epoch event, routes the exact visual WebSocket path,
   and closes visual state with the existing meeting lifecycle.

5. `src/ui-routes.js`  
   Adds only the exact HTML/JS allowlist entries with `Cache-Control: no-store`;
   no recursive public directory, listing, CDN, or source map.

6. `src/pipeline.js`  
   After the M0 audit justifies it, adds only a synchronous
   `playback_cancelled({ outputEpoch, reason, monotonicMs })` handler event at
   every existing authoritative output abort. The epoch increases before any
   newer output can be admitted. No listener means current behavior.

### Tests and one shared fixture

7. `test/local-avatar-session.test.js`  
   Locks auth, protocol bounds, queue behavior, source sequence, output epoch,
   reconnect replacement, stale rejection, and close behavior.

8. `test/local-avatar-page-contract.test.js`  
   Locks page silence, CSP/cache expectations, fragment clearing, marker/L1
   traces, predicted-versus-presented timestamps, cancel idle, reconnect, and the
   narrow test-only browser diagnostic surface.

9. `test/local-avatar-static-regression.test.js`  
   Locks the static source range, serialized payload bytes, single PCM send,
   input/echo behavior, all cancel paths, reconnect/exit/leave, and zero live
   initialization.

10. `test/fixtures/local-avatar-timeline.json`  
    Holds the frozen transient/sample-index marker trace and, after H0 approval,
    the hashed L1 calibration inputs/parameters and expected synthetic frame
    trace.

### Why no additional L1 files are needed

Conditional L1 edits files 1, 3, 7, 8, and 10 only:

- RMS/window carry and calibrated level generation stay in the already concrete
  H session module;
- the already present canvas draws three original geometric mouth states;
- the shared fixture records calibration and expected trace;
- no runtime config schema, PNG, SVG, provenance package, renderer module,
  provider interface, or asset route is added.

`src/server.js` is not touched because it already delegates HTTP/WS traffic.
`src/config.js`, Fish, Soniox, gateways, profiles, memory, skills, tools, and
Agent Core decisions are not touched. No dependency is added.

## Minimum output-epoch contract

The initial output epoch is `0`. At an authoritative abort, the pipeline:

1. performs the existing abort operation in its existing order;
2. synchronously increments the opaque `outputEpoch`;
3. emits `playback_cancelled` before control can admit a newer response;
4. contains listener exceptions so they cannot change abort behavior.

The current `onAudio(Buffer)` signature remains unchanged. JavaScript's
synchronous event ordering lets `meet-routes.js` assign every later copied PCM
sample to the current epoch without putting visual metadata into the audio
callback. Existing Fish abort-signal checks must still suppress late cancelled
chunks.

The event is transport-observable playback control, not renderer policy. It
contains no text, utterance content, gateway state, meeting credential, visual
session ID, or provider concept. `local-avatar-session.js`, not the pipeline,
owns connection generation, sample indices, marker/envelope history, and
presentation state.

M0 stops if tests reveal an abort path that cannot obey this ordering without
changing turn, TTS, gateway, exit, or cancellation semantics.

## Route, auth, state, and dependency contract

### Selection and routes

- Default: current `POST /join-meeting`.
- Explicit H0: exact form value `avatarExperiment=hybrid-local-l0`.
- Post-gate L1: exact value `avatarExperiment=hybrid-local-l1`.
- Public files: `GET /local-avatar/index.html` and
  `GET /local-avatar/local-avatar.js`.
- Visual socket: `WS /local-avatar/ws`.
- Every other `/local-avatar/*` request is 404.
- Unknown experiment values fail before bot creation; they never select static.

The existing static `botPayload` literal remains source-identical. H adds
`voice_agent_settings.url` only in the explicit branch while preserving the
existing `websocket_settings.audio` object as the sole meeting input/output.

### Authentication

The launch URL is:

```text
https://host/local-avatar/index.html?v=<random visualId>#cap=<single-use bootstrap>
```

The capability is 256 random bits, short-lived, audience-bound to `visualId`,
stored hashed, and visible to Attendee but not reusable outside this visual
session. JS clears the fragment with `history.replaceState` before logging,
telemetry, or error handling, then supplies it in the first bounded WebSocket
message. The server checks exact same-origin `Origin`, expiry, audience, replay,
message size/rate, and constant-time hash equality before sending state.

Successful bootstrap may return one short-lived, connection-family-bound
reconnect ticket held only in page memory. It supports same-page socket loss.
Neither token uses query strings, local/session storage, cookies, source maps,
asset URLs, or logs.

A full document reload loses the in-memory ticket and starts closed. Reuse of the
single-use bootstrap fails closed; it may not replay state or affect realtime
audio. H0 records whether this visual availability is operationally acceptable.

### State

Server:

```text
CREATED -> AUTHENTICATED -> READY -> CLOSED
```

Page:

```text
CONNECTING -> IDLE <-> PRESENTING -> CLOSED
```

Every authenticated socket replacement increments `connectionGeneration`.
Every `playback_cancelled` supplies a greater `outputEpoch`. Lower generation or
epoch messages are rejected before scheduling/drawing. Disconnect, expiry,
protocol error, cancel, or queue overflow immediately clears pending visual state
and presents closed/idle.

The visual queue is duration-bounded. It never backpressures Fish, Agent Core,
Soniox, or `realtime_audio.bot_output`. Overflow is a failed visual run, not a
reason to replay late state.

### Dependency direction

```text
pipeline playback_cancelled + existing onAudio
                    |
                    v
meet-routes.js -> local-avatar-session.js -> visual WebSocket
       |
       +----------> existing Attendee realtime audio (sole owner)

index.html -> local-avatar.js -> canvas
```

No arrow points from pipeline/core/gateway/audio modules toward local-avatar
code. Static does not require or initialize the local module.

## Static source and payload regression

M0 must prove both:

1. a guarded hash/source snapshot of the current static `botPayload` literal and
   nested `websocket_settings.audio` construction is unchanged; and
2. with nondeterministic identifiers injected as fixed fixtures, the exact UTF-8
   serialized Attendee payload bytes equal the pre-change golden bytes.

It additionally asserts:

- `voice_agent_settings` is absent, not null;
- optional `bot_image` bytes/presence are unchanged;
- `realtime_audio.bot_output` trigger, base64 PCM, sample rate, count, and order
  are unchanged;
- 16 kHz mixed input, echo gate decisions, handler sends, 24 kHz Fish defaults,
  connection replacement, greeting, barge-in/cancel, exit grace, stored-bot
  leave, and cleanup are unchanged;
- missing/invalid/blackholed live settings and assets cannot affect static;
- module-load and resource sentinels show no live require, capability, timer,
  socket, page read, or network call;
- a failed experiment does not launch static in the same meeting.

## F. Hard pass/stop gates

### M0 pass

- all static source/payload/lifecycle tests pass before and after the seam;
- every authoritative abort emits exactly one increasing epoch event;
- listener absence/failure changes no current behavior or timing gate;
- no output after a cancel is mislabeled with the old epoch;
- the seam introduces no avatar/provider import or policy.

**Stop:** any semantic regression, incomplete abort coverage, duplicate/missing
epoch, late old-epoch PCM, or need for cancel refactoring stops before H0.

### H0 pass

- the hosted target accepts simultaneous `websocket_settings.audio` and
  `voice_agent_settings.url` and keeps both managers healthy;
- the page contains no `AudioContext`, AudioWorklet, media element, oscillator,
  destination, audio track, or microphone-to-output path;
- the independent observer records exactly one bot and one waveform, with no new
  duplicate, comb filtering, level/gating shift, or non-waived cut regression;
- page load, auth failure, socket loss, kill, and reload do not stop, delay,
  replace, duplicate, or replay realtime input/output;
- repeated start/middle/end transients and markers yield observable p50/p95/max
  signed/absolute skew and bounded drift under one predeclared fixed mapping;
- cancel, rapid next response, realtime reconnect, visual reconnect, exit, leave,
  and failed cleanup produce no stale marker, second bot, orphan resource, or
  static fallback;
- CSP, no-store, fragment clearing, expiry, replay, wrong-origin,
  oversized/rate-limited input, and redaction checks pass;
- the frozen 30-minute Google Meet run passes CPU, memory, event-loop, thermal,
  page presentation, queue, reconnect, and observer gates;
- static regression remains clean.

**Stop:** failure of any item rejects H for this issue. Close with evidence. Do
not add L1, A, L2, Caty art, or another carrier.

### Conditional L1 pass

- only after an explicit retained H0 approval, edits remain inside files
  1/3/7/8/10;
- the approved short-window RMS geometry and calibration are frozen from hashed
  silence, comfort-noise, tone, and Japanese Fish fixtures before blinded review;
- arbitrary rechunking and odd-byte boundaries produce the identical
  source-sample envelope and closed/half/open trace;
- silence/comfort noise never opens the mouth; cancel bypasses smoothing and
  closes before the next presented frame; late old epochs never reopen;
- delayed/batched visual delivery, hidden page, socket reconnect, and queue
  overflow fail closed without burst replay or audio impact;
- the original geometric canvas face meets the predeclared blinded speaking,
  timing, identity, distraction, and visual-acceptability floor;
- H0 audio, one-owner, static, lifecycle, resource, and 30-minute results remain
  non-inferior.

**Stop:** any failed L1 gate closes the issue without L2, imported art, provider
work, or production adoption.

## Five-line binding decision

1. Draft one experiment issue now; drafting does not authorize code.
2. Start M0 only after the binding baseline, seam, hosted-test, observer, and security prerequisites are recorded.
3. H0 must prove hosted Hybrid H, a truly audio-free page, one audible owner, bounded observer A/V behavior, and static/lifecycle isolation.
4. L1 may edit only the existing ten-file set after recorded H0 approval; Full-page A, L2, WebGL, Caty art, and LiveAvatar remain out.
5. Any hard-gate failure closes the experiment with evidence while static remains the sole production-qualified default.
