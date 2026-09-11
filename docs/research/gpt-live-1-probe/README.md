# GPT-Live-1 probe — Issue #248

Standalone research tool; no production integration. Node 26, the repository's existing `ws`, macOS `say`, and `ffmpeg`/`ffprobe` only. No API key is needed for fixture generation or tests. Live results below are intentionally blank.

## Run

From this directory:

```bash
bash make-fixtures.sh
export OPENAI_API_KEY='<your key>'
node probe.mjs --input fixtures/solo.wav --thinking-progress
node probe.mjs --input fixtures/two-speaker.wav --instructions-file prompts/silent-unless-addressed.txt
# Choose a time inside solo's silence while the model is speaking (e.g. 6000;
# inspect the generated segment table and a baseline run first).
node probe.mjs --input fixtures/solo.wav --interrupt-at-ms 6000 --interrupt-input fixtures/interrupt.wav
```

Optional: `--voice quartz`, `--instructions-file prompts/caty-default.txt`,
`--append-instruction "返答を一文にしてください。"`, `--backend-delay-ms 5000`,
`--tail-ms 6000`, `--out runs/<unique-name>/`. Relative paths resolve from the shell's working directory; default prompts, interruption fixture and timestamped runs resolve next to the script. Existing `events.jsonl` is never overwritten.

The simulated backend waits a fresh random 3000–8000 ms per client delegation unless a delay is supplied. `--thinking-progress` emits a midway progress note. The canned Japanese commentary explicitly says it is a test and does not claim to have fetched weather or other facts. Pending backend timers are canceled when closing; use a longer tail to observe a late delegation. Tail silence is actually streamed. Startup and close acknowledgement have 20 s and 10 s timeouts. Missing key, invalid input/sidecar, server error, malformed output, pacing more than 100 ms late, and premature socket close fail nonzero. Partial reports survive connection failures.

`--interrupt-at-ms` is relative to the first input audio send, rounded up to a 20 ms boundary. It inserts `interrupt.wav`, then resumes the base fixture, shifting later segment timestamps. It must be within the base fixture and outside a speech segment. This avoids ambiguous overlapping ground-truth utterances; pick a baseline output-speaking interval inside a silence gap. The probe does not play audio locally.

## Fixtures and cost

`make-fixtures.sh` uses Kyoko for A and resolves the Japanese (`ja_JP`) Eddy voice for B from `say -v '?'` (plain `Eddy` is locale-ambiguous). Each converted clip's duration comes from `ffprobe -show_entries format=duration`, rounded to the nearest 16 kHz sample. The segment table records those clip boundaries, including any leading/trailing silence emitted by `say`; it is a known fixture reference, not an acoustic VAD measurement. All three fixtures are built in a temporary directory before publication. Re-running replaces them. Empty/unknown durations fail instead of publishing misleading silence-only fixtures.

- `solo`: three addressed questions, including a Fukuoka weather lookup; 8 s after each.
- `two-speaker`: five lunch-planning lines, targeted at about 40 s including 1.5 s gaps, then one addressed lunch question, 8 s silence, one unaddressed line and 8 s silence. Six unaddressed lines total. Actual duration depends on installed voice versions; inspect the printed table.
- `interrupt`: one short interruption, no added silence.

[GPT-Live pricing](https://developers.openai.com/api/docs/models/gpt-live-1) checked 2026-09-11: USD 0.05/min, billed per second. Audio-only estimate for **each fixture** is `ffprobe duration_seconds / 60 * 0.05`; the generator prints it. For a session add the tail, startup and close time. With typical solo <60 s, two-speaker <90 s, interrupt <10 s, their standalone runs plus three 6 s tails cost <USD 0.15 before connection overhead. The three commands above reuse solo for the interruption trial: expected total <USD 1. These are planning bounds, not measured costs. No paid backend is invoked. Compare the actual invoice with the [OpenAI usage page](https://platform.openai.com/usage).

## Protocol and outputs

Uses the Issue #248 protocol and the official [Live WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets?api=live): `/v1/live/sessions`, bearer header, first `session.start`, wait for `session.started`, paced `session.input_audio.append`, finally `session.close` and `session.closed`. The [session guide](https://developers.openai.com/api/docs/guides/live-conversations) documents instruction/context appends and usage. No Realtime API events are sent.

**Output-rate assumption:** `session.output_audio.delta` contains mono PCM16 at the negotiated `session.audio.format.rate` (16000 Hz). This probe assumes that rate rather than detecting it. Confirm against a live session before interpreting playback speed or interruption results.

- `events.jsonl`: every sent client event and received server event, receive/send `t_ms` from `performance.now()` since connection initiation. Audio strings become `audio_bytes`; all other event fields are retained. Input rows also record `input_offset_ms`. Local `kind: "probe"` rows contain the effective segment table, interruption marker or failure; these are log metadata, never wire events. Transcript/instructions remain readable in these research files.
- `output.wav`: concatenated received PCM, with a 44-byte mono PCM16/16 kHz WAV header. Network gaps are not inserted, so listen with the event timeline for timing interpretation.
- `transcript.md`: interleaved input/output deltas in receive order, carrying server `start_ms`/`end_ms` and local receive time. Deltas are not merged into linguistic sentences.
- `metrics.json`, `metrics.md`: the same report in JSON and readable Markdown.

## Metric definitions and limits

- `first_output_audio_latency_ms`: per utterance, first received audio at/after its known speech end and before the next utterance starts, minus speech end. The end is mapped from sidecar sample offsets onto the recorded send time of the containing chunk plus the intra-chunk sample duration. No VAD or nominal socket-start offset is used. Missing observations are `null`; p50 excludes them. Output before speech end is not response latency. Without response IDs, late previous answers or ongoing backchannels can enter a following window: inspect the transcript manually.
- `backchannel_events`: output transcript deltas received while at least one client delegation is open, before its commentary send. Includes text and delegation IDs; multiple open delegations do not duplicate a delta. This operational definition can include content beyond literal backchannels.
- `delegation_count`: client-target delegation creations.
- `unaddressed_response_count`: number of `addressed:false` fixture lines with any received audio between that line's start and the next line's start (last line: session end). Maximum one per line; not transcript-token count. Includes during-speech backchannels. Delayed answers can be misattributed; manually audit. `unaddressed_line_count` is the denominator (6 for the two-speaker fixture). No sidecar yields no latency/tally evidence, rather than inferred labels.
- `interruption_handled`: receive-stream proxy, not proof of audible cancellation. Requires output activity within 100 ms before injection and at least 1200 ms of subsequent observation. `true` means a ≥200 ms receive gap begins within 1000 ms of injection; `false` means none does; `null` means no injection or insufficient evidence. Natural pauses/network jitter can look like stops; buffered playback and resumed/new answers cannot be distinguished. Verify by listening and repeat with an appropriate injection time.
- `usage`: unchanged from server `session.closed`, or `null` on failed/incomplete runs. `session_duration_ms` is elapsed real session time measured monotonically from connection attempt through final event, so connection overhead is included. `estimated_cost_usd = session_duration_ms / 60000 * 0.05`, not the invoice.

## Offline checks and replay

```bash
node --test docs/research/gpt-live-1-probe/ # from repository root
# Or: node --test probe.test.mjs          # from this directory
```

`index.js` only enables the directory command on Node 26.5. Tests generate PCM in OS temp, fake the clock and socket, and test reports from synthetic JSONL without API access. To recompute reports from a recorded log, import `metrics(events, segments)` or `writeReports(out, events, segments, pcmBuffers)` from `probe.mjs`. Get `segments` from the `kind:probe,name:run` row. Audio cannot be recovered from redacted JSONL; pass `parseWav(readFileSync('output.wav'))` as the sole PCM buffer. Imports never open a socket.

## Results (complete only after live runs)

| Measurement | Result | Run / notes |
|---|---|---|
| Solo latency p50 | | |
| Backchannel observed | | |
| Interruption OK | | |
| Unaddressed responses (out of 6 unaddressed lines) | | |
| Japanese quality (free text) | | |
| Usage from session.closed | | |
| Actual cost from OpenAI usage page | | |
