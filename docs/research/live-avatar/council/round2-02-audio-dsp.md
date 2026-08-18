# Round 2 — Realtime Audio / DSP Cross-Review

Role: Councilor 2, realtime audio / DSP
Date: 2026-07-23
Scope: cross-review of all five Round 1 proposals; no implementation recommendation

## 1. Updated position

The five reviews converge on the right experiment shape:

- the current Attendee static bot is the immutable audio control;
- Option B is disqualified because Attendee `output_video` is prerecorded HTTPS MP4 playback, not continuous live camera injection;
- Option A is the currently documented Attendee carrier for live page audio/video;
- Option E is the mandatory local renderer control;
- LiveAvatar LITE is the strongest documented managed renderer candidate because its reference input matches current Fish PCM;
- Option C is a fresh, instrumented Recall comparison, not a branch resurrection;
- all FULL managed-agent modes are outside the Agent Core boundary.

My Round 1 recommendation survives, but with a qualification: **native 24 kHz format compatibility makes LiveAvatar LITE admissible; it does not make it lower risk than E or prove A/V synchronization.** The correct PoC is one A carrier harness with frozen PCM, first E and then LiveAvatar LITE, followed by C only when its cross-provider diagnostic value justifies the extra failure domains.

The current vote is therefore:

1. approve the static baseline and instrumented A+E control;
2. approve A+LiveAvatar LITE as the managed challenger;
3. retain C as a later falsification/comparison lane;
4. reject B and all FULL modes;
5. make no production selection before measured audio, cancel, and A/V evidence exists.

## 2. Cross-review of the other proposals

### 2.1 Councilor 1 — Meeting Bot / WebRTC

**Strongest point.** The explicit lifecycle state machine and single-owner failure isolation are essential. “Renderer ready” must precede speech; reconnect generations must not replay stale PCM; teardown must distinguish meeting leave, renderer close, and the current fixed exit grace. This is stronger than treating a successful WebSocket connection as readiness. The proposal also correctly separates a documented carrier (A) from the local and managed renderers it carries.

**Strongest rebuttal.** The claim that LiveAvatar receives “the exact same bytes” as the normal meeting path is true only at the application tee if implemented and hash-verified. It does not establish that LiveAvatar accepts every byte, renders every sample, or that the meeting observer hears an equivalent waveform after browser conversion, capture, WebRTC encoding, and meeting decoding. Likewise, the starter's approximately 400 ms first aggregation and 1 s later aggregation are not measured vendor render latency. The proposal should say “byte-identical outbound payloads before separate transports,” not imply end-to-end identity.

Its score also mixes transport and renderer evidence. D-LITE can score well for Fish input compatibility while still requiring A or C to reach the meeting. E similarly cannot receive an end-to-end meeting score independently of its carrier. Those totals are useful screening priors, but they cannot rank complete architectures until carrier and renderer are scored separately.

### 2.2 Councilor 3 — Avatar / Vendor Integration

**Strongest point.** Separating renderer/vendor scoring from transport scoring is the cleanest model in Round 1. The proposal also correctly distinguishes:

- LiveAvatar LITE's established 24 kHz mono S16LE input;
- Tavus Echo's incomplete encoding/returned-track contract despite a 24 kHz example;
- Simli's explicit 16 kHz input, which requires one measured 24→16 kHz conversion;
- FULL modes, which fail the boundary regardless of visual quality.

This makes “renderer-only” a wire-level property rather than a marketing label.

**Strongest rebuttal.** The vendor scores give too much credit to protocol clarity before cancel, backpressure, acknowledged ingest, render timestamps, and video-only meeting handoff are measured. For example, a documented input format does not prove stable realtime cadence or deterministic queue purge. Simli's 6000-byte preference implies 187.5 ms of 16 kHz mono S16LE audio per preferred chunk, but that arithmetic is neither its total latency nor proof that smaller chunks behave reliably. LiveAvatar's native format avoids a mandatory pre-ingest resampler, but the necessary audio delay for video alignment could erase that advantage in conversational responsiveness.

The proposal is right to rank local E first, but its 91/100 is still a prior. E inherits A's browser and meeting codec path and can consume Mac mini CPU/GPU in ways that damage the audio loop. Local ownership is not evidence of low jitter.

### 2.3 Councilor 4 — Agent Identity / Memory / Skills Boundary

**Strongest point.** The capability-shaped interface is the strongest defense against the avatar becoming a second agent. A renderer needs only an ephemeral render-session ID, media format, appearance key, PCM, flush, close, and media health. It does not need prompts, transcripts, gateway credentials, memory, tools, or stable user identity. The mapping of LiveAvatar `start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt` into a narrow concrete adapter is appropriately specific.

**Strongest rebuttal.** A common `health()` interface must not imply telemetry that the vendor does not actually expose. Local queue depth, bytes sent, and timestamps are observable; remote accepted samples, remote queue depth, first rendered frame, and purge completion may remain unknown. The interface must represent “not observable” rather than synthesizing reassuring counters.

The proposal's unknown list also asks whether Attendee `output_video` supports sustained realtime injection. That is no longer an unknown under the cited contract: it accepts an HTTPS MP4 and is not the live surface required by B. Only the existence of a future, different continuous-camera contract is unknown. This matters because facts should close gates rather than remain indefinitely framed as vendor questions.

### 2.4 Councilor 5 — Skeptic / Security / Operations

**Strongest point.** “Minimal” must include processors, credentials, clocks, session owners, billing meters, rollback steps, and observability—not just glue-code size. The warning that renderer shutdown, stale reconnect generations, orphan billing, and public-page credentials are part of media correctness is persuasive. An operator cannot trust audio cancel if a vendor session can continue rendering or billing after Meetmate exits.

**Strongest rebuttal.** Procurement gates and technical PoC gates should be ordered, not conflated. A sandbox PoC using synthetic/consented likeness, scripted non-confidential PCM, short-lived tokens, hard spend caps, and no real-user traffic can answer timing and cancellation questions before every DPA or production-region term is complete. Production adoption still requires all governance answers. Requiring full procurement closure before a bounded technical experiment could prevent the evidence needed to decide whether procurement is worthwhile.

The skeptic score heavily weights security and rollback, which is appropriate for readiness but not an audio-quality ranking. Its low D score should not be read as evidence that LITE will sound poor; its high E score should not be read as evidence that local rendering will meet CPU or lip-sync requirements.

## 3. Evidence against my own Round 1 recommendation

My Round 1 table ranked LiveAvatar LITE narrowly above E, 78.0 versus 76.5. The cross-review exposes four reasons not to treat that order as substantive:

1. **The scoring unit was mixed.** D-LITE was scored partly as a renderer while A and C were carriers and E was a renderer/control. A complete LiveAvatar architecture is A+D or C+D, not D alone.
2. **Native format fit was overweighted.** LiveAvatar accepts current Fish's nominal 24 kHz mono S16LE format, but A still converts PCM into browser audio and the meeting still applies capture and codec stages. Avoiding a pre-renderer resampler does not preserve the final waveform.
3. **The most important latency is unknown.** The reference's 400–600 ms first aggregation and 1 s later aggregation may be application batching rather than a vendor minimum. Conversely, the vendor may add more queue/render delay. Neither direction is proven.
4. **Audio alignment can harm turn behavior.** Delaying meeting audio to match video adds response latency and may extend audible cancellation tail. If the echo gate follows generation rather than actual playout, delayed audio can shift speaking/cooldown state away from what meeting participants hear.

Evidence also cuts against assuming E is automatically safe. E still needs a supported live carrier; with current Attendee that means A's page capture and browser audio path. Its local renderer can contend with AudioWorklet/page rendering, browser capture, encoding, STT, and Fish on the Mac mini. E is the best control because it removes a vendor clock and vendor queue—not because its end-to-end performance is known.

I therefore revise the interpretation, not the PoC order: E and LiveAvatar LITE are co-equal comparison subjects with different risks. E is the diagnostic/control anchor; LITE is the best documented managed challenger.

## 4. Audio-claim audit

### 4.1 Sample rates and codec boundaries

**Facts**

- Current meeting/STT input is 16 kHz mono PCM (`src/config.js:8`, `316-322`).
- Current Fish TTS defaults to 24 kHz and emits aligned raw PCM chunks using S2-Pro (`src/config.js:9-16`, `350-363`; `src/tts-fish.js:100-123`, `166-183`, `199-259`).
- Current Attendee meeting output labels Fish chunks with `TTS_SAMPLE_RATE` at `src/transport-meet/meet-routes.js:1319-1329`.
- Attendee officially accepts base64 16-bit mono PCM at 8, 16, or 24 kHz: [Attendee Realtime Audio](https://docs.attendee.dev/guides/realtimeaudio).
- The official LiveAvatar LITE reference uses base64 raw mono S16LE at 24 kHz: [LiveAvatar LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python).
- Historical Recall output requested a 16 kHz `AudioContext`; the retained evidence does not show its actual runtime rate. Historical capture created an unconstrained context and retained no measured rate.

**Unknowns**

- Actual Attendee and Recall `AudioContext` rates/states, browser resampler implementation, page-capture rate, WebRTC packetization, and meeting codec behavior.
- LiveAvatar's internal render/audio rate, accepted-versus-dropped sample accounting, and whether any internal conversion occurs after its documented input.

Accordingly, “no resampling is required” is valid only from current Fish output to the LiveAvatar ingress contract. “No resampling occurs” end to end is unsupported.

### 4.2 Same-byte tee

There are three distinct claims:

1. **Source equality:** both branches originate from the one `onAudio(chunk)` callback at `src/pipeline.js:2207-2227`.
2. **Outbound equality:** the meeting and renderer adapters receive/hash the same ordered S16LE sample bytes before transport-specific framing or intentional playout delay.
3. **Rendered equality:** the meeting and avatar render every sample identically.

The first is the intended repository seam. The second is implementable and must be verified with turn ID, sequence, byte count, first-sample index, and rolling hashes. The third is not established and may be false because the branches have different clocks, buffering, conversions, loss, and codecs.

Meeting-audio delay does not invalidate source equality, but it creates a separate bounded queue and changes scheduling. Hashes must exclude base64/JSON framing and compare decoded PCM. “Same-byte tee” must never be used as shorthand for “same timing” or “same audible quality.”

### 4.3 Buffering, jitter, and underrun

**Historical fact:** `d3d86d7` scheduled one `AudioBufferSourceNode` for each received chunk using one `playCursor`; it had no bounded jitter queue, underrun counter, or meeting playout timestamp. `0cd1e52` improved browser input scheduling with an AudioWorklet but did not repair that output design.

**Current LiveAvatar reference fact:** the integration accumulates approximately 400 ms for the first send and 1 s thereafter; the guide recommends approximately 600 ms then 1 s. These are reference feed batches, not proof of a minimum vendor buffer or measured end-to-end latency.

**Required measurement:** distinguish source aggregation, network transit, local playout queue, vendor acceptance, vendor render queue, browser video playout, browser audio playout, and meeting observer capture. Each local queue must have measured depth, a fixed maximum, underrun/overrun counters, and an utterance/epoch-aware flush. Remote queue depth remains “unknown” unless exposed or inferable from acknowledgements and rendered timestamps.

### 4.4 A/V skew

Define the sign before testing:

```text
skew_ms = first matching visible-mouth event at observer
          - first matching audible event at observer
```

Positive skew means video lags audio. Report signed p50/p95, absolute p95, maximum, discontinuities, and drift over the full run. Measure both renderer-boundary timestamps and a separate meeting-observer recording using deterministic audio markers plus frame flashes; add speech/viseme correlation as a secondary test.

The static-image baseline can establish audio latency, quality, and capture precision, but it cannot establish an acceptable lip-sync distribution. A moving local E calibration control is required before setting the A/V gate. Thresholds must be chosen after measuring clock/capture error and conducting blind perceptual review.

For LiveAvatar, compare at least:

- immediate meeting audio versus returned video;
- one bounded, fixed audio delay derived from measured render delay;
- if justified by observed drift, a bounded adaptive policy with every adjustment logged.

Do not hide added audio delay inside an improved skew score. Report Fish-first-PCM → first audible meeting output separately.

### 4.5 Echo, barge-in, cancel, and drain

The existing transport drops meeting frames while the agent speaks/cools down (`src/transport-meet/meet-routes.js:1379-1404`), while interim-STT barge-in is conditional on the gate being open (`src/pipeline.js:1280-1321`). Wake+cancel and standalone-cancel behavior remain as documented at `src/pipeline.js:1324-1343`, `1390-1392`, `1438-1446`.

A page or renderer must not redefine these semantics. However, delayed playout creates a new timing question: does the existing speaking/cooldown state describe Fish generation, bytes queued, or sound actually heard? Until measured, one cannot claim that a 400–600 ms alignment delay preserves echo suppression or interruption. The PoC should correlate gate transitions with queue depth and meeting-observer audible timestamps without changing the existing semantics.

LiveAvatar exposes `agent.interrupt`, and the local sender can stop enqueueing. That proves a cancellation command exists; it does **not** prove that already accepted PCM/motion is purged within an acceptable bound. Measure:

- cancel request → last locally emitted sample;
- cancel request → last audible meeting sample;
- cancel request → last matching avatar frame;
- samples discarded locally versus already submitted remotely;
- stale output after reconnect or a new turn.

Exactly one audio path may reach the meeting. A page-captured Fish path plus current `realtime_audio.bot_output`, or direct Fish plus vendor-returned audio, is an immediate duplicate-audio failure. Echo incidence must be detected in meeting input/recording; a correct boolean gate value alone is not proof.

## 5. What is genuinely different from historical Recall

The proposed comparison differs from `origin/feat/recall-ai` in ways that improve attribution:

- current Fish is S2-Pro at 24 kHz rather than the branch's older 16 kHz-era assumption;
- one frozen current Fish PCM corpus feeds every candidate;
- actual browser rates are recorded instead of requested and assumed;
- input and output variations are separated;
- browser output uses a bounded clocked buffer rather than one source node per network chunk;
- queue, underrun, clipping, sequence, playout, CPU, and A/V telemetry are mandatory;
- Recall default and `web_4_core` are explicit test conditions;
- Fish model/prompt/tag changes are excluded;
- `audio_mixed_raw` enablement is present when direct Recall input is tested.

These differences make the experiment diagnosable; they do not prove it will succeed. C still shares the historical browser-output and provider-replacement topology. CPU pressure, browser resampling, scheduler behavior, WebRTC/meeting codec conversion, network jitter, and echo remain plausible failure domains. There is still no retained evidence for the historical symptoms, affected commit, actual browser rates, compute variant, or abandonment reason. Neither “Recall failed” nor “Recall is fixed” is supported.

## 6. Score audit and revised comparison

The Round 1 totals are not directly comparable:

- Councilor 1 scored complete options but treated D as renderer-only and E as a renderer needing A.
- Councilor 3 correctly split vendor modes and transport modes, though both tables still use unmeasured priors.
- Councilor 4 scored identity boundaries, making counterfactual B numerically high despite disqualification.
- Councilor 5 scored operational/security readiness, not audio fidelity.
- My own table mixed carriers and renderers and gave disqualified B a high theoretical total, which could mislead readers who skip the hard-gate note.

Round 2 should use two scorecards and omit totals for hard-disqualified modes. Scale is 0–5; these remain evidence/readiness priors, not measured quality.

### Carrier scorecard

Weights: audio-path controllability 35%, live-video contract 25%, observability/cancel potential 20%, static/provider isolation 20%.

| Carrier | Audio | Live video | Observability/cancel | Isolation | Weighted /100 | Status |
|---|---:|---:|---:|---:|---:|---|
| A — Attendee page | 3.0 | 5.0 | 3.0 | 3.0 | **70** | Primary Attendee PoC carrier |
| B — Attendee PCM + separate injection | 5.0 | 0.0 | 1.0 | 5.0 | — | Hard-disqualified: no continuous live-video contract |
| C — Recall Output Media | 2.5 | 5.0 | 3.5 | 2.0 | **64.5** | Later cross-provider comparator |

### Renderer scorecard

Weights: native Fish/one-source fit 30%, timing/cancel evidence 25%, observability 20%, privacy/operational isolation 15%, meeting-carrier fit 10%.

| Renderer | Fish fit | Timing/cancel | Observability | Isolation | Carrier fit | Weighted /100 | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| E — bounded local renderer | 5.0 | 4.0 | 5.0 | 5.0 | 4.0 | **93** | Mandatory control; CPU/visual quality unmeasured |
| LiveAvatar LITE | 5.0 | 3.0 | 2.5 | 2.5 | 4.0 | **70.5** | Managed challenger; skew/flush are decisive |
| Tavus Audio Echo | 4.0 | 2.0 | 2.0 | 2.0 | 3.0 | **54** | Contract-discovery fallback |
| Simli audio-to-video | 3.5 | 2.5 | 2.5 | 2.5 | 3.0 | **57** | Requires measured 24→16 kHz conversion |
| Any FULL mode | 0.0 | — | — | 0.0 | — | — | Hard-disqualified by Agent Core boundary |

These revised scores reverse my Round 1 numerical D/E order because they stop giving a renderer credit for the carrier it does not supply and penalize unknown remote queue/render observability. They do not assert that E will look better or that LITE will fail; they select the most discriminating test order.

## 7. Vote-change conditions

I will change the current vote under the following evidence:

- **Promote LiveAvatar LITE to preferred renderer** if outbound PCM hashes and sequences are complete; no meaningful samples are silently dropped; measured render delay is stable enough for a bounded audio-delay policy; signed and absolute p95 A/V skew pass the post-control gate; added audible latency and cancel tail pass; `agent.interrupt`, reconnect, and explicit deletion are deterministic; and blind A/B Fish quality is not materially worse than control.
- **Downgrade or reject LiveAvatar LITE** if alignment requires unbounded/adaptive latency, 1 s batching produces visible cadence artifacts, remote queue state prevents bounded cancel, stale motion/audio survives interrupt, or video cannot be carried without a second audible path.
- **Promote E from mandatory control to production preference** if it meets the explicit visual-quality floor and Mac mini CPU/memory limits while preserving audio underrun, latency, echo, and cancel measurements.
- **Downgrade E to control-only** if stakeholders establish a photorealism requirement it cannot meet, or local render/encoding load materially harms the audio loop.
- **Promote C ahead of A** only if the same page, PCM, renderer, and test script show a repeatable Attendee-specific failure and Recall passes on a declared compute variant without unacceptable cost, latency, or lifecycle regressions.
- **Reopen B** only after Attendee publishes a supported continuous participant-camera output contract with timing, backpressure, cancel, and coexistence semantics. A sales assurance about repeated MP4 replacement is insufficient.
- **Reject the whole live-avatar direction for now** if no candidate preserves one audible Fish path, current cancel/echo behavior, bounded queues, and baseline-relative blind audio quality.

No visual demo, vendor latency claim, or weighted score alone changes the vote.
