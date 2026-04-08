# Live checklist: 001-wake-word-context-fix

Use this after restarting the Meet server on the patched build.

## Preconditions

- Start from a fresh Meet session.
- Confirm the patched files are deployed:
  - `src/transport-meet/meet-routes.js`
  - `src/pipeline.js`
  - `src/stt.js`
- Tail the relevant logs before joining.

## Check 1: single-agent keyterms are loaded

Expected:
- Single-agent path no longer logs `(no keyterms)` for Caty.
- Logs should show wake-word boosting terms were derived from the active profile.

Record:
- pass / fail
- exact log line

## Check 2: direct wake word still works

Say:
- `ケイティ、こんにちは`
- optionally `ケイト、こんにちは` if alias testing is enabled

Expected:
- Agent responds normally.
- Wake detection happens without repeated retries.

Record:
- recognized transcript
- whether the agent answered
- time to first response

## Check 3: unnamed chatter is not injected into LLM context

Before addressing the agent, let background meeting chatter occur.
Then say:
- `ケイティ、今の話は無視して、一言だけ返して`

Expected:
- Response follows the direct request.
- It does not continue unrelated planning or content generation from background chatter.

Record:
- whether unnamed audio appeared in logs
- whether the generated response referenced unnamed chatter

## Check 4: stop command interrupts correctly

After some background chatter, say:
- `ケイティ、ストップ`
- or another tested stop phrase

Expected:
- Ongoing generation or speech stops.
- No continued proposal-writing or diagnostic flow appears after the stop command.

Record:
- interruption success
- any trailing output after stop

## Check 5: pending queue replay follows the same filtering rule

Create a situation where unnamed audio is buffered before a direct address.
Then address the agent clearly.

Expected:
- Replay may help wake detection.
- Only addressed content is carried into the LLM context.

Record:
- whether buffered content was replayed
- whether unrelated meeting text leaked into the reply

## Pass bar for this cycle

Treat the fix as live-validated only if all are true:
- keyterms present in single-agent logs
- wake word responds reliably
- unnamed chatter does not contaminate reply content
- stop command interrupts reliably
- pending queue path does not reintroduce contamination
