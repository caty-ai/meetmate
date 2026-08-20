# Local renderer implementation evidence

Date: 2026-07-23  
Purpose: shared evidence for a second five-role council; no implementation approval

## Question

Can Meetmate reuse the Caty Phone frame-avatar and pseudo-2.5D WebRig technology
as the smallest local lip-sync implementation, while preserving current static
mode, Fish Audio, Agent Core, gateways, Soniox, and meeting quality?

## Frozen boundaries

- Current static-image path remains byte/behavior compatible and the default.
- Agent Core, identity, memory, skills, tools, OpenClaw/Hermes/Claude gateways,
  Soniox, and Fish configuration are unchanged.
- One Fish generation and exactly one audible meeting output per utterance.
- No vendor renderer is part of the first local-renderer implementation.
- No production implementation is authorized by this council. The output is a
  reviewed minimal module specification and a GitHub implementation issue.
- No generic provider/plugin/DI/lifecycle framework.
- A live renderer may proceed only after the avatar-free Attendee webpage carrier
  passes its baseline-derived audio and stability gates.

## Meetmate evidence

Current main at `cf1642d166eb2eb1d101a75c5b79382118436fcc`:

- `src/transport-meet/meet-routes.js:1206-1219` creates the current static bot with
  Attendee realtime audio and an optional static `bot_image`.
- `src/transport-meet/meet-routes.js:1319-1329` sends Fish PCM through
  `realtime_audio.bot_output`.
- `src/transport-meet/meet-routes.js:1376-1404` receives mixed meeting audio and
  applies the echo gate.
- `src/tts-fish.js` returns raw mono PCM; current default is 24 kHz S2-Pro.
- `src/pipeline.js:2207-2227` generates Fish audio once and emits it through the
  existing `onAudio` boundary.
- Current cancel/barge-in/exit behavior is already product-sensitive and must not
  be rewritten for an avatar.

Issue #62 contains measured user evidence:

- 24 kHz made meeting audio “much better”;
- start-of-speech and mid-response cuts remained in the 2026-07-03 run;
- no abort, barge-in, TTS stall, duration cap, or gateway error explained them;
- Attendee/Meet VAD, jitter/resampling, zero-silence, and codec behavior remain
  candidate causes.

This makes the current static meeting path the quality baseline and makes an
avatar-free webpage carrier test a hard prerequisite.

## Attendee carrier contract

Official Voice Agent documentation states that `voice_agent_settings.url` loads a
public HTTPS page, meeting audio is exposed as page microphone input, and page
audio/video are captured into the meeting at a 1280×720 viewport.

Unknowns to measure:

- actual browser `AudioContext.sampleRate`;
- autoplay and suspended/resumed states;
- resampling and codec boundaries;
- page scheduling/capture quality;
- whether Voice Agent and realtime-audio settings can coexist safely;
- cancel/reconnect/page-reload behavior;
- CPU/memory/thermal headroom on the target Mac mini.

The official `output_video` contract accepts an HTTPS MP4 URL, not a continuous
live canvas/video stream, so the local renderer must be displayed in the captured
Voice Agent page.

### Hybrid evidence from current Attendee open source

The current public Attendee source at commit
`ba74253c3c27a10bc10c5ded67a34eddc82b915d` provides stronger—but not yet
hosted-runtime—evidence for a hybrid:

- the bot creation serializer exposes and validates `voice_agent_settings` and
  `websocket_settings` independently and contains no visible mutual-exclusion
  validation between them;
- `BotController` independently creates `BotWebsocketClientManager` when realtime
  audio is configured and `WebpageStreamerManager` when a voice-agent URL reserves
  resources;
- the webpage stream is selected as the webcam destination while realtime
  `bot_output` continues through `RealtimeAudioOutputManager`.

This makes the preferred experiment:

**Hybrid H** — keep current `websocket_settings.audio` as the sole audible
meeting input/output and add a silent `voice_agent_settings.url` page for video.

It is still not a proven hosted API guarantee. The docs show the two modes
separately, there is no reviewed upstream test that exercises both together, the
hosted version/config may differ, and a “silent” webpage may still expose an audio
track that interacts with meeting mixing. H therefore requires:

1. vendor confirmation or a minimal sandbox bot payload containing both settings;
2. proof that the page emits no audible samples and the observer sees exactly one
   waveform;
3. confirmation that page failure cannot stop/replace/replay current realtime
   audio;
4. Google Meet first, then Zoom web-adapter verification if Zoom is claimed.

If H fails, do not silently fall back to the full-page audio architecture in the
same implementation issue; return to a new decision because that alternative
changes the proven audio path.

## Caty Phone frame renderer evidence

Source repo: `<local Caty repo checkout>`

`CatyController.swift:2429-2513`:

- samples `AVAudioPlayer.averagePower` every 60 ms;
- maps dB to discrete mouth levels;
- maps `-50...-10 dB` to a continuous `0...1` speech envelope;
- binds the envelope to member and utterance IDs;
- clears it on stop.

`FrameAvatarView.swift:34-63`:

- maps mouth levels to `idle`, `talk1`, `talk2`, and `talk3`;
- uses `blink` or `talk_blink` during blinking;
- uses `listen` while listening;
- mouth thresholds are `0.2` and `0.7`.

Frame slots generated by the Caty toolchain are:

`icon`, `idle`, `talk1`, `talk2`, `talk3`, `blink`, `talk_blink`, `listen`.

## Caty pseudo-2.5D WebRig evidence

`webrig/index.html`:

- accepts `{mouthOpen, isBlinking, activity, ts}`;
- retains at most 24 timestamped samples;
- samples the envelope 80 ms behind its mapped source clock and interpolates;
- applies mouth attack/decay, voiced hysteresis, bounded syllable variation, and
  shape blending;
- adds local blink, breathing, head, body, and eye motion;
- exposes `window.rig.setAvatarState`, `start`, `stop`, and `getStats`;
- uses `requestAnimationFrame` and WebGL.

`docs/rig-real-caty.md`:

- builds a Caty rig from aligned `base`, `open`, and `blink` PNGs;
- extracts `mouth_close`, `mouth_open`, and eye patches;
- packages embedded textures for an offline browser runtime;
- explicitly describes this as grid warp/layer fade pseudo-2.5D, not Live2D;
- currently has two mouth poses; `edit-half.png` is not used.

`webrig/NOTICE.md`:

- the runtime vendors the MIT-licensed Anime2.5DRig runtime by hakoniwa / 852wa;
- any reuse must preserve the required license/notice attribution and identify
  which copied/adapted files remain derived from it.

## What “reuse” may mean

Do not import SwiftUI/iOS application code into Meetmate. Candidate reusable pieces:

1. the behavioral formula for RMS/dB to a normalized envelope;
2. the minimal timestamped state contract;
3. the frame assets and frame-selection semantics;
4. the browser-native WebRig runtime and baked Caty rig, with attribution;
5. the existing rig-generation tools as an offline asset pipeline, not a runtime
   dependency.

The council must decide whether code should be copied with provenance, adapted into
a smaller Meetmate-specific page, or consumed as a versioned generated asset. It
must not invent a shared cross-repository package unless current evidence requires
one.

## Audio-clock requirement

“Hz-driven mouth movement” is ambiguous. For the minimum implementation:

- mouth opening should be driven by short-window PCM energy/RMS, not dominant
  frequency;
- the envelope must be derived from the same Fish PCM samples that become audible;
- state timing must follow scheduled playback/sample position, not websocket
  arrival time;
- renderer state must close immediately on cancel epoch and may never replay an
  old utterance after reconnect.

Dominant-frequency heuristics are not a reliable Japanese viseme classifier.
Phoneme/viseme timing is a later, separately justified enhancement only if amplitude
lip sync fails a predeclared visual floor.

## Candidate implementation levels to compare

### L0 — deterministic carrier marker

No avatar. Frozen PCM plus a visual flash tied to sample position. Falsifies the
Attendee webpage audio/video carrier before renderer work.

### L1 — three/four-frame local lip sync

Idle/closed, half-open, open, and optional blink/talk-blink frames. PCM energy drives
discrete state. This is the smallest real avatar candidate.

### L2 — Caty pseudo-2.5D WebRig

Same PCM envelope and state contract, with local WebGL interpolation, blink,
breathing, and layer deformation. It should be a renderer swap after L1 evidence,
not a separate media architecture.

### L3 — LiveAvatar LITE

Still a later managed challenger. Not part of the first local implementation issue.

## Council questions

Each role must answer:

1. Is L1 or L2 the smallest implementation that produces useful product evidence?
2. Must L1 precede L2, or can one bounded implementation contain both as renderer
   fixtures without adding framework overhead?
3. Where should RMS/envelope extraction run, and how is it tied to the browser audio
   clock without reintroducing the historical chunk-scheduling failure?
4. What are the exact runtime modules/files and their one-sentence responsibilities?
5. What existing static/core files require thin wiring, if any?
6. What Caty code/assets are copied, adapted, or referenced, and how is provenance
   preserved?
7. What unit, browser, carrier, 30-minute, cancel, reconnect, and static-regression
   tests are mandatory?
8. What immediate-stop conditions prevent proceeding from L0 to L1 or L1 to L2?
9. Does the proposal avoid abstractions built only for future LiveAvatar/Recall?
10. Is the proposal ready to become one implementation issue? Vote yes/no and state
    prerequisites.
