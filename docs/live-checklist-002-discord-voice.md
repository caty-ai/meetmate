# Live checklist: 002-discord-voice (EPIC #41 child 3, #138)

Live E2E baseline for the Discord voice adapter, with measurement criteria. This run turns the
#115 smoke's qualitative PASS into measured numbers the Epic integration review (E-6③) can cite.

Scope per EPIC #41 body v2 child-3 row: wake→first-audio latency, exit-command / manual-stop
immediacy, multi-speaker attribution, reconnect — plus the three live findings carried from #115
(perceived response latency, immediate-ack overlap A/B, MCP-less gateway config).
**Barge-in is out of scope** (owner ruling 2026-08-30, L1-8 record in the Epic body).

This lane changes no product code. All measurement is external (log timestamping wrapper +
Discord API reads + wall-clock). If a check turns out to be unmeasurable without instrumentation,
record the gap and file a follow-up issue — do not patch `src/` from this lane. Two such gaps were
already localized by the pre-run review (see Checks 4 and 6) and are pre-registered below.

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
- Ack A/B lever (Check 3): the ONLY working lever is the **launch environment variable**
  `ENABLE_IMMEDIATE_ACK` — `src/pipeline.js:49` freezes it into a module-load const, and
  `immediate_ack_enabled` lives in the read-only `ENV_DIAGNOSTICS` table
  (`src/settings/registry.js:190-205`), which the settings PUT/PATCH cannot write
  (`src/settings/routes.js` resolves `SETTINGS_REGISTRY` ids only). A settings-side toggle is
  therefore unexecutable, and any env change requires a **server restart** to take effect. The
  mechanism dispute in #135 is resolved empirically by this run's Block B ⚡ count (see Check 3).

## Measurement harness (no code changes)

Create a 0700 work dir and start the server with stdout run through a timestamping pipe:

```sh
WORKDIR=$(mktemp -d)            # 0700 by default; keep logs out of world-readable /tmp
cd <gateway home>
set -a; . ./.env; set +a        # load token/env silently — never echo values
printf 'Authorization: Bot %s\n' "$DISCORD_TOKEN" > "$WORKDIR/auth.hdr"; chmod 600 "$WORKDIR/auth.hdr"
npm start 2>&1 | perl -e '$|=1; use Time::HiRes qw(time); while (<STDIN>) { printf "[%.3f] %s", time, $_ }' | tee "$WORKDIR/live.log"
```

(`npm start` = `node src/server.js`; there is no repo-root `server.js`.)

Timestamp caveat: values are pipe-read times, accurate to roughly tens of milliseconds under
load (node pipe writes can coalesce). Fine for a record-only baseline; deltas are approximations,
the wall-clock T-felt is the perception-side truth.

Log anchors (all pre-existing lines in `src/pipeline.js`):

| Anchor | Log line | Meaning / caveat |
|---|---|---|
| A1 | `🎤  [interim→final]` | STT final (fires for EVERY final — pair with transcript text) |
| A2 | `🔔  Wake word detected! Gate → CLOSED` | wake accepted while gate OPEN (a wake landing mid-turn logs `⏳ … queuing` instead — that trial is void, rerun it) |
| A3 | `⚡  Immediate ack:` | ack TTS enqueued |
| A4 | `🗣️  <agent> speaking (first chunk):` | **absent whenever an ack ran** — the fast path is gated on `spokenSentenceCount === 0` and the ack sets it to 1 (`src/pipeline.js:2590, 2707`). Usable in ack-OFF blocks only |
| A5 | `📥  [diag] firstChunk transition` | first LLM token (`src/pipeline.js:2690`) — works in both ack states |
| A6 | `🚪  Exit command detected!` | exit command recognized (`src/pipeline.js:2070`) |

Derived metrics per trial:

- **T-ack** = A3 − A2 (ack enqueue delay; ack-ON blocks only)
- **T-llm** = A5 − A2 (wake → first LLM token; both blocks)
- **T-first** = wake → answer speech start: ack-OFF block = A4 − A2; ack-ON block = first `🗣️`
  line whose quoted text is NOT the ack, − A2
- **T-felt** = wall-clock stopwatch from *end of the human wake utterance* to *first audible bot
  audio*, recording **whether that first audio was the ack or the answer** (with ack ON it is
  almost always the ack — record both moments when possible: T-felt-ack and T-felt-answer)

Discord-side ground truth for presence checks (used in Checks 4/5/7). Poll until settled:

```sh
# absence = HTTP 404 (JSON code 10065 "Unknown voice state"); 401/403 = probe FAILURE, not absence
curl -s -o /dev/null -w '%{http_code}\n' -H @"$WORKDIR/auth.hdr" \
  https://discord.com/api/v10/guilds/$GUILD_ID/voice-states/@me
```

Record only the HTTP code as evidence — never the URL with the expanded guild ID.

`GET http://127.0.0.1:<port>/api/discord/status` (loopback only) for `configured`/`session` state.
Status output is verified clean (sessionId/state/startedAt/connectionReady only —
`discord-session.js:143-158`), but **join responses DO contain `guildId`/`channelId`**
(`discord-session.js:614-623`): before saving any join/leave JSON as evidence, redact mechanically:
`jq 'del(.guildId,.channelId)'`. Re-scan every log excerpt for IDs before attaching it.

## Check 1 — join & announce (gate for everything else)

Procedure: `POST /api/discord/join` from the dashboard; wait for the response.

- Metric: join responds `in-progress` only after the announce validation gate passes (E-6②
  BLOCKER regression guard); announce audible in Japanese.
- Pass bar: join succeeds on first attempt; announce heard by owner.
- Evidence: join response JSON (redacted via the jq filter above), owner confirmation,
  timestamped announce log window.

## Check 2 — wake → first-audio latency (finding 1: 応答体感)

Procedure: ≥5 wake exchanges (e.g. 「アルファ、〜」 with short questions of similar length).
One speaker, quiet channel, ack at launch default (ON). **Wait for the full answer to finish and
the gate to reopen before the next trial** — a trial whose wake logs `⏳ … queuing` is void; rerun
it. Pair each trial's anchors by the quoted transcript text, not by adjacency.

- Metrics: per-trial T-ack / T-llm / T-first / T-felt (ack-vs-answer noted); report median and
  max across trials.
- Pass bar: **5/5 trials produce a spoken answer with no timeout** (ties to #74). Latency values
  themselves are **record-only** — this run creates the baseline; no threshold is invented here.
- Evidence: trial table (below) + the anchor lines per trial copied from the log.
- Note: constants stay frozen (D3 discipline carried from #115). If T-felt-answer − T-first is
  large, that localizes latency to transcode/pacing — record it as a finding, do not tune.

## Check 3 — immediate-ack overlap A/B (finding 2: あいづちの被り)

Hypothesis from #115: per-user clean audio makes end-of-utterance detection fire earlier than in
Meet, so the ack lands while the human is still talking (threshold itself is the frozen Meet value).

Procedure: two blocks of ≥5 wake exchanges using **deliberately long wake utterances** (2+ clauses,
e.g. 「アルファ、今日の予定を整理したいんだけど、まず午前の分から教えて」):

- Block A: launch default (`ENABLE_IMMEDIATE_ACK` unset → ON). Same session as Check 2 is fine.
- Block B: stop the gateway → relaunch with `ENABLE_IMMEDIATE_ACK=false` in the launch env →
  re-join → run the trials → afterwards relaunch with the default env restored.
- **First-wake carve-out (both blocks)**: the first addressed turn after every (re)join always
  acks regardless of the flag — `forceImmediateAck = !hasSentInitialWakeAck`
  (`src/pipeline.js:2194, 2233`) bypasses the gate. Discard trial 1 of each block from the A/B
  scoring; an ⚡ on Block B trial 1 is expected, not a failed toggle.
- Effectiveness gate for Block B: **zero `⚡` lines from trial 2 onward**. If ⚡ persists on
  trials 2+, the env lever failed in the wild → record verbatim and stop the block; that outcome
  is decisive live evidence for #135 either way (this run doubles as #135's field test — the
  pre-run review localized `forceImmediateAck` as the likely mechanism behind #135's original
  "env ignored" observation).

- Metrics: per-block overlap count over trials 2..6 (trials where ack audio is audible while the
  speaker is still mid-utterance — owner's ear is the sensor, majority call if participants
  disagree); per-trial T-ack (block A); Block B ⚡ line count from trial 2 on.
- Pass bar: **record-only A/B**. Triage rule fixed in advance: if block A overlaps in ≥3/5 scored
  trials, file a follow-up issue proposing Discord-specific ack gating (no threshold changes here).
- Evidence: two trial tables + the launch command line (env var visible, no secrets) per block.

## Check 4 — exit command (voice) — behavior capture for a pre-localized gap

**Pre-registered expectation (from the pre-run review, code evidence)**: the exit voice command is
likely NOT wired to a Discord leave — `transport-meet` subscribes to `exit_requested`
(`meet-routes.js:1692-1702`) but `transport-discord` subscribes only to `playback_cancelled`
(`audio-out.js:151`, `discord-session.js:598`). Expected live behavior: A6 fires, farewell may
play, **bot remains in the channel**. This check captures the actual behavior as the live half of
that finding's evidence.

Procedure: during an idle moment, speak an exit phrase (canonical list: `src/messages.js:187-190`).

- Metrics: A6 observed? farewell played? then poll status + voice-state for 60s: does the bot
  actually leave (terminal + 404/10065) without manual intervention? Seconds from A6 to settled
  state (whichever state that is).
- Pass bar: **PASS only if the bot leaves cleanly without manual intervention.** If it remains
  (expected per code reading), record FAIL-as-expected → pre-registered triage: follow-up issue
  "Discord: exit voice command does not leave the channel (exit_requested unsubscribed)" with
  both the code localization above and this live capture. Then clear the state via Check 5's
  manual stop and continue the run.
- Evidence: timestamped A6/farewell window + status JSON + poll trace (HTTP codes only).

## Check 5 — manual stop immediacy

Procedure: (re)join, then `POST /api/discord/leave` from loopback while the bot is mid-answer
(ask a question, fire leave during playback).

- Metrics: HTTP response; seconds from leave request to terminal (status `session: null`) and
  voice-state 404/10065; playback actually stops (stop plumbing `stopPlayback/flush(outputEpoch)`
  — frozen in #0b — observable as truncated audio).
- Pass bar: clean terminal without restart; an immediate re-join succeeds (mutex released).
- Evidence: leave response (redacted), timestamped logs, re-join success record.

## Check 6 — multi-speaker: functional separation (attribution observability is a known gap)

**Pre-registered gap (from the pre-run review)**: per-human attribution has NO external observable
surface in a Discord live run — the D7 `user=discord-<sid>-…` gateway identity is one key per
session (not per human; `src/session-user.js:9-17`), stdout transcript lines omit the D10
`speaker` meta, `conversationLog` (which does carry per-entry speaker,
`src/pipeline.js:1025-1038`) is neither persisted nor exported for Discord, and the LLM prompt
does not render speaker names. Attribution correctness is therefore evidenced by the #115
per-user STT test pins plus the functional checks below; a follow-up issue proposes a minimal
observability surface (e.g. speaker displayName in the transcript log line). **Do not score
attribution from the D7 sessionUser — that would false-PASS.**

Procedure: 2 real users in the channel. Interleave: user A wakes and asks; user B speaks without
wake; user B wakes and asks; both talk briefly at once (overlapping speech may degrade to the
documented mixed-"unknown" posture — record, don't fail, per D10).

- Metrics (all observable): (a) each user's wake works and gets an answer (≥2 addressed turns per
  user); (b) unnamed (no-wake) speech is not injected — the next answer does not reference it
  (behavioral non-reference test; `meeting_context_injection_enabled` defaults false so
  non-injection is structural — the behavioral test is the live confirmation); (c) during the
  overlap moment, the session neither crashes nor wedges.
- Pass bar: 100% of addressed turns answered; zero unnamed-content references; no crash/wedge.
- Evidence: log lines per addressed turn (paired by transcript text) + the answer text that
  proves non-reference.

## Check 7 — disconnect handling (two distinct code paths)

**7a — server-side removal (voice_removed path)**: owner force-disconnects the bot via Discord UI
(right-click → disconnect). This fires `voiceStateUpdate` with a null channel → `movedAway` →
immediate teardown with reason `voice_removed` (`discord-session.js:262-268`). The reconnect
window is NOT involved here.

- Metrics: seconds from the kick to settled clean terminal (status `session: null`,
  voice-state 404/10065); immediate re-join succeeds.
- Pass bar: clean terminal + re-join OK, no wedged mutex. **Fail** = anything wedged (mutex held
  with no session, status stuck, re-join 409 without a live session — would confirm the #116
  wedge class in live form).

**7b — network-level drop (Disconnected / waitForReconnect path)**: briefly disrupt the gateway
machine's network (Wi-Fi off ~3s, then on). This is the path that exercises the vendor
`Disconnected` status and the 500ms `waitForReconnect` window (`discord-session.js:107, 226-232`).
Because the window is 500ms fail-closed, a human-scale blip is EXPECTED to settle as a clean
terminal (`finalize("disconnected")`); an auto-rejoin (outcome a) requires a sub-500ms blip and is
opportunistic-only — record it if it happens, don't chase it.

- Metrics: outcome class (rejoin-and-continue vs clean terminal); seconds to settled state;
  re-join afterwards succeeds.
- Pass bar: settled clean state (either class) + no wedge. Same fail definition as 7a.
- Evidence for both: timestamped logs + status JSON + poll trace.

## Check 8 — gateway config inventory (finding 3: MCP 構成)

Record-only. Capture alongside the run:

- The meeting Alpha session's gateway config: **MCP servers list (expected: none — MCP-less)**,
  agent profile in use, STT/TTS vendors, launch value of `ENABLE_IMMEDIATE_ACK`.
- One tool-shaped question during Check 2 (e.g. 「アルファ、今の東京の天気は？」) and the observed
  behavior — graceful no-tools answer vs timeout (cross-reference #74).
- Pass bar: none (inventory). The judgement whether MCP-less is the intended standing config for
  meeting sessions goes to triage as a gateway-ops note, not a meetmate issue.

## Results

> Filled during the live run. One row per trial; attach raw log windows in the PR or as an Issue
> comment, never with tokens/IDs (run the redaction scan first).

### Trial table — Check 2 (ack ON)

| # | utterance (short label) | T-ack (s) | T-llm (s) | T-first (s) | T-felt ack/answer (s) | answered? |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

### Trial tables — Check 3 (block A ack ON / block B ack OFF)

Same columns plus `overlap? (y/n)`; trial 1 of each block recorded but excluded from scoring
(forced first ack); block B additionally pins `⚡ lines from trial 2 on = 0` (or the verbatim
violation if the lever failed — decisive for #135 either way).

### Check summary

| Check | Pass bar met? | Measured values / notes |
|---|---|---|
| 1 join & announce | | |
| 2 wake latency | | |
| 3 ack A/B | (record-only) | |
| 4 exit command | (expected FAIL — gap capture) | |
| 5 manual stop | | |
| 6 multi-speaker functional | | |
| 7a kick / 7b network drop | | |
| 8 config inventory | (record-only) | |

## Triage rules (fixed before the run)

Every live finding lands in exactly one bucket, recorded in the Results section:

1. **Fixed ref** — already covered by a merged change (cite SHA/issue).
2. **Follow-up issue** — filed with the measured evidence attached (this lane never patches src).
3. **Accept-with-reason** — explicitly recorded, with the reason and the re-visit trigger.

Pre-registered triage: Check 3 block A overlap ≥3/5 scored trials → follow-up issue
(Discord-specific ack gating). Check 3 block B lever failure → evidence to #135. Check 4 bot
remains in channel → follow-up issue (exit_requested unsubscribed, code lines above). Check 6
attribution observability → follow-up issue (minimal surface proposal). Check 7 outcome "wedged"
→ evidence to #116. Latency findings that localize to transcode/pacing → follow-up issue on the
transport, with T-felt-answer − T-first data.

## Pass bar for this cycle

- Checks 1, 2, 5, 6, 7 meet their pass bars (3 and 8 are record-only by design; 4 is a gap
  capture whose PASS would be a pleasant surprise — its outcome feeds triage either way).
- This satisfies the Epic #41 Done when line "実際の Discord 音声チャンネルで wake word → 音声回答が
  end-to-end で通る（証拠: ライブチェックリストの記録）" with quantified evidence; the attribution
  Done when line is evidenced by the #115 test pins + Check 6 functional separation, with the
  observability gap explicitly recorded.
