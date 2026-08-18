# Local Renderer Council Round 1 — Meeting Bot / WebRTC

Role: Meeting Bot / WebRTC Architect  
Date: 2026-07-23  
Scope: research/specification only; no source implementation

## Vote

**Yes: one implementation Issue is ready, but only as a staged experimental Issue for Hybrid H → L0 → L1.**

- **Hybrid H:** retain current `websocket_settings.audio` as the sole meeting input/output and add a silent `voice_agent_settings.url` page for video.
- **L0:** deterministic visual marker driven from the same Fish PCM sample timeline.
- **L1:** Caty three/four-frame amplitude lip sync.
- **L2:** not in the first Issue. It requires a later decision after L1 passes.
- **Full-page A:** not an automatic fallback. If H coexistence fails, stop and create a separately reviewed Issue because A changes both audio input and output.

This vote authorizes an implementation Issue, not production adoption.

## Why H is first

Issue #62 records that 24 kHz made meeting audio much better while start/mid-response cuts remained unexplained. That makes the current Attendee realtime-audio path the quality baseline, not a path to replace casually. Issue #69 asks for lip sync while retaining Fish, Attendee, the gateway, and the Mac mini.

Attendee open source at `ba74253c3c27a10bc10c5ded67a34eddc82b915d` independently validates `voice_agent_settings` and `websocket_settings`, constructs both managers when configured, selects webpage video as the webcam, and retains realtime bot output. This supports H, but does not prove hosted coexistence or silence. H must pass a sandbox observer test before renderer work.

## Composition comparison

| Composition | Meeting audio owner | Video owner | Clock consequence | Disposition |
|---|---|---|---|---|
| **H+L0** | Existing Attendee realtime WS | Silent Voice Agent page marker | Audio playout clock is not exposed; observer correlates current audio with page marker | First hard gate |
| **H+L1** | Existing Attendee realtime WS | Silent page frame renderer | Preserves current audio; visual timing uses source sample index plus measured page delay | First useful avatar |
| **H+L2** | Existing Attendee realtime WS | Silent page WebGL WebRig | Adds WebGL, internal 80 ms interpolation, CPU/context-loss and licensing risk | Later renderer swap |
| **A+L0/L1/L2** | Voice Agent page | Same page | Page AudioContext can own audio/video timing, but input capture, output playback, resampling and echo behavior all change | Separate decision if H fails |

H is preferred only if the hosted sandbox proves both settings coexist, the page contributes no audible samples, page failure does not disturb realtime audio, and observer evidence shows one bot/one waveform. Otherwise H is rejected, not “fixed” by silently moving to A.

## Lifecycle and ownership

For the experimental live endpoint:

```text
session created
  -> Attendee realtime WS ready
  -> silent visual page ready
  -> pipeline starts/greeting permitted
  -> active generation
  -> cancel/visual stop or page reconnect
  -> bot leave + page generation revoked
  -> closed
```

- Existing realtime WS remains the only Soniox input and Fish output owner.
- The page requests microphone permission as required by Attendee, but never connects that stream, an AudioContext, media element, or vendor track to an audible destination.
- Fish is generated once at `src/pipeline.js:2207-2227`. Existing `realtime_audio.bot_output` at `src/transport-meet/meet-routes.js:1319-1329` remains unchanged; a side tap derives visual state only.
- A page connection uses a short-lived per-session token and generation. Replacement invalidates the old generation and sends no historical state.
- Cancel closes the visual epoch immediately and prevents old mouth states reopening after reconnect.
- Page/render failure fails closed to idle/blank visuals while realtime audio continues only if the sandbox proved manager independence. It never creates a second bot or changes audio owner.
- Exit preserves the current fixed grace and single stored-bot leave. The Issue must not reinterpret playback drain.

## Clock ownership

### Hybrid H

Attendee realtime output owns audible playout; Meetmate cannot observe its final playback clock. The server derives RMS from the exact Fish PCM in 60 ms source windows across network-chunk boundaries, stamps cumulative sample index and send time, and sends only visual state to the page. The page maps the server clock to `performance.now()` and applies at most one predeclared visual delay from L0 observer measurements.

H passes only if observer-side signed A/V skew and drift remain inside baseline-derived gates. A fixed source clock is not proof of meeting playout alignment.

### Full-page A

The page AudioWorklet would own dequeued playback samples and derive RMS from the samples actually scheduled. It would also need microphone capture, 16 kHz input conversion, bounded output buffering and echo-gate integration. This is more measurable but recreates the historical browser audio failure class. It is outside the H Issue.

## Exact first-Issue files

### New runtime files

1. `src/transport-meet/local-avatar-session.js` — owns experimental page sessions, ephemeral token/generation, 60 ms PCM RMS windows, sample indices, clock sync, cancel/close, and visual-only WS messages.
2. `public/local-avatar.html` — fixed 1280×720 silent Voice Agent page with one image/canvas surface and no audible media graph.
3. `public/local-avatar.js` — performs page readiness/clock sync, rejects stale generations, renders L0 markers or L1 frames, and returns timing/health events.
4. `public/local-avatar/assets/caty/{idle,talk1,talk2,talk3,blink,talk_blink,listen}.png` — copied L1 frame fixtures.
5. `public/local-avatar/PROVENANCE.md` — records Caty source repository commit/path, asset hashes/rights, copied semantics, and confirms no Swift code was imported.

### Thin existing-file wiring

1. `src/server.js` — adds one dedicated `/local-avatar/stream` WebSocket upgrade route; static server behavior is otherwise unchanged.
2. `src/transport-meet/meet-routes.js` — adds a non-default experimental join path, H payload construction, page readiness gate, visual tap beside the unchanged realtime output, and page-session cleanup. Normal `/join-meeting` must execute the existing static payload path byte-for-byte.
3. `src/pipeline.js` — only if necessary, emits a media-only cancel notification adjacent to existing authoritative aborts. It must not change abort conditions, turn state, Fish generation, prompts, memory, tools, gateway behavior, or exit logic. No renderer/vendor import is allowed.

### New tests

1. `test/local-avatar-session.test.js` — RMS/window continuity, `-50...-10 dB` normalization, sample indices, generations, cancel and no reconnect replay.
2. `test/local-avatar-payload.test.js` — exact static payload snapshot plus H payload containing both settings and one realtime audio owner.
3. `test/local-avatar-static-isolation.test.js` — static startup/create/turn/exit with live credentials absent and live page DNS blackholed.
4. `test/local-avatar-page-contract.test.js` — page protocol, L0/L1 frame mapping, stale-generation rejection, idle-on-cancel and absence of audible elements/nodes.

Browser/carrier/30-minute evidence remains an operator test artifact; no Playwright or other dependency is added merely for this Issue.

## Caty reuse

- Do not import SwiftUI or `AVAudioPlayer` code.
- Adapt only the behavior: 60 ms energy sampling, dB `-50...-10` to `0...1`, L1 thresholds `0.2` and `0.7`, frame names, and reset-on-stop semantics.
- Copy the authorized Caty frame PNGs from the pinned Caty commit and record hashes/provenance.
- L2 later may copy/adapt `webrig/index.html`, baked `rig.caty.js/json`, and the offline-generated Caty rig. It must preserve `webrig/NOTICE.md` and MIT Anime2.5DRig attribution, identify derived files, and update distributable notice material.
- Do not copy the Caty rig-generation tools into Meetmate; they remain an offline source-asset pipeline.

## Mandatory tests

- **Unit:** chunk-boundary-independent RMS, silence/peak/clamp behavior, frame thresholds, monotonic samples, generation/cancel/close.
- **Browser:** 1280×720 load, immediate mic permission, no audible page output, L0/L1 timing, page reload, stale token/generation, console errors.
- **Carrier H0:** Google Meet sandbox with both settings; exactly one waveform; current mixed input and Fish output intact; page kill/reload does not stop or duplicate audio.
- **30-minute:** baseline, H+L0 and H+L1 with greeting, multiple turns, long Japanese response, Issue #62-style start/mid cuts, silence, interruption and exit; capture CPU/memory/thermal slope.
- **Cancel:** initial, middle and final-drain cancel; mouth closes within the predeclared bound and old epoch never reopens.
- **Reconnect:** page, realtime WS and server reconnect independently; one bot, one audio owner, no replay.
- **Static regression:** serialized payload/image behavior, greeting/turn/cancel/exit/leave parity, no live import/session/network/timer in normal mode.
- **Observer A/V:** signed p50/p95/max skew and drift, not “looks synced.”

Thresholds are set after the unchanged static baseline and before candidate labels/results are revealed.

## Immediate-stop conditions

### H/L0 stop

- hosted Attendee rejects or does not reliably start both settings;
- the page produces any audible copy or changes realtime input/output;
- page failure/reload stops, replaces or replays current audio;
- duplicate bot/audio, unbounded reconnect, stale generation or missing observer timestamps;
- current 24 kHz blind audio or Issue #62 cut behavior materially regresses;
- H A/V skew/drift cannot be bounded because the audio clock is inaccessible.

If H stops, do not implement Full-page A in the same Issue.

### L1 stop

- L0 carrier gates are not all passed;
- RMS derives from arrival time rather than source sample position;
- cancel does not close immediately or reconnect replays an old utterance;
- frame assets lack rights/provenance;
- CPU/memory/thermal or event-loop impact harms meeting audio;
- L1 fails the predeclared minimum visual floor.

### L2 stop

- L1 has not passed its 30-minute and visual gates;
- no product question remains that L2 can answer;
- WebGL unavailable/context loss is not fail-closed;
- WebRig’s 80 ms interpolation plus transport delay fails A/V gates;
- CPU/thermal regression, embedded texture/asset bloat, missing MIT notice, or no material blind visual improvement over L1.

## Answers to the 10 council questions

### 1. Is L1 or L2 the smallest useful implementation?

**L1.** L0 first falsifies H; L1 is the smallest real avatar that tests PCM-energy lip motion, visual acceptability, cancellation and resource cost. L2 adds presentation quality, not new meeting architecture evidence.

### 2. Must L1 precede L2?

**Yes.** They may share the same tiny visual-state message, but L2 should be a later renderer swap after L1 passes. Including WebGL/attribution/context-loss work in the first Issue adds scope before need is proven.

### 3. Where does RMS extraction run and how is it clocked?

For H, server-side in `local-avatar-session.js`, from the same Fish PCM sent to realtime output, in continuous 60 ms source-sample windows. The page schedules stamped states against a synchronized browser clock and L0-calibrated visual delay. Final audio clock is unobservable, so observer skew is a hard gate. For Full-page A, extraction belongs in the playback AudioWorklet at dequeue time, but A is a separate Issue.

### 4. What are the exact runtime modules/files?

The five new runtime/artifact files and three thin wiring files listed above are the ceiling. There is no provider registry, DI container, generic renderer interface or lifecycle framework.

### 5. What static/core files need wiring?

Only `server.js`, `meet-routes.js`, and—if no existing signal can represent cancel—an emission-only hook in `pipeline.js`. The normal static payload block, Fish synthesis, STT, gateway, memory, skills and tools remain behaviorally unchanged.

### 6. What Caty code/assets are reused?

Behavioral formulas and frame semantics are adapted; frame PNGs are copied from a pinned commit with hashes/rights; Swift code is not copied. WebRig runtime/rig/NOTICE are deferred to L2 and retain MIT provenance.

### 7. Which tests are mandatory?

All unit, browser, H0 carrier, 30-minute, cancel, reconnect, observer A/V and static-regression tests listed above. A local screenshot without observer audio/video is insufficient.

### 8. What stops L0→L1 or L1→L2?

Any H/L0 hard failure stops L1. Any L1 technical, resource, provenance or visual-floor failure stops L2. L2 additionally needs a declared product question and material visual benefit.

### 9. Does this avoid future-only abstractions?

**Yes.** It uses one concrete local session bridge and one page. L0/L1 are modes inside that page, not providers. LiveAvatar, Recall, Full-page A and generalized plugin contracts are absent.

### 10. Is one implementation Issue ready?

**Yes, with prerequisites:** the Issue title should be “PoC: Attendee Hybrid H carrier with L0 marker and L1 Caty frame lip sync.” It must require a sandbox H coexistence proof, frozen static baseline/threshold protocol, approved Caty asset provenance, and the exact stop rules above. Success means evidence, not production rollout. H failure closes the Issue without A fallback; L2 receives a separate Issue only after L1 passes.

## Adoption condition

No architecture is adopted from this Issue alone. H+L1 may advance to production design only after Google Meet and claimed Zoom runs show baseline-noninferior audio, one audible owner, bounded A/V skew/cancel/reconnect, acceptable visual quality and host resources, complete static isolation, and provenance compliance.
