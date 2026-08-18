# Round 2 — Skeptic / Security / Operations Cross-Review

Status: adversarial cross-review after reading all five Round 1 submissions
Date: 2026-07-23
Role: Councilor 5, skeptic / security / operations

## Revised position

The council has converged on the right hard boundaries:

- B is rejected because Attendee `output_video` is MP4 playback, not live camera injection.
- FULL managed-agent modes are rejected.
- E is required as a control.
- A is the only currently documented Attendee live A/V carrier.
- LiveAvatar LITE is the best-documented managed renderer challenger.
- C must be rebuilt as an instrumented comparison, not revived from the old branch.

That convergence is useful, but it creates a new risk: repeated agreement can make unmeasured assumptions look proven. None of A, C, D-LITE, or E has yet demonstrated meeting-side audio quality, A/V skew, cancellation tail, reconnect safety, static-path isolation, real-user privacy acceptability, or bounded failure cost. E and D are renderers, not complete meeting transports; both currently depend on A or C. Scores that award a renderer high “static preservation,” “meeting fit,” or “lifecycle” points before the carrier is selected are inflating confidence by scoring the easy half of a composite system.

My Round 1 vote remains **baseline, then A+E control and A+LiveAvatar LITE challenger; retain C as a fresh comparator; reject B and all FULL modes**. I reduce confidence in E as an eventual production favorite, and increase confidence that LiveAvatar LITE deserves a PoC, because the other proposals correctly showed that its official starter resolves more of the raw-audio contract than my first posture credited.

## Cross-review of the other proposals

### Councilor 1 — Meeting Bot / WebRTC Architecture

**Strongest point.** The proposal most clearly identifies the composite architecture: E or D cannot reach a meeting by itself, and the viable experiment is a renderer carried by A, with C as the cross-provider benchmark. Its explicit state machine and refusal to auto-fail over across providers are operationally sound. “Stop and leave the one authoritative live bot” is safer than creating a static bot while the live participant may still be connected. Its requirement that LiveAvatar sends wait for `session.state_updated: connected`, cancellation stop both the local loop and the remote renderer, and teardown explicitly delete the session directly follows the [official LiveAvatar LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python).

**Strongest rebuttal.** The score gives D a 5/5 for preserving the current audio/static boundary even though D-LITE is not a meeting transport, requires A or C, and may require delaying meeting audio to match its 400–600 ms initial renderer buffer. That delay changes the effective speaking/cooldown window, interruption tail, and exit timing even if the PCM bytes are identical. D also receives a 3/5 lifecycle score before explicit deletion, disconnect, and orphan-billing behavior are measured. C receives a strong 4/5 lifecycle/observability score because Recall exposes DevTools and CPU metrics, but those do not prove cleanup, cancellation, credential containment, or cost controls. The scoring mixes documented introspection with operational readiness.

Security and privacy are compressed into one 15% criterion alongside cost and vendor risk. That makes it possible for strong technical documentation to obscure unacceptable likeness/voice retention or a missing DPA. These should be hard gates, not merely deductions.

### Councilor 2 — Realtime Audio / DSP

**Strongest point.** The immutable PCM envelope and sample accounting are the best falsification machinery in the round. Utterance ID, sequence, first-sample index, source timestamp, rolling hash, cumulative source/rendered sample counts, clipping counters, queue watermarks, and observer-side A/V markers can distinguish corruption from timing and drift. This directly repairs the old Recall experiment's absence of a bounded clocked queue and retained playout evidence. The proposal also correctly insists that cancellation be measured as both `cancel_requested → last audible sample` and `cancel_requested → last matching video frame`.

**Strongest rebuttal.** The weighted table gives B 70/100 even though its A/V clock score and contract-maturity score are zero and the option cannot satisfy the live requirement. A hard-rejected option should be shown as “N/A / rejected,” not a competitive number with an asterisk. D scores 78/100 and E 76.5/100 despite neither including a proven meeting carrier in that row. More importantly, security/privacy, credential exposure, vendor shutdown, retention, deletion, orphan billing, regional processing, and likeness rights are absent from the criteria. DSP readiness is not production readiness.

The proposal says byte hashes can prove both consumers received identical source PCM. That proves ingress lineage, not equivalent playout: LiveAvatar batches frames, browser Web Audio converts S16LE to float, a page may resample, and meeting WebRTC encodes again. Hash equality must not be presented as duplicate-audio prevention or end-to-end fidelity proof.

### Councilor 3 — Avatar / Vendor Integration

**Strongest point.** This is the strongest correction to my own initial vendor skepticism. It distinguishes present LiveAvatar from obsolete HeyGen Interactive Avatar evidence and grounds LITE in an official raw PCM contract: mono S16LE at 24 kHz, explicit `agent.speak`, `agent.speak_end`, `agent.interrupt`, video-only frontend, and identical upstream audio tee. That matches current Fish without a second synthesis or resampler. It also usefully separates Tavus Audio Echo from FULL CVI and identifies Simli's explicit 16 kHz contract and overload condition instead of treating all “renderer-only” products as interchangeable.

**Strongest rebuttal.** The vendor scoring is materially inflated. Local lightweight receives 91/100 with no actual implementation, no Mac mini CPU result, no measured visual floor, and no independent meeting-video path. LiveAvatar LITE receives 81/100 while retention, region, subprocessors, training use, deletion behavior under failure, concurrency, billing granularity, and end-to-end A/V delay remain unresolved. Simli receives 78/100 based partly on a clear byte contract even though shared-capacity overload is an explicit availability risk and 24→16 kHz conversion plus `syncAudio` ownership remain unproven. Contract clarity is being mistaken for service fitness.

The recommendation to defer C until A has a measured Attendee-specific failure is too narrow. [Recall Output Media](https://docs.recall.ai/docs/stream-media) explicitly supports Google Meet and Zoom, exposes DevTools/CPU metrics, and lets the PoC compare default versus `web_4_core`. Councilor 1 correctly identifies C as a cross-provider benchmark. A small C run can prevent an Attendee-specific browser/container artifact from being misdiagnosed as renderer failure even if A appears to pass.

### Councilor 4 — Agent Identity / Memory / Skills Boundary

**Strongest point.** The ownership table and deliberately weak renderer capability are the best defense against provider leakage. Separating meeting session UUID, gateway session identity, bot ID, vendor session ID, and ephemeral render session prevents a renderer from becoming a second agent platform. The narrow interface—media-only `open`, `pushPcm`, `flush`, `close`, and `health`—appropriately excludes prompts, transcripts, memory, tools, stable user IDs, gateway credentials, and semantic turn authority. This is consistent with the current single Fish callback boundary and current single-owner bot lifecycle.

**Strongest rebuttal.** The claim that “a renderer outage degrades to the unchanged static path” is underspecified and unsafe if read as in-session automatic fallback. Under current constraints, switching from an A live bot to the unchanged static path means ending one participant and creating another. Unless absence is verified, that can produce duplicate bots and audio. The safe guarantee is that **future/new sessions** remain static-capable immediately and that an active live session closes deterministically; in-session fallback requires a separately proven handoff protocol.

The proposal's unknown list also retains an obsolete question asking whether Attendee `output_video` supports sustained realtime injection. The official contract now answers it: [the endpoint accepts an HTTPS MP4 URL](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video), so B is rejected unless a new API is published. Its B score of 4.40/5 is counterfactual and likely to confuse readers despite the disqualification note. E at 4.68/5 similarly assumes meeting-path and local-resource success before measurement.

## Evidence that weakens my Round 1 position

My Round 1 review leaned too far toward E and too far away from D-LITE.

1. I scored D-LITE 2.35/5, but the [LiveAvatar overview](https://docs.liveavatar.com/) and [official LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) establish raw mono S16LE 24 kHz input, a video-only frontend, explicit interrupt, connected-state gating, and an identical TTS-frame tee. Current Meetmate Fish output is also 24 kHz S16LE mono. This eliminates the second-TTS, mandatory resampling, and returned-audio ambiguity that justified part of my caution. D-LITE should move up as a **PoC candidate**, though not yet as a production candidate.
2. I scored bounded E at 4.15/5. Every other proposal correctly notes that E still needs A or a future live video carrier. The [Attendee Voice Agents contract](https://docs.attendee.dev/guides/voiceagents) captures page audio and video; therefore E still inherits browser rate, capture, WebRTC, cancellation, and meeting-codec risks. No local renderer has been measured on the Mac mini or against an agreed visual floor. My score overstated end-to-end readiness.
3. I placed C last largely because of recurrence risk. [Recall Output Media](https://docs.recall.ai/docs/stream-media) now provides explicit two-platform support, container variants, CPU metrics, and DevTools. Those features do not prove quality, but they make C valuable earlier as a transport-control experiment. Councilor 1's “cross-provider benchmark” framing is stronger than treating C only as historical falsification.
4. I gave B a residual 2.70/5 despite hard rejection. This was poor score hygiene. A nonexistent live transport should be N/A, not numerically ranked.

My caution remains supported where official evidence exposes concrete operational hazards: LiveAvatar may silently drop events before connected, its reference batches roughly 400–600 ms initially and about 1 second thereafter, interruption requires local and remote actions, and explicit session deletion is needed to stop billing. Those are not hypothetical vendor anxieties; they are lifecycle requirements from the official integration.

## Why the past Recall branch remains materially different

The council agrees that neither “Recall failed before” nor “Recall is fixed now” is evidence-based.

Historical `origin/feat/recall-ai`:

- [`d2e8f77`](https://github.com/caty-ai/meetmate/commit/d2e8f77) asserted 16 kHz compatibility without retained runtime browser or meeting measurements.
- [`d3d86d7`](https://github.com/caty-ai/meetmate/commit/d3d86d7) created one `AudioBufferSourceNode` per network chunk, advanced a single `playCursor`, guessed a localhost subscription, and had no bounded jitter queue, media clock, underrun counter, or meeting playout timestamps.
- [`b5fbff1`](https://github.com/caty-ai/meetmate/commit/b5fbff1) used `ScriptProcessorNode(4096)` and manual averaging downsampling from an unconstrained capture context; no retained runtime sample-rate log remains.
- [`0cd1e52`](https://github.com/caty-ai/meetmate/commit/0cd1e52) moved capture to AudioWorklet but retained a 4096-sample flush and did not fix the output scheduler.
- [`02ece31`](https://github.com/caty-ai/meetmate/commit/02ece31) changed input again to Recall mixed raw audio while retaining browser output.
- [`b9549f6`](https://github.com/caty-ai/meetmate/commit/b9549f6) later added the required raw-audio artifact enablement, proving the prior configuration was incomplete.
- [`bbe1544`](https://github.com/caty-ai/meetmate/commit/bbe1544) mixed Fish model, prompt, and tag changes into the transport trial; [`de1d03e`](https://github.com/caty-ai/meetmate/commit/de1d03e) reverted the bundle without recording why.

A valid new C differs by freezing current 24 kHz Fish S2-Pro PCM, changing one input/output variable at a time, using a bounded clocked queue, observing actual browser rates, retaining sample/queue/playout metrics, comparing default and `web_4_core`, recording the meeting observer path, and isolating bot lifecycle. Recall currently documents output at 1280×720/15 fps and warns that CPU pressure can cause choppy media; the old payload did not name a compute variant. This makes CPU a discriminator, not the historical cause.

Still unknown are the historical heard symptoms, affected commit, meeting platform/session, actual browser rates, Recall instance variant, CPU graphs, network trace, bot/session IDs, recording, reason for branch abandonment, and reason for the S2-Pro bundle revert. No Round 2 proposal may fill those gaps with inference.

## Assumption challenge by risk domain

### Static isolation and rollback

“Byte-for-byte static payload unchanged” is necessary but insufficient. Static isolation also requires:

- no mandatory live-avatar environment variables or startup validation in static mode;
- no shared singleton, queue, timer, retry loop, SDK initialization, browser asset, or cleanup hook that can fail static startup;
- no config-schema default that changes current behavior;
- no shared bot ID or renderer session surviving between modes;
- no live dependency in health checks that can mark static unhealthy;
- regression tests for create, greeting, multiple turns, interruption, long response, exit, reconnect, and leave;
- a kill switch evaluated before live bot creation.

Rollback must be split into two claims:

1. **Control-plane rollback:** disable new live sessions without contacting the avatar vendor.
2. **Active-session containment:** stop new PCM, invalidate queues, attempt renderer/session cleanup, leave the one live bot, and surface an orphan incident if the vendor is unreachable.

Automatic in-session recreation as static is rejected until the system can prove the original bot is absent. Otherwise “fallback” is a duplicate-bot mechanism.

### Duplicate bots and duplicate audio

Exactly one Fish synthesis is not enough. The composite A+D path can still duplicate audio through:

- current Attendee WebSocket output accidentally remaining enabled;
- page AudioContext playout plus renderer-returned audio;
- a browser reconnect replaying buffered PCM;
- a replacement primary connection while a stale page continues playing;
- local audio delayed for sync while an immediate branch is also audible;
- vendor/session retry creating a second remote stream;
- fallback creating a second meeting bot before confirmed leave.

The proof must be observer-side: one participant identity, one audible waveform, generation/epoch rejection of stale frames, and zero duplicate/echo incidents through reconnect and cancel. Configuration inspection alone cannot prove this.

### Credentials and session authorization

“Keep keys server-side” is incomplete for A, because the renderer frontend runs on a public HTTPS page. The design must show:

- server-minted, single-use, short-lived, audience- and render-session-bound tokens;
- no durable secret in query strings, HTML/JS, browser storage, console, network error bodies, source maps, screenshots, or telemetry;
- origin validation and replay resistance on page and media WebSockets;
- expiration/revocation on leave, cancel, and bot replacement;
- separate sandbox/production projects, key rotation, least privilege, and incident revocation;
- vendor callback authentication and idempotency without accepting semantic/tool events.

No proposal has yet established that each vendor supports sufficiently scoped ephemeral authorization.

### Privacy and biometric/likeness data

Renderer-only prevents prompt/memory leakage but does not solve privacy. Managed paths may process Fish voice audio, avatar source imagery/video, derived face representations, rendered frames, IP/device metadata, meeting/bot IDs, and timing metadata. Before real-user or customer data:

- use only synthetic or explicitly consented likeness and scripted non-confidential PCM in the PoC;
- inventory every processor and subprocessor, region, retention period, deletion SLA, recording default, training/reuse term, and breach/SLA obligation;
- determine the legal/contractual treatment of face and voice data in intended jurisdictions and customer agreements;
- prove deletion of source assets, derived artifacts, logs, and orphan sessions;
- ensure no stable user, gateway, transcript, prompt, memory, or tool identifier reaches the renderer.

SOC 2, HIPAA, GDPR, or trust-center badges do not answer purpose limitation, training use, likeness rights, or per-session deletion. These are hard procurement gates.

### Cost, quota, outage, and vendor shutdown

“Per minute” is not a cost model. Composite cost may include Attendee/Recall minutes, higher container tiers, avatar credits, custom replica fees, concurrency plans, minimum billable increments, bandwidth, reconnects, idle/inactivity windows, orphaned sessions, and support/SLA tiers.

Every managed PoC must deliberately test authentication failure, quota exhaustion, rate limiting, renderer overload, partial connect, lost delete response, network partition, and vendor 5xx. Required controls:

- local maximum duration, concurrency, retry budget, and daily spend cap;
- no retry on invalid media, authentication, quota, or billing errors;
- exponential bounded reconnect only for explicitly retryable failures;
- idempotent create/delete and reconciliation of local sessions to vendor billing/usage;
- alerting on orphaned bots/renderers and spend anomalies;
- an export/deletion and replacement plan for avatar assets if the vendor changes price, API, ownership, or shuts down.

The system must keep static Meetmate available if every avatar account and endpoint is disabled. No score should exceed “plausible” on operations until these faults are exercised.

## Score audit and revised screening

Round 1 score inflation came from four patterns:

1. assigning high points to an architectural ideal that does not exist (B);
2. scoring renderer and carrier separately while describing the result as end-to-end readiness (D and E);
3. awarding contract clarity as if it proved latency, availability, privacy, or cancellation;
4. allowing weighted totals to compensate for hard failures.

The only honest current score is for **composite PoC configurations**. Scale: 0–5. Unknowns score 1–2, not a neutral 3. Hard gates override totals.

| Composite | Architecture/static isolation 20% | Media/cancel evidence 20% | Security/privacy evidence 20% | Operations/cost evidence 20% | Meeting fit/observability 20% | Total /5 | Disposition |
|---|---:|---:|---:|---:|---:|---:|---|
| Static baseline | 5 | 5 | 4 | 4 | 5 | **4.6** | Required control |
| A + bounded E | 4 | 2 | 5 | 4 | 3 | **3.6** | First local control PoC |
| A + LiveAvatar LITE | 4 | 3 | 1 | 1 | 3 | **2.4** | Managed challenger PoC only |
| A + Tavus Echo | 4 | 2 | 1 | 1 | 2 | **2.0** | Defer pending contract answers |
| A + Simli | 4 | 2 | 2 | 1 | 2 | **2.2** | Defer; resampling/overload questions |
| C + bounded E | 2 | 2 | 3 | 2 | 4 | **2.6** | Cross-provider diagnostic |
| C + managed renderer | 2 | 2 | 1 | 1 | 4 | **2.0** | Too many vendors for first PoC |
| B live injection | 0 | 0 | 3 | 3 | 0 | **N/A** | Rejected: no official live API |
| FULL managed pipeline | 0 | 2 | 1 | 1 | 2 | **N/A** | Rejected: boundary violation |

These numbers are deliberately conservative. A+LiveAvatar's technical protocol evidence is stronger than its total suggests; its low total reflects missing privacy/procurement and failure-cost evidence, not dismissal of the candidate. E's high security score assumes a truly local bounded renderer with reviewed model/assets; a cloud-hosted “local-style” renderer does not inherit it.

## Preserved unknowns

- Historical Recall/HeyGen symptoms, recordings, bot/session IDs, API versions, compute variant, browser rates, CPU/network traces, and abandonment/revert reasons.
- Static baseline distributions and acceptance thresholds for latency, jitter, audio quality, cancellation tail, A/V skew, CPU/memory, reconnect, echo, and leave.
- Actual Attendee/Recall AudioContext rates, autoplay states, internal resampling, capture buffering, meeting codec paths, and Google Meet/Zoom parity for A.
- Whether Attendee Voice Agents can retain current direct mixed-audio input without enabling a second output path.
- LiveAvatar render-delay distribution, timestamp/ack model, queue/backpressure bound, interrupt purge tail, reconnect/idempotency behavior, inactivity timeout, delete reliability, regional processing, retention/training terms, concurrency, and current effective cost.
- Tavus Echo encoding/channel/cadence, returned-audio authority, cancellation guarantee, meeting handoff, timestamps, privacy terms, and effective cost.
- Simli video-only/`syncAudio` behavior, safe chunk cadence, measured 24→16 kHz effect, shared-capacity overload, dedicated capacity, privacy terms, and cost.
- Local renderer design, asset/model license, visual-quality floor, Mac mini CPU/GPU/memory load, and its browser/carrier A/V behavior.
- Vendor ephemeral-token support, session revocation, callback authentication, DPA/subprocessors/regions, source/derived asset deletion, training/reuse, incident SLA, quotas, minimum billing, overage, and shutdown/export terms.
- A safe active-session containment procedure when renderer deletion or bot leave cannot be confirmed.

## Vote-change conditions

I will change my vote toward **A+LiveAvatar LITE for a production-shaped pilot** only if:

- a synthetic-data sandbox shows one bot/one audible path through connect, interrupt, reconnect, long response, exit, and renderer outage;
- p50/p95 response latency and observer-side A/V skew pass thresholds set after the static baseline;
- `connected` gating prevents silent loss, cancellation stops local send and remote rendering within the approved tail, and explicit deletion is reconciled against billing;
- scoped ephemeral authorization is demonstrated and no durable secret reaches the public page;
- DPA, regions, subprocessors, retention/deletion, training/reuse, likeness rights, concurrency, and effective cost are accepted;
- disabling live mode leaves static startup and new static sessions independent of every avatar dependency.

I will change my vote toward **A+E as the production default** only if its agreed visual floor is met and Mac mini/browser load does not materially worsen audio, latency, barge-in, or reliability.

I will move **C earlier or prefer it over A** if A lacks sufficient browser/media telemetry, fails Google Meet/Zoom parity, or measured A-specific container behavior causes audio or A/V defects while a fresh default-versus-`web_4_core` C comparison passes.

I will reconsider **B** only after Attendee publishes an official continuous participant-camera output contract with timestamps/synchronization, backpressure, cancellation, coexistence with current realtime audio, and target-platform support. Vendor assurances about repeatedly replacing MP4s are insufficient.

I will reject any current favorite immediately if it exposes durable credentials, requires vendor brain/TTS, cannot prove one bot and one audible path, cannot flush stale media, cannot stop billable sessions, makes static depend on the live vendor, or lacks acceptable voice/likeness governance.
