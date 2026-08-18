# Round 3 — Avatar / Vendor Adversarial Debate

Role: Councilor 3, Avatar / Vendor Integration Architect
Date: 2026-07-23
Scope: adversarial review after reading all five Round 2 submissions; research only

## Adversarial thesis

The emerging sequence—static baseline, then A+E, then A+LiveAvatar LITE—is directionally safe but not the smallest falsifying sequence. It couples two questions too early:

1. Can Attendee’s webpage carrier preserve audio and expose usable clocks?
2. Can a renderer consume Fish PCM, cancel deterministically, and produce acceptable video timing?

The first question can be tested with a calibration page that plays frozen Fish PCM and renders deterministic flashes/mouth states; it does not require a product-quality local E renderer. The second can be tested off-meeting with frozen PCM against local E and LiveAvatar LITE; it does not require waiting for the Attendee carrier to pass. The smallest evidence plan is therefore two independent lanes:

```text
carrier lane:  static baseline -> A calibration page -> optional C calibration page
renderer lane: frozen PCM -> bounded local E bench
                         -> LiveAvatar LITE sandbox bench

compose only after both relevant lanes pass:
  A+E
  A+LiveAvatar LITE
```

This challenges the *strict order*, not the candidates. A+E remains the required meeting control before A+LITE can win an end-to-end comparison. But building a visually credible E before probing LITE’s already-documented wire contract is not justified if E’s visual floor is unknown or photorealism is mandatory.

### Boundary facts before debate

| Mode | Fact | Boundary result |
|---|---|---|
| LiveAvatar FULL/Embed | [Official overview](https://docs.liveavatar.com/) assigns ASR, LLM, TTS, and WebRTC to the vendor | Reject: not renderer-only for this brief |
| LiveAvatar LITE | [Official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) accepts base64 raw 24 kHz mono S16LE, exposes start/speak/end/interrupt, tees upstream TTS frames, and has a video-only frontend | Renderer-only at the documented wire boundary; meeting timing, remote queue purge, and operations remain unproven |
| Tavus Audio Echo | [Echo docs](https://docs.tavus.io/sections/conversational-video-interface/echo-mode) say pre-generated audio bypasses every layer except Realtime Replica | Plausible renderer-only; encoding, returned-audio ownership, backpressure, and utterance-scoped cancel remain incomplete |
| Tavus Text Echo / FULL CVI | Text Echo invokes vendor TTS; FULL owns perception/turn/STT/LLM/TTS | Reject |
| Simli audio-to-video | Official WebRTC docs specify PCM Int16 mono 16 kHz audio-to-video | Renderer-focused, but requires measured 24→16 kHz conversion and still lacks a proven cancel/output-ownership contract |
| Current D-ID realtime agent | Current overview describes STT, turn detection, LLM, TTS, and avatar | Reject from this shortlist unless a distinct supported renderer-only contract is produced |
| Local bounded E | Meetmate owns PCM, animation derivation, queue, clocks, and cancel | Renderer-only by construction if it remains bounded; visual quality, licensing, and Mac mini load are unknown |

Every answer below distinguishes **Fact**, **Inference**, **Unknown**, and the **smallest falsifying experiment**. “Falsifying” means the shortest test that can disprove the contested favorable claim; passing it is necessary, not sufficient for production.

## 1) なぜ以前のRecall構成は音質が悪かった可能性があるのか。

**Fact.** The repository does not retain a recording or structured observation proving that the audio was noisy, clipped, slow, fast, delayed, or dropping. It therefore cannot prove “音質が悪かった” as a measured historical fact. What is proven is a high-risk experiment design:

- `d3d86d7` scheduled one `AudioBufferSourceNode` per received chunk with one `playCursor`, without a bounded jitter buffer, underrun count, or meeting playout clock.
- `b5fbff1` used an unconstrained capture AudioContext, `ScriptProcessorNode(4096)`, and manual average downsampling.
- `0cd1e52` improved input scheduling but retained the weak output path.
- `02ece31` changed input again to Recall raw mixed audio; `b9549f6` later added the required artifact enablement.
- the payload did not identify a Recall compute variant; current [Recall Output Media documentation](https://docs.recall.ai/docs/stream-media) connects CPU pressure with choppy output and recommends testing `web_4_core`.
- `bbe1544` mixed Fish/prompt/tag changes into the transport experiment and `de1d03e` reverted them without a stated reason.

**Inference.** Browser scheduling, actual-rate mismatch/resampling, CPU starvation, WebRTC/meeting codec conversion, network jitter, echo/gating, or the mixed Fish changes could each have degraded perceived audio. None is established as the cause.

**Unknown.** Actual symptom, affected commit, final hybrid result, AudioContext rates, instance variant, CPU trace, packet arrival, meeting platform, and abandonment reason.

**Smallest falsifying experiment.** To falsify the leading *scheduler* claim, replay one frozen 24 kHz Fish fixture in the same current Recall container through (a) the historical per-chunk scheduler and (b) one bounded clock-driven buffer, holding page, compute tier, network route, and meeting constant. Retain observer recording, actual rates, arrivals, queue depth, underruns, and cumulative samples. If there is no repeatable quality/timing difference, the scheduler-alone hypothesis loses support; it does not exonerate resampling, CPU, codec, or network. Test default versus `web_4_core` separately to falsify the CPU-tier hypothesis.

## 2) Attendee webpage方式でも同じ問題が再発しないか。

**Fact.** [Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents) captures a public page’s audio and video into the meeting. A therefore shares the historical *class* of browser-output boundaries: PCM-to-browser conversion, actual AudioContext clock, page capture, WebRTC, meeting codec, CPU, network, and reconnect. Remaining with Attendee preserves vendor familiarity, not the current `realtime_audio.bot_output` media route.

**Inference.** A may reduce provider/lifecycle change relative to Recall and a bounded instrumented queue may prevent historical scheduler errors. That makes attribution better, not recurrence impossible.

**Unknown.** Actual Attendee AudioContext rate/state, resampler, capture buffer, CPU visibility, autoplay behavior, Google Meet/Zoom parity, and whether direct current meeting input can remain while page output is the only egress without changing echo/barge-in semantics.

**Smallest falsifying experiment.** Do **not** build E first. Load an A calibration page that plays one frozen Fish fixture from a bounded queue and displays deterministic frame flashes/mouth transitions keyed to sample indices. Disable current WebSocket output for that live bot. Record actual browser rate/state, queue/underruns, one-audio proof, observer-side waveform and A/V timestamps, cancel tail, and reconnect behavior. A single baseline-relative regression falsifies “A is a safe carrier” before avatar work. If A passes, it still has not proven LITE or E.

This is the strongest reason to weaken the strict A+E-first sequence: the carrier can be falsified with less code and no avatar-quality debate.

## 3) LiveAvatar LITEは本当に映像rendererだけとして使えるか。

**Fact.** At its documented interface, yes: the official LITE starter sends already-generated 24 kHz mono S16LE through `agent.speak`, ends via `agent.speak_end`, interrupts via `agent.interrupt`, and renders video to a video-only frontend. It does not require transcript text in that path. This is materially different from LiveAvatar FULL, which owns ASR/LLM/TTS/WebRTC.

**Inference.** “Renderer-only at the wire” implies Meetmate can keep semantic authority if the integration sends only PCM plus ephemeral render/session data. It does **not** imply the vendor is stateless operationally: LITE still owns avatar assets, a remote render queue, WebRTC/session state, availability, credentials, and billing.

**Unknown.** Remote accepted-sample acknowledgement, queue/backpressure limit, first-frame timestamps, interrupt-to-last-frame purge, reconnect/idempotency, retention/training/region, and failure-time deletion/billing behavior. The reference’s roughly 400 ms first batching (guide roughly 600 ms) and later roughly one-second batching are feed behavior, not end-to-end render latency.

**Smallest falsifying experiment.** Before any meeting integration, create one capped sandbox LITE session with a synthetic avatar and non-confidential frozen PCM. Send no text, microphone, LLM, STT, or turn data. Gate on connected; send sequence-marked speech/tone bursts; issue local send-stop plus `agent.interrupt` mid-burst; inspect browser network/media tracks; verify the frontend emits video and no audible track; measure last matching frame; explicitly delete and reconcile the session. Any required text/TTS/turn service, audible vendor track, stale post-interrupt frames beyond the gate, or continued session/billing falsifies the favorable renderer-only integration claim.

Passing cannot prove absence of all hidden internal processing; production still requires a contractual data-use statement.

## 4) Fish AudioのPCMを二重生成せず、会議音声と口の動きへ同じsourceとして渡せるか。

**Fact.** The current one-source seam exists at `onAudio(chunk)` (`src/pipeline.js:2207-2227`). Current Fish output defaults to 24 kHz mono S16LE, matching the documented LiveAvatar LITE ingress and Attendee’s supported realtime-audio rates. LITE’s official reference demonstrates a tee of upstream TTS frames to renderer and ordinary downstream audio. Therefore a second Fish request or vendor TTS is not technically required.

**Inference.** Stamping before fan-out can prove both outbound branches derive from the same ordered source samples. It cannot prove the vendor accepted/rendered every sample, nor that the meeting observer hears the same waveform after separate clocks, browser conversion, capture, and codecs. “Same source” is not “same timing” or “same output bytes.”

**Unknown.** Vendor ingest loss/acknowledgement, internal conversion, and the delay policy required to align direct meeting audio with LITE video.

**Smallest falsifying experiment.** Use one pre-recorded PCM fixture so the Fish call count is exactly zero during replay (and separately assert one Fish request in a live-turn test). Stamp turn, sequence, first-sample index, byte count, and decoded-PCM hash before fan-out. Hash the meeting-adapter and LITE-adapter inputs after decoding transport framing; count samples; observe meeting audio for doubled waveform/echo; correlate video. A mismatched source hash/sample count, a second synthesis/TTS request, or two audible copies falsifies the claim. Matching hashes prove source lineage only.

For Tavus, the same experiment must choose returned audio *or* direct Fish as the sole egress. For Simli, hash lineage branches before its intentional 24→16 kHz conversion and separately account for converted sample indices.

## 5) avatar vendorがLLM/STT/turn-takingを握らずに済むか。

**Fact.**

- LiveAvatar LITE: yes at the documented mode boundary.
- Tavus Audio Echo: yes in stated mode; only Realtime Replica remains.
- Local E: yes by construction.
- Simli audio-to-video: its documented purpose is renderer-focused, though control-plane evidence is less complete.
- LiveAvatar FULL, Tavus FULL CVI, Tavus Text Echo, and the current D-ID realtime-agent path: no under this brief.

**Inference.** A capability-limited server adapter plus a short-lived browser token can enforce the boundary: vendor receives PCM, format, opaque appearance/session capability, end/cancel, and nothing semantic.

**Unknown.** Whether each managed vendor’s production authentication/token scope can prevent access to other agent features, and whether moderation or transcript-like processing is mandatory behind the renderer API even when no text is supplied.

**Smallest falsifying experiment.** Provision a least-privileged sandbox project and run the candidate with outbound network logging plus an allowlist containing only create-render-session, PCM, end/cancel, video receive, and delete. Deny microphone, transcript, prompt, memory, tool schemas, gateway/session IDs, and text endpoints. If the session cannot render, cannot cancel, or requests a semantic service, the “vendor need not own the brain” claim is falsified for that mode. A polished FULL demo is irrelevant.

## 6) static-image経路を本当に無変更にできるか。

**Fact.** The current static payload and separately loaded `bot_image` path are known. A future design can branch before bot construction so static continues to build exactly that payload. No live avatar implementation exists yet, so “truly unchanged” has not been proven.

**Inference.** Source-level payload equality is achievable, but insufficient. Static is changed operationally if startup requires live-avatar environment variables, imports/initializes an SDK, shares a failing singleton/queue/timer, depends on a live health check, or has live cleanup hooks.

**Unknown.** The future module-import, configuration-validation, startup, health, and cleanup effects because implementation is intentionally out of scope.

**Smallest falsifying experiment.** In the eventual PoC branch, run the existing static regression with every live credential absent and all avatar endpoints blackholed. Snapshot and byte-compare the bot-create request, image bytes/path behavior, greeting/turn/interruption/exit/leave events, and verify no avatar DNS/network call, SDK initialization, timer, or required config occurs. Any difference falsifies “unchanged.” A passing test establishes only the covered static behavior, so it must remain a permanent regression gate.

## 7) vendor障害時に二重Botや二重音声を発生させず戻せるか。

**Fact.** The safe rollback has two meanings:

1. **Control-plane rollback:** disable live mode before bot creation so all new sessions use unchanged static behavior without contacting the vendor.
2. **Active-session containment:** stop new PCM, invalidate the generation/queue, attempt renderer deletion, leave the one live bot, and surface an orphan incident if absence cannot be confirmed.

An in-session switch from an A live bot to a static bot is not the unchanged static path; it creates a new participant. Attendee reconnect or stale browser/vendor queues can independently duplicate audio even with one Fish synthesis.

**Inference.** Generation/epoch rejection, one output owner selected before creation, idempotent close/delete, and “leave then verify absence before recreate” can prevent ordinary duplicates. They cannot guarantee remote deletion during a vendor/network partition.

**Unknown.** Provider-specific bot-absence confirmation, renderer delete idempotency, stale WebRTC track behavior, and the acceptable orphan containment policy.

**Smallest falsifying experiment.** In a sandbox meeting, inject vendor disconnect after partial speech, reconnect race, lost delete response, and vendor 5xx while recording as another participant. Assert one bot identity, one waveform, no stale old-generation audio/video, local queue zero, bounded retries, leave attempted once, and **no static replacement until original absence is verified**. Any overlapping participant/audio falsifies safe fallback. If absence cannot be verified, the correct result is contained failure, not automatic recovery.

This evidence supports the council’s refusal to implement cross-provider automatic failover.

## 8) 最小モジュールはいくつ必要か。

**Fact.** The comparison needs five responsibility units, but they need not become five production abstractions:

1. test-only frozen fixture and observer/metrics harness;
2. one live-session media coordinator for source stamps, selected single egress, generation, cancel, close, and bounded optional delay;
3. one concrete A carrier page/controller;
4. one bounded local E renderer used by the page;
5. one concrete LiveAvatar LITE adapter.

Option C, Tavus, or Simli each adds one concrete experiment adapter only if a named discriminator earns the test.

**Inference.** Combining coordinator and route code may reduce file count but not responsibilities. Conversely, splitting every metric, lifecycle state, vendor, transport, and renderer into interfaces would not reduce risk.

**Unknown.** Which code boundaries are natural until two concrete paths exist. The comparison can retain metrics in the harness instead of a permanent telemetry module.

**Smallest falsifying experiment.** Implement the A calibration page and off-meeting LITE bench as concrete test spikes using one shared event envelope but no registry/framework. If one-audio selection, generation/cancel, or comparable timestamps must be duplicated inconsistently, that falsifies the claim that no small coordinator is needed. If the two adapters share only PCM bytes and close semantics, that falsifies the need for a larger common lifecycle abstraction.

The number “five” is a responsibility count, not permission to create a five-layer framework.

## 9) その抽象化は今必要か、将来のためだけの過剰設計ではないか。

**Fact.** The historical branch already demonstrates the present need for a few common experiment fields: turn/sequence/sample lineage, actual clocks, bounded queues, authoritative cancel, generation, and one-output ownership. It does not demonstrate a need for plugin discovery, provider registries, dependency-injection containers, generic vendor configuration, capability negotiation, persistent renderer identity, or automatic Attendee/Recall failover.

**Inference.** One small event envelope and a live-only coordinator are justified by current falsification and safety needs. A generic “Media Shell platform” is not justified until concrete A+E and A+LITE implementations show stable common behavior.

**Unknown.** Whether Tavus, Simli, or C will ever enter production; designing their imagined commonality now is speculation.

**Smallest falsifying experiment.** Build the two thin concrete adapters first and record duplicated logic. Extract only behavior that is identical, independently tested, and necessary in both. If a third candidate can be added by only mapping the small envelope and cancel/close without changing it, the abstraction is sufficient. If the envelope must gain vendor-specific session, agent, transcript, or transport concepts, reject the abstraction rather than generalize Agent Core around the vendor.

Therefore: **yes** to a current-purpose media envelope, bounded one-output coordinator, and test harness; **no** to a future-proof avatar plugin architecture.

## Adversarial disposition

The vendor evidence both supports and weakens the council sequence:

- It **supports testing LITE early off-meeting** because its native Fish contract, video-only frontend, interrupt command, and explicit lifecycle are more concrete than the yet-unspecified E implementation.
- It **supports A+E before A+LITE as an end-to-end meeting verdict** because E removes the remote renderer clock/queue and therefore isolates A’s carrier.
- It **weakens building E first as a product candidate** because no visual floor, implementation, license, or Mac mini profile exists. A deterministic calibration renderer is enough to test the carrier.
- It **weakens calling LITE the winner** because native PCM compatibility does not solve split A/V clocks, cancel tail, privacy, lock-in, orphan billing, or meeting capture.
- It **keeps Tavus Audio Echo alive** as a possible answer to split-clock A/V if its synchronized returned track can become the sole meeting audio and its cancel/format contract is confirmed.
- It **keeps C conditional but not forbidden**: one controlled C calibration run is justified if A lacks required diagnostics/platform parity or if the chair needs a carrier-level cross-check, even when A appears acceptable.

My Round 3 vote is:

1. baseline the current static bot;
2. run the minimal A carrier calibration, not a polished E;
3. in parallel, bench bounded E and LiveAvatar LITE off-meeting with the same PCM;
4. compose A+E as the observer-side control;
5. compose A+LITE only after A and LITE independently pass;
6. admit Tavus/Simli/C only on a named falsification question;
7. reject B and all FULL/brain-owning modes.

No production vendor is selected. The first failed hard gate ends that candidate’s lane; visual realism cannot compensate for a second brain, second voice, unbounded queue, unobservable A/V clock, unsafe rollback, or a changed static path.
