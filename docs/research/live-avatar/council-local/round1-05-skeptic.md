# Local Renderer Council Round 1 — Skeptic / Security / Operations

Status: blind independent review; no implementation approval  
Date: 2026-07-23  
Role: Councilor 5, skeptic / security / operations  
Evidence boundary: shared `00`, `01`, `02`, `04`, and `08`; Issues [#62](https://github.com/caty-ai/meetmate/issues/62) and [#69](https://github.com/caty-ai/meetmate/issues/69); Caty WebRig source/NOTICE/rig documentation; current worktree constraints. No other `council-local/round1` proposal was read.

## Position

**L1 is the smallest local renderer that could produce product evidence, but neither L1 nor L2 is responsibly ready for an implementation issue today.** The only responsibly ready issue shape is an L0 **Hybrid H coexistence experiment**:

- current `websocket_settings.audio` remains the sole meeting input/output; and
- simultaneous `voice_agent_settings.url` supplies a silent visual page.

[Current Attendee open source at `ba74253`](https://github.com/attendee-labs/attendee/commit/ba74253c3c27a10bc10c5ded67a34eddc82b915d) materially strengthens H: the serializer validates the two settings independently, `BotController` constructs realtime WebSocket and webpage-streamer managers independently, the webpage becomes the webcam destination, and realtime `bot_output` remains handled by its audio-output manager. There is no visible mutual-exclusion check.

This is code-path evidence, not a hosted-service guarantee. No reviewed upstream combined-mode test was found; the deployed version/configuration may differ; and a nominally silent captured page can still expose an audio track that changes mixing. H is preferred only if a sandbox proves coexistence, true page silence, one audible owner, and safe cancel/reconnect/leave.

**Full-page A**—where the page owns meeting audio and video—remains the alternative architecture, but it must not be an automatic fallback inside the H issue. If H fails, return to a new decision because A changes the current audio path.

If neither H nor A passes, stop. Building L1 or L2 cannot repair a failed meeting carrier. If H passes, it preserves the known audio topology but has a weaker A/V clock: the visual page sees source timing, not authoritative meeting playout. If A passes, it can tie mouth state to browser sample consumption but deliberately replaces the current audio egress and reopens the historical browser-audio failure class.

L2 should not be bundled into the first implementation. The existing Caty WebRig uses unseeded randomness for syllable timing, “rest” events, mouth-shape selection, blink, gaze, and body motion; interpolates a timestamp queue 80 ms behind its mapped clock; performs per-frame WebGL deformation; and has a context-restore path whose state contract lacks utterance/generation identity. Those properties are acceptable for an iOS visual effect but are hostile to a deterministic meeting-quality experiment.

## Evidence that invalidates a casual “reuse Caty” plan

### Existing audio is already not a clean control

Issue [#62](https://github.com/caty-ai/meetmate/issues/62) records two distinct facts:

- 24 kHz substantially improved perceived voice quality; and
- start-of-speech and mid-response cuts remained in the 2026-07-03 test.

The associated session logged zero abort, barge-in, TTS stall, duration-cap, or gateway error. Zero-filled silence/VAD behavior, Attendee jitter/resampling, and Meet noise suppression remain hypotheses. Therefore “local rendering did not worsen audio” cannot mean only “it sounds about the same.” Baseline cut locations, durations, and frequency must be characterized first, or a candidate can hide regression inside existing instability.

### L2 is not deterministic from PCM

In Caty `webrig/index.html`:

- `Math.random()` controls syllable intervals, rest probability, mouth-shape rerolls, blink, gaze, body motion, and optional talk motion.
- external mouth state is “naturalized” rather than being a pure function of PCM and sample position;
- only 24 timestamped state samples are retained;
- sampling is offset by 80 ms and interpolated;
- the public state shape is `{mouthOpen, isBlinking, activity, ts}`, with no utterance ID, generation, cancel epoch, or first-sample index.

The same PCM can therefore produce different mouth shapes and motion across runs. A local page can look plausible while observer-side A/V timing is wrong. “Natural” is not a substitute for repeatable evidence.

### WebGL recovery can revive stale state

The WebRig does listen for `webglcontextlost` and `webglcontextrestored`, which is better than ignoring loss. However, restore receives `lastAvatarState`, clears the queue, resets mouth variation, reloads the rig, and has no utterance/generation check. If the last state was speaking/open-mouth, restoration can visually revive a cancelled utterance. `getStats()` reports only FPS/readiness/variant, not frame time, context-loss count, restore duration, dropped state, queue age, or GPU memory.

### L2's rendering cost is not bounded by current evidence

The runtime uses `requestAnimationFrame`, calls `fit()` every frame, deforms layer vertex arrays on the CPU, uploads dynamic buffers, and draws multiple WebGL layers. Device pixel ratio is capped at 2, but no Attendee-container CPU/GPU profile or 30-minute context-loss/thermal result exists.

The WebRig would execute in Attendee's remote browser container, while the Mac mini still owns Meetmate, Fish, relay, and instrumentation. Both sides require measurement:

- Mac mini CPU, memory, event-loop delay, power/thermal state, and PCM relay stability;
- page FPS, long frames, queue age, context loss/restore, reloads, and any container resource telemetry Attendee exposes.

If Attendee does not expose container CPU/GPU information, that absence remains an operational observability penalty.

### Provenance is incomplete

`webrig/LICENSE` is MIT, copyright 2026 hakoniwa. `webrig/NOTICE.md` says the spike vendors Anime2.5DRig from `hakoniwa/852wa/Anime2.5DRig`, removed several upstream capabilities, and was copied from a shallow local upstream clone. The exact upstream object identity is therefore not recorded in the NOTICE. Any substantial copy must preserve the MIT license and copyright notice and identify the copied/adapted files.

The Caty mouth source images are weaker: commit `a76aff1b4f51430f2de97a752fdb00548b1bf7fc` says they were “rescued” from an old, previously untracked directory. No adjacent rights/provenance statement identifies their artist, generation source, commercial/public-display rights, or allowed redistribution. A git commit and SHA-256 prove file identity, not copyright permission.

The source repo is also a moving target. Its current HEAD is `4d56cb926763edc56ef8b9c387f198ad0b94a844`, while the last commit touching `webrig/index.html` is `8b2e2dad05576014d334554cb25f107f80e2da10`. Copying “current Caty” without a manifest creates silent cross-repo drift.

The Caty working tree also contains unrelated dirty state outside the inspected rig/assets paths. Future work must not clean, commit, or copy that working tree wholesale. Resolve every imported file from an explicit commit/path/hash. This Meetmate research worktree likewise contains shared untracked research artifacts; this council turn is limited to this one document and authorizes no source, configuration, dependency, README, release, or issue mutation.

## Hybrid H versus Full-page A

| Concern | Hybrid H | Full-page A |
|---|---|---|
| Meeting audio owner | Existing realtime WebSocket should remain sole owner | Page is sole owner; current WebSocket output must be disabled |
| Contract/code evidence | Current OSS independently constructs both managers and shows no visible exclusion; no combined hosted test/guarantee | Voice Agent page A/V capture is documented |
| Audio regression surface | Lowest if coexistence really preserves current path; inherits known #62 cuts | Browser playout, resampling, capture, WebRTC, and meeting codec are new |
| A/V clock | Weak: page visual clock is not the existing audio playout clock | Stronger locally: envelope can follow samples consumed by page audio |
| Duplicate-audio risk | High until a silent page and one-owner observer test prove otherwise | High if current WebSocket output remains enabled |
| Failure isolation | Two simultaneous Attendee media mechanisms may interact | One page-owned live mechanism, but page failure removes A/V |
| Current disposition | First cheap hosted coexistence probe | Separate decision if H is rejected or inadequate |

A “silent page” means the page creates no `AudioContext`, oscillator, media element, audio track, or vendor audio output in H. Silence generated by an active audio graph is still a second captured audio source and can interact with mixing/VAD. The observer must prove one audible waveform and no changed level, comb filtering, gating, or start/mid cut rate.

## Truly minimal safe experiment

### Gate 0 — stabilize and instrument the static baseline

Run the existing static path with the Issue #62 fixture set. Record source PCM and independent observer audio. Establish baseline distributions for start cuts, mid-response cuts, response latency, cancellation tail, reconnect, duplicate audio, bot leave, CPU/memory, and thermal state. Do not waive an unstable baseline by averaging it into permissive candidate thresholds.

### Gate H0 — coexistence-only Hybrid H

Create one non-default sandbox bot with both settings:

- current realtime WebSocket input/output unchanged;
- a public visual page that renders deterministic sample-indexed flashes only;
- no page audio graph or audio/media output;
- no avatar asset.

Prove that Attendee accepts the payload, the page loads, current PCM input/output continues, exactly one bot and one audible waveform exist, and cancel/reconnect/leave remain bounded. Measure observer A/V skew between known PCM transients and flashes. If coexistence is rejected, page capture interferes with WebSocket audio, page silence changes audio behavior, or timing is not observable/usable, reject H.

### Gate A0 — full-page carrier only by a new decision

If H fails but the live path remains worth investigating, stop the H issue and make a new architecture decision. A later Full-page A issue would use a bounded clock-driven audio queue and the same deterministic flashes. The mouth/marker state would follow the browser audio render/sample position, not WebSocket arrival. Current realtime WebSocket output would be disabled by construction. This separation prevents a “fallback” from silently replacing the proven audio path.

### Gate L1 — only after one carrier passes

Replace the flash with three deterministic states—closed, half, open—plus optional independently timed blink. Drive mouth level from short-window PCM RMS at consumed/scheduled sample positions. No random syllables, phoneme guesses, WebGL, head motion, asset toolchain, or generic renderer abstraction.

L1 is successful only if it adds useful visual evidence over L0 without changing the passing carrier's audio, resource, cancel, reconnect, or static results.

### L2 — separately authorized later

L2 is not part of this minimum. It earns a new issue only if:

- L1 passes technical gates but misses a predeclared visual-quality floor that pseudo-2.5D could plausibly satisfy;
- Caty code and art provenance are cleared;
- randomness is disabled or deterministically seeded for test mode;
- the state contract gains utterance/generation/cancel identity;
- context loss/restore, fallback, and resource budgets are specified;
- WebGL works in the Attendee container for 30 minutes under stress.

## Answers to the ten mandated questions

### 1. Is L1 or L2 the smallest implementation that produces useful product evidence?

**L1**, after H0—or a separately approved A0—passes. L0 produces carrier evidence; L1 is the smallest renderer/product evidence. L2 produces polish evidence only after L1 proves the clock, mouth-state, carrier, and cancellation boundaries.

L2 is not “L1 but nicer.” It adds WebGL availability, context lifecycle, random animation, per-frame CPU/GPU work, third-party source licensing, generated rig assets, and cross-repo maintenance.

### 2. Must L1 precede L2, or can one bounded implementation contain both as renderer fixtures without adding framework overhead?

**L1 must precede L2 as a decision gate.** Do not put both in one implementation issue or add a renderer selector/framework. A single page may eventually replace the L1 drawing function with L2, but only after L1 evidence is frozen. Bundling both encourages tuning L2 until it “looks right,” destroys attribution, and turns a bounded experiment into a renderer platform.

The only shared contract justified now is immutable `(session_generation, utterance_id, cancel_epoch, first_sample_index, sample_count, rms, scheduled_at)` state. Similar rendering APIs are not sufficient reason for an abstraction.

### 3. Where should RMS/envelope extraction run, and how is it tied to the browser audio clock without reintroducing the historical chunk-scheduling failure?

For **Full-page A**, RMS should run in the browser audio render path—preferably the same AudioWorklet/ring-buffer consumer that owns page playout. Compute fixed short-window energy from samples as they are consumed, and attach the first-sample index and browser render-clock time. Do not schedule one source node per network chunk, compute energy on packet arrival, or infer mouth state from dominant frequency.

For **Hybrid H**, the page is silent and cannot use its own audio playout clock. The server may compute or forward RMS/sample-index envelopes from the one Fish PCM stream, but observer calibration must quantify the offset and drift between existing Attendee WebSocket audio and visual page capture. H should be rejected for lip sync if that relationship is unstable or unobservable; preserving audio alone is not sufficient.

On cancel, invalidate the epoch, close the mouth immediately, clear scheduled visual state, and reject every old-generation packet after reconnect.

### 4. What are the exact runtime modules/files and their one-sentence responsibilities?

For the **first responsibly scoped issue (L0 Hybrid H coexistence experiment)**:

- `public/live-avatar-probe.html` — a dependency-free, credential-free, audio-free page that renders deterministic sample-indexed markers.
- `public/live-avatar-probe.js` — H-only generation/cancel handling, marker timing, page-silence assertions, and structured browser telemetry.
- `src/transport-meet/live-avatar-probe.js` — non-default experimental session relay, ephemeral page capability, PCM/control envelope, one-output-owner assertion, and probe telemetry.
- `test/live-avatar-probe.test.js` — unit/contract tests for payload modes, source lineage, epoch cancellation, one-owner rules, and public-page secret exclusion.
- `test/live-avatar-static-isolation.test.js` — proves static payload/startup behavior does not import or depend on the probe.

If A is later authorized, add `public/live-avatar-audio-worklet.js` and a separate A-specific page/controller test. Do not put dormant A audio code into the H page.

For later **L1**, add only:

- `public/live-avatar-l1.js` — deterministic RMS-to-three-state mapping and frame presentation.
- `public/live-avatar-assets/` — cleared, hashed L1 frames plus a provenance manifest.

This is a proposed issue boundary, not authorization to create the files now. L2 files are intentionally unspecified until it passes its prerequisites.

### 5. What existing static/core files require thin wiring, if any?

Only `src/transport-meet/meet-routes.js` should require thin, non-default wiring:

- select H, A, or existing static **before** bot payload construction;
- preserve the existing static payload block byte-for-byte;
- tee Fish PCM/control only in the selected live experiment;
- keep current WebSocket output authoritative in H;
- make page output authoritative and current WebSocket output impossible in A.

Do not edit `src/pipeline.js`, Fish, gateway/provider code, memory, skills/tools, profile resolution, or static image loading. `public/` is already served, so no new app framework is justified. If safe isolation cannot be achieved with this thin seam, stop and redesign rather than moving avatar state into Agent Core.

### 6. What Caty code/assets are copied, adapted, or referenced, and how is provenance preserved?

For L1:

- copy **no Swift/SwiftUI code**;
- reimplement the simple RMS threshold behavior from the documented formula rather than copying application code;
- copy frame PNGs only after a written art-rights/provenance statement identifies creator/source, public-display and redistribution rights, and permitted modification;
- record source repo, source commit, original paths, destination paths, SHA-256, modification notes, and approval in `public/live-avatar-assets/PROVENANCE.md`.

The current “rescued from previously untracked” commit is not enough rights evidence.

For L2 later:

- vendor an immutable, reviewed subset rather than reference a mutable local checkout or create a cross-repo package;
- include the upstream `webrig/LICENSE` and an expanded NOTICE naming Anime2.5DRig, copied/adapted files, Caty source commit, hashes, local modifications, and the fact that the original shallow upstream object was not recorded;
- preserve regeneration commands and generated-asset inputs;
- decide explicitly whether `rig.caty.js/json` are distributed derived assets and apply the art-rights record to their embedded textures;
- add a drift-check script against the pinned manifest, not against Caty `HEAD`.

### 7. What unit, browser, carrier, 30-minute, cancel, reconnect, and static-regression tests are mandatory?

**Unit**

- exact RMS values for tone, silence, low noise, clipped PCM, odd chunk boundaries, and multiple window sizes;
- deterministic closed/half/open thresholds and hysteresis;
- same PCM produces identical state timeline across repeated runs;
- sample-index continuity across rechunking;
- cancel closes immediately and old epoch/generation never reopens;
- H and A enforce mutually exclusive audible owners;
- public page artifacts contain no API key, gateway token, meeting URL, stable user ID, or internal session identity.

**Browser**

- actual 24/48 kHz AudioContext behavior, suspended/resumed/autoplay, hidden page, timer throttling, reload, network jitter, bounded queue underrun/overrun, and asset failure;
- for later L2: WebGL unavailable, forced context loss/restore during speech and cancel, FPS/long-frame telemetry, deterministic test seed, stale-state rejection, and a non-WebGL closed-mouth fallback.

**Carrier**

- H0 first; A0 only in a separately approved issue, never as silent fallback within the same run/scope;
- independent observer recording of source transient versus marker, one audible waveform, no comb filtering/level change, start/mid cut rate, cancel tail, reconnect, bot count, page count, input continuity, and leave.

**Thirty-minute**

- the frozen script from `04-comparison-poc-spec.md`;
- Mac mini CPU/memory/event-loop/thermal slope and page FPS/long frames/context loss/reloads;
- baseline versus candidate blind audio and objective cut/dropout comparison;
- no queue growth, resource leak, or stale visual state.

**Static regression**

- live credentials absent and live DNS blackholed;
- exact static bot payload/image behavior;
- no live module initialization/network/timer;
- greeting, turns, barge-in/cancel, reconnect, exit, and leave baseline-equivalent;
- failed live session never creates a static bot in the same meeting.

### 8. What immediate-stop conditions prevent proceeding from L0 to L1 or L1 to L2?

**Stop before L1 if:**

- the static baseline is not repeatable enough to set blinded thresholds;
- H coexistence is unsupported, rejected, duplicates/suppresses audio, changes #62 cut behavior, or cannot expose useful A/V timing;
- A regresses blind audio, start/mid cuts, latency, cancellation, reconnect, or resource use;
- any mode creates two bots or two audible owners;
- cancel/reconnect can replay stale markers or utterances;
- actual rate/queue/observer timing is unavailable;
- the public page requires a durable secret or exposes sensitive meeting/session data;
- static initializes or depends on any live component.

**Stop before L2 if:**

- L1 fails because of carrier, timing, cancel, or resource defects;
- no predeclared visual floor explains what L2 is meant to improve;
- Caty art or runtime provenance/rights remain unresolved;
- unseeded random mouth shapes remain in the acceptance path;
- the state contract still lacks utterance/generation/cancel identity;
- WebGL is unavailable/unstable, context restore revives stale state, or no closed-mouth fallback exists;
- 30-minute FPS, long-frame, memory, context-loss, and Mac mini/relay budgets fail;
- L2 expands into Live2D, phoneme inference, avatar authoring, a provider framework, or a cross-repo package.

### 9. Does the proposal avoid abstractions built only for future LiveAvatar/Recall?

**Yes, if kept to the concrete H probe and later deterministic L1 page.** Do not create `AvatarProvider`, renderer discovery, capability negotiation, generic lifecycle/state machine, LiveAvatar/Recall adapters, cross-provider fallback, common vendor config, or a shared Caty/Meetmate package.

The current-purpose envelope, one-output-owner assertion, bounded queue, cancel epoch, and provenance manifest are safety/test controls, not future-proofing. Extract shared rendering code only after two working renderers demonstrate identical semantics; L1 and hypothetical L2 names alone do not establish that.

### 10. Is the proposal ready to become one implementation issue? Vote yes/no and state prerequisites.

**Vote: NO for an L1/L2 implementation issue.**

One issue that includes carrier changes, Hybrid H, Full-page A, RMS clocking, L1, L2, Caty asset import, WebGL hardening, and static regression is not “minimal”; it is an EPIC disguised as one issue.

**A narrowly reclassified L0 Hybrid H coexistence experiment issue is ready to draft, not yet ready to execute, after these prerequisites are written into it:**

1. Issue #62 baseline artifacts and blinded thresholds exist.
2. The issue cites current Attendee OSS evidence but explicitly requires hosted sandbox confirmation and does not represent coexistence as guaranteed.
3. H keeps the existing realtime WebSocket as the immutable sole input/output owner; the page contains no audio graph/track.
4. The public-page capability design contains no durable secret or sensitive stable identifier.
5. Exact observer, cancel, reconnect, bot-count, static-isolation, CPU/memory/thermal, and stop gates are included.
6. No Caty art or runtime is imported in L0.

If H fails, return to a new decision before drafting A. After one carrier passes, create a **separate L1 issue** with cleared frame rights and frozen deterministic tests. Create an L2 issue only after L1 results justify the additional visual hypothesis.

## Security, public-page, and fallback gates

The Voice Agent URL is public HTTPS. The page and static assets must be treated as retrievable by outsiders:

- no durable Attendee, gateway, Fish, or meeting credential in HTML, JS, source maps, query strings, local storage, logs, or error text;
- short-lived, one-session, audience-bound capability where interaction is required;
- no raw internal meeting/session/gateway/user ID in the browser;
- strict input validation, origin/session binding, replay prevention, CSP, and bounded message sizes/rates;
- assume avatar PNGs and embedded rig textures can be copied; do not publish uncleared art;
- page failure or capability expiry closes visuals and cannot change Agent Core or create another bot.

There is no automatic in-meeting fallback:

1. invalidate the generation and stop local sends;
2. close visual/audio queues;
3. request leave for the one live bot;
4. prove absence or record an orphan incident;
5. allow static only in a later clean session.

Under H, renderer failure may allow the existing audio bot to continue **only if the tested ownership contract proves the visual page can disappear without changing audio or bot lifecycle**. That is graceful visual degradation, not switching media owners. Under A, page failure removes the live A/V owner and should fail closed.

## Final vote

| Question | Vote |
|---|---|
| Implement L1 now | **No** |
| Implement L2 now | **No** |
| Bundle L1 and L2 in one issue | **No** |
| Draft one L0 Hybrid H coexistence experiment issue | **Conditional yes** |
| Include Full-page A fallback in that issue | **No** |
| Prefer H if coexistence/silence/ownership/timing pass | **Yes** |
| Treat H coexistence as established | **No** |
| Advance L1 after one carrier and asset-rights gates pass | **Yes** |
| Advance L2 after L1 | **Only by a new decision** |
| Preserve static as sole production path | **Yes** |

The responsible next issue tests whether Meetmate can show a deterministic silent visual page beside—or instead of—the current audio route without changing what participants hear. It should not yet promise a local avatar.
