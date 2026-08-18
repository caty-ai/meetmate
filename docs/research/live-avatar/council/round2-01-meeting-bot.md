# Round 2 — Meeting Bot / WebRTC Cross Review

Role: Councilor 1, Meeting Bot / WebRTC Architect
Date: 2026-07-23
Scope: Cross-review of all five Round 1 proposals; research only

## Revised position

The council broadly converges on the same hard boundaries:

- preserve the static Attendee payload and image path;
- tap the existing Fish stream once at `src/pipeline.js:2207-2227`;
- keep one bot, one meeting input owner, one Fish synthesis, and one audible output;
- reject Attendee Option B under the current MP4-only `output_video` contract;
- reject managed FULL agent modes;
- use a bounded, timestamped, cancellable Media Shell;
- treat historical Recall symptoms and root cause as unknown.

My vote remains **A+E first, then A+LiveAvatar LITE as the managed challenger**. However, I narrow my Round 1 recommendation in two ways:

1. Option C should not be a mandatory equal benchmark. It should run last, only if its historical-falsification or cross-provider diagnostic value justifies changing the meeting provider.
2. A/C and D/E must not be ranked as if they were interchangeable whole architectures. A and C are meeting carriers; D-LITE and E are renderers. The meaningful comparisons are combinations such as A+E, A+LiveAvatar LITE, C+E, and C+LiveAvatar LITE.

Option B is not a low-scoring candidate. It is **ineligible** until a new official continuous live-camera contract exists.

## Cross-review of Councilor 2 — Realtime Audio / DSP

### Strongest point

The DSP proposal gives the most falsifiable media contract. Its rolling hash and cumulative-sample accounting at the Fish fork distinguish source corruption from transport corruption. Its two-point A/V measurement—renderer boundary and meeting-observer boundary—is also essential. Renderer-local timestamps alone cannot prove what Google Meet or Zoom participants actually receive.

The proposed cancellation observables are especially strong:

- `cancel_requested -> last audible sample`;
- `cancel_requested -> last matching video frame`;
- count of samples already committed to an irreversible buffer.

That is a more useful acceptance contract than a generic claim that `agent.interrupt` or an AudioWorklet “supports cancellation.”

### Strongest rebuttal

The score table ranks D at 78, E at 76.5, and B at a counterfactual 70 even though the scored objects are different layers and B cannot deliver live video. D's 4.5/5 “Fish fidelity and codec control” is supported at the LiveAvatar ingest boundary, but not at the meeting-observer boundary. The official starter proves 24 kHz S16LE compatibility and a same-frame tee; it does not prove rendered-video delay, meeting-audio alignment, or meeting-side codec quality.

Similarly, the roughly 400 ms code buffer / 600 ms guide recommendation and later one-second batches are feed behavior, not measured end-to-end renderer latency. The proposal generally says this correctly, but putting D first can be read as stronger empirical evidence than exists. I would retain its test plan and drop its cross-layer rank.

## Cross-review of Councilor 3 — Avatar / Vendor Integration

### Strongest point

The vendor proposal cleanly separates vendor mode from marketing label. It rejects LiveAvatar FULL, Tavus FULL/Text Echo, and D-ID-style managed pipelines while admitting only audio-driven renderer modes. Its LiveAvatar LITE analysis correctly updates the central uncertainty from “can it accept Fish?” to “can its video be synchronized with the one meeting-audio path without unacceptable delay?”

It also usefully separates renderer contracts:

- LiveAvatar LITE: native 24 kHz mono S16LE, video-only frontend, explicit interrupt;
- Tavus Audio Echo: plausible renderer-only path but returned-audio and cancel ambiguity;
- Simli: concrete 16 kHz PCM contract requiring one measured 24→16 kHz conversion.

This is the strongest vendor-specific screening work in Round 1.

### Strongest rebuttal

The proposal's 91/100 local-renderer score and 81/100 LiveAvatar score are not comparable to the transport table unless a carrier is included. A local renderer cannot enter a meeting under the current Attendee contract without Option A's browser capture; LiveAvatar LITE likewise needs a proven meeting handoff. “Meeting fit” scores of 3 or 4 remain architectural priors, not official end-to-end contracts.

The Simli details are useful additional council evidence, but they were not established in the shared evidence pack. The chair should independently validate those official pages before Simli displaces a shared-evidence candidate. Vendor latency marketing must remain a claim, not a measured result.

Finally, “run C only if A fails” is too absolute. C may be worth one controlled run even if A works when explicit Google Meet/Zoom parity or container CPU observability is a decision requirement. The reason to run C must be named; history alone is not sufficient.

## Cross-review of Councilor 4 — Agent Identity / Memory / Skills

### Strongest point

The identity proposal provides the clearest ownership model. It distinguishes meeting session UUID, gateway `sessionUser`, bot ID, vendor session ID, and ephemeral `render_session_id`, and refuses to reuse one namespace as another. Its deliberately weak renderer interface—

```text
open
pushPcm
flush
close
health
```

—is the best defense against a renderer growing into a second Agent Core. The proposal also correctly maps LiveAvatar-specific `start`, `agent.speak`, `agent.speak_end`, `agent.interrupt`, connected-state gating, and explicit deletion into a concrete adapter rather than polluting the generic interface.

### Strongest rebuttal

There is one direct factual inconsistency. Section 8 lists “Does Attendee `output_video` support sustained realtime participant-camera injection?” as unknown, while the same proposal correctly states elsewhere that the official endpoint accepts queued HTTPS MP4 and is not a continuous live injection contract. Under current evidence, the answer is **no**, not unknown. Only whether Attendee will publish a different future API is unknown.

The minimal-module section also lists an “Attendee video injection” experiment adapter after B has been contract-rejected. That adapter should not exist in the PoC scope unless it means prerecorded animation rather than the live requirement.

Its B score of 4.40/5 is explicitly marked counterfactual, but a disqualified option numerically outranking viable A and C obscures the decision. Hard-rejected architectures should be listed outside the weighted table.

## Cross-review of Councilor 5 — Skeptic / Security / Operations

### Strongest point

The skeptic proposal identifies the operational architecture that the other proposals underweight:

- server-side or short-lived browser credentials;
- synthetic/consented likeness for PoC;
- explicit retention, deletion, training-use, region, and subprocessor review;
- generation/epoch protection against stale reconnect playback;
- local session-duration, concurrency, retry, and spend caps;
- explicit LiveAvatar deletion rather than inactivity-timeout billing;
- rollback that does not depend on the failing vendor.

Its insistence that “minimal” include credentials, processors, billing meters, session owners, and rollback steps is correct. LiveAvatar LITE can be minimal in PCM adaptation while still being non-minimal operationally.

### Strongest rebuttal

The recommended order says to build E before probing A. That is valid only as an off-meeting renderer bench. E cannot be evaluated as a live meeting candidate until a supported carrier exists, currently A. The sequence should say “bench E,” then prove A's single-audio carrier, then evaluate A+E at the meeting observer.

The table calls LiveAvatar's 400–600 ms initial / one-second subsequent buffering “measured.” It is observed in the official reference/guide, but it is not a measured renderer or meeting latency result. This wording should be tightened because the entire council otherwise preserves the distinction.

The operations gates are appropriate before production and many are appropriate before external-data PoC, but not every procurement answer is necessary to run a synthetic, isolated local harness. The gating phase should distinguish:

- before any external vendor call;
- before a meeting sandbox;
- before real-user data;
- before production.

Without that staging, a useful low-risk discriminator can be blocked by a production-level requirement.

## Evidence that weakens my Round 1 recommendation

### A is a larger audio change than my ranking conveyed

My Round 1 called A the documented Attendee live carrier and gave it 3.00/5. That remains factually supportable, but A replaces the known `realtime_audio.bot_output` egress at `src/transport-meet/meet-routes.js:1319-1329` with page playback, browser capture, and WebRTC/meeting encoding. Actual `AudioContext` rate, autoplay state, resampling, capture buffering, and Google Meet/Zoom parity are unknown. Remaining with Attendee does not mean retaining the current media path.

The council's DSP and skeptic reviews therefore weaken any claim that A is “small.” A is only the smallest currently documented Attendee live-video route.

### E's leading score conflates renderer safety with meeting feasibility

My Round 1 gave E 4.15/5. That is defensible for a bounded local renderer, but not for the whole meeting path. E still depends on A and inherits A's browser/audio risks. Its Mac mini CPU/GPU headroom and minimum acceptable visual fidelity are unknown. If the product requirement is photorealism, E may remain a good diagnostic control but cease to be a viable final choice.

### LiveAvatar LITE's native format does not prove acceptable synchronization

The official starter establishes a real improvement over the earlier evidence: current Fish already produces the required 24 kHz mono S16LE, the frontend is video-only, and the backend exposes connected/speak/end/interrupt/delete lifecycle. This supports same-byte teeing and eliminates a second TTS/resampler.

It does not prove that A+LiveAvatar works. The reference buffering can make the video lag immediate meeting audio. Delaying meeting audio may increase p95 response latency, extend the audible cancellation tail, alter the effective speaking/cooldown interval, and complicate the fixed exit grace at `src/pipeline.js:1358-1387`. My D score of 5/5 for preserving the current audio/static boundary was too generous because aligned playout may require deliberately changing live audio timing.

### C may not justify an equal comparison slot

My Round 1 presented C as the cross-provider benchmark. The other proposals correctly emphasize that it changes the meeting provider, reopens the historically confounded browser-output topology, adds compute-tier/cost variation, and has the highest recurrence risk. Recall's explicit Google Meet/Zoom support, 15 fps contract, DevTools, and CPU metrics make it diagnostically valuable, but not automatically necessary.

C should proceed only with a stated discriminator, such as:

- A lacks usable browser/CPU diagnostics;
- Attendee fails one target platform;
- the council needs to distinguish provider capture from renderer behavior;
- a customer requirement demands independently verified Google Meet and Zoom support.

### My score table mixed layers

My Round 1 scored A, B, C, D, and E in one table. That overstates precision:

- A/C are meeting carriers;
- D-LITE/E are renderers;
- B is an absent transport;
- D-FULL is a rejected agent pipeline.

My 3.10 for C versus 3.00 for A also superficially contradicts my A-first recommendation. The difference came from explicit Recall two-platform support and observability, while the sequence was driven by lower change surface. A future score must make those criteria and hard gates separate rather than compressing them into one total.

## How every live candidate differs from historical Recall

The historical facts are limited. The old branch moved through `d3d86d7`, `b5fbff1`, `0cd1e52`, `02ece31`, and `b9549f6`; it used an older 16 kHz-era design, per-network-chunk `AudioBufferSourceNode` playback, no bounded jitter queue or meeting timestamps, changing input paths, an unspecified Recall compute variant, and initially incomplete raw-audio artifact configuration. `bbe1544` mixed Fish/prompt/tag changes and `de1d03e` reverted them without a recorded reason. No retained evidence establishes heard symptoms or a root cause.

### A — Attendee page carrier

A changes the provider from Recall to Attendee and keeps static bot creation separate from live bot creation. The new A test uses current 24 kHz Fish, a clocked bounded playout queue, actual browser-rate capture, utterance-scoped cancellation, and meeting-observer timestamps. It holds Soniox/Agent Core/Fish fixed.

A does **not** eliminate the historical class of browser-output risk. It still sends PCM through a browser audio clock, page capture, WebRTC, and meeting codec. A can reproduce scheduler/resampling/CPU symptoms if its Media Shell is poorly designed.

### B — separate Attendee video injection

B is not a live candidate under current evidence. Historical Recall used webpage A/V output; Attendee B offers only queued HTTPS MP4 playback. Repeated MP4 replacement would be a new unsupported failure mode, not a controlled reproduction or improvement. No PoC should be built.

### C — new Recall Output Media

New C uses a fresh minimal harness, current 24 kHz Fish S2-Pro PCM, identical recorded fixtures, a bounded clocked queue, actual AudioContext-rate logging, sequence/playout telemetry, current Output Media combination constraints, and explicit default-versus-`web_4_core` runs. Direct Recall `audio_mixed_raw` input is enabled correctly and introduced only as a separately labeled condition.

Historical C did not retain actual browser rates, CPU/variant evidence, queue metrics, meeting timestamps, or a result tied to the final hybrid topology. The new controls make attribution possible; they do not prove Recall is now good or that CPU caused the old outcome.

### D — LiveAvatar LITE

Current LiveAvatar LITE consumes raw 24 kHz mono S16LE over its backend WebSocket and returns video to a video-only frontend. It has explicit connected, speak, speak-end, interrupt, and delete lifecycle. The same Fish bytes can feed the renderer and the one meeting-audio path.

The historical dossier does not preserve enough HeyGen implementation detail, session IDs, API version, recordings, or logs to claim a precise code-level comparison. It is safe only to say that legacy HeyGen Interactive Avatar examples are not current LiveAvatar API evidence and that the current LITE contract is now documented. Any claim that LiveAvatar “fixes the old HeyGen failure” would be unsupported.

### D — Tavus Audio Echo

Tavus accepts pre-generated audio while bypassing the other conversational layers. Unlike historical Recall browser scheduling, its renderer queues and synchronized returned tracks are vendor-managed. Exact encoding/cadence, cancellation tail, and returned-audio ownership remain unknown in the shared evidence. If tested, it must use Fish once and select either returned audio or direct Fish as the sole meeting output.

There is no historical Tavus trial in the dossier, so it is neither validated nor implicated by the Recall history.

### Managed Simli candidate

The vendor councilor reports an official 16 kHz mono PCM audio-to-video contract. Unlike current Fish-native LiveAvatar LITE, Simli would add one explicit 24→16 kHz renderer-only resampler. The original Recall branch also involved rate assumptions/resampling, but Simli's new test would retain original 24 kHz for the meeting leg, stamp samples before conversion, and measure the renderer conversion independently.

Because Simli was not part of the shared evidence pack, these facts require independent official-source validation before it enters the council's final comparison. There is no historical Simli trial.

### E — bounded local renderer

E keeps rendering local and derives envelope/viseme state from current Fish PCM. It adds no Recall bot, avatar vendor audio queue, vendor session, vendor resynthesis, or external likeness/voice processor. Cancellation and render timestamps can be controlled locally.

When E is carried by A, browser capture/WebRTC remains; thus E isolates renderer-vendor risk but not the historical class of browser/meeting transport risk. Its result must be described as A+E, not E alone.

### FULL managed modes

LiveAvatar FULL, Tavus FULL, and similar D-ID pipelines differ from historical Recall by taking even more ownership—ASR, LLM, TTS, WebRTC, or turn logic. That difference violates the Meetmate boundary rather than improving the experiment. They remain rejected without PoC.

## Factual and scoring inconsistencies to resolve

1. **B is factually rejected, not unknown.** Round 1 Councilor 4's unknown list contradicts the shared official MP4-only contract.
2. **Reference batching is not measured latency.** Councilor 5's table uses “measured” for the 400–600 ms / one-second LiveAvatar reference behavior. No meeting latency or p95 render delay has been measured.
3. **D means two different things.** Some proposals score D as LiveAvatar LITE renderer-only; the vendor proposal defines D as FULL managed pipeline and places LITE under A/C. Both taxonomies can be internally coherent, but their D scores cannot be compared.
4. **E means renderer or end-to-end path depending on table.** E scores of 4.15/5, 76.5/100, 91/100, and 4.68/5 variously include or omit A's carrier risk.
5. **Counterfactual B scores are misleading.** B receives 70/100, 78/100, or 4.40/5 in several tables despite a zero/missing live-video contract. Hard-rejected B should be removed from ranked totals.
6. **C's role differs.** It is variously an equal benchmark, fallback only after A failure, and last historical falsification. The final plan must name the discriminator that earns C a run.
7. **No scores are performance results.** The scales, weights, and candidate definitions differ. They are evidence priors and must not be averaged across councilors.
8. **Simli is not yet shared evidence.** Its vendor-council details should be verified before the chair treats its score as council-wide fact.

## Revised comparison frame

Use hard gates first, then score complete combinations.

| Combination | Current status | Primary discriminator |
|---|---|---|
| Static Attendee | Required baseline | Existing audio quality, latency, barge-in, exit |
| A+E | First live control | Cost of browser capture plus bounded local rendering |
| A+LiveAvatar LITE | Managed challenger | Visual gain versus renderer delay, added audio delay, lifecycle/privacy |
| C+E | Conditional transport comparator | Recall versus Attendee page/container behavior |
| C+LiveAvatar LITE | Conditional full comparison | Only after carrier and renderer effects are separately attributable |
| B+any live renderer | Rejected | No official continuous camera injection |
| FULL managed mode | Rejected | Violates Agent Core ownership |

No combination advances without actual browser rates, bounded queues, one-audio proof, cancellation tail, meeting-observer A/V skew, reconnect behavior, CPU/memory, and blind audio comparison.

## What would make me change my vote

I would move from **A+E first, A+LiveAvatar LITE second, C conditional** only on one of these evidence sets:

- **Vote for C first:** Attendee A cannot provide a single reliable audio owner, cannot expose enough browser diagnostics, fails required Google Meet/Zoom behavior, or measured A audio quality is materially worse than static while a fresh C run passes the same protocol.
- **Vote for LiveAvatar LITE as the lead renderer:** A+LITE beats A+E on the agreed visual requirement while meeting baseline-derived p95 response latency, observer-boundary A/V skew, cancellation tail, barge-in, explicit deletion, privacy, and cost gates.
- **Vote for E as the production renderer:** stakeholders define a bounded non-photorealistic visual floor that A+E meets, and the Mac mini shows adequate CPU/GPU headroom without audio regression.
- **Revive B:** Attendee publishes a new official continuous participant-camera API with timestamps/synchronization, backpressure, cancellation, realtime-audio coexistence, and required platform support.
- **Admit Tavus or Simli ahead of LITE:** the exact PCM, returned-track, cancellation, latency, lifecycle, privacy, and cost contracts are independently verified and then beat LITE under identical Fish PCM and carrier conditions.

Before changing any vote, I require a recorded static baseline and the same frozen current Fish PCM corpus, test script, meeting platform, observer capture, and scoring thresholds for every compared combination. A better-looking demo, an advertised latency, or an unexplained successful call is not sufficient.
