# Live voice engine — Stage 1 prototype ("just make it talk")

Status: design r1 for a 3-seat review (2026-09-11). Owner decision 2026-09-11 (翔さん): before the full L implementation in `live-voice-engine.md`, build the **smallest straight-line prototype** that makes gpt-live-1 talk in a real Google Meet through meetmate **with Caty's Fish voice**, so the human experience can be judged before any hardening. Internal test only, dedicated branch, **not merged to main**. Generality is kept in the *shape* (same handler contract as the full design), not in features.

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

## What is built

### Switch and secrets (env only)

- `VOICE_ENGINE=live` (any other value or unset → today's behaviour, byte-for-byte). Read once at startup in `src/config.js` next to the existing env reads; **no settings-registry entry** in the prototype (so `docs/settings-contract.md` inventory/lock tests are untouched — the value is read via `process.env` directly and documented as a prototype-only knob).
- `OPENAI_LIVE_API_KEY` (env only, never written to `config.json`). Fish key: the existing effective `fish_audio_api_key`; voice: the existing effective `tts.voiceId` (Caty preset `0089dce5fefb4c6ba9b9f2f0debe1ddc` in the test home).
- Startup check: `VOICE_ENGINE=live` with a missing OpenAI key or `tts.provider != fish-audio` → one clear log line and the process stays in pipeline mode (no crash, no silent partial start).

### `createHandler` branch (`src/transport-meet/meet-routes.js`)

```js
if (VOICE_ENGINE === "live") return createLiveEngine(session, turnState, onAudio, { profile, config });
```

placed before the existing `PIPELINE_TTS_PROVIDERS` check. The returned object has the same keys the pipeline branch returns (`send / close / on / handleGateway* / getDelegationResults / floorStatus / continueWithoutArbitration`) so nothing downstream changes. Under `live`, the transport **echo gate is bypassed** (input keeps flowing while Caty speaks — required for interruption) and hub integration is disabled with the same warning legacy mode uses today.

### `src/live-openai/live-engine.js` (new, single module ≈ 300 lines)

1. **OpenAI Live client** — lifted from `docs/research/gpt-live-1-probe/probe.mjs` (WebSocket to `/v1/live/sessions`, `session.start` with `audio.format.rate = 16000`, `session.input_audio.append` for every Attendee chunk unmodified, `session.instructions` = agent profile prompt + the `silent-unless-addressed` block when `wakeMode = wake`, `session.close` on teardown, 20 s start / 10 s close timeouts). `session.output_audio.delta` is **dropped**. `session.usage.updated` is logged; at `session.closed` the billed `usage.seconds` and an estimated USD figure are logged.
2. **Fish live client** — `wss://api.fish.audio/v1/tts/live`, headers `Authorization: Bearer <key>` and `model: s2.1-pro`, MessagePack frames. Client events: `{event:"start", request:{text:"", reference_id, format:"pcm", sample_rate: TTS_SAMPLE_RATE, latency:"low"}}`, `{event:"text", text}`, `{event:"flush"}`, `{event:"stop"}`. Server events: `{event:"audio", audio:<bytes>}`, `{event:"finish", reason}`. Because the repo has no msgpack dependency and the Codex sandbox has no network, a **minimal msgpack codec** (`src/live-openai/msgpack-lite.js`, maps / str / bin / int / float / bool / nil / array only) is written in-repo with unit tests against known byte vectors.
3. **Forwarder** — every `session.output_transcript.delta` is sent to Fish as a `text` event immediately (no sentence buffering, no fragment/backchannel filtering — owner decision). A `flush` is sent when no delta has arrived for 600 ms. Fish `audio` bytes go to `onAudio(buffer)` through a **real-time pacer** (`TTS_SAMPLE_RATE` × 2 bytes per second) so `turnState.isAgentSpeaking` is true only while audio is actually being played into the meeting.
4. **Interruption (prototype detector)** — when a `session.input_transcript.delta` arrives while the Fish queue is non-empty, the engine: sends Fish `stop`, drops the queue, increments the output epoch (late audio from the old epoch is ignored), opens a fresh Fish socket for the next text, and emits `playback_cancelled`. This is deliberately naive; Stage 2 replaces it with the energy/gap detector from the full design (R-1).
5. **Delegation** — `session.delegation.created` (client target) → `src/llm-openclaw.js:streamChat(messages, { signal })` with the delegation text plus the last 12 transcript turns; the aggregated text is returned as one `session.commentary.append` under the delegation id. No progress notes, no cancellation on interruption; aborted only on `close()`.
6. **Cost cap** — hard-coded 60 minutes: a timer from `session.started` sends `session.close`, speaks 「時間の上限に達したので、ここで一度切りますね」 through Fish, and the handler stays silent afterwards.
7. **Gateway callbacks** — `handleGatewaySessionReply` / `handleGatewayAnnounceInjected` append the text as commentary; spawn/completion are logged only.

### Tests (minimum)

- `test/live-openai-msgpack.test.js` — encode/decode round-trips for the six event shapes and the byte vectors.
- `test/live-openai-forwarder.test.js` — fake OpenAI/Fish socket pair: delta → `text` ordering, 600 ms flush, interruption epoch drop, 60-minute cap sends `session.close`.
- Existing suite stays green with `VOICE_ENGINE` unset.

### Not built (Stage 2)

Settings-registry entries and UI, class-1 key storage, hub arbitration, Discord, fragment/backchannel policy, energy-based interruption, per-day cap, metrics table automation, docs beyond this note and a README paragraph.

## How 翔さん tries it (owner-assisted E2E)

1. In the test home (`~/claude-workspace/meetmate-demo-home-luca` or a copy), set `VOICE_ENGINE=live` and `OPENAI_LIVE_API_KEY` in `.env`; `tts.provider` must be `fish-audio` with Caty's `tts.voiceId`.
2. Start meetmate from the prototype worktree, join a Meet with the bot as usual, talk to Caty for a few minutes; try interrupting her mid-sentence and talking to another person without her name.
3. What to judge (human ears, no thresholds yet): does it feel like Caty (voice), does she react without a gap, does she stop when interrupted, does she stay quiet when not addressed, does the Fish voice trail the model's timing noticeably.
4. Cost: the log prints billed seconds at close; expect ≈ USD 0.05/min OpenAI + Fish characters.

## Files to touch (prediction — WIP declaration will confirm)

`src/live-openai/live-engine.js` (new), `src/live-openai/msgpack-lite.js` (new), `src/transport-meet/meet-routes.js` (createHandler branch, echo-gate bypass, hub warning), `src/config.js` (`VOICE_ENGINE` read), `test/live-openai-msgpack.test.js` (new), `test/live-openai-forwarder.test.js` (new), `docs/design/live-voice-engine-prototype.md` (this), `README.md` (one paragraph, prototype flag).

Not touched: `src/pipeline.js`, `src/tts-fish.js`, `src/settings/**`, `src/transport-discord/**`, `docs/cli-contract.md`, `docs/settings-contract.md`, `package.json`.

## Questions for the 3-seat design review

- **Q0 — If this framing is wrong for the goal "hear Caty's voice with gpt-live-1 timing in a real Meet as fast as possible", say so and propose the alternative.** (Examples we considered and rejected: using gpt-live-1's own audio with a preset voice — rejected by the owner in #251; sentence-buffered Fish HTTP — the measured 6 s failure mode.)
- Q1 Is the naive interruption detector (input transcript delta while Fish queue non-empty) good enough to *experience* barge-in, or will it misfire on backchannel-triggering noise so badly that the demo is misleading?
- Q2 Echo: with the transport echo gate bypassed, will Caty hear her own Fish voice through the Meet mix and answer herself? If likely, what is the smallest guard that keeps interruption working?
- Q3 Anything in the Fish live protocol or the msgpack-lite plan that will bite (framing, `flush` semantics, socket reuse after `stop`, sample rate 24000)?
- Q4 Anything that would force rework in Stage 2 if built this way (i.e., a shape decision, not a feature omission)?
