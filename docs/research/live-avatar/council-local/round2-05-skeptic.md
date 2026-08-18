# Local Renderer Council Round 2 — Skeptic / Security / Operations Cross-Review

Status: cross-review; no implementation authorization  
Date: 2026-07-23  
Role: Councilor 5, skeptic / security / operations  
Reviewed: all five `council-local/round1-*.md` submissions

## Revised position

The other proposals weaken my categorical objection to a single H→L0→L1 issue. A single issue can be responsible **as a gated experiment ledger** if failure at H or L0 is an accepted successful outcome, L1 code/assets are not started before the gate, and each gate is enforced by a separate reviewed commit/PR or explicit owner sign-off.

They do not yet persuade me that the issue is **implementation-ready today**. Three prerequisites remain architectural, not clerical:

1. hosted Hybrid H coexistence and true page silence are unproven;
2. the existing handler boundary does not yet expose a proven authoritative output/cancel epoch for every abort path; and
3. Caty image rights are not documented sufficiently for public-page distribution.

My Round 1 “NO” therefore changes to:

- **Conditional yes to drafting one gated H→L0→L1 experiment issue now.**
- **No to starting L1 implementation until H/L0, cancel-epoch, baseline, public-page, and image-rights gates pass.**
- **No to including any L2 code, assets, selector, fallback, or WebGL hardening in that issue.**

Full-page A remains a separately authorized architecture if H fails. It is not a branch, fallback, or hidden second mode in the H issue.

## Cross-review

### Councilor 1 — Meeting Bot / WebRTC

**Strongest point.** The lifecycle is concrete and correctly keeps the existing realtime WebSocket as the sole meeting input/output owner in H. The proposal explicitly says H failure closes the issue rather than falling into A, and page/render failure may degrade only the visual side after manager independence is proven. Its one-bot/one-generation rules, no historical replay on page reconnect, current fixed exit grace, and observer-side A/V gate correctly distinguish visual containment from media-owner switching.

**Strongest objection.** The “one issue is ready” conclusion depends on work that the same proposal calls prerequisites: hosted coexistence, baseline thresholds, and Caty asset rights. It also permits an optional `src/pipeline.js` edit if cancel cannot otherwise be surfaced. That is not a thin implementation detail; it is the unresolved authority boundary identified by Councilor 4. The H/L1 issue must depend on a separately reviewed handler-level cancel/output-epoch contract and must not discover the need by editing Agent Core mid-issue.

The proposed dedicated WebSocket route and `server.js` edit also need justification against the existing route/allowlist design. Every new public upgrade path increases authentication, replay, rate-limit, and cleanup surface. The smallest issue should first show why the existing meet transport cannot own the visual session.

### Councilor 2 — Audio / DSP

**Strongest point.** This proposal provides the strongest deterministic contract. It rejects network-chunk semantics, carries sample indices across callbacks, distinguishes H source time from A playback time, freezes calibration before blinded results, disables Caty's random mouth rests/shapes during measurement, and makes cancel epoch invalidate PCM and envelope state. The explicit statement that H preserves the current baseline without proving its playout clock is particularly important given Issue [#62](https://github.com/caty-ai/meetmate/issues/62).

**Strongest objection.** The proposal simultaneously argues for a minimal issue and includes A-only AudioWorklet code, a calibration config file, an optional L2 runtime directory, WebRig assets, and several unmeasured initial constants. A disabled L2 fixture is still implementation, provenance burden, attack surface, and review cost. A config artifact can also become premature product policy. The issue should retain calibration output as a test artifact until L1 passes rather than add a general runtime configuration surface.

The proposed 20 ms window, 10 ms hop, percentile rules, 12 dB spread, and attack/decay values are defensible starting hypotheses, not established Meetmate values. The issue must mark them as frozen experiment parameters derived/approved after baseline, not acceptance truth.

### Councilor 3 — Local Renderer / Caty Asset

**Strongest point.** The L1/L2 comparison is the most concrete visual and asset analysis. It correctly states that L2 is grid-warp/layer-fade pseudo-2.5D, has only two authored mouth poses, adds an 80 ms look-behind and a roughly 1.9 MB embedded rig, and is not Live2D. Its separation of runtime MIT obligations from Caty image/likeness rights is correct. It also recognizes current Attendee OSS commit [`ba74253`](https://github.com/attendee-labs/attendee/commit/ba74253c3c27a10bc10c5ded67a34eddc82b915d) as implementation evidence rather than hosted proof.

**Strongest objection.** Putting L2 in the same issue directly contradicts the strongest gate. The proposal names L2 runtime code, rig assets, a renderer selector, context-loss fallback, and package notices before L1 proves there is a product question for L2. That work creates momentum and makes “optional” code part of the security and maintenance surface.

More seriously, the H design proposes a silent AudioWorklet/analysis clock. In H, the visual page must create no audio graph or track at all. A zero-gain/muted AudioContext can still become a captured audio source and contaminate the one-owner proof. H RMS belongs at the server's one Fish seam, and page timing must be calibrated from stamped source time against the observer. If that clock is inadequate, reject H; do not invent a silent second audio pipeline.

The current Caty WebRig also cannot be treated as a safe L1 fallback without adaptation: unseeded `Math.random()` controls mouth rests and shapes; its public state lacks generation/utterance/cancel identity; and context restoration can reload `lastAvatarState` after queues are cleared. “Fallback to L1” must be newly designed and tested, not inferred from current WebRig recovery.

### Councilor 4 — Module Boundary / Test Contract

**Strongest point.** This is the strongest boundary proposal. It correctly identifies two blockers before L1: hosted H and an authoritative handler-level cancel/output epoch. It keeps H free of `AudioContext`, confines public assets through exact allowlisting, makes the visual queue unable to backpressure Fish, and excludes `server.js`, `pipeline.js`, config, Agent Core, and generic abstractions from the L1 issue. Its explicit dependency chain—baseline, cancel contract, H pass, rights, visual/cancel gates—is the responsible way to make one later implementation issue.

**Strongest objection.** The URL-fragment token is only partly protective. A fragment is not sent in the subsequent HTTP request, but the full `voice_agent_settings.url` is sent to Attendee's bot API/control plane and may appear in provider logs, dashboards, crash reports, or screenshots. It must therefore be a short-lived, single-use, narrowly scoped capability—not merely “a secret hidden from HTTP logs”—and must be consumed and removed with `history.replaceState` before any telemetry or error reporting.

The proposal also copies Caty's fixed `-50...-10 dB` normalization and `0.2/0.7` thresholds into the contract. Councilor 2 correctly shows these came from a different player/meter/corpus. Preserve them only as a comparison fixture, not the default. Calibration must demonstrate that comfort noise does not open the mouth and that the same PCM produces the same trace.

Finally, `drop-new-on-overflow` requires a visual correctness argument. It prevents visual backpressure from harming audio, but may leave the mouth displaying stale state. Overflow should fail the visual gate, force a safe closed/current snapshot policy, and be reported; it must not silently continue with known-late animation.

## Evidence against my Round 1 position

My Round 1 vote treated issue creation and code authorization too similarly. Councilors 1–3 demonstrate that an issue can be structured so a failed H/L0 gate closes successfully with evidence and no A fallback. Explicit stop gates do reduce speculative work if repository controls enforce them.

Councilor 4 strengthens my original blocker: a carrier pass alone is insufficient; the cancel epoch must be available at the handler boundary before L1. This makes my earlier proposed file list too confident. I named a server relay before proving the existing route topology and did not make the cancel contract an external dependency.

I also understated the difference between:

- copying Caty frame art;
- adapting Caty behavioral ideas; and
- copying MIT-derived Anime2.5DRig runtime.

Only the third has an identified license today. The source images were committed as rescued previously untracked files; hashes prove identity, not rights. L0 should use synthetic geometric markers. L1 should use synthetic/non-personal frames unless a written rights record clears Caty art.

## Adjudication of the contested claims

### Can one gated H→L0→L1 issue avoid speculative work?

**Yes, but only with executable gates, not prose headings.**

Minimum enforcement:

1. The issue is labeled experiment, not feature or production.
2. H/L0 and L1 are separate commits/PR checkpoints.
3. The L1 files/assets do not exist before a retained H/L0 pass artifact and approval comment.
4. H/L0 failure closes the issue successfully with a rejection result.
5. Full-page A and L2 are explicitly excluded.
6. No unchecked L1 task is assigned/scheduled before the gate.
7. The issue template names the gate owner and evidence links.

Without these controls, a single issue encourages sunk-cost continuation. With them, issue count itself is not the safety boundary.

### L2 deferral

**Defer L2 completely.** Do not copy its runtime, rig, notices, assets, test selector, fallback code, or disabled fixture in the H/L1 issue. Keep only a later-decision paragraph.

L2 earns a new issue when L1 passes all nonvisual gates and either:

- L1 misses only a predeclared naturalness/presence floor that L2 plausibly addresses; or
- a blinded comparison requires richer motion to answer a named product question.

Before L2 code:

- seed or disable random syllable/rest/mouth-shape behavior for deterministic tests;
- separate mouth determinism from optional seeded blink/head/body motion;
- add generation, utterance, sample, and cancel identity to state;
- define context-loss fallback that starts closed and cannot revive `lastAvatarState`;
- test WebGL unavailable, forced loss/restore during speech/cancel, hidden-page throttling, shader/texture failure, and 30-minute resource behavior;
- preserve MIT LICENSE/NOTICE and pin exact copied/adapted files/hashes.

### Caty provenance and image rights

For L1, no Swift code is needed. Reimplement RMS/frame selection from documented behavior. Use synthetic frames unless the following is recorded:

- creator and source-generation method;
- ownership or license;
- public webpage/meeting display right;
- redistribution and modification right;
- consent/likeness basis if a person is represented;
- source repo commit/path/hash and destination transformation/hash.

The `a76aff1` rescue commit is provenance history, not permission.

For L2, preserve `webrig/LICENSE` and expand `NOTICE.md` with the Anime2.5DRig origin, Caty source commit, every copied/adapted file, generated asset inputs/commands, and the limitation that the original shallow-upstream object was not recorded. Embedded textures inherit the art-rights gate; they do not become MIT merely because the runtime is MIT.

### Determinism and random behavior

Acceptance mouth state must be a deterministic function of:

```text
(renderer_session, generation, utterance, cancel_epoch,
 source_sample_index, frozen PCM, frozen calibration)
```

No `Math.random()` may affect mouth state, timing, or acceptance clips. Optional blink/head/body behavior may use a deterministic seed only after it is proven not to affect mouth trace, frame rate, or resource gates. Production randomness that differs from tested behavior requires its own stress test; a deterministic test-only mode cannot certify an unrelated random production mode.

### Public page authentication, cache, and CSP

The H page is public infrastructure even when its capability is ephemeral.

- Use a short-lived, single-use, session/generation-bound capability with strict message-size/rate limits and constant-time validation.
- Assume Attendee can see and retain the configured full page URL, including fragments. Never place a durable credential or internal gateway/session/user ID there.
- Consume the fragment immediately, clear it with `history.replaceState`, and prevent it from entering logs, error reports, referrers, screenshots, or page telemetry.
- Serve HTML/JS and capability bootstrap responses with `Cache-Control: no-store`; do not use a service worker, local storage, or persistent browser cache for authorization.
- Use an explicit CSP such as `default-src 'none'`, same-origin script/image/style as narrowly required, and one exact `connect-src` WebSocket origin. Avoid inline script and `unsafe-eval`.
- Allowlist exact asset paths; no recursive directory server, directory listing, CDN, external fonts, analytics, or source maps containing secrets.
- Treat avatar assets as extractable by the client. Authentication does not substitute for distribution rights.
- Expiry/auth failure must render a closed/blank visual and close only the visual connection; it cannot affect realtime audio or create a bot.

### WebGL and context loss

Not relevant to L1 acceptance and therefore not part of the first issue. For later L2:

- context loss must atomically mark visual output unavailable, clear state, and render/fall back closed;
- restoration starts with a new renderer generation or explicit current snapshot, never saved speaking state;
- no page reload, bot recreation, audio-graph creation, or PCM replay;
- expose FPS, long frames, context-loss count, restore duration, queue age/drop, and fallback count;
- test unavailable WebGL and repeated forced loss during cancel/reconnect;
- measure page/container resource behavior separately from Mac mini bridge/Agent Core resource behavior.

### Stale generation and cancel IDs

The page protocol must carry at least:

```text
renderer_session_id
connection_generation
utterance_id
cancel_epoch
first_sample_index
sample_count/window_count
source_monotonic_time
```

Every reconnect increments `connection_generation`; every authoritative abort/cancel invalidates the epoch before later state is admitted. Page startup and reconnect begin closed and receive no replay buffer. Old messages are rejected before scheduling or drawing. A later utterance cannot be closed by a delayed older cancel.

The current pipeline/handler contract must expose this authority before L1. Inferring cancel from silence, polling turn state, waiting for the next PCM chunk, or relying on socket close is unacceptable.

### Duplicate audio, bot, and fallback

H has one immutable audio owner: current realtime WebSocket. The visual page creates no `AudioContext`, media element, oscillator, audio destination, vendor track, or microphone-to-output connection. A muted/zero graph is not accepted as silence.

Minimum negative tests deliberately enable a second audio source and prove the observer detector catches level doubling, comb filtering, echo, or correlated duplicate waveform. Page crash/reload, visual WebSocket reconnect, realtime-audio reconnect, and server restart must never create a second bot or replay visual/audio state.

If H fails, leave the bot, prove absence or record an orphan incident, and close the issue. Full-page A requires a new decision and new bot session. Static remains the next-session default; there is no same-meeting automatic fallback.

## Exact minimum test set

### Before L1 code

1. **Static repeatability:** at least the frozen 30-minute Issue #62 scenario with source/observer audio, cut incidence, cancellation, reconnect, bot leave, and host resource data sufficient to freeze gates.
2. **Cancel contract:** unit/integration proof that every authoritative output abort emits a synchronous handler-level epoch event without changing turn semantics.
3. **H payload:** hosted bot accepts both settings; current input/output works; the page loads.
4. **Page silence:** page has no audio graph/track and observer sees exactly one waveform.
5. **Manager independence:** page kill/reload/auth failure does not stop, delay, replace, or replay realtime audio.
6. **L0 observer timing:** deterministic sample-indexed marker has bounded signed skew/drift against audible transients.
7. **Static isolation:** default payload/lifecycle unchanged; no live module, asset, timer, route, or credential is required in static mode.
8. **Public-page security:** expired/replayed/oversized/wrong-generation messages fail closed; cache/CSP/log checks pass.

### L1 tests after the gate

1. Chunk-boundary-independent RMS and sample indices for silence, comfort noise, tone, clipped/odd PCM, and frozen Japanese speech.
2. Frozen calibration; comfort noise never opens the mouth; repeated PCM produces an identical frame trace.
3. Cancel at onset/middle/drain, rapid cancel/new utterance, reconnect, delayed/reordered/duplicate messages, and queue overflow.
4. Missing/corrupt asset falls to closed visual without touching audio.
5. Browser hidden/background/reload behavior and deterministic canvas presentation timestamps.
6. Observer A/V p50/p95/max/drift, missed/extra mouth transitions, and blind visual floor.
7. Thirty-minute CPU, memory, event-loop delay, page FPS/long frames, queue slope, Mac mini thermal state, start/mid audio cuts, one waveform, and one bot.
8. Static regression repeated with live endpoint absent, invalid, and blackholed.

Any duplicate bot/audio, stale old-epoch frame, public credential leak, static dependency, unbounded queue/retry, or worsened non-waived audio gate is zero tolerance.

## What would change my NO vote

I would vote **YES, implementation-ready for one gated H→L0→L1 issue** when:

1. Issue #62 baseline and blinded numeric gates are frozen.
2. The handler-level cancel/output-epoch contract is reviewed and tested outside renderer code.
3. Hosted H passes L0 with page silence, one waveform, page/audio-manager independence, bounded observer skew/drift, cancel/reconnect, and one bot.
4. The issue contains no Full-page A or L2 implementation scope.
5. The L1 visual floor is stated and synthetic or rights-cleared assets are pinned with a complete manifest.
6. Public-page capability, no-store/cache policy, CSP, allowlist, log redaction, replay/rate bounds, and failure behavior are specified.
7. L1 work is a separate gated checkpoint and no L1 files/assets are created before the H/L0 evidence is approved.

At that point the issue is no longer speculative: H is a proven carrier, L1 answers a named visual question, and failure still closes without widening scope.

## Compromise

Draft one issue now titled along the lines of:

> Experiment: qualify Attendee Hybrid H with L0; add deterministic L1 only after carrier approval

The issue has two milestones:

1. **H/L0 qualification** — executable after baseline/cancel prerequisites.
2. **L1 implementation** — locked until the H/L0 approval comment and asset-rights manifest exist.

It explicitly excludes Full-page A, L2, LiveAvatar, Recall, production rollout, new dependencies, config-schema work, generic abstractions, and same-meeting fallback. Closing at H/L0 rejection counts as successful completion of the experiment.

## Vote

| Question | Vote |
|---|---|
| Draft one gated H→L0→L1 experiment issue now | **Conditional yes** |
| Call it implementation-ready today | **No** |
| Start L1 before H/L0 and cancel-contract approval | **No** |
| Include dormant/optional L2 code in the issue | **No** |
| Use Caty art before rights/provenance approval | **No** |
| Prefer deterministic L1 after H passes | **Yes** |
| Treat current WebRig random/context recovery as reusable unchanged | **No** |
| Full-page A fallback inside the issue | **No** |
| Preserve static as the sole production path | **Yes** |

The stop gates are strong enough to make one issue a responsible coordination artifact. They are not evidence that the renderer is ready to implement. The gate must control when code exists, not merely when a checkbox is marked.
