# Local Renderer Council Round 1 — Caty Asset / Browser Architecture

Role: Local Renderer / Caty Asset Architect  
Date: 2026-07-23  
Evidence boundary: `00-evidence-pack.md`, `02-council-decision.md`, `04-comparison-poc-spec.md`, `08-local-renderer-evidence.md`, and the cited Caty source/assets only. No other `council-local/round1` proposal was read.  
Caty source inspected: `/path/to/workspace/project` at `4d56cb926763edc56ef8b9c387f198ad0b94a844` (relevant tracked files clean; unrelated worktrees/scratch files exist).

## Position

Use **L1 as the smallest real avatar, deterministic test fixture, and runtime fallback; admit L2 as an explicit renderer mode inside the same bounded PoC only after L1’s media contract passes.** L1 must precede L2 in test order, but it does not need a separate framework, issue, configuration system, or long-lived phase.

The renderer choice is secondary to the Attendee carrier choice:

- **Hybrid H:** keep current `websocket_settings.audio` as the sole meeting input/output; add `voice_agent_settings.url` only for a silent local-renderer video page. This best preserves current 24 kHz meeting audio **if and only if** Attendee officially or in sandbox proves both settings coexist, the page is truly silent, exactly one audible owner exists, and lifecycle/cancel are safe.
- **Full-page A:** the Voice Agent page owns meeting audio and video. This gives the renderer the best shared browser playback clock, but replaces the current proven WebSocket output with Web Audio → page capture → WebRTC/meeting encoding.

Current Attendee open source at `ba74253c3c27a10bc10c5ded67a34eddc82b915d` makes H more than a paper topology: the serializer handles both settings independently, `BotController` can create both `BotWebsocketClientManager` and `WebpageStreamerManager`, the webpage is selected as the webcam source, and realtime `bot_output` remains under `RealtimeAudioOutputManager`. This is strong implementation evidence, but not a hosted API guarantee: the docs remain separate, no reviewed upstream combined test was found, hosted version/config may differ, and a “silent” page can still affect meeting mixing.

H is therefore the **preferred and only carrier authorized by this local-renderer issue after its sandbox gate**. If H fails, stop and return to a new decision; do not silently substitute full-page A in the same issue. A changes the proven input/output path and deserves separate authorization. No renderer work may hide a carrier failure.

## L1 versus L2

| Dimension | L1 frame renderer | L2 pseudo-2.5D WebRig |
|---|---|---|
| Visual value | Clear speaking/idle/blink state; deliberately simple and diagnosable | More presence from interpolation, breathing, blink, head/body/eye motion, grid warp, and mouth shape blending |
| Mouth source | Same normalized PCM-energy envelope, discretized at `<0.2`, `<0.7`, otherwise open | Same envelope; continuous attack/decay, voiced hysteresis, bounded syllable variation, shape blending |
| Browser surface | `<canvas>` or `<img>` frame swap; no WebGL required | WebGL + `requestAnimationFrame`; 20 baked layers in current rig |
| Timing | Direct sample-position state; no renderer look-behind required | Existing runtime samples timestamped state about 80 ms behind source clock and stores at most 24 samples |
| Failure behavior | Deterministic idle/closed fallback | WebGL unavailable/context lost, shader/texture load failure, rAF throttling, DPR/memory/CPU/GPU pressure |
| Asset size/shape | Four aligned Caty frames are sufficient: closed, half, open, blink | Current embedded `rig.caty.js` is about 1.9 MB; generated from base/open/blink and currently has only two authored mouth poses |
| Attendee suitability | Best carrier/control probe at 1280×720; lowest render load | Plausible but unmeasured in Attendee container; must prove WebGL availability, stable frame rate, capture, and context recovery |
| Provenance burden | Caty image rights/provenance only; Swift behavior is reimplemented, not copied | Caty image rights plus MIT Anime2.5DRig runtime LICENSE/NOTICE and derived-file disclosure |

L2 is not Live2D and must not be described as such. It is a grid-warp/layer-fade pseudo-2.5D renderer whose current Caty rig uses `mouth_close` and `mouth_open`; `edit-half.png` is not part of the baked rig. L1 therefore has a genuinely different diagnostic advantage: its three mouth openings directly expose the energy thresholds without WebGL interpolation or invented syllable motion.

## 1. Is L1 or L2 the smallest implementation that produces useful product evidence?

**Answer: L1.** L0 remains the carrier falsification marker, but L1 is the smallest implementation that answers the product question “does a visibly speaking Caty participant add useful presence?” It can use four Caty assets:

```text
edit-closed.png -> idle/closed
edit-half.png   -> talk1/half-open
edit-open.png   -> talk2/open
edit-blink.png  -> blink
```

The Caty Phone behavior in `FrameAvatarView.swift:34-63` provides the semantics—closed below `0.2`, half below `0.7`, open otherwise, with blink handling—but SwiftUI/iOS code is not copied. The browser implementation should be a small original frame-selection function.

L2 provides more visual value only if observer review sees a meaningful improvement over L1. Its interpolation, idle movement, and shape variation can look more alive, but can also make mouth motion less faithful to amplitude and add 80 ms renderer look-behind. It is not the smallest evidence source.

**Test.** Run blinded observer clips of static, L1, and L2 using identical PCM and carrier capture. Ask separately about “obviously speaking,” perceived sync, naturalness, distraction, and identity consistency.

**Hard stop.** If L0 fails carrier audio/stability, implement neither. If stakeholders say a local non-photorealistic avatar can never ship, retain L1 only as instrumentation and do not productize asset systems.

## 2. Must L1 precede L2, or can one bounded implementation contain both as renderer fixtures without adding framework overhead?

**Answer: both statements are true at different levels.** L1 must precede L2 as a behavioral and failure-isolation gate, but both belong in one bounded PoC and one page. Use an explicit experiment constant/query such as `renderer=l1|l2`, not a provider registry or base-class hierarchy.

L1 is also L2’s runtime visual fallback. If WebGL initialization, shader/texture loading, or context restoration fails, keep the same page/session/audio owner and switch only the visual stage to L1 closed/current mouth state. Do not reload the page, recreate the bot, restart audio, or replay queued PCM. Existing Caty WebRig attempts WebGL restoration; Meetmate should additionally make visual fallback explicit because meeting audio must survive renderer loss.

This fallback is safe only because both renderers consume the same small state:

```text
{ generation, turnId, sampleIndex, mouthOpen, activity, isBlinking, sourceTime }
```

It is not evidence for a generic avatar abstraction.

**Test.** Run one session that switches L1→L2 during silence, injects WebGL context loss during speech, falls back L2→L1 without audio interruption, and rejects old-generation states after reconnect.

**Hard stop.** Do not enable L2 if L1 cannot deterministically close on cancel, if mode switching alters the audio graph, or if fallback requires page/bot recreation.

## 3. Where should RMS/envelope extraction run, and how is it tied to the browser audio clock without reintroducing the historical chunk-scheduling failure?

**Answer: compute short-window RMS in the page AudioWorklet/ring-buffer path from the exact Fish sample sequence being scheduled, and emit mouth state by rendered sample position—not WebSocket arrival.**

Use the Caty formula as behavior, not copied Swift:

```text
rms = sqrt(mean(s16_normalized²))
db = 20 * log10(max(rms, epsilon))
mouthOpen = clamp((db - (-50)) / 40, 0, 1)
```

The Caty Phone’s 60 ms meter is evidence for a workable cadence, not a required browser timer. The browser should aggregate audio render quanta into a predeclared short window, stamp its first/last sample indices, and update the renderer when the corresponding playback position is reached. Do not schedule one `AudioBufferSourceNode` per network chunk.

Carrier-specific clock treatment:

- **H, authorized target:** the current Attendee WebSocket PCM remains the only audible output. The page consumes the tee only in a silent analysis clock and aligns by source sample index/time. This does **not** prove it shares Attendee’s remote playout clock; observer-side A/V skew is mandatory. If a zero-gain destination connection is needed to keep the worklet clock running, it still must prove zero captured audible output; a muted node is not evidence by itself.
- **A, comparison only:** the worklet’s output would be the sole page audio captured by Attendee, so envelope and mouth state could share the actual scheduled playback sample clock. That synchronization advantage comes at the cost of replacing current audio and is outside this local issue unless separately approved.

Cancel increments the epoch, purges the local analysis/playout queue, sets `mouthOpen=0`, and rejects late samples. Reconnect never reuses queued old-generation PCM.

**Tests.** Unit-test silence, sine waves at known amplitude, clipping, odd chunks, rate/chunk boundaries, attack/decay, threshold crossings, and cancel. Browser-test cumulative rendered samples, actual `AudioContext.sampleRate`, underruns, and state timestamps.

**Hard stop.** Stop if state is driven by arrival time, dominant frequency, wall-clock timers disconnected from sample position, an unbounded queue, or per-network-chunk source scheduling.

## 4. What are the exact runtime modules/files and their one-sentence responsibilities?

Proposed minimal paths for the future issue:

1. `src/transport-meet/meet-live-local.js` — live-only H bot construction, ephemeral page session, one Fish PCM tee, generation/cancel/close, and enforcement that current realtime WebSocket remains the sole audio owner.
2. `public/meet-live-local/index.html` — 1280×720 Attendee page composition, explicit `l1|l2` visual selection, visual fallback, and media/renderer telemetry.
3. `public/meet-live-local/audio-worklet.js` — bounded silent PCM analysis clock, RMS envelope, sample-position/underrun counters, and no audible page output.
4. `public/meet-live-local/frame-renderer.js` — original L1 four-frame mapping, blink, idle/closed cancel behavior, and deterministic frame timestamps.
5. `public/meet-live-local/caty-webrig.js` — reduced/adapted MIT-derived L2 runtime exposing only init/state/render/stop/stats/context-loss behavior.

Versioned assets:

```text
public/meet-live-local/assets/caty-l1/{closed,half,open,blink}.png
public/meet-live-local/assets/caty-l2/rig.caty.js
public/meet-live-local/assets/caty-l2/manifest.json
public/meet-live-local/vendor/anime25d/LICENSE
public/meet-live-local/vendor/anime25d/NOTICE
```

The manifest records file hashes, Caty source commit, generator commands/version, image-rights owner/approval, and which runtime file is MIT-derived. Do not ship both the 1.9 MB embedded JS and duplicate embedded JSON unless a test proves both are needed.

This is five runtime files plus immutable assets, not five framework layers. L0 uses files 1–3 with deterministic flashes; L1 adds file 4/assets; L2 adds file 5/rig asset. Full-page A would require a different audible worklet/carrier decision and is intentionally not generalized into these files.

**Hard stop.** Add no module for an unnamed future renderer. If a responsibility cannot be stated without “provider,” “plugin,” “registry,” or “future,” it is outside this issue.

## 5. What existing static/core files require thin wiring, if any?

Only `src/transport-meet/meet-routes.js` should require thin experiment wiring:

- select static versus H **before** bot payload creation;
- keep the existing static payload/image block byte-for-byte and behavior-compatible;
- in live mode only, hand bot construction and page session to `meet-live-local.js`;
- tee the existing one Fish `onAudio` stream to the selected sole meeting-audio owner and the local renderer analysis branch;
- forward authoritative end/cancel/leave without changing their Agent Core meaning.

No changes belong in `src/pipeline.js`, `src/tts-fish.js`, gateway providers, Soniox, memory/LCM, skills/tools, agent profile resolution, or the config schema in this first issue. Static mode must not import/init live assets, validate live-only variables, start timers, or call the page.

H and A differ architecturally and must never be toggled within one bot generation:

| Mode | Meeting audio owner | Page audio | Renderer video |
|---|---|---|---|
| H — this issue | existing Attendee realtime WebSocket | provably silent analysis only | L1 or L2 |
| A — separate decision | Attendee-captured page AudioWorklet | sole audible page path | L1 or L2 |

**Test.** Snapshot the serialized static payload and full lifecycle with live credentials absent and live endpoints blackholed. Assert no live import/network/timer in static mode.

**Hard stop.** Reject wiring that enables both existing WebSocket output and audible page output, mutates the static payload block, or introduces live requirements at startup.

## 6. What Caty code/assets are copied, adapted, or referenced, and how is provenance preserved?

### Adapt, do not copy

- `CatyController.swift:2429-2513`: reimplement its `-50…-10 dB → 0…1` envelope behavior and reset-on-stop semantics in JavaScript; do not copy Swift controller/session code.
- `FrameAvatarView.swift:34-63`: reimplement only the frame thresholds/state semantics; do not copy SwiftUI, `AssetResolver`, layout, settings, or iOS lifecycle.
- `webrig/index.html`: extract and reduce only the WebGL rig render/state/context-loss portions needed by L2. Remove sample-rig switching, `localStorage`, WKWebView message handlers, iOS composition settings not used by the 1280×720 page, and any behavior not justified by the PoC.

### Copy as versioned Caty assets

- L1: `firmware-assets/caty-mouth-draft/edit-closed.png`, `edit-half.png`, `edit-open.png`, `edit-blink.png`, renamed in the package with source hashes.
- L2: generated `webrig/rig.caty.js` embedded asset only, plus a manifest. Regenerate offline from aligned closed/open/blink sources if the checked-in output cannot be legally/operationally consumed.

### Reference as offline tooling; do not import into runtime

- `tools/rig-from-frames` and `tools/rig-preprocess`;
- `docs/rig-real-caty.md` regeneration commands/config;
- `tools/rig-pipeline` security/determinism work where a future asset rebuild is needed.

Do not add their Node packages, `ag-psd`, PSD parsing, generator CLI, test fixtures, MediaPipe/camera/microphone code, Caty gateway/avatar engine, iOS application code, sample avatar, or the entire WebRig repo to Meetmate runtime.

### Provenance

The WebRig runtime is derived from Anime2.5DRig by hakoniwa / 852wa under MIT. Copy the full `webrig/LICENSE` and `webrig/NOTICE.md`, retain copyright/permission text, identify `caty-webrig.js` as adapted derived code, record upstream origin and Caty source commit, and preserve notices in distributed source/artifacts. The generated Caty image/rig data is not made MIT merely by using the MIT runtime; document its separate ownership/consent and allowed use.

Relevant Caty history includes the initial integration `ebcef51`, real Caty rig generation `23c71d0`, frame/fullscreen mode `a45e9ae`, and current inspected tree `4d56cb9`. These identify provenance; they do not replace the LICENSE/NOTICE.

**Tests.** CI/package test verifies asset hashes, manifest completeness, LICENSE/NOTICE presence, no network fetch/CDN, and deterministic offline rig regeneration when invoked separately.

**Hard stop.** Do not copy any L2 runtime without MIT notice; do not publish Caty likeness assets without explicit rights confirmation; do not claim generated rig assets inherit the runtime license.

## 7. What unit, browser, carrier, 30-minute, cancel, reconnect, and static-regression tests are mandatory?

### Unit

- PCM RMS/dB normalization; threshold states; silence/zero/clip/odd chunks;
- source sample indices, queue bounds, actual-rate conversion accounting;
- end/cancel closes mouth and purges the epoch;
- late/reordered/duplicate old-generation state rejection;
- H enforces current realtime WebSocket as the immutable sole audio owner and contains no hidden A-style audible page branch;
- L1 frame choice and L2 state normalization/24-sample cap.

### Browser

- L0 flash, L1, and L2 under the same fixtures at 1280×720;
- L1 asset missing/corrupt fallback to a safe closed placeholder;
- L2 WebGL unavailable, shader/texture failure, explicit context loss/restore, fallback to L1 without page/audio restart;
- `requestAnimationFrame` slowdown/background/hidden-page behavior;
- actual AudioContext state/rate, ring-buffer underrun/overrun, DPR, FPS, event-loop lag, memory, and WebGL errors;
- zero CDN/network dependency after page load.

### Carrier H versus A

- H has open-source implementation support at Attendee `ba74253`, but still needs vendor confirmation or a minimal hosted sandbox payload containing both settings;
- assert the H page contributes zero audible samples while current realtime input/output remains singular, and that page failure cannot stop, replace, or replay realtime audio;
- A’s theoretical advantage is a shared page playback/visual clock; its cost is replacement of current audio. Compare against A only if A has been separately approved and measured;
- never average H and A results, switch modes in one bot, or fall back H→A automatically.

### Thirty-minute and observer

Run static, carrier L0, L1, and qualifying L2 using the frozen scenario: Japanese short/long/rapid utterances, silence/noise, barge-in, cancel at initial/mid/final positions, two rapid turns, idle, reconnect, exit/leave, CPU/network contention. Record audio/video, CPU/memory/thermal slope, FPS, queue, underrun, frame timing, drift, bot count, and blind visual/audio ratings.

### Cancel and reconnect

- cancel-to-last-audible-sample and cancel-to-last-visible-mouth-frame;
- immediate mouth close without stale WebRig interpolation;
- reconnect increments generation and never replays old PCM/state;
- WebGL failure never restarts audio or creates another bot.

### Static regression

Byte-compare payload/image behavior and run greeting, turns, interruption, long response, reconnect, exit, and leave with all live assets/credentials missing and endpoints blackholed.

**Hard stop.** Any second TTS, second audible owner, duplicate bot, static dependency, stale turn replay, unbounded local queue, or Agent Core change fails regardless of visual quality.

## 8. What immediate-stop conditions prevent proceeding from L0 to L1 or L1 to L2?

### Stop L0 → L1

- static baseline is not repeatable or instrumentation changes it materially;
- H fails the hosted carrier audio/stability/observer gates;
- H coexistence is not officially/sandbox proven, page silence is not proven, or lifecycle creates ambiguity;
- A materially worsens baseline Fish audio, cancel, reconnect, echo, or resource budget;
- actual page clock/queue/observer evidence is insufficient to attribute faults;
- static isolation or one-audio ownership fails.

### Stop L1 → L2

- L1 cannot tie mouth state to rendered sample position, close on cancel, or reject old generations;
- local carrier/page CPU or memory already approaches the approved budget;
- Caty asset rights or package provenance are unresolved;
- WebGL is unavailable/unstable in the Attendee container;
- L2 context loss, asset failure, or fallback affects audio/page lifecycle;
- L2 adds material CPU/GPU/thermal, frame jitter, A/V skew, or cancel tail beyond the predeclared gate;
- blind review finds no meaningful visual gain over L1.

One exception: L1 missing the *visual naturalness* floor alone may justify testing L2, because L2 exists to improve motion. It does not waive audio, clock, cancel, provenance, carrier, or resource failures.

## 9. Does the proposal avoid abstractions built only for future LiveAvatar/Recall?

**Yes.** It has:

- one live-only server bridge;
- one concrete Attendee page;
- one audio worklet/sample clock;
- two explicit local render functions sharing a tiny state record;
- one test harness defined by the existing PoC specification.

It deliberately omits:

- `AvatarProvider`/renderer interfaces and dynamic registries;
- dependency injection/capability negotiation;
- common vendor configuration or lifecycle frameworks;
- LiveAvatar/Recall/Tavus fields, sessions, retries, billing, or health models;
- automatic carrier/provider failover;
- phoneme/viseme frameworks, dominant-frequency analysis, local ML, or Live2D;
- a cross-repository Caty package or new runtime dependency.

The shared state record exists because L1/L2 and tests need sample-clock comparability now, not because a future vendor might. If L3 is later authorized, it receives its own concrete adapter; common code is extracted only after observed duplicate semantics.

**Test.** Trace every proposed file and field to an L0/L1/L2 acceptance test. Delete anything with no current consumer/test.

**Hard stop.** Reject the issue if it introduces provider-neutral abstractions, config schema work, Agent Core changes, or a package whose justification is future L3/C.

## 10. Is the proposal ready to become one implementation issue? Vote yes/no and state prerequisites.

**Vote: YES, issue-ready; NO, not code-start-ready until prerequisites pass.**

One bounded issue can contain:

1. Gate 0 static evidence;
2. Gate 1 hosted Hybrid H validation with L0;
3. L1 implementation/control;
4. optional L2 implementation and explicit L1 fallback;
5. tests, provenance package, measurements, and stop decisions.

It must not promise that L2 will be reached or shipped. The issue closes successfully if a hard gate stops the sequence with retained evidence.

### Prerequisites before coding the local renderer

- approve baseline-derived thresholds and observer/test environment from `04-comparison-poc-spec.md`;
- record the `ba74253` open-source evidence and obtain Attendee confirmation or sandbox entitlement for simultaneous H settings; otherwise mark H unavailable rather than assuming;
- complete avatar-free H carrier testing and prove current realtime WebSocket is the sole input/output owner while the page is silent;
- confirm Caty likeness/image rights and MIT runtime notice/package plan;
- freeze Caty asset hashes and current source commit;
- state whether bounded non-photorealistic L1 could ship and what visual gain would justify L2;
- name the exact existing-file wiring and static regression owner.

### Issue hard boundaries

- no source work before Gate 1 passes;
- no L2 before L1 media/cancel/resource/provenance gates pass, except visual-naturalness-only escalation;
- no source edits outside the named live module/page/assets and thin `meet-routes.js` experiment wiring;
- no new dependency, config schema, README/release/deployment change, vendor renderer, or generic framework;
- static remains the default production architecture.

## Final recommendation

Treat L1 and L2 as two explicit visual implementations of one local sample-clock contract, not two architectures. Prove hosted H with L0 first. Implement L1 inside the same bounded issue as the mandatory control and fallback. Enable L2 only as a measured WebGL visual upgrade; if it cannot beat L1 without harming audio, resources, cancel, provenance, or lifecycle, ship neither—or retain L1 if it independently meets the product floor. If H fails, stop and request a new A decision rather than changing the audio architecture inside this issue.
