# Round 4 — Skeptic / Security / Operations Revised Proposal

Status: revised proposal and vote; no implementation approval
Date: 2026-07-23
Role: Councilor 5, skeptic / security / operations
Reviewed: all five Round 3 submissions

## Revised conclusion

**Do not adopt any live-avatar architecture now. Approve at most two comparison PoCs: A+bounded E and A+LiveAvatar LITE, only after shared prerequisites pass.**

This is a vote for a measured comparison boundary, not for production rollout, a vendor, or a generalized Media Shell. B and all FULL managed-agent modes are disqualified. C+E and C+LITE remain conditional diagnostic alternatives, not part of the first two-candidate comparison.

The first executable step is smaller than either candidate: a static baseline followed by an avatar-free A carrier probe using frozen PCM and deterministic visual markers. If A fails its hard gates, neither A+E nor A+LITE should be built.

## What changed in my opinion

### 1. I now support A+E as one of the two comparison candidates

In Round 3 I questioned whether A+E was worth building at all. The other Round 3 proposals make the strongest case for a **bounded** E: it supplies a locally observable moving control at the meeting boundary and separates Attendee carrier failure from managed-renderer failure. I therefore support A+E after the carrier-only probe passes.

This is not support for a polished local avatar. E should be no more than the minimum visual calibration/product discriminator—such as three mouth states or deterministic sample-indexed motion. Asset systems, phoneme frameworks, GPU inference, photorealistic models, and a generic renderer API remain out of scope.

### 2. I raise LiveAvatar LITE from contract probe to the second comparison PoC

The [LiveAvatar overview](https://docs.liveavatar.com/) and [official LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) establish more than I originally credited: raw mono S16LE at 24 kHz, video-only frontend, explicit `agent.speak_end` and `agent.interrupt`, connected-state gating, and explicit session deletion. That matches current Fish ingress without a second TTS or mandatory renderer resampler.

I still do not call LITE production-ready. Accepted-sample accounting, remote queue bounds, render-delay distribution, cancel tail, deletion/billing under failure, privacy terms, and meeting-side A/V behavior remain unknown.

### 3. I move C out of the primary comparison

Round 3 strengthens the case that C is a named discriminator, not a ritual replay of history. C changes meeting provider, bot lifecycle, compute tier, browser container, credentials, cost, and failure domain. It should run only if A fails for an Attendee-specific reason, lacks required telemetry/platform parity, or the chair needs a cross-provider carrier result.

The old Recall branch remains diagnostically relevant but not predictive. [`d3d86d7`](https://github.com/caty-ai/meetmate/commit/d3d86d7) used per-network-chunk browser scheduling without bounded queue/timing evidence; later commits changed capture, input transport, artifact configuration, and Fish/prompt variables. A fresh C could be better instrumented, but that does not make it a low-risk first candidate.

### 4. I retain the strict rollback and abstraction dissent

“Fallback” means new sessions can use static without any avatar vendor. It does not mean spawning a static bot while a failed live bot may still be present. In-session automatic fallback remains rejected.

Only a small source-lineage/control envelope and concrete adapters are justified now. A provider registry, universal lifecycle engine, generic vendor config, automatic Attendee/Recall failover, or billing/telemetry platform would be premature.

## Hard gates before scoring

Weighted totals never override these gates:

- one Meetmate Agent Core and one Fish synthesis;
- exactly one bot and one audible meeting-output owner per generation;
- no vendor-required LLM, STT, TTS, memory, tools, or turn authority;
- no durable client-visible credential;
- static startup and operation independent of all live credentials, SDKs, endpoints, health checks, and cleanup;
- bounded local queues, stale-generation rejection, authoritative cancel, and explicit cleanup;
- no automatic static recreation until the live bot's absence is proven;
- synthetic/consented likeness and non-confidential audio for sandbox work;
- hard duration, concurrency, retry, and spend limits;
- enough observer-side evidence to locate audio, A/V, reconnect, duplicate, and cancellation failures.

B fails the capability gate because [Attendee `output_video`](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video) accepts queued HTTPS MP4 playback rather than a continuous live camera stream. FULL LiveAvatar/Tavus/current end-to-end agent modes fail the Agent Core gate. They are **DQ**, not low-scoring alternatives.

## Composite ranking under the required weights

Scores are 0–5 evidence/readiness priors, converted to the required 100-point matrix. Unknowns score 1–2 unless a documented architecture materially reduces the risk; they do not receive a neutral 3. These are not measured performance results.

| Composite | 現在のFish Audio品質維持 25 | 人格・記憶・スキル・ツールの完全維持 20 | staticモードとの隔離・差分の小ささ 15 | latencyとA/V同期 15 | 会議での安定性 10 | 費用・privacy・運用 10 | vendor交換可能性 5 | Total /100 | Rank |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A + bounded E** | 3.0 | 5.0 | 3.0 | 2.5 | 3.0 | 4.0 | 4.0 | **69.5** | **1** |
| **A + LiveAvatar LITE** | 3.5 | 4.5 | 3.0 | 1.5 | 1.5 | 1.0 | 2.5 | **56.5** | **2** |
| **C + bounded E** | 2.0 | 4.5 | 1.5 | 2.0 | 2.0 | 2.0 | 3.0 | **49.5** | **3** |
| **C + LiveAvatar LITE** | 2.5 | 4.0 | 1.5 | 1.0 | 1.0 | 0.5 | 1.5 | **40.5** | **4** |
| **B + any live renderer** | — | — | — | — | — | — | — | **DQ** | — |
| **Any FULL managed-agent mode** | — | — | — | — | — | — | — | **DQ** | — |

Weighted calculations use `(raw score / 5) × criterion weight`.

### 1. A + bounded E — 69.5

Why it leads:

- E derives motion locally from the one Fish source and sends no voice/likeness to a second avatar processor.
- Agent identity, memory, skills, tools, and turn authority can remain fully local.
- Local queue/frame/cancel behavior is observable, and renderer removal is comparatively clean.

Why it does not score higher:

- A replaces the current realtime WebSocket output with browser playback, page capture, WebRTC, and meeting codec.
- Actual browser rate, resampling, autoplay, capture buffer, CPU headroom, Google Meet/Zoom parity, and observer audio remain unknown.
- Static isolation is a design intention until tested with live dependencies absent/blackholed.
- E's visual floor, Mac mini load, encoding cost, asset/model licensing, and product relevance are unknown.

### 2. A + LiveAvatar LITE — 56.5

Why it ranks second:

- The documented 24 kHz PCM contract supports one-source lineage without second TTS/resampling before renderer ingress.
- LITE is renderer-only at the documented wire boundary and keeps a video-only frontend.
- A is the only currently documented Attendee live A/V carrier.

Why unknowns materially lower the score:

- Two independent clocks—page audio and remote video—create unmeasured A/V skew. Reference feed batching is not measured meeting latency.
- Delaying meeting audio may worsen response latency, echo-gate alignment, cancellation tail, and exit drain.
- Remote accepted samples, backpressure, queue purge, reconnect, idempotency, delete reliability, orphan billing, and vendor outage behavior are unknown.
- Voice audio and likeness data cross another processor; retention, region, subprocessors, training/reuse, deletion, likeness rights, and effective total cost remain unresolved.
- Adapter-level replaceability does not make proprietary avatar assets, LiveKit/session behavior, credits, and availability portable.

### 3. C + bounded E — 49.5

Why it remains eligible:

- [Recall Output Media](https://docs.recall.ai/docs/stream-media) explicitly covers Google Meet and Zoom, exposes DevTools/CPU metrics, and permits a default-versus-`web_4_core` discriminator.
- E keeps the renderer local and makes C a cleaner carrier comparison than C+LITE.

Why it is not selected:

- It changes the meeting provider and returns to the historical webpage-output failure class.
- Default versus `web_4_core` adds quality/cost variation; the required tier is unknown.
- Recall lifecycle, credentials, billing, and output-media constraints add risk without answering the first Attendee question.
- Historical recordings, symptoms, browser rates, compute variant, CPU trace, and abandonment reason remain missing.

### 4. C + LiveAvatar LITE — 40.5

This combines the most external state before either layer is proven: Recall carrier plus LiveAvatar renderer, two vendor lifecycles and billing meters, browser capture, remote render queue, and split A/V clocks. It is useful only after C+E isolates the carrier and A+LITE isolates the renderer. Running it in the first comparison would repeat the historical error of changing too many failure domains together.

## Explicit vote

### Adopt now

**No.** Keep the current Attendee + static image + Fish Audio path as the only production-qualified architecture.

No candidate has measured baseline-relative Fish quality, observer A/V skew, cancellation tail, reconnect safety, static isolation, effective cost, or real-data privacy fitness. A weighted score cannot substitute for those facts.

### Maximum-two comparison PoC

**Yes, conditional approval for exactly two complete candidates:**

1. **A + bounded E**
2. **A + LiveAvatar LITE**

Do not include C, Tavus, Simli, B, or FULL modes in the same first PoC. Each additional candidate adds interpretation and operational cost before the common A carrier is known to work.

## Shared prerequisites before either candidate

1. **Product discriminator:** state whether a deliberately non-photorealistic bounded E could ever ship. If no, E remains a calibration control, not a product candidate.
2. **Static baseline:** 30-minute scripted current Attendee/static/Fish run covering greeting, multiple turns, interruption, long response, reconnect, exit, and leave; retain meeting-observer recording and timing.
3. **Frozen source:** one current 24 kHz Fish PCM fixture plus deterministic tone/transient and visual marker sequence.
4. **Avatar-free A carrier probe:** bounded page playout, actual AudioContext state/rate, queue/sample accounting, one-audio proof, cancel, reconnect, CPU, and observer recording. Current WebSocket output must be disabled by construction for the live bot.
5. **Static isolation contract:** with every live credential absent and endpoint blackholed, static payload/image behavior is byte-identical, no live module initializes, and scripted behavior remains baseline-equivalent.
6. **Failure ownership:** immutable output owner per generation; stale media rejected; no automatic in-session static replacement.
7. **PoC security:** synthetic/consented asset, scripted non-confidential PCM, disposable project, server-side durable key, short-lived audience/session-bound browser capability if needed, local duration/concurrency/retry/spend caps, and manual revocation path.

If the carrier probe fails a baseline-derived audio, cancel, duplicate, or observability gate, stop. Do not build E or LITE on A.

## Candidate-specific prerequisites

### A + bounded E

- Keep E inside the deliberately bounded visual scope.
- Establish Mac mini/page CPU and memory budget before declaring it “lightweight.”
- Measure source-indexed local frame timing and meeting-observer A/V timing.
- Prove local render/cancel/reconnect does not starve or replay page audio.
- Retain E as control even if it fails the product visual floor.

### A + LiveAvatar LITE

- Pass an off-meeting sandbox test with PCM/control only: no text, STT, LLM, vendor TTS, turn data, memory, tools, stable user ID, or audible frontend track.
- Gate all media on connected state; count/reject pre-connected sends.
- Stop the local send loop and send `agent.interrupt` on the same cancel epoch.
- Measure interrupt-to-last-frame, accepted/unknown samples, and reconnect behavior.
- Explicitly delete and reconcile session/usage; test lost-delete-response and vendor 5xx.
- Compare immediate versus one bounded delayed meeting-audio condition; report added response latency separately from improved A/V skew.
- Before real-user data, complete DPA/subprocessor/region/retention/deletion/training/likeness-rights review and effective total-cost model.

## Exit criteria and conditional C trigger

A candidate passes the comparison only if it:

- preserves one source Fish lineage and exactly one audible observer waveform;
- meets baseline-derived blind audio, latency, cancel, reconnect, and stability thresholds;
- reports signed/absolute observer-side A/V skew and drift;
- leaves static independent of live failure;
- terminates locally within bounded time even if remote cleanup is unconfirmed;
- exposes no semantic Agent Core data or durable browser secret;
- fits the declared visual requirement and measured resource budget.

Run **C+E only as a new decision** if A fails for a repeatable Attendee-specific carrier limitation, lacks necessary Google Meet/Zoom support, or lacks enough telemetry to distinguish failure. Run **C+LITE only after both C+E and A+LITE independently pass** and a real product decision requires their composition.

## Minority concern that must remain in the council decision

The likely majority will approve A+E and A+LiveAvatar LITE. My minority concern is that even this “minimal two-candidate PoC” may be prematurely feature-shaped.

The avatar-free A carrier probe and off-meeting LITE renderer probe can falsify the two largest assumptions without building either composite. If either fails, a composed PoC wastes work and risks encoding an abstraction around a dead carrier or renderer. The chair should make these probes explicit prerequisites, not implementation steps hidden inside the candidates.

I also object to reading the fixed 10-point `費用・privacy・運用` weight as permission to compensate for unacceptable privacy or cleanup with better audio or visuals. Missing consent/rights, durable client credentials, inseparable second audio, unbounded billing, vendor brain ownership, or static dependency are hard failures regardless of the weighted total.

Finally, if stakeholders cannot say whether bounded non-photorealistic E could ever ship, A+E should remain a calibration artifact capped accordingly. Calling it the “leading architecture” would overstate what it decides.

## Final ranked vote

1. **A+bounded E — approve as comparison control after prerequisites**
2. **A+LiveAvatar LITE — approve as managed comparison after prerequisites**
3. **C+bounded E — conditional diagnostic, not approved in first comparison**
4. **C+LiveAvatar LITE — defer until both component paths pass separately**
5. **B — disqualified under current MP4-only contract**
6. **FULL managed modes — disqualified for Agent Core violation**

Production remains static. The council should authorize no more than the two ranked comparison candidates and should stop at the first failed hard gate rather than “finishing the PoC” for completeness.
