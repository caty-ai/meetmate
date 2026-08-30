# Claude Code integration smoke test — 2026-08-30

Status: **supported** (README row flipped in this change)

Re-run of the [2026-07-23 smoke test](claude-code-smoke-test-2026-07-23.md) on
current `main` (v8.8.0 era), covering the four follow-ups that had held the
README row back, with one requirement replaced by owner decision
([#92](https://github.com/caty-ai/meetmate/issues/92)): instead of recording a
clean barge-in, interruption behavior is observed and documented as-is.

## Configuration under test

- Meetmate provider: `openai-compatible` (no Claude-specific provider branch)
- Bridge: Claude Code gateway (`/v1/chat/completions`, `CATY_BACKEND=claude`),
  dedicated bearer token, `X-Caty-Agent-Trust: trusted` required
- Conversation source of truth: Claude Code native session
- Meetmate history: `historyMaxTurns: 0`
- Empty-response replay: `emptyResponseRetry: false`
- Tool-capable gateway opt-in: `trustedAgentTools: true`
- `LLM_RESPONSE_TIMEOUT_MS=60000`
- Meeting scope: private, trusted, organizer-owned Google Meet, `one_to_one` mode
- STT: Soniox (07-23 used Deepgram)
- TTS: Fish Audio
- Display: static `avatar.png` (no lip-sync or rig experiments enabled)

No production gateway, public repository, or deployment was changed. The run
used a dedicated `AI_MEET_HOME` test home and a dedicated gateway instance.

## Local gateway and contract checks

Gateway suite on the bridge side: 790 tests, 0 failures. Live contract checks
against the running gateway:

| Check | Result |
| --- | --- |
| Non-stream OpenAI-compatible JSON | Pass |
| Streaming SSE deltas and `[DONE]` | Pass |
| Meetmate `openai-compatible` client (real `src/llm-openai.js`, both paths) | Pass |
| Same-session multi-turn recall | Pass |
| Different-session isolation | Pass (see note) |
| Client abort followed by same-session reconnect | Pass (`409` while the backend turn finishes, `200` at ~10 s) |
| One-second backend deadline | Pass (`504 timeout`) |
| Concurrent same-session request | Pass (`409 session_busy`) |
| Dedicated token and trusted-meeting header | Pass (`401` / `403` fail-closed) |

**Isolation note.** A first isolation attempt failed for an instructive reason:
the test prompt said "remember this", so the resident agent wrote the nonce
into its persistent memory layer, and a different session recalled it from
there. The native sessions themselves were correctly distinct (separate
transcripts, no mixing). Re-run with an explicitly conversation-only nonce:
recall passed in-session, isolation passed across sessions. Implication worth
stating plainly: the gateway isolates *conversation state* per `user` key, but
a resident brain with persistent memory can remember anything it is explicitly
asked to persist — across meetings. Treat meeting content accordingly.

## Google Meet smoke

Meeting and bot identifiers are omitted from this committed record.

| Acceptance check | Result | Evidence |
| --- | --- | --- |
| Joins as the configured agent | Pass | Attendee joined; participant displayed with the configured display name |
| Static image remains visible | Pass | Static `avatar.png` rendered for the participant |
| Fish Audio remains active | Pass | Greeting and replies synthesized |
| Claude Code personality | Pass | Identified itself, consulted its own workspace state before answering a "what are you working on" question, and answered with real current projects |
| Multiple voice turns | Pass | Addressed turns transcribed and answered; bare backchannels (「うん」「はい」) correctly ignored |
| Conversation context | Pass | Follow-up turns received context-aware responses |
| Session routing | Pass | Per-meeting `user` key logged on every gateway payload |
| Exit command | Pass | Voice exit command triggered farewell, Attendee leave, and log persistence |
| Interruption behavior (replaces the 07-23 barge-in requirement) | **Observed and documented as-is** | The bot does **not** stop speaking when a participant talks over it. Server log confirms the transport echo gate drops all inbound frames while the agent is speaking (405 frames dropped on one turn); the organizer confirmed the bot talked through the overlap. This matches the EPIC #41 design-review finding that mid-answer barge-in is double-gated on this path. The README row states this. |
| Post-meeting summary with trusted header | Pass **after two fixes found live** | See below |
| OpenClaw regression | Pass at automated-suite level | `make test` on the branch: 57/57 suites, only the known [#38](https://github.com/caty-ai/meetmate/issues/38) runner-IPC flake (both affected files pass 21/21 and 7/7 when run directly); bridge-side suite 790/790 |

## Issues discovered during the smoke (fixed in this change)

The live meeting surfaced two defects in the post-meeting summarizer path,
both invisible against lenient cloud providers:

1. **Missing `user`.** `summarizeConversation` sent no `user` field, and the
   stateful gateway rejects such requests (`400 missing_user`) because `user`
   is its mandatory session-routing key. Fix: the summarizer now sends a unique
   per-summary key (`meetmate-summary-<uuid>`), so the summary turn never
   collides with a live meeting session. The trusted-header regression fixed
   after 07-23 did **not** recur — the failing request passed bearer and trust
   checks and died on body validation.
2. **Hard-coded 30 s timeout.** The summarizer ignored the resolved
   `LLM_RESPONSE_TIMEOUT_MS` and timed out at 30 s; a stateful-gateway summary
   turn regularly needs more. Fix: it now honors the resolved
   `llm.responseTimeoutMs` (default unchanged at 30 s when unset).

Verification: with both fixes, the summarizer was re-run through the real
provider path against the live gateway using the saved conversation log from
this meeting and produced a well-formed summary (3 summary items, 1 todo).
Unit coverage added for the `user` key (format, per-call uniqueness,
`sessionUser` passthrough) and the timeout resolution.

## Follow-ups

None blocking the row flip. Interruption support (true barge-in) on the Meet
path remains future work tracked under EPIC
[#41](https://github.com/caty-ai/meetmate/issues/41)'s design notes; the README
row describes today's actual behavior.
