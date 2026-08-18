# Round 2 — Cross Review: Agent Identity / Memory / Skills Boundary

Status: cross-review, not an implementation decision
Councilor: Agent Identity / Memory / Skills Architect
Date: 2026-07-23
Reviewed: all five Round 1 council proposals

## Updated position

The five proposals substantially agree on the invariant and differ mainly in
experimental order and how much infrastructure a comparison PoC deserves.

My Round 1 recommendation survives, but with two corrections:

1. **A is a meeting carrier, while E and LiveAvatar LITE are renderers.** Treating
   A, D, and E as mutually exclusive hides the actual composition. The useful
   comparison is static baseline versus **A+E** versus **A+LiveAvatar LITE**.
2. A named, reusable “Media Shell” is too easy to future-proof prematurely. The
   PoC needs a frozen PCM replay harness, one small event envelope, and concrete
   adapters. It does not yet need a plugin framework, provider registry, generic
   lifecycle engine, or a new source-of-truth object.

Option B remains rejected because Attendee's current `output_video` contract is
HTTPS MP4 playback, not continuous live camera injection
([official endpoint](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video)).
Option C remains a fresh, instrumented falsification of the old Recall topology,
not a branch revival. FULL avatar modes remain rejected because they duplicate
Agent Core.

## 1. Cross-review of the other proposals

### Councilor 1 — Meeting Bot / WebRTC

**Strongest point.** The proposal correctly decomposes the problem into meeting
transport and renderer and makes one meeting-output owner explicit. Its
lifecycle analysis is the best of Round 1: renderer readiness, page reconnect,
meeting rejoin, provider WebSocket replacement, drain, leave, and stale replay
are distinct transitions. That is consistent with the current single-owner
replacement behavior (`src/transport-meet/meet-routes.js:1290-1300`) and the
single stored-bot leave path (`src/transport-meet/meet-routes.js:1337-1354`).
Its insistence that static and live bot construction branch before payload
creation protects the current static contract at
`src/transport-meet/meet-routes.js:1206-1219`.

**Strongest rebuttal.** The proposed lifecycle state machine and full Media Shell
responsibility list risk becoming production architecture before the PoC proves
that A's browser carrier is usable. “Input ready,” “renderer ready,” “draining,”
reconnect generations, automatic instrumentation, and provider-neutral video
states are all sensible eventually, but a generic implementation now would
encode unverified commonality across Attendee, Recall, and LiveAvatar. For the
comparison, state should remain local to each concrete adapter; only timestamps,
sequence/epoch, cancel, and close have demonstrated cross-candidate value.
Cross-provider automatic failover is rightly excluded.

### Councilor 2 — Realtime Audio / DSP

**Strongest point.** This proposal gives the most falsifiable media invariant:
stamp the Fish stream once with utterance ID, chunk sequence, first-sample index,
and monotonic timestamp; prove identical source bytes using byte counts or a
rolling hash; and measure cumulative source versus rendered samples. This
directly protects the existing single synthesis seam at
`src/pipeline.js:2207-2227` and the one current Attendee wrapper at
`src/transport-meet/meet-routes.js:1319-1329`. It also correctly measures cancel
at both audio and video tails rather than assuming `abort()` means media stopped.

**Strongest rebuttal.** Not every metric named in the DSP proposal belongs in a
shared runtime module. Peak/extrema/NaN counters, ring-buffer watermarks,
forced-aligned phonemes, flash calibration, drift slope, and rolling hashes are
excellent harness instrumentation, but making them permanent Media Shell
responsibilities would overbuild the product boundary. A PoC should retain raw
events sufficient to compute these offline and implement only the queue/cancel
controls necessary for the candidate under test. The AudioWorklet/ring-buffer
choice should also follow measured Attendee runtime behavior, not become an
architecture requirement before the actual `AudioContext` rate and scheduler are
observed.

### Councilor 3 — Avatar / Vendor Integration

**Strongest point.** The vendor proposal materially strengthens the managed
renderer case with current contracts rather than marketing categories.
LiveAvatar LITE's official starter uses base64 raw PCM S16LE mono 24 kHz with
`start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt`, tees the same
TTS frames to normal downstream audio, and has a video-only frontend
([official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python)).
That matches current Fish's default 24 kHz output
(`src/config.js:9-16`, `src/config.js:350-363`) and removes both a second TTS and
a renderer resampler from the boundary. The proposal also distinguishes Tavus
Audio Echo from FULL CVI and Simli's explicit 16 kHz contract instead of treating
vendors as interchangeable.

**Strongest rebuttal.** “Best native Fish contract” is not yet “smallest
end-to-end PoC.” LiveAvatar adds a second remote session, credential, likeness
asset, billing lifecycle, connected-state race, interrupt protocol, explicit
deletion, and a buffered video clock. Its roughly 400–600 ms first feed and
roughly 1 s subsequent batching are protocol/reference facts, not measured
meeting latency; delaying the sole audible path to align video may damage the
very conversational responsiveness Meetmate is preserving. In addition, A must
still carry the result into the meeting, so LiveAvatar does not eliminate the
unmeasured browser/WebRTC chain. E should run first to isolate A before a managed
renderer is added.

### Councilor 5 — Skeptic / Security / Operations

**Strongest point.** The skeptic correctly rejects “minimal” as a line-count
claim. External processors, credentials, session owners, billing meters,
biometric/voice data, rollback steps, and observability are architectural state
even when local glue is short. The concrete requirement for one-time,
audience-restricted browser credentials is essential: a public Attendee page must
never receive gateway credentials, durable avatar keys, transcripts, prompts, or
stable identity. The proposal also correctly requires static rollback not to
depend on the failed vendor.

**Strongest rebuttal.** Several production controls—spend anomaly alerts,
vendor-usage reconciliation, DPA/subprocessor approval, API deprecation
ownership, concurrency canaries, and full incident fallback sequencing—are
adoption gates, not prerequisites for a synthetic, non-confidential comparison
PoC. Pulling all of them into the first experiment would prevent learning the
basic media facts. The narrower PoC safety boundary is: sandbox credentials,
synthetic/consented assets, hard session-duration cap, explicit cleanup,
non-confidential audio, no production users, and no client-visible durable
secret. The broader controls remain mandatory before real-user traffic.

## 2. Evidence against my own Round 1 recommendation

My earlier order favored E, then A, then D-LITE. The following evidence cuts
against that preference and must remain visible:

- **E does not solve meeting injection.** Under the current Attendee contract,
  even a local renderer still needs A's webpage capture. It therefore inherits
  the same unknown browser sample rate, autoplay, resampling, capture, WebRTC, and
  meeting codec behavior described by
  [Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents).
- **E may be falsely “lightweight.”** Mac mini CPU/GPU headroom and visual
  acceptability are unknown. If “local control” expands into photorealistic model
  inference, encoding infrastructure, GPU packaging, and model licensing, it is
  no longer the smallest control. This is the skeptic's strongest challenge to
  my top ranking.
- **A changes more than presentation.** The current production path has
  documented bidirectional PCM and echo gating
  (`src/transport-meet/meet-routes.js:1319-1329`,
  `src/transport-meet/meet-routes.js:1376-1404`). A makes the page the live
  output owner and may also expose meeting audio as microphone input. Whether
  current direct input can remain without ambiguous coexistence is unknown. A
  could therefore alter input and output failure domains together, repeating a
  central Recall experiment error.
- **LiveAvatar LITE has stronger renderer evidence than E has implementation
  evidence.** Its 24 kHz protocol, interrupt, and video-only frontend are known;
  no equally concrete local renderer implementation or measured CPU profile is
  yet specified. If product fidelity is photorealistic by definition, testing E
  first could be non-discriminating work.
- **C has diagnostic strengths A lacks.** Recall officially documents Google Meet
  and Zoom, 1280×720 at 15 fps, selectable compute variants, DevTools, and CPU
  metrics ([Recall Output Media](https://docs.recall.ai/docs/stream-media)).
  A's cross-platform parity and container telemetry are less established. If A
  cannot expose clocks/CPU sufficiently, C may be the better scientific carrier
  despite its larger operational change.
- **Renderer-only does not mean privacy-safe.** LiveAvatar LITE still receives
  voice audio and likeness data. Retention, training use, region, subprocessors,
  deletion semantics, reconnect/idempotency, and current price remain unknown.

These points lower confidence in a production ranking. They do not change the
comparison recommendation because A+E remains the cleanest way to measure the
meeting carrier before adding a second remote renderer, while A+LITE tests the
strongest currently documented managed protocol.

## 3. Agent Core and authority audit

### 3.1 Source-of-truth audit

| State or authority | Current owner/evidence | Allowed live-path behavior | Boundary violation |
|---|---|---|---|
| Meeting session identity | Meetmate creates a UUID and stores configuration/logs (`src/transport-meet/meet-routes.js:1137-1162`) | Derive a random ephemeral render capability via a private server mapping | Reuse gateway/session/user ID as public vendor identity |
| Selected/current agent | Meetmate session plus pipeline switching (`src/pipeline.js:510-520`, `555-579`) | Translate authoritative switch to an appearance-only event | Vendor selects agent, voice, model, or permissions |
| Gateway route and credentials | Config/pipeline/provider (`src/pipeline.js:546-568`, `1898-1913`) | Never cross media boundary | URL/token/model exposed to page or renderer |
| Personality/system prompt | Agent profile and gateway request (`src/pipeline.js:546-568`, `1898-1913`) | Never sent; renderer consumes audio | Text/prompt sent for animation or moderation |
| Conversation memory | OpenClaw gateway; bounded local history only for standalone providers (`src/pipeline.js:1850-1868`, `2043-2051`) | Renderer retains no conversational memory | Vendor avatar/agent object becomes memory store |
| Skills/tools/delegation | Existing gateway event and Agent Core paths | No renderer callback can dispatch or approve a tool | Media health/event treated as a tool result or user turn |
| Turn/wake/cancel/exit | Existing pipeline and echo gate (`src/pipeline.js:1280-1446`, `src/transport-meet/meet-routes.js:1379-1404`) | Adapter maps authoritative abort/end/close to media controls | Vendor turn detector or ASR decides when to speak/stop |
| Speech content and voice | Fish, selected by existing profile; one `onAudio` seam (`src/pipeline.js:2207-2227`) | Tee identical already-generated PCM once | Second TTS, replacement voice, text-to-avatar TTS |
| Avatar appearance | New Meetmate-owned mapping | Send opaque appearance/asset key only | Vendor appearance object stores persona or user memory |
| Meeting bot lifecycle | Existing transport and stored bot ID (`src/transport-meet/meet-routes.js:1337-1354`) | Renderer cleanup is subordinate and separately idempotent | Renderer creates/leaves a second conversational bot |

The “renderer” role is therefore capability-limited, not merely documented:

```text
may: receive ephemeral render capability
may: receive format + appearance key + PCM + end/cancel
may: return video/media timing + health

may not: receive transcript/prompt/memory/tool schemas
may not: choose agent/gateway/voice/turn
may not: write conversation state or invoke tools
may not: survive the parent meeting session
```

### 3.2 Session isolation audit

Four identifiers must remain separate:

1. `meeting_session_id`: Meetmate's authority and correlation root.
2. `gateway_session_user`: currently agent-scoped as
   `meet-${session.id}-${agentId}` (`src/pipeline.js:568`).
3. `meeting_bot_id`: provider lifecycle handle.
4. `render_session_id`: random, single-meeting, single-renderer-generation,
   short-lived capability.

Only Meetmate keeps the mapping. The browser receives an audience-restricted
token, not these internal IDs raw where avoidable. Reconnect increments a local
generation/epoch; media from old generations is rejected. Agent switching may
change `appearance_key`, but never aliases or rotates the gateway session based
on vendor state. Renderer close revokes the capability and explicitly deletes a
billable LiveAvatar session; gateway history remains intact. A renderer outage
cannot cause cross-meeting failover or create a second bot.

The current replacement behavior for a primary Attendee WebSocket
(`src/transport-meet/meet-routes.js:1290-1300`) is evidence for single ownership,
but it is not automatically sufficient for a page plus renderer reconnect. That
generation check remains a PoC obligation.

### 3.3 Tool and event audit

The live path needs a one-way semantic boundary:

```text
Agent Core -> media: speech bytes, authoritative end/cancel, appearance change
media -> Agent Core: readiness/failure/timing only
```

Media-originated events must be allowlisted. `ready`, `closed`, `queue_depth`,
`first_frame`, `last_frame`, and `error_code` may affect whether media starts or
the bot leaves; they must never become user messages, model context, delegation
results, tool invocations, memory writes, or agent switches. Vendor-supplied
textual “reason” fields are untrusted diagnostics, not prompts.

FULL LiveAvatar, Tavus FULL CVI, Text Echo, and any vendor mode that requires its
ASR/LLM/TTS/turn controller fail this audit regardless of visual quality.
LiveAvatar LITE passes at protocol shape because it consumes external PCM and
offers explicit speak/end/interrupt, but only observed behavior can pass the
cancel and lifecycle audit.

## 4. Minimality audit of the proposed modules

### What is actually required for the comparison

1. **Frozen fixture/replay harness** outside Agent Core: current Fish 24 kHz
   S16LE PCM, source timestamps, and a scripted end/cancel sequence.
2. **One small media event envelope**, not a framework:

   ```text
   { render_session_id, generation, turn_id, sequence,
     captured_at, sample_rate, pcm }
   end(turn_id)
   cancel(turn_id)
   close()
   ```

3. **Concrete A+E adapter/page** with bounded playout and enough timing to locate
   browser versus meeting defects.
4. **Concrete A+LiveAvatar-LITE adapter** that maps connected/start/speak/end/
   interrupt/delete and records vendor/session timing.
5. **Test-only observers** for PCM hashes/counts, actual AudioContext rate,
   queue/underrun, first/last frame, meeting-side A/V skew, duplicate audio,
   cancel tail, and cleanup.

### What should not be built yet

- a renderer interface hierarchy or dynamic provider registry;
- plugin discovery, dependency injection, capability negotiation, or a common
  vendor configuration schema;
- a new agent/session/profile abstraction;
- a generic cross-provider lifecycle state machine;
- automatic fallback between Attendee and Recall;
- persistent renderer memory or appearance-persona synchronization;
- a generalized telemetry platform, dashboard, billing reconciler, or production
  rollout controller;
- phoneme/viseme framework work beyond what the single E control needs;
- modifications to `pipeline.js`, gateway providers, memory/LCM, skill/tool
  dispatch, or profile resolution.

The event envelope is justified by experimental comparability, not future vendor
extensibility. If two concrete adapters do not naturally share a behavior, keep
it concrete. A production abstraction may be extracted only after measurements
show stable commonality.

### Necessary controls that are not overengineering

Bounded queues, generation/sequence rejection, authoritative cancel, one audible
owner, explicit renderer deletion, session-duration cap, and client-secret
isolation are required to make the PoC interpretable and safe. They address
failures already evidenced by the historical branch or current vendor contract;
they are not speculative future-proofing.

## 5. Historical Recall: same shape, materially different experiment

### Proven historical facts

- `d2e8f77` asserted 16 kHz compatibility without retained actual browser or
  meeting rates.
- `d3d86d7` used one `AudioBufferSourceNode` per network chunk and a single
  `playCursor`, with no bounded jitter queue, underrun count, media clock, or
  meeting playout timestamps.
- `b5fbff1` added `getUserMedia`, an unconstrained capture AudioContext,
  `ScriptProcessorNode(4096)`, and manual average downsampling.
- `0cd1e52` moved capture to AudioWorklet but retained a 4096-sample flush and did
  not fix output observability.
- `02ece31` removed browser input and used Recall raw mixed input while retaining
  browser output.
- `b9549f6` later added the artifact enablement required by that input.
- `bbe1544` combined Fish S2-Pro, prompt, and tag changes with the transport
  experiment; `de1d03e` reverted the bundle without recording why.

### How the new C comparison differs

- Freeze current Soniox, prompt, gateway, agent, and Fish S2-Pro behavior.
- Use current native 24 kHz Fish PCM and the same recorded fixture as A/E/LITE.
- Change output transport first; identify any input-transport change as a
  separate condition.
- Use one bounded, clock-driven page queue instead of per-chunk source scheduling.
- Observe actual AudioContext rate/state rather than assuming the requested rate.
- Compare Recall default and `web_4_core`; current Recall documentation links
  choppy output to CPU pressure and recommends the larger variant
  ([Recall Output Media](https://docs.recall.ai/docs/stream-media)).
- Retain sequence/sample counts, CPU, queue, underrun, cancel, meeting playout,
  and A/V evidence.

### What remains unknown

No retained recording or structured log binds noise, dropout, clipping, wrong
speed, added latency, or abandonment to a commit. The historical instance
variant, actual AudioContext rates, CPU, chunk arrivals, meeting/session, and
reason for the S2-Pro revert are unknown. Therefore the new controls make C
diagnosable; they do not prove Recall will be better. Equally, the old branch
does not prove Recall is inherently poor.

## 6. Facts, inferences, and unknowns

### Facts

- Current static construction uses one Attendee bot payload with WebSocket audio
  and optional `bot_image` (`src/transport-meet/meet-routes.js:1206-1219`).
- Current Fish defaults to 24 kHz and its one output callback becomes meeting
  output (`src/config.js:9-16`; `src/pipeline.js:2207-2227`).
- Attendee A captures a public page's audio/video; B's endpoint accepts MP4, not
  live frames ([Voice Agents](https://docs.attendee.dev/guides/voiceagents),
  [Output Video](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video)).
- Recall captures a webpage at 1280×720/15 fps on Google Meet and Zoom and
  exposes compute variants/CPU diagnostics
  ([Recall Output Media](https://docs.recall.ai/docs/stream-media)).
- LiveAvatar LITE's official starter accepts 24 kHz mono S16LE and defines
  connected/start/speak/end/interrupt behavior with a video-only frontend
  ([official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python)).

### Inferences to test

- A+E will isolate Attendee carrier quality more cleanly than A+LITE.
- Identical PCM plus measured clocks can attribute regressions among renderer,
  browser, provider capture, and meeting codec.
- A bounded delay of the one meeting-audio path may make LiveAvatar video
  acceptable without harming response and interruption quality.
- A small event envelope will be sufficient for both comparison adapters.

### Unknowns

- Actual Attendee and Recall AudioContext rate/state, capture resampling,
  autoplay, buffer depth, and meeting codec behavior.
- Whether A can retain current direct meeting input while page output is the sole
  egress without changing echo/barge-in semantics.
- A's Google Meet/Zoom parity and accessible container telemetry.
- LiveAvatar render-delay distribution, backpressure, cancel tail, reconnect,
  idempotency, deletion reliability, retention/training/region, and total cost.
- E's minimum visual design, CPU/GPU use, encoding load, license provenance, and
  product acceptability.
- Baseline-derived acceptance thresholds.

## 7. Cross-review vote

My vote is:

1. Measure the immutable current static baseline.
2. Record B as contract-rejected.
3. Run **A+E** as the smallest carrier-control experiment.
4. Run **A+LiveAvatar LITE** as the managed renderer challenger using identical
   Fish bytes, exactly one audible path, explicit interrupt, and explicit session
   deletion.
5. Run C only if it has diagnostic value after A, using a fresh harness and both
   default and `web_4_core`.
6. Do not evaluate FULL modes.

This vote is for a comparison sequence, not production adoption.

## 8. Vote-change conditions

I will change the vote as follows:

- **Move LiveAvatar LITE ahead of E** if photorealism is confirmed as a hard
  acceptance requirement, its data-governance terms pass review, and sandbox
  evidence shows connected gating, cancellation, deletion, and bounded
  audio-delay/A/V skew without material response regression.
- **Move C ahead of A** if Attendee cannot expose sufficient browser/media
  diagnostics, cannot preserve current input semantics with one page-owned
  output, or fails Google Meet/Zoom support while Recall demonstrates those
  requirements with the identical fixture.
- **Drop E as more than a control** if a deliberately bounded 2D/viseme
  implementation exceeds Mac mini resource limits or fails the stated visual
  floor; drop it entirely only if it cannot traverse A's supported meeting path.
- **Reopen B** only when Attendee publishes an official continuous camera-output
  contract with timestamps/backpressure/cancel and coexistence with current
  realtime audio. An undocumented repeated-MP4 technique is insufficient.
- **Reject LiveAvatar LITE** if it requires transcript/persona/tool access, a
  second TTS or audible track, durable client credentials, unbounded/stale
  queues, or cannot reliably interrupt and delete a session.
- **Reject the whole live-avatar effort for this phase** if every viable carrier
  materially degrades blind A/B audio, response latency, barge-in, or static
  rollback relative to baseline.
