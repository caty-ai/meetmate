# Failure Dossier — Recall.ai / HeyGen / Live Avatar Attempts

Date: 2026-07-23
Evidence rule: absent logs or recordings are recorded as **unknown**.

## 1. Proven facts

### Repository facts

1. `origin/feat/recall-ai` exists and was not merged into current main.
2. The branch progressed through:
   - design spec (`d2e8f77`);
   - Recall provider/browser bridge (`d3d86d7`);
   - getUserMedia input capture and manual downsampling (`b5fbff1`);
   - AudioWorklet capture (`0cd1e52`);
   - hybrid direct Recall input + browser output (`02ece31`);
   - required `audio_mixed_raw` enablement (`b9549f6`);
   - Fish S2-Pro change (`bbe1544`);
   - exact revert of that S2-Pro change (`de1d03e`).
3. The original browser output path converted S16 PCM to Float32, created one `AudioBuffer` per network chunk, and scheduled each source using a single `playCursor`.
4. No bounded jitter buffer, underrun counter, clipping counter, meeting playout timestamp, or A/V timestamp existed.
5. Browser input first used `ScriptProcessorNode(4096)`, then `AudioWorklet` with a 4096-sample flush, then was removed in favor of Recall raw audio input.
6. The capture AudioContext was created without a fixed rate. The code logged the runtime rate, but no retained log value was found.
7. The output AudioContext requested 16 kHz. No retained proof shows whether Chromium honored that rate.
8. The Recall bot payload did not specify `web_4_core` or GPU variant in the inspected commits.
9. `b9549f6` proves `audio_mixed_raw` initially lacked required artifact enablement and was corrected later.
10. `de1d03e` proves the branch reverted the bundled S2-Pro/prompt/tag change. Its commit message states no operational reason.
11. Current main now uses Soniox input at 16 kHz and Fish S2-Pro output at 24 kHz. The historical branch was built against an older 16 kHz-era path.

### Measured user symptoms

The repository history and Issue #69 contain no retained meeting recording, structured measurement, or commit message that reliably binds a symptom to a commit.

| Requested fact | Evidence |
|---|---|
| Heard noise | Unknown |
| Dropouts | Unknown |
| Clipping/distortion | Unknown |
| Wrong speed | Unknown |
| Added latency | Unknown |
| Exact affected commit | Unknown |
| Exact meeting platform/session | Unknown |
| Recall instance variant | Payload omitted variant; service default at that time is not proven |
| Browser input AudioContext rate | Logged by code but retained value not found |
| Browser output AudioContext rate | Requested 16 kHz; actual value unknown |
| Exact chunk sizes from Fish/network | Not retained |
| Reason Recall branch was abandoned | Unknown |
| Reason S2-Pro was reverted | Unknown |

The research brief says there were multiple trials and reverts and asks that heard symptoms be reconstructed. Git alone cannot supply those symptoms. They must be recovered from operator notes, meeting recordings, terminal logs, Slack messages, or billing/session dashboards if they still exist.

## 2. Unproven hypotheses

None of the following may be stated as the historical root cause:

- Recall.ai audio quality was inherently poor.
- Browser playback caused the defect.
- 16↔48 kHz resampling caused the defect.
- Per-chunk AudioBuffer scheduling caused the defect.
- CPU starvation caused the defect.
- Meeting codec conversion caused the defect.
- Echo gate caused the defect.
- Ngrok or WebSocket jitter caused the defect.
- Fish S2-Pro caused the defect.

## 3. Why each hypothesis remains plausible

| Hypothesis | Supporting evidence | Disconfirming/limiting evidence | PoC discriminator |
|---|---|---|---|
| Browser scheduling | One source node per chunk; no queue metrics | Continuous `playCursor` may work under stable arrival | Log arrival/playout clock, bounded queue, underruns |
| Resampling | Actual AudioContext rate could differ from requested rate; manual averaging existed on input | Hybrid removed browser input but historical result after that is not recorded | Capture actual rates; compare native 24/48 kHz and one high-quality resampler |
| CPU | No variant set; Recall now documents very small default vs 4-core guidance | No historical CPU trace | Same page on default and 4-core with CPU/underrun metrics |
| Codec path | Webpage PCM must pass Web Audio → browser capture → WebRTC/meeting codec | Current Attendee WebSocket path also encounters meeting encoding | Inject identical PCM, record meeting output, compare objective and blind subjective results |
| Echo/gate | Output capture may return in mixed input and gate behavior changed | Hybrid direct input still shares mixed meeting audio; gate exists on current Attendee too | Count duplicate frames/echo, run interruption script |
| Network jitter | Browser received variable chunks over public WebSocket | No packet timing retained | Log sequence/timestamps, queue depth, loss/reconnect |
| Fish model | S2-Pro commit reverted | Revert bundled many unrelated prompt/tag assets; current main later adopted S2-Pro | Use identical recorded current Fish PCM for every candidate |
| Avatar buffering/A/V skew | Current official LiveAvatar LITE examples buffer 400–600 ms before the first renderer chunk | Historical Recall branch had no LiveAvatar integration, so this cannot explain that branch | Tee identical 24 kHz Fish PCM; measure renderer video vs delayed/undelayed meeting audio |

## 4. Historical design errors independent of the root cause

These are code-review facts, not claims about heard symptoms:

- The first spec declared “no conversion needed” before observing actual browser and meeting rates.
- The first implementation guessed an internal Recall WebSocket subscription contract.
- The implementation changed provider logic inside a large route file before locking static behavior with a regression contract.
- Input and output failure domains were changed together, making attribution difficult.
- The provider bridge had no media clock, sequence ID, queue-depth telemetry, or A/V skew instrumentation.
- The TTS output path had no explicit cancellation flush for already scheduled browser sources.
- The branch later fixed artifact enablement, showing the initial realtime raw-audio configuration was incomplete.
- A Fish model/prompt migration was mixed into the transport experiment, contaminating audio comparisons.

## 5. Required evidence recovery

Before a production decision, search for:

- Recall Bot Explorer records and CPU graphs for historical bot IDs;
- Recall invoices/usage showing instance variants;
- meeting recordings or screen captures;
- terminal logs containing `capture started @ ...Hz`;
- Slack threads or personal notes describing noise, dropouts, speed, delay, and the commit under test;
- ngrok/WebSocket logs;
- any HeyGen session IDs and API version used.

If these artifacts no longer exist, the dossier remains intentionally incomplete and the PoC must reproduce candidates against a measured baseline.

## 6. Current Option B finding

Attendee now documents `POST /api/v1/bots/{object_id}/output_video`, but its body is a public HTTPS MP4 URL with optional `loop` and `mute_video`. This does not supply continuous realtime video frames or a WebRTC track. It therefore does not preserve the current realtime PCM path while injecting a genuinely live avatar under an official contract. A repeated short-MP4 replacement loop would be an unapproved hack and is not proposed.
