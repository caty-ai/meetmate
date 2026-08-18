# Round 2 — Local Renderer Cross-Review

Date: 2026-07-23  
Role: local renderer / browser runtime  
Scope: cross-review and issue-shape decision only; no implementation

## Revised position

Round 1 changed my vote.

**L1 remains the smallest renderer that can produce product evidence, but it is
not ready to implement today.** The smallest issue responsibly ready to draft is
an **L0 Hybrid H coexistence probe**. It must prove the hosted Attendee
combination, a genuinely audio-free page, one audible owner, bounded
source-to-observer timing, failure isolation, cancel/reconnect behavior, and
static isolation.

After that passes, L1 should be a **separate bounded issue**. L1 is not merely a
fixture: it is both the enduring non-WebGL fallback and the first test of whether
participants perceive the local avatar as useful rather than distracting.
However, that statement becomes true only when the product team predeclares a
visual floor and the selected art is cleared for public display and
redistribution. Before those gates, L1 is only a proposed product experiment.

L2 should be a **later, separate issue**, not a dormant fixture in the L1 issue.
My Round 1 proposal underestimated how much independent uncertainty L2 adds:
third-party source lineage, embedded texture rights, nondeterministic animation,
WebGL lifecycle, remote-container performance, and a new visual-quality
hypothesis. A shared state record does not justify shared issue scope or a
renderer framework.

Full-page A remains a separately reviewed architecture decision if H fails. It
must not be an automatic fallback in the H issue because it changes the sole
audible owner.

## Cross-review of the five Round 1 proposals

### 1. Meeting-bot integrator

**Strongest point:** the proposal keeps the media-ownership decision ahead of
renderer work. H preserves the current realtime WebSocket audio route while the
page is visual-only, and an H failure returns to a new A decision rather than
silently replacing the audio carrier. Its staged H → L0 → L1 order and page
failure isolation are the right operational skeleton.

**Strongest objection:** it treats one staged experimental issue as large enough
to include carrier qualification and L1. That weakens attribution: a failed
result could be carrier timing, public-page behavior, asset rights, or renderer
quality. H0 should close with recorded evidence before an L1 implementation
issue is opened.

### 2. Audio/DSP specialist

**Strongest point:** this is the strongest same-sample contract. Continuous
24 kHz S16LE sample indices, 20 ms RMS windows with 10 ms hop, chunk-boundary
carry, mean removal, calibrated dBFS thresholds, causal smoothing, and explicit
cancel epochs make the visual trace reproducible. It also correctly refuses to
pretend H exposes an authoritative browser audio clock.

**Strongest objection:** allowing L2 as a disabled test fixture in the same issue
still imports L2's code, asset, WebGL, and provenance surface before L1 has
answered the product question. “Disabled” is not free scope. The DSP contract
should be preserved, while L2 waits for a separate decision.

### 3. Local renderer proposal

**Strongest point:** the proposal separated the H and A audio topologies, kept
rig generation offline, rejected a generic renderer/provider framework, and
required L2 context-loss degradation to L1 without restarting or replaying
audio. The shared generation/turn/sample state is the right conceptual boundary.

**Strongest objection:** my own Round 1 vote was too permissive in putting L2 in
the same issue and too vague about Caty art rights. A source commit and hashes
establish identity, not permission. The proposed automatic restoration of a
renderer state also needs a stricter freshness rule than “fall back to L1 and
resume.”

### 4. Module-boundary architect

**Strongest point:** the proposal identifies the missing cancel-epoch seam as an
architecture prerequisite, not a browser detail. Its dependency direction keeps
Agent Core, Fish, Soniox, gateways, memory, and tools out of the visual edge, and
its exact allowlist/static-isolation contract prevents the experiment from
becoming a second application.

**Strongest objection:** its frozen Caty-style `-50...-10 dB` mapping and
`0.2/0.7` thresholds are too specific before fixture calibration. Those values
are evidence about Caty, not safe Meetmate defaults. The file boundary is useful,
but the numeric contract should follow the audio proposal's frozen,
fixture-derived calibration.

### 5. Skeptic / security / operations

**Strongest point:** the skeptic found the decisive distinction between
provenance and rights. The “rescued” Caty PNG commit, shallow Anime2.5DRig
upstream history, and public retrievability of a Voice Agent page mean that
hashes and notices alone do not authorize publication. The insistence that an H
page create no `AudioContext`, media element, oscillator, destination node, or
audio track is also the cleanest one-owner test.

**Strongest objection:** calling the L0 issue merely “ready to draft, not ready
to execute” can become procedural ambiguity. The issue should be executable as
a deliberately gated probe once its baseline thresholds, ephemeral capability,
observer protocol, and stop conditions are written. It need not wait for Caty
rights because L0 imports no Caty assets. The skeptic's NO is correct for L1/L2,
but should not immobilize the carrier experiment.

## Resolution of the disputed points

### L1: product evidence, not merely a fixture

L0 answers “can the media topology carry a synchronized silent visual surface
without harming audio?” It is a fixture.

L1 answers a different question: “does a deterministic three-state illustrated
face add acceptable participant-facing value at an acceptable cost?” It is the
smallest product renderer and, if accepted, the required no-WebGL fallback.
Therefore L1 must have product acceptance evidence:

- blinded comparison against L0/static;
- obvious and correctly timed idle-versus-speaking state;
- immediate close on cancel and no stale reopen;
- stable identity and no distracting flicker;
- no audio-quality, latency, lifecycle, or static-mode regression;
- a predeclared CPU/memory/frame-time floor.

If stakeholders declare in advance that a three-state illustrated avatar could
never be shipped, L1 ceases to be product evidence and is only a technical
fixture. In that case the council must say so explicitly rather than relabel a
fixture after an unfavorable result.

### L2: later issue

L2 follows only when L1 passes its carrier/timing/resource gates but misses a
predeclared visual-quality criterion that pseudo-2.5D motion could plausibly
improve. It is not justified when L1 already meets the floor, and it cannot fix
carrier, cancel, or clock failures.

The only shared contract to preserve is concrete state data such as:

```text
{
  session_generation,
  connection_generation,
  utterance_id,
  cancel_epoch,
  first_sample_index,
  sample_count,
  level,
  source_time
}
```

This is a stale-state safety contract, not a renderer API.

## Exact files, assets, and provenance

### Issue 1: L0 Hybrid H coexistence probe

- `src/transport-meet/live-avatar-probe.js` — owns one non-default H probe's
  ephemeral page capability, bounded marker/control relay, generation/epoch
  validation, and telemetry.
- `public/live-avatar-probe.html` — fixed-size, dependency-free, credential-free,
  audio-free captured page.
- `public/live-avatar-probe.js` — deterministic sample-indexed marker scheduling,
  stale-state rejection, page-silence assertions, and browser telemetry.
- `test/live-avatar-probe.test.js` — protocol, capability, bounds, cancel,
  reconnect, and one-owner tests.
- `test/live-avatar-static-isolation.test.js` — proves default static payload,
  audio bytes, module loading, routes, and lifecycle remain unchanged.
- `test/fixtures/live-avatar-probe/` — frozen PCM transients and expected marker
  trace.

Thin edits are limited to `src/transport-meet/meet-routes.js` and exact public
file allowlisting in `src/ui-routes.js`. If the handler boundary cannot expose an
authoritative cancel epoch without changing `src/pipeline.js`, stop and review
that seam separately; do not poll Agent Core state from the renderer.

### Issue 2: L1 deterministic frame avatar

- `src/transport-meet/local-avatar-session.js` — derives calibrated envelopes
  from the exact copied Fish PCM stream and owns bounded sequencing/epochs.
- `public/live-avatar/l1.html` — fixed canvas/image surface with no audio path
  under H.
- `public/live-avatar/l1.js` — source-sample scheduling, calibrated
  closed/half/open selection, optional independently timed blink, diagnostics,
  and deterministic test hooks.
- `public/live-avatar/frames/closed.png`
- `public/live-avatar/frames/half.png`
- `public/live-avatar/frames/open.png`
- `public/live-avatar/frames/blink.png` only if it has separately cleared rights
  and cannot perturb mouth timing.
- `public/live-avatar/PROVENANCE.md` — per-file source repository, immutable
  source commit, original/destination path, original/destination SHA-256,
  transformation command, creator/likeness owner, public-display permission,
  redistribution/modification permission, approver, and date.
- `config/live-avatar-envelope.json` — frozen calibration values, fixture hashes,
  extractor version, and sample rate.

No Swift or SwiftUI file is copied. `CatyController.swift` and
`FrameAvatarView.swift` are behavioral references only. The exact Caty PNG source
paths and hashes must be resolved from a pinned commit; no file is copied from a
dirty working tree or merely because it appears in `a76aff1...`. If written
rights cannot be established, use a newly created synthetic/non-personal test
frame set with its own provenance.

### Issue 3: L2 pseudo-2.5D WebRig

- `public/live-avatar/l2.js` — a reviewed, minimal adaptation of the Caty WebRig
  render path; no audio scheduling and no provider abstraction.
- `public/live-avatar/webrig/rig.caty.js` — pinned generated rig asset, treated as
  distributable art because it embeds textures.
- `public/live-avatar/webrig/manifest.json` — source commit/path/hash,
  destination hash, transformations, embedded texture inventory, and
  regeneration command.
- `public/live-avatar/webrig/LICENSE` — preserved Anime2.5DRig MIT license.
- `public/live-avatar/webrig/NOTICE.md` — hakoniwa/852wa attribution, exact
  copied/adapted sections, Caty source identity, modifications, and an explicit
  note that the prior shallow clone did not record the original upstream object.

`webrig/index.html` is a source for selected behavior, not a file to copy
wholesale. Rig-generation tools remain offline and outside Meetmate runtime.
The current Caty `rig.caty.js` and any embedded textures require both runtime
license review and separate art/likeness rights clearance.

## Determinism and random mouth behavior

Unseeded Caty behavior is forbidden in every acceptance run. Random syllable
duration, mouth rests, and mouth-shape substitution directly alter the
audio-to-mouth relationship and must be disabled, not merely made “usually
small.”

The acceptance mode is deterministic:

- mouth openness is solely a function of the frozen sample envelope, thresholds,
  smoothing, and epoch;
- optional blink/head/body cosmetics use a documented seeded PRNG, with the seed
  derived from or recorded beside `(session_generation, utterance_id)`;
- replaying the same PCM, state trace, and seed produces the same rendered trace;
- the seed is present in telemetry and fixture evidence.

A later production candidate may use bounded seeded cosmetic variation. Random
mouth rests or shape substitutions remain outside the acceptance path and
require their own blinded comparison showing no worse skew, missed transitions,
or participant perception.

## WebGL context loss and stale-state handling

Caty's current “restore `lastAvatarState`” behavior is unsafe as copied. A
context can return after cancel, reconnect, or a new utterance.

On `webglcontextlost`, L2 must:

1. prevent default restoration handling and stop its render loop;
2. invalidate GPU resources and the local L2 presentation generation;
3. discard interpolation history, random-animation state, and cached
   `lastAvatarState`;
4. present an already-loaded L1 closed/idle frame;
5. leave H audio and the page connection untouched.

On `webglcontextrestored`, rebuild resources but remain closed. L2 may resume
only after a fresh authoritative snapshot whose
`(session_generation, connection_generation, utterance_id, cancel_epoch)` equals
the current page state and whose sample position is not behind the current
presentation floor. It must never replay buffered states or resurrect the
pre-loss mouth. Restore during cancel and reconnect are mandatory tests.

WebGL unavailable at startup has the same fail-closed L1 behavior. Fallback is
visual degradation inside the one page, not a new bot, new audio owner, page
reload, or media replay.

## Public-page and asset exposure

The Voice Agent page and every referenced asset must be assumed publicly
retrievable:

- no durable Attendee, Fish, gateway, meeting, or user credential in HTML, JS,
  source maps, query strings, storage, logs, or errors;
- use a short-lived, one-session, audience-bound capability; place the bootstrap
  secret in the URL fragment, consume and clear it, then authenticate the
  bounded WebSocket;
- expose no raw meeting URL or stable internal session/user/gateway identifier;
- bind origin and session, reject replay, cap message size/rate/history, use a
  restrictive CSP, and load no third-party CDN;
- serve only explicit allowlisted immutable assets, preferably hashed;
- publish no Caty frame or embedded rig texture until its art and likeness rights
  explicitly cover public display and redistribution.

Page/capability failure closes the visual state. It cannot invoke Agent Core,
create a second bot, switch to static in the same meeting, or change the audible
owner.

## Visual and CPU floor

Thresholds must be frozen before candidate labels are revealed.

For L1, require at minimum:

- blinded observers distinguish speaking from idle and rate the result no worse
  than the predeclared distraction/acceptability floor;
- onset/offset/cancel bounds pass the synchronized observer recording;
- no false opening on silence/comfort noise and no unstable flicker;
- target Mac mini CPU, memory slope, event-loop delay, and thermal state remain
  within the static-derived margin;
- page frame cadence/long tasks and relay queue/history remain bounded for
  30 minutes.

L2 advances only with a named visual deficit and a predeclared minimum blinded
improvement over L1. It must also meet a stricter browser floor: target frame
rate, p95/p99 frame time, long-frame count, context-loss recovery, memory slope,
and zero stale restores over 30 minutes. Both the Mac mini and Attendee page are
measured. If Attendee exposes no remote container CPU/GPU telemetry, record
`unknown` rather than zero and treat the missing observability as a deployment
penalty; visual frame-time evidence is still mandatory.

## Direct response to the two NO-today votes

The module-boundary and skeptic NO votes are correct **for an L1/L2
implementation issue today**. Hosted H coexistence, a transport-visible cancel
epoch, and frame rights are prerequisites, not checklist items to discover while
building the renderer.

They do not imply that all work must stop. A Caty-free, audio-free L0 H probe is
the smallest reversible experiment that resolves the carrier uncertainty. It may
be filed as an executable issue once its static baseline, ephemeral capability,
observer protocol, resource limits, and immediate-stop conditions are included.
Failure closes that issue and returns to an A architecture decision.

## Smallest compromise and vote

The smallest compromise is:

1. draft and execute one **L0 H-only coexistence probe issue** with no Caty code
   or art and no A fallback;
2. after recorded H, cancel-epoch, static-isolation, timing, and rights gates
   pass, open one **L1 deterministic frame-avatar issue**;
3. consider **L2 only in a later issue** if L1 passes technically but misses a
   predeclared visual floor that pseudo-2.5D can address.

**Vote today:**

- L0 H-only probe issue: **YES, conditional on the issue containing the stated
  baseline, security, observer, resource, and stop gates**.
- L1 implementation issue now: **NO**.
- L1 after H/cancel/right/floor prerequisites: **YES**.
- L2 in the L1 issue: **NO**.
- L2 later: **conditional YES by a new decision**.
- Full-page A as fallback in the H issue: **NO**.
- Static as the only production-qualified default throughout: **YES**.
