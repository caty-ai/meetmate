# #253 minimal Live / Hermes / Fish listening trial

Internal unmerged prototype; owner approval is required before sending a bot to Meet. No Stage 2, release, provider migration, or backend runtime changes.

## Shape

`Meet PCM → Live conversation ↔ live-backend.js → existing configured LLM adapter → Hermes`

`Live transcript → existing Fish live socket → existing PCM pacer → Meet`

The only new runtime module is `src/live-openai/live-backend.js`. Existing provider code is reused. The bridge returns completed Japanese sentences once as they arrive, rather than collecting the entire backend response. This does not remove Hermes model/harness latency. Live owns greetings/backchannels and voices results; substantive answers are delegated.

## Local checks (no Meet)

Run from this worktree with Node 26+, the existing dependencies, and a configured test home. Output directories must not exist. Logs include synthetic test transcripts and backend responses; keep them private and outside Git.

```sh
AI_MEET_HOME=/absolute/test-home node docs/research/live-voice-smoke/probe.cjs backend /absolute/new-backend-run
AI_MEET_HOME=/absolute/test-home node docs/research/live-voice-smoke/probe.cjs audio /absolute/new-audio-run /absolute/question.wav
```

`question.wav` must be PCM16 mono, 16 kHz, at most 15 seconds. The audio probe expects Japanese speech asking Caty to ask the backend for the verification code. It provides the code only to the real backend, not to Live, so seeing it return through Fish text demonstrates the client-delegation path. A local 55-second deadline requests Live close; the engine has its normal additional 10-second close timeout. This script never starts the Meet server or joins a meeting.

`trace.json` records input/output/delegation/backend and audio-delivery timestamps. `played.wav` and `fish-received.wav` concatenate PCM (they omit time spent waiting and are NOT latency demonstrations). Actual audible quality and Google Meet playback remain human listening checks.

## Measured 2026-09-12 (before human listening)

- Recovered the existing loopback SSH tunnel for the configured Hermes endpoint; the remote service answered HTTP 200 on `/health`.
- The existing test home selects `openai-compatible`, model identifier `hermes-luca-caty`, with no session-header or trusted-tools opt-in. The real backend introduced itself as Luca. Target identity is awaiting owner clarification; the bridge does not replace the backend persona. Read-only remote configuration shows the Luca profile uses `grok-4.6` via xAI; no remote settings were changed.
- Direct two-turn backend smoke: first result 14.162 s; second result 7.332 s. Both answered the self-contained code question. History was explicitly passed; this does not prove persistence across sessions.
- Real synthetic voice smoke: Live delegated to the real Hermes endpoint; the secret test phrase returned from Hermes and appeared in Live's output and Fish input. Backend wait 24.526 s. First PCM delivery was 2.045 s after synthetic input completion. Live session closed normally at 36 billed seconds. This is one run, not a latency distribution.
- Fish received PCM equaled delivered PCM byte-for-byte (423,390 bytes, 24 kHz mono). No cancellation, Fish socket-lost or engine-error events in this run. This checks delivery integrity, not pronunciation/naturalness.
- The initial probe summary tested proof presence in a single backend chunk and reported `proofReturned:false`; the phrase was split over chunks. Concatenating the saved backend chunks proves it returned. The probe now aggregates them. The raw original trace is preserved.
- Test-home animated-avatar experiment disabled in favor of the existing static image, with an owner-local config backup. No server or bot started.

## Before the next Meet listen

1. Confirm the intended Caty/Hermes identity with the owner. The previous test-home route is Luca's Hermes.
2. Verify the backend tunnel and chosen public audio origin. The test home still has a historical Tailscale `PUBLIC_WSS_URL`; pass the working ngrok WebSocket URL for the test join. Static avatar avoids that old animated-page origin.
3. Start the prototype server with the existing test home. Wait for the owner's explicit Meet-join signal and meeting URL.
4. Test one substantive question, one follow-up and one interruption. Judge backend response content and voice separately. Report waiting time, not merely Live's quick acknowledgment.
5. Leave, verify Attendee ended, stop test services/tunnels; restore any separately paused ngrok agent. Never reset unrelated Tailscale mappings.

## Deferred limits

Native Live timing is deliberately not preserved through Fish re-synthesis. Input-based interruption, small incomplete ASCII-tag holds, 300 ms idle flush, and existing Fish reconnect budget remain prototype choices. The backend connection works but backend speed is not yet satisfactory. Do not call this an optimized or fully hardened system.
