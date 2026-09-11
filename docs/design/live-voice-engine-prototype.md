# Live voice engine — Stage 1 prototype ("just make it talk")

Status: **design r2 (2026-09-11)** after the 3-seat design review (Opus 5 / GLM 5.3 / Grok 4.6, all GO-WITH-CHANGES) and Alpha's Fish `tts/live` probe. Owner decision 2026-09-11 (翔さん): before the full L implementation in `live-voice-engine.md`, build the **smallest straight-line prototype** that makes gpt-live-1 talk in a real Google Meet through meetmate **with Caty's Fish voice**, so the human experience can be judged before any hardening. Internal test only, dedicated branch, **not merged to main**. Generality is kept in the *shape* (same handler contract as the full design), not in features.

Owner answers folded in (2026-09-11):

| Question | Answer |
|---|---|
| Engine selection surface (full design) | settings UI + env alias — **deferred to Stage 2**; the prototype uses env only |
| Backchannels / cut-off fragments | **stream everything as-is** to Fish; decide a policy after listening |
| Cost guard | 60 minutes per meeting, per-meeting cap only (hard-coded in the prototype) |
| Discord | Meet only |
| Mid-session failure | no automatic fallback; set the env back and restart |
| Review | 3 heterogeneous seats on this prototype design (owner-approved downgrade from 5 for an unmerged internal branch); the full design gets 5 seats in Stage 2 |

## Goal (the one thing to prove)

A person in a Meet says 「キャティ、…」 and hears Caty answer in her own Fish voice with the gpt-live-1 timing (backchannels, no dead gap, can be interrupted). Everything else — settings UI, hub, Discord, tests beyond the codec/forwarder, per-day caps, metrics polish — is Stage 2.

## Fish `tts/live` probe (Alpha, 2026-09-11, Caty voice, `s2.1-pro`, `latency: low`, 4 short sessions, < USD 0.05)

| Question | Measured |
|---|---|
| Does `sample_rate: 24000` get honoured? | Yes. Same 34-char text: 249 520 bytes at 24000 vs 157 430 at 16000 (ratio 1.59 ≈ 1.5). No chipmunk risk at `TTS_SAMPLE_RATE = 24000`. |
| `flush` semantics | Audio starts **335–360 ms after `flush`** on a warm socket (first session ~730 ms). Three `text` deltas sent 300 ms apart produced **no audio until `flush`**. |
| More `text` after a `flush` on the same socket | Works; second sentence's first audio 357 ms after its `flush`. |
| `stop` | Server sends `finish {reason:"stop", time}` after draining; the socket stays open but **ignores any later `text`/`flush`** → a socket is dead after `stop`. |
| Framing | One msgpack object per WS message, `audio` is msgpack **bin**, chunks 15–56 KB, all even-length; no other server event types seen. |

Consequences: Fish socket is pre-opened and **never sent `stop` mid-session**; interruption = `ws.close()` the current socket and promote a pre-opened spare (cold-open cost hidden); `stop` only at engine close. Sentence-close buffering stays forbidden (owner); the 600 ms idle `flush` is the prototype's only closer.

## What is built

### Switch and secrets (env only)

- `VOICE_ENGINE=live` (any other value or unset → today's behaviour, byte-for-byte). `LIVE_ECHO_MODE=full-duplex|gated` (default `full-duplex`; escape hatch, see Echo). `OPENAI_LIVE_API_KEY` (env only, never written to `config.json`, never logged).
- **Env inventory lock (review finding, all 3 seats):** `test/paths.test.js` T12-02 and `test/settings-hardening.js` scan every `process.env.NAME` under `src/` against `docs/settings-env-inventory.json` (pinned at 99 names). The three new env reads are therefore **added to the inventory** as `env-only-readonly-diagnostic` (`VOICE_ENGINE`, `LIVE_ECHO_MODE`) and `env-only-never-admin-exposed` (`OPENAI_LIVE_API_KEY`), the pinned count moves 99 → 102 in the inventory, both tests and the one baseline sentence in `docs/settings-contract.md` §5. No registry entry, no UI, no schema — the settings contract's *registry* is untouched; only its inventory bookkeeping moves.
- Fish key: the existing effective `fish_audio_api_key`; voice: `getPipelineConfig(...).tts.referenceId` (registry path `tts.voiceId`; Caty preset `0089dce5fefb4c6ba9b9f2f0debe1ddc` in the test home). Model pinned to `s2.1-pro` for live (the registry default `s2-pro` is the HTTP default).
- Startup check: one resolved `liveEngineAvailable()` (env = live, OpenAI key present, `tts.provider = fish-audio`, Fish key + referenceId present) is used by **both** the `createHandler` branch and the echo-gate bypass. Missing pieces → one clear log line and the process stays in pipeline mode.

### `createHandler` branch (`src/transport-meet/meet-routes.js`)

Placed before the existing `PIPELINE_TTS_PROVIDERS` check; returns the same keys the pipeline branch returns (`send / close / on / handleGateway* / getDelegationResults / floorStatus / continueWithoutArbitration`) so nothing downstream changes. Under live: the transport echo gate is bypassed in `full-duplex` mode (input keeps flowing while Caty speaks — required for interruption and for the model to hear overlapping speech); in `gated` mode the existing gate applies unchanged. Hub integration is disabled with a warning (same posture as legacy mode; `logLegacyMode` is not called).

Contract note (GLM finding): this is a deliberate, engine-conditional deviation from `docs/transport-contract.md` D6 (`echoesOwnOutput: true` → gate). It is documented here, scoped to `VOICE_ENGINE=live`, and unmerged; Stage 2 amends the contract properly.

### `src/live-openai/live-engine.js` (new, single module)

1. **OpenAI Live client** — lifted from `docs/research/gpt-live-1-probe/probe.mjs` (`session.start` with `audio.format.rate = 16000`, `session.input_audio.append` for every Attendee chunk unmodified, `session.instructions` = agent profile prompt + the `silent-unless-addressed` block when `wakeMode = wake`, `session.close` on teardown, 20 s start / 10 s close timeouts). `session.output_audio.delta` is **dropped**. `session.usage.updated` logged; at `session.closed` the billed `usage.seconds` and an estimated USD figure are logged.
2. **Fish live client** — `wss://api.fish.audio/v1/tts/live`, headers `Authorization: Bearer <key>` and `model: s2.1-pro`, MessagePack frames (`start` request: `text:""`, `reference_id`, `format:"pcm"`, `sample_rate: TTS_SAMPLE_RATE`, `latency:"low"`; then `text` / `flush`; `stop` only at engine close). **Pre-opened at `session.started` plus one spare socket**; each socket is tagged with its output epoch at open. In-repo minimal msgpack codec (`src/live-openai/msgpack-lite.js`): decode str/bin as bytes and convert to UTF-8 only at the event layer; assert the whole frame was consumed; bin8/16/32, float32/64, all int widths; throw on ext/uint64.
3. **Forwarder** — every `session.output_transcript.delta` → Fish `text` immediately (no buffering, no filtering — owner decision). `flush` when no delta has arrived for 600 ms (`FLUSH_IDLE_MS`). Fish `audio` bytes are **stamped with the socket's epoch at enqueue**; odd trailing byte held until the next chunk; queue bounded at 15 000 ms (`MAX_QUEUED_AUDIO_MS`, drop oldest, log once per epoch). A 20 ms pacer drains at real time to `onAudio(buffer, { outputEpoch, firstSampleIndex, sampleRate })` (the D3 metadata the local avatar needs); `turnState.isAgentSpeaking` is true only while audio is being emitted and falls after 200 ms of empty queue.
4. **Interruption detector** (one replaceable function `detectInterruption`) fires only when **all** hold: (a) a `session.input_transcript.delta` arrives while the current epoch has queued audio or in-flight Fish text; (b) the input text is **not** a substring of the last ~40 chars sent to Fish (self-echo suppression); (c) ≥ 2 consecutive input deltas or ≥ 4 accumulated chars; (d) ≥ 500 ms since the first Fish audio byte of the current utterance. Also fires when no `session.output_transcript.delta` has arrived for ≥ 1500 ms while the current epoch is still "live" — i.e. condition (a) holds: queued audio not yet played, or text sent to Fish in this epoch whose audio has not fully arrived (the model already stopped itself). On fire: close the current Fish socket, promote the spare, clear the queue, `epoch++`, `turnState.isAgentSpeaking = false`, emit `playback_cancelled { outputEpoch: <cancelled epoch>, reason: "interrupted", monotonicTime }` (D4 payload). Every input transcript received while the pacer is draining is logged with a `🪞` prefix so the first Meet session shows whether echo is present.
5. **Delegation** — `session.delegation.created` (client target) → `streamChat(messages, { openclawUrl, openclawToken, sessionUser, model, temperature, maxTokens, signal })` with the gateway fields from `getPipelineConfig(...).llm` (the seats found the bare `{ signal }` call throws); messages = last 12 transcript turns + the delegation text; aggregated into one `session.commentary.append { delegation_id, content }`. Duplicate delegation ids are rejected (as the probe does); gateway callbacks use a separate `gateway-<n>` namespace. Aborted only on `close()`.
6. **Cost cap** — 60 minutes **per meeting session id** (module-level map keyed by `session.id`, so a handler re-creation on reconnect does not restart the clock): speaks 「時間の上限に達したので、ここで一度切りますね。」 via Fish, then `session.close`, then silent. All timers (flush, cap, pacer) are cleared in `close()`.
7. **Gateway callbacks** — `handleGatewaySessionReply` / `handleGatewayAnnounceInjected` append the text as commentary; spawn/completion are logged only.

### Tests (minimum, all with fake sockets injected through an options seam that defaults to real `ws`)

- `test/live-openai-msgpack.test.js` — byte vectors (`{event:"flush"}` = `81 a5 65 76 65 6e 74 a5 66 6c 75 73 68`; `bin` = `c4 03 01 02 03`), round-trips, full-frame consumption, throw on ext.
- `test/live-openai-forwarder.test.js` — delta → `text` ordering; `flush` at 600 ms and not before; interruption closes the socket, drops the queue, increments the epoch, **late audio from the old socket is ignored**, `playback_cancelled` carries the cancelled epoch; **overlapping input during a short 「うん」 does NOT fire** (self-echo / backchannel non-fire); odd-byte leftover; `onAudio` metadata keys; 60-min cap sends the closing line then `session.close`; `liveEngineAvailable()` reasons; `createHandler` with `VOICE_ENGINE` unset returns the pipeline handler unchanged.
- Existing suite green with `VOICE_ENGINE` unset (including the updated inventory count).

### Not built (Stage 2)

Settings-registry entries and UI, class-1 key storage, hub arbitration, Discord, fragment/backchannel policy, energy-based interruption, per-day cap, transport-contract amendment, metrics automation. **Named fallback if the live Fish path disappoints** (Opus seat): micro-chunked Fish **HTTP** through the existing `src/tts-fish.js` streaming path (~10–15 chars per request; the owner rejected *sentence-buffered* HTTP, not micro-chunking) — zero new protocol code, prosody seams at joins. Not built unless the owner asks.

## How 翔さん tries it (owner-assisted E2E) — first-listen script

1. In the test home (`~/claude-workspace/meetmate-demo-home-luca` or a copy), set `VOICE_ENGINE=live` and `OPENAI_LIVE_API_KEY` in `.env`; `tts.provider` must be `fish-audio` with Caty's `tts.voiceId`. Use **headphones** on the human side so the only echo path under test is Attendee's own mix.
2. Start meetmate from the prototype worktree, join a Meet with the bot as usual.
3. Four passes, in this order: (1) one addressed question 「キャティ、…」; (2) talk over her answer (barge-in); (3) a second person speaks without her name; (4) sit silent while she answers a longer question. Listen for: does it feel like Caty, no gap, does she stop when interrupted, does she stay quiet when not addressed, does she stutter or cut herself (self-echo), does the Fish voice trail noticeably.
4. If she cuts herself or answers herself: restart with `LIVE_ECHO_MODE=gated` and repeat pass (1) and (4) (barge-in is lost in that mode by design). Expected residual under `full-duplex`: interruption stops audio within ~0.5–1.5 s, and a backchannel 「うん」 through Fish lands ~0.3–0.6 s late.
5. Cost: the log prints billed seconds at close; expect ≈ USD 0.05/min OpenAI + Fish characters.

## Files to touch (prediction — WIP declaration confirms)

`src/live-openai/live-engine.js` (new), `src/live-openai/msgpack-lite.js` (new), `src/transport-meet/meet-routes.js` (createHandler branch, echo-gate bypass under full-duplex, hub warning), `src/config.js` (`VOICE_ENGINE`, `LIVE_ECHO_MODE` reads), `docs/settings-env-inventory.json` (+3 names, count 102), `docs/settings-contract.md` (§5 baseline sentence 99 → 102 only), `test/paths.test.js` + `test/settings-hardening.js` (pinned count), `test/live-openai-msgpack.test.js` (new), `test/live-openai-forwarder.test.js` (new), `docs/design/live-voice-engine-prototype.md` (this), `README.md` (one paragraph).

Not touched: `src/pipeline.js`, `src/tts-fish.js`, `src/settings/**`, `src/transport-discord/**`, `docs/cli-contract.md`, `docs/transport-contract.md`, `package.json`.

## Review record (r1 → r2)

| Seat | requested / actual | effort | verdict | headline findings (how r2 answers) |
|---|---|---|---|---|
| Opus 5 | opus-5 / claude-opus-5 (Agent code-reviewer) | high | GO-WITH-CHANGES | CRITICAL self-echo + naive detector (→ detector (b)–(d), `LIVE_ECHO_MODE`); CRITICAL env inventory lock (→ inventory +3, count 102); MAJOR streamChat options, onAudio metadata, chunk_length, cold socket, per-handler cap, stale-epoch leaks, 24 kHz unverified, unbounded queue (→ all addressed; 24 kHz measured). Sequencing: Fish probe first (→ done). Recommended default `gated`; r2 keeps `full-duplex` default with suppression + escape hatch (Grok/GLM: gating hides backchannels and drops overlapping user speech) — owner flips on first listen. |
| GLM 5.3 | glm-5.3 / glm-5.3 | default | GO-WITH-CHANGES | MAJOR inventory lock, echo, streamChat, D6 deviation unacknowledged (→ contract note above); MINOR epoch binding, D4 payload, codec bytes-first, queue cap, single resolved flag, probe first, run-book expectations (→ all addressed). |
| Grok 4.6 | grok-4.6 / grok-4.6 | high | GO-WITH-CHANGES | CRITICAL detector kills backchannels / self-cut, echo, inventory lock (→ addressed); MAJOR streamChat, cold open (→ spare socket), 24 kHz (→ measured), D3/D4 drift (→ addressed); MINOR queue cap, odd bytes, `s2.1-pro`, no `logLegacyMode` (→ addressed). |

Q0 (framing) — all three seats: framing is right; Opus: sequencing (probe first) — done. Alpha does not count as a seat; verdicts are adjudicated on evidence, not counted.
