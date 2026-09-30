# Design note #266 — page-owned reply audio for face-package sessions ("page audio" mode)

In-repo copy of the frozen design v1.4 (caty-ai/meetmate#266), lightly edited. The review history is on the Issue.
- Status: frozen after four design review rounds; implementation follows this note.
- Marks: **[r1:…]** to **[r4:…]** are reviewed requirements adopted in rounds 1–4, with the finding source.
- Base: `origin/main` 00a92ff.
Owner decisions (frozen): option 1 first; opt-in, default unchanged; self-hosted Attendee capture patched to 48 kHz locally (upstream PR not now); Done when #3 thresholds accepted.

Implementation notes (where the code had to choose):
- The state route reads the heartbeat body only for `faceAudio=page` sessions; other sessions keep today's synchronous route byte-for-byte (§2.2).
- Marker states of page-routed epochs carry `audio: "page"`, so the host's wall-clock timeline stays idle for them even before the first PCM chunk arrives (§2.5).
- After a stream stop (B) the host reopens the stream after the next healthy state poll, at most once per 500 ms (§2.4).
- A page stop idles the mouth only for page-owned epochs; a WebSocket-routed epoch keeps its wall-clock mouth (§2.4, §2.5).
- `pageAudioUntil` is (re)set at WebSocket connect (beginSource), on `playback_cancelled`, and on session close through a session close hook (§2.6).

## §0 Measured facts (VPS spike, 2026-09-30 — #266 comments 5895245160 / 5895395602)
- Attendee `c59b71b8` webpage streamer captures page audio (Chrome → PulseAudio null sink → `alsasrc` monitor) and sends it **with the page video on one WebRTC connection** (`webpage_streamer.py:171-185, 355-392`); the bot routes that audio into the **same `gainNode`** as the WebSocket `realtime_audio.bot_output` path (`shared_chromedriver_payload.js:407-445, 553-561, 704`) ⇒ both at once = double audio. Chrome runs with `--autoplay-policy=no-user-gesture-required` (`webpage_streamer.py:236`).
- A/V offset, streamer path, fresh container, one consumer: chunked playback 180 s → median +4.6 ms, drift +0.5 ms/min, 0 dropouts; 48 kHz patch 120 s → median −1.1 ms, drift −0.2 ms/min.
- A second `/offer` consumer on the same container causes 40–60 ms dropouts in every consumer.
- **Scope of these numbers [r1: Devin/Kimi NIT]:** streamer leg only. The bot → Meet leg (canvas + gainNode) and the absolute added voice latency are not measured; Done when #3 measures the streamer leg, Done when #5/#6 cover the rest.

## §1 Today (code facts, origin/main)
- `pipeline.deliverAudio()` (`src/pipeline.js:634-698`) applies floor mute/fence (mute returns early; stale fence ⇒ zeroed PCM), builds `metadata`, calls the transport `onAudio(buffer, metadata)`; `projectedEnd` is send-time.
- Meet `onAudio` (`src/transport-meet/meet-routes.js:1793-1815`) sends `realtime_audio.bot_output`, and **only if that send succeeded** (`:1809`) publishes the marker.
- Cancellation: `abortPlayback` → `playback_cancelled` (`src/pipeline.js:711-726`, floor cancels via `:821-833`) → `localAvatarSession.cancelPlayback` (`meet-routes.js:1817-1825`), which today only enqueues a visual `cancel` state picked up by the 100 ms poll.
- face-host (`public/local-avatar/face-host.js`) polls `POST /local-avatar/state` every 100 ms; auth = Bearer capability + visual id + `Origin === publicOrigin` + generation (`src/ui-routes.js:193-236`, `local-avatar-session.js:114, 280`); wall-clock anchor with forward-only re-anchor (`:73-77`); 33 ms tick. Page CSP `connect-src 'self'` (`src/ui-routes.js:13-24`); package iframe `sandbox="allow-scripts"`, CSP `media-src 'none'` (`src/transport-meet/face-package.js:112-116`).
- Echo gate: `turnState` is created in `meet-routes.js:1779-1784` and checked at `:1881-1903` (`isAgentSpeaking || now < inputCooldownUntil`); the pipeline sets both from send-time events.

## §2 Proposed shape
**2.0 Opt-in [r1: Grok/Kimi on follow-settings; r2: all three].** Join field `faceAudio=page`. Validation uses the **resolved** avatar experiment, which is the value after `meet-routes.js:1202-1204`. There, a settings default of `face-package` resolves to `""` unless the form sends `avatarExperiment=face-package` explicitly.
- The mode is allowed only when the resolved value is `face-package`; otherwise the join returns 400. So "follow settings" + `faceAudio=page` is always 400.
- It also returns 400 when the session's resolved hub config (`sessionHubConfig`, `meet-routes.js:1300`) has `enabled === true`, so this check runs after that line. **[r1: Grok/Kimi Q6]** Floor release is send-time + `hub.tailMs`, so page-path delay could overlap the next grant. The combination is deferred to a follow-up Issue.
- The join form shows the checkbox only when the avatar select is explicitly `face-package`. MCP `join_meeting` unchanged (never sends it ⇒ default). No settings-registry key in this lane (#267 owns `src/settings/registry.js`, `public/settings.js`).

**2.1 Epoch routing (meet-routes `onAudio` closure only).** Decision at the first chunk of each `outputEpoch`, fixed for the epoch: page if *audio-ready* (2.2), else WebSocket (today's path). Never both, never switched mid-epoch. A page-routed epoch whose stream dies mid-epoch loses its tail **by design** (recovery at the next epoch); this is asserted by a test, not hidden **[r1: Kimi]**. **Markers are published for every epoch regardless of route [r1: Devin/Kimi]**; with the mode off the block is byte-identical to today (pinned by DW1).

**2.2 Audio-ready = freshness-bounded [r1: all three].** All of: an audio stream is open for the current session generation; the page's last heartbeat is ≤ 1 s old; the heartbeat reports `ctx.state === "running"`; the stream's unacknowledged backlog ≤ 2 s. Heartbeat = fields added to the existing 100 ms `/local-avatar/state` poll body (`audio: {state, playedEpoch, playedSample, receivedSample}`), so no new channel is needed. Losing freshness marks the page not-ready for the **next** epoch only.

**[r2: Grok/Kimi]** How the heartbeat is carried:
- The route reads the small JSON body on **every** poll, including polls answered with 204. Between replies, 204 is the steady state, so parsing only 200 polls would let freshness lapse.
- The exact-query-key guard (`ui-routes.js:218`) is unchanged.
- The session stores the latest heartbeat in memory through a new `recordHeartbeat()` method. `readState` stays a pure read.
- meet-routes reads the stored heartbeat through the session object. All of this stays inside the declared files.

**2.3 Audio stream [r1: Grok CRITICAL, Devin/Kimi].** New `POST /local-avatar/audio` with **exactly the `/local-avatar/state` checks** (Bearer capability + visual id + `Origin === publicOrigin` + live session + generation; POST-only; 404 on failure). Streamed binary response, length-prefixed frames. Frame kinds: `pcm {generation, outputEpoch, cancelEpoch, firstSampleIndex, sampleRate, utteranceId|null, bytes}` and `cancel {generation, cancelEpoch, outputEpoch}`. Rules:
- One stream per session; a new stream (or a new generation) closes the previous one server-side.
- **No replay:** a new stream carries only frames enqueued after it opened. The page drops frames whose `generation` or `cancelEpoch` is stale, and frames whose `firstSampleIndex` is below the epoch cursor.
- **[r3: Kimi NIT]** The page's POST sends a complete request body. It is a plain `fetch` without a `duplex` streaming upload. The `requestTimeout` probe result holds only under that condition.
- **[r2: Devin NIT; r3: Kimi NIT]** When a stream dies, the server marks every page-routed epoch that was in flight as *page-lost*. An epoch counts as in flight if any of its frames were queued or written on that stream and it had not ended or been cancelled. The remaining frames of a page-lost epoch are dropped and never sent, even if a new stream opens in the same generation. The new stream carries only later epochs. This is the "tail lost, no switch" behaviour that DW2 asserts.
- **Cancel is pushed in-stream:** `cancelPlayback` (and `beginSource`, session close, leave) purges queued frames with `outputEpoch <= cancelled` and writes a `cancel` frame immediately; session close ends the response.
- Server queue bounded to ~2 s; overflow ⇒ close the stream (current epoch loses its tail, next epoch falls back) **[r1: Grok]**.
- Socket settings, on this route only: `req/res.setTimeout(0)`, `Cache-Control: no-store` and `X-Accel-Buffering: no`. CSP is unchanged. **[r1: Kimi/Devin]** Flushing through the tailnet serve front end must be verified on the VPS before the implementation counts as done.
- **[r2: Kimi/Devin, measured]** Node's `server.requestTimeout` does **not** cut a streamed response once the request body has been read. Probe (`probe-request-timeout.js`, Node v26.5.0): with `requestTimeout = 2000`, a POST whose response streamed for 6 s completed with all 13 lines. So no `server.js` change and no client-side stream rotation are needed. DW8 still includes a > 5 min soak through tailnet serve as the live-path check.

**2.4 Page player (face-host, mode only).** One `AudioContext`. Chunk scheduling is driven by stream arrival, never by rAF. The first chunk of an epoch starts at `max(cursor, currentTime + leadMs)` (`leadMs` = 150). Later chunks start at `max(cursor, currentTime + guard)`. Gaps are silence. The cursor rule is in the bullets below. **Two kinds of stop [r1: Grok CRITICAL; r2: Grok/Kimi; r3: Grok MAJOR split].**

**(A) Epoch stop — keep the stream.** Call `source.stop()` on every scheduled node of the cancelled epoch or epochs, and drop their remaining frames. The fetch **stays open**. Triggers:
- a `cancel` frame;
- a stale `cancelEpoch`/`outputEpoch` from the state poll.

Cancellation is routine: every barge-in produces it. It must not tear down the stream, otherwise every later epoch would fall back to WebSocket for the rest of the session.

**[r4: Grok MAJOR]** An epoch stop also rewinds the player:
- It sets `cursor = currentTime`.
- It deletes the cancelled epoch's sample→time rows from the §2.5 map. The mouth then has nothing to resume from, and the next page epoch's first chunk starts at `currentTime + leadMs`, not at the cancelled epoch's old scheduled end.
- The mouth stays idle until that next chunk starts playing.

**(B) Stream stop — stop every scheduled node and abort the fetch.** Triggers:
- a generation change or `timeline.connect`;
- `backoff()`;
- `pagehide`;
- the audio stream ending for any reason: fetch error, response end, server-side overflow close, or supersede;
- a state-poll 404/401 (session closed, or leave).

After (B), the page opens a new stream only once the state poll has reconnected. That new stream is subject to the §2.3 no-replay and page-lost rules.

Rules that apply to both kinds of stop:
- No scheduled node may outlive its stream. This rules out a page tail overlapping the next, WebSocket-routed epoch (F-double). Accepted residual (i) is therefore "the tail is not played", never "the tail is played late".
- **[r3: Devin MINOR]** After either kind of stop, the mouth goes idle at once. The page sends `speak-end` (reason `interrupt`) for the active utterance and `level 0`, so a page-lost or cancelled epoch never leaves the mouth frozen open.
- **[r3: Devin NIT]** One scheduling cursor per stream, shared across epochs. The first chunk of an epoch starts at `max(cursor, currentTime + leadMs)`; later chunks start at `max(cursor, currentTime + guard)`. So consecutive epochs never overlap even when the page lags. `guard = 20 ms`.

**2.5 Mouth mapping [r1: all three].** For epochs the page received PCM for, the sample→time map is **piecewise from the actual scheduling decisions**: each scheduled chunk records `(firstSampleIndex, sampleCount, scheduledStartCtxTime)`; `speak-start`/`level`/`speak-end` are computed from the chunk covering `ctx.currentTime`, using the server envelope windows (no `outputLatency` term — the spike measured ~5 ms without it). For epochs routed to the WebSocket (fallback), the existing wall-clock marker timeline is used unchanged. **[r2: Grok NIT]** For page-owned epochs the wall-clock `createTimeline.tick()` is idle: markers still arrive, but they only supply envelope windows and never trigger `speak-start` on the wall clock. That way exactly one clock drives the mouth in each epoch. Mouth tick: 33 ms interval kept (rAF optional, never required; Xvfb/fullscreen rAF cadence unverified). AnalyserNode only in the probe as a cross-check.

**2.6 Echo gate [r1: all three; r2: all three].** meet-routes keeps a new field, `turnState.pageAudioUntil`, and only meet-routes writes it. The gate at `:1883` also drops input while `now < pageAudioUntil + pathPadMs + ECHO_LOOP_COOLDOWN_MS`.
- `ECHO_LOOP_COOLDOWN_MS` is the constant meet-routes already uses (`:780`); `config.echoCooldownMs` is set from the same value (`src/config.js:393`).
- `pathPadMs` is measured on the VPS (§2.8); its initial value is 300 ms.

`pageAudioUntil` is updated in three ways:
- **Send projection.** For each page-routed chunk: `pageAudioUntil = max(pageAudioUntil, now + leadMs) + chunkMs`.
- **Backlog hold.** While a page epoch is live and the heartbeat is fresh: `pageAudioUntil = max(pageAudioUntil, now + (receivedSample − playedSample)/rate·1000)`. Heartbeats can only extend the hold, never shorten it, and `pathPadMs` is always kept.
  - **Live [r3: Grok MINOR]:** the epoch is the current page-routed epoch, it has not been cancelled, and it is not page-lost. The heartbeat's `playedEpoch` must equal that epoch.
  - **Counters [r3: Devin NIT]:** `receivedSample` and `playedSample` are cumulative sample counts **of that epoch**, keyed by `playedEpoch`.
  - **After a reset:** heartbeats are ignored for the hold until the next page-routed send, so a stale pre-cancel backlog cannot re-close the gate.
- **Reset on cancel [r2: all three, MAJOR].** Set `pageAudioUntil = now` in three places: the existing `playback_cancelled` listener (`meet-routes.js:1817-1825`), `beginSource`, and session close. After a reset, only `pathPadMs + ECHO_LOOP_COOLDOWN_MS` remains, which covers in-flight residual (ii). This mirrors the pipeline's own cancel paths, which clear `inputCooldownUntil` (`pipeline.js:1108-1109, 1975-1978, 2317-2320`). A barge-in must never leave the bot deaf for the rest of the cancelled reply.

`src/pipeline.js` is not touched.

**2.7 Streamer consumers [r1: Devin].** Ops/Done-when item: exactly one PeerConnection per streamer container (container exits on leave — already the case); a bot-side streamer reconnect is logged, and the probe checks for dropouts.

**2.8 Measurement work [r1: Kimi DW5 unclear].** `tools/av-sync-probe/` (not shipped): (a) streamer-leg A/V offset/drift (spike harness, productised); (b) added-latency probe: time from the server sending a marked chunk to that chunk being audible at the streamer `/offer` receiver, for the page path, vs the WebSocket path measured at the bot (or the owner-live measurement if the bot leg cannot be instrumented); the result sets `pathPadMs`.

**2.9 Packages stay audio-free.** Sandbox and `media-src 'none'` unchanged; only the meetmate-owned host page gains audio. `docs/face-packages.md` wording + ADR 09 amendment note. The capability now gates reply PCM as well as visual state — same holder set, same TTL; stated in the doc.

**2.10 Self-hosted Attendee.** Local ops patch (not in this repo): capture rate from env `WEBPAGE_STREAMER_AUDIO_SAMPLE_RATE` (default 16000; ours 48000), with rollback in the VPS ops notes. Attendee cloud unaffected unless opted in; docs state the 16 kHz limit there.

## §3 Failure forms (worst first)
F-double, F-silent, F-stale, F-regress, F-leak — as v1; §2.1–2.6 are the mechanisms against each. Accepted residuals: (i) a page-routed epoch whose stream dies mid-epoch loses its tail; (ii) after a cancel, audio already inside GStreamer/WebRTC/bot buffers (~100–300 ms) still plays — measured, not promised zero.

## §4 Done when (owner-confirmed thresholds)
1. With the mode off: behaviour, Attendee cloud path and `make test` unchanged; `test/characterization-attendee-audio.test.js` and `test/local-avatar-static-regression.test.js` still pass unmodified; a test pins that the marker/bot_output block is identical when off.
2. With `faceAudio=page`, each epoch goes through exactly one path. Tests cover:
   - **Routing:** ready → page; not-ready → WebSocket; stale heartbeat → next epoch on WebSocket; heartbeat carried on 204 polls; `ctx` suspended after ready.
   - **Stream loss:** mid-epoch stream death (tail lost and not played, no switch, no duplicate, scheduled nodes stopped); reconnect or new generation (no replay, and a page-lost epoch stays lost); queue overflow.
   - **Cancel:**
     - barge-in before `leadMs` elapses;
     - **a cancel keeps `/local-avatar/audio` open, and a later epoch still routes to the page** [r3: Grok];
     - after any stop, the mouth goes idle (`speak-end` + `level 0`) [r3: Devin];
     - after an epoch stop, the cursor is rewound and the cancelled epoch's map rows are gone: the next page epoch's first chunk starts at `currentTime + leadMs`, and the mouth stays idle until then [r4: Grok];
     - a stale pre-cancel heartbeat does not re-close the gate [r3: Grok].
   - **Markers:** markers flow for both routes.
   - **Echo gate:** input is dropped while page audio is projected or backlogged and released after it; the gate **re-opens within `pathPadMs + ECHO_LOOP_COOLDOWN_MS` of a cancel** (`pageAudioUntil` reset).
   - **Validation:** follow-settings + `faceAudio=page` → 400; hub `enabled:true` → 400; hub resolved to `enabled:false` → allowed.
3. Streamer-leg VPS probe over a ≥ 60 s reply: median |A/V offset| ≤ 40 ms, drift ≤ 5 ms/min, including a reply with synthesis stalls; before (WebSocket path, marker timeline) / after recorded on #266.
4. Cancel / barge-in / reply cancel / leave-while-speaking: the page scheduler is silent within one mouth tick (33 ms) of receiving the cancel (test with a mocked `AudioContext`); meeting-side tail measured live and recorded.
5. Added voice latency measured by §2.8(b) and recorded; `pathPadMs` set from it; owner listening check at an agreed time (48 kHz patched Attendee) says voice quality and latency are acceptable.
6. Live check: owner judges lip sync over a long reply acceptable.
7. `docs/face-packages.md` + ADR 09 amendment note versioned; a test pins the package iframe sandbox and CSP unchanged.
8. Ops: one PeerConnection per streamer container confirmed; tailnet-serve flushing of `/local-avatar/audio` confirmed on the VPS, including a > 5 min continuous stream soak.

## §5 Files to touch (prediction; declared on #266 and checked against #267 before code)
`src/transport-meet/meet-routes.js`, `src/transport-meet/local-avatar-session.js`, `src/ui-routes.js`, `public/local-avatar/face-host.js`, `public/index.html`, `public/app.js`, `docs/face-packages.md`, `docs/design/266-page-audio.md` (new), `tools/av-sync-probe/*` (new, not shipped), tests: `test/local-avatar-session.test.js`, `test/ui-routes.test.js`, `test/local-avatar-page-contract.test.js`, `test/local-avatar-face-package-cases.js` (VM cases, mocked `AudioContext`), new `test/local-avatar-page-audio.test.js`, new `test/meet-routes-page-audio.test.js`; read-only pins: `test/characterization-attendee-audio.test.js`, `test/local-avatar-static-regression.test.js`.
**Not touched:** `src/pipeline.js`, `src/settings/registry.js`, `public/settings.js`.
