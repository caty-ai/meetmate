# Round 2 Cross-review — Module Boundary / Test Contract

Date: 2026-07-23  
Role: Module Boundary / Test Contract Architect  
Scope: cross-review and compromise specification only; no implementation

## Cross-review of the five Round 1 proposals

### 01 — Meeting Bot / WebRTC

**Strongest point:** it makes audio ownership and failure behavior explicit.
Hybrid H preserves the existing realtime WebSocket as the sole input/output,
Full-page A is a separate ownership topology, and H failure cannot silently select
A. Its staged `H → L0 → L1` issue is also operationally understandable.

**Strongest objection:** its proposed file ceiling is not actually minimal.
`src/server.js` already delegates HTTP and WebSocket handling to `meet-routes.js`,
so another upgrade route there is unnecessary. It also permits a conditional
`pipeline.js` edit without defining the exact event contract, and lists more Caty
frames than L1 needs. “Sandbox proof” is described both as an issue prerequisite
and work inside the issue; that gate must be stated unambiguously.

### 02 — Audio / DSP

**Strongest point:** it supplies the best same-sample and measurement contract.
Chunk boundaries have no DSP meaning; sample index, cancel epoch, incremental
odd-byte/window carry, observer skew, and an actual calibration artifact are the
right test coordinates. Its warning not to transplant Caty's fixed meter
thresholds into a different PCM chain is persuasive.

**Strongest objection:** the proposed file list pre-builds A-only AudioWorklet and
L2 WebRig branches while H is still unproved. That is speculative code and invites
a generic renderer surface. The 20 ms/10 ms extractor and percentile calibration
are good hypotheses, but must be frozen by fixture evidence rather than treated as
architecture truth before measurement.

### 03 — Local Renderer / Caty Asset

**Strongest point:** it gives the most concrete Caty reuse boundary. Swift/iOS
application code and offline rig tools stay out; generated art, adapted WebRig,
MIT runtime, and likeness rights remain separate provenance categories. Its
L1-first visual diagnosis is sound.

**Strongest objection:** a “silent analysis AudioWorklet” is incompatible with
the strict H hypothesis. A zero-gain graph can still create a captured audio track
or alter browser/media lifecycle, so it cannot be introduced merely to obtain a
clock. Bundling L2 and treating L1 as its runtime fallback also makes WebGL code,
rights work, and switching behavior part of the first issue before L1 justifies
them.

### 04 — Module Boundary / Test Contract

**Strongest point:** it identifies the hidden cancel-boundary defect and gives
static mode a positive isolation contract: no live import, session, timer, token,
asset read, or network operation. It also correctly distinguishes H's calibrated
source-sample clock from A's actual browser render clock.

**Strongest objection:** the Round 1 vote is too administratively conservative.
Requiring a separately completed LA-03 seam and LA-04 H pass before even one
implementation issue fragments a single falsifiable experiment. The same issue
can contain a test-first, emission-only cancel seam and H0, then prohibit all L1
files until H0 passes. The Round 1 proposal also adopted Caty's `-50...-10 dB`
normalization too readily; DSP calibration must decide runtime thresholds.

### 05 — Skeptic / Security / Operations

**Strongest point:** it exposes the strongest blockers that attractive renderer
code could hide: hosted H remains unknown, a silent page must contain no audio
graph at all, public-page credentials and assets are exposed surfaces, current
audio is not a clean baseline, L2 randomness prevents repeatability, and Caty file
hashes do not prove art rights.

**Strongest objection:** splitting H0 and L1 into separate issues is not required
for safety. A single issue can express a hard execution gate: H0 failure closes
with evidence; L1 code and art are never added. That retains one owner, one audit
trail, and one static-regression suite without authorizing speculative renderer
work.

## Resolution: one gated issue, but staged source scope

**Yes, one implementation issue can responsibly contain H proof and conditional
L1.** The issue is a falsification workflow, not an instruction to implement all
listed stages immediately.

The distinction is:

- **Issue scope may describe H0 and conditional L1.**
- **Source scope expands only after a recorded gate pass.**

The issue has three ordered milestones:

1. **M0 — behavior-lock and cancel seam.** Add regression tests first, then the
   smallest output-cancel observation needed by the visual edge.
2. **H0 — hosted coexistence probe.** Build only the silent marker page/session,
   run the hosted carrier and observer protocol, and record pass/stop evidence.
3. **L1 — conditional frame renderer.** Add calibration and cleared frames only
   after H0 passes every hard gate.

If H0 fails, the issue closes as a valid falsification result. It contains no L1
assets, threshold code, WebGL, AudioWorklet, or A fallback. Full-page A requires a
new architecture decision and issue.

This resolves the Round 1 vote split:

- proposals 01/02/03 are right that one gated issue can retain one audit trail;
- proposals 04/05 are right that no renderer code may exist before the carrier and
  cancel boundaries are proved.

## Cancel/output seam: inside the issue, before H0 acceptance

The current `createPipeline(..., onAudio)` seam exposes PCM but not every
authoritative cancel. Polling `turnState.isAgentSpeaking`, using inactivity
timeouts, or inferring cancel from missing chunks cannot meet immediate-close and
no-replay contracts.

The seam should therefore be implemented in M0, not left as an external LA-03
prerequisite:

- `src/pipeline.js` emits one additive, synchronous
  `playback_cancelled` handler event at each existing authoritative abort;
- the event contains only `{ reason, monotonicTime }`;
- it contains no avatar/provider/session secret, transcript, prompt, gateway
  state, or replacement turn policy;
- listener absence is a no-op;
- listener failure is contained and cannot change the abort;
- existing abort conditions, order, `turnState`, Fish calls, gateway calls, exit
  grace, and conversation semantics remain unchanged.

`local-avatar-session.js` owns the visual `cancelEpoch`. It increments the epoch
when it receives `playback_cancelled`; the pipeline does not know visual epochs.
The first subsequent PCM sample starts a new source-sample sequence for that
epoch. Natural drain closes visually from the final scheduled envelope/idle rule;
it does not synthesize a cancel.

M0 must test every current authoritative abort path. If one complete, emission-only
event cannot be added without refactoring cancel semantics, stop the issue and
return to architecture review. LA-03 may consume the event for telemetry later,
but L1 correctness must not depend on a separate issue's schedule.

## Exact concrete file ceiling

### M0 + H0: ten files touched

New runtime/page files:

1. `src/transport-meet/local-avatar-session.js` — owns one H visual session,
   capability validation, connection generation, source-sample marker sequence,
   clock mapping, cancel epoch, bounded visual queue, reconnect invalidation,
   close, and telemetry.
2. `public/local-avatar/index.html` — fixed 1280×720 dependency-free page with one
   marker/canvas surface, strict CSP, and no audio/media element or graph.
3. `public/local-avatar/local-avatar.js` — authenticates the page socket, maps the
   server sample clock to `performance.now()`, presents L0 markers, rejects stale
   connection/epoch state, idles on failure, and exposes a test-only diagnostic
   surface.

Existing thin edits:

4. `src/transport-meet/meet-routes.js` — lazily selects the explicit H experiment,
   adds the proven combined payload, tees source timing beside the unchanged
   realtime output, forwards `playback_cancelled`, routes the exact visual
   WebSocket path, and closes the visual session with the meeting lifecycle.
5. `src/ui-routes.js` — allowlists only the exact H0 HTML and JS paths; it does not
   become a recursive static server.
6. `src/pipeline.js` — adds only the M0 emission-only
   `playback_cancelled` event described above.

Tests/fixture:

7. `test/local-avatar-session.test.js` — capability, clock, bounds, epoch,
   reconnect, close, input validation, and cancel-path contracts.
8. `test/local-avatar-page-contract.test.js` — marker schedule, page silence, CSP,
   stale-state rejection, disconnect idle, and deterministic browser-test API.
9. `test/local-avatar-static-regression.test.js` — exact default payload/audio
   behavior, no live import/init, and lifecycle parity.
10. `test/fixtures/local-avatar-timeline.json` — frozen PCM transient/sample-index
    and expected marker trace shared by unit, browser, and observer checks.

`src/server.js` is not edited: it already delegates HTTP and WebSocket requests to
`meet-routes.js`.

### Conditional L1: six additional files, maximum sixteen

Only after H0 passes:

11. `src/transport-meet/local-avatar-calibration.json` — frozen sample rate,
    fixture hashes, window/hop, dB normalization, thresholds, hysteresis, and
    attack/decay parameters produced by the approved calibration procedure.
12. `public/local-avatar/assets/closed.png`
13. `public/local-avatar/assets/half.png`
14. `public/local-avatar/assets/open.png`
15. `public/local-avatar/assets/blink.png`
16. `public/local-avatar/assets/PROVENANCE.md` — source repo/commit/path, source
    and destination SHA-256, transformations, creator/rightsholder, public-display
    and redistribution/modification approval, and likeness consent.

L1 modifies the existing `local-avatar-session.js`, `local-avatar.js`,
`ui-routes.js`, tests, and fixture; it adds no renderer module. `drawL1(level,
blink)` is one concrete function in `local-avatar.js`.

Four PNGs are the ceiling: closed, half, open, and idle blink. `talk3`,
`talk_blink`, `listen`, and `icon` are not needed to answer the first product
question.

No new npm dependency, configuration schema, server route layer, provider
interface, renderer registry, DI container, or cross-repository package is
permitted.

## Dependency direction

```text
pipeline.js
  ├── existing PCM callback ─────────────────────────────┐
  └── playback_cancelled event                           │
                                                        v
meet-routes.js ──lazy live branch──> local-avatar-session.js
   │                              ├── visual state WS
   │                              └── frozen calibration JSON (L1 only)
   │
   └── existing Attendee realtime audio owner (unchanged)

public/local-avatar/index.html
  └── local-avatar.js
       └── cleared fixed PNGs (L1 only)
```

Forbidden reverse dependencies:

- pipeline, gateway, Soniox, Fish, profile, memory, skill, and tool modules never
  import local-avatar code;
- browser code never calls Agent Core or receives transcript/text/internal IDs;
- assets and calibration contain no executable routing or provider behavior;
- static mode never imports or initializes `local-avatar-session.js`.

The pipeline event is a transport-observable playback fact, not a dependency on
the renderer.

## Route, authentication, and state contracts

### Explicit experiment selection

The normal `POST /join-meeting` remains the default. The live branch is selected
only by the exact value `avatarExperiment=hybrid-local-l0`; after H0 passes, the
accepted value may become `hybrid-local-l1`.

The current static `botPayload` literal remains source-identical. With no exact
experiment value:

- no `voice_agent_settings` field is added;
- no local-avatar module is required;
- no page URL/capability/session/timer is created;
- invalid or missing live-only data is irrelevant to static;
- static does not fall back into or out of a live bot.

Unknown experiment values fail before bot creation; they do not silently select
static.

### Public HTTP and visual WebSocket routes

- `GET /local-avatar/index.html`
- `GET /local-avatar/local-avatar.js`
- conditional L1 asset paths, each explicitly allowlisted
- `WS /local-avatar/ws`

All other `/local-avatar/*` paths return 404. The existing Attendee realtime
WebSocket path continues through the current handler unchanged.

### Capability contract

The launch URL uses a distinct random `visualId`, not the internal meeting session
ID:

```text
https://host/local-avatar/index.html?v=<visualId>#cap=<256-bit capability>
```

- the fragment is not sent in the HTTP request;
- JS reads it once, immediately removes it with `history.replaceState`, and sends
  it only in the first WebSocket authentication message;
- the server stores only its hash and compares in constant time;
- it is audience-bound to one `visualId`, expires with the experiment/session,
  and authorizes visual protocol only;
- it is absent from query strings, logs, telemetry, errors, local/session storage,
  source maps, and asset URLs;
- the socket has a short unauthenticated timeout, strict maximum message size and
  rate, exact same-origin `Origin` validation, and no state delivery before auth.

Reload may reuse the still-valid launch capability, but accepting it increments
`connectionGeneration`, closes the prior visual socket, clears all page/server
visual queues, and sends only the current epoch plus idle/current live state. No
historical envelope or PCM is replayed.

### State ownership

Server visual session:

```text
CREATED -> AUTHENTICATED -> READY -> CLOSED
```

`connectionGeneration` changes on every authenticated replacement.
`cancelEpoch` changes on every `playback_cancelled`. Mouth/marker state is data
inside `READY`, not another lifecycle framework.

Page:

```text
CONNECTING -> IDLE <-> PRESENTING -> CLOSED
```

Disconnect, protocol error, capability expiry, cancel, or stale data moves the
page to `IDLE` immediately. Only a current connection generation and cancel epoch
can present state.

### H visual clock

The H page has no `AudioContext`, `AudioWorklet`, `<audio>`, oscillator, media
destination, or muted audio graph. The server stamps exact Fish source-sample
indices and its monotonic time. A nonce/echo exchange estimates the
server-to-page monotonic offset; the page presents by mapped source sample, never
by WebSocket arrival.

This is not claimed to be the Attendee/Meet playout clock. H passes only if the
independent observer shows bounded signed skew and drift between PCM transients
and captured markers. If the mapping is unstable or requires more than the
predeclared delay, reject H.

### L1 envelope

After H0, `local-avatar-session.js` incrementally handles odd bytes and window
carry across Fish callbacks, derives RMS from the exact PCM copy admitted to the
existing realtime output, and sends compact timestamped levels. Network chunks
never define windows.

Runtime normalization comes only from the frozen calibration JSON. Caty's
`-50...-10 dB`, `0.2/0.7`, 60 ms cadence, and WebRig smoothing are reference
hypotheses, not silently copied production constants. Dominant frequency,
phonemes, per-utterance AGC, future-sample normalization, and random syllable
motion are out.

Visual backpressure drops and records visual state; it never blocks Fish, the
existing `realtime_audio.bot_output`, Soniox, or Agent Core.

## Static byte/payload regression contract

“Byte-compatible” has two separate tests:

1. **Source guard:** the existing static `botPayload` literal and
   `websocket_settings.audio` construction remain text-identical except for
   surrounding live-only code outside the guarded range.
2. **Serialized payload guard:** for the frozen request/config fixtures, the exact
   UTF-8 bytes sent to Attendee match the pre-change golden payload after replacing
   only nondeterministic session/token fields with fixed test values.

Additional static assertions:

- `voice_agent_settings` is absent, not null;
- optional `bot_image` presence/content is unchanged;
- base64 Fish bytes, trigger, and `TTS_SAMPLE_RATE` are identical and sent once;
- mixed input, echo gate, Soniox rate, greeting, turns, barge-in/cancel, reconnect,
  exit grace, bot leave, and connection replacement are behavior-locked;
- `require.cache` and sentinels show no local-avatar module load, session, timer,
  capability, page read, or network call;
- static passes with live assets/config/host unavailable and live DNS blackholed;
- a failed live experiment cannot create a static bot in the same meeting.

The golden payload must not contain real secrets. It tests bytes deliberately,
while semantic assertions separately produce useful failure messages.

## H0 hard gate and conditional L1

H0 passes only when the hosted target proves:

- one combined payload is accepted and both managers remain operational;
- the page creates no audio graph/track and the observer detects exactly one
  waveform/audio owner;
- page load, kill, reload, WebSocket loss, auth expiry, and stale messages do not
  stop, replace, duplicate, delay, or replay current realtime audio;
- current mixed input, echo gate, Fish output, cancellation, reconnect, exit, and
  leave stay inside frozen baseline-derived gates;
- source-to-observer audio continuity and Issue #62 start/mid-cut distributions do
  not materially regress;
- marker-to-observer-audio p50/p95/max signed skew and drift are observable and
  inside frozen gates;
- 30-minute CPU, memory, event-loop, thermal, page-frame, queue, reconnect, and
  orphan-resource results pass;
- static isolation remains clean.

Only then may L1 files 11–16 be added.

L1 additionally requires:

- art provenance and rights approval before assets enter `public/`;
- frozen calibration generated from hashed silence/noise/Japanese Fish fixtures;
- deterministic closed/half/open traces under rechunking;
- immediate close on cancel and no old-epoch reopen after rapid next turn/reload;
- no material change to H0 audio, resource, timing, or lifecycle results;
- a predeclared visual floor and blinded observer result.

## L2 is a separate issue

L2 is not a fixture, dormant branch, fallback, optional directory, or acceptance
item in this issue. It earns a new issue only after L1 evidence answers a named
product question that L2 could improve.

The later issue must independently address:

- exact WebRig upstream/Caty commits and derived-file manifest;
- full MIT LICENSE/NOTICE and separate Caty art rights;
- removal or deterministic seeding of random mouth/rest motion;
- utterance/generation/cancel identity on context restore;
- WebGL availability, long frames, context loss/restore, closed-mouth failure,
  30-minute resource budgets, and the additional 80 ms/lookback contribution;
- material blinded visual improvement over L1 without weakening H.

L1 need not become an automatic L2 fallback. A WebGL failure can fail visually
closed to the existing L1 page only if that later issue proves switching does not
replay state or affect audio.

## Compromise issue scope

**Title:** PoC: prove Attendee Hybrid H and conditionally add deterministic L1
frame lip sync

**In scope**

- M0 test-first static/cancel contracts;
- hosted H0 with current realtime audio as immutable sole input/output;
- an audio-free L0 page and sample-index marker;
- conditional, post-H0 L1 calibration and four cleared Caty frames;
- unit, actual-browser, hosted carrier, synchronized observer, cancel/reconnect,
  30-minute, security, provenance, and static-regression evidence;
- a stop report as a successful issue outcome when a hard gate fails.

**Out of scope**

- Full-page A, L2 WebRig, L3 LiveAvatar, Recall, production adoption/deployment;
- AudioWorklet or any page audio graph in H;
- new dependencies/config framework;
- provider/renderer interfaces, DI, registry, automatic fallback;
- Agent Core decision changes, Fish/Soniox/gateway/profile/memory/skill/tool changes;
- a second TTS, STT, bot, meeting input, or audible output.

## Preliminary vote

**YES: one gated H0 → conditional L1 implementation issue is responsibly
issue-ready. It is not code-start-ready until its M0 regression tests and exact
cancel-event contract are accepted.**

Conditions of the vote:

1. H coexistence is treated as an unknown to prove inside the issue, never as a
   vendor guarantee.
2. Only files 1–10 exist before H0 passes; files 11–16 are forbidden until the
   pass is recorded.
3. H failure closes the issue without A or L1 code.
4. The playback-cancel seam is emission-only and test-locked inside M0; failure to
   keep it semantic-neutral stops the issue.
5. Static remains the sole production-qualified/default path.
6. L2 is a later issue, not hidden optional scope.
