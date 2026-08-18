# Round 1 — Agent Identity / Memory / Skills Boundary

Status: independent council proposal
Councilor: Agent Identity / Memory / Skills Architect
Date: 2026-07-23
Evidence boundary: `00-evidence-pack.md`, `01-failure-dossier.md`, cited repository lines/commits, and linked official vendor documentation only

## Position

The avatar must be a **replaceable, stateless renderer at the edge of the existing
Fish PCM stream**. OpenClaw/Hermes/Claude-compatible gateway selection and all
agent semantics remain immutable behind the existing Meetmate Agent Core
boundary. A renderer may know how an agent looks and may receive the already
chosen voice waveform, but it must never decide who the agent is, what it
remembers, which skill/tool to invoke, what it says, when a turn ends, or which
gateway handles that turn.

My preliminary order is **E > A > D-LITE > C > B**. Option E is the safest
control. Option A is now the viable documented Attendee live-camera transport.
Within D, the current official LiveAvatar LITE starter establishes a sufficiently
renderer-only protocol to merit a PoC; any FULL managed-agent mode remains
rejected before PoC. Option B is rejected under the current official contract
because Attendee `output_video` queues an HTTPS MP4, not live frames or a WebRTC
track.

This is a boundary recommendation, not an implementation recommendation.

## 1. The immutable ownership model

There must be exactly one authoritative owner for each class of state:

| Concern | Source of truth | Renderer-visible form |
|---|---|---|
| Agent identity and selected agent | Meetmate session/profile resolution | Opaque `render_session_id`; optional non-authoritative appearance key |
| Personality/system instructions | Existing agent profile and gateway request path | Never sent |
| Conversation memory/history | OpenClaw/Hermes/Claude-compatible gateway session, or existing local history fallback | Never sent |
| Skills, tools, delegation, permissions | Existing gateway and Agent Core | Never sent |
| Gateway URL/token/model selection | Existing config/provider/pipeline path | Never sent |
| Turn state, wake/cancel, barge-in, exit | Existing pipeline and transport echo gate | Renderer receives only `audio`, `flush`, `close`; it cannot originate semantic turns |
| Voice identity | Existing profile/Fish selection | PCM output; an opaque appearance mapping may be looked up locally |
| Avatar appearance | Meetmate-owned appearance mapping | Renderer asset/template identifier only |
| Media clocks, queues, A/V sync | Media shell/render adapter | Per-render-session telemetry only |
| Meeting bot lifecycle | Existing meeting transport | Renderer cannot create/leave the conversational agent independently |

Repository evidence already supports this separation:

- A meeting gets a new UUID and keeps selected agent IDs and per-agent
  conversation logs in Meetmate-owned session state
  (`src/transport-meet/meet-routes.js:1137-1162`).
- Gateway warmup uses `meet-${sessionId}-${agentId}`, explicitly preventing one
  agent session from accidentally warming another
  (`src/transport-meet/meet-routes.js:1175-1185`).
- Runtime switching updates gateway URL/token, voice, model, system addendum, and
  the agent-specific gateway session user inside the pipeline
  (`src/pipeline.js:546-574`).
- OpenClaw owns its conversation history; only standalone providers use the
  pipeline's bounded local history (`src/pipeline.js:1850-1868`). Gateway
  credentials and `sessionUser` are passed directly to the selected LLM provider
  (`src/pipeline.js:1898-1913`).
- The actual generated Fish chunks cross the intended boundary at one callback,
  `onAudio(chunk)` (`src/pipeline.js:2207-2227`). This is the only content stream
  a renderer needs.
- The current Attendee transport wraps that output once as
  `realtime_audio.bot_output` with `TTS_SAMPLE_RATE`
  (`src/transport-meet/meet-routes.js:1319-1329`), while input/echo gating stays
  independently owned by the existing transport
  (`src/transport-meet/meet-routes.js:1376-1404`).

Consequently, no option may add avatar-vendor calls to `pipeline.js`,
`llm-provider.js`, gateway implementations, memory/LCM ingest, skill/tool
handling, delegation handling, or profile resolution. “The vendor can also
remember the user” is not a feature in this architecture; it is conflicting
state.

## 2. Session isolation and the renderer capability

The public meeting `sessionId`, gateway `sessionUser`, vendor session ID, and bot
ID are different namespaces and must not be reused interchangeably.

A renderer session should be created by Meetmate with:

```text
render_session_id = random, single-meeting, single-bot, single-appearance
capabilities = { ingest_audio, flush_audio, close, health }
metadata = { sample_rate, channels=1, encoding=s16le, appearance_key }
```

It should not receive:

- the OpenClaw/Hermes/Claude session key;
- gateway URL or token;
- prompts, transcripts, memory records, tool schemas, tool results, or
  delegation events;
- a stable user identifier, email, calendar identity, or cross-meeting memory
  key;
- arbitrary selected-agent configuration;
- authority to write to the conversation log or trigger meeting leave.

The server maintains a private mapping:

```text
meeting session UUID
  -> existing agent/gateway session and transport lifecycle
  -> one ephemeral renderer session
```

Disconnect/reconnect may replace a media connection, but it must not mint a new
agent identity or share one renderer queue across meetings. This follows the
existing single-owner rule where a new primary WebSocket supersedes the previous
one (`src/transport-meet/meet-routes.js:1290-1300`) and leave targets the one
stored bot ID (`src/transport-meet/meet-routes.js:1337-1354`).

For multi-agent meetings, appearance switching is a media event derived from the
already-authoritative `onAgentSwitch` callback
(`src/pipeline.js:555-574`), never a vendor decision. It may change an
`appearance_key`; it must not change gateway, memory namespace, voice, or tool
permissions. If a vendor requires a stable “avatar agent” object carrying
conversation state, that contract is unsuitable.

## 3. Vendor-as-renderer rule

A candidate is renderer-only only if all of the following are demonstrable:

1. Meetmate supplies the final, already-synthesized Fish PCM.
2. The vendor does not run ASR, LLM, TTS, turn detection, memory, tools, or
   moderation that rewrites conversational output.
3. The output is video-only, or returned audio can be deterministically disabled
   so Fish is not heard twice.
4. `flush` drops queued media for an interrupted turn, and `close` invalidates the
   renderer capability.
5. Media telemetry can be correlated by opaque render/turn IDs without sending
   transcript text.
6. A renderer outage degrades to the unchanged static path or loss of animation,
   not loss of Agent Core state.

Official evidence is consistent but incomplete:

- Attendee Voice Agents capture a public page's audio/video at 1280×720:
  https://docs.attendee.dev/guides/voiceagents
- Attendee's `output_video` accepts a public HTTPS MP4 URL plus `loop` and
  `mute_video`. It is not a continuous frame/WebRTC injection contract:
  https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video
- Recall Output Media captures a webpage at 1280×720/15 fps, cannot be combined
  with automatic/output audio or video endpoints, and always includes video:
  https://docs.recall.ai/docs/stream-media
- LiveAvatar FULL explicitly owns ASR/LLM/TTS/WebRTC and therefore violates the
  boundary. LITE requires customer STT/LLM/TTS/WebRTC. Its official starter
  establishes `start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt`
  over a backend audio WebSocket using base64 raw PCM S16LE mono at 24 kHz; the
  frontend is video-only, and the same upstream TTS frames are tee'd to avatar
  and normal downstream audio:
  https://docs.liveavatar.com/ and
  https://github.com/heygen-com/liveavatar-starter-livekit-agent-python
- Tavus Echo accepts pre-generated audio and is a legitimate renderer-only
  candidate, but synchronized returned audio and cancellation still require PoC:
  https://docs.tavus.io/sections/conversational-video-interface/echo-mode

Marketing labels such as “LITE,” “Echo,” or “external TTS” do not satisfy this
rule by themselves. The wire contract and observed behavior do.

## 4. Provider leakage threats

The main architectural failure mode is not visual quality; it is a renderer
quietly becoming a second agent platform.

| Leakage | Consequence | Required prevention |
|---|---|---|
| Transcript/prompt sent “for lip sync” | Personality and meeting content leave the gateway boundary | Audio-only renderer input; reject text-required animation |
| Stable gateway/session ID reused as vendor ID | Cross-meeting correlation and confused ownership | Random per-render-session ID; private mapping only |
| Vendor TTS enabled beside Fish | Two voices, duplicate billing, different persona | Vendor TTS disabled by contract and observed packet/audio test |
| Vendor turn detector queues speech after barge-in | Existing abort semantics no longer authoritative | Explicit queue flush with measured silence after cancel |
| Vendor avatar object stores memory | Divergent memory and deletion semantics | No vendor conversational memory; delete ephemeral render session |
| Raw profile/config passed to webpage | Token, tool, or identity disclosure | Allowlisted appearance/media fields only |
| Vendor callback interpreted as a tool event | Remote renderer gains agent authority | Adapter accepts media health/timing only |
| Shared browser/page singleton | Audio or appearance crosses sessions | One isolated page/renderer queue per bot session |

Returning synchronized audio is especially dangerous: it may be technically
necessary for some avatar products, but it creates a second output authority.
Unless the meeting transport can use that returned track as the *only* audible
copy while proving byte/content lineage from Fish and preserving cancellation,
the candidate is rejected. A “mute one of the two and hope” design is not an
acceptable invariant. LiveAvatar LITE avoids this particular ownership conflict:
its documented frontend is video-only and the backend tees the same 24 kHz Fish
frames to renderer and normal downstream audio. Its risk is instead temporal:
the documented initial renderer buffer can make video lag immediately played
meeting audio.

## 5. Minimal module boundaries

Do not build a generic avatar plugin framework. Phase 1 needs three narrow
boundaries, owned outside Agent Core:

1. **Media tap** — observes the existing Fish `onAudio(chunk)` output and assigns
   monotonic chunk/turn timestamps. It does not parse text or call a vendor.
2. **Media shell** — one bounded per-session queue with `pushPcm`, `flush`,
   `close`, clock/underrun/A/V metrics, and a deterministic fan-out of the exact
   same Fish bytes to one audible meeting sink plus one silent/video renderer
   sink. It may delay meeting playout to align A/V, but may not synthesize again.
3. **One experiment adapter per compared path** — concrete Attendee webpage,
   Attendee video injection, Recall webpage, remote renderer-only API, or local
   renderer transport. Each exposes the same *small* media lifecycle, without
   discovery, dynamic registration, dependency injection containers, vendor
   config schemas, or a generalized “capability marketplace.”

The static route must continue to construct exactly the current payload
(`src/transport-meet/meet-routes.js:1206-1219`). The PoC can select a separate
live branch before bot construction; it must not make static behavior pass
through the new media shell. This keeps rollback structural rather than
configuration-dependent.

The shell must not own agent selection, Fish synthesis, STT, gateway calls, turn
logic, or meeting lifecycle. Its interface is intentionally too weak to become
Agent Core:

```text
open(render_session_id, media_format, appearance_key)
pushPcm(turn_id, sequence, captured_at, bytes)
flush(turn_id, reason)
close(reason)
health() -> media-only counters
```

For LiveAvatar LITE the concrete mapping is narrow and explicit:
`open -> start`, `pushPcm -> agent.speak`, end-of-Fish-turn ->
`agent.speak_end`, and abort -> stop the local send loop plus
`agent.interrupt`. Sending must wait for `session.state_updated: connected`;
close must explicitly delete the vendor session to prevent an orphan and
continued billing. These protocol details belong only in that concrete adapter,
not in a generic renderer abstraction.

## 6. Option comparison through the identity boundary

### Option A — Attendee webpage voice agent

This keeps the web renderer under Attendee's meeting participant but changes the
live bot payload and browser audio path. It can preserve Agent Core if the page
gets only PCM plus an appearance key. It has a larger double-routing risk than B:
the existing realtime audio must not also emit the same Fish stream if page audio
is captured.

**Adopt for the comparison PoC if:** Attendee confirms page capture behavior,
microphone/autoplay works without user interaction, live and static payloads are
structurally separate, and a single audible Fish path plus cancel flush can be
demonstrated. With LiveAvatar LITE, tee the exact current 24 kHz Fish S16LE mono
frames—no second TTS and no resampling—to both the page's one meeting-audio path
and the renderer WebSocket, then measure/deliberately compensate the renderer's
initial buffering.

**Reject immediately if:** `voice_agent_settings` requires moving STT/LLM/TTS or
identity into the page; it cannot coexist with required meeting input; the page
needs gateway/session credentials; or duplicate output cannot be excluded.

### Option B — current Attendee audio plus separate video injection

B would have preserved current input, echo gate, Fish generation,
`realtime_audio.bot_output`, bot ownership, and static behavior while adding only
video. The official contract now disproves that live path: `output_video` accepts
an HTTPS MP4 with optional loop/mute flags and queues prerecorded media. Repeated
MP4 replacement would be a speculative, discontinuous mechanism with no shared
A/V clock.

**Adoption condition:** none under the current contract. Reconsider only if
Attendee publishes a continuous live camera-output API and it passes the original
coexistence, queue, flush, cleanup, and A/V timing gates.

**Immediate rejection condition (met):** the endpoint is prerecorded-file
playback rather than a continuous live injection surface. It may be tested for a
looping-animation use case, but that is not Option B's live avatar.

### Option C — Recall Output Media webpage

C can keep identity out of Recall, but it replaces more of the known transport
surface and exposes the Fish stream to a browser capture path. Recall's documented
Output Media resource/combination constraints enlarge the operational boundary.
It should be a measured comparator, not the default recovery path.

**Adopt for the comparison PoC if:** a fresh minimal page receives only PCM and
appearance; direct Recall meeting input remains separate; `web_4_core` and the
default variant are measured; actual AudioContext rates, queue depth, underruns,
cancel flush, and meeting playout are captured.

**Reject immediately if:** Output Media forces Recall-managed ASR/LLM/TTS,
requires stable user identity/transcript, cannot separate input from output, or
cannot expose enough diagnostics to attribute failure.

### Option D — managed avatar service

FULL modes are outside the architecture. LiveAvatar LITE now has direct official
protocol evidence for a renderer-only boundary: existing 24 kHz S16LE mono Fish
frames enter `agent.speak`, `agent.speak_end` closes the turn, and
`agent.interrupt` supports cancellation; the frontend is video-only. It therefore
does not require a second TTS or a second audible track. Tavus Echo remains a
separate renderer-only candidate with returned-audio ambiguity.

**Adopt a D sub-option for the comparison PoC if:** the signed/current API
contract accepts existing Fish PCM, every brain feature is bypassed, no text or
memory is required, and flush/session deletion are measured. LiveAvatar LITE
meets the protocol-level PCM/no-second-TTS gate; it must still prove that its
roughly 400–600 ms first renderer buffer and later roughly 1 s framing can meet
end-to-end latency and A/V skew needs. The shell must either add a bounded delay
to the sole meeting-audio path or reject LITE if synchronization costs too much.

**Reject immediately if:** ASR, LLM, TTS, turn-taking, memory, tools, or vendor
agent identity is mandatory; Fish must be regenerated; cancel cannot purge
queued speech; a second audible avatar track is captured; events must be sent
before the documented connected state; vendor sessions cannot be explicitly
deleted; or the contract relies on obsolete HeyGen Interactive Avatar examples.

### Option E — vendorless lightweight renderer

E has the strongest identity, privacy, and session-isolation properties. It can
consume local PCM amplitude/visemes without sending content or stable identifiers
to another party, and it gives a control for separating “avatar rendering”
problems from vendor/browser transport problems. Its tradeoff is appearance, not
agent architecture.

**Adopt as the mandatory control if:** it can run within the selected
Attendee/meeting video path, keep bounded CPU/queue behavior, flush on barge-in,
and reach an agreed minimum visual quality after baseline measurement.

**Reject as the final product, but retain as control, if:** stakeholders require
photorealism it cannot provide or its CPU use materially damages measured audio.
Reject it entirely only if it cannot produce a live meeting video through any
supported transport.

## 7. What is different from the historical Recall branch

The new comparison must not revive `origin/feat/recall-ai`.

Historical facts that matter to the boundary:

- `d3d86d7` changed provider branching and browser input/output together before
  static behavior had a regression contract. It also guessed a
  `ws://localhost:8080` subscription rather than using a proven contract.
- The browser created one `AudioBufferSourceNode` per chunk with a single
  `playCursor`, but no bounded queue, media clock, underrun counter, cancellation
  purge, or meeting playout timestamps.
- `b5fbff1` then added browser capture/manual downsampling;
  `0cd1e52` changed capture scheduling; `02ece31` removed browser input and kept
  browser output. These steps changed failure domains across trials instead of
  holding the agent and transport boundaries fixed.
- `b9549f6` later enabled the required raw-audio artifact, proving initial setup
  was incomplete.
- `bbe1544` mixed Fish model/prompt/tag changes into the transport experiment;
  `de1d03e` reverted the bundle without an operational reason.

The new PoC differs by keeping current Soniox input and current 24 kHz Fish PCM
fixed, tapping the single existing Fish output once, giving the renderer no agent
semantics, changing one transport/render variable at a time, and using recorded
identical PCM for cross-option comparison. The old branch assumed a 16 kHz-era
path; current defaults are 16 kHz input and 24 kHz TTS
(`src/config.js:8-16`, `src/config.js:316-353`).

No historical symptom or root cause is claimed: heard noise, dropouts, wrong
speed, latency, actual AudioContext rates, instance variant, and abandonment
reason remain unknown. The absence of retained measurements means Recall is
neither exonerated nor convicted.

## 8. Unknowns that block a production recommendation

1. Does Attendee `output_video` support sustained realtime participant-camera
   injection, and can it coexist with current WebSocket audio?
2. Can Attendee Voice Agents and current meeting-input requirements coexist
   without duplicate output or a second resampling path?
3. What actual AudioContext rates/states occur in Attendee and Recall containers?
4. LiveAvatar LITE's format and video-only frontend are established. What are its
   measured first-frame delay, p50/p95 A/V skew, interruption purge latency, and
   orphan-session behavior under disconnect/reconnect?
5. Can Tavus Echo disable or safely make authoritative its returned audio?
6. What data each vendor retains, for how long, and whether render sessions and
   derived biometrics can be deleted independently of agent memory.
7. How appearance assets are licensed and whether a vendor uses meeting audio for
   training; no candidate passes procurement without contractual answers.
8. Whether a local renderer can meet visual expectations and CPU limits on the
   Mac mini baseline.
9. The missing historical artifacts listed in the failure dossier (recordings,
   logs, Recall CPU/variant data, HeyGen session/API version).

## 9. Preliminary weighted score

Scores are architectural priors from 1 (poor) to 5 (strong), not measured
performance. “Operational evidence” scores contract clarity/known integration
surface, not audio or visual quality.

| Criterion | Weight | A | B | C | D-LITE | E |
|---|---:|---:|---:|---:|---:|---:|
| Agent boundary / single source of truth | 30% | 4.5 | 5.0 | 4.0 | 4.5 | 5.0 |
| Session isolation / least disclosure | 20% | 4.0 | 5.0 | 3.5 | 3.5 | 5.0 |
| Static/Fish path preservation | 15% | 3.0 | 5.0 | 2.5 | 4.0 | 4.5 |
| Cancel, queue, and output-authority fit | 15% | 3.5 | 4.0 | 2.5 | 4.0 | 4.0 |
| Current official contract evidence | 10% | 4.0 | 1.0 | 4.0 | 4.5 | 4.0 |
| Provider leakage/privacy exposure | 10% | 3.5 | 4.5 | 3.0 | 3.0 | 5.0 |
| **Weighted total / 5** | **100%** | **3.88** | **4.40*** | **3.35** | **4.00** | **4.68** |

\* B's numerical boundary score is counterfactual: it describes how attractive
the architecture would be if a continuous endpoint existed. It is
**disqualified**, regardless of weighted total, because the required live-video
capability does not exist in the official contract.

Interpretation:

- **E is mandatory as a control**, not automatically the final visual choice.
- **A is the preferred production-shaped Attendee PoC** because its page capture
  path is documented, but it must prove one-audio-path behavior and acceptable
  A/V delay.
- **B is rejected now**; vendor confirmation cannot override the documented MP4
  body without a new official continuous-output contract.
- **C is valuable specifically to retest the historical class of design under
  controlled, observable conditions**, not because the old branch established
  suitability.
- **D-LiveAvatar LITE is a qualified renderer PoC**, not a managed-agent PoC. Its
  native 24 kHz protocol and video-only frontend preserve Fish ownership, while
  buffer/skew and lifecycle behavior remain experimental. A FULL managed avatar
  scores zero on the agent-boundary criterion and is rejected without weighted
  consideration.

Scores must be replaced, not merely adjusted rhetorically, after baseline and PoC
measurements. Any candidate that cannot expose the required timestamps, queue
depth, underruns, A/V skew, reconnects, barge-in result, echo/duplicate-audio
incidence, CPU, and memory fails regardless of visual appeal.

## 10. Round 1 recommendation

Advance E as the identity-safe control and A as the documented meeting-render
transport. Use LiveAvatar LITE as the leading D renderer inside that measured
path: tee identical existing Fish frames, never synthesize twice, keep exactly
one audible meeting path, and make interrupt/delete lifecycle behavior explicit.
Admit C only as a fresh, instrumented historical comparator. Reject B until
Attendee publishes a new continuous live camera-output contract.

The adoption gate common to every option is simple: **the renderer can disappear
without taking personality, memory, skills, tools, gateway session, current
conversation state, or the unchanged static audio path with it**. If that
statement cannot be demonstrated under disconnect, reconnect, barge-in, and exit,
the option is not a renderer and must be rejected.
