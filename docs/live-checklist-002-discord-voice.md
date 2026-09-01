# Live checklist: 002-discord-voice (EPIC #41 child 3, #138)

Live E2E baseline for the Discord voice adapter, with measurement criteria. This run turns the
#115 smoke's qualitative PASS into measured numbers the Epic integration review (E-6③) can cite.

Scope per EPIC #41 body v2 child-3 row: wake→first-audio latency, exit-command / manual-stop
immediacy, multi-speaker attribution, reconnect — plus the three live findings carried from #115
(perceived response latency, immediate-ack overlap A/B, MCP-less gateway config).
**Barge-in is out of scope** (owner ruling 2026-08-30, L1-8 record in the Epic body).

This lane changes no product code. All measurement is external (log timestamping wrapper +
Discord API reads + wall-clock). If a check turns out to be unmeasurable without instrumentation,
record the gap and file a follow-up issue — do not patch `src/` from this lane.

## Preconditions

- Build: epic/41 at `3d1430b` or later (child #1 `98d1353` + #2a `4931645` + #2b `3d1430b` merged).
- Checkpoint-1 posture (approved 2026-08-31, unchanged): owner's 身内 server only, guild allowlist
  set to that guild, intents `Guilds` + `GuildVoiceStates` only, bot permissions View Channel +
  Connect + Speak. Token handed via one-time secret → `.env` (0600) → shredded after the run.
- Owner (翔さん) present in the voice channel for every check; a second real participant is needed
  for Check 6 (a phone + PC pair with two Discord accounts is acceptable).
- LLM/STT/TTS env present in the gateway home (harness trouble ① from the #115 smoke: a missing
  `OPENAI_COMPATIBLE_API_KEY` fails setup — verify before joining).
- No stale gateway process (#115 smoke trouble ②): before starting, confirm the port is free;
  `EADDRINUSE` means an old process is still serving joins with old settings.
- `immediate_ack_enabled` starts at its default (`true`). Toggling for Check 3 happens **via the
  settings API/UI only** — the `ENABLE_IMMEDIATE_ACK` env path is known-broken (#135) and must not
  be used for the A/B.

## Measurement harness (no code changes)

Start the server with stdout run through a timestamping pipe (macOS-safe):

```sh
node server.js 2>&1 | perl -MTime::HiRes=time -ne 'printf "[%.3f] %s", time, $_' | tee /tmp/mm138-live.log
```

Log anchors (all pre-existing lines in `src/pipeline.js`):

| Anchor | Log line | Meaning |
|---|---|---|
| A1 | `🎤  [interim→final]` | STT final for the wake utterance |
| A2 | `🔔  Wake word detected! Gate → CLOSED` | wake accepted |
| A3 | `⚡  Immediate ack:` | ack TTS enqueued |
| A4 | `🗣️  <agent> speaking (first chunk):` | first answer chunk enters TTS |

Derived metrics per trial:

- **T-ack** = A3 − A2 (ack enqueue delay)
- **T-first** = A4 − A2 (wake → first answer chunk, pipeline-side)
- **T-felt** = wall-clock stopwatch from *end of the human wake utterance* to *first audible bot
  audio in Discord* (this includes transcode + player pacing that logs cannot see)

Discord-side ground truth for presence checks (used in Checks 4/5/7):

```sh
# 404 = bot has no voice state in the guild (clean absence)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bot $DISCORD_TOKEN" \
  https://discord.com/api/v10/guilds/$GUILD_ID/voice-states/@me
```

`GET http://127.0.0.1:<port>/api/discord/status` (loopback only) for `configured`/`session` state.
Confirm while recording that status output never contains token, guild, or channel IDs.

## Check 1 — join & announce (gate for everything else)

Procedure: `POST /api/discord/join` from the dashboard; wait for the response.

- Metric: join responds `in-progress` only after the announce validation gate passes (E-6②
  BLOCKER regression guard); announce audible in Japanese.
- Pass bar: join succeeds on first attempt; announce heard by owner.
- Evidence: join response JSON (redacted), owner confirmation, timestamped announce log window.

## Check 2 — wake → first-audio latency (finding 1: 応答体感)

Procedure: ≥5 wake exchanges (e.g. 「アルファ、〜」 with short questions of similar length).
One speaker, quiet channel, ack setting at default (`true`).

- Metrics: per-trial T-ack / T-first / T-felt; report median and max across trials.
- Pass bar: **5/5 trials produce a spoken answer with no timeout** (ties to #74). Latency values
  themselves are **record-only** — this run creates the baseline; no threshold is invented here.
- Evidence: trial table (below) + the four anchor lines per trial copied from the log.
- Note: constants stay frozen (D3 discipline carried from #115). If T-felt − T-first is large,
  that localizes latency to transcode/pacing — record it as a finding, do not tune.

## Check 3 — immediate-ack overlap A/B (finding 2: あいづちの被り)

Hypothesis from #115: per-user clean audio makes end-of-utterance detection fire earlier than in
Meet, so the ack lands while the human is still talking (threshold itself is the frozen Meet value).

Procedure: two blocks of ≥5 wake exchanges using **deliberately long wake utterances** (2+ clauses,
e.g. 「アルファ、今日の予定を整理したいんだけど、まず午前の分から教えて」):

- Block A: `immediate_ack_enabled=true` (default).
- Block B: set `immediate_ack_enabled=false` **via settings UI/API**, confirm the effective value
  via settings read-back, then repeat. Restore `true` afterwards and confirm read-back again.

- Metrics: per-block overlap count (trials where ack audio is audible while the speaker is still
  mid-utterance — owner's ear is the sensor, majority call if participants disagree); per-trial
  T-ack; in block B confirm zero `⚡` anchor lines appear.
- Pass bar: **record-only A/B**. Triage rule fixed in advance: if block A overlaps in ≥3/5 trials,
  file a follow-up issue proposing Discord-specific ack gating (do not change thresholds here).
- Evidence: two trial tables + effective-setting read-back before each block.

## Check 4 — exit command immediacy

Procedure: during an idle moment, speak the exit command (same phrase set as the #115 smoke).

- Metrics: seconds from the exit command's A1 (final transcript) to (a) session terminal log,
  and (b) Discord API voice-state returning 404; farewell audible before leave (EXIT_GRACE_MS
  behavior).
- Pass bar: terminal state + 404 reached **without any manual intervention**; status shows
  `session: null`. Time is record-only.
- Evidence: timestamped log window + curl 404 output + status JSON.

## Check 5 — manual stop immediacy

Procedure: join again, then `POST /api/discord/leave` from loopback while the bot is mid-answer
(ask a question, fire leave during playback).

- Metrics: HTTP response; seconds to terminal log + voice-state 404; playback actually stops
  (stop plumbing `stopPlayback/flush(outputEpoch)` — frozen in #0b — observable as truncated audio).
- Pass bar: clean terminal without restart; an immediate re-join succeeds (mutex released).
- Evidence: leave response, timestamped logs, re-join success record.

## Check 6 — multi-speaker attribution

Procedure: 2 real users in the channel. Interleave: user A wakes and asks; user B speaks without
wake; user B wakes and asks; both talk briefly at once (accepting that overlapping speech may
degrade — record, don't fail, per D10 mixed-degrade posture).

- Metrics: for each addressed utterance, gateway payload shows the correct per-user identity
  (`user=discord-<sid>-…` namespace, D7); unnamed (no-wake) speech is not injected into the LLM
  turn (verify: next answer does not reference it, and logs show it held as unaddressed).
- Pass bar: 100% correct attribution on addressed utterances (≥2 per user); zero unnamed-content
  leakage into answers.
- Evidence: log lines per utterance + the answer text that proves non-reference.

## Check 7 — reconnect

Procedure: while a session is live, the owner force-disconnects the bot server-side (Discord UI →
right-click bot → disconnect). This exercises the vendor `disconnected` path with the
`waitForReconnect` window (500ms, fail-closed side).

- Metrics: outcome class — (a) auto-rejoin within the window and the session continues, or
  (b) clean terminal (session `null`, voice-state 404, no wedged mutex, immediate re-join works).
  Seconds from disconnect to settled state.
- Pass bar: outcome is (a) or (b). **Fail** = anything wedged: mutex held with no session, status
  stuck, or re-join 409 without a live session (would confirm the #116 wedge class in live form).
- Evidence: timestamped logs + status JSON + re-join record.

## Check 8 — gateway config inventory (finding 3: MCP 構成)

Record-only. Capture alongside the run:

- The meeting Alpha session's gateway config: **MCP servers list (expected: none — MCP-less)**,
  agent profile in use, STT/TTS vendors, `immediate_ack_enabled` effective value.
- One tool-shaped question during Check 2 (e.g. 「アルファ、今の東京の天気は？」) and the observed
  behavior — graceful no-tools answer vs timeout (cross-reference #74).
- Pass bar: none (inventory). The judgement whether MCP-less is the intended standing config for
  meeting sessions goes to triage as a gateway-ops note, not a meetmate issue.

## Results

> Filled during the live run. One row per trial; attach raw log windows in the PR or as an Issue
> comment, never with tokens/IDs.

### Trial table — Check 2 (ack=true)

| # | utterance (short label) | T-ack (s) | T-first (s) | T-felt (s) | answered? |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

### Trial tables — Check 3 (block A / block B)

Same columns as above, plus `overlap? (y/n)`; block B additionally pins `⚡ lines seen = 0`.

### Check summary

| Check | Pass bar met? | Measured values / notes |
|---|---|---|
| 1 join & announce | | |
| 2 wake latency | | |
| 3 ack A/B | (record-only) | |
| 4 exit command | | |
| 5 manual stop | | |
| 6 attribution | | |
| 7 reconnect | | |
| 8 config inventory | (record-only) | |

## Triage rules (fixed before the run)

Every live finding lands in exactly one bucket, recorded in the Results section:

1. **Fixed ref** — already covered by a merged change (cite SHA/issue).
2. **Follow-up issue** — filed with the measured evidence attached (this lane never patches src).
3. **Accept-with-reason** — explicitly recorded, with the reason and the re-visit trigger.

Pre-registered triage: Check 3 block A overlap ≥3/5 → follow-up issue (Discord-specific ack
gating). Check 7 outcome "wedged" → evidence to #116. Latency findings that localize to
transcode/pacing → follow-up issue on the transport, with T-felt−T-first data.

## Pass bar for this cycle

- Checks 1, 2, 4, 5, 6, 7 meet their pass bars (3 and 8 are record-only by design).
- This satisfies the Epic #41 Done when line "実際の Discord 音声チャンネルで wake word → 音声回答が
  end-to-end で通る（証拠: ライブチェックリストの記録）" with quantified evidence.
