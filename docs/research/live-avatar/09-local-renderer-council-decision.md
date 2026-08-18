# Local renderer implementation council decision

Date: 2026-07-23

Status: issue-ready; not unconditionally code-ready

Parent: GitHub Issue #69

Related quality baseline: GitHub Issue #62

Created implementation experiment:
https://github.com/caty-ai/meetmate/issues/173

## Decision

Create one experiment issue with three strictly ordered milestones:

1. **M0 — behavior lock and output identity seam**
2. **H0 — hosted Attendee Hybrid H carrier with an audio-free L0 page**
3. **L1 — deterministic local three-state lip sync, only after H0 approval**

The current Attendee realtime WebSocket remains the only meeting-audio input and
output owner. The Voice Agent page is a video surface only. It must not create an
`AudioContext`, audio/media element, audio track, second TTS, second bot, or
fallback audio path.

Static image remains the default and the only production-qualified mode. The
experiment is explicit and non-default. A failed gate closes the experiment
with evidence; it does not expand scope.

## Council support

| Decision | Meeting bot | DSP | Renderer | Boundary | Skeptic |
|---|---:|---:|---:|---:|---:|
| Create one experiment issue now | Yes | Yes | Yes | Yes | Yes |
| Keep M0 → H0 → conditional L1 in one audit trail | Yes | Yes | Yes | Yes | Yes |
| Do not start L1 before recorded H0 approval | Yes | Yes | Yes | Yes | Yes |
| Exclude L2/WebGL, Full-page A, Caty art, LiveAvatar, and Recall | Yes | Yes | Yes | Yes | Yes |
| Keep static as the default and sole production path | Yes | Yes | Yes | Yes | Yes |
| Eleven touched paths maximum | Yes | Yes | Yes | Yes | Yes |

The file-ceiling tie-break is recorded in
`council-local/round3-06-chair-tiebreak.md`.

## Why this is the smallest responsible experiment

The current Fish Audio path is already the strongest part of Meetmate. Moving
audio into a browser page would reintroduce clocks, buffering, resampling, and
autoplay behavior before video feasibility is known.

Current Attendee open source shows separate realtime-audio and webpage-streamer
managers, but this does not prove that the hosted service accepts and safely
runs both settings together. H0 therefore proves coexistence before any mouth
renderer is built.

The mouth signal is short-window PCM energy, not “audio frequency.” Frequency
alone does not represent mouth opening. L1 reuses the same Fish PCM observation
as the meeting output, assigns continuous sample indices, and derives a
deterministic closed/half/open level without generating audio again.

## M0 contract

Before H0, regression tests lock:

- the normalized and serialized static Attendee payload;
- exactly one unchanged 24 kHz S16LE Fish `bot_output` per existing callback;
- mixed input, echo gate, greeting, turns, barge-in/cancel, reconnect, exit,
  leave, and delayed cleanup;
- absence of local-avatar module loads, capabilities, routes, sockets, timers,
  page reads, or network activity in static mode.

The minimum additive lifecycle fact must correlate PCM and cancellation:

```text
onAudio(buffer, {
  outputEpoch,
  firstSampleIndex,
  sampleRate
})

playback_cancelled({
  outputEpoch,
  reason,
  monotonicTime
})
```

The exact API shape may follow the existing emitter/callback style, but these
semantics are binding:

- `outputEpoch` is opaque, authoritative, and monotonic within one handler;
- every observed PCM chunk carries its epoch and continuous first sample index;
- every authoritative abort path invalidates the active epoch synchronously;
- late PCM or visual state from an invalidated epoch is rejected;
- absent or failing observers cannot change abort, turn, or audio behavior;
- the seam carries no avatar/provider/session secret or Agent Core state.

If this cannot be added without refactoring abort ownership or changing current
behavior, stop at M0.

## H0 contract

H0 adds `voice_agent_settings.url` only in the explicit experiment while keeping
the existing `websocket_settings.audio` payload unchanged.

The local page:

- is a fixed 1280×720 dependency-free Canvas page;
- produces deterministic sample-index markers only;
- has no audio API, audio/media element, track, service worker, storage, or
  third-party request;
- receives a 256-bit, short-lived, single-session visual capability;
- clears bootstrap material from browser history;
- uses exact path allowlisting, restrictive CSP, `Cache-Control: no-store`,
  bounded messages/queues/retries, constant-time capability comparison, and
  redacted logs;
- rejects stale connection generation, output epoch, cancel epoch, and sequence;
- closes visually and replays no history after cancel, reconnect, expiry, or
  page reload.

H0 is accepted only by hosted Attendee plus an independent synchronized observer.
PCM generation time, WebSocket send time, page `performance.now()`, or a muted
browser clock cannot substitute for observer evidence.

## Conditional L1 contract

L1 may start only after a linked H0 artifact is explicitly approved.

The extractor is fixed to:

- input: the same copied 24 kHz S16LE Fish PCM bytes used by the existing send;
- window: 480 samples / 20 ms;
- hop: 240 samples / 10 ms;
- preprocessing: `s16 / 32768`, remove each window mean;
- feature: RMS converted to dBFS;
- coordinate: continuous sample index inside `outputEpoch`;
- chunking: arbitrary Fish/WebSocket chunk boundaries do not change the trace.

Normalization, silence/noise thresholds, hysteresis, attack, and decay are not
guessed. They are calibrated on a frozen, hashed corpus and committed before
candidate/blinded results are opened.

The page draws original non-personal closed/half/open Canvas geometry. It does
not copy Caty images. Caty Phone's energy-to-mouth state technique is a
behavioral reference only. Blink, random syllables, WebGL, pseudo-2.5D, imported
art, renderer interfaces, registries, and provider abstractions are out.

## Exact eleven-path ceiling

M0 and H0 may touch paths 1–10:

1. `src/transport-meet/local-avatar-session.js`
2. `public/local-avatar/index.html`
3. `public/local-avatar/local-avatar.js`
4. `src/transport-meet/meet-routes.js`
5. `src/ui-routes.js`
6. `src/pipeline.js`
7. `test/local-avatar-session.test.js`
8. `test/local-avatar-page-contract.test.js`
9. `test/local-avatar-static-regression.test.js`
10. `test/fixtures/local-avatar-timeline.json`

Only after H0 approval may L1 add:

11. `src/transport-meet/local-avatar-calibration.json`

L1 edits the existing session/page/tests/fixture and adds no other file. Runtime
does not import from `test/`, which is excluded from the package artifact.

No dependency, `package.json`, lockfile, `src/server.js`, config schema, README,
Agent Core, Fish, Soniox, gateway, profile, memory, skill, tool, static image,
provider interface, DI container, or generic renderer framework may change.

## Hard pass and stop gates

Numeric thresholds are frozen from the repeated static baseline before candidate
results are revealed. Required evidence includes:

- source PCM hashes, byte/send counts, sample indices, callback gaps, clipping,
  and queue age;
- observer exactly-one-bot and exactly-one-waveform proof;
- start/mid-response cut incidence, response-to-first-audible-sample p50/p95,
  cancel-to-last-audible-sample p50/p95/max, and duration drift;
- repeated transient/marker signed and absolute A/V skew p50/p95/max, variance,
  and 30-minute drift;
- page FPS/frame intervals/long frames, CPU, memory slope, event-loop, thermal,
  queue, reconnect, listener/timer/socket, and orphan-resource results;
- page load, kill, reload, socket loss, capability expiry, wrong-origin,
  replay, oversize/rate-limit, cancel, reconnect, exit, and leave cases;
- blinded L1 usefulness/distraction result after calibration is frozen.

Stop on any:

- hosted rejection or ambiguous coexistence of both Attendee settings;
- second bot, audio owner, waveform, audio graph/track, or audible duplicate;
- changed static payload, audio bytes/send count, echo/cancel/turn/lifecycle;
- page failure that delays, stops, replaces, backpressures, duplicates, or
  replays realtime audio;
- unobservable or baseline-regressing A/V relationship;
- stale old-epoch reopen, unbounded queue/retry/resource growth, capability leak,
  unexpected egress, or weakened CSP/cache/auth;
- post-result DSP tuning, nondeterministic mouth trace, false silence openings,
  or failure of the predeclared visual floor;
- need for a twelfth path or an excluded architecture.

When H0 fails, close with its evidence. Do not add Full-page A or L1 code to the
same issue.

## Minority and resolved objections

- Two Round 2 reviewers preferred a separate H0-only issue. They accepted one
  issue only because source scope is milestone-gated and failure is a valid
  completed result.
- Initial Round 3 ceilings were 10, 15, and 16. Ten omitted a packaged runtime
  calibration artifact; 15/16 assumed image assets. The final 11-path solution
  ships calibration under `src/` and uses original Canvas geometry.
- Hybrid H remains an unproved hosted behavior. The council decision authorizes
  testing it, not claiming that it works.

## Binding decision

1. Create one experiment issue now.
2. Begin with behavior locks and the minimum authoritative output epoch seam.
3. Prove hosted, audio-free Hybrid H before creating any L1 runtime calibration.
4. Keep the current realtime audio path and static default unchanged.
5. Stop with evidence instead of widening to L2, Full-page A, vendor rendering,
   or additional files.
