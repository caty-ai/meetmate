# Claude Code integration smoke test — 2026-07-23

Status: **integration in progress**

Claude Code is intentionally not listed as supported in the README yet. The
local gateway and a real Google Meet call passed most of the acceptance checks,
but a real-meeting barge-in was not conclusively observed.

## Configuration under test

- Meetmate provider: `openai-compatible`
- Conversation source of truth: Claude Code native session
- Meetmate history: `historyMaxTurns: 0`
- Empty-response replay: `emptyResponseRetry: false`
- Tool-capable gateway opt-in: `trustedAgentTools: true`
- Gateway auth: dedicated `CATY_OPENAI_CHAT_TOKEN`
- Meeting scope: private, trusted, organizer-owned Google Meet
- STT: Deepgram
- TTS: Fish Audio
- Display: existing static `avatar.png`

No production gateway, public repository, or deployment was changed.

## Local gateway and contract checks

| Check | Result |
| --- | --- |
| Non-stream OpenAI-compatible JSON | Pass |
| Streaming SSE deltas and `[DONE]` | Pass |
| Meetmate `openai-compatible` client | Pass |
| Same-session multi-turn recall | Pass |
| Different-session isolation | Pass |
| Client abort followed by same-session reconnect | Pass |
| One-second backend deadline | Pass (`504 timeout`) |
| Concurrent same-session request | Pass (`409 session_busy`) |
| Dedicated token and trusted-meeting header | Pass |

The live Claude Code agent identified itself as Alpha and used its resident
workspace personality. A nonce remembered in one session was recalled on the
next turn and was unavailable in a different session.

## Google Meet smoke

Meeting and bot identifiers are omitted from this committed record.

| Acceptance check | Result | Evidence |
| --- | --- | --- |
| Joins as the configured agent | Pass | Attendee reached `joined_recording`; participant displayed as `Alpha (AI)` |
| Static image remains visible | Pass | Existing `avatar.png` rendered for the participant |
| Fish Audio remains active | Pass | Greeting and replies were synthesized; cache/store logs were healthy |
| Claude Code personality | Pass | Replied, “はい、アルファです。ユーザー、お話できますよ” |
| Multiple voice turns | Pass | Two addressed user turns were transcribed and answered |
| Conversation context | Pass | Follow-up about speaking together received a context-aware response |
| Session routing | Pass at contract/local E2E | Exact Meetmate `user` key was logged; independent local session test showed no mixing |
| Exit command | Pass | Voice “アルファを退出して” triggered farewell, Attendee leave, and log persistence |
| User barge-in | **Not conclusively verified in the real meeting** | Transport abort/process cleanup and Meetmate barge-in tests passed, but no clean live interruption sample was recorded |
| OpenClaw regression | Pass at automated-suite level | Gateway full suite and existing Meetmate provider tests passed |

## Issue discovered during the smoke

The first post-meeting summary request omitted the explicit trusted-agent
option and received `403 trusted_meeting_required`. The fix forwards
`trustedAgentTools` through the generic OpenAI-compatible summarizer path and
has a regression test. This did not affect the live conversation or exit flow.

## Required follow-up before changing the compatibility table

1. Record one clean real-meeting barge-in while Alpha is speaking.
2. Repeat the smoke with the final committed branches.
3. Confirm the post-meeting summary succeeds with the trusted header.
4. Re-run the OpenClaw path using its normal configuration.
