# Live Avatar Architecture Council — Evidence Pack

Status: Round 0 shared evidence, no chair recommendation
Date: 2026-07-23
Repository baseline: `origin/main` at `cf1642d166eb2eb1d101a75c5b79382118436fcc`
Research branch: `codex/research-live-avatar-architecture`

## 1. Scope and non-negotiable boundaries

This phase selects a comparison PoC; it does not implement a live avatar.

- Do not replace or modify Meetmate Agent Core.
- Do not move personality, memory, skills, tools, session identity, turn logic, or gateway selection into an avatar vendor.
- Preserve Soniox input, OpenClaw/Hermes/Claude-compatible gateway paths, and Fish Audio output.
- Treat the avatar vendor as a renderer unless an independently proven renderer-only mode exists.
- Preserve the current static-image path byte-for-byte during Phase 1.
- Do not edit source, README, package manifests/locks, or config schema.
- Do not merge, push, release, or publish.

The council must compare at least Options A–E from the research brief and must not claim unmeasured values.

## 2. Issue #69

GitHub Issue: https://github.com/caty-ai/meetmate/issues/69

Issue #69 asks for a research-first decision on lip sync/live video while retaining Fish Audio, Attendee, the gateway, and the Mac mini baseline. It records Recall.ai Output Media + HeyGen as a previously raised possibility, not as an approved design. The issue contains no implementation measurements and no comments.

## 3. Current production path (`origin/main`)

### 3.1 Static bot creation payload

`src/transport-meet/meet-routes.js:1206-1219` creates one Attendee bot:

```text
meeting_url
bot_name
websocket_settings.audio.url
websocket_settings.audio.sample_rate = SAMPLE_RATE
bot_image (only when loaded)
```

There is no appearance-mode switch. Static image data is loaded separately at `meet-routes.js:823-863`. This is the regression boundary: a future live path must not change the payload or image-loading behavior when static mode is selected.

### 3.2 Existing realtime audio input/output

- Input: Attendee sends `realtime_audio.mixed` base64 PCM to the server WebSocket. `meet-routes.js:1376-1404` decodes it and calls `handler.send(audio)`.
- Output: Fish PCM emitted by the pipeline is wrapped once as `realtime_audio.bot_output` with `sample_rate: TTS_SAMPLE_RATE` at `meet-routes.js:1319-1329`.
- Attendee connection replacement is single-owner: a new primary WebSocket supersedes the old connection (`meet-routes.js:1290-1300`).
- Leave is single-bot: the stored bot ID is used for Attendee `/leave` after `exit_requested` (`meet-routes.js:1337-1354`).

### 3.3 Sample rates and Fish Audio

- STT/meeting input baseline: 16 kHz mono PCM (`src/config.js:8`, `316-322`).
- TTS baseline: 24 kHz by default (`src/config.js:9-16`, `350-363`).
- Fish request: raw PCM, requested sample rate, `chunk_length: 300`, normalization enabled (`src/tts-fish.js:100-123`).
- Fish stream aligns odd byte chunks before forwarding (`src/tts-fish.js:199-259`).
- Current model default is `s2-pro`; output is streamed without a second TTS generation (`src/tts-fish.js:166-183`).
- The exact same `onAudio(chunk)` callback currently becomes the meeting output (`src/pipeline.js:2207-2227`). A live renderer fan-out should start at this boundary, not by synthesizing again.

Fish official API: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech

- Official PCM output is 16-bit mono and supports 8/16/24/32/44.1 kHz.
- Official LiveKit integration defaults to PCM 24 kHz mono.
- This confirms the current 24 kHz Fish request and LiveAvatar LITE’s required format can match without a codec or resampler.

### 3.4 Echo, barge-in, cancel, and exit

- Transport echo gate drops meeting frames while the agent is speaking or during the cooldown, with an optional closed-gate bypass (`meet-routes.js:1379-1404`).
- Pipeline barge-in uses interim STT only when the gate is open, checks confidence/noise, and aborts the current controller (`src/pipeline.js:1280-1321`).
- Wake+cancel is handled at `utterance_end`; standalone cancel is intentionally disabled (`src/pipeline.js:1324-1343`, `1390-1392`, `1438-1446`).
- Exit speaks a farewell, waits a fixed 3 seconds because sending chunks is not playback completion, then emits `exit_requested` (`src/pipeline.js:1358-1387`).
- Any media shell must preserve these semantics and expose playback/drain state if the fixed exit grace is to be replaced later. That replacement is outside this PoC.

### 3.5 Agent Core boundary

`meet-routes.js` creates the current pipeline and supplies media callbacks; gateway selection and session identity remain inside current config/pipeline/provider modules. The live path must not add vendor calls inside:

- `src/pipeline.js`
- `src/llm-provider.js` or gateway provider implementations
- memory/LCM ingest
- skills/tools/delegation event handling
- agent profile resolution

The intended seam is after Fish PCM generation and before meeting transport output.

## 4. Required Recall history reconstruction

Branch: `origin/feat/recall-ai`

The full diff from its merge base with main was inspected, plus each required commit’s actual diff.

### 4.1 `d2e8f77` — migration spec

Proposed replacing Attendee with Recall Output Media while retaining STT → LLM → TTS. It assumed both transports could use 16 kHz mono S16LE and described a browser bridge that would play TTS through Web Audio.

Evidence limitation: this was a design document. Statements such as “no conversion needed” were not accompanied by captured browser sample rates, packet traces, or meeting recordings.

### 4.2 `d3d86d7` — provider bridge

Added `public/recall-client.html`, Recall bot creation/leave paths, a provider flag, and browser AudioContext playback. The initial page:

- scheduled every received PCM chunk as a separate `AudioBufferSourceNode`;
- requested a 16 kHz `AudioContext`;
- used `startAt = max(now + 20 ms, playCursor)`;
- attempted unsupported/uncertain subscription messages to `ws://localhost:8080`;
- replaced parts of `meet-routes.js` with provider branching.

No jitter buffer, queue bounds, underrun counters, actual AudioContext rate log persistence, or meeting-side playout timestamps were present.

### 4.3 `b5fbff1` — getUserMedia capture

Removed the guessed localhost Recall subscription and captured meeting input with `getUserMedia`. It:

- requested mono 16 kHz but created the capture `AudioContext` without forcing its rate;
- logged `captureCtx.sampleRate`;
- used deprecated `ScriptProcessorNode(4096)`;
- manually downsampled by averaging from the actual context rate to 16 kHz;
- disabled echo cancellation, noise suppression, and AGC.

At 48 kHz, 4096 input samples represent about 85.3 ms per callback before network and STT; at 16 kHz they represent 256 ms. The repository contains no captured actual value for the test container, so the actual callback duration is unknown.

### 4.4 `0cd1e52` — AudioWorklet

Moved capture off the main thread and retained a 4096-sample flush. It added a ScriptProcessor fallback. This addressed a plausible scheduling problem but did not add measurement, queue bounds, or improve the per-chunk playback scheduler.

### 4.5 `02ece31` — hybrid audio

Removed browser audio input entirely. Recall `realtime_endpoints` supplied `audio_mixed_raw.data` directly to a second server WebSocket, while the browser remained output-only. It introduced:

- a primary client WebSocket for TTS;
- a relay WebSocket for meeting input;
- shared echo-gate state;
- cleanup of the relay when the primary disconnected.

This reduced input resampling risk but retained browser TTS playback and its scheduling/resampling unknowns.

### 4.6 `b9549f6` — artifact enablement

Added the required `recording_config.audio_mixed_raw.enabled = true` and 16 kHz sample rate before subscribing to `audio_mixed_raw.data`.

### 4.7 `bbe1544` and `de1d03e` — Fish S2-Pro and revert

`bbe1544` changed the Fish model and emotion-tag syntax along with prompts/tests. `de1d03e` mechanically reverted that entire commit. The revert commit message gives no reason and contains no listening notes or measurements. Therefore:

- fact: the S2-Pro change was reverted on the Recall branch;
- unknown: whether the revert was caused by Fish quality, unrelated prompt/tag changes, Recall/browser transport quality, or branch stabilization.

Current main later adopted S2-Pro independently and uses 24 kHz output after live A/B work recorded in current source comments. The historical Recall revert is not evidence that S2-Pro is unsuitable today.

## 5. Official platform evidence (checked 2026-07-23)

Primary documentation was preferred over blogs.

### 5.1 Attendee

Voice Agents: https://docs.attendee.dev/guides/voiceagents

- `voice_agent_settings.url` loads a public HTTPS page in an Attendee container.
- Attendee captures that page’s audio and video and streams both into the meeting.
- Meeting audio is exposed to the page as microphone input.
- Container viewport is 1280×720.
- The page must request microphone access immediately and require no user click.

Realtime audio: https://docs.attendee.dev/guides/realtimeaudio

- Bidirectional WebSocket PCM supports 8/16/24 kHz output and mixed 8/16/24 kHz input.
- Audio is base64 16-bit mono PCM.
- Attendee retries WebSocket connection up to 30 times at 2-second intervals.
- Documentation says invalid-message errors are not currently reported.

Realtime video: https://docs.attendee.dev/guides/realtimevideo

- This is input only: per-participant JPEG frames are delivered to the application.
- It is not a documented path for injecting bot-camera video.

Bot API: https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video

- `POST .../output_video` accepts a public HTTPS URL to an MP4 file plus `loop` and `mute_video` flags.
- It is a queued prerecorded-file output API, not a documented continuous frame/WebRTC injection API.
- It cannot accept a live LiveAvatar/renderer stream under the official contract. Repeatedly replacing MP4s would be a speculative hack with discontinuities and no A/V clock.
- Therefore Option B, as defined (“existing realtime audio unchanged, live video separately injected”), is rejected for a live avatar unless Attendee publishes a new live camera-output contract. The endpoint remains useful only for prerecorded/looping animation experiments.

Unknowns requiring vendor confirmation or a sandbox PoC:

- whether `voice_agent_settings` and `websocket_settings.audio` may be enabled together;
- the Attendee container’s actual AudioContext sample rate and autoplay state;
- whether page output is resampled once or more before meeting encoding;
- whether Attendee plans a continuous live-camera output API distinct from MP4 `output_video`.

### 5.2 Recall.ai

Output Media: https://docs.recall.ai/docs/stream-media

- Supports Google Meet and Zoom.
- Captures a webpage as bot camera or screenshare at 1280×720 and 15 fps.
- Only `webpage` output-media kind is currently documented.
- Default `web` variant is 250 millicores/750 MB; `web_4_core` is 2250 millicores/5250 MB; `web_gpu` adds WebGL.
- Recall explicitly connects choppy output with CPU pressure and recommends testing `web_4_core`.
- Output Media cannot be combined with automatic/output audio or video endpoints.
- DevTools and CPU metrics are available while the bot is alive.
- Output Media always includes video; audio-only output is not supported in this mode.

This official guidance makes the old branch’s unspecified default variant a material confounder. It does not prove CPU was the historical cause.

### 5.3 LiveAvatar (successor to HeyGen Interactive Avatar)

Overview: https://docs.liveavatar.com/
Official LITE starter: https://github.com/heygen-com/liveavatar-starter-livekit-agent-python

- FULL mode manages ASR, LLM, TTS, and WebRTC; this conflicts with the default Meetmate boundary unless all brain layers can be bypassed.
- LITE mode requires the customer to provide STT, LLM, TTS, and WebRTC; LiveAvatar describes itself as real-time video streaming in this mode.
- The overview explicitly advertises use of external TTS such as Fish Audio.
- LITE is listed at 1 credit/minute; FULL/Embed at 2 credits/minute. Current subscription/overage pricing must be reconfirmed before procurement.
- Current published plans are Starter $19/month for 150 credits with 5-minute sessions, Essential $99/month for 1,000 credits with 20-minute sessions, and Business $475/month for 5,000 credits with 60-minute sessions. LITE consumes one credit/minute; FULL consumes two. Thus the required 30-minute PoC cannot run on a single Starter session.
- Custom avatar creation requires a continuous two-minute source video and consent. HeyGen publishes a biometric privacy notice; likeness ownership/consent, deletion, DPA, region, and whether streamed Fish audio is retained must be approved before using a real person’s avatar.

The official starter and its LITE integration reference establish:

- backend audio WebSocket with `start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt`;
- raw PCM S16LE, mono, 24 kHz, base64;
- frontend is video-only; backend handles audio;
- the same TTS frames are tee'd to the avatar WebSocket and the normal downstream audio path;
- the reference implementation buffers roughly 400 ms for the first chunk and 1 second thereafter (the integration guide recommends 600 ms then 1 second);
- interruption must both stop the local send loop and send `agent.interrupt`;
- events sent before `session.state_updated: connected` may be silently dropped;
- the session must be explicitly deleted to stop billing; an orphan may remain until inactivity timeout.

This matches current Fish’s native 24 kHz PCM output, so no second TTS generation or resampling is required. The live Media Bridge can tee identical Fish bytes to:

1. the meeting-audio playout path; and
2. LiveAvatar LITE’s audio WebSocket.

Critical unknown:

LiveAvatar returns the rendered video separately from meeting audio. Its initial renderer buffer means immediately playing Fish into the meeting can make the video lag the sound. The PoC must measure render delay and either (a) delay meeting audio by the measured bounded amount, or (b) reject the candidate if p95 skew/added latency is unacceptable. There must be exactly one audible path; LiveAvatar audio must not also be captured as a second meeting audio track.

Migration is from HeyGen Interactive Avatar to LiveAvatar; old Interactive Avatar examples must not be treated as current API evidence.

### 5.4 Tavus

Overview: https://docs.tavus.io/sections/conversational-video-interface/overview-cvi
Echo mode: https://docs.tavus.io/sections/conversational-video-interface/echo-mode
Pipecat renderer integration: https://docs.tavus.io/sections/integrations/pipecat

- Tavus FULL CVI contains perception, turn-taking, STT, LLM, TTS, and rendering, so it violates the boundary by default.
- Echo mode can bypass all layers except the realtime replica and accepts pre-generated base64 audio.
- Tavus documents a video-layer mode that receives upstream TTS audio and returns synchronized video/audio streams.

Echo mode is therefore a legitimate renderer-only comparison candidate, but its transport, price, cancellation behavior, meeting handoff, and whether returned audio duplicates Fish output remain PoC unknowns.

### 5.5 D-ID, Simli, local renderer

D-ID’s current realtime overview describes an end-to-end agent pipeline with STT/turn detection/LLM/TTS/avatar. No official renderer-only Fish PCM path was established in this research pass, so it is not a lead candidate.

Simli and local solutions remain possible, but no current official contract was strong enough to outrank the verified Attendee/Recall/Tavus paths. A local 2D/viseme renderer remains the control candidate because it can be driven from the existing Fish PCM without handing identity or audio to a third party.

### 5.6 Published cost and retention facts

- Attendee Pay As You Go: five free hours, then $0.50/hour, with published volume discounts to $0.35/hour: https://attendee.dev/pricing
- Attendee privacy policy says audio/video are retained five days by default, while meeting transcripts and participant data are retained indefinitely unless deletion is requested: https://attendee.dev/privacy_policy
- LiveAvatar LITE: one credit/minute, with current plan limits above: https://docs.liveavatar.com/docs/faq/credits
- Tavus current published developer plans include a free allowance, then paid plans and per-minute overage; exact Echo-mode eligibility/rate is not separately established: https://www.tavus.io/pricing
- Fish S2-Pro API pricing is $15 per million UTF-8 input bytes, but Fish is already the baseline cost and must not be double-generated: https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits

## 6. Options the council must score

### Option A — Attendee webpage voice agent + Media Shell + renderer

The most direct official audio+video page capture path. It changes the live bot payload but can keep static unchanged through a separate live branch. For LiveAvatar LITE, current Fish 24 kHz PCM can be tee'd unchanged to the renderer WebSocket and the page’s meeting-audio playout. Primary risks are browser/container audio quality, the renderer’s 400–600 ms initial buffer, A/V skew, and double-routing if existing realtime audio is accidentally left active.

### Option B — current Attendee realtime audio unchanged + separate official video injection

Rejected under the current official contract: Attendee `output_video` accepts only a public HTTPS MP4 URL with optional looping/muting. It is not a live stream/frame injection surface. Reconsider only if Attendee supplies a new official continuous camera-output API.

### Option C — Recall Output Media + Media Shell + renderer

Supported in Google Meet and Zoom and closest to the historical branch. Must start from a new minimal PoC, not resurrect the branch. Must test `web_4_core`, 24/48 kHz behavior, bounded jitter buffering, AudioWorklet or direct track paths, and exact input/output separation.

### Option D — managed avatar pipeline

FULL modes are rejected unless every brain/turn layer is demonstrably bypassed. Tavus Echo and LiveAvatar LITE remain renderer-only sub-options pending audio-contract proof.

### Option E — vendorless lightweight renderer

2D/canvas/viseme/local lip-sync. It is the stability and privacy control. Photorealism is lower, but it offers the cleanest single-source PCM fan-out and lowest vendor brain risk.

## 7. Required PoC facts, not preset targets

Baseline first: current Attendee + static image + Fish Audio, 30 minutes in Google Meet with greeting, multiple turns, interruption, long response, and exit.

Measure:

- Fish request and first PCM timestamps;
- first audible meeting output;
- p50/p95 response latency;
- PCM byte counts and chunk intervals;
- actual browser input/output AudioContext rates and states;
- every resampling and codec boundary;
- underrun, dropout, clipping, and queue depth;
- CPU and memory;
- A/V skew p50/p95;
- disconnect/reconnect count;
- barge-in success;
- echo and duplicate-audio incidence;
- blind A/B quality against static baseline.

Thresholds are defined after baseline measurement. A candidate that lacks observability cannot pass.

## 8. Council model disclosure

The requested external model lineup (Claude/Fable 5 equivalent, Kimi K3, GLM 5.2, Fugu Ultra) is not directly callable in this Codex App session. Five independent Codex-native role agents will be used instead. Their role, independence boundary, and review record will be preserved. No unavailable model review will be represented as executed.
