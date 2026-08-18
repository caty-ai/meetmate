# Round 1 — Realtime Audio / DSP Review

Role: Councilor 2, realtime audio / DSP
Date: 2026-07-23
Decision posture: research only; scores are preliminary and hard rejection gates override totals

## 1. Audio invariant

The audio system should have exactly one speech source and exactly one meeting-output owner.

The source is the existing Fish Audio stream: 24 kHz by default, mono S16LE PCM, `s2-pro`, with odd-byte alignment already enforced (`src/config.js:9-16`, `350-363`; `src/tts-fish.js:100-123`, `166-183`, `199-259`). The correct fork point is the existing `onAudio(chunk)` boundary at `src/pipeline.js:2207-2227`. One immutable PCM chunk, carrying a monotonically increasing utterance ID, chunk sequence, first-sample index, and source monotonic timestamp, should fan out to:

1. the one authorized meeting audio path; and
2. a renderer/lip-sync consumer.

No option may invoke Fish twice, normalize twice, independently rechunk the two branches before stamping them, or let a renderer synthesize replacement speech. Byte counts and a rolling hash at the fork should prove both consumers received the same source PCM. This preserves the current request/output characteristics and separates Fish quality from downstream transport quality.

For the static path, the current single wrapping of PCM as `realtime_audio.bot_output` with `sample_rate: TTS_SAMPLE_RATE` at `src/transport-meet/meet-routes.js:1319-1329` remains the reference. Attendee officially accepts base64, 16-bit, mono PCM at 8/16/24 kHz, so current 24 kHz Fish output is a native documented input rate: [Attendee Realtime Audio](https://docs.attendee.dev/guides/realtimeaudio). That does **not** imply there is no later meeting/WebRTC codec conversion.

## 2. Codec and clock boundaries by option

| Option | End-to-end audio boundary | DSP consequence |
|---|---|---|
| A — Attendee webpage voice agent | Fish 24 kHz S16LE → network framing → browser S16-to-Float conversion → actual `AudioContext` rate (must be measured) → Attendee page capture → WebRTC/meeting codec | At least one browser-domain conversion/resampling boundary is likely. The existing Attendee realtime output must be disabled for the live bot or participants can hear duplicate speech. With LiveAvatar LITE, the same source bytes can be tee'd to the renderer while page playout remains the sole meeting-audio owner; its initial renderer buffering makes A/V delay the critical risk. Attendee documents webpage audio/video capture, but not the container's actual audio clock: [Voice Agents](https://docs.attendee.dev/guides/voiceagents). |
| B — Attendee realtime audio plus separate video injection | Audio would remain on the current 24 kHz PCM path, which is ideal in theory | Rejected: the official `output_video` surface accepts a public HTTPS MP4 URL with loop/mute controls, not continuous frames or WebRTC. Replacing MP4s repeatedly would introduce discontinuities and lacks a shared A/V clock: [Attendee `output_video`](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video). |
| C — Recall Output Media | Fish 24 kHz S16LE → network → webpage conversion/playout at actual browser clock → Recall page capture → WebRTC/meeting codec | Same browser-clock risk as A, plus a provider switch and a historically unmeasured scheduler. Recall's documented Output Media is webpage A/V capture, and its output-media mode cannot be combined with separate output-audio/video endpoints: [Recall Output Media](https://docs.recall.ai/docs/stream-media). |
| D — managed renderer-only mode | For LiveAvatar LITE: Fish 24 kHz mono S16LE bytes → base64 `agent.speak` → renderer; the identical bytes separately feed the one meeting-audio path, while the frontend receives video only | The official starter establishes native format compatibility, `start`/`agent.speak`/`agent.speak_end`/`agent.interrupt`, and a tee of the same TTS frames, so no second synthesis or renderer-side resampling is required. Its roughly 400 ms initial buffer (guide: 600 ms) and roughly 1 s later batches make renderer delay versus meeting audio the principal unknown: [LiveAvatar overview](https://docs.liveavatar.com/), [official LiveAvatar LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python). Tavus Audio Echo remains less bounded: [Tavus Echo Mode](https://docs.tavus.io/sections/conversational-video-interface/echo-mode). |
| E — vendorless lightweight renderer | Fish PCM fork → local envelope/phoneme/viseme derivation; meeting audio depends on the chosen Attendee transport | Renderer-side control is strongest and no vendor codec is needed for lip sync. However, under the current Attendee contract a live camera still appears to require webpage capture (Option A), so end-to-end audio is not automatically as clean as the renderer itself. |

Option B therefore has the best hypothetical Fish isolation but is not implementable under the present official contract. Among viable comparison PoCs, E rendered over A's transport establishes the most useful local control; C and D must beat that control rather than merely render a more photorealistic face.

## 3. Buffer, jitter, underrun, and clipping requirements

The historical Recall implementation is not an acceptable scheduler template. Commit `d3d86d7` created one `AudioBufferSourceNode` per received PCM chunk and advanced one `playCursor`, with no bounded jitter buffer or underrun telemetry. Stable arrivals could make that design sound acceptable, but it cannot distinguish network jitter, main-thread delay, resampling, or CPU starvation.

Every browser or vendor path must expose:

- `utterance_id`, `chunk_seq`, first-sample index, sample count, source timestamp, arrival timestamp, enqueue timestamp, scheduled playout timestamp, and actual render callback timestamp;
- actual `AudioContext.sampleRate` and state, not only the requested value;
- queue depth in samples and milliseconds, low/high watermark crossings, late chunks, dropped chunks, underruns, reconnects, and cancellation-discarded samples;
- source PCM peak, count of samples equal to S16 extrema, post-conversion peak, NaN/non-finite count, and any limiter/normalizer activation;
- cumulative source samples versus cumulative rendered samples, which detects speed error and clock drift even when speech remains intelligible.

Use a preallocated ring buffer driven by an audio rendering clock (for example, an AudioWorklet or an equivalent direct audio-track writer), not one scheduled source per network chunk. Buffer watermarks and maximum queued duration must be derived from baseline arrival-jitter measurements; this review intentionally sets no unmeasured latency target. When the upper bound is reached, fail visibly and count the event rather than grow latency without limit. Never repair overruns by silently dropping arbitrary PCM or by changing playback rate without recording the policy and resulting sample delta.

For C, test the same page and identical recorded Fish PCM on the default Recall variant and `web_4_core`. Recall explicitly associates choppy output with CPU pressure and recommends the larger variant as a discriminator; that is a test obligation, not proof of the historical cause: [Recall Output Media](https://docs.recall.ai/docs/stream-media).

## 4. Echo, barge-in, cancel, and drain

The current semantic reference is:

- transport drops meeting frames while the agent speaks and during cooldown (`src/transport-meet/meet-routes.js:1379-1404`);
- interim-STT barge-in only operates with the gate open and aborts the active controller after confidence/noise checks (`src/pipeline.js:1280-1321`);
- wake+cancel is evaluated at `utterance_end`, while standalone cancel is intentionally disabled (`src/pipeline.js:1324-1343`, `1390-1392`, `1438-1446`);
- exit uses a fixed three-second grace because “sent” does not mean “played” (`src/pipeline.js:1358-1387`).

A live media shell must not reinterpret these rules. It must replicate the speaking/cooldown state to every input path and guarantee that page-captured or vendor-returned speech cannot re-enter STT as an unlabelled participant. Test and count echo/duplicate frames rather than inferring success from the gate state.

On controller abort, a single cancellation event must:

1. stop accepting chunks for the cancelled utterance;
2. flush all not-yet-rendered samples from the jitter buffer;
3. stop or invalidate already scheduled renderer/video frames;
4. report samples already committed to an irreversible meeting/vendor buffer; and
5. prevent late packets from reviving the utterance.

The required observable is `cancel_requested → last audible sample` and `cancel_requested → last matching video frame`. A renderer that has no utterance-scoped flush/stop primitive is immediately rejected. The PoC should measure playback/drain state, but it must not replace the existing fixed exit grace in this phase.

For D, Tavus notes that Audio Echo bypasses all layers except the replica while interruption responsibility remains with the caller's stream. This is compatible in principle only if queued audio can be cancelled deterministically. LiveAvatar FULL owns ASR/LLM/TTS/WebRTC and is outside the boundary; only LITE merits testing. LITE's documented `agent.interrupt` is the correct control-plane primitive, but the PoC must prove that it flushes queued renderer audio/video and must stop the local send loop at the same cancellation epoch. Events must not be sent until `session.state_updated: connected`, because the official reference warns that earlier events may be silently dropped.

## 5. A/V synchronization measurement

A/V sync must be measured at two points:

1. **Renderer boundary:** correlate each PCM first-sample index with the presentation timestamp of the corresponding viseme/video frame.
2. **Meeting observer boundary:** record the bot as another meeting participant and correlate the captured audio timestamp with the captured frame timestamp.

Use a deterministic calibration asset generated once from the same Fish-format PCM contract: repeated tone/transient markers paired with unambiguous full-frame flashes, followed by a fixed speech sample with known phoneme/viseme timing. Record source timestamps, renderer timestamps, transport timestamps where available, and observer capture timestamps against monotonic clocks. Report offset and absolute skew p50/p95, maximum skew, discontinuities, and drift slope over the full 30-minute run. A single “looks synced” judgment is insufficient.

For live speech, add a secondary correlation of audio energy/forced-aligned phonemes against mouth aperture, but do not substitute it for the marker test. Blind listeners should rate both speech quality and perceived sync because low numerical skew does not rule out distortion or unnatural mouth motion.

No candidate-specific pass number is asserted before baseline. Adoption requires council-approved limits defined from the measured current path, meeting capture precision, and human perceptual results. A candidate that cannot export enough timestamps to locate skew between source, renderer, and meeting is rejected for lack of observability.

## 6. Historical Recall comparison

The old Recall branch changed too many failure domains and collected too little evidence to establish a root cause:

- `d2e8f77` asserted a shared 16 kHz format without captured browser rates or meeting traces.
- `d3d86d7` introduced per-chunk `AudioBufferSourceNode` scheduling and an assumed localhost subscription, without queue or playout metrics.
- `b5fbff1` used `ScriptProcessorNode(4096)`, accepted an uncontrolled capture context rate, and manually averaged down to 16 kHz. A 4096-sample callback spans about 85.3 ms at 48 kHz and 256 ms at 16 kHz before network/STT.
- `0cd1e52` moved capture to an AudioWorklet but preserved a 4096-sample flush and the weak output scheduler.
- `02ece31` removed browser input in favor of Recall raw mixed audio, reducing input-resampling risk but leaving browser output quality and scheduling unmeasured.
- `b9549f6` later enabled the required `recording_config.audio_mixed_raw`, proving earlier artifact configuration was incomplete.
- `bbe1544` changed Fish model, prompts, and tags during the transport experiment; `de1d03e` reverted the bundle without a reason. Current main independently uses S2-Pro at 24 kHz, so the revert is not evidence against current Fish.

The new C PoC must therefore use current 24 kHz Fish output, a frozen recorded PCM corpus, direct Recall mixed input, a bounded clocked output buffer, explicit `web_4_core` comparison, and full timing telemetry. It must not resurrect the branch or attribute historical symptoms—noise, dropout, clipping, wrong speed, or latency are all still unknown.

## 7. Adoption and immediate-rejection conditions

### Common adoption conditions

- The Fish request and pre-transport PCM are identical across baseline and candidates; rolling hashes, sample counts, and no second synthesis prove it.
- Exactly one meeting audio owner is active, with zero duplicate-audio/echo incidents in the scripted run.
- Actual sample rates, resamplers, channel conversions, PCM-to-float conversions, packetization, and meeting codec boundaries are enumerated from measurements.
- Queue depth is bounded; underrun, clipping, reconnect, late-packet, and discarded-sample counters exist and are retained.
- Barge-in and wake+cancel preserve current semantics, and cancellation tail plus video stop are measured.
- Renderer-boundary and observer-boundary A/V skew distributions and drift are retained.
- A 30-minute Google Meet run covers greeting, multiple turns, interruption, long response, and exit, followed by blind A/B audio quality against the static baseline.
- Static mode preserves its current bot payload, image-loading behavior, and single-bot lifecycle (`src/transport-meet/meet-routes.js:823-863`, `1206-1219`, `1290-1300`, `1337-1354`).

### Immediate rejection conditions

- A second Fish/TTS generation, vendor-owned LLM/turn logic, or replacement voice is required.
- The option cannot accept or derive animation from the current Fish PCM without changing Agent Core.
- Two audio paths can reach the meeting, or renderer-returned audio cannot be muted/selected unambiguously.
- Sample rate is assumed rather than observed, resampling is undocumented, or cumulative sample accounting reveals unexplained loss/duplication/rate drift.
- The playout queue is unbounded, lacks underrun counters, or cannot flush by utterance on cancellation.
- There is no way to measure end-to-end A/V timestamps or cancellation tail.
- Blind A/B shows a material Fish-quality regression under thresholds set after baseline.
- Option B remains rejected while Attendee only accepts queued HTTPS MP4 files for `output_video`.
- Recall C omits the default-versus-`web_4_core` discriminator, or D uses a FULL managed pipeline.
- LiveAvatar LITE cannot keep its rendered video within the baseline-derived p95 skew limit without adding an unacceptable bounded delay to meeting audio.

## 8. Preliminary weighted scores

Scale: 0–5 per criterion. Weighted total is out of 100. These are evidence-confidence scores before measurement, not final procurement scores.

| Criterion | Weight | A | B | C | D | E |
|---|---:|---:|---:|---:|---:|---:|
| Fish fidelity and codec control | 30 | 3.0 | 5.0 | 2.5 | 4.5 | 3.5 |
| Buffer/cancel/echo robustness potential | 25 | 3.5 | 4.0 | 2.5 | 3.0 | 4.0 |
| A/V clock control and observability | 15 | 4.0 | 0.0 | 4.0 | 4.0 | 4.5 |
| Static/Agent Core isolation | 20 | 3.0 | 5.0 | 2.5 | 4.0 | 4.0 |
| Current official-contract maturity | 10 | 4.0 | 0.0 | 4.0 | 4.0 | 3.0 |
| **Weighted total** | **100** | **67.5** | **70.0*** | **57.5** | **78.0** | **76.5** |

\* Option B fails a hard contract gate; its theoretical audio-isolation score does not make it eligible.

### Preliminary order and conditions

1. **D (78.0): adopt LiveAvatar LITE as the managed renderer challenger**, because current Fish PCM is natively compatible and can be tee'd byte-identically. Pair it with A for meeting transport; advance only if measured renderer delay can be matched by a bounded meeting-audio delay without failing latency or barge-in quality. Tavus Audio Echo remains a lower-confidence sub-option.
2. **E (76.5): adopt as the renderer/DSP control**, paired with A for the currently documented Attendee live transport. It advances only if browser-path Fish quality remains inside measured baseline-derived limits.
3. **A (67.5): adopt as the first transport PoC**, conditional on a single audio owner, measured actual browser rate, bounded AudioWorklet/equivalent playout, and successful cancel/echo tests.
4. **C (57.5): retain as a historical-reproduction challenger**, built fresh and tested on both default and `web_4_core`; do not advance on visual quality alone.
5. **B: reject now**, regardless of its 70.0 theoretical score, until Attendee publishes a continuous live camera-output contract.

## 9. Unknowns that block a production choice

- Actual Attendee and Recall browser `AudioContext` rates, autoplay state, internal resampler behavior, capture packetization, and audio buffer depth.
- The meeting platform's exact encode/decode path and how much skew/quality loss is introduced after provider capture.
- Historical Recall runtime variant, CPU traces, browser rates, recordings, operator symptoms, and why the branch or S2-Pro bundle was reverted.
- LiveAvatar LITE's renderer-delay distribution, safe packet cadence beyond the reference buffering pattern, acknowledgement/timestamp model, actual `agent.interrupt` flush tail, and bounded meeting-audio delay needed to align its video-only return.
- Tavus Echo's queued-audio cancellation guarantee, meeting handoff, latency distribution, and whether returned audio can be excluded while preserving synchronized video.
- Whether Attendee plans a supported continuous live-camera injection API.
- Baseline distributions for latency, arrival jitter, clipping, dropouts, barge-in, echo, and capture precision; thresholds must follow these measurements.

## 10. Round 1 recommendation

Run one frozen-PCM baseline, then test **A+E as the local control and A+LiveAvatar LITE as the managed challenger**. The LITE starter resolves the major format/fan-out uncertainty: current Fish output is already its native 24 kHz mono S16LE input, and the avatar is video-only. The remaining decision is empirical—whether delaying the one meeting-audio path by a bounded amount can hold p95 A/V skew without making response latency or interruption tail unacceptable. Keep C as a deliberately instrumented Recall comparison. Do not implement B, do not reuse the old Recall scheduler, and do not permit any path to obscure whether a defect originated in Fish, buffering/resampling, renderer timing, provider capture, or the meeting codec.
