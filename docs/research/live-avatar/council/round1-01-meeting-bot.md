# Round 1 — Meeting Bot / WebRTC Architecture Proposal

Role: Meeting Bot / WebRTC Architect
Status: Independent council proposal
Date: 2026-07-23

## Position

Run a measured, non-production comparison with the current Attendee static bot as the immutable control. The principal executable comparison should include **Option A (Attendee webpage voice agent)** carrying both **Option E (vendorless renderer)** and **LiveAvatar LITE under Option D**, with **Option C (Recall Output Media)** as the cross-provider benchmark. LiveAvatar LITE now has an official external-PCM contract that matches current Fish output; Tavus Echo remains a secondary renderer-only candidate. Managed FULL modes are outside the Meetmate boundary.

**Option B is rejected under the current official contract.** Attendee's `POST .../output_video` accepts a public HTTPS MP4 URL with looping/muting flags; it is queued prerecorded-file output, not continuous frame or WebRTC injection. Repeated MP4 replacement would be a speculative, discontinuous transport with no A/V clock. B should return to consideration only if Attendee publishes a new official continuous camera-output API.

No live option should alter the static payload during Phase 1. Static and live bot creation must be separate branches selected before bot creation, not conditionals that gradually mutate the existing payload. The current static contract is the payload at `src/transport-meet/meet-routes.js:1206-1219`, including its independently loaded `bot_image` path at `src/transport-meet/meet-routes.js:823-863`.

## Architectural invariant

There must be one brain and one authoritative speech stream:

```text
meeting input
  -> existing Soniox / pipeline / gateway / session
  -> Fish Audio PCM (one synthesis)
       -> static: existing Attendee realtime_audio.bot_output
       -> live: bounded Media Shell -> renderer/video transport
```

The fan-out seam is the existing `onAudio(chunk)` output boundary at `src/pipeline.js:2207-2227`. The existing Fish stream already handles odd-byte alignment (`src/tts-fish.js:199-259`) and produces 24 kHz PCM by default (`src/config.js:9-16`, `src/config.js:350-363`). A candidate must consume that stream or a single explicitly measured conversion of it; it must not invoke another TTS or move turn logic, personality, memory, tools, or session identity into the renderer.

The Media Shell is not a second agent. It is a live-only adapter responsible for:

- PCM sequence numbers, source timestamps, byte counts, and chunk cadence;
- a bounded jitter/playout queue with underrun, overrun, clipping, and dropped-frame counters;
- one declared resampling boundary, if the renderer contract requires it;
- renderer cancellation and queue flush when the current pipeline aborts;
- video frame/track timestamps and A/V skew;
- readiness, disconnect/reconnect, drain, and terminal state;
- a single meeting-output owner, preventing duplicate Fish audio.

Existing semantics remain authoritative: single-owner Attendee WebSocket replacement at `src/transport-meet/meet-routes.js:1290-1300`, bot-output wrapping at `src/transport-meet/meet-routes.js:1319-1329`, single-bot leave at `src/transport-meet/meet-routes.js:1337-1354`, transport echo gating at `src/transport-meet/meet-routes.js:1379-1404`, pipeline barge-in at `src/pipeline.js:1280-1321`, and the current exit grace at `src/pipeline.js:1358-1387`. The PoC may measure real drain state but must not silently replace the three-second exit behavior.

## Option assessment

### Option A — Attendee voice-agent webpage

Attendee documents a public HTTPS page loaded in a 1280×720 container; it captures the page's audio and video into the meeting and exposes meeting audio as microphone input. The page must request microphone access immediately without a click ([Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents)). This is the clearest documented Attendee path for live camera plus audio.

For live mode, the page should be the only meeting-output owner. Leaving `websocket_settings.audio` enabled merely to preserve the old path risks duplicate output and an unproven coexistence combination. The live bot payload should instead use `voice_agent_settings`, while static continues to use the current byte-for-byte payload.

Advantages:

- documented browser-to-meeting audio and video path;
- remains within the current bot provider and leave lifecycle;
- renderer page can expose Media Shell telemetry directly.

Risks and unknowns:

- coexistence of `voice_agent_settings` and `websocket_settings.audio` is not established;
- actual `AudioContext.sampleRate`, autoplay state, browser capture resampling, and meeting codec boundaries are unknown;
- meeting input presented as page microphone could duplicate or replace the current direct mixed-audio input;
- browser scheduling and container CPU pressure can damage playout unless queueing and telemetry are explicit;
- the evidence does not establish equivalent behavior on both Google Meet and Zoom, so both require separate sandbox runs.

Adopt only if the page can own live output without duplicate audio, current direct input can be retained or replaced without changing turn semantics, all resampling boundaries are observed, cancellation flushes queued audio, and both target meeting platforms pass the baseline-derived thresholds.

Reject immediately if Attendee requires simultaneous ambiguous audio routes, the page cannot start media without user interaction, the actual runtime prevents bounded low-jitter playback, or the vendor cannot disclose/support the audio capture path sufficiently to measure it.

### Option B — Attendee realtime audio plus separate video injection

This would have been the strongest boundary because Attendee realtime audio officially supports base64 mono S16 PCM at 8/16/24 kHz and reconnects up to 30 times at two-second intervals ([Attendee Realtime Audio](https://docs.attendee.dev/guides/realtimeaudio)). It aligns with current input decoding at `src/transport-meet/meet-routes.js:1376-1404` and output wrapping at `src/transport-meet/meet-routes.js:1319-1329`.

The necessary video surface does not exist in the current official contract. [Attendee Realtime Video](https://docs.attendee.dev/guides/realtimevideo) is meeting-to-application JPEG input, not bot-camera injection. `POST .../output_video` accepts only a public HTTPS MP4 URL plus `loop` and `mute_video`; it is a queued prerecorded-file API, not continuous frame/WebRTC injection ([Attendee Output Video API](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video)).

**Immediate decision: reject Option B.** Repeatedly replacing MP4 files is not an admissible PoC because it invents an unsupported pseudo-stream with discontinuities, upload latency, queue ambiguity, and no shared A/V clock.

Re-adopt for evaluation only if Attendee publishes an official continuous participant-camera output contract with sustained frame/track semantics, timestamps or a defined synchronization model, bounded backpressure, cancellation, coexistence with `websocket_settings.audio`, and Google Meet/Zoom support.

### Option C — Recall Output Media

Recall explicitly documents webpage capture as camera or screenshare at 1280×720 and 15 fps on both Google Meet and Zoom. Output Media always includes video and cannot be combined with automatic/output audio or video endpoints ([Recall Output Media](https://docs.recall.ai/docs/stream-media)). The webpage must therefore be the sole live output owner; current Attendee audio output cannot be carried over as a parallel meeting route.

This option is valuable as the strongest documented cross-platform comparison and the closest topology to the historical experiment. It is not a recommendation to revive `origin/feat/recall-ai`.

Advantages:

- explicit Google Meet and Zoom support;
- documented 15 fps webpage output;
- live DevTools and CPU metrics;
- selectable `web_4_core` variant provides a controlled CPU comparison.

Risks:

- browser/Web Audio/WebRTC reintroduces scheduler, resampling, codec, and CPU boundaries;
- output media cannot be combined with separate output endpoints, reducing fallback flexibility;
- changing provider also changes bot lifecycle and reconnect behavior, increasing attribution burden;
- input and output must be deliberately separated so Recall raw mixed input does not create a second uncontrolled experiment.

Adopt only if a new minimal PoC, tested on both the default web variant and `web_4_core`, meets the measured control on audio quality, latency, interruptions, A/V skew, CPU, and reconnect behavior. Use direct Recall raw mixed input only as a separately identified input condition.

Reject immediately if the page cannot be the single audio owner, the required compute tier is operationally unacceptable, queue/cancel telemetry cannot be captured, or either Google Meet or Zoom fails the baseline-derived thresholds.

### Option D — managed avatar service

FULL modes are rejected at the architecture boundary. LiveAvatar FULL owns ASR, LLM, TTS, and WebRTC ([LiveAvatar overview](https://docs.liveavatar.com/)); Tavus FULL CVI likewise includes perception, turn-taking, STT, LLM, TTS, and rendering ([Tavus CVI overview](https://docs.tavus.io/sections/conversational-video-interface/overview-cvi)). Those responsibilities belong to Meetmate.

LiveAvatar LITE is now the lead managed-renderer sub-option. Its [official LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) establishes a backend WebSocket with `start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt`; it accepts base64 raw PCM S16LE mono at 24 kHz, while the frontend is video-only. This exactly matches current Fish's native PCM format, so the existing bytes can be tee'd to the normal meeting-audio path and the avatar without resampling or second synthesis.

The reference batches about 400 ms for the first avatar send and one second thereafter; its guide recommends 600 ms then one second. That batching makes A/V alignment the central risk: immediate Fish playout into the meeting may lead the video. The Media Shell must measure renderer delay and either delay meeting audio by a bounded measured amount or reject the candidate when p95 skew/added response latency is unacceptable. Delaying meeting audio also delays the effective echo-gate/playback window and must be tested against barge-in and exit behavior.

The lifecycle contract is also stricter than a generic renderer:

- wait for `session.state_updated: connected`, because earlier events may be silently dropped;
- on interruption, stop the local send loop and send `agent.interrupt`;
- send `agent.speak_end` only after the intended utterance bytes have been accepted;
- explicitly delete the session during teardown to stop billing; do not rely on inactivity timeout;
- keep the video-only frontend from becoming a second audible meeting path.

Adopt LiveAvatar LITE only if identical-byte teeing is verified, the Attendee webpage can carry its video while the Media Shell remains the sole page-audio owner, cancel/flush passes interruption tests, explicit deletion is reliable, and measured meeting-audio delay produces acceptable A/V skew without unacceptable response latency.

Tavus Echo remains eligible because it accepts pre-generated base64 audio and describes synchronized returned audio/video ([Tavus Echo](https://docs.tavus.io/sections/conversational-video-interface/echo-mode), [Tavus Pipecat renderer integration](https://docs.tavus.io/sections/integrations/pipecat)). Its returned audio must be used instead of—not in addition to—the direct Fish meeting output, and its exact PCM/cancel contract remains less established in this evidence.

Reject any managed sub-option immediately if it resynthesizes speech, requires vendor ASR/LLM/turn-taking, cannot preserve session isolation, creates duplicate audible audio, cannot deterministically interrupt/flush, or cannot close billable sessions. Reject LiveAvatar LITE specifically if its renderer buffer forces baseline-relative p95 A/V skew or added latency beyond the measured acceptance threshold.

### Option E — vendorless renderer

A local 2D/canvas/viseme renderer is the control for renderer risk. It can derive mouth energy/visemes from the already-generated Fish PCM and emits no second audio. It still needs a meeting injection path—currently Option A's captured page, or a future officially supported continuous camera API—so it does not eliminate the WebRTC/container experiment.

Advantages:

- cleanest single-source PCM semantics and cancellation control;
- lowest privacy and avatar-vendor coupling;
- deterministic instrumentation and reproducible rendering load.

Risks:

- lower photorealism;
- if carried through a webpage, it retains container and meeting-codec risks;
- local lip-sync processing on the Mac mini must be measured, not assumed cheap.

Adopt as the stability control and retain as a production candidate if product quality is acceptable and Mac mini CPU/memory remain within baseline-derived bounds.

Reject as the user-facing choice only if blind review shows it cannot meet the product's minimum visual-quality requirement; do not reject it as a technical control.

## Why the old Recall branch is not the new Option C

The historical sequence is useful evidence about experimental design, not evidence that Recall itself failed:

- `d2e8f77` asserted no conversion was needed without captured rates.
- `d3d86d7` scheduled one `AudioBufferSourceNode` per chunk with one `playCursor`, no bounded jitter buffer, no queue metrics, and an uncertain localhost subscription.
- `b5fbff1` introduced `ScriptProcessorNode(4096)` and manual averaging downsampling from an unconstrained capture context.
- `0cd1e52` moved capture to AudioWorklet but retained a 4096-sample flush.
- `02ece31` finally separated input by using Recall raw mixed audio while leaving browser output in place.
- `b9549f6` later added the artifact enablement required for `audio_mixed_raw`.
- `bbe1544` mixed a Fish S2-Pro/prompt/tag change into the transport experiment; `de1d03e` reverted the bundle without recording why.

The new comparison differs materially: current main uses Fish S2-Pro at 24 kHz; identical recorded Fish PCM feeds every candidate; input and output variables are changed separately; browser rates are observed rather than requested and assumed; queueing is bounded; cancellation is measurable; default versus `web_4_core` is explicit; and meeting-side recording plus A/V timestamps are mandatory.

No retained recording, log, or commit binds historical noise, dropout, clipping, speed, or latency to a cause. Browser scheduling, resampling, CPU, codec conversion, echo/gating, network jitter, and Fish remain hypotheses, not conclusions. In particular, `de1d03e` is not evidence against today's S2-Pro because it reverted several coupled changes and current main adopted S2-Pro independently.

## Lifecycle and failure isolation

Each live session needs an explicit state machine:

```text
creating bot -> meeting joined -> input ready -> renderer ready
-> live -> draining/cancelling -> leaving -> closed
```

The bot must not speak live until both the meeting transport and renderer are ready. If the renderer fails before first speech, the PoC should mark the run failed rather than mutating the live bot into the static path. If it fails mid-session, stop accepting new render audio, abort/flush queued playback, preserve diagnostic state, and invoke the provider's one authoritative leave operation. Cross-provider automatic failover is excluded because it would create a second participant and obscure lifecycle ownership.

Reconnect tests must distinguish server-to-provider WebSocket replacement, webpage reconnect, renderer reconnect, and meeting rejoin. Sequence IDs must reveal replay or loss. Exit measurement ends only after the current fixed grace and leave request are observed; any future drain-based improvement is a separate change.

## PoC sequence and decision gates

1. Record the current Attendee static baseline for 30 minutes in Google Meet using greeting, multiple turns, interruption, long response, and exit. Repeat in Zoom if Zoom is a required production target; the evidence only explicitly establishes both-platform support for Recall.
2. Replay the identical captured Fish 24 kHz PCM through an instrumented Media Shell without an avatar. Establish arrival, queue, playout, and meeting-recording clocks.
3. Record Option B as contract-rejected; do not spend PoC time on repeated MP4 replacement. Reopen only on a new official continuous camera-output contract.
4. Run Option E through Option A's Attendee webpage carrier. This establishes the local-renderer control before adding a managed renderer.
5. Run Option A with identical PCM and the same Media Shell test script.
6. Run Option C from a new minimal Recall payload on default and `web_4_core`, first with output-only variation and then, if needed, direct Recall mixed input as a separately labeled test.
7. Run LiveAvatar LITE as the Option D renderer-only sub-option after instrumenting `connected`, speak batching, interrupt, speak-end, and explicit session deletion. Compare immediate meeting playout against a bounded delayed-audio condition; do not hide the added latency.
8. Set pass/fail thresholds only after baseline data exists. A candidate without underrun, queue, CPU, A/V skew, reconnect, and meeting-side audio evidence cannot pass.

Required observations include Fish request/first-PCM, first audible meeting output, p50/p95 response latency, chunk sizes/intervals, actual AudioContext rate and state, every resampler/codec boundary, clipping/dropouts/underruns, queue depth, CPU/memory, A/V skew p50/p95, reconnects, barge-in, echo/duplicate audio, and blind A/B quality.

## Preliminary weighted score

Scores are 1 (poor/unknown) to 5 (strong), based only on currently documented contracts. Unknown contract details are penalized rather than guessed.

| Criterion | Weight | A | B | C | D renderer-only | E |
|---|---:|---:|---:|---:|---:|---:|
| Preserve current audio/static boundary | 25% | 3 | 1 | 2 | 5 | 5 |
| Media integrity and controllable A/V sync | 25% | 3 | 1 | 3 | 3 | 4 |
| Lifecycle/observability | 20% | 3 | 1 | 4 | 3 | 4 |
| Google Meet + Zoom confidence | 15% | 2 | 1 | 5 | 2 | 2 |
| Operational cost/privacy/vendor risk | 15% | 4 | 3 | 2 | 1 | 5 |
| **Weighted score / 5** | **100%** | **3.00** | **1.30** | **3.10** | **3.05** | **4.15** |

Interpretation:

- Option E leads as a renderer/control, but currently needs A as its meeting carrier.
- Option B is eliminated by the official prerecorded-MP4 contract; its theoretical audio isolation does not compensate for the absence of live video injection.
- Option C is the best documented two-platform benchmark, not a default production recommendation.
- Option A is the only currently documented Attendee live carrier among these options.
- LiveAvatar LITE under Option D now has the strongest managed renderer-only PCM fit, but its batching makes A/V skew versus added response latency a decisive PoC question. FULL mode remains ineligible.

These are screening scores, not a vendor selection. Replace them with measured scores only after the static baseline and identical-PCM comparison.

## Unresolved evidence requests

- Attendee confirmation for `voice_agent_settings` plus `websocket_settings.audio`, and whether a future continuous live-camera API distinct from MP4 `output_video` is planned.
- Actual Attendee and Recall container AudioContext rates, autoplay states, resampling paths, and meeting codec paths.
- Attendee Google Meet/Zoom parity evidence for A and for any future live-camera API that could revive B.
- LiveAvatar LITE measured render delay distribution, p95 A/V skew, acceptable meeting-audio delay, exact server acceptance/queue behavior, and reliability of interrupt plus explicit billable-session deletion.
- Tavus Echo returned-audio ownership, cancellation, transport, meeting handoff, and current price.
- Historical Recall bot IDs, instance variants, CPU graphs, recordings, terminal logs, ngrok logs, and operator notes.
- Historical HeyGen session IDs and API version; old Interactive Avatar examples must not be treated as current LiveAvatar API evidence.
- Baseline-derived acceptance thresholds and the product's minimum acceptable avatar realism.

Until these are resolved, no candidate should be described as proven, and no production implementation should begin.
