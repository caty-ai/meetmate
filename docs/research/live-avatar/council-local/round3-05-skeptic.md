# Round 3 Final Vote — Skeptic / Security / Operations

Date: 2026-07-23  
Scope: final council decision only; no implementation authorization  
Reviewed: all five `council-local/round2-*.md` submissions

## Changed view from Round 2

My Round 2 vote was conditional yes to drafting one gated experiment issue but
no to calling it implementation-ready. The common compromise resolves the main
ambiguity: one issue can be the audit trail while source scope remains locked by
milestone. I therefore vote **YES to creating that one issue now**.

This is not a vote to start H0 or L1 code immediately. M0 must first lock static
behavior and prove that the existing abort authority can expose a
semantic-neutral cancellation/output-epoch observation. H0 may then falsify the
hosted Hybrid H carrier. L1 remains forbidden until H0 and all listed gates pass.

The Round 2 evidence also sharpens one requirement. A bare
`playback_cancelled({reason, monotonicTime})` event is insufficient if a late
old PCM callback can arrive after the event and be mistaken for a new
utterance. The authoritative `outputEpoch` (or equivalent immutable identity)
must be attached consistently to both output PCM observations and cancellation.
If that cannot be done without changing turn, abort, or audio behavior, M0
stops.

## Final vote table

| Decision | Vote | Binding qualification |
|---|---|---|
| A. Create an experiment issue now | **YES** | Issue creation authorizes specification and ordered evidence collection, not unconditional code start. |
| B. Use one issue for M0 → H0 → conditional L1 | **YES** | Each milestone expands source scope only after a recorded hard-gate pass; H0 failure closes successfully with no L1 files. |
| C. Keep L2 out | **YES** | L2, WebGL, Caty art/runtime, renderer switching, and dormant fixtures are absent. |
| D. Treat M0, baseline, security, and rights as prerequisites | **YES** | M0 precedes H0; H0/security/cancel baselines precede L1; frame rights precede any asset entering `public/`. |
| E. Enforce the exact minimal file ceiling below | **YES** | Fifteen paths maximum through L1; no new dependency or general framework. |
| F. Make every pass/stop gate binding | **YES** | A failed hard gate stops the current milestone and forbids downstream source scope. |
| Full-page A fallback in this issue | **NO** | H failure returns to a new architecture decision. |
| Start L1 now | **NO** | H is not yet a proven lip-sync carrier. |
| Production rollout/default change | **NO** | Static remains the sole production-qualified default. |

## D. Ordered prerequisites

### Before any M0 source edit

1. Preserve the current static behavior with regression fixtures: normalized and
   serialized Attendee payload, one unchanged `bot_output`, mixed input, echo
   gate, cancellation, reconnect, exit, leave, and delayed cleanup.
2. Record the current Issue #62 start-cut and mid-response-cut baseline using the
   hosted target and synchronized observer capture.
3. Freeze the H0 observer protocol and numeric acceptance limits before candidate
   results are revealed.
4. Approve the exact M0 event contract and enumerate every current authoritative
   abort path it must observe.

### Before H0 code starts

M0 must demonstrate that one additive observer seam can expose:

```text
output_audio({ outputEpoch, sampleStart, sampleCount, sampleRate, bytes })
playback_cancelled({ outputEpoch, reason, monotonicTime })
```

Equivalent names are acceptable. The identity and ordering are not optional.
Listener absence must be a no-op; listener failure must be contained; the seam
must not alter abort conditions, Fish bytes, callback order, dialogue, turn
state, gateway behavior, or exit grace. If semantic-neutrality cannot be proved,
stop before H0.

### Before conditional L1 code starts

1. Hosted H0 passes every carrier, observer, lifecycle, security, and 30-minute
   gate below.
2. Static regression remains byte- and behavior-compatible.
3. Frozen Fish Japanese speech, silence, and exact comfort-noise fixtures produce
   an approved deterministic calibration record.
4. The L1 visual/product floor is declared before candidate review.
5. Each proposed frame has written creator/rightsholder, public-display,
   redistribution, modification, and likeness approval. Otherwise use newly
   created non-personal synthetic frames with equally explicit provenance.

## E. Exact minimal file ceiling

### M0 + H0: at most ten touched paths

1. `src/pipeline.js` — only the additive authoritative output/cancel observation
   accepted in M0.
2. `src/transport-meet/meet-routes.js` — explicit non-default experiment
   selection, unchanged audio tee, combined Attendee payload, exact page/socket
   dispatch, and lifecycle close.
3. `src/ui-routes.js` — exact allowlist only; no recursive public directory.
4. `src/transport-meet/local-avatar-session.js` — one concrete visual session,
   ephemeral capability, bounded marker queue, output epoch, connection
   generation, stale rejection, and idempotent close.
5. `public/local-avatar/index.html` — fixed, dependency-free, audio-free page.
6. `public/local-avatar/local-avatar.js` — L0 deterministic flashes, epoch and
   connection rejection, closed/idle failure state, and test telemetry.
7. `test/local-avatar-session.test.js` — protocol, auth, bounds, output epoch,
   cancel, reconnect, and cleanup.
8. `test/local-avatar-page-contract.test.js` — silence, CSP, deterministic
   presentation, stale rejection, and browser failure behavior.
9. `test/local-avatar-static-regression.test.js` — payload/audio/lifecycle
   compatibility and zero live-module initialization by default.
10. `test/fixtures/local-avatar-timeline.json` — frozen transient/sample-index
    trace; no real credential or personal data.

`src/server.js`, configuration schemas, Agent Core policy, Fish, Soniox,
gateways, profiles, memory, skills, and tools are outside the ceiling. No new
dependency, provider interface, renderer registry, DI container, or package is
allowed.

### Conditional L1: five additional paths, fifteen total

11. `src/transport-meet/local-avatar-calibration.json` — frozen extractor and
    calibration values plus fixture hashes.
12. `public/local-avatar/assets/closed.png`
13. `public/local-avatar/assets/half.png`
14. `public/local-avatar/assets/open.png`
15. `public/local-avatar/assets/PROVENANCE.md`

L1 modifies existing H0 JS/tests rather than adding a renderer layer. Blink,
alternate talk frames, Caty files, WebRig, AudioWorklet, and fallback code are
outside the issue. A need to exceed this ceiling stops for council review; it is
not an invitation to rename files or hide generated artifacts.

## F. Hard pass and stop gates

### M0 pass/stop

Pass only if all authoritative abort paths emit exactly one ordered observation,
PCM carries the matching authoritative output epoch and continuous sample
lineage, listener absence/failure is inert, and all locked static tests pass.

Stop if the seam requires refactoring abort ownership, polling mutable turn
state, inferring cancel from silence, changing audio bytes/order, or teaching
pipeline code about avatars. No H0 files are added after an M0 stop.

### H0 carrier pass/stop

Pass only if the hosted target:

- accepts simultaneous `websocket_settings.audio` and
  `voice_agent_settings.url` for one bot;
- keeps the current realtime WebSocket as the sole input/output owner;
- presents a page with no `AudioContext`, `AudioWorklet`, audio/media element,
  oscillator, media destination, captured audio track, or vendor audio;
- produces exactly one observer waveform with no duplicate, comb-filtered,
  delayed, gated, or level-shifted copy;
- is non-inferior to the frozen Issue #62 start/mid-cut baseline;
- yields bounded marker-to-observer-audio signed skew, p50/p95/max, variance, and
  drift under one predeclared fixed offset;
- survives cancel before/mid/after output, rapid next turn, page reload/kill,
  socket replacement, reconnect, exit, leave, and failed cleanup without stale
  replay, audio disruption, duplicate bot, or orphan resource;
- passes frozen 30-minute CPU, memory slope, event-loop, thermal, page-frame,
  queue, and reconnect limits; and
- leaves static isolation clean.

Stop H0 on any failed item. Close the issue with evidence if the carrier fails;
do not add L1, select Full-page A, create a second bot, or tune an audio delay to
mask unstable mapping.

### Conditional L1 pass/stop

Pass only if frozen PCM and epoch traces yield byte-identical envelope/frame
traces under arbitrary rechunking; silence/comfort noise stays closed; cancel
closes before the next presented frame; stale epochs never reopen; assets and
calibration are exactly manifest-bound; blinded visual results meet the
predeclared floor; and all H0 audio, security, lifecycle, and resource gates
remain non-inferior.

Stop on failed rights, nondeterminism, stale reopen, visual queue growth, timing
regression, or pressure on the audio path. A visual failure must fail closed and
must never change the bot or audible owner.

## Exact security, operations, and rights stops

### Security

- Use a random, 256-bit, short-lived, one-session, audience-bound visual
  capability distinct from internal meeting/session/user IDs.
- The launch fragment is consumed immediately and removed with
  `history.replaceState`; the capability is sent only in the first WebSocket
  authentication message. Treat the full launch URL as exposed to Attendee's
  control plane and redact it from application/provider-visible logs and errors.
- Store only a capability hash and compare in constant time. Validate exact
  same-origin `Origin`; impose unauthenticated timeout, expiry, replay rejection,
  message size/rate/queue bounds, and no pre-auth state delivery.
- Use `Cache-Control: no-store` for bootstrap HTML/JS during the experiment, a
  restrictive CSP, no third-party origin, no service worker, no storage, no
  source map, no raw transcript/PCM/meeting URL/internal credential, and an exact
  path allowlist.
- Stop on credential reuse across sessions, secret appearance in URL query/log/
  telemetry/error/storage, unexpected egress, CSP relaxation, unbounded input,
  or any page access to Agent Core.

### Operations

- The experiment is explicit opt-in; missing/unknown values never silently
  select live or static after bot creation.
- Reload/replacement increments connection generation, closes the prior socket,
  clears both queues, starts closed, and sends only a current snapshot—never
  history.
- Visual overflow is recorded and fails the gate; it closes/coalesces current
  visual state and never backpressures Fish or `bot_output`.
- Stop on duplicate bots, duplicate audio, timer/socket/listener leaks, retry
  storms, audio interruption caused by page failure, stale generation mutation,
  or inability to prove remote cleanup.

### Rights

- Caty art and embedded textures are prohibited; repository history and hashes
  prove identity, not permission.
- Each L1 file needs origin, immutable source, source/destination SHA-256,
  transformations, creator/rightsholder, public-display, redistribution,
  modification, likeness status, approver, and date.
- Generated synthetic art must record model/tool, inputs or reproducible
  generation record, applicable terms, human approval, and confirmation that it
  depicts no identifiable person.
- Stop before copying into `public/` if any field or approval is missing. License
  notices cannot substitute for image or likeness rights.

## Conditions that make the issue acceptable

The issue is acceptable only when its body:

1. states that static remains the sole production-qualified default;
2. labels H as a hosted hypothesis, not an Attendee guarantee;
3. makes M0, H0, and L1 separate source-scope checkpoints;
4. records that a hard-gate failure is a successful falsification outcome;
5. contains the fifteen-path ceiling and all forbidden scope explicitly;
6. freezes baseline and acceptance limits before candidate results;
7. requires synchronized observer media rather than server/page timestamps as
   end-to-end proof;
8. requires the epoch on PCM and cancel, not only an uncorrelated cancel event;
9. includes the security, operations, and rights stops above; and
10. names a human approver for each milestone expansion.

## Exact issue title

> Experiment: prove hosted Attendee Hybrid H, then conditionally add deterministic L1 frame lip sync

## Binding decision

1. Create exactly one experiment issue now; this does not authorize immediate renderer implementation.
2. M0 may only lock current behavior and prove a semantic-neutral authoritative PCM/cancel output epoch.
3. H0 must prove one hosted bot, one audible owner, a truly audio-free page, bounded observer A/V behavior, and safe lifecycle failure.
4. Only a recorded M0/H0/security/baseline/rights pass unlocks deterministic three-frame L1; L2, A fallback, WebGL, Caty, and LiveAvatar remain out.
5. Any hard-gate failure closes or returns the issue to council review while static remains the sole production-qualified path.
