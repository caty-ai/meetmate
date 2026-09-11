# Live voice engine — follow-up L Issue skeleton

## Integration point

- Verified: `src/transport-meet/meet-routes.js:createHandler` selects `createPipeline` or a legacy agent and exposes `send`/`close` plus delegation and floor callbacks. TODO: define a Live alternative implementing the required handler lifecycle (unverified).
- Verified: the callback in `handleWsConnection` sends output through `onAudio` (`src/transport-meet/meet-routes.js`). TODO: specify teardown, error propagation and rollback before introducing another engine (unverified).
- TODO: select engine configuration without changing the frozen CLI/config contract in `docs/cli-contract.md` (unverified).

## Audio contract

- Verified: `docs/TECHNICAL.md` describes input STT as 16 kHz; `docs/transport-contract.md` specifies 16 kHz mono PCM ingress. `src/transport-meet/meet-routes.js` decodes base64 `realtime_audio.mixed.data.chunk` before `handler.send`. TODO: verify Attendee PCM16 end-to-end with captured samples (unverified).
- Verified: output is `realtime_audio.bot_output`, with base64 `data.chunk` and `data.sample_rate: TTS_SAMPLE_RATE` in `src/transport-meet/meet-routes.js`. Current input and output rates are independent; `docs/TECHNICAL.md` records 24 kHz output.
- TODO: negotiate Live output rate and reconcile the probe's assumed 16 kHz with transport output metadata; define buffering/resampling/backpressure and cancellation semantics (unverified).

## Client delegation → OpenClaw

- Verified: `src/llm-openclaw.js:streamChat(messages, options)` is an async generator of text chunks, accepts `options.signal`, and requires OpenClaw URL/token.
- TODO: map a client `session.delegation.created` ID and conversational context to `streamChat`, then return commentary under that ID; define chunk aggregation and ordering (unverified).
- TODO: retain per-delegation task lifetime, cancellation and late-result policy; an interruption of speech must not implicitly terminate useful work (unverified). Existing handler gateway callbacks in `src/transport-meet/meet-routes.js` need an explicit compatibility decision.

## Responsibility split (proposal; not implemented)

- Verified baseline: wake checks, floor integration and speech delivery live in `src/pipeline.js`; the transport also gates incoming echo in `src/transport-meet/meet-routes.js`.
- TODO: replace assumptions in this table with probe evidence and a Bridge interface contract (unverified).

| Responsibility | Model | Bridge |
|---|---|---|
| Wake word | Prompt-based addressed-only behavior (unverified) | Enforce reliable addressing policy if model cannot (unverified) |
| Speaker attribution | Mixed-audio distinction capability (unverified) | Preserve available transport identity; mixed stream cannot supply missing identity (unverified) |
| Floor hub | Conversational turn-taking (unverified) | Keep authoritative hub grants/fences from `src/floor-client.js` / `src/pipeline.js` (proposal, unverified) |
| Echo guard | Full-duplex echo robustness (unverified) | Reconcile current input-drop gate in `src/transport-meet/meet-routes.js` with uninterrupted listening (unverified) |
| Fillers | Brief Japanese backchannels during delegation (unverified) | Disable overlapping local fillers only after equivalence is shown; `src/pipeline.js` (unverified) |

## Voice question

- TODO: verify the stated 12 preset voices and select Japanese voice quality using the probe (unverified).
- TODO: verify custom voice availability/terms through OpenAI sales (unverified).
- Local TTS such as Irodori-TTS cannot simply be inserted into a full-duplex model's internal speech generation; replacing output would require a different composition and timing contract (unverified). Existing separate TTS providers are selected in `src/transport-meet/meet-routes.js` and composed by `src/pipeline.js`.

## Open questions

- TODO: measure Japanese latency, delegation backchannels, silent-unless-addressed compliance and interruption behavior with `docs/research/gpt-live-1-probe/` (unverified).
- TODO: establish echo leakage, speaker identity limits and multiple-agent floor arbitration using Attendee (unverified).
- TODO: confirm output rate, session usage accounting, disconnection recovery, and event ordering under a real account (unverified).

## Draft Done-when for L Issue

- TODO: freeze engine selection and handler/audio interfaces with cited contract amendments where needed (unverified).
- TODO: demonstrate measured addressing, latency, interruption and Japanese voice acceptance thresholds approved by the owner (unverified).
- TODO: demonstrate OpenClaw delegation success/failure/cancellation, floor/echo compatibility and rollback to the existing pipeline (unverified).
- TODO: pass repository canonical checks, obtain required independent review, and record actual usage/cost and operational limits (unverified).
