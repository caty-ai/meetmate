# Round 3 — Meeting Bot / Media Integration Final Vote

Date: 2026-07-23  
Scope: final issue-shape decision only; no implementation

## Final position

**Draft one experiment issue now; do not start code merely because the issue
exists.**

The issue contains three source-gated milestones:

1. **M0 — current-behavior lock and minimum output-epoch/cancel observation**
2. **H0 — hosted Attendee Hybrid H coexistence and marker proof**
3. **L1 — conditional deterministic local frame lip sync**

Only M0 is eligible to begin after the pre-code prerequisites in this decision
are accepted. H0 source work waits for M0. L1 source and assets do not exist
until H0 and its security/cancel baselines pass.

Full-page A, L2, WebGL, Caty art/runtime, LiveAvatar, Recall, production rollout,
and same-meeting fallback are excluded.

## Changed view from Round 2

In Round 2 I voted for an H0-only issue and a separate later L1 issue. I now
accept one issue containing H0 and conditional L1.

The change is procedural, not architectural. Round 2 proposals 04 and 05
demonstrate that an issue can be a single falsification ledger without being a
single authorization to create all source:

- milestone-specific file ceilings make speculative renderer work reviewable;
- an H0 rejection is a successful issue outcome, not an incentive to continue;
- L1 files are forbidden until a retained H0 evidence artifact and named gate
  approval exist;
- one issue preserves the baseline, carrier, and conditional renderer evidence
  in one audit trail.

I retain the substantive Round 2 conclusions: H is unproved in the hosted
runtime, the current PCM callback is insufficient for authoritative
cancellation identity, L2 is premature, and A cannot be an automatic fallback.

## Repository evidence cross-check

| Claim or gate | Repository evidence | Consequence |
|---|---|---|
| Static Attendee audio is the current launch contract. | `src/transport-meet/meet-routes.js:1206-1219` constructs `websocket_settings.audio` and only optionally adds `bot_image`. | Static payload and default selection must be locked before adding H. |
| There is one current meeting-output send. | `meet-routes.js:1319-1329` converts each callback buffer once into `realtime_audio.bot_output` at `TTS_SAMPLE_RATE`. | The experiment may tee metadata/analysis beside this send but may not replace, delay, or duplicate it. |
| The current output callback lacks lifecycle identity. | `src/pipeline.js:489-494` documents `onAudio(buffer)`; `pipeline.js:2217-2226` passes only each Fish chunk. | An output epoch cannot be inferred from the callback. M0's additive seam is justified before L1. |
| The pipeline already owns abort authority and an event surface. | `pipeline.js:629-634`, `1316-1320`, `1456-1463`, and `2344-2349` abort current work; `pipeline.js:2382-2385` exposes its existing emitter. Timeout/delegation aborts also occur at `1720` and `1774`. | M0 may add an emission-only lifecycle fact, but must test exact-once behavior and must not rewrite abort or turn semantics. |
| Audio generation is already serialized. | `pipeline.js:499-502` serializes `speakSentence` calls through `ttsLock`; Fish audio reaches the one callback at `2217-2226`. | The epoch seam can observe the existing serialized path; it does not justify a second TTS or queue. |
| Meeting input and echo behavior are route-owned and sensitive. | `meet-routes.js:1376-1404` accepts `realtime_audio.mixed`, applies the echo gate, and calls `handler.send`. | Static and H0 tests must lock the same gate decisions and send counts. |
| Reconnect already replaces the active realtime connection. | `meet-routes.js:1290-1300` closes the previous client and handler; `1417-1429` closes the handler on current-client disconnect. | The visual connection needs its own generation and may not replace or replay the realtime-audio owner. |
| No new server upgrade layer is required. | `src/server.js:45-78` delegates HTTP to `meetRoutes.handleHttp`; `server.js:90-106` delegates every non-calibration upgrade to the existing Meet WebSocket server. | `src/server.js` is outside the file ceiling. Exact H routes can dispatch inside the existing route owners. |
| Public serving is already allowlist-based. | `src/transport-meet/meet-routes.js:920-924` calls `servePublicAsset`; `src/ui-routes.js:8-18` and `29-45` use an exact `PUBLIC_ASSETS` map and reject traversal. | Add only explicit H/L1 paths and security headers; do not add a recursive static server. |
| No current browser-test dependency exists. | `package.json` uses Node 22 `node --test` and has no Playwright/jsdom dependency. | Add no dependency. Node tests lock contracts; hosted Attendee plus synchronized observer capture is the actual-browser acceptance test. |
| H coexistence is source-supported but hosted-unproved. | `08-local-renderer-evidence.md:75-104` records independent Attendee managers at commit `ba74253...`, but no hosted combined test or guarantee. | Simultaneous `websocket_settings.audio` plus `voice_agent_settings.url` is an H0 result, never an assumption. |
| Existing audio is not a clean control. | `08-local-renderer-evidence.md:41-49` records Issue #62's remaining start/mid-response cuts despite the 24 kHz improvement. | H0 must compare cut incidence and observer audio with a frozen current-static baseline. Matching source bytes is insufficient. |
| The research contract already requires baseline-derived gates. | `04-comparison-poc-spec.md:26-70`, `106-183`, and `188-203` require the unchanged baseline, synchronized instrumentation, one waveform, cancel/reconnect/30-minute evidence, static isolation, and thresholds frozen before candidate results. | This final decision does not invent unmeasured millisecond or CPU limits; M0 freezes them from repeatable evidence. |

No gate below assumes Attendee queue admission, resampler position, WebRTC
packetization, or remote playout acknowledgement. H exposes source bytes, send
time, visual presentation time, and observer media. Only the observer can accept
end-to-end A/V behavior.

## A–F final vote

| Item | Final vote | Binding interpretation |
|---|---|---|
| **A — Draft one experiment issue now** | **YES** | Drafting is authorized. Code start is not. The issue is a falsification ledger and may close successfully at any hard stop. |
| **B — Keep H0 and conditional L1 in one issue** | **YES** | Source scope expands milestone by milestone. No L1 task, file, frame, calibration runtime, or acceptance run starts before recorded H0 approval. |
| **C — Keep L2 and the named alternatives out** | **YES** | No L2/WebGL/Caty art or runtime, Full-page A, LiveAvatar, Recall, generic provider/renderer surface, or same-meeting fallback appears even as dormant code. |
| **D — Make prerequisites executable gates** | **YES** | The issue names the evidence, owner, review checkpoint, and stop outcome for M0, H0, security, cancel, observer, and L1 entry. |
| **E — Enforce the exact minimal file ceiling** | **YES** | Maximum 11 touched files through M0/H0 and 16 only after H0 approves L1. No new dependency or server/config/framework file. |
| **F — Treat pass/stop gates as binding** | **YES** | A failed seam, hosted carrier, silence, one-owner, timing, security, lifecycle, resource, static, or L1 prerequisite closes or pauses the issue; it never widens architecture. |

## Exact issue title

> **Experiment: prove Attendee Hybrid H, then conditionally add deterministic L1 frame lip sync**

The issue must be labelled `experiment`, not feature, migration, or production
rollout.

## D — Prerequisites and milestone authorization

### Before any code starts

The issue may be drafted immediately, but M0 coding waits until:

1. the current commit and exact static 30-minute scenario are pinned;
2. the baseline fixture/observer manifest and threshold-freezing procedure from
   `04-comparison-poc-spec.md` are named;
3. one gate owner is named for M0 and one for hosted observer evidence;
4. M0's event semantics and the 16-file absolute ceiling are accepted;
5. the issue states that stop evidence is completion and that no same-meeting
   fallback is allowed.

These are specification prerequisites. They do not require Caty, a new vendor,
or a renderer implementation.

### Before H0 starts

M0 must have:

- locked the default payload and one existing `bot_output` send;
- locked mixed-input/echo, connection replacement, close, exit, and leave
  behavior;
- proved that static mode loads no local-avatar module, capability, page, timer,
  socket, or asset;
- produced a repeatable static observer baseline sufficient to freeze the H0
  audio, cancel-tail, A/V, resource, and 30-minute gates;
- either landed the minimum event seam below with exact tests or stopped with
  evidence that it cannot remain semantic-neutral.

### Before conditional L1 starts

All H0 pass evidence must be retained and approved. In addition:

- the public-page capability/CSP/cache/log/replay tests pass;
- the output epoch and cancel event pass onset, middle, final-drain, rapid
  cancel/new-output, reconnect, and close tests;
- a predeclared L1 visual acceptance floor exists;
- only newly created synthetic/non-personal frames are selected, with creator,
  public-display, redistribution, modification, source/destination hash, and
  transformation records;
- the PCM fixture set and calibration procedure are approved and frozen before
  blinded L1 results.

Caty art is not an alternative way to meet this prerequisite in this issue.

## M0 — minimum authoritative seam

M0 begins with tests. It may then add one additive, emission-only output lifecycle
contract in `pipeline.js`.

The minimum sufficient facts are:

```text
output_epoch_started({ outputEpoch, monotonicTime, sampleRate })
output_epoch_finished({ outputEpoch, monotonicTime })
playback_cancelled({ outputEpoch, reason, monotonicTime })
```

Rules:

- `outputEpoch` is opaque and monotonic within one handler.
- `started` occurs once when the first existing PCM byte for that epoch reaches
  the current `onAudio` path, not when an LLM request begins.
- `finished` occurs once only after the epoch's existing serialized audio has
  naturally drained from the local generation path.
- `playback_cancelled` occurs once only when an already-started output epoch is
  invalidated by an existing authoritative abort/close. An LLM timeout before
  any PCM does not invent a playback cancellation.
- Listener absence is a no-op. Listener exceptions are contained and cannot
  change abort order, Fish calls, `turnState`, dialogue, exit, or gateway logic.
- The raw `onAudio(Buffer)` signature and the existing `bot_output` send remain
  unchanged.
- Pipeline events contain no avatar state, renderer ID, page capability,
  transcript, prompt, meeting URL, profile, memory, or provider policy.
- `local-avatar-session.js`, not Agent Core, maps the lifecycle fact into visual
  connection generations and cancel epochs.

The names above may change during test design, but their facts and ordering may
not. If the existing ack/progress/main-response/greeting flows cannot be assigned
an exact epoch without changing their semantics, M0 stops for architecture
review. Polling `turnState`, waiting for silence, or treating WebSocket close as
utterance cancel is not an alternative.

## E — exact minimal file ceiling

### M0 + H0: maximum 11 touched files

| # | File | One responsibility |
|---:|---|---|
| 1 | `src/pipeline.js` | Emit only the tested output-epoch/cancel facts at existing authority points; no avatar dependency or semantic change. |
| 2 | `src/transport-meet/meet-routes.js` | Select the explicit non-default experiment, preserve the current realtime-audio payload/send/input owner, add the combined H payload, dispatch the exact visual socket, and close the visual session with meeting lifecycle. |
| 3 | `src/ui-routes.js` | Allowlist the exact page assets and apply their no-store/content-security headers; no catch-all serving. |
| 4 | `src/transport-meet/local-avatar-session.js` | Own one ephemeral visual capability, output/source sequence, connection generation, cancel epoch, bounded marker queue, stale rejection, close, and telemetry without importing Agent Core/Fish/Soniox/provider policy. |
| 5 | `public/local-avatar/index.html` | Fixed 1280×720 dependency-free marker page with no audio/media element or inline secret. |
| 6 | `public/local-avatar/local-avatar.js` | Authenticate the visual socket, render source-indexed H0 markers, reject stale state, fail closed, and report scheduled/presented diagnostics; create no audio graph. |
| 7 | `test/pipeline-playback-epoch.test.js` | Prove exact lifecycle ordering/counts and unchanged abort/output behavior for current abort, close, and natural-drain paths. |
| 8 | `test/local-avatar-session.test.js` | Prove capability, bounds, sequence, generation/epoch, reconnect, close, and no-replay contracts. |
| 9 | `test/local-avatar-page-contract.test.js` | Prove CSP/static page shape, absence of audio APIs/elements, deterministic marker state, stale rejection, and fail-closed behavior. |
| 10 | `test/local-avatar-static-regression.test.js` | Lock default serialized payload, PCM send, input/echo, reconnect/exit/leave, and zero live initialization. |
| 11 | `test/fixtures/local-avatar-timeline.json` | Freeze source transients, epoch/marker trace, and expected observer-correlation identifiers without secrets. |

`src/server.js` is explicitly excluded because it already dispatches the relevant
HTTP and WebSocket traffic. `package.json`, `src/config.js`, TTS, Soniox,
gateway, profiles, memory, skills, tools, and existing static image assets are
also excluded.

### Conditional L1: five additional files, maximum 16 total

Only after the H0 approval checkpoint:

| # | File | One responsibility |
|---:|---|---|
| 12 | `src/transport-meet/local-avatar-calibration.json` | Frozen experimental sample rate, fixture hashes, window/hop, normalization, thresholds, hysteresis, and attack/decay; not a general config surface. |
| 13 | `public/local-avatar/assets/closed.png` | Newly created synthetic/non-personal closed-mouth frame. |
| 14 | `public/local-avatar/assets/half.png` | Newly created synthetic/non-personal half-open frame. |
| 15 | `public/local-avatar/assets/open.png` | Newly created synthetic/non-personal open-mouth frame. |
| 16 | `public/local-avatar/assets/PROVENANCE.md` | Creator, permissions, source/destination hashes, transformations, and approval for the three synthetic frames. |

L1 modifies the already-counted session/page/tests and adds one concrete
closed/half/open mapping. It adds no blink asset, renderer module, provider
interface, registry, factory, DI layer, AudioWorklet, WebGL fallback, or new npm
dependency.

## F — hard pass and stop gates

### M0 pass gates

M0 passes only if:

- default static launch serializes without `voice_agent_settings` and preserves
  the current optional `bot_image`;
- every Fish buffer still produces exactly one identical `bot_output` payload at
  the current rate, with no delay or backpressure from an absent listener;
- `realtime_audio.mixed`, echo decisions, handler sends, connection replacement,
  explicit exit/leave, and close remain regression-equivalent;
- output epochs have exact start/finish/cancel ordering across greeting,
  acknowledgement/progress, main response, barge-in, wake-cancel, interruption,
  timeout-before-audio, rapid new output, reconnect, and handler close;
- the event listener is optional and failure-contained;
- the repeatable static baseline and observer artifacts are sufficient to freeze
  H0 thresholds before H0 results are seen.

**Stop M0** on any altered audio byte/send count, changed turn/abort behavior,
ambiguous epoch, duplicate/missing lifecycle fact, required avatar listener, or
non-local refactor.

### H0 pass gates

H0 passes only if the hosted target proves:

1. one Attendee bot accepts and sustains both `websocket_settings.audio` and
   `voice_agent_settings.url`;
2. realtime input/output remains the sole media owner and follows the current
   path;
3. the page creates no `AudioContext`, `AudioWorklet`, audio/media element,
   oscillator, media destination, microphone/output connection, or captured
   audio track;
4. synchronized observer capture detects exactly one waveform and no duplicate
   bot, correlated copy, comb filtering, level shift, or new gating;
5. page load, kill, reload, socket loss, auth expiry, and marker overflow cannot
   stop, replace, delay, backpressure, duplicate, or replay realtime audio;
6. current Issue #62 start/mid-cut distribution, continuity, response latency,
   cancel audio tail, input/echo, reconnect, exit, and leave do not fail any
   non-waived frozen baseline-derived gate;
7. repeated source transients and presented flashes produce observer-measured
   signed/absolute skew p50/p95/max and drift within the frozen gate after at
   most one predeclared fixed mapping;
8. cancel closes the marker before the declared visual bound, older epochs never
   redraw, reconnect starts closed, and no history is replayed;
9. the 30-minute CPU, memory, event-loop, thermal, page-frame, queue, reconnect,
   and orphan-resource evidence passes;
10. the short-lived, single-session capability is replay/rate/size/origin
    bounded, removed from page state, absent from logs/telemetry/storage, and
    served with no-store and restrictive CSP;
11. static isolation remains clean with the live page absent, invalid, and
    blackholed.

The URL capability is assumed visible to Attendee's control plane even when
placed in a fragment; it must never be durable or grant nonvisual authority.

**Stop H0** on hosted rejection/ambiguity, a page audio track or graph, a second
waveform/bot, page/audio-manager coupling, unstable observer mapping, stale
replay, credential leakage, unbounded retry/queue/resource use, non-waived
baseline regression, or static dependency.

H0 failure closes the issue with evidence. It does not create A, static fallback,
L1, a second bot, or a second audio owner in the same meeting. Google Meet is the
required first proof; no Zoom claim exists without the same gates.

### Conditional L1 pass gates

After H0 approval, L1 passes only if:

- RMS windows and source indices are invariant to Fish chunking and odd-byte
  splits over silence, comfort noise, known tones, clipped PCM, and frozen
  Japanese Fish fixtures;
- analysis geometry, normalization, thresholds, attack/decay, and hysteresis are
  fixture-derived and frozen before blinded results; Caty's 60 ms meter,
  `-50...-10 dB`, and `0.2/0.7` are not defaults;
- comfort noise never opens the mouth and identical PCM/epoch input produces an
  identical closed/half/open trace;
- cancel at onset, middle, final drain, and rapid cancel/new-output closes within
  the frozen visual bound and no old epoch/connection can reopen or close the
  newer output;
- delayed, reordered, duplicate, late, or overflow visual state fails closed or
  advances to a current snapshot; it never displays a known-stale mouth or
  backpressures audio;
- missing/corrupt frames fail visually closed without touching meeting audio;
- synchronized observer A/V, missed/extra transitions, blinded visual floor,
  page frame/long-task, CPU/memory/thermal, and 30-minute evidence pass without
  weakening H0;
- the three synthetic assets and manifest satisfy the recorded public-display
  and redistribution rights;
- static regression passes again with live endpoints unavailable.

**Stop L1** on nondeterminism, false silence openings, stale state, missing
rights, failed visual floor, audio/timing/resource regression, or any need for
L2, A, WebGL, Caty, LiveAvatar, Recall, a second audio path, or a generic
abstraction. A desire for richer visuals becomes a later decision, not scope
expansion.

## Five-line binding decision

1. **Draft now:** one experiment issue with the exact title above; drafting does not authorize code.
2. **Execute by gate:** M0 first, H0 only after M0 passes, and L1 files only after recorded H0/security/cancel approval.
3. **Preserve ownership:** static remains default; Hybrid H keeps the existing realtime WebSocket as the sole meeting input/output owner.
4. **Enforce scope:** sixteen touched files maximum; no Full-page A, L2, WebGL, Caty art/runtime, LiveAvatar, Recall, new dependency, framework, or same-meeting fallback.
5. **Stop honestly:** any hard-gate failure closes or pauses the experiment with evidence and never widens the media architecture.
