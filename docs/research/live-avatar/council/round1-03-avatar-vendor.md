# Round 1 — Avatar / Vendor Integration Architecture

Role: Councilor 3, Avatar / Vendor Integration Architect
Date: 2026-07-23
Decision scope: comparison PoC only; no implementation recommendation
Evidence boundary: Round 0 evidence pack and failure dossier, plus linked official vendor documentation. Other council proposals were not read.

## 1. Position

The vendor decision is subordinate to the media-boundary decision. Meetmate must keep Soniox, Agent Core, gateway selection, Fish Audio, turn/cancel/exit behavior, and the static-image path. Therefore a candidate is admissible only if it can consume the **already-generated Fish PCM** as rendering input without taking ownership of STT, LLM, TTS, memory, identity, or turn-taking.

The preferred investigation order is:

1. **Option E, local lightweight renderer**, as the privacy/stability control.
2. **Option A with a renderer-only service**, using Tavus Audio Echo, Simli audio-to-video, or LiveAvatar LITE behind one Media Shell.
3. **Option C with the same renderer**, only if Option A fails for a measured Attendee container reason.
4. **Option B is rejected under the present Attendee API contract.**
5. **FULL managed pipelines are rejected immediately.**

This is not a production selection. LiveAvatar LITE now has the strongest end-to-end contract match: its official starter accepts the current Fish format directly, tees the same PCM to avatar and downstream audio, supports explicit interrupt, and returns video-only. Its principal risk is no longer format compatibility but the additional meeting-audio delay needed to align sound with its buffered video. Tavus Echo remains a valid renderer-only comparator; Simli publishes a clear byte contract but requires 24→16 kHz resampling.

## 2. Non-negotiable renderer contract

The Media Shell, not the avatar vendor, must own these invariants:

- One Fish synthesis. The callback already used at `src/pipeline.js:2207-2227` is the only PCM source; the avatar path must not trigger a second TTS.
- Stable internal envelope: `turn_id`, monotonic `sequence`, PCM bytes, encoding, channels, sample rate, Fish-generation timestamp, and end/cancel markers.
- Explicit adaptation per renderer. Current Fish output is normally 24 kHz mono S16LE; a 16 kHz-only renderer requires one observable resampling stage. “Requested browser sample rate” is not proof of the actual rate.
- Exactly one audible meeting route. If a vendor returns synchronized audio with video, the shell must select either that audio or the direct Fish route, never both.
- Cancel must flush vendor/render queues for the affected `turn_id`; reconnect must not replay stale audio.
- Vendor output must remain downstream of Agent Core. Vendor session IDs must not become Meetmate session identity.
- Static mode must preserve the current Attendee bot payload and image-loading behavior byte-for-byte.

Any candidate that cannot expose enough timestamps and queue state to measure Fish-first-PCM → renderer ingest → rendered frame/audio → meeting playout cannot pass, even if a demo looks good.

## 3. Vendor comparison

### 3.1 LiveAvatar LITE versus FULL

**Official contract.** [LiveAvatar’s overview](https://docs.liveavatar.com/) says FULL manages ASR, LLM, TTS, and WebRTC, while LITE requires the customer to provide STT, LLM, TTS, and WebRTC and explicitly supports external TTS including Fish Audio. The official [LITE LiveKit Agent starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) establishes a backend WebSocket using `start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt`; its payload is base64 raw PCM S16LE, mono, 24 kHz. Its frontend is video-only, while the backend tees the same TTS frames to the avatar and normal downstream audio path. [Credits documentation](https://docs.liveavatar.com/docs/faq/credits) lists LITE at 1 credit/minute and FULL/Embed at 2 credits/minute, with current plans and overage rates subject to procurement reconfirmation. HeyGen’s current product page also states that [LiveAvatar and HeyGen are distinct products with separate pricing and accounts](https://www.liveavatar.com/heygen-vs-liveavatar); legacy HeyGen Interactive Avatar examples are not current LiveAvatar API evidence.

**Boundary fit.**

- LITE: admissible in principle. It maps to Option A or C as a renderer behind the Media Shell, and to Option D only in the narrow sense that rendering is managed externally while the brain remains local.
- FULL/Embed: inadmissible. “Bring your own LLM/TTS” inside a vendor-managed conversational pipeline is not equivalent to renderer-only ownership; vendor ASR/turn/session behavior still duplicates Meetmate responsibility.

**Raw/external audio issue.** This contract matches current Fish’s native 24 kHz PCM, so the exact same bytes can be fanned out without a second TTS or resampler. The reference’s `agent.interrupt` also maps cleanly to Meetmate cancel, provided the local send loop is stopped at the same time. It warns that media sent before `session.state_updated: connected` may be silently dropped, so connection state is a hard send gate. Remaining protocol questions include backpressure/queue limits and production telemetry, not basic format compatibility.

**Latency.** The official reference buffers roughly 400 ms for its first avatar audio chunk and 1 second thereafter; the integration guide recommends 600 ms then 1 second. Those values are renderer feed batching, not measured meeting latency. Because LiveAvatar returns video separately while the existing Fish path can play audio immediately, the naive tee will make the face lag the voice. The PoC must measure rendered-video delay and add a bounded delay to the **single** meeting-audio path, then accept or reject the resulting p95 response latency and A/V skew. WebRTC and “real-time” marketing are not substitutes for this measurement.

**Privacy and lock-in.** Fish audio and avatar/likeness data cross a third-party boundary. The product publishes broad trust claims, but retention, region, subprocessors, training use, deletion, and custom-avatar consent terms must be contractually checked. Lock-in is moderate-high: session protocol, WebRTC SDK, avatar asset, billing credits, and output behavior are proprietary, though a Media Shell adapter limits core-code coupling.

**Adopt for PoC only if:**

- measured video delay can be paired with bounded meeting-audio delay while passing p95 response-latency and A/V-skew gates;
- local send-loop cancellation plus `agent.interrupt` produces no stale speech/motion;
- connected-state gating and explicit session deletion are reliable (the reference warns orphaned sessions can bill until inactivity timeout);
- queue/backpressure telemetry is sufficient and required DPA/data-location/retention terms are acceptable.

**Reject immediately if:** LITE invokes vendor TTS/turn-taking; the A/V alignment delay makes conversation materially worse; cancel leaves queued motion; state races silently drop meaningful audio; essential telemetry is unavailable; or the integration requires changing Agent Core/static mode.

### 3.2 Tavus Audio Echo versus FULL CVI

**Official contract.** [Tavus Echo Mode](https://docs.tavus.io/sections/conversational-video-interface/echo-mode) states that Audio (Base64) Echo bypasses all layers except the Realtime Replica Layer and accepts pre-generated base64 audio. Its example carries `audio`, `sample_rate` (including 24000 in the example), `inference_id`, and `done`. By contrast, [FULL CVI](https://docs.tavus.io/sections/conversational-video-interface/overview-cvi) includes perception, turn-taking, STT, LLM, TTS, and rendering. Current [Tavus pricing](https://www.tavus.io/pricing) is plan/minute/concurrency based; the page currently lists free PoC minutes, paid monthly tiers, per-minute overage, and a 30-second minimum charge. Procurement must snapshot the exact plan at decision time.

**Boundary fit.**

- Audio Echo: the strongest explicit renderer-only candidate. It maps naturally to Option A/C behind the shell. `inference_id` can correlate with, but must not replace, Meetmate `turn_id`.
- Text Echo: rejected because it invokes Tavus TTS and breaks the Fish Audio invariant.
- Microphone Echo: not the first PoC because it makes interrupt logic part of the streamed audio/transport and broadens the test.
- FULL CVI: rejected because it duplicates the Agent Core’s brain and turn layers.

**Raw/external audio issue.** Tavus documents base64 audio and sample rate, but the example does not by itself prove accepted encoding, channel layout, optimum chunk cadence, backpressure, or whether returned audio is byte-identical to input. The evidence pack notes that its video-layer integration returns synchronized video/audio, which creates a duplicate-audio risk if the current Attendee PCM route remains active.

**Latency.** Tavus recommends FULL for its optimized latency; that recommendation must not pressure Meetmate into surrendering the boundary. Echo’s renderer and Daily/WebRTC path, plus the selected Option A/C meeting bridge, must be measured independently. No advertised latency is counted as a PoC result.

**Privacy and lock-in.** External audio and replica identity are processed by Tavus/Daily infrastructure. Tavus publishes a [Trust Center](https://trust.tavus.io/) listing SOC 2 Type 2, HIPAA, and GDPR, but certification badges do not answer Meetmate-specific retention, recording defaults, regional processing, or training-use questions. Lock-in is high around replica training, Daily room/session transport, Interactions Protocol, and usage/concurrency pricing.

**Adopt for PoC only if:** Audio Echo’s exact encoding and cancel contract are confirmed; the returned A/V tracks can be routed without duplicate Fish audio; a stock replica can be used before supplying biometric footage; timestamps/metrics are accessible; and 24 kHz works without hidden rate conversion or is explicitly measured.

**Reject immediately if:** only Text Echo/FULL satisfies the quality target; returned audio cannot be separated or made authoritative; scheduled speech survives cancel; a vendor persona/turn controller becomes required; or latency observability is unavailable.

### 3.3 Simli audio-to-video

**Official contract.** [Simli’s custom WebRTC client documentation](https://docs.simli.com/api-reference/simli-webrtc) describes audio-to-talking-head rendering from arbitrary sources and specifies PCM Int16, mono, 16 kHz, preferably 6000-byte chunks (maximum 65,536 bytes). The [session endpoint](https://docs.simli.com/api-reference/endpoint/webrtc/startAudioToVideoSession) exposes `audioInputFormat: pcm16`, `syncAudio`, batching, silence handling, session/idle limits, and warns that shared capacity can return “server overloaded.” Simli’s official site markets speech-to-video latency below 300 ms and a free/paid usage model, but this is a vendor claim, not a Meetmate measurement. A published [DPA](https://www.simli.com/legal/data-processing-agreement) provides a contractual starting point for processing/security review.

**Boundary fit.** This is a true audio-driven renderer candidate for Option A/C. It is preferable to D-ID for this council round because the current D-ID realtime overview describes a required STT/turn/LLM/TTS agent pipeline, whereas Simli publishes a concrete renderer input format. Simli does not rescue Option B: its output is WebRTC A/V, not the HTTPS MP4 accepted by Attendee `output_video`.

**Raw/external audio issue.** The byte contract is clearest of the managed candidates, but it is **16 kHz**, while current Fish output defaults to 24 kHz. The shell must resample once with sequence/timestamp continuity; the direct Attendee leg must continue to use original 24 kHz unless the candidate’s single-audible-path design says otherwise. `syncAudio` needs clarification: the PoC must determine whether false yields usable video-only output and whether true returns synchronized audio that should become the sole meeting audio.

**Latency.** The preferred 6000-byte chunk is 187.5 ms at 16 kHz mono S16LE before network/render time. That arithmetic is a contract consequence, not measured end-to-end latency, and smaller chunks are reportedly allowed. The PoC should sweep safe chunk sizes instead of treating the preferred value as mandatory. Shared-capacity overload is an explicit production risk.

**Privacy and lock-in.** Audio and face assets leave Meetmate. The DPA helps, but exact retention, region, generated frames, custom-face deletion, and dedicated capacity must be confirmed. Lock-in is moderate: the narrow PCM contract is easy to adapter-isolate, while face IDs, WebRTC/session semantics, capacity reservation, and appearance quality remain proprietary.

**Adopt for PoC only if:** one measured 24→16 kHz conversion is acceptable; `syncAudio` yields an unambiguous one-audio topology; cancel/queue flush is proven; overload/dedicated-slot behavior is testable; and privacy terms cover audio and likeness.

**Reject immediately if:** 16 kHz input audibly regresses Fish quality; renderer buffering breaks barge-in; video-only output is unavailable and returned audio cannot be made authoritative; shared capacity misses availability needs; or cancellation/telemetry is insufficient.

### 3.4 Local lightweight renderer

This is Option E and the control, not a promise of photorealism. A local 2D mouth/viseme/envelope renderer can consume the same Fish PCM without transmitting audio or a biometric replica to another vendor. It offers the strongest boundary, privacy, deterministic cancel, and unit economics. Its weaknesses are engineering ownership, Mac mini CPU/GPU budget, and lower realism. A local model that requires large GPU inference or changes Agent Core is not “lightweight” and should be rejected.

Adopt as the control if it can maintain the baseline audio, meet measured CPU/memory and A/V-skew limits, and render a deliberately modest design. Reject a particular local implementation if it degrades the audio loop, cannot run on the Mac mini baseline, or becomes a bespoke photorealistic research project.

## 4. Options A–E mapping

| Option | Vendor mapping | Contract finding | Round 1 disposition |
|---|---|---|---|
| A — Attendee webpage voice agent + shell | LiveAvatar LITE, Tavus Audio Echo, Simli, or local renderer displayed in the Attendee page | Official page A/V capture path exists; primary risks are browser rate/state, double audio, capture/codec latency, and coexistence assumptions | **Primary managed-renderer PoC path**, after static baseline and audio topology are locked |
| B — current Attendee PCM + separate video injection | None of the live candidates | [Attendee `output_video`](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video) accepts only a public HTTPS MP4 URL plus loop/mute flags; it is not live frames/WebRTC | **Reject now**; reconsider only if Attendee publishes a continuous camera-output contract |
| C — Recall Output Media + shell | Same renderers as A, embedded in a Recall-captured webpage | Officially supported webpage output at 1280×720/15 fps, but incompatible with Recall automatic/output endpoints and sensitive to container resources | **Fallback PoC**, built fresh; never revive the old branch wholesale |
| D — managed avatar pipeline | LiveAvatar FULL, Tavus FULL CVI, current D-ID realtime | Duplicates STT/LLM/TTS/turn/session ownership | **Reject**. Only renderer-only LITE/Echo submodes are admissible, and those should be treated as A/C renderer adapters |
| E — vendorless renderer | Local 2D/canvas/viseme | Cleanest same-PCM boundary; no vendor brain or per-minute renderer fee | **Required control and leading low-risk candidate** |

## 5. Weighted scoring

Scores are architectural priors, not measured PoC results. Each criterion is 0–5: Agent Core/static isolation 30%, external-audio contract 20%, latency/cancel/observability potential 15%, meeting-path fit 15%, privacy/data control 10%, and cost/lock-in 10%. Weighted total is the sum of `(score / 5) × weight`.

### 5.1 Renderer/vendor modes

| Candidate | Boundary 30 | Audio 20 | Latency/controls 15 | Meeting fit 15 | Privacy 10 | Cost/lock-in 10 | Total /100 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Local lightweight | 5 | 5 | 4 | 3 | 5 | 5 | **91** |
| Simli audio-to-video | 5 | 5 | 3 | 3 | 2 | 3 | **78** |
| Tavus Audio Echo | 5 | 4 | 3 | 3 | 2 | 2 | **72** |
| LiveAvatar LITE | 5 | 5 | 3 | 4 | 2 | 3 | **81** |
| Tavus FULL CVI | 1 | 1 | 4 | 2 | 1 | 1 | **32** |
| LiveAvatar FULL/Embed | 1 | 1 | 4 | 2 | 1 | 2 | **34** |

Interpretation: LiveAvatar LITE ranks first among managed services because its official reference matches Fish’s 24 kHz S16LE mono output, tees identical frames, returns video-only, and exposes interrupt. Its score is held below local by third-party privacy/lock-in and the unresolved audio-delay/A-V-skew tradeoff. Simli’s clear contract is offset by mandatory resampling; Tavus Echo can move upward if encoding, cancel, and returned-track behavior are confirmed. FULL scores are irrelevant to adoption because they fail a hard boundary, regardless of total.

### 5.2 Transport options

| Option | Boundary 30 | Audio 20 | Latency/controls 15 | Meeting fit 15 | Privacy 10 | Cost/lock-in 10 | Total /100 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A — Attendee page | 4 | 3 | 3 | 5 | 3 | 4 | **74** |
| B — separate live injection | 5 | 5 | 4 | 0 | 4 | 4 | **78, but hard-rejected** |
| C — Recall Output Media | 3 | 2 | 2 | 4 | 2 | 2 | **52** |
| D — FULL managed pipeline | 1 | 1 | 4 | 3 | 1 | 1 | **35, hard-rejected** |
| E — local lightweight | 5 | 5 | 4 | 3 | 5 | 5 | **91** |

Option B illustrates why weighted totals cannot override hard gates: its conceptual isolation is excellent, but current Attendee meeting-path fit is zero because the required API does not exist.

## 6. Recall history: what changes and what does not

The unmerged `origin/feat/recall-ai` history is evidence about experimental design, not proof that Recall is intrinsically bad:

- [`d3d86d7`](https://github.com/caty-ai/meetmate/commit/d3d86d7) scheduled each PCM network chunk as a separate browser `AudioBufferSourceNode`, requested 16 kHz, and had no bounded jitter queue or playout telemetry.
- [`b5fbff1`](https://github.com/caty-ai/meetmate/commit/b5fbff1) captured browser input with `ScriptProcessorNode(4096)` and manual averaging downsample, but retained no actual runtime sample-rate log.
- [`0cd1e52`](https://github.com/caty-ai/meetmate/commit/0cd1e52) moved capture to AudioWorklet but retained a 4096-sample flush and did not repair output scheduling/measurement.
- [`02ece31`](https://github.com/caty-ai/meetmate/commit/02ece31) wisely separated direct Recall meeting input from browser output; [`b9549f6`](https://github.com/caty-ai/meetmate/commit/b9549f6) later added the artifact enablement the raw input subscription required.
- [`bbe1544`](https://github.com/caty-ai/meetmate/commit/bbe1544) mixed Fish S2-Pro, prompt, and tag changes into the transport experiment; [`de1d03e`](https://github.com/caty-ai/meetmate/commit/de1d03e) reverted the bundle without an operational reason.

The historical path also omitted Recall’s larger `web_4_core`/GPU variant. Current Recall documentation explicitly associates choppy Output Media with CPU pressure, but no historical CPU trace exists. Therefore browser scheduling, resampling, CPU, network jitter, meeting codec, echo gate, and Fish model remain plausible—not proven—causes. Current main at [`cf1642d`](https://github.com/caty-ai/meetmate/commit/cf1642d166eb2eb1d101a75c5b79382118436fcc) is a different 24 kHz Fish S2-Pro baseline.

Option C must therefore start as a minimal new experiment using identical recorded current Fish PCM, bounded queueing, actual AudioContext rates, CPU/underrun metrics, and both default and `web_4_core`. Reusing the branch would import its confounders.

## 7. Required unknowns and decision gates

Before any managed renderer is selected, obtain vendor-written answers or sandbox measurements for:

1. Exact PCM encoding, rates, channels, maximum/minimum/preferred chunk sizes, and whether chunks need timestamps (already substantially answered for LiveAvatar LITE and Simli; still incomplete for Tavus Echo).
2. Backpressure, queue limit, silence, end-of-turn, cancel/flush, reconnect, and stale-audio behavior.
3. Whether renderer output contains audio; whether video-only is possible; whether returned audio is altered from the input.
4. Ingest-to-first-frame and steady-state A/V skew timestamps accessible to the customer.
5. Session startup, idle timeout, max duration, concurrency, regional availability, and overload behavior.
6. Audio/avatar storage, retention, training use, region, subprocessors, deletion SLA, DPA, and custom-likeness consent.
7. PoC and projected production cost including minimum billing increments, concurrency tier, custom replica, dedicated capacity, egress, and the meeting transport.

Adoption requires baseline-relative evidence: p50/p95 audible response, A/V skew, underruns/dropouts/clipping, CPU/memory, reconnects, barge-in success, duplicate-audio/echo incidence, and blind A/B quality. Thresholds must be set after the current static Attendee + 24 kHz Fish baseline is measured. A visually attractive avatar cannot compensate for degraded speech or broken interruption.

## 8. Round 1 recommendation

Run Option E as the control and place **LiveAvatar LITE** behind Option A for the smallest discriminating managed-renderer PoC. It now has the best native Fish contract, but the experiment must deliberately compare immediate audio against video-aligned delayed audio and measure the latency/skew tradeoff. Keep Tavus Audio Echo as the no-resampling renderer comparator pending its track/cancel details, and Simli as the explicit-contract fallback if one measured 24→16 kHz conversion is acceptable. Do not evaluate any FULL mode, Text Echo, or D-ID end-to-end agent. Do not run Option C until Option A has a measured failure attributable to Attendee rather than to the renderer. Do not run Option B under the current MP4-only contract.

The selection rule is simple: preserve Meetmate’s voice and brain, prefer the fewest media clocks, and reject any renderer that cannot prove exactly what happens to each Fish PCM turn.
