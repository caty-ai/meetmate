# Live voice engine (`voice.engine = live`) — design note for the L Issue

Status: **design review draft r1 (2026-09-11)**. Every bullet is one of: **Decided** (with the evidence or the contract it rests on), **Open (owner)** (needs 翔さん's answer; see "Owner questions"), or **Open (reviewer)** (a technical question the design review must answer or accept as an E2E measurement). Nothing in this note is implemented; `src/` is untouched on this branch.

Shape in one sentence: gpt-live-1 is the **ears and the conversational brain** (full-duplex listening, turn-taking, backchannels, deciding when to delegate), OpenClaw stays the **knowledge brain** (delegation target), and Fish Audio `tts/live` is the **mouth** (Caty's voice); the model's own audio is discarded.

## 1. Probe evidence (2026-09-11, `docs/research/gpt-live-1-probe/README.md#results`)

- Full-duplex behaviour confirmed in Japanese: backchannel 「うん」 during user speech, no perceptible gap before answers, honest paraphrase of client-delegation commentary.
- Fillers during delegation are produced by the model itself (「ちょっと調べてみるね。確認してるよ、もう少し待ってね」).
- Silent-unless-addressed held **0/6** unaddressed lines in two runs with synthetic two-speaker audio (clean `say` voices, name spoken clearly). Prompt-based only.
- Interruption: the model cut its own speech within the same second and acknowledged the interrupter.
- Wire facts (from `runs/*/events.jsonl`, 4 sessions): server events seen are `session.started`, `session.input_transcript.delta`, `session.output_transcript.delta`, `session.output_audio.delta` (continuous, includes silence, ~32 kB/s at 16 kHz), `session.delegation.created`, `session.commentary.appended`, `session.instructions.appended`, `session.thinking.appended`, `session.usage.updated` (every 15 s), `session.closed` (carries `usage.seconds` = billed figure). **No dedicated "output cancelled / turn ended" event was observed** — see Open (reviewer) R-1.
- Cost: 226 billed seconds, ~USD 0.19 (USD 0.05/min, per second). Fish `tts/live` cost is per character (assumed USD 15 / 1M chars, unverified).
- Voice decision (#251, owner 2026-09-11): **Path 3** — discard gpt-live-1 audio, stream `session.output_transcript.delta` into Fish Audio `wss://api.fish.audio/v1/tts/live` (Caty preset `fish-neutral-ja-v1`), play Fish PCM into `bot_output`. Measured: transcript leads audio by 0.3–1.2 s; Fish TTFB ~0.3 s warm (1.1 s cold); added delay floor ~0.3 s; sentence-close buffering (6 s) is the failure mode. Path 2 (Seed-VC) rejected: Japanese intonation.

## 2. Integration point

- **Decided — where.** `src/transport-meet/meet-routes.js:createHandler(session, turnState, onAudio)` gains a first branch: if the effective `voice_engine` is `live`, return `createLiveEngine(session, turnState, onAudio, config, hooks)` from the new module `src/live-openai/live-engine.js`. The existing `createPipeline` branch and the legacy branch are unchanged. The Live engine returns the **same handler shape** the pipeline branch returns today: `{ send, close, on, handleGatewaySubagentSpawn, handleGatewaySubagentCompletion, handleGatewaySessionReply, handleGatewayAnnounceInjected, getDelegationResults, floorStatus, continueWithoutArbitration }` (verified at `meet-routes.js:824-833`), so `handleWsConnection` and the local-avatar `playback_cancelled` / `exit_requested` listeners (`meet-routes.js:1806-1830`) need no change.
- **Decided — lifecycle.** `send(buf)` forwards Attendee PCM to `session.input_audio.append`. `close()` sends `session.close`, waits for `session.closed` (10 s timeout, as in the probe), closes the Fish live socket, cancels any in-flight OpenClaw delegation `AbortSignal`, and emits a final `usage` log line. All OpenAI/Fish socket errors surface as `engine_error` events on the handler emitter plus one diagnostic-ID log line (`docs/diagnostic-ids.md` conventions); the session then behaves exactly like a pipeline TTS hard failure today (bot goes silent; the meeting session is not torn down by the engine).
- **Decided — no mid-session automatic fallback** from Live to the pipeline engine. Reason: a silent switch would double-bill (two vendors already open), change the voice mid-meeting, and hide the failure from the operator. Rollback is operational: set `voice.engine` back to `pipeline` (the default) and restart. **Open (owner) Q5** confirms this expectation.
- **Decided — engine selection surface.** `docs/cli-contract.md` (frozen) freezes the `init` wizard prompt sequence and the config-resolution tiers; it does not freeze the settings registry. The engine is a new **settings-registry entry** (`docs/settings-contract.md` §1 shape): `voice_engine` → `voice.engine`, `enum(pipeline,live)` / `pipeline`, `ux: detail`, `credential: none`, `apply: restart-required`, `envAlias: VOICE_ENGINE`. It is **not** added to the init wizard. This satisfies the four-tier precedence without amending the frozen contract. **Open (owner) Q1** asks whether the UI (detail tab) exposure is wanted from day one or env-only first.
- **Decided — new secret.** `openai_live_api_key` → `voice.live.openaiApiKey`, `secret`, class-1, `envAlias: OPENAI_LIVE_API_KEY`. It is separate from `OPENAI_COMPATIBLE_API_KEY` (which the contract keeps environment-only for the LLM provider). Fish reuses the existing `fish_audio_api_key`; the Live engine requires `tts.provider = fish-audio` (setup-mode validation error otherwise).
- **Decided — Discord transport is out of scope for this Issue.** `src/transport-discord/discord-session.js:113` constructs `createPipeline` directly; wiring the Live engine there is a separate S/M Issue after the Meet path is measured. **Open (owner) Q4** confirms.
- **Decided — floor hub.** Same posture as legacy mode today (`meet-routes.js:1949`): when `voice.engine = live` and `HUB_*` is configured, log the warning and disable hub integration; `floorStatus()` reports `{ enabled: false, engine: "live" }` and `continueWithoutArbitration()` is a no-op. Multi-agent floor arbitration with a full-duplex model is a later design.

## 3. Audio contract

- **Decided — input.** Attendee delivers 16 kHz mono PCM16 (`docs/transport-contract.md` normative ingress; `meet-routes.js` base64-decodes `realtime_audio.mixed.data.chunk`). The Live session is started with `audio.format.rate = 16000` exactly as the probe did, and frames are forwarded **unmodified and unpaced** (Attendee already paces at real time). No resampler in the Bridge.
- **Decided — output.** gpt-live-1 `session.output_audio.delta` is **discarded** except for a per-delta RMS computation used only for metrics (§7). Fish `tts/live` is requested at `tts.sampleRate` (default 24000 — the global v1 setting that `docs/transport-contract.md` forbids changing), format PCM16 mono, `latency: low`, model `s2.1-pro` as probed. Fish PCM chunks are emitted through `onAudio(buffer, metadata)` unchanged, so `bot_output` framing, `TTS_SAMPLE_RATE`, the TTS cache key and pre-rendered `audio_clips` are untouched.
- **Decided — streaming, not sentence buffering.** Each `session.output_transcript.delta` is forwarded to the open Fish live socket as an incremental `text` event as it arrives. The `src/pipeline.js` two-tier splitter (`findSplitPoint` / `SENTENCE_PAUSE_MS`) is **not** reused — its close-on-punctuation rule is the measured 6 s failure mode. A Fish `flush` is sent when the transcript stream pauses > `live.flushGapMs` (default 600 ms, the probe's `--gap-ms`) so short answers are not held.
- **Decided — pacing and backpressure.** Fish returns audio faster than real time; the Bridge keeps a bounded output queue (cap: `live.maxQueuedAudioMs`, default 15000 = `MAX_AUDIO_DURATION_MS` in `src/tts-pcm-stream.js`) and pushes to `onAudio` at real-time pace so `turnState.isAgentSpeaking` reflects what the meeting actually hears. Overflow beyond the cap drops the **oldest queued text** not yet sent to Fish (never audio already in flight) and logs it.
- **Decided — cancellation (same tick).** On an interruption signal (R-1), the Bridge (a) sends Fish `stop` and closes/reopens the live socket, (b) clears the output queue, (c) marks a new "output epoch" so late Fish chunks from the cancelled epoch are ignored, (d) emits `playback_cancelled` for the local-avatar listener. Target: no Fish audio from the cancelled utterance reaches `bot_output` more than 200 ms after the signal.
- **Decided — fragments and backchannels are Bridge settings.** `live.voiceBackchannels` (voice 「うん / はい / なるほど / ええ」 via Fish, or drop) and `live.voiceFragments` (voice cut-off text such as 「力を抜」, or drop). Both are `apply: restart-required` and detail-tab. Defaults: **Open (owner) Q2** (Alpha recommends: fragments drop, backchannels voice — the measured backchannel latency through Fish is ~0.3 s which still lands inside the user's utterance).

## 4. Client delegation → OpenClaw

- **Decided — mapping.** On `session.delegation.created` with a client target, the Bridge builds the messages from the delegation payload text plus the last `llm.historyMaxTurns` input/output transcript turns, and calls `src/llm-openclaw.js:streamChat(messages, { signal, onFirstEvent })`. Chunks are aggregated into **one** `session.commentary.append` under the delegation `id` when the stream ends (the probe's shape); intermediate `session.thinking.append` progress notes are sent at most every `live.thinkingNoteMs` (default 4000) so the model keeps backchanneling honestly. Multiple concurrent delegations are allowed and tracked by `id`; results are returned per id, in completion order.
- **Decided — lifetime.** A user interruption does **not** abort an in-flight OpenClaw call (useful work). The delegation is aborted only on `close()` or on the existing per-task timeout (`docs/task-timeout-handoff-spec.md` values reused). A late result after the model has moved on is still appended as commentary; the model decides whether to voice it (probe showed it paraphrases honestly).
- **Decided — gateway callbacks.** `handleGatewaySessionReply` and `handleGatewayAnnounceInjected` append the reply text via `session.commentary.append` under a synthetic id (so background-delegation results reach the model as context); `handleGatewaySubagentSpawn` / `handleGatewaySubagentCompletion` are recorded in `getDelegationResults()` and logged, nothing more, in v1. **Open (reviewer) R-3** asks whether this is an acceptable v1 or the announce text must be voiced verbatim.
- **Decided — persona.** `session.instructions` at start = the agent profile prompt (`currentAgentProfile()` / `getPipelineConfig` composition reused), plus the `silent-unless-addressed` block when `wakeMode = wake`, plus the delegation policy text from `prompts/caty-default.txt` adapted.

## 5. Responsibility split

| Responsibility | Model (gpt-live-1) | Bridge (meetmate) | Basis |
|---|---|---|---|
| Wake word | Addressed-only behaviour via instructions (`wakeMode = wake`); `always` mode omits the block | Does not gate audio. Logs wake-word hits on `session.input_transcript.delta` for the metric "unaddressed lines answered" (§7). Authoritative policy remains a prompt, so the E2E threshold (§7) is the gate | Probe 0/6 synthetic; real-meeting adherence is a Done-when measurement |
| Speaker attribution | None (mixed stream) | None added; identical to today's mixed-audio pipeline | Attendee mixed audio has no per-speaker identity on this path |
| Floor hub | Conversational turn-taking only | Hub disabled with warning (§2) | Legacy-mode precedent `meet-routes.js:1949` |
| Echo guard | Full-duplex robustness (model must not answer its own Fish voice) | **`live.echoMode`**: `full-duplex` (default; the transport echo gate `meet-routes.js:1862-1877` is bypassed so interruption works) or `gated` (gate input while Fish is speaking + `inputCooldownUntil`, losing barge-in). `turnState.isAgentSpeaking` is driven by the Fish output queue, not by model audio | **Open (reviewer) R-2**: self-hearing in a real Meet is unmeasured; `gated` is the fallback if the E2E shows self-answers |
| Fillers / progress pings | Produced by the model during delegation | `src/pipeline.js` ack / progress-ping / fallback speech paths are **not instantiated** under the Live engine (the pipeline object is never created) | Probe transcript |
| Voice | Discarded | Fish `tts/live` with the agent's `tts.voiceId` | #251 Path 3 |
| Cost guard | — | `live.maxSessionMinutes` (default: **Open (owner) Q3**); on reaching the cap the engine sends `session.close`, voices one fixed line via Fish (「時間の上限に達したので、ここで一度切りますね」), and the handler goes silent. `session.usage.updated` is logged every 15 s with cumulative billed seconds and estimated USD; `session.closed.usage.seconds` and Fish character count are written to the session summary | 課金・支出 = high-risk area (handbook docs/06) |

## 6. Voice question — closed by #251

- 12 preset voices / custom voice via OpenAI sales: **N/A** under Path 3 (model audio is discarded). The custom-voice request stays a parallel, optional owner action and is not a dependency.
- Local TTS (Irodori-TTS, #126) is compatible with this design in principle because the mouth is already external; it is not in scope for this Issue.

## 7. Measurements the L Issue must produce (live E2E with a real Meet via Attendee, owner-assisted)

| Metric | Threshold (proposed) | How |
|---|---|---|
| Added delay, transcript delta → first Fish audio in `bot_output` | p50 ≤ 0.8 s, p95 ≤ 1.5 s | Bridge log timestamps per utterance |
| Interruption: last cancelled-epoch audio after signal | ≤ 200 ms | Bridge log + recording |
| Unaddressed lines answered (two real speakers, ≥ 10 unaddressed lines) | ≤ 1 / 10 in `wake` mode | Human count from the recording |
| Self-answer / echo loop | 0 in a 10-minute session (`full-duplex`); otherwise switch to `gated` and re-measure | Recording |
| Cost | Reported billed seconds and Fish chars per session; `maxSessionMinutes` cap demonstrated once | `session.closed.usage`, Fish response headers |
| Rollback | `voice.engine = pipeline` + restart returns to today's behaviour with no leftover sockets | Manual + `lsof` |

## 8. Open questions

**Owner (clarify batch, one AskUserQuestion, ≤ 5):**
- Q1 Engine selection surface: settings registry entry with env alias **and** settings UI (detail tab) from day one, or env alias only first (UI in a follow-up)?
- Q2 Default voicing policy: fragments drop + backchannels voice (recommended) / both voice / both drop?
- Q3 Cost guard default for `live.maxSessionMinutes` (60 recommended; a normal meeting) — and is a per-session cap enough for v1, or is a daily cap required too?
- Q4 Discord transport: out of scope for this Issue (recommended) or in scope?
- Q5 Rollback expectation: operational only (setting + restart, recommended) or also an automatic mid-session fallback to the pipeline engine?

**Reviewer (design review r1; answer, or convert into a Done-when measurement):**
- **Q0 — If the framing itself is wrong (ears = gpt-live-1, mouth = Fish, brain = OpenClaw, engine beside `createPipeline`), say so and propose the alternative.**
- R-1 Interruption signal: no explicit cancel/turn-end server event was observed in 4 sessions. Proposed detector: user speech energy on the input (RMS over 100 ms windows above a threshold) **while** Fish is speaking, OR a `session.output_transcript.delta` gap > 1.5 s while Fish still has queued text. Is there a better wire signal (official docs), and is the proposed detector acceptable for v1?
- R-2 Echo: is `full-duplex` a safe default given Meet's mixed audio may contain the bot's own output through participants' speakers, or should `gated` be the default until measured?
- R-3 Gateway callbacks: is "append as commentary, do not voice verbatim" an acceptable v1 for `handleGatewayAnnounceInjected`?
- R-4 Fish `tts/live`: does the live endpoint honour `sample_rate: 24000` and a `stop` event with the semantics assumed in §3? (Alpha will run a 2-minute Fish live probe before implementation if the review asks; cost < USD 0.05.)
- R-5 Secret boundary: is a new class-1 setting `openai_live_api_key` the right shape, or should the key be env-only like `OPENAI_COMPATIBLE_API_KEY`?

## 9. Draft L Issue

**Why.** Today's pipeline (STT → LLM → sentence-split TTS) has a measured 2–6 s gap and cannot backchannel, interrupt, or be interrupted. gpt-live-1 gives full-duplex Japanese conversation with ~0.1 s reaction, and #251 fixed the voice path so Caty keeps her Fish voice. Without an engine switch the meetmate bot stays turn-based.

**Done when.**
- [ ] `voice_engine` and `openai_live_api_key` registry entries land with schema, masking, env alias and inventory lock tests (`docs/settings-contract.md` §5 / §12) passing; `voice.engine = pipeline` default leaves every existing test green
- [ ] `src/live-openai/live-engine.js` implements the handler shape in §2 with unit tests on a fake socket pair (start/close, delta → Fish text, flush gap, cancellation epoch, queue cap, usage cap)
- [ ] `createHandler` selects the Live engine only when `voice.engine = live` and `tts.provider = fish-audio`; setup-mode validation rejects other combinations with a setup issue
- [ ] Hub disabled with warning under Live; Discord unchanged
- [ ] Live E2E in a real Meet (owner-assisted) with the §7 table filled in and thresholds met, or a HOLD with the measured numbers
- [ ] Cost: `session.usage.updated` log line, `session.closed.usage.seconds` + Fish chars in the session summary, `live.maxSessionMinutes` demonstrated once
- [ ] Rollback demonstrated (§7 last row)
- [ ] `docs/TECHNICAL.md`, `docs/settings-contract.md` (registry table), `docs/transport-contract.md` (lane note: Live engine output path) updated; README one-paragraph mention
- [ ] 5-seat merge review (課金・支出), L1-7 record, CI green, annotated tag + GitHub Release

**Files to touch (prediction).** `src/live-openai/live-engine.js` (new), `src/live-openai/openai-live-client.js` (new; WebSocket client from the probe), `src/live-openai/fish-live-client.js` (new), `src/transport-meet/meet-routes.js` (`createHandler` branch + echo-gate bypass under Live + hub warning), `src/settings/registry.js` (2 entries) and its inventory JSON `docs/settings-env-inventory.json`, `src/config.js` (effective values), `test/live-openai-*.test.js` (new), `docs/TECHNICAL.md`, `docs/settings-contract.md`, `docs/transport-contract.md`, `README.md`. Not touched: `src/pipeline.js`, `src/transport-discord/**`, `docs/cli-contract.md`.

**Size.** L (new module beside `createPipeline`, boundary change in `createHandler`, new vendor secret). **High-risk: 課金・支出 + secret boundary → 5 heterogeneous seats** for design (this note) and for merge.
