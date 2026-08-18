# Round 1 — Skeptic / Security / Operations Critic

Status: independent preliminary review
Date: 2026-07-23
Evidence boundary: `00-evidence-pack.md`, `01-failure-dossier.md`, repository history, and the official URLs cited below. No other council proposal was read.

## Position

The burden of proof is not “can an avatar appear in a meeting?” It is “can a live renderer be added without weakening the already-working static participant, duplicating Fish audio, leaking credentials or biometric/voice data, or creating an outage and cost domain that operators cannot immediately disable?”

On present evidence, **no managed live-avatar option is ready for adoption**. Option B is rejected under Attendee's current official contract. A measured, time-boxed PoC is justified for Options A, E, and D's renderer-only modes. Option C is useful only as a deliberately instrumented falsification of the historical Recall path, not as the default or as a resurrection of `origin/feat/recall-ai`.

The word **minimal** is currently unsafe:

- Option B looked minimal in topology, but the official `output_video` contract accepts a public HTTPS MP4 URL with loop/mute flags. It is queued prerecorded media, not live camera injection. Repeated MP4 replacement would be a speculative discontinuous hack, not a minimal live path.
- Option A may be minimal in vendor count but replaces the known audio egress with browser capture. It adds autoplay, AudioContext, page lifecycle, browser capture, WebRTC, and double-routing failure modes.
- Option D may be minimal in local code while maximizing external state: another credential, another processor of face and voice data, another session lifecycle, another billing meter, and another outage/shutdown dependency.
- Option E minimizes vendor and data-processing exposure, but a custom renderer is not minimal engineering if photorealism, realtime video encoding, A/V synchronization, GPU support, and cross-platform maintenance are smuggled into the requirement.

“Minimal” must therefore be scored across code delta, changed media boundaries, external processors, credentials, session owners, billing meters, rollback steps, and observability—not by lines of glue code.

## Evidence and recurrence risk

The abandoned Recall branch is not proof that Recall audio is inherently defective. It is proof that the experiment design made diagnosis impossible.

- The migration spec at [`d2e8f77`](https://github.com/caty-ai/meetmate/commit/d2e8f77) assumed 16 kHz compatibility before retaining runtime measurements.
- The provider bridge at [`d3d86d7`](https://github.com/caty-ai/meetmate/commit/d3d86d7) scheduled one browser source per network chunk without bounded jitter buffering, underrun counters, queue metrics, or meeting-side playout timestamps.
- Input moved from `getUserMedia` and manual downsampling at [`b5fbff1`](https://github.com/caty-ai/meetmate/commit/b5fbff1), to AudioWorklet at [`0cd1e52`](https://github.com/caty-ai/meetmate/commit/0cd1e52), to Recall raw mixed input at [`02ece31`](https://github.com/caty-ai/meetmate/commit/02ece31). Input and output failure domains changed during the same experiment.
- [`b9549f6`](https://github.com/caty-ai/meetmate/commit/b9549f6) later enabled the required mixed-audio artifact, demonstrating that the earlier configuration was incomplete.
- Fish S2-Pro and prompt/tag changes were bundled at [`bbe1544`](https://github.com/caty-ai/meetmate/commit/bbe1544) and mechanically reverted at [`de1d03e`](https://github.com/caty-ai/meetmate/commit/de1d03e). There is no retained evidence assigning the failure to Fish, Recall, the browser, resampling, or the bundled prompt changes.

Recurrence is likely if a new PoC again changes transport input, transport output, renderer, Fish settings, prompts, and bot lifecycle together; omits sequence/media-clock/queue telemetry; or evaluates candidates with different source audio. The control must be one captured current Fish 24 kHz PCM fixture fanned into each renderer while Soniox, Agent Core, prompts, and Fish model remain fixed.

### Historical Recall is not current Recall

The following differences prohibit both “Recall already failed” and “Recall is fixed now”:

1. The historical branch was built around an older 16 kHz-era output path; current main uses Fish S2-Pro at 24 kHz.
2. The historical payload did not select a Recall compute variant. Current [Recall Output Media documentation](https://docs.recall.ai/docs/stream-media) explicitly warns that CPU pressure can produce choppy output and recommends testing `web_4_core`.
3. The historical implementation evolved from browser-captured input to Recall `audio_mixed_raw`, but retained browser output. There is no retained result tied to the final topology.
4. Current Recall Output Media documentation says it cannot be combined with automatic/output audio or video endpoints and that webpage output always includes video. These are material present-day constraints, not proven properties of the historical service.
5. No historical recording, actual AudioContext rate, CPU graph, instance variant, packet trace, symptom/commit mapping, or reason for abandonment survives in the repository.

Option C must consequently start from a new minimal harness and explicitly compare default versus `web_4_core`; it must not cherry-pick the old branch.

## Option comparison under hostile assumptions

| Option | What looks minimal | Hidden failure domains | Security/privacy exposure | Operational criticism |
|---|---|---|---|---|
| A — Attendee voice-agent webpage | One meeting vendor and an official page-capture path | Browser autoplay and lifecycle, actual AudioContext rate, resampling, page audio capture, WebRTC encoding, A/V clock, and accidental simultaneous WebSocket audio | Public page delivery and any renderer called by it; credentials are at risk if embedded in HTML, query strings, client JS, or browser logs | [Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents) requires a public HTTPS page and immediate mic access. Coexistence with current realtime audio is unproven. A reconnect can create two audio owners unless ownership is explicit. |
| B — Attendee audio unchanged + `output_video` | Preserves known Fish-to-Attendee PCM path | Officially accepts only a public HTTPS MP4 URL plus loop/mute; it is not continuous frame or WebRTC injection | Low incremental disclosure for prerecorded animation, but it cannot carry the required live renderer output | **Rejected for live avatar under the current contract.** [Attendee `output_video`](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots/object_id/output_video) is useful only for prerecorded/looping experiments. Reconsider only after Attendee publishes a continuous live-camera contract. |
| C — Recall Output Media | Official webpage capture and closest historical analogue | A second meeting transport, browser playout, compute-variant sensitivity, output-media restrictions, bot lifecycle, reconnect, and all historical clock/queue risks | Recall plus renderer receive meeting/session data; additional credential, retention, subprocessor, and regional-processing review | Highest recurrence risk. [Recall Output Media](https://docs.recall.ai/docs/stream-media) exposes CPU metrics and variants, which helps diagnosis, but also turns compute sizing into cost and quality risk. |
| D — managed avatar | Vendor supplies synchronized animation/video | Vendor session lifecycle, cancellation/drain, WebRTC handoff, quota, version drift, shutdown, and the measured 400–600 ms initial/1 s subsequent buffering of LiveAvatar's reference path | Highest: face/likeness asset, Fish voice audio, session metadata, and potentially meeting context cross another processor | FULL modes violate the Agent Core boundary. [LiveAvatar LITE](https://docs.liveavatar.com/) now has a credible renderer-only 24 kHz PCM contract, and [its official starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) shows video-only frontend delivery. That reduces interface uncertainty but makes A/V skew, pre-connect silent drops, explicit interrupt, and explicit bill-stopping deletion concrete operational gates. Tavus Echo remains less proven here. |
| E — vendorless lightweight renderer | No new avatar API, credentials, or external processor | Local CPU/GPU contention, media encoding, lip-sync quality, A/V clock, packaging, model/license provenance, and maintenance | Best control over face and voice data, subject to local model/license and artifact storage review | Strong privacy/stability control if limited to 2D/canvas/visemes. Reject a “lightweight” PoC that quietly becomes a photorealistic ML/video infrastructure project. |

### Narrow comparison: B versus A

B would have been the safest topology because the existing documented [Attendee realtime audio](https://docs.attendee.dev/guides/realtimeaudio) path remained the sole audio owner. The official MP4-only `output_video` contract falsifies that topology for live video. A is now the viable Attendee path, but it deliberately moves audio through a less observable browser/WebRTC chain. A must therefore be a separate bot type with existing WebSocket output disabled by construction; B should not receive engineering time unless the vendor publishes a new continuous output API.

### Narrow comparison: E versus D

E wins on data minimization, vendor shutdown resilience, credential count, and cost predictability. D may win on visual quality and implementation speed, but only by outsourcing operational state. LiveAvatar LITE's official starter establishes raw mono 24 kHz S16LE input, matching current Fish output without resampling or second TTS, so its renderer-only claim is materially stronger than a marketing assertion. That does not remove its roughly 400–600 ms initial buffer, 1 s later chunks, pre-connected silent drops, interrupt dual-control, explicit session deletion, or likeness/voice governance risks. If the required product outcome is “visible speaking state and credible lip movement,” E is likely the actually minimal control. If photorealism is a hard requirement, D becomes relevant, but that requirement must be explicit enough to justify those costs and vendor lock-in.

### Narrow comparison: C versus A

Both capture a webpage into a meeting, so both inherit browser timing and audio-capture uncertainty. C additionally changes the meeting-bot provider and reopens a historically confounded path. Its current compute metrics make it a useful diagnostic comparator, not the low-risk default. A should precede C unless Attendee cannot provide required diagnostics or renderer coexistence.

## Security and privacy gates

The live avatar is not “just video.” It processes at least a face/likeness asset and Fish-generated voice audio; depending on topology, it may also receive meeting audio, participant identifiers, meeting URLs, transcripts, or prompts. Some jurisdictions and customer contracts may treat face templates or voiceprints as biometric data even when the product does not use them for identification. Legal classification, consent, notice, retention, deletion, regional processing, subprocessors, model-training use, and data-subject handling are unresolved and require owner review before real-user traffic.

Minimum controls:

- Keep Attendee, Recall, LiveAvatar/Tavus, and renderer credentials server-side. Never place durable secrets in the public voice-agent page, HTML, JavaScript bundle, query string, WebSocket URL, browser local storage, screenshots, or client-visible error messages.
- Mint one-time, audience-restricted, short-lived renderer/session tokens server-side if the browser must authenticate. Bind them to bot/session ID and expire them on leave.
- Use separate sandbox and production keys, least-privileged vendor projects, spending caps where supported, and a key-rotation/revocation runbook.
- Treat public meeting URLs, bot IDs, session tokens, likeness assets, and PCM as sensitive. Redact them from structured logs while retaining non-sensitive sequence, rate, queue, and timing telemetry.
- Establish vendor retention/deletion behavior and DPA/subprocessor/region terms before uploading a production likeness or voice stream. The PoC should use a synthetic or explicitly consented test likeness and scripted non-confidential audio.
- Confirm that vendor contracts prohibit training or reuse of likeness and voice data without explicit opt-in. If this cannot be established, reject D and any A/C renderer that exports those assets.
- Threat-model replay and session hijack: a leaked live token must not let an attacker animate the likeness, inject audio/video, join a meeting, or continue billing after Meetmate exits.
- Do not expose internal Agent Core prompts, memory, tools, gateway credentials, or transcripts to an avatar vendor. Renderer-only is an enforced data boundary, not merely a product description.

## Reliability, duplicate-media, and rollback requirements

### Single ownership

Exactly one bot ID, one meeting-audio ingress, one Fish synthesis, and one meeting-audio egress must exist per session. Renderer fan-out starts after Fish PCM generation; it must never trigger another TTS request. If a managed renderer returns synchronized audio, that returned audio must either be the sole explicitly selected egress or be discarded. Sending both direct Fish PCM and renderer-returned audio is an immediate rejection because it can produce echo, phasing, doubled volume, and non-deterministic barge-in.

Reconnect behavior is especially dangerous. Attendee documents up to 30 WebSocket retries at two-second intervals. A recovering page/renderer connection must not coexist with a replacement connection that can still play queued audio. Every media message needs session ID, monotonic sequence, and generation/epoch; stale generations must be rejected. Cancellation must flush scheduled and vendor-queued media, not only abort future Fish chunks.

LiveAvatar LITE makes this requirement concrete: events sent before the session reports `connected` can be silently dropped; interruption requires both stopping the local send loop and sending `agent.interrupt`; ending local audio is insufficient because the remote session must be explicitly deleted to stop billing. The PoC must assert all three transitions and reconcile them in telemetry.

### Release isolation

- Static mode remains the default and its existing payload remains byte-for-byte unchanged.
- Live mode uses a separate construction path selected before bot creation, not runtime mutation of an existing static bot.
- Enable only by allowlisted test meeting/account plus a server-side kill switch. Do not rely on a browser flag or vendor dashboard alone.
- No automatic fallback that launches a second bot while the first may still be present. Fallback order is: stop media; revoke/close renderer; request original bot leave; verify absence or timeout with an explicit incident state; then create one static bot.
- Canary one synthetic meeting at a time. Production rollout requires concurrency and quota tests, not extrapolation from one bot.
- Pin API versions or record resolved versions where vendors permit. Vendor deprecation notices and SDK/API change monitoring need an owner.

### Outage, cost, and shutdown

All managed options need connect, render, and drain deadlines; bounded queues; circuit breakers; per-session maximum duration; concurrency limits; and idempotent cleanup. The cost model must include meeting-bot minutes, renderer/avatar credits, higher Recall compute variants, bandwidth, idle/reconnect minutes, retries, and orphaned sessions. “One credit/minute” is not a budget until current pricing, minimum commitments, overages, rounding, and concurrent session behavior are confirmed.

Required cost protections:

- maximum billed minutes and maximum concurrent live sessions enforced locally;
- vendor usage reconciliation against locally recorded session start/stop;
- alerts for orphaned vendor sessions, retry storms, and daily spend anomaly;
- no unbounded retry after authentication, quota, invalid media, or billing errors;
- a vendor shutdown plan that leaves static Meetmate fully operable with no schema or code rollback.

The credible rollback unit is the feature flag plus live-session cleanup, not a code deploy. If turning off live mode still requires the avatar vendor to respond, rollback is not operationally valid.

## Adoption conditions

A candidate may advance beyond sandbox only if all of the following are demonstrated against the same captured Fish PCM and the measured current static baseline:

1. Static mode payload and behavior remain unchanged and its regression test passes.
2. Exactly one bot and one audible stream are observed through create, interruption, cancellation, reconnect, long response, and exit.
3. Actual input/output sample rates, resampling boundaries, chunk sequence/arrival/playout timestamps, bounded queue depth, underruns, clipping, disconnects, CPU/memory, and A/V skew are recorded.
4. Cancellation has a measured upper bound and flushes browser/vendor queues; reconnect cannot replay stale audio.
5. A renderer outage and quota error leave the meeting through a deterministic cleanup path, after which a new static session works.
6. API keys are server-side or exchanged for scoped short-lived tokens; leaked client artifacts do not authorize new sessions.
7. Data-flow inventory, consent basis, DPA/subprocessors/retention/deletion/training terms, and likeness/voice asset ownership are approved for the intended users and regions.
8. Per-minute and worst-case orphan/retry costs are measured under the intended compute variant and enforced by local caps.
9. Blind A/B audio quality is not materially worse than the static baseline, with thresholds set only after baseline measurement.
10. The vendor can be removed without changing Agent Core, Soniox, Fish Audio, gateway selection, memory, skills, tools, or the static meeting path.

## Immediate rejection conditions

Reject a candidate without further tuning if:

- it requires the vendor's ASR, LLM, TTS, personality, memory, turn logic, or tools;
- it cannot accept the existing Fish output in a documented or experimentally stable renderer-only contract;
- static mode shares altered payload construction, mandatory config, or vendor availability;
- two bots or two audio egresses can exist during normal operation, reconnect, or fallback;
- cancellation cannot flush already queued media, or stale audio can play after a new turn;
- credentials must be durable and client-visible;
- the vendor cannot state retention/deletion, training use, subprocessors, or likeness/voice rights acceptably;
- no hard session-duration, concurrency, retry, or spend cap can be enforced;
- failure cleanup depends indefinitely on the failed vendor;
- required observability is unavailable, making a defect indistinguishable from the historical Recall experiment;
- a production exit or rollback can strand an audible/visible bot in the meeting;
- Option E requires photorealism or a new unbounded ML/video platform while still being presented as “lightweight.”

## Unknowns that block a decision

- The actual symptoms, affected commits, bot IDs, recordings, instance variant, browser rates, CPU traces, and abandonment reason from the historical Recall/HeyGen trials.
- Whether Attendee `voice_agent_settings` and `websocket_settings.audio` can coexist; preferably they should not, but the contract affects migration and safety.
- Whether Attendee plans an official continuous live-camera output contract distinct from its current MP4-only `output_video`. Until then B is rejected, not unknown.
- Actual Attendee and Recall browser AudioContext rates/states and all resampling/codec boundaries.
- LiveAvatar LITE's remaining queue/drain limits, exact render/A/V timing distribution, reconnect/idempotency behavior, regional processing, inactivity timeout, and current pricing. Its input is now established as raw mono 24 kHz S16LE and its frontend path as video-only. Tavus Echo's accepted format/rate/cadence and returned A/V ownership remain less established.
- Whether managed avatar vendors retain PCM, face assets, embeddings, rendered video, logs, or derived voice/face data, and whether any are used for training.
- Quota, retry, orphan-session billing, rate-limit, incident SLA, API-version/deprecation, export, and account-termination behavior for every managed vendor.
- The actual product floor for visual fidelity. Without it, E cannot be fairly bounded and D cannot be justified.
- Mac mini CPU/GPU headroom for E and the interaction between local render/encoding load and STT, Agent Core, and Fish streaming.

## Preliminary weighted score

These are **evidence/readiness scores**, not performance results. Scale: 1 = materially adverse or unproven, 3 = plausible with major gates, 5 = strongest current evidence/control. “Audio continuity” scores architectural isolation plus contract evidence, not measured quality.

| Criterion | Weight | A | B | C | D renderer-only | E bounded 2D |
|---|---:|---:|---:|---:|---:|---:|
| Preserve static and current audio path | 25% | 2 | 1 | 1 | 3 | 4 |
| Security/privacy/data minimization | 20% | 3 | 4 | 2 | 1 | 5 |
| Operational rollback and outage isolation | 20% | 3 | 4 | 2 | 2 | 5 |
| Contract/readiness evidence | 15% | 3 | 1 | 3 | 4 | 3 |
| Cost predictability/vendor resilience | 10% | 3 | 3 | 2 | 1 | 5 |
| Scope discipline / low overengineering risk | 10% | 3 | 4 | 2 | 3 | 2 |
| **Weighted score / 5** | **100%** | **2.75** | **2.70** | **1.90** | **2.35** | **4.15** |

The ranking is intentionally conditional and does not overrule hard rejection gates. B's residual score reflects privacy and rollback advantages for prerecorded media, but it is rejected for the live requirement. E leads only if it stays a bounded 2D/viseme control. A is the most credible Attendee PoC. D's LiveAvatar LITE sub-option now has a strong PCM/renderer contract, but it remains blocked on meeting handoff, A/V skew, lifecycle/billing, and governance. C has the highest historical recurrence risk and should run only when its diagnostic value justifies the additional provider and compute cost.

## Preliminary recommendation

Run a short **contract-elimination sequence**, not a feature implementation:

1. Establish and record the static baseline.
2. Record B as rejected under the current official MP4-only contract; do not prototype repeated MP4 replacement.
3. Build the smallest bounded E control needed to establish whether the product actually requires a managed photorealistic renderer.
4. Probe A with a single audio owner and full browser/media telemetry.
5. Within A/D, test LiveAvatar LITE's established 24 kHz tee only after privacy and token answers are written. Measure the initial buffer and p95 skew; gate sends on `connected`; test both local send cancellation and `agent.interrupt`; verify explicit session deletion stops billing.
6. Run C last as a fresh, instrumented historical falsification using both default and `web_4_core`, never as a branch revival.

No option should be called “minimal,” “safe,” or “fixed” until it survives duplicate-audio, cancellation, reconnect, vendor outage, orphan billing, credential exposure, and rollback tests.
