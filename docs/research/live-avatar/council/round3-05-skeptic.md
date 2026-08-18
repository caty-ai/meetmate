# Round 3 — Skeptic / Security / Operations Adversarial Debate

Status: adversarial review, not implementation approval
Date: 2026-07-23
Role: Councilor 5, skeptic / security / operations
Reviewed: all five Round 2 submissions

## Opening challenge

The Round 2 consensus is directionally coherent but not yet evidence:

- “A+E is minimal” is an inference about experimental usefulness, not a fact about code, latency, CPU, visual value, or operational surface.
- “Same-byte tee” can be true before transport and false at acceptance, timing, playback, and observer boundaries.
- “Static remains unchanged” can be true for one JSON payload while false for startup, config validation, shared state, cleanup, dependencies, or health checks.
- “Fallback to static” is safe for future sessions; it is not proven as an in-session recovery.
- “Renderer-only” narrows semantic authority but does not remove credentials, biometric/likeness processing, data retention, billing, outage, or vendor-shutdown risk.
- “E is the control” is useful only if it answers a decision. If the product requires photorealism, a custom 2D renderer may test browser transport but not product viability.

I still vote for research rather than implementation. The smallest useful next action may be a disposable carrier falsification harness, not an A+E feature-shaped PoC.

## 1. なぜ以前のRecall構成は音質が悪かった可能性があるのか。

### Fact

- [`d3d86d7`](https://github.com/caty-ai/meetmate/commit/d3d86d7) converted S16 PCM into browser buffers, created one `AudioBufferSourceNode` per network chunk, and advanced one `playCursor` without a bounded jitter queue, underrun count, or meeting playout timestamp.
- [`b5fbff1`](https://github.com/caty-ai/meetmate/commit/b5fbff1) used an unconstrained capture `AudioContext`, deprecated `ScriptProcessorNode(4096)`, and manual averaging downsampling. No retained runtime sample-rate value exists.
- [`0cd1e52`](https://github.com/caty-ai/meetmate/commit/0cd1e52) moved input capture to AudioWorklet but retained a 4096-sample flush and did not repair output observability.
- [`02ece31`](https://github.com/caty-ai/meetmate/commit/02ece31) changed input to Recall raw mixed audio while retaining browser output; [`b9549f6`](https://github.com/caty-ai/meetmate/commit/b9549f6) later added required artifact enablement.
- [`bbe1544`](https://github.com/caty-ai/meetmate/commit/bbe1544) mixed Fish model, prompt, and tag changes into the transport trial; [`de1d03e`](https://github.com/caty-ai/meetmate/commit/de1d03e) reverted the bundle without a recorded reason.
- The payload did not select a Recall compute variant. Current [Recall Output Media documentation](https://docs.recall.ai/docs/stream-media) associates CPU pressure with choppy media and recommends testing `web_4_core`.

### Inference

Browser scheduling, an actual/requested sample-rate mismatch, crude input downsampling, CPU starvation, network jitter, page capture, WebRTC/meeting codec conversion, echo/gating, or incomplete configuration could each have produced poor quality. Changing input, output, and Fish variables across the branch made attribution worse.

### Unknown

It is not established that audio was poor in every run, what “poor” meant, which commit was running, whether the defect persisted after hybrid input, what browser rate or compute variant was used, or why the branch and Fish bundle were abandoned. Recall itself is neither convicted nor exonerated.

### Smallest falsification test

Replay one frozen current 24 kHz Fish PCM fixture through a new Recall output-only page twice—default and `web_4_core`—using a bounded clocked buffer. Record actual `AudioContext` rate, source/render sample counts, queue depth, underruns, CPU, and observer-side meeting audio. Do not change input, Fish, prompts, or renderer. This falsifies “CPU/old scheduler explains the class of failure” more cheaply than rebuilding the old branch.

## 2. Attendee webpage方式でも同じ問題が再発しないか。

### Fact

[Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents) loads a public HTTPS page and captures its audio/video into the meeting. The retrieved contract does not establish the container's actual AudioContext rate, autoplay state, capture resampler, buffer depth, CPU telemetry, or Google Meet/Zoom parity. A replaces the current documented WebSocket PCM egress with browser playback, page capture, WebRTC, and meeting encoding.

### Inference

Yes, the same class of failure can recur. Changing Recall to Attendee removes one provider and preserves the existing bot vendor relationship, but it does not remove browser scheduling, rate conversion, page lifecycle, capture, codec, reconnect, or CPU pressure. “Same vendor as static” is not “same audio path as static.”

### Unknown

Whether Attendee's container is more stable, whether its actual rate matches 24 kHz, whether current direct meeting input can remain while page output is sole egress, and whether echo/barge-in semantics survive delayed page playout.

### Smallest falsification test

Do **not** build E first. Load a disposable Attendee voice-agent page that plays a deterministic frozen PCM/tone sequence through one bounded AudioWorklet/ring buffer and renders synchronized color flashes. Disable current WebSocket output for that live bot. One observer recording plus runtime rate/queue logs can reject A before any avatar renderer work.

This is the first attack on the A+E consensus: E is not needed to learn whether A damages audio.

## 3. LiveAvatar LITEは本当に映像rendererだけとして使えるか。

### Fact

The [LiveAvatar overview](https://docs.liveavatar.com/) assigns STT, LLM, TTS, and WebRTC to the customer in LITE mode. Its [official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) accepts base64 raw mono S16LE at 24 kHz, uses `start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt`, and has a video-only frontend. It gates sends on `session.state_updated: connected`; earlier events may be silently dropped. The integration explicitly deletes the session to stop billing.

### Inference

LITE is renderer-only at the documented wire/authority boundary. That is stronger than a marketing label and weakens my Round 1 skepticism. It does not prove renderer-only operation in the complete A+LITE system: the vendor still owns a remote queue, render clock, WebRTC session, likeness asset, availability domain, credential, and billing lifecycle.

### Unknown

Remote acceptance acknowledgements, queue/backpressure bounds, internal resampling, render timestamps, interrupt purge tail, reconnect/idempotency, deletion reliability under partition, inactivity billing, region, subprocessors, retention, training/reuse, likeness deletion, concurrency, and effective price.

### Smallest falsification test

Use synthetic likeness and non-confidential PCM in a disposable project. After connected, send a uniquely sequenced short utterance, interrupt halfway, stop the local loop, and then delete the session. Observe the video-only frontend and network traffic. Reject LITE if text/TTS/turn services are required, if stale mouth motion persists beyond the declared bound, if a second audio track appears, or if deletion cannot be reconciled with session/usage state.

## 4. Fish AudioのPCMを二重生成せず、会議音声と口の動きへ同じsourceとして渡せるか。

### Fact

Current Fish audio crosses one callback at `src/pipeline.js:2207-2227`; current output defaults to 24 kHz, mono raw PCM and aligns odd bytes. LiveAvatar LITE's documented ingress is also 24 kHz mono S16LE. Therefore one Fish generation can feed two application-level consumers without a second TTS or mandatory pre-renderer resampler.

### Inference

A source tee is feasible. “Same bytes” is valid only for decoded PCM at the local fork or adapter ingress. It does not imply that:

- the renderer acknowledges or renders every sample;
- page audio and renderer video share a clock;
- transport rechunking is identical;
- browser float conversion/resampling preserves bytes;
- meeting participants hear the same waveform;
- cancellation reaches both branches simultaneously.

The phrase “same-byte tee” should be replaced with **one-source PCM lineage**.

### Unknown

LiveAvatar accepted-sample accounting, loss before/after connected, page playout drift, remote queue behavior, and observer-side alignment. A/V correction may require delaying the only meeting-audio route, which preserves source lineage but changes response and cancel timing.

### Smallest falsification test

Stamp one fixture with `turn_id`, sequence, first-sample index, byte count, and rolling PCM hash. Hash both local adapter inputs, then compare cumulative submitted samples with observable playout/frame events and the meeting recording. The claim fails if a second Fish request occurs, local hashes diverge, sample order/count changes without an explicit recorded transform, or both immediate and delayed audio routes become audible.

## 5. avatar vendorがLLM/STT/turn-takingを握らずに済むか。

### Fact

LiveAvatar FULL and Tavus FULL CVI own conversational layers and violate the boundary. LiveAvatar LITE and Tavus Audio Echo document external/pre-generated audio modes. LITE's protocol shape does not require prompt, transcript, memory, tools, or vendor TTS.

### Inference

Yes for a narrowly configured LITE-style renderer, but only if authority is enforced by data flow rather than policy text. A renderer receiving only ephemeral session capability, appearance key, PCM, end/cancel, and media timing has no legitimate need for Agent Core state.

### Unknown

Whether production SDK defaults enable analytics, moderation, transcription, persistence, or vendor agent features; whether vendor callbacks include text that an integration might accidentally feed into Agent Core; and whether appearance objects retain stable identity or conversation metadata.

### Smallest falsification test

Capture every outbound field and inbound event in a synthetic session. The allowlist is PCM, media format, ephemeral renderer/session identifiers, appearance asset, end/cancel, and media health/timing. Reject if a successful session requires transcript, prompt, gateway/user ID, LLM/TTS settings, turn detection, memory, tools, or semantic callbacks.

## 6. static-image経路を本当に無変更にできるか。

### Fact

The current static bot payload is built at `src/transport-meet/meet-routes.js:1206-1219` and independently loads `bot_image` at `src/transport-meet/meet-routes.js:823-863`. Selecting a separate live payload before bot creation can preserve those bytes.

### Inference

Byte-identical payload construction is possible, but “static unchanged” is broader and unproven. Static can regress through new mandatory environment validation, dependency import failure, shared singleton state, timers, WebSocket listeners, cleanup handlers, config defaults, health checks, memory pressure, or a live feature flag evaluated after partial initialization.

### Unknown

The eventual code layout, module initialization behavior, configuration schema, tests, and whether static sessions instantiate any live code indirectly.

### Smallest falsification test

Before live code, snapshot the exact static create payload and scripted static behavior. After the smallest live spike, run the same test with all live credentials absent and avatar endpoints forced unreachable. Assert identical payload/image behavior, no live imports/network calls/timers, greeting/turn/cancel/exit/leave parity, and successful static startup. A JSON snapshot alone is insufficient.

## 7. vendor障害時に二重Botや二重音声を発生させず戻せるか。

### Fact

Current code stores one bot ID for leave and replaces the primary Attendee WebSocket owner. Attendee documents reconnect attempts. Live A and static use different bot-construction paths; LiveAvatar deletion is a separate remote operation.

### Inference

Safe **control-plane fallback for new sessions** is achievable with a pre-creation kill switch. Safe **in-session fallback** is not established. Starting static before the live bot's absence is confirmed can create two participants. Waiting for a failed vendor to acknowledge deletion can make “fallback” unavailable precisely during an outage.

Exactly one Fish generation also does not prevent duplicate audio. Reconnect replay, stale page playout, direct WebSocket output left enabled, renderer-returned audio, simultaneous immediate/delayed paths, or two bots can all duplicate sound.

### Unknown

Provider leave confirmation semantics, stale page lifetime, renderer close/delete idempotency, how long an unreachable bot can remain, and whether meeting APIs expose authoritative participant absence.

### Smallest falsification test

In a sandbox meeting, kill the renderer network mid-utterance while queues contain uniquely marked PCM. Trigger reconnect and the proposed recovery path. The observer must see one bot identity, one waveform, no stale generation, bounded last-audio/last-frame tail, and a locally terminal session even if remote delete fails. Do not create a static replacement in this first test. Only after absence can be proven should a second test attempt static recreation.

The safe initial policy is: fail closed, leave the live bot, mark any unconfirmed remote session as an orphan incident, and keep **subsequent** sessions static. “Seamless fallback” is rejected until separately proven.

## 8. 最小モジュールはいくつ必要か。

### Fact

The consensus proposals variously name a Media Shell, event envelope, replay harness, carrier adapter, renderer adapters, lifecycle state machine, and observers. These are responsibilities, not evidence that each deserves a production module.

### Inference

There are two different minimums:

1. **Smallest carrier falsification:** zero new production modules. Use one disposable test page plus a test driver/observer outside the product. This answers whether A's browser path can preserve audio.
2. **Smallest comparison PoC after A passes:** three narrow runtime units plus test code:
   - a live-only server session/PCM bridge with generation, sequence, bounded queue, cancel, and close;
   - one Attendee live page that owns the sole meeting-audio playout and displays video;
   - one concrete renderer implementation at a time—bounded E code or a LiveAvatar LITE adapter.

Static bot construction should remain on its existing path; a live payload branch is necessary code but not a new abstraction. Fixture replay and meeting observation are test utilities, not runtime modules.

### Unknown

Whether E logic naturally belongs inside the page, whether LITE signaling belongs server-side, and whether A's microphone input requires a separate bridge. Actual vendor/browser contracts may change the count.

### Smallest falsification test

Implement only the disposable A carrier page first. If it fails baseline audio, the correct module count for this phase is zero: stop. If it passes, build one concrete A+E vertical slice without a provider interface and count the real seams revealed by code and telemetry.

## 9. その抽象化は今必要か、将来のためだけの過剰設計ではないか。

### Fact

Only a few common properties are already evidenced across viable candidates: one-source PCM lineage, per-turn/generation ordering, authoritative cancel/end, one audible owner, bounded local queues, and close/cleanup. Vendor readiness, acknowledgements, remote queues, video tracks, billing deletion, and telemetry differ materially.

### Inference

A generic Media Shell/plugin framework is not justified now. The minimum reusable contract is a test/event envelope and a few invariants, not dynamic provider discovery, dependency injection, capability negotiation, a universal lifecycle engine, a common config schema, or a billing/telemetry platform. Duplicate a small amount of concrete adapter code before inventing false commonality.

Some controls are not overengineering: generation rejection, bounded buffering, one-audio ownership, cancel, explicit cleanup, client-secret isolation, and a session-duration/spend cap are necessary for an interpretable and safe external-vendor PoC.

### Unknown

Whether the second working adapter will reveal a stable abstraction. It cannot be known before A+E and A+LITE expose their actual state and failure shapes.

### Smallest falsification test

Build one concrete A carrier spike and, only if it passes, one A+E vertical slice. Then sketch the LITE mapping without refactoring. Extract a shared interface only if both adapters duplicate the same state transitions and tests; otherwise keep them concrete.

## Is A+E worth building?

Not yet as a product-shaped feature.

### Fact

E avoids an avatar vendor and permits deterministic local render timestamps/cancel. It still requires A's unproven browser capture path and an unspecified renderer design. No minimum visual requirement or Mac mini resource result exists.

### Inference

A tiny E—energy-driven mouth states or synchronized color/shape markers—can be worth building **as instrumentation** after the A carrier spike passes. It isolates carrier timing and gives a visible calibration source. A polished 2D avatar is not justified until stakeholders state that non-photorealistic output could be acceptable.

### Unknown

Whether a bounded E would influence the product decision, meet visual expectations, or reduce total cost once engineering/design/maintenance are included.

### Smallest falsification test

Before avatar code, ask for a binary product constraint: “Could a deliberately non-photorealistic 2D/viseme participant ever ship?” If no, E remains only a few-hour calibration instrument, not a product candidate. If yes, cap the spike to three mouth states driven by PCM energy and measure A's audio, CPU, cancel, and observer A/V behavior. Stop before asset systems, phoneme models, GPU inference, or renderer frameworks.

## Cost and privacy attack on the managed challenger

The technical sandbox may proceed before full procurement, but only with staged gates.

### Before any external call

- synthetic/explicitly consented likeness and scripted non-confidential PCM;
- disposable sandbox project and least-privileged credential;
- durable secret server-side only; short-lived, audience-bound browser token if required;
- hard duration, concurrency, retry, and spend caps;
- documented cleanup plus manual revocation;
- no transcript, prompt, memory, tool, stable user ID, or production meeting URL.

### Before real-user or production-like data

- DPA, subprocessors, regions, retention, deletion SLA, recording defaults, training/reuse, likeness and voice rights;
- callback authentication, replay resistance, key rotation, incident handling;
- measured quota, overload, reconnect, orphan-session, and delete-failure behavior;
- full cost including carrier minutes, renderer credits, minimums, concurrency, custom likeness, retries, idle/orphan time, egress, and required support tier.

[LiveAvatar credits](https://docs.liveavatar.com/docs/faq/credits) list LITE at one credit per minute, but a credit rate is not total cost or a shutdown plan. Static Meetmate must start and operate when the avatar account, credentials, DNS, and endpoint are all absent.

## Final adversarial disposition

- **B and FULL modes:** rejected.
- **A carrier:** not approved for architecture; approved only for the smallest disposable falsification test.
- **E:** approved only as calibration/control after A passes; product work depends on an explicit non-photorealistic visual floor.
- **LiveAvatar LITE:** protocol-qualified renderer probe after A passes; not privacy-, cost-, lifecycle-, or meeting-qualified.
- **C:** conditional discriminator if A fails or lacks observability; never a branch revival.
- **Static:** the only production-qualified path in current evidence.

The council should not call the next step “implementing a minimal live avatar.” It is testing whether the only documented Attendee live carrier is good enough to justify building any avatar on top of it.
