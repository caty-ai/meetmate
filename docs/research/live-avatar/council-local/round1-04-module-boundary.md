# Round 1 — Module Boundary / Test Contract Architect

Date: 2026-07-23  
Role: module boundary and test-contract architecture  
Scope: proposal only; no production implementation

## Verdict

**Vote: NO, not ready to file the L1 implementation issue today.**

L1 is the smallest renderer that can produce useful product evidence, but two
architecture facts are still unresolved:

1. the hosted Attendee runtime has not proved that
   `websocket_settings.audio` and `voice_agent_settings.url` can coexist with
   exactly one audible owner; and
2. the current `createPipeline(..., onAudio)` boundary exposes PCM chunks but no
   transport-visible output epoch/cancel event. A browser can therefore stop on
   disconnect, but cannot prove immediate queue invalidation for every current
   barge-in/wake-cancel path without polling `turnState` or modifying Agent Core.

Those are not renderer details. They select the media topology and define whether
cancel can be correct. The implementation issue becomes ready only after LA-04
records an explicit **Hybrid H pass** or a separately reviewed **Full-page A
decision**, and LA-03 supplies the cancel-epoch contract at the existing handler
boundary.

If H passes, the first implementation issue should contain **H + L1 only**. If H
fails, do not put an A fallback in that issue: A changes meeting-audio ownership
and needs a new boundary review.

## Boundary facts from the current code

- `src/transport-meet/meet-routes.js:1206-1219` is the static launch contract:
  `websocket_settings.audio` is the meeting input/output carrier and `bot_image`
  is optional.
- `src/transport-meet/meet-routes.js:1319-1329` is the only current Fish PCM
  transport sink. It wraps the existing 24 kHz PCM once as
  `realtime_audio.bot_output`.
- `src/transport-meet/meet-routes.js:1376-1404` is the only current meeting-input
  path and retains the existing echo gate before `handler.send(audio)`.
- `src/pipeline.js:2207-2227` already has the right data seam: one Fish generation
  calls `onAudio(chunk)`. The local avatar must observe or copy those bytes, never
  request Fish again.
- `src/server.js` already sends HTTP and WebSocket traffic to `meet-routes`; it
  needs no live-avatar edit.
- `src/ui-routes.js` serves an allowlisted set of public files. It should not
  become a recursive general-purpose static server.
- Caty's useful interface is behavioral, not architectural: 60 ms audio-power
  sampling and discrete frame thresholds in `CatyController.swift:2429-2513`
  and `FrameAvatarView.swift:34-63`; timestamped interpolation and local
  animation in `webrig/index.html`; MIT attribution in `webrig/NOTICE.md`.

## Topology decision: Hybrid H versus Full-page A

### Preferred experiment: Hybrid H

H keeps `websocket_settings.audio` as the sole meeting input and audible output,
and adds a `voice_agent_settings.url` page which emits video but no audio.

This is the smaller product-risk boundary because the current Soniox input, Fish
output, echo gate, 24 kHz payload, connection replacement, and leave behavior stay
on their present path. The same `onAudio` bytes may be copied into a timestamped
visual-envelope stream; the copy is not a second Fish generation or audible sink.

The Attendee open-source commit cited by the evidence pack independently constructs
the realtime WebSocket manager and webpage streamer and shows no visible
mutual-exclusion validation. That is useful source evidence, but it is **not** a
hosted API guarantee and it is not a combined-mode test.

H is eligible only when L0 proves all of the following:

- the hosted bot accepts both settings in one payload;
- the webpage publishes no audible samples and the observer records exactly one
  waveform;
- page load, reload, crash, and disconnect do not stop, replace, duplicate, delay,
  or replay realtime audio;
- only the realtime-audio manager owns meeting input/output;
- visual timing can be calibrated against observer audio without unbounded drift;
- current cancel, reconnect, and leave behavior remains safe.

For H, there is no honest “browser audio playback clock”: audio is played by the
separate realtime-audio manager. The page must schedule visual envelopes against a
monotonic **source-sample clock** (`startMonoMs + sampleIndex / 24000`) and LA-04
must measure the fixed mapping to observer audio. It must not run muted PCM through
an `AudioContext` merely to obtain a clock; a captured silent track is still a
second audio path and invalidates the H proof.

### Contingency: Full-page A

A makes the Voice Agent page own meeting microphone input, Fish playback, captured
audio, and video. It can tie RMS to the actual `AudioWorkletProcessor` render
sample position, but it replaces the current proven audio carrier and adds browser
autoplay, resampling, queueing, and capture failure modes.

If H fails, A is not a hidden runtime fallback or a boolean branch in the H issue.
It requires a new decision and its own implementation issue. That issue must name
the page as the one meeting-audio owner and remove
`websocket_settings.audio` from that experiment payload; both must never be active
as audible owners.

## Smallest H + L1 file boundary

No generic provider, renderer registry, factory, DI container, lifecycle framework,
or cross-repository package is proposed.

| File | One responsibility |
|---|---|
| `src/transport-meet/local-avatar-session.js` | Own one H experiment's authenticated page connection, PCM carry/RMS calculation, monotonic source-sample/envelope sequence, cancel epoch, bounded send queue, reconnect invalidation, and telemetry; it receives callbacks/data and does not import pipeline, gateways, Soniox, Fish, profiles, or Attendee clients. |
| `public/live-avatar/index.html` | Declare the fixed 1280×720 captured page, one canvas/image surface, status marker, and the local script; it contains no audio element. |
| `public/live-avatar/live-avatar.js` | Own page WebSocket state, source-sample-clock scheduling, stale-epoch rejection, frame selection, blink, reconnect behavior, page-visible diagnostics, and a deterministic browser-test API. |
| `public/live-avatar/frames/idle.png` | Closed-mouth base frame. |
| `public/live-avatar/frames/talk1.png` | Low-energy mouth frame. |
| `public/live-avatar/frames/talk2.png` | Primary high-energy mouth frame. |
| `public/live-avatar/frames/talk3.png` | Alternate high-energy mouth frame used at a frozen cadence. |
| `public/live-avatar/frames/blink.png` | Idle blink frame. |
| `public/live-avatar/frames/talk-blink.png` | Speaking blink frame. |
| `public/live-avatar/NOTICE.md` | Record Caty source commit/path, copied/adapted asset hashes, transformation commands, authors, and applicable license notices. |
| `test/local-avatar-session.test.js` | Lock RMS carry, clock/sequence/epoch, authentication, bounds, reconnect, and idempotent-close behavior with `node:test`. |
| `test/meet-live-avatar-static-regression.test.js` | Lock default payload, module non-loading, PCM send, input gate, connection, and leave behavior before live wiring changes. |
| `test/fixtures/live-avatar-envelope.json` | Hold the frozen deterministic sample-index/envelope/frame trace used by Node and actual-browser checks. |

`listen.png` and `icon.png` are not runtime dependencies for the first L1 issue.
Adding them would introduce semantic state not supplied by the renderer boundary.

There is deliberately no `renderer.js` interface. `live-avatar.js` calls one
L1-specific `drawFrame(level, blinking)` function. L2 may replace that function in
a later diff after the gate; it does not justify a plugin surface now.

### Thin edits to existing files

Only these existing files may require edits in the H + L1 issue:

1. `src/transport-meet/meet-routes.js`
   - accept an explicit non-default experiment value on `/join-meeting`;
   - build the already-proven combined H payload only after the H gate;
   - preserve the existing `websocket_settings.audio` object byte-for-byte;
   - add the `voice_agent_settings.url` field for H;
   - route only the exact live-page WebSocket path to
     `local-avatar-session.js`;
   - copy each existing `onAudio(buffer)` chunk to the visual session **after**
     retaining the current `realtime_audio.bot_output` send;
   - forward the prerequisite handler-level output/cancel epoch event;
   - close the visual session when the current primary meeting connection or
     lifecycle closes.
2. `src/ui-routes.js`
   - add exact HTTP allowlist entries for the HTML, JS, NOTICE, and fixed frame
     files;
     do not add directory traversal or a catch-all static route.

`src/server.js`, `src/pipeline.js`, `src/tts-fish.js`, `src/config.js`, all
gateway modules, memory, tools, profiles, and Soniox code are outside the L1 issue.
If LA-03 cannot expose cancel at the existing handler API without making L1 edit
`pipeline.js`, this council must reconvene rather than waive the boundary.

### Dependency direction

```text
meet-routes.js
  ├── existing createHandler / Attendee realtime audio (unchanged owner)
  └── local-avatar-session.js
          └── authenticated envelope/control WebSocket
                  └── public/live-avatar/live-avatar.js
                        └── fixed frame PNGs
```

Allowed dependencies point outward from `meet-routes.js` toward the visual edge.
The visual edge must not import or call Agent Core, gateways, Soniox, Fish, profile,
memory, tools, or the Attendee bot client. Static mode must not construct a local
avatar session, timer, socket, token, asset read, or browser URL.

## Ownership and wire contract

### Ownership table

| Concern | Sole owner in H + L1 |
|---|---|
| Meeting microphone input | existing Attendee realtime-audio WebSocket path |
| Soniox feed and echo gate | existing `meet-routes.js`/pipeline behavior |
| Fish generation | existing pipeline/Fish path |
| Audible meeting output | existing `realtime_audio.bot_output` path |
| Visual source-sample sequence | `local-avatar-session.js` |
| Visual send queue | `local-avatar-session.js`, bounded and drop-new-on-overflow |
| Envelope math | pure helpers in `local-avatar-session.js`, applied to the same copied PCM samples |
| Envelope playback schedule | `live-avatar.js`, by source sample index and mapped monotonic clock |
| Cancel epoch | Agent Core remains authority; LA-03 handler event transports it; local session stamps it; browser enforces it |
| Canvas/frame state | `live-avatar.js` |
| Frame assets and provenance | `public/live-avatar/frames/` plus `NOTICE.md` |

The visual queue is not an audio queue in H. It carries compact energy windows and
sample positions only. It must be bounded by duration, not merely message count.
Overflow drops unsent newest visual windows and reports loss; it may not back up
the existing audible path.

### Minimal server-to-page messages

The protocol is local-avatar-specific and version `1`; it is not a future provider
protocol.

```json
{"type":"clock_echo","v":1,"nonce":17,"serverMonoMs":12290.2}
{"type":"start","v":1,"session":"opaque","connection":3,"epoch":8,"sampleRate":24000,"originSample":0,"originServerMonoMs":12345.6}
{"type":"envelope","v":1,"connection":3,"epoch":8,"firstSample":1440,"windowSamples":1440,"values":[0.04,0.32,0.81]}
{"type":"cancel","v":1,"connection":3,"epoch":9,"atMonoMs":12440.1,"reason":"barge_in"}
{"type":"stop","v":1,"connection":3,"epoch":10,"reason":"meeting_close"}
```

- `connection` increases on every accepted page connection. Messages from an older
  connection are invalid.
- `epoch` increases at start/cancel/stop boundaries supplied by the handler
  contract. The page clears pending windows and draws `idle` before accepting a
  newer epoch; lower epochs are always dropped.
- `firstSample` is a continuous index within the epoch and values cover fixed
  sample windows. Arrival time never becomes presentation time.
- The page periodically sends a nonce and its monotonic send time; `clock_echo`
  lets it estimate the server/page monotonic offset from the round-trip midpoint.
  `originServerMonoMs` is therefore mapped into the page clock. Offset uncertainty
  and observer A/V skew are telemetry and gates, not hidden constants.
- No transcript, prompt, text, user ID, memory, tool state, agent reasoning, or
  meeting microphone audio is sent to the visual page.
- The page returns only `ready`, `stats`, and `protocol_error`; it cannot send
  meeting audio or Agent Core commands.
- The launch URL carries the one-time page credential in the URL fragment, which
  is not sent in the HTTP request; page JS consumes and clears the fragment before
  opening the authenticated WebSocket. The session ID is opaque but is not treated
  as the credential.

### RMS/envelope rule

For every fixed window from the exact Fish PCM copied at the existing `onAudio`
boundary:

1. decode signed little-endian 16-bit samples;
2. compute `rms = sqrt(sum(sample²) / n) / 32768`;
3. compute `db = 20 * log10(max(rms, epsilon))`;
4. map `-50...-10 dB` linearly and clamp to `0...1`;
5. apply only the Caty frame thresholds: `idle` below `0.2`, `talk1` from `0.2`
   through below `0.7`, then `talk2`/`talk3` at or above `0.7`, alternating only
   at one frozen cadence.

The sender preserves sample indices across arbitrary Fish chunk boundaries, so a
window is never reset merely because a WebSocket chunk ended. The browser uses
bounded attack/decay only if its constants are frozen before subjective results.
Dominant frequency and phoneme inference are out of scope.

H schedules these values against the calibrated source-sample clock. For A, the
same calculation belongs inside the AudioWorklet render path and is reported with
the processor's played-sample index; doing it on WebSocket receipt is forbidden.

## Static regression contract

Before the first live edit, lock the following as tests:

- the default `/join-meeting` form produces the current payload with
  `meeting_url`, `bot_name`, `websocket_settings.audio.url`,
  `websocket_settings.audio.sample_rate`, and optional `bot_image`;
- default/static payload has no `voice_agent_settings`;
- static mode works with all live-avatar settings and assets absent;
- default HTTP/WS routes do not load `local-avatar-session.js`;
- static `onAudio` sends exactly one `realtime_audio.bot_output` containing the
  same base64 bytes and `TTS_SAMPLE_RATE`;
- static `realtime_audio.mixed` continues through the same echo-gate decisions and
  `handler.send` count;
- primary connection replacement, close, `exit_requested`, bot leave, and
  three-second exit behavior remain unchanged;
- 16 kHz Soniox input and 24 kHz Fish S16LE mono defaults are unchanged.

A snapshot must compare normalized JSON objects, plus explicit absence assertions;
it must not bless incidental key ordering or secrets. A module-load sentinel or
cache inspection must prove zero live-module initialization in static mode.

## Mandatory test contract

### Unit tests

- PCM extremes, silence, odd-byte carry, and chunk-boundary independence produce
  deterministic RMS values and sample indices.
- `-50`, `-10`, `0.2`, and `0.7` boundary values select the declared frame.
- sequence duplicate, gap, reorder, and overflow counters are exact.
- new `connection` or `epoch` synchronously clears queued states; an older message
  can never reopen the mouth.
- tokens are scoped to one opaque session, compared safely, expire, and never
  appear in logs or frame URLs.
- closing the page/session is idempotent; timer/socket/listener counts return to
  zero.
- all static regression contracts above pass with experiment mode omitted.

Use the existing Node 22 `node:test` stack. Add no npm dependency.

### Browser tests

Run the actual target Chromium/Attendee page, not jsdom:

- page reaches `ready`, reports viewport, visibility, renderer clock, dropped
  frames, and canvas-present timestamps;
- deterministic envelope fixtures yield the expected ordered frame trace;
- delayed/batched WebSocket delivery retains the source-sample schedule rather
  than replaying every late frame;
- cancel changes to `idle` within the declared visual bound and stale envelopes
  remain rejected;
- reload creates a new connection and starts idle with no historical replay;
- WebSocket loss leaves the avatar idle, stops all local scheduling, and reconnects
  only with a fresh server snapshot;
- the page creates no `HTMLAudioElement`, `MediaStreamAudioDestinationNode`, or
  audible Web Audio graph in H;
- browser console, unhandled rejection, CSP, asset-load, and long-task counts are
  zero at acceptance.

Expose a narrow `window.__meetmateAvatarTest` only under `?test=1`; it may inject
envelope/control messages and read frame/stats state. It is not a renderer API.

### Carrier and meeting E2E

- L0 first sends frozen clicks/tones plus visual markers and proves the chosen H
  contract on hosted Attendee.
- A remote observer records one and only one waveform; source/observer duration,
  missing/duplicate samples, clipping, gap, and drift are compared with static.
- page failure injection does not perturb realtime audio in H.
- Google Meet is mandatory; Zoom is a separate claim and requires the same test.
- telemetry correlates source sample, visual presentation, observer audio, and
  captured video; unavailable values are `unknown`, never zero.

### 30-minute run

- run the frozen script on the target Mac mini and separate observer;
- record browser sample/clock behavior, CPU, memory slope, event-loop lag, thermal
  state, queue depth, frame drops, reconnects, underruns, and duplicate audio;
- require zero orphan timer/socket/session, zero stale replay, and zero second
  waveform;
- blind visual assessment and all quantitative thresholds are frozen before
  candidate labels are revealed.

### Cancel, reconnect, and exit

- cancel during initial audio, mid-utterance, final drain, and two rapid
  utterances;
- prove the cancel event reaches the page, the pending visual queue is cleared,
  the last visible non-idle timestamp is bounded, and old epochs never replay;
- reconnect during silence and output; only a new connection/epoch may resume;
- page reload/crash must not close H realtime audio;
- explicit leave and voice exit close the visual session locally even if remote
  bot cleanup fails.

## Failure containment

- Failure to load/connect/render the H page produces no audio fallback, retry
  storm, second bot, or static-mode mutation. Realtime audio continues exactly as
  before while the visual result is marked failed.
- Visual backpressure drops visual data and records the loss; it never pauses Fish,
  `realtime_audio.bot_output`, Soniox, or Agent Core.
- Any unexpected page-originated audio, duplicate observer waveform, or Attendee
  manager coupling is a carrier failure, not something muted by application gain.
- Authentication/protocol failure closes only the visual connection.
- Stale connection/epoch messages are dropped before scheduling or drawing.
- L2 WebGL loss, if later attempted, must fall to an idle L1 frame within the page;
  it must not alter meeting audio or silently become a production fallback.
- Static remains the only production-qualified/default path. Experiment failure
  never changes the default.

## Immediate stop conditions

### Stop L0 → L1

Do not create or measure the L1 renderer if any of these occurs:

- hosted Attendee rejects or ambiguously interprets the combined H payload;
- the page cannot be proved silent, or more than one observer waveform exists;
- page failure affects realtime input/output, cancel, reconnect, or leave;
- audio continuity/quality misses a non-waived static-derived carrier gate;
- visual marker drift cannot be bounded against observer audio;
- the cancel-epoch event is absent from the handler boundary;
- a 30-minute run leaks, reloads unexpectedly, or exhausts resource headroom;
- consent/provenance for the selected frame assets is incomplete.

If H fails for a topology reason, stop. Do not switch the same issue to A.

### Stop L1 → L2

Do not copy/adapt the WebRig when:

- L1 misses the declared visual floor because timing or carrier evidence is bad;
- L1 cancel/reconnect/static regression is not clean;
- L1 already meets the visual floor and L2 has no predeclared product question;
- L2 attribution or generated-asset lineage is incomplete;
- target-machine CPU/memory/thermal headroom is below the frozen margin;
- WebGL/context-loss behavior cannot remain isolated from audio;
- the proposed work introduces a renderer/provider framework.

## Caty reuse and provenance

For L1:

- **Adapt the behavior**, with source references in code comments and NOTICE:
  `CatyController.swift:2429-2513` for dB normalization/stop reset and
  `FrameAvatarView.swift:34-63` for thresholds/frame semantics.
- **Copy only approved generated PNG frames**, after recording source repository
  commit, original relative path, original SHA-256, destination SHA-256,
  transformation command, likeness/consent owner, and license conclusion.
- **Do not copy SwiftUI/iOS application code.**
- **Reference, but do not copy, WebRig runtime code** in the L1 issue.

For a later L2 issue:

- identify every copied/adapted section of `webrig/index.html` and every baked
  texture/rig artifact;
- preserve the MIT Anime2.5DRig notice and hakoniwa / 852wa attribution from
  `webrig/NOTICE.md`;
- record whether each file is upstream-derived, Caty-derived, or newly written;
- keep rig-generation tools offline; they do not become Meetmate runtime
  dependencies.

## Candidate implementation issue

**Title:** PoC: add H-only L1 local frame avatar after carrier qualification

**Dependencies**

- LA-02 static baseline and frozen thresholds complete;
- LA-03 telemetry plus handler-level output epoch/cancel event complete;
- LA-04 hosted Hybrid H pass complete, including silent-page and one-waveform proof;
- synthetic/non-personal frame set selected and provenance/consent recorded;
- visual floor and cancellation bound declared before implementation.

**In scope**

- the exact H + L1 files and thin edits named above;
- copied Fish PCM used only to derive timestamped envelopes;
- H payload behind an explicit non-default experiment value;
- unit, real-browser, Meet carrier, cancel/reconnect, 30-minute, and static
  regression evidence.

**Out of scope**

- Full-page A fallback;
- L2 WebRig, L3 LiveAvatar, Recall, vendor selection, production rollout;
- generic provider/renderer/factory/DI abstractions;
- new dependencies;
- Agent Core, gateway, Soniox, Fish, identity, memory, skill, tool, prompt, or turn
  policy changes;
- a second TTS, STT, bot, meeting input, or audible output owner.

## Explicit answers to the ten council questions

1. **L1 or L2?** L1. It is the smallest real-avatar test; L2 adds WebGL and
   provenance/resource variables before amplitude timing is proved.
2. **Ordering?** L1 must pass before L2. Do not bundle both or build a renderer
   fixture system; a later L2 diff may replace the single L1 draw function.
3. **RMS and clock?** Derive RMS from the exact copied Fish S16LE samples in fixed
   sample windows. In H, schedule compact envelopes on a calibrated monotonic
   source-sample clock because the page does not own audio; in A, compute/report it
   in the AudioWorklet render path. Never schedule by WebSocket arrival.
4. **Exact files?** `local-avatar-session.js`, the fixed HTML/JS, six named frame
   PNGs, NOTICE, two named Node tests, and one frozen fixture, with
   responsibilities listed above.
5. **Thin existing wiring?** `meet-routes.js` and the `ui-routes.js` allowlist
   only. `server.js`, pipeline, Fish, Soniox, gateways, and Agent Core stay out.
6. **Caty reuse?** Adapt the formula/frame semantics, copy only approved generated
   L1 PNGs with hashes/consent/license records, reference WebRig for now, and
   preserve its MIT notice if L2 is later copied.
7. **Tests?** Deterministic unit/state tests, actual-browser clock/silence tests,
   hosted carrier/observer tests, frozen 30-minute run, cancel/reconnect/exit
   injection, and default-static payload/module-load/audio regression are all
   mandatory.
8. **Stops?** Any coexistence, silent-page, one-waveform, carrier-quality,
   cancel-epoch, drift, stability, provenance, static-isolation, or resource gate
   failure stops the next level immediately.
9. **Future-only abstractions?** Yes, avoided. There is one H-specific session and
   one L1 draw function, no LiveAvatar/Recall/provider surface.
10. **Ready?** **No today.** It becomes a single H + L1 implementation issue only
    after LA-02/03 and a hosted LA-04 H pass, plus asset provenance and frozen
    visual/cancel thresholds. H failure returns to an A architecture decision,
    not implementation fallback.
