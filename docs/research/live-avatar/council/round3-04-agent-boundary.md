# Round 3 — Adversarial Debate: Agent Boundary

Status: adversarial answers, comparison PoC only
Councilor: Agent Identity / Memory / Skills Architect
Date: 2026-07-23
Inputs: all five Round 2 cross-reviews, shared evidence pack, failure dossier,
repository evidence, and cited official contracts

## Debate position

The comparison should test complete compositions, not mix carrier and renderer
scores:

```text
static Attendee baseline
A + bounded local E
A + LiveAvatar LITE
C + bounded E (only for a named cross-provider discriminator)
```

A and C are meeting carriers. E and LiveAvatar LITE are renderers. B is absent
from the live comparison because Attendee accepts an HTTPS MP4, not a continuous
camera stream
([Attendee `output_video`](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video)).
FULL vendor-agent modes are absent because they duplicate Meetmate's brain.

The invariant is stricter than “use Fish”:

- one Meetmate Agent Core;
- one authoritative meeting session and agent-specific gateway session;
- one Fish synthesis;
- one immutable output owner per bot generation;
- no transcript, prompt, memory, tool, or stable user identity at the renderer;
- no automatic in-session static replacement while the live bot may still exist;
- no shared live dependency on the static path.

Each answer below separates fact, inference, and unknown, then names the smallest
test that could falsify it.

## なぜ以前のRecall構成は音質が悪かった可能性があるのか

### Answer

Several independent mechanisms could have degraded audio, but the repository
does not prove which mechanism occurred—or even preserve the exact heard symptom.

**Facts**

- `d3d86d7` converted each received PCM chunk into a separate
  `AudioBufferSourceNode` and advanced one `playCursor`. It had no bounded jitter
  queue, underrun counter, media clock, or meeting-observer timestamp.
- `b5fbff1` captured input with `ScriptProcessorNode(4096)` from an unconstrained
  AudioContext and manually averaged down to 16 kHz. At 48 kHz, 4096 samples are
  about 85.3 ms; at 16 kHz they are 256 ms before network/STT.
- `0cd1e52` moved input capture to AudioWorklet but retained a 4096-sample flush
  and did not fix the output scheduler.
- `02ece31` changed input again to Recall raw mixed audio while browser output
  remained, and `b9549f6` later supplied the required artifact enablement.
- The Recall payload did not select `web_4_core`; current Recall documentation
  connects CPU pressure with choppy Output Media and recommends comparing the
  larger variant
  ([Recall Output Media](https://docs.recall.ai/docs/stream-media)).
- `bbe1544` changed Fish model, prompt, and emotion tags in the transport
  experiment; `de1d03e` reverted the bundle without a recorded operational
  reason.

**Plausible inferences, not findings**

Network arrival jitter plus per-chunk scheduling could have caused gaps;
unobserved browser resampling or manual averaging could have caused distortion or
speed error; low container CPU could have starved page audio/video; WebRTC and
meeting codecs could have changed quality; echo/gating or incomplete raw-input
configuration could have affected the conversation; and mixed Fish/prompt
changes could have contaminated listening comparisons.

**Unknown**

Noise, clipping, dropouts, speed error, and added latency are all unbound to a
commit. The actual AudioContext rate, instance variant, CPU graph, packet trace,
meeting/session, recording, abandonment reason, and S2-Pro revert reason are not
retained. “Recall audio was bad” is therefore not an evidence-based root cause.

### Smallest falsification test

Replay one recorded current 24 kHz Fish fixture through a fresh Recall page with
one bounded clocked queue. Run the identical fixture once on the default variant
and once on `web_4_core`; retain actual AudioContext rate/state, arrival and
playout sample counts, underruns, queue depth, CPU, and the meeting-observer
recording. This falsifies specific scheduler/CPU/rate hypotheses without changing
Soniox, Agent Core, prompt, Fish, or meeting input. It cannot reconstruct the
historical cause.

## Attendee webpage方式でも同じ問題が再発しないか

### Answer

Yes. A changes vendor but retains the same broad browser-output failure class.
It is the smallest documented Attendee live carrier, not a proven clean audio
path.

**Facts**

Attendee loads a public HTTPS page, captures its audio and video, and exposes
meeting audio as page microphone input
([Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents)).
The current static path instead sends Fish once as
`realtime_audio.bot_output` (`src/transport-meet/meet-routes.js:1319-1329`) and
receives direct mixed PCM under the existing echo gate
(`src/transport-meet/meet-routes.js:1376-1404`).

**Inference**

An A page will likely cross PCM-to-float, actual AudioContext, page capture,
WebRTC, and meeting-codec boundaries. A poorly designed page can repeat
per-network-chunk scheduling, unbounded latency, stale reconnect playback, or
duplicate audio if current WebSocket output remains active.

**Unknown**

Attendee container AudioContext rate/state, autoplay behavior, internal
resampling, capture buffering, CPU headroom, observer-side codec quality,
Google Meet/Zoom parity, and whether direct mixed input can remain while page
output is the sole egress are not measured.

### Smallest falsification test

Before adding any managed avatar, run **A+E**, where E is only a deterministic
canvas mouth/flash driven by the frozen PCM fixture. Disable the current
WebSocket output by construction for this live bot, record the actual browser
clock and bounded queue, and compare the meeting-observer audio with the static
fixture. Force one page reconnect and one cancel. If A alone introduces material
audio degradation, duplicate output, stale replay, or unobservable timing,
LiveAvatar is not the cause and should not be added.

## LiveAvatar LITEは本当に映像rendererだけとして使えるか

### Answer

**At the documented wire boundary, yes; at meeting-quality and failure behavior,
not yet proven.**

**Facts**

The official LITE starter uses `start`, `agent.speak`, `agent.speak_end`, and
`agent.interrupt`; accepts base64 raw PCM S16LE mono at 24 kHz; tees the same
upstream TTS frames to the normal downstream path; and supplies video to the
frontend without a second frontend audio track
([LiveAvatar LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python)).
The overview assigns STT, LLM, TTS, and WebRTC to the customer in LITE, whereas
FULL owns agent layers and is rejected
([LiveAvatar overview](https://docs.liveavatar.com/)).

**Inference**

LITE can remain downstream of Meetmate Agent Core if it receives only PCM,
opaque appearance/session capability, end, interrupt, and close. It need not see
text or choose a turn. This is stronger evidence than the obsolete HeyGen
Interactive Avatar examples.

**Unknown**

Remote accepted-sample accounting, backpressure, queue bound, presentation
timestamps, interrupt-to-last-frame time, reconnect/idempotency, delete
reliability, render-delay distribution, retention/training/region, and effective
cost remain unknown. Reference aggregation of roughly 400–600 ms initially and
roughly one second later is a feed pattern, not measured renderer or meeting
latency.

### Smallest falsification test

With gateway, STT, and Fish generation absent, send a prerecorded 24 kHz PCM
fixture directly through the LITE adapter. Inspect every outbound field: no
transcript, prompt, tool, memory, or stable user ID may be required. Verify video
appears, no second audio reaches the page, pre-connected sends are rejected
locally, `agent.interrupt` stops matching motion within a measured tail, and
explicit deletion ends the session. Any required vendor TTS/text/turn component
falsifies renderer-only status immediately.

## Fish AudioのPCMを二重生成せず、会議音声と口の動きへ同じsourceとして渡せるか

### Answer

Yes at the application fork; not as a claim of identical downstream waveform or
timing.

**Facts**

Current Fish synthesis emits through one `onAudio(chunk)` callback
(`src/pipeline.js:2207-2227`). Fish defaults to 24 kHz
(`src/config.js:9-16`, `src/config.js:350-363`), matching LiveAvatar LITE's
documented ingress. The current meeting leg wraps those bytes once
(`src/transport-meet/meet-routes.js:1319-1329`).

**Required design**

Stamp bytes immediately after the existing Fish callback:

```text
{ render_session_id, generation, turn_id, sequence,
  first_sample_index, source_monotonic_at, pcm_s16le_24k }
```

One branch feeds the sole page-owned meeting audio queue; the other maps the
same decoded PCM bytes to `agent.speak`. End and cancel are control events, not
new synthesis requests. A bounded meeting-audio delay may change presentation
time for A/V alignment, but it must not change PCM content or create an immediate
audible branch in parallel.

**Unknown**

Hash equality before transport does not prove LiveAvatar accepted/rendered all
samples, nor that browser conversion/WebRTC preserves the waveform. “Same
source” is not “same playout.”

### Smallest falsification test

Count Fish synthesis requests and require exactly one. Hash ordered decoded PCM
at the fork and at both adapter inputs; sample counts, turn IDs, and sequences
must match. Then record the meeting as an observer and require one—not two—
audible waveform. Intentionally enable a duplicate path in a negative test to
prove the observer detector catches it. Any second Fish call, missing sequence,
or simultaneous page/WebSocket audio fails the invariant.

## avatar vendorがLLM/STT/turn-takingを握らずに済むか

### Answer

Yes for LITE/Echo-style renderer modes if authority is enforced by data shape;
no for FULL managed modes.

**Facts**

Meetmate currently owns agent switching and the gateway route, token, voice,
model, system addendum, and agent-scoped session key
(`src/pipeline.js:546-579`). OpenClaw manages its history; standalone providers
use the bounded local history (`src/pipeline.js:1850-1868`). Gateway requests
receive `sessionUser` and model/config inside the provider path
(`src/pipeline.js:1898-1913`). Wake, cancel, barge-in, and exit already belong to
the pipeline and echo gate (`src/pipeline.js:1280-1446`;
`src/transport-meet/meet-routes.js:1379-1404`).

**Required authority rule**

The vendor may receive:

```text
ephemeral render capability
appearance key
PCM format and bytes
authoritative end / interrupt / close
```

It may return only readiness, media timing, bounded health/error, and video.
It must not receive prompts, transcripts, memory, tool schemas/results, gateway
credentials, stable user IDs, or permission to select an agent. Vendor text
fields are untrusted diagnostics and never enter model context, memory, a tool
call, or delegation.

**Unknown**

A product label does not prove hidden services are disabled. LITE's documented
shape passes; observed network behavior and configuration must confirm it.

### Smallest falsification test

Animate a fixture with OpenClaw/Hermes/Claude gateways, Soniox, and all Meetmate
tools disabled. Capture vendor requests and callbacks. The test passes only if
rendering works with audio/control fields alone and a forged vendor callback
cannot become a transcript, tool result, agent switch, or memory write. If
rendering requires text, vendor turn detection, vendor TTS, or tool access, reject
the mode.

## static-image経路を本当に無変更にできるか

### Answer

Yes, but only with stronger isolation than “the payload object looks similar.”
The static path must be independent at bytes, startup, dependencies, state, and
failure behavior.

**Facts**

Current static bot construction is the payload at
`src/transport-meet/meet-routes.js:1206-1219`, with image loading separately at
`src/transport-meet/meet-routes.js:823-863`. There is no current appearance-mode
switch. Phase 1 requires this path to remain byte-for-byte unchanged.

**Required design**

- Add a separate live entry path selected before bot construction; do not insert
  live conditionals into the existing static payload block.
- Static mode must not import/initialize a renderer SDK, validate live-only
  environment variables, start a live timer/queue, contact a vendor, share a bot
  or renderer ID, or depend on live health checks.
- The kill switch is evaluated before live construction and defaults new
  sessions to the existing static route.
- “Fallback” means future sessions can immediately use static without vendor
  availability. It does not mean automatically spawning a static bot beside an
  uncertain live bot.

**Unknown**

Until a regression captures the actual serialized request and lifecycle,
byte-preservation is a design claim.

### Smallest falsification test

Capture the exact serialized static Attendee request from baseline, including
the current optional image behavior. With every live endpoint blackholed and all
live credentials absent, run create, greeting, multiple turns, cancel/barge-in,
long response, reconnect, exit, and leave. Compare request bytes and retained
observable events to baseline. Also assert that no live module initializes and
no outbound live-vendor call occurs. Any difference fails static isolation.

## vendor障害時に二重Botや二重音声を発生させず戻せるか

### Answer

Yes for containment and future-session rollback. Safe automatic in-session
conversion to the unchanged static bot is not established and is rejected for
the PoC.

**Required ownership model**

```text
output_owner = STATIC_WEBSOCKET | LIVE_PAGE   # immutable for a bot generation
media key = (meeting_session_id, generation, turn_id, sequence)
```

There is one bot ID and one output owner. Every create/reconnect increments a
generation. Page and renderer accept only the current generation; cancel revokes
the turn; bot replacement/leave revokes the generation. A delayed audio branch
cannot coexist with an immediate branch. A renderer-returned audio track cannot
coexist with page Fish output.

On renderer/vendor failure:

1. stop accepting new PCM for that generation;
2. invalidate local page queues and reject late/stale media;
3. send best-effort interrupt/delete to the renderer;
4. request leave for the one live bot;
5. record an orphan incident if renderer deletion or bot absence is unconfirmed;
6. disable new live creation independently of the failed vendor;
7. start static only for a new session, or after a separately proven absence
   confirmation—not automatically in this PoC.

**Facts**

The current transport already replaces a previous primary WebSocket
(`src/transport-meet/meet-routes.js:1290-1300`) and leaves using one stored bot ID
(`src/transport-meet/meet-routes.js:1337-1354`). These are useful precedents, not
proof that page/vendor generations are safe.

**Unknown**

Vendor delete acknowledgment does not itself prove billing stopped, and leave
request does not necessarily prove the participant is absent. Required provider
status/reconciliation behavior is unmeasured.

### Smallest falsification test

During queued speech, independently kill the page connection, LiveAvatar
connection, and delete response; reconnect with a new generation and deliver old
packets afterward. An observer must see at most one bot and one audible stream,
and no old-generation sound/motion. Then activate the kill switch while the
vendor is unreachable and create a new static session successfully. Do not spawn
a replacement static bot during the uncertain live session.

## 最小モジュールはいくつ必要か

### Answer

For the comparison PoC: **three runtime modules and one test-only harness**.
This is a conceptual responsibility count, not a mandate for exactly four source
files.

### Runtime module 1 — concrete live-session bridge

Responsibilities:

- create one ephemeral `render_session_id` and short-lived page capability;
- own `generation`, `turn_id`, `sequence`, and immutable `output_owner`;
- tap the existing Fish callback once and emit the small PCM/control envelope;
- accept only allowlisted page readiness/timing/errors;
- revoke generation and coordinate stop/leave.

It must not own agent identity, gateway selection, memory, tools, turn detection,
Fish synthesis, the static payload, or cross-provider fallback.

### Runtime module 2 — Attendee live page

Responsibilities:

- use the page microphone as the explicitly selected live input path;
- play the sole audible Fish stream through one bounded, clocked queue;
- render the bounded local E mouth/flash directly in the page;
- display the selected renderer video;
- report actual browser rate/state and local media timestamps;
- flush by turn and reject stale generations.

The tiny E control stays in this page. It is not a separate renderer framework.

### Runtime module 3 — LiveAvatar LITE adapter

Responsibilities:

- wait for connected, then map start/speak/speak-end/interrupt/delete;
- send only the PCM/control envelope plus opaque appearance capability;
- stop local sends at the same cancel generation;
- record only observable vendor lifecycle/timing and preserve “unknown” for
  remote queue facts it cannot observe.

This is a concrete adapter, not an `AvatarProvider` base class.

### Test-only harness

Responsibilities:

- replay the frozen Fish fixture and scripted cancel/reconnect/failure sequence;
- count synthesis and hash/sample sequences at the fork;
- capture browser rates, queue events, CPU, and meeting-observer A/V/audio;
- assert static request bytes, one bot, one output owner, generation rejection,
  vendor deletion attempt, and no agent/tool data leakage.

C/Recall does not earn a permanent runtime abstraction. If the named
cross-provider discriminator is triggered, give it a separate disposable page
adapter using the same fixture/event record.

### Smallest falsification test

Attempt A+E and A+LITE using only these responsibilities. If a fourth runtime
responsibility is unavoidable, document the concrete missing contract. “A future
vendor might need it” is not evidence. If any of the three modules begins owning
prompts, agent profiles, tools, or static construction, the split is wrong.

## その抽象化は今必要か、将来のためだけの過剰設計ではないか

### Answer

Only the media envelope and generation/output-owner rules are needed now.
A generic Media Shell/plugin framework is not.

**Needed now because they make claims falsifiable**

- `(render_session_id, generation, turn_id, sequence)` on PCM/control;
- one immutable `output_owner`;
- `end`, `cancel`, and `close`;
- bounded local queue and stale-generation rejection;
- concrete observable timestamps, with unavailable remote facts represented as
  unknown;
- one frozen fixture and observer-side comparison.

**Rejected as future-proofing**

- provider discovery or registry;
- base `AvatarProvider`/renderer interface hierarchy;
- dependency-injection container or capability negotiation;
- common vendor configuration schema;
- generic cross-provider lifecycle engine;
- generalized `health()` that invents parity among incomparable vendor metrics;
- automatic Attendee/Recall failover;
- persistent renderer memory, persona synchronization, or a new profile model;
- generic phoneme/viseme pipeline beyond the single bounded E control;
- production telemetry platform, billing reconciler, or plugin marketplace
  before a carrier/renderer passes.

The LiveAvatar protocol should stay explicit in its concrete adapter. The A page
should stay explicit about its browser clock. Shared production abstractions may
be extracted only after at least two measured integrations demonstrate stable
common behavior. Similar method names are not sufficient evidence.

**Fact**

The existing system already has the correct semantic seam at Fish
`onAudio(chunk)` and already owns sessions, agents, gateway requests, history,
turn state, and bot lifecycle. A new generalized agent or provider layer would
duplicate working authority.

**Inference**

A small event envelope is justified for experiment comparability, not future
extensibility.

**Unknown**

Measurements may reveal a missing shared control—for example an unavoidable
playout acknowledgment—but that should be added in response to observed
contracts, not guessed now.

### Smallest falsification test

Implement the comparison design on paper as two explicit sequence traces:
A+E and A+LITE. Every required message must map to an existing authority or one
of the three concrete runtime modules. If a proposed abstraction has only one
consumer, only forwards fields unchanged, or exists solely to accommodate an
unnamed future vendor, delete it. If both traces independently require the same
semantics and tests cannot be expressed without them, keep only that smallest
shared semantic.

## Adversarial conclusion

The council has enough evidence to choose a **comparison boundary**, not a live
avatar:

1. Agent identity, personality, memory, skills, tools, gateway route, turn
   authority, and Fish voice remain Meetmate-owned.
2. Static remains independently executable and byte-preserved.
3. A+E falsifies the Attendee carrier before a managed renderer is blamed or
   credited.
4. A+LiveAvatar LITE tests the strongest documented renderer-only protocol with
   the same source PCM and one audible owner.
5. C runs only for a stated provider/observability/platform discriminator.
6. Failure containment revokes one generation and leaves one bot; it does not
   create a replacement bot speculatively.
7. Three runtime modules plus one test harness are enough. Anything more must be
   justified by measured failure, not vendor-count ambition.
