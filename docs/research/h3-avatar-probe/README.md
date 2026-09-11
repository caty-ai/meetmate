# MiniMax H3 clip-library avatar probe — #252

Docs-only, test-only experiment. No runtime integration; no dependencies beyond Node 26 builtins. Generate a small video library once, then select clips from a local audio envelope. Live generation and visual evaluation are **not yet performed**.

## Run

From the repository root:

```sh
node --test docs/research/h3-avatar-probe/
node docs/research/h3-avatar-probe/generate-clips.mjs --dry-run
# Set FAL_KEY in your shell without putting its value in source/logs.
node docs/research/h3-avatar-probe/generate-clips.mjs --only idle,talk --max-usd 1
node docs/research/h3-avatar-probe/generate-clips.mjs --upload rest
```

Or `cd docs/research/h3-avatar-probe` and use `node generate-clips.mjs --plan clips.plan.json`.

CLI: `--plan <json>`, `--only idle,talk`, `--dry-run`, `--upload data|rest` (default data), `--poll-ms 3000`, `--timeout-ms 900000`, `--max-usd 5`.

The default plan and output `clips/` are relative to the script, independent of cwd. An explicit `--plan` is relative to cwd; reference paths are relative to that plan. `--only` filters the plan before estimating the selected jobs' cost; unknown names fail. Plan validation, cost guard and reading all selected references happen before network requests. Missing `FAL_KEY` in live mode fails immediately. Existing same-name outputs are replaced; rerunning live generation submits new paid jobs (no automatic retry/resume).

Dry-run needs no key and performs **zero network calls**, including with `--upload rest`. It builds the real data-URI request body in memory, simulates COMPLETED on the second poll, and writes only `clips/<name>.dryrun.json`. Its `request_body` preserves every field/value except data URIs, whose logged representation is the first 64 characters (explicitly recorded as `data_uri_log_limit`). It is a log, not a replayable body. REST dry-run also uses local data URIs as stand-ins for uncreated storage URLs. No MP4, fabricated media, real generation time or completed live metadata is produced.

Live mode writes `clips/<name>.mp4` and `<name>.json`: request ID, UTC submission/completion times, `generation_s` (submit through observed COMPLETED, including polling latency), expanded prompt, actual downloaded byte count and assumed USD estimate. Request ID is persisted before polling so a timeout still leaves a job identifier. Downloads stream to `.part` and rename on success. A timeout aborts local I/O; it does **not** cancel a queued fal job or its charges. Non-2xx fails with HTTP status and the first 200 response-body characters; CLI errors redact the key and print one line.

## REST facts and assumptions

**[Verified in the supplied brief, 2026-09-11; not independently verified in this offline sandbox]**

- Submit `POST https://queue.fal.run/minimax/h3/reference-to-video`, `Authorization: Key $FAL_KEY`, JSON body. Response: `{ request_id, status_url, response_url }`.
- Poll `GET {status_url}?logs=1`; IN_QUEUE / IN_PROGRESS continue, COMPLETED proceeds, any other/missing status fails. Existing query parameters are retained.
- Fetch `GET {response_url}` with authorization. Result: `{ video: { url, content_type, file_name, file_size }, expanded_prompt }`; download `video.url` without forwarding the API key.
- Model fields: `prompt`, `reference_image_urls`, `reference_audio_urls`, integer `duration` (default 5), `resolution` (`480P`, `768P`, `2K`, `4K`), `aspect_ratio` (default `adaptive`), integer `seed`, boolean `enable_safety_checker`, `prompt_expansion_mode` (default `balanced`). This probe defaults safety checking to true.
- File inputs accept data URIs. This probe supports local PNG (`image/png`) and MP3 (`audio/mpeg`) references. Prompts identify references by modality and order, e.g. “the character in image 1” / “audio 1”. Audio references must be 2–15 seconds; the supplied Fish Audio Japanese reference is stated to be 8 seconds.
- Alternative storage flow: authenticated `POST https://rest.alpha.fal.ai/storage/upload/initiate` with `{ file_name, content_type }` → `{ upload_url, file_url }`; PUT bytes with the content type to the signed `upload_url` (no API key forwarded); use `file_url` as the model reference. Assets are served from v3.fal.media.
- Assumed list prices: 480P **$0.05/s**, 768P **$0.06/s**, 2K **$0.13/s**; first five reference images free. Cost guard sums duration × resolution rate per selected job, before any upload/submit. Default cap is $5. No price supplied for 4K or >5 images: this probe refuses those plans instead of assuming a cost. Estimates are not billing guarantees.

**[Unverified]** Live endpoint acceptance, actual billing (including any additional fees), storage/data-URI equivalence, audio duration/content validity, exact generation latency, browser codec/autoplay compatibility, loop seams, style retention and Japanese mouth-motion quality. No network call was made to verify these claims. Audio duration is a caller precondition, not decoded by the builtin-only script. Validate any replacement audio before live use.

## Clip plan

`clips.plan.json` contains the exact prompts from #252. All four use the style reference as image 2 and 768P output.

| Clip | Seconds | Seed | Image 1 | Audio | Estimated USD |
|---|---:|---:|---|---|---:|
| idle | 5 | 11 | caty_idle.png | none | 0.30 |
| talk | 5 | 12 | caty_talk1.png | caty-talk-8s.mp3 | 0.30 |
| nod | 4 | 13 | caty_idle.png | none | 0.24 |
| smile | 4 | 14 | caty_idle.png | none | 0.24 |
| Total | 18 | | | | 1.08 |

## Results — fill only after live runs

| Clip | generation_s | File size (bytes) | Cost estimate (USD) | Viewing note |
|---|---|---|---|---|
| idle | 196.0 | 1,089,615 | 0.30 | base H3 `reference-to-video`, 1344×768, 24 fps, 5.18 s, AAC track; owner to fill |
| talk | 136.5 | 2,025,942 | 0.30 | same; reference audio `caty-talk-8s.mp3`; owner to fill |
| nod | 200.9 | 1,409,729 | 0.30 | duration raised 4→5 (API minimum is 5; first attempt 422); owner to fill |
| smile | 130.0 | 2,084,263 | 0.30 | same fix; owner to fill |
| talk-h3max-home2home (manual, not in plan) | **inference 1.41 s** (submit round-trip 4.4 s with data-URI image) | 4,490,542 | ~0.10 (768P, 5 s, discounted list) | `minimax/h3-max/image-to-video`, `image_url` = `end_image_url` = `refs/caty_home.png`, 768×768, 5.18 s, AAC; identity held; last frame did not visibly return to home (hand raised) — recheck |

**Home-to-home set (2026-09-12, `clips/h3max/`, git-ignored):** all four clips regenerated with `minimax/h3-max/image-to-video`, `image_url` = `end_image_url` = `refs/caty_home.png`, 768×768, 5 s, seeds 31–34, one shared prompt prefix. Inference 1.35–1.43 s each; ~USD 0.10 each. First/last frames of all four match the home pose and framing (frame strip checked). Owner verdict on the first (mixed-source) set: mouth motion "結構良さそう", but clips "ズレてしまってる" → switching jumps; the home-to-home set is the fix. Generator: `~/.claude/scratch/alpha/h3max/gen-home2home.sh` (to be folded into `generate-clips.mjs` as an `--engine h3max` mode). Open with `switcher.html?clips=clips/h3max&audio=clips/sample-caty-path3.wav`.

**Reading (2026-09-11):** base H3 is 130–200 s per 5 s clip → pre-generation only. H3 Max image-to-video is ~1.4 s inference → viable for per-utterance clips (2026-09-09 Plan B), but it takes **no audio input**, so mouth motion is generic rather than lip-synced to Fish. Lip-sync to our audio exists only in `minimax/h3-max/director` (5.6–7.2 s reaction, per-minute billing; 09-09 lab). Plan B for this lane: idle loops home→home via h3-max i2v, per-utterance home→home clips on speech, double-buffered switcher, Fish audio played by the Bridge.

## Local switcher

Open `switcher.html` directly as a local file after generating clips; no server or external scripts are needed. Select an audio file using the file picker (suggested: `../gpt-live-1-probe/path3/solo-1/output.wav`), then play via the button or audio controls. Space toggles playback when focus is outside native form/media controls; those retain native keyboard behavior. The file picker uses an object URL, so the browser can analyze the user-selected local audio.

Default video directory is `clips/`; use `switcher.html?clips=another-directory` or a URL-encoded absolute directory URL. Videos are muted, contain-fit and stacked in a 16:9 box with a 150 ms opacity transition. idle/talk loop continuously; optional nod/smile switch from looping preload elements to one-shot playback when selected. Missing/unsupported media is reported, and missing optional clips are skipped. If only one optional clip is playable it is reused; if both are playable they alternate. No video is expected in dry-run.

An AnalyserNode computes raw time-domain RMS every 40 ms. RMS ≥ 0.375 selects talk; lower RMS for **more than 300 ms** selects idle. If the talk interval before that quiet period lasted ≥1.5 seconds, select nod/smile once, then idle on `ended`. Renewed speech interrupts a gesture and selects talk. Pause, end, seek, file change, or audio failure resets to idle. Overlay shows state, raw RMS, a 0/1/2 level using 0.375 and 0.75, and audio elapsed time. Both upper levels select the same talk clip. RMS is not loudness-normalized; quieter source audio may never cross 0.375. Test this with the intended audio before judging animation responsiveness.

## Comparison and limits

The PNG renderer in `public/local-avatar/frames.js` (#63/#72) uses idle/talk1–3/blink/talk_blink frames, 0.375/0.75 envelope levels, 40 ms render ticks and 150 ms blinks. This probe reuses those numeric level thresholds and render cadence, but directly measures local raw RMS instead of consuming the renderer's server envelope/marker stream. Its 300 ms quiet hysteresis and post-talk gestures are the requested probe behavior, not a reproduction of the renderer's entire timing model. Blinks here are baked into generated videos; the 150 ms crossfade does not impose a 150 ms blink. H3 may provide smoother body motion but adds generation cost, larger files and loop/transition seams. A prerecorded talk loop follows only the current audio's activity, not its phonemes; the 8-second reference guides a 5-second generated clip and does not ensure lip sync to later playback audio. HeyGen LiveAvatar is an alternative live-avatar approach, **not built or benchmarked here**; no latency, cost or quality equivalence is claimed.

## Verification and handoff

Tests cover validation/cost math, MIME/base64 round-trip, exact request field shape, queue states/errors/abort, dry-run files with no fetch, fail-closed preflight, and fake-fetch REST upload through streamed download. Live-path test bytes exist only in a cleaned temporary directory and are not presented as playable media. `index.js` is a tiny test entry because Node 26.5.0 resolves the requested directory argument as a module rather than discovering its test files.

All changes are confined to this probe. `clips/` is ignored; supplied `refs/` are preserved for Alpha to include in the commit. No commit/push was performed. `gh issue view 252` failed to connect; the supplied brief was authoritative. Browser execution and independent Kimi K3 + GLM 5.2 review remain for Alpha in a network-enabled environment (review quorum not met here). No tool-state directory was created.
