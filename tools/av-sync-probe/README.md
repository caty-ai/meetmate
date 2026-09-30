# av-sync-probe (#266 §2.8, not shipped)

Measurement kit for the page-audio mode (`faceAudio=page`). `tools/` is outside the npm
`files` allowlist, so nothing here ships.

- `flash-face/`: a Face Protocol v1 package whose whole viewport brightness follows `level`.
  Video luminance therefore encodes the mouth. It follows `docs/face-packages.md` (files only,
  no inline script, `event.source === parent`, no audio).
- `analyze.js`: an offline analyzer. It computes the audio RMS envelope and the video
  luminance series, then runs windowed cross-correlation (10 s windows, 2 s step, ±500 ms lag).
  It reports the A/V offset median/p10/p90 and the drift in ms/min (Theil-Sen slope).
  The sign is `offsetMs = video − audio`, so a positive value means the face is late.
- `node analyze.js --selftest` generates a synthetic recording with a known offset and drift
  and checks that the analyzer recovers them. It writes no files.

## §2.8(a): streamer-leg A/V offset and drift (Done when #3)

1. Install `flash-face/` as the face package on the test instance (`avatar.facePackageDir`)
   and restart. Use a separate test instance; the live service stays untouched.
2. Join with アバター表示 = フェイスパッケージ and the page-audio checkbox on (`faceAudio=page`).
   For the "before" run, join with the checkbox off (WebSocket path, marker timeline).
3. Record from the streamer's `/offer` receiver, which carries page audio and page video on one
   WebRTC connection. Use exactly one consumer: a second `/offer` consumer causes 40–60 ms
   dropouts in every consumer. Record at 60 fps if you can (see "Resolution").
4. Ask for a reply of at least 60 s, including one reply with synthesis stalls.
5. Analyze:
   - `node analyze.js --video recording.webm` (needs `ffmpeg` on PATH), or
   - `node analyze.js --wav audio.wav --luma luma.csv`, where the CSV has `time_s,luma` rows,
     one per video frame.
6. Record the JSON on #266. Done when #3 needs median |offset| ≤ 40 ms and |drift| ≤ 5 ms/min
   over ≥ 60 s (see `doneWhen3` in the output).

## §2.8(b): added voice latency (sets `pathPadMs`)

1. On the server, log the send time of a marked chunk: the first page-routed chunk of a reply
   after at least 1 s of silence.
2. Record the streamer `/offer` receiver audio with a synchronized clock, then run
   `node analyze.js --wav receiver.wav --onsets`. It lists burst onsets that follow ≥ 300 ms of quiet.
3. Latency = the onset time minus the send time for the same reply. Repeat on the WebSocket
   path, measured at the bot, or use the owner-live measurement if the bot leg cannot be instrumented.
4. Set `PAGE_AUDIO_PATH_PAD_MS` in `src/transport-meet/meet-routes.js` from the page-path result.
   The initial value is 300.

## Resolution

The face shows one level per 100 ms envelope window, and the camera samples it at the frame rate.
The analyzer models the unknown window phase, but it cannot see an edge more precisely than
one frame.
- **Synthetic accuracy at 60 fps:** median within about ±5 ms and drift within about ±4 ms/min
  over 75–120 s. The self-test enforces ±6 ms and ±4 ms/min.
- **Synthetic accuracy at 30 fps:** roughly ±8 ms and ±6 ms/min.

When the drift result is close to the 5 ms/min threshold, record at 60 fps, or for longer than
120 s, before judging.
