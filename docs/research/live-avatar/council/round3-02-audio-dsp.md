# Round 3 — Realtime Audio / DSP Adversarial Debate

Role: Councilor 2, realtime audio / DSP
Date: 2026-07-23
Scope: adversarial review of all five Round 2 submissions; research only

## Position before the nine questions

The council's convergence is useful but dangerous: repeating “24 kHz,” “same-byte tee,” “video-only,” and “explicit interrupt” can make a documented ingress format sound like proven meeting quality. It is not.

Three proof levels must remain separate:

1. **Byte lineage:** the two branches originate from the same Fish sample sequence.
2. **Transport completeness:** each branch accepts every intended sample once, in order, for the correct turn and generation.
3. **Acoustic/temporal equivalence:** participants hear the expected waveform while the corresponding mouth motion arrives within the accepted skew.

Current evidence substantially supports the possibility of level 1 for LiveAvatar LITE. Levels 2 and 3 are unknown. Browser conversion, resampling, queueing, vendor render delay, WebRTC encoding, meeting codecs, loss, and cancellation can break them without changing the source hash.

The 400–600 ms first and approximately 1 s subsequent LiveAvatar values are reference application feed aggregation. They are facts about the reference, not measured vendor buffer depth, first-frame latency, or meeting A/V skew. Delaying meeting audio may improve visible sync, but it also adds response latency, creates another cancel-sensitive queue, and can desynchronize the existing speaking/echo-gate state from what participants actually hear.

## 1 Recall音質原因可能性

**Answer.** The historical root cause is unknown. No retained recording, symptom-to-commit mapping, actual browser rate, packet trace, CPU graph, instance variant, or operator note establishes whether the defect was noise, dropout, clipping, wrong speed, latency, or something else. Therefore no single audio cause may be promoted above the others.

**Facts.**

- `d3d86d7` scheduled one browser `AudioBufferSourceNode` per network chunk with one `playCursor` and no bounded jitter queue, underrun counter, or meeting playout timestamp.
- `b5fbff1` used `ScriptProcessorNode(4096)`, an unconstrained capture `AudioContext`, and manual averaging downsampling.
- `0cd1e52` moved capture to AudioWorklet but retained a 4096-sample flush and did not repair output observability.
- `02ece31` removed browser input in favor of Recall raw mixed input while browser output remained.
- `b9549f6` later added required raw-audio artifact enablement.
- `bbe1544` combined Fish S2-Pro, prompt, and tag changes; `de1d03e` reverted the bundle without recording why.
- The historical Recall payload did not select `web_4_core`; current Recall documentation identifies CPU pressure as one possible cause of choppy output and recommends the larger variant as a test: [Recall Output Media](https://docs.recall.ai/docs/stream-media).

**Inference, not fact.** Browser scheduling, runtime resampling, CPU starvation, network jitter, page capture, meeting codec conversion, or echo/gate behavior could each have caused or amplified a defect. The branch makes all plausible and proves none.

**Smallest falsification test.** Take one frozen current 24 kHz Fish S16LE fixture and run it through a fresh Recall output-only page using one bounded clocked buffer. Run the identical page once on the default variant and once on `web_4_core`, logging actual `AudioContext` rate, arrivals, queue depth, underruns, cumulative samples, CPU, and a meeting-observer recording. This can falsify narrow claims such as “the current default CPU tier is the cause” or “current Recall always damages this fixture.” It cannot reconstruct the historical cause without historical artifacts.

## 2 Attendee webpage再発

**Answer.** Yes, the same *class* of defect can recur. Option A changes the vendor but retains browser PCM conversion/playout, an actual browser clock that may differ from the requested rate, page capture, WebRTC encoding, and a meeting codec. It removes some historical Recall-specific variables; it does not remove the browser-output failure surface.

**Facts.**

- Attendee Voice Agents capture a public page's audio and video into the meeting and expose meeting audio as the page microphone: [Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents).
- Attendee does not document the container's actual `AudioContext` rate, internal resampling path, capture buffer, or exposed A/V presentation clock.
- Current static output instead sends Fish once as `realtime_audio.bot_output` at `src/transport-meet/meet-routes.js:1319-1329`.

**Unknowns.** Autoplay state, actual rate, page CPU headroom, browser capture cadence, Google Meet/Zoom parity, and whether current direct meeting input can remain while page output is the sole audio egress without shifting echo/barge-in behavior.

**Smallest falsification test.** Before adding an avatar, play a frozen Fish fixture through an instrumented A page with a bounded queue. Record simultaneously at the page and from an independent meeting participant. Compare it with the current static path using cumulative sample duration, drop/underrun/clipping counters, objective waveform/spectral measurements, and blind A/B. Log the actual browser rate and stress the page with the exact intended rendering load. A clean run falsifies “recurrence is inevitable”; it does not prove recurrence is impossible under longer load or reconnect.

## 3 LITE renderer-only

**Answer.** LiveAvatar LITE is renderer-only at the documented wire/ownership boundary, subject to observed-behavior verification. It is not a complete meeting path, and “renderer-only” says nothing about latency, queue purge, privacy, cost, or acoustic quality.

**Facts.**

- The official overview assigns STT, LLM, and TTS to the customer in LITE and identifies Fish Audio as an external TTS option: [LiveAvatar overview](https://docs.liveavatar.com/).
- The official starter uses a backend audio WebSocket with `start`, `agent.speak`, `agent.speak_end`, and `agent.interrupt`, accepts base64 raw mono S16LE at 24 kHz, and presents video-only to the frontend: [LiveAvatar LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python).
- Events sent before the connected state may be silently dropped; session deletion is explicit.

**Unknowns.** Accepted-sample acknowledgement, backpressure, remote queue limit, render timestamp distribution, interrupt-to-last-frame tail, reconnect/idempotency, and whether production behavior exactly matches the starter.

**Smallest falsification test.** Start LITE with no vendor LLM/STT/TTS credentials or transcript input. Send only a known PCM fixture and end marker; observe that video is produced and no audio track is exposed to the frontend. Then interrupt mid-fixture and measure the last matching frame. If LITE requires text, vendor TTS, vendor turn decisions, or an inseparable audible track, the renderer-only claim is falsified for this architecture.

## 4 同一Fish PCM二重生成なし

**Answer.** The architecture can use one Fish synthesis and tee one ordered PCM sample stream to the meeting and LITE. This is a feasible source invariant, not yet an observed end-to-end result. The meeting branch may legitimately rechunk, convert S16LE to browser float, resample, and delay; those operations prevent any claim of acoustic byte identity after the fork.

**Facts.**

- Current Fish output reaches one `onAudio(chunk)` callback at `src/pipeline.js:2207-2227`.
- Current Fish defaults to 24 kHz; LiveAvatar LITE's ingress is 24 kHz mono S16LE, so no pre-ingress rate conversion is required (`src/config.js:9-16`, `350-363`; [official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python)).
- Fish already aligns odd byte chunks (`src/tts-fish.js:199-259`).

**Inference to test.** One stamped sample envelope can feed both sinks without a second Fish request, duplicate samples, silent loss, or reordered turns.

**Smallest falsification test.** Stub Fish with a deterministic PCM fixture and count Fish invocations. At the fork, assign turn ID, generation, sequence, first-sample index, and sample count. Decode transport framing at the last locally observable point for each branch and compare ordered PCM hashes and cumulative samples. Any second Fish invocation, missing/duplicated sample range, stale generation, or branch-specific content rewrite falsifies the claim. Separately compare the meeting-observer recording; a matching source hash must not be reported as acoustic equivalence.

## 5 vendorがLLM/STT/turn-takingを握らない

**Answer.** The vendor must not own these layers. LiveAvatar LITE and Tavus Audio Echo are admissible only in modes where already-generated audio is the sole semantic input. FULL modes, Tavus Text Echo, and current end-to-end agent products are rejected even if their latency is better.

**Facts.**

- Meetmate's Agent Core already owns gateway selection, session identity, memory, skills/tools, turn/cancel, and Fish synthesis.
- LiveAvatar FULL owns ASR/LLM/TTS/WebRTC; LITE requires the customer stack: [LiveAvatar overview](https://docs.liveavatar.com/).
- Tavus Audio Echo says it bypasses all layers except the realtime replica, while Text Echo invokes vendor TTS: [Tavus Echo Mode](https://docs.tavus.io/sections/conversational-video-interface/echo-mode).

**Unknowns.** Whether a production vendor account or SDK silently enables moderation, transcript processing, turn inference, or persistent agent memory beyond the documented renderer path.

**Smallest falsification test.** Run with no transcript, prompt, memory, tool schema, user identity, vendor LLM/STT/TTS configuration, or meeting microphone sent to the renderer. Provide only ephemeral renderer ID, appearance key, PCM, end, interrupt, and close. Inspect outbound requests and vendor events. If rendering cannot operate, speech content changes, or vendor turn events become necessary for correct output, the no-brain-layer claim is falsified.

## 6 static無変更

**Answer.** Static must remain structurally unchanged, not merely visually similar. The current payload, image-loading behavior, WebSocket audio path, input/echo semantics, bot ownership, startup, and leave behavior must not depend on any live-avatar credential, SDK, page, queue, or vendor health.

**Facts.**

- Current static bot creation is at `src/transport-meet/meet-routes.js:1206-1219`; static image loading is separate at `823-863`.
- Primary WebSocket replacement and one stored-bot leave are at `1290-1300` and `1337-1354`.
- The research boundary requires no source modification during this phase.

**Unknowns.** A future implementation could still create hidden coupling through shared startup validation, mandatory config, singleton queues, cleanup hooks, or health checks even if the JSON payload appears identical.

**Smallest falsification test.** Snapshot the exact static create payload and emitted audio message sequence on the baseline commit. In the future PoC branch, unset every avatar/vendor variable and make all avatar endpoints unreachable, then run static create, greeting, multiple turns, interruption, long response, exit, reconnect, and leave. Compare the payload byte-for-byte and verify no live module initializes or changes static timing. Any required live dependency or payload difference falsifies “static unchanged.”

## 7 vendor障害時二重Bot/音声なし復帰

**Answer.** Safe recovery means containment, not automatic in-session fallback. On renderer failure: stop new PCM for that generation, flush local queues, invalidate stale media, attempt idempotent renderer deletion, leave the one live bot, and surface an orphan incident if absence cannot be confirmed. Only then may another session start static. Creating a static bot while the live participant might remain is a duplicate-bot mechanism.

**Facts.**

- Current transport has one stored Attendee bot ID and one primary WebSocket owner (`src/transport-meet/meet-routes.js:1290-1300`, `1337-1354`).
- A can duplicate audio if both page playout and current `realtime_audio.bot_output` remain enabled.
- LiveAvatar exposes `agent.interrupt`, but the command's existence does not prove already accepted motion is purged.
- The current three-second exit grace exists because bytes sent are not playback completion (`src/pipeline.js:1358-1387`).

**Unknowns.** Remote queue depth, delete reliability during vendor outage, page survival after server disconnect, Attendee participant-absence confirmation, and the maximum already-committed audio/video tail.

**Smallest falsification test.** During a long deterministic utterance, inject a renderer network failure, page reconnect, and bot transport reconnect one at a time. Attempt stale-generation replay and trigger cancel. From an independent meeting observer, verify one participant identity, one waveform, no second correlated copy/comb filtering, no old-turn audio after the new epoch, and measured `cancel/failure → last audible sample/last matching frame`. Withhold the vendor delete response and prove no replacement bot is created before explicit absence/timeout incident handling. Any overlap falsifies safe recovery.

Delayed meeting audio must be part of this test. The delay queue is an audible owner: cancel must purge it, drain must report it, and an immediate path must never remain active beside it. Gate transitions at `src/transport-meet/meet-routes.js:1379-1404` and interim-STT behavior at `src/pipeline.js:1280-1321` must be correlated with what the observer hears; internal “speaking=false” is not proof of silence.

## 8 最小モジュール数

**Answer.** The smallest discriminating PoC needs **three concrete runtime units plus one test-only harness**, not a platform:

1. **PCM tap/relay:** at the existing Fish callback, stamp generation, turn, sequence, first-sample index, rate, and PCM; own the one-source fan-out and optional bounded meeting-audio delay.
2. **One Attendee live page:** bounded clock-driven audio playout, the minimal local E animation, actual-rate/queue/frame telemetry, and exactly one captured audible output.
3. **One LiveAvatar LITE bridge:** concrete connected/start/speak/end/interrupt/delete mapping and video handoff to the same page.
4. **Test-only replay/observer harness:** frozen PCM, scripted cancel/reconnect/failure, local hashes/counters, meeting recording, A/V/skew and blind-quality analysis.

The first comparison can omit unit 3 and run A+E. C, Tavus, and Simli do not belong in this first implementation slice; each earns a separate concrete adapter only after a named discriminator requires it.

**Inference.** These units are sufficient to distinguish A carrier damage from managed-renderer damage without modifying Agent Core.

**Smallest falsification test.** Attempt the frozen-fixture, cancel, reconnect, and observer protocol using only these units. If a required behavior cannot be located in one unit without moving semantic state into Agent Core or duplicating lifecycle ownership, the module count or boundary is wrong. The answer should then add one concrete responsibility, not a generic framework.

## 9 抽象化は今必要か

**Answer.** No generic avatar abstraction is justified now. A tiny sample-lineage envelope and common test vocabulary are necessary; a provider registry, plugin system, generic lifecycle state machine, capability marketplace, shared vendor config schema, or universal `health()` contract is not.

**Facts.**

- The compared systems do not expose common observability. Local E can report queue/frame state; LiveAvatar may expose only local sends and coarse session events; Recall exposes browser/CPU diagnostics; absence of a remote metric must remain explicit.
- Historical Recall became hard to diagnose because multiple boundaries changed without a stable sample/time envelope, not because it lacked a plugin framework.

**Inference to test.** The only demonstrated common runtime concepts are generation, turn, ordered PCM samples, end, interrupt, close, and local timestamps.

**Smallest falsification test.** Implement the A+E experiment and specify the LITE mapping on paper against the same envelope. If both can express source lineage, one-audio ownership, cancel, and close without type switches that alter semantics, the envelope is sufficient. If a second implemented adapter later repeats identical control code with the same measured meaning, extract that behavior then. Do not generalize merely because two vendors use WebSockets or both have a method named “interrupt.”

Instrumentation can remain test-side or offline where possible. Rolling hashes, clipping/extrema counts, drift analysis, forced alignment, and visual marker analysis are experiment tools; only bounded playout, generation rejection, one-audio ownership, and authoritative cancel are runtime necessities.

## Round 3 vote

Proceed only with a staged comparison:

1. immutable static audio baseline;
2. A page with no avatar, to isolate browser/capture audio;
3. A+E moving local control;
4. A+LiveAvatar LITE with immediate versus bounded-delayed meeting audio;
5. C only for a named carrier discriminator, on default and `web_4_core`.

Keep B and all FULL modes rejected. Do not call LITE proven because its ingress format matches Fish. Promote it only if meeting-observer audio quality, signed/absolute p95 A/V skew, added response latency, cancel tail, reconnect, and one-audio proofs pass the post-control gates.

The decisive adversarial question is not “did both sockets receive the same PCM?” It is: **after two clocks, buffering, interruption, browser capture, vendor rendering, and the meeting codec, did participants hear one complete Fish utterance at the right time—and did both sound and motion stop when Meetmate said stop?**
