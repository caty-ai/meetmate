# Round 4 — Revised Agent Boundary Proposal

Status: revised proposal after adversarial debate
Councilor: Agent Identity / Memory / Skills Architect
Date: 2026-07-23
Decision scope: adopt-now decision and at-most-two comparison PoC

## Revised conclusion

**Adopt now:** no live-avatar architecture. Keep the current static Attendee path.

**Approve for comparison PoC:** at most two complete compositions, in this order:

1. **A+E** — Attendee webpage carrier plus a bounded local calibration renderer.
2. **A+LiveAvatar LITE** — the same carrier and source envelope plus the strongest
   currently documented renderer-only managed protocol.

Both are conditional on a smaller avatar-free A carrier calibration passing
first. C+E and C+LITE are ranked below them and are not automatically authorized
as a third lane. C may replace an A-based lane only after a named Attendee
carrier/observability/platform discriminator fails and the council explicitly
reopens the comparison.

Option B and every FULL brain-owning mode are **disqualified**, not low-scoring:

- B has no official continuous live camera-output contract; Attendee
  `output_video` accepts a public HTTPS MP4 plus loop/mute flags
  ([official endpoint](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video)).
- LiveAvatar FULL, Tavus FULL CVI, and equivalent modes own conversational layers
  that must remain in Meetmate Agent Core
  ([LiveAvatar overview](https://docs.liveavatar.com/),
  [Tavus CVI overview](https://docs.tavus.io/sections/conversational-video-interface/overview-cvi)).

This is authorization to measure two compositions, not to ship either.

## 1. What changed in my opinion

### Change 1 — A carrier calibration now precedes A+E

Round 1 and Round 2 treated A+E as the first useful control. The meeting-bot,
vendor, DSP, and skeptic Round 3 arguments are stronger: E is not needed to
falsify Attendee webpage audio. A disposable page can play frozen Fish-format
PCM through a bounded queue and render deterministic flashes. If observer-side
audio already regresses, building even a small avatar confounds the result.

I therefore add a non-candidate prerequisite:

```text
static fixture baseline -> avatar-free A carrier calibration
                           -> only then A+E and A+LITE
```

### Change 2 — I no longer rank renderers without their carrier

My early order `E > A > D-LITE > C > B` mixed transport and renderer layers.
Round 2/3 correctly established that A/C are carriers and E/LITE are renderers.
This revision scores only A+E, A+LITE, C+E, and C+LITE.

### Change 3 — module count is smaller and staged

I previously said three runtime modules plus one harness were the comparison
minimum. That is the maximum for the selected two-composition PoC, not the
minimum first step:

- A calibration and A+E need **two runtime responsibility units plus one
  test-only harness**.
- A+LITE adds **one concrete runtime adapter**, for a maximum of three runtime
  units plus the same harness.

The local E control remains a few deterministic page routines, not a provider
module.

### Change 4 — “fallback to static” is narrowed

I withdraw any wording that could imply automatic in-session degradation to the
unchanged static bot. Safe rollback means:

- new sessions select static before bot construction without contacting a live
  vendor; and
- an active live session is contained, queues/generation are revoked, and its one
  bot is asked to leave.

A replacement static bot is not created until original absence is independently
confirmed under a separately proven handoff. The comparison PoC does not attempt
that handoff.

### Change 5 — B receives no counterfactual score

Round 2 correctly criticized a numerically strong but disqualified B. The
official MP4 contract closes the current gate. B is listed as DQ, not weighted.

### What did not change

Agent identity, personality, memory, skills, tools, delegation, gateway route,
turn authority, Fish voice, and meeting-session ownership remain entirely in
Meetmate. A renderer receives only ephemeral media capability, appearance, PCM,
and authoritative media controls.

## 2. Non-negotiable authority boundary

| Authority/state | Sole owner | Renderer visibility |
|---|---|---|
| Meeting session UUID and selected agents | Meetmate meeting route | No stable ID; only a random render capability |
| Gateway session and route | Existing pipeline/provider | Never visible |
| Personality/system prompt | Existing profile/gateway | Never visible |
| Conversation memory/history | OpenClaw/Hermes/Claude-compatible gateway or existing standalone fallback | Never visible |
| Skills, tools, delegation, permissions | Existing Agent Core/gateway paths | Never visible; vendor callbacks cannot dispatch |
| Wake, barge-in, cancel, exit | Existing pipeline and echo gate | Receives derived `end`, `interrupt`, `close` only |
| Voice/content | One existing Fish synthesis | Already-generated PCM only |
| Appearance | Meetmate-owned mapping | Opaque asset/appearance capability |
| Media generation, queue, A/V timing | Live-only bridge/page/adapter | Ephemeral per-session state |
| Meeting bot lifecycle | Existing meeting transport | No authority to create a second conversational bot |

Repository facts support the boundary:

- Meetmate creates and stores the meeting UUID and selected-agent session state
  (`src/transport-meet/meet-routes.js:1137-1162`).
- Agent switching owns gateway URL/token, voice, model, system addendum, and
  agent-scoped session identity inside the pipeline
  (`src/pipeline.js:546-579`).
- OpenClaw owns conversation history while standalone providers use the existing
  bounded fallback (`src/pipeline.js:1850-1868`).
- Gateway requests receive session/model/credentials inside the provider path
  (`src/pipeline.js:1898-1913`).
- Fish crosses the intended media seam once at `onAudio(chunk)`
  (`src/pipeline.js:2207-2227`).

The live data flow is one-way semantically:

```text
Agent Core -> media:
  PCM, authoritative end/cancel/close, appearance change

media -> Agent Core:
  ready/failure/timing only
```

Vendor error text is untrusted diagnostics. It cannot become a user turn, model
context, memory, tool result, delegation result, agent switch, or permission
decision.

## 3. Session, generation, and output ownership

The following namespaces remain distinct:

1. Meetmate `meeting_session_id`;
2. agent-specific gateway `sessionUser`;
3. meeting-provider `bot_id`;
4. random, short-lived `render_session_id`;
5. monotonically increasing live `generation`.

Only Meetmate stores the mapping. The page gets a single-use, short-lived,
audience-bound capability, not a gateway key or stable user identity.

Every media item is keyed by:

```text
(render_session_id, generation, turn_id, sequence)
```

The bot generation selects exactly one immutable audible owner:

```text
STATIC_WEBSOCKET  # current realtime_audio.bot_output
LIVE_PAGE         # page AudioContext/capture is the only audible egress
```

A live generation cannot also emit current WebSocket bot output. Immediate and
video-aligned delayed page paths cannot coexist. Renderer-returned audio cannot
coexist with the page Fish path. A stale generation is rejected before queueing.

On page/renderer failure:

1. revoke the current generation and stop new PCM;
2. flush local queues and reject late packets;
3. best-effort interrupt/delete the renderer with bounded retries;
4. request leave once for the stored live bot;
5. record an orphan incident if deletion/absence is unconfirmed;
6. disable new live creation locally;
7. keep subsequent sessions on the independent static route.

The current primary-WebSocket replacement and one-bot leave behavior
(`src/transport-meet/meet-routes.js:1290-1300`, `1337-1354`) are useful
precedents, not proof that page/vendor recovery already works.

## 4. Static byte and operational preservation

The current static payload block remains exactly
`src/transport-meet/meet-routes.js:1206-1219`, including the separately loaded
image behavior at `src/transport-meet/meet-routes.js:823-863`.

The live path must be selected before bot construction and must not:

- add conditionals inside the current static payload block;
- require live credentials or live config validation for static startup;
- initialize/import a vendor SDK on the static path;
- start live queues, timers, retry loops, listeners, or cleanup hooks;
- add a live dependency to health checks;
- share bot IDs, render sessions, or mutable singletons with static;
- contact any renderer when live mode is disabled.

The regression prerequisite uses deterministic fixture inputs to compare the
serialized static request byte-for-byte. It also tests startup and lifecycle
with all live credentials absent and endpoints blackholed. Payload equality
alone is insufficient.

## 5. Revised composite ranking

### Scoring method

The required weights total exactly 100:

| Criterion | Weight |
|---|---:|
| Fish integrity | 25 |
| Agent identity / brain boundary | 20 |
| Static isolation / diff size | 15 |
| Latency / A/V behavior | 15 |
| Meeting stability | 10 |
| Cost / privacy / operations | 10 |
| Replaceability | 5 |
| **Total** | **100** |

Each composite receives 0–5 per criterion. Weighted points are
`score / 5 × weight`. Unknown end-to-end behavior receives 1–2 rather than a
neutral 3. A documented ingress format earns credit only in its criterion; it
does not earn unmeasured latency, deletion, privacy, or meeting-quality points.
Hard gates override totals.

### Evidence/readiness score

| Rank | Composite | Fish 25 | Identity 20 | Static/diff 15 | Latency/A-V 15 | Meeting stability 10 | Cost/privacy/ops 10 | Replaceability 5 | Total /100 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **A+E** | 3.0 → 15.0 | 5.0 → 20.0 | 3.0 → 9.0 | 2.0 → 6.0 | 2.0 → 4.0 | 4.0 → 8.0 | 4.0 → 4.0 | **66.0** |
| 2 | **A+LiveAvatar LITE** | 3.5 → 17.5 | 4.5 → 18.0 | 2.5 → 7.5 | 1.0 → 3.0 | 1.5 → 3.0 | 1.0 → 2.0 | 2.0 → 2.0 | **53.0** |
| 3 | **C+E** | 2.0 → 10.0 | 5.0 → 20.0 | 1.5 → 4.5 | 2.0 → 6.0 | 2.5 → 5.0 | 2.0 → 4.0 | 3.0 → 3.0 | **52.5** |
| 4 | **C+LiveAvatar LITE** | 3.0 → 15.0 | 4.5 → 18.0 | 1.0 → 3.0 | 1.0 → 3.0 | 1.5 → 3.0 | 1.0 → 2.0 | 1.5 → 1.5 | **45.5** |

### Why the ranking is this conservative

#### 1. A+E — 66.0

E has the cleanest identity, privacy, cancellation, and replacement boundary,
but the composite still inherits A's unmeasured browser rate, resampling, page
capture, WebRTC, meeting codec, reconnect, and platform behavior
([Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents)). It has
no measured Mac mini/browser load or agreed production visual floor. The 66 is a
control-readiness score, not proof that it will sound or look acceptable.

#### 2. A+LiveAvatar LITE — 53.0

LITE earns more Fish credit because its official starter matches current 24 kHz
mono S16LE, exposes speak/end/interrupt, tees upstream TTS, and uses a video-only
frontend
([official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python)).
It loses elsewhere because A still owns meeting audio while LITE adds a remote
render clock, session, credential, likeness processor, deletion/billing state,
and split A/V timing. The reference's 400–600 ms first and roughly one-second
later aggregation are feed behavior, not measured meeting latency.

#### 3. C+E — 52.5

C offers explicit Google Meet/Zoom support, 1280×720 at 15 fps, DevTools, CPU
metrics, and a `web_4_core` discriminator
([Recall Output Media](https://docs.recall.ai/docs/stream-media)). E keeps brain
and renderer control local. The composite nevertheless changes the meeting
provider, revives the historically confounded browser-output topology, adds
compute/cost choice, and has no measured current quality. It is valuable when
the question is specifically “is A's carrier the problem?”, not as an automatic
third candidate.

#### 4. C+LiveAvatar LITE — 45.5

This composition combines the broadest unmeasured surface: changed meeting
provider, Recall browser/container clocks, a remote avatar renderer clock,
multiple credentials and billing domains, and two remote cleanup lifecycles. It
retains the same good LITE brain boundary but is a poor first attribution
experiment. It should run only after carrier and renderer effects are separately
measured.

### Disqualified

| Candidate | Status | Reason |
|---|---|---|
| B + any live renderer | **DQ** | Attendee currently accepts queued HTTPS MP4, not continuous live video |
| LiveAvatar/Tavus/D-ID-style FULL agent | **DQ** | Vendor owns or requires LLM/STT/TTS/turn/session authority |
| Any renderer requiring text/vendor TTS | **DQ** | Violates one Fish source and brain boundary |

## 6. Exact maximum-two PoC

### Prerequisite 0 — immutable baseline

Before any live runtime work:

- capture the deterministic serialized static payload and `bot_image` behavior;
- record current Fish request/first PCM, first audible meeting output, response
  latency, sample counts/cadence, audio quality, echo, barge-in/cancel, reconnect,
  long response, exit, and leave;
- freeze a current 24 kHz Fish S16LE test corpus and scripted turn/failure events;
- define acceptance thresholds only after baseline measurement;
- keep source, prompts, Soniox, gateway, Fish model/settings, and agent fixed.

### Prerequisite 1 — avatar-free A carrier falsification

Use a disposable Attendee page with:

- one bounded clock-driven PCM queue;
- actual AudioContext rate/state and local queue timestamps;
- deterministic flashes tied to source sample indices;
- current WebSocket output disabled for the live bot;
- observer recording for audio, A/V timing, duplicate output, cancel, and
  reconnect.

Stop the phase if A materially degrades audio, has two output owners, cannot
flush stale media, or cannot expose enough evidence. Do not build E/LITE around a
failed carrier.

### PoC composition 1 — A+E

Add only a bounded three-state mouth/flash renderer to the same page. It is a
calibration/control, not a product avatar system. Measure browser load,
observer-side A/V skew, audio regression, cancel tail, reconnect generation, and
one-owner behavior.

### Prerequisite 2 — off-meeting LITE protocol probe

Using synthetic/consented likeness and non-confidential fixture PCM:

- use a disposable least-privileged project and server-held credential;
- enforce duration, retry, concurrency, and spend caps;
- send no transcript, prompt, memory, tool, gateway/user identity, or microphone;
- wait for connected; test speak/end, local send-stop plus interrupt, and
  explicit deletion;
- confirm video-only frontend and no second audible track;
- retain unknown where remote acceptance/queue/presentation metrics do not exist.

### PoC composition 2 — A+LiveAvatar LITE

Use the same A page, fixture, event envelope, observer, and thresholds. Tee one
source PCM lineage to the sole page-audio queue and the LITE adapter. Compare
immediate audio with at most one explicitly bounded delay condition; report added
response latency separately from A/V skew. Test connected-state loss, cancel,
page reconnect, renderer reconnect, lost delete response, and vendor failure.

### C substitution gate

C is not a third automatic experiment. Reopen a C+E probe only if at least one is
true:

- A cannot expose enough browser/CPU/media timing to locate a failure;
- A cannot provide required Google Meet/Zoom behavior;
- A cannot preserve a single live input/output topology;
- A shows a measured carrier-specific defect that a provider comparison can
  discriminate.

Run C+E first, fresh, on default and `web_4_core`. C+LITE requires a further
decision after C+E and A+LITE isolate both carrier and renderer effects.

## 7. Exact minimal modules

### For A calibration and A+E: two runtime units

1. **Concrete live-session bridge**

   - creates ephemeral `render_session_id` and short-lived page capability;
   - owns generation, turn, sequence, immutable output owner, and one Fish tap;
   - emits PCM/end/cancel/close;
   - accepts allowlisted readiness/timing/error events only;
   - revokes generation and coordinates one bot leave.

2. **Concrete Attendee live page**

   - owns the only audible live playout queue;
   - forwards the explicitly selected live meeting input to existing Meetmate
     processing without gaining turn authority;
   - reports actual browser clock/queue/frame facts;
   - rejects stale generations and flushes by turn;
   - contains the tiny E three-state calibration renderer directly.

### For A+LITE: add one runtime unit

3. **Concrete LiveAvatar LITE adapter**

   - maps connected/start/speak/speak-end/interrupt/delete;
   - receives only the small PCM/control envelope and opaque appearance
     capability;
   - stops local sends on the same cancel generation;
   - exposes only observed events and labels remote queue facts unknown.

### One shared test-only harness

- replays the frozen corpus and scripted fault sequence;
- counts synthesis and hashes/sample sequences at locally observable points;
- records actual browser rate, queue, CPU, meeting-observer audio/A-V, cancel
  tail, duplicate output, reconnect, and cleanup;
- asserts static bytes/startup isolation and no agent/tool data leakage.

This is the exact maximum scope: **two runtime units for A+E, three for the full
two-composition comparison, plus one test-only harness**.

### Explicitly rejected abstractions

- `AvatarProvider` or renderer class hierarchy;
- provider registry/plugin discovery;
- dependency-injection container or capability negotiation;
- common vendor configuration schema;
- generic cross-provider lifecycle/health/retry engine;
- generalized media/billing/telemetry platform;
- automatic Attendee↔Recall failover;
- persistent renderer memory, persona synchronization, or new profile/session
  source of truth;
- generic viseme/phoneme/asset framework;
- any avatar call inside pipeline, gateway providers, memory/LCM, skills/tools,
  delegation, or profile resolution.

Only this envelope is shared now:

```text
{ render_session_id, generation, turn_id, sequence,
  first_sample_index, source_monotonic_at, sample_rate, pcm }
end(turn_id)
cancel(turn_id)
close(reason)
```

It exists to make this comparison falsifiable, not to onboard future vendors.

## 8. Hard gates and remaining unknowns

### Immediate rejection gates

- second Fish/vendor TTS generation;
- prompt, transcript, memory, stable user, gateway, tool, or turn authority at
  the renderer;
- two meeting bots or audible owners during normal, delayed, reconnect, cancel,
  failure, or rollback conditions;
- stale old-generation media after cancel/reconnect;
- unbounded local queue or no utterance-scoped flush;
- static payload/startup/lifecycle depends on live code/vendor;
- no observer-side audio/A-V/cancel evidence;
- durable browser-visible credential;
- managed session cannot be bounded and explicitly closed;
- FULL mode or B's repeated-MP4 pseudo-stream.

### Facts

- Current Fish has one output seam and defaults to 24 kHz.
- LITE's documented ingress matches that PCM and its frontend is video-only.
- A and C capture webpages into meetings.
- B's current endpoint is prerecorded MP4.
- Historical Recall lacked the measurements needed to determine root cause.

### Unknowns penalized in scoring

- actual A/C browser clocks, resampling, autoplay, capture, codec, CPU, and
  platform parity;
- current static baseline distributions and acceptance thresholds;
- E visual floor, license, and Mac mini/browser resource use;
- LITE render delay, accepted-sample/queue evidence, interrupt purge,
  reconnect/idempotency, delete/billing reconciliation, cost, retention,
  training, regions, subprocessors, and likeness rights;
- safe participant-absence confirmation for any future in-session replacement;
- whether a second measured adapter reveals a justified common abstraction.

## 9. Minority concerns retained

The skeptic's minority concern should remain prominent: even “A+E PoC” can sound
too feature-shaped. The only justified first write is a disposable A carrier
falsification page. If A fails, the correct result may be **zero live runtime
modules** and continuation of static—not a pivot into a larger C or vendor
platform.

A second minority concern comes from the vendor/meeting reviews: C may deserve a
small carrier run even when A appears to pass if explicit Google Meet/Zoom parity
or provider-level observability is a decision requirement. My vote keeps C
conditional because the user asked for at most two PoC compositions; the chair
should record that this sacrifices some cross-provider diagnostic confidence.

Finally, if photorealism is an immutable product requirement, bounded E may be
only calibration and not a shippable candidate. That does not remove its value
as the cleanest A/V and carrier control, but it changes how its 66.0 score should
be interpreted.

## 10. Vote

| Decision | Vote |
|---|---|
| Adopt a live avatar now | **No** |
| Keep current static path as production default | **Yes** |
| Approve avatar-free A carrier calibration | **Yes** |
| Approve at most two comparison PoC compositions after prerequisites | **Yes: A+E and A+LiveAvatar LITE** |
| Automatically run C as a third comparison | **No** |
| Reconsider C on a named substitution gate | **Yes, by a new explicit decision** |
| Prototype B repeated-MP4 injection | **No / DQ** |
| Evaluate any FULL vendor-agent mode | **No / DQ** |

The recommendation is intentionally reversible: prove the carrier, compare one
local and one managed renderer using the same source and authority boundary, and
stop at the first failed hard gate. No amount of visual quality compensates for
a second brain, second voice, changed static path, stale generation, unsafe bot
replacement, or an unobservable failure.
