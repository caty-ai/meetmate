# Face packages and Face Protocol v1

A face package is an operator-installed folder containing a silent visual renderer.
Meetmate hosts it during an explicitly requested `face-package` meeting. The renderer
receives generic visual messages, never meeting credentials or audio (not even when the
host page plays the reply in the opt-in page-audio mode). Caty Stage is
one example implementation. No renderer code or character artwork is bundled here.

## Configuration

```json
{
  "avatar": {
    "experiment": "face-package",
    "facePackageDir": "/srv/meetmate-face",
    "emotionJudge": "off",
    "faceListenReactions": false,
    "faceTimelineOffsetMs": 300
  }
}
```

The settings ids are `avatar_experiment`, `face_package_dir`, `emotion_judge`,
`face_listen_reactions`, and `face_timeline_offset_ms`. The directory is deployment-only: edit the config on the
server and restart. It must be absolute; it is neither UI-writable, UI-returned nor
transferable. Invalid or missing directories/manifests fall back to the static bot
image with `MM-MMT-003` (invalid setting); diagnostic logs do not contain paths.

Each join must explicitly send `avatarExperiment: "face-package"`. A global setting
alone uses the static image unless the join requests the face renderer. Select
フェイスパッケージ in the join form to send this per-join request. The global
value only exposes face settings; it does not opt subsequent joins in. Existing static, rig, and frames joins
keep their payload, PCM delivery and state schema. With no face-package session,
face modules are not imported, package directories are not read, and all face routes
return 404. Changing settings does not turn a rig session into a face session.

`emotion_judge` is `off` (default), `tags`, or `jev`. Jev uses `jev-latest` at
`https://api.typesafe.ai/v1/systemone`; configure `TYPESAFE_API_KEY` in the process
launch environment or deployment environment file. This credential is read only
when a judgement is needed, never as a settings-registry startup value. Jev sends
only cleaned agent reply segments, not acknowledgements, progress pings, greeting
or timeout fallbacks. It runs concurrently with speech, before the TTS lock wait,
with an 800 ms timeout. Failures fall back to canonical Fish tags, then neutral.
It never delays audio. Late results remain eligible after synthesis finishes until a newer utterance
starts, cancellation, or generation reset. The host applies an update only to its
active id and ignores it after playback reaches its own speak-end. The first canonical tag in textual order wins; unknown tags are ignored:

| Fish tag | Emotion | Intensity |
|---|---|---|
| `[soft voice]` | null | 0 |
| `[warm]` | trust | 0.3 |
| `[friendly, warm]` | joy | 0.3 |
| `[empathetic, unhurried]` | sadness | 0.2 |
| `[thoughtful]` | anticipation | 0.2 |

Listening reactions are an experiment, disabled by default. Enabling
`face_listen_reactions` supplies listen boundaries. When `emotion_judge` is also
`jev`, confirmed user utterances may be sent for one reaction judgement each,
at most one call per four seconds. Packages must declare `listen` and/or `cue` to
receive the corresponding messages. Start a new meeting after changing this flag.

### Lip-sync offset

`face_timeline_offset_ms` (`avatar.faceTimelineOffsetMs`) is how long, in
milliseconds, the face waits after the server marks audio before animating it.
It is a signed integer from -3000 to 3000; the default 300 is the behaviour before
the setting existed. It is read once when a face session starts and reaches the
host page as the descriptor's `timelineOffsetMs`; a package cannot override it.
Changes apply from the next join; a running meeting keeps its value.

- Mouth moves later than the voice: decrease the value (negative values are allowed).
- Mouth moves earlier than the voice: increase the value.
- Change it in steps of 100–200 ms and start a new meeting after each change.

Observed reference values, judged by eye rather than measured: the Attendee cloud
bot looks right at 300; one self-hosted Attendee deployment needed -700.

The offset follows the bot host (#260). `face_timeline_offset_ms` is the value for
Attendee cloud (and for an installation that has not chosen a host);
`face_timeline_offset_ms_self_hosted` (`avatar.faceTimelineOffsetMsSelfHosted`,
same range, default 300) is the value for a self-hosted Attendee. The value of the
host selected by `bot_host` when the meeting starts is the one sent; the settings
screen marks it "in use". See "Choosing where the bot runs" in the setup guide.

## Folder and manifest

```json
{
  "spec": "face-package/1",
  "entry": "index.html",
  "query": "quality=low",
  "viewport": { "width": 1280, "height": 720 },
  "supports": ["speak", "level", "emotion", "background", "listen", "cue"],
  "quality": "low"
}
```

`face.json` and the entry file are required. The manifest is limited to 64 KiB
before reading/parsing and is never served through the package mount. `entry` must be a safe relative path to
an indexed `.html` file, with no query, fragment, dot-prefixed component, backslash,
percent escape, or colon. `query` is optional: one to four plain `key=value` pairs,
joined by `&`. Keys contain 1–40 and values 0–40 characters from `[A-Za-z0-9_.-]`.
The host appends `?<query>` **after the entry**; it is never part of file resolution.
Empty search strings are accepted on asset requests, but an explicitly supplied
manifest query must contain at least one pair. Percent escapes and `+` are rejected.

`viewport` is optional and advisory, with integer width/height from 1 to 8192.
`supports` is an array of at most 32 strings, each matching
`^[a-z][a-z0-9-]{0,31}$` (1–32 characters, no trailing newline). Known v1 values are
`speak`, `level`, `emotion`, `background`, `listen`, and `cue`; `speak` and `level`
are required. Hosts ignore unknown well-formed values for forward compatibility,
dropping them from the normalized descriptor and `host-init`; they never enable
new message types. Non-string or malformed entries and oversized arrays invalidate
the manifest. The 32-entry limit applies before filtering or deduplication.

`quality` is optional: `auto`, `low`, `medium`, or `high`, forwarded in
`host-init`. Other descriptive manifest fields are ignored and never returned by
the descriptor. The configured viewport does not resize the meeting video output.

Keep all resources in the folder. No network dependencies, inline scripts, SVG,
Wasm, service workers, storage, microphone, media playback or AudioContext playback
path are permitted. Package scripts must be files inside the package (`.js` or `.mjs`). Relative worker scripts
may require an in-memory blob worker in an opaque-origin sandbox. Inline CSS,
blob workers, data/blob images and package-local fetches are supported. Do not embed
audio controls in the package; the meeting pipeline owns sound (ADR 09). In the opt-in
page-audio mode the meetmate host page, never the package, plays the reply (see
[Page audio](#page-audio-faceaudiopage-experimental)). Packages stay audio-free in every mode.

## Face Protocol v1

The browser transport is `postMessage` between the host and a sandboxed iframe.
Messages are ordinary objects with `type`; unknown types are ignored. Packages must
validate `event.source === parent`, message shape, vocabulary, numeric bounds and
ids. Hosts validate `event.source === iframe.contentWindow`. Since the frame has an
opaque origin, the host sends to `'*'`; only non-secret visual data goes to that
specific window. The Bearer capability stays in the host closure and never crosses
the protocol. Another host may implement the same messages through its own adapter.

| Direction | Type | Fields / purpose |
|---|---|---|
| Package → host | `face-hello` | Optional `spec: "face-package/1"`; starts the handshake |
| Host → package | `host-init` | `spec`, `supports`, optional `viewport`, `quality` |
| Package → host | `face-ready` | Optional `spec`; renderer is ready to receive speech |
| Host → package | `speak-start` | `id`, `emotion`, `intensity`; one spoken segment starts |
| Host → package | `speak-emotion` | `id`, `emotion`, `intensity`; updates the active segment |
| Host → package | `level` | `id`, `v` in 0..1; visual envelope on the playback clock |
| Host → package | `speak-end` | `id`, `reason: "end"` or `"interrupt"` |
| Host → package | `background` | `mode: "solid"`, `"image"`, or `"chroma"`; `color: "#rrggbb"` |
| Host → package | `listen-start`, `listen-end` | `id`; listening interval, experimental |
| Host → package | `cue` | `id`, `emotion`, `intensity`; one listening reaction, experimental |

Emotion vocabulary is Plutchik eight: `joy`, `trust`, `fear`, `surprise`, `sadness`,
`disgust`, `anger`, `anticipation`, plus `null` for neutral. Intensity is 0..1.
Jev's `neutral` maps to null. Without declared `emotion`, speak-start is neutral
and speak-emotion is not sent. Optional messages require declared capabilities.

The host keeps the background visible and the iframe hidden until `face-ready`;
`face-hello` alone starts initialization but does not reveal an unready frame.
The hidden frame stays laid out and rendered (`opacity:0`, not `visibility:hidden`) so the package can reach its first animation frame.
The package may send ready directly. Handshake messages are idempotent. Start is
sent before levels or emotion updates for an id. Every temporal message includes
an id; discard stale levels, emotion updates and ends for other ids. Normal end
settles the renderer; interrupt immediately clears queued animation. Generation
reset/reconnect interrupts the previous active segment and discards stale history.

One output epoch can contain many segments, including silence gaps. Meetmate stores
a cumulative timeline of `{utteranceId, utteranceStartSample, lastSample, endSample,
emotion, intensity, emotionRevision}` in each face state. The latest snapshot thus
preserves start/end transitions across polling coalescing. This visual history is
bounded to 20 seconds and 256 segments; reconnect starts fresh. Normal completion
comes from explicit synthesis completion and the final sample position, never a
silent envelope. Levels run at roughly 30 Hz over 100 ms envelope windows, with a
300 ms initial playback offset and forward re-anchoring after synthesis gaps.
No PCM, text, output epoch, filesystem path or capability is sent to the package.

## Serving boundary

Host HTML uses the existing visualId/fragment-capability launch pattern. A live
face session gates both host assets. The fragment is removed before the iframe is
created. The host obtains a descriptor with a Bearer-authenticated, Origin-matched
POST to `/local-avatar/face-descriptor?v=<visualId>`; the descriptor is not CORS-enabled.
Only it reveals the independent 256-bit random `mountId`, absent from the launch URL.
Package files use `/local-avatar/pkg/<mountId>/<relative path>`. Treat mount URLs as
short-lived access credentials and avoid recording them in reverse-proxy logs.
Application log scrubbers redact mount URLs and visual identifiers.

Every asset request checks session liveness without refreshing the TTL. Expiry or
close revokes the mount. An immutable file index is built once at session creation:
regular files only, no symlinks or dotfiles/directories, realpath under the root.
Request paths are matched literally without percent-decoding, so use plain ASCII file
names without spaces or `%` (such a file is indexed but can never be fetched).
Limits: 2000 files, depth 8, relative path length 200, 64 MiB per file, 256 MiB total.
Exceeding a limit invalidates the package, including non-served files. Requests use
exact index lookup, never a user-provided filesystem path. Before streaming, the
server checks ancestors, realpath, regular-file identity, inode/device, size and
mtime/ctime, then opens without following symlinks and rechecks the descriptor.
Install a replacement package between meetings; changing files in a live mount
makes those files unavailable until the next session.

Only GET is supported. Fixed MIME types allow `js`, `mjs`, `css`, `json`, `png`,
`jpg`, `jpeg`, `webp`, `psd`, `woff2`, and `html` only for the declared entry. There is no directory listing.
Responses carry `nosniff`, `no-store`, `no-referrer`, and CORS `*` only on package
files, which allows their opaque-origin renderer to load them. The entry response
CSP begins with `sandbox allow-scripts`; the iframe independently sets
`sandbox="allow-scripts" allow=""`. Neither grants same-origin privileges, forms,
popups or top navigation. Resource fetches are restricted to this mount; scripts
must come from this package mount and cannot be inline. Host CSP adds only `frame-src 'self'` to the
existing strict local-avatar policy. Media is denied. Package rules also prohibit
Web Audio: sandboxing alone cannot guarantee that arbitrary code never creates an
audio graph, so use renderer-only packages.

## Page audio (`faceAudio=page`, experimental)

By default the reply audio goes to Attendee over the WebSocket (`realtime_audio.bot_output`)
and the face follows it on a wall-clock marker timeline. With a self-hosted Attendee webpage
streamer, the host page's own audio travels with the page video on one WebRTC connection. So
the host page can play the reply itself, and voice and mouth come from one clock (#266).

- **Opt-in per join.** Select フェイスパッケージ explicitly in the join form and tick the page-audio
  checkbox; the form sends `faceAudio=page`. The join returns 400 unless the resolved avatar
  experiment is explicitly `face-package`, so "follow settings" plus `faceAudio=page` is always
  400. It also returns 400 while meet-floor-hub arbitration is enabled for the session. MCP
  `join_meeting` never sends the field.
- **Settings default (#274).** `face_audio_default` (`avatar.faceAudioDefault`, `""` or `page`,
  next-join) pre-sets the checkbox. It is shown only for face-package on a self-hosted
  Attendee; on Attendee cloud the screen shows a one-line note instead. Precedence: an explicit
  `faceAudio` field (`page` or an empty `faceAudio=`) wins with the validation above; only an
  absent field consults the default. The default turns page audio on only for a self-hosted
  Attendee, an explicitly resolved face-package join and no enabled floor hub; otherwise the
  join silently uses the WebSocket path and never fails because of the default. The join form
  reads the default and the host kind from `GET /info`. While the box is untouched the form
  sends no field (the server's default applies); once clicked, checked sends `faceAudio=page`
  and unchecked sends `faceAudio=` (explicit off).
- **Sample rates.** Inbound meeting audio stays a fixed 16 kHz: the Deepgram/Soniox STT
  providers, the mixed-STT window, the Discord 48k→16k decimation and wake calibration all
  assume it. The outgoing voice stays `tts_sample_rate`; with Attendee keep it at 8000, 16000
  or 24000, the only rates Attendee realtime audio accepts, because any reply can fall back to
  the WebSocket path. The rate at which Attendee captures the face page's audio is an
  Attendee-server setting (`WEBPAGE_STREAMER_AUDIO_SAMPLE_RATE` on a patched self-hosted
  Attendee; upstream is fixed at 16 kHz; 48 kHz recommended for this mode). meetmate does not
  change it and cannot read it.
- **One path per reply epoch.** Each output epoch is routed once, at its first chunk. It goes to
  the page if the page is audio-ready: its audio stream is open for the current generation, its
  last heartbeat is at most 1 s old and reports a running `AudioContext`, and its backlog is at
  most 2 s. Otherwise the epoch goes to the WebSocket exactly as today. An epoch never uses
  both paths and never switches mid-epoch. If the page stream dies mid-epoch, the rest of that
  epoch is not played; the next epoch falls back.
- **Transport.** The host posts a small heartbeat on its existing 100 ms `/local-avatar/state`
  poll. It opens `POST /local-avatar/audio?generation=<g>&v=<visualId>`, which applies exactly the
  `/local-avatar/state` checks: Bearer capability, visual id, `Origin`, live session, and
  generation. The response is a stream of length-prefixed frames, `pcm` and `cancel`:
  - one stream per session, and a new stream or generation supersedes the old one;
  - no replay;
  - the server queue is bounded to about 2 s;
  - `Cache-Control: no-store` and `X-Accel-Buffering: no`.
  A barge-in or reply cancel pushes a `cancel` frame, and the page stops that epoch's scheduled
  audio at once while keeping the stream open. For every chunk queued to the page, the server
  mirrors silence (same-length all-zero PCM) on the bot-output channel so Attendee keeps the
  bot's mic open.
- **The capability now also gates reply PCM.** The holder set is the same (the launched host page)
  and so is the TTL. Only a `faceAudio=page` session serves the audio route; every other session
  gets 404.
- **Packages stay audio-free.** The iframe sandbox (`allow-scripts`, `allow=""`), the package CSP
  (`media-src 'none'`) and the host CSP are unchanged. The host never forwards PCM, sample
  buffers or audio timing to the package. It sends the same Face Protocol v1 messages; only
  their clock changes: `speak-start` / `level` / `speak-end` follow the chunks the host
  actually scheduled.
- **Echo gate.** While page audio is projected or reported as backlog, meetmate drops meeting
  input. The gate also covers a fixed path pad of 300 ms plus the echo cooldown. A cancel
  re-opens the gate within that pad plus cooldown.
- **Self-hosted Attendee only.** Attendee cloud captures page audio at 16 kHz unless it is
  patched. Measurement procedures live in `tools/av-sync-probe/`, which is not shipped.

**ADR 09 amendment (2026-09-30, #266).** ADR 09 said the meeting pipeline exclusively owns sound.
Amended: the pipeline still decides what is said and when it is cancelled. In the opt-in
`faceAudio=page` mode, the meetmate-owned host page may *play* the reply for page-routed epochs.
Face packages remain renderer-only and audio-free in every mode. The default path is unchanged.

## Backend conversation continuity

If the agent backend is a Hermes `api_server`, it is stateless per request unless
`X-Hermes-Session-Id` is sent — set `llm.openaiCompatible.sessionHeader` to
`X-Hermes-Session-Id`, otherwise every reply starts from a blank conversation.
