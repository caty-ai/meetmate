# #267 — reply without a wake word when jev judges "addressed to Caty" and "turn finished" (opt-in trial)

Status: design draft for review (L1-9). Owner decisions of 2026-09-29 / 2026-10-01 are marked **[owner]**.

## §0 Measured facts (2026-09-30, Mac in Japan, before any code)

Probe: 12 hand-written Japanese meeting lines × 3 calls each, one jev request per call asking both questions (`noul`), state = `{ assistant_name, recent_lines[], latest_line }`.

- Latency: p50 288 ms, p90 349 ms, max 411 ms (n=36). No errors.
- At a 0.5 cut: "addressed" 10/12, "finished" 11/12.
- Misses that matter:
  - `田中: よろしくお願いします` (greeting between people) → addressed 0.62, finished 0.91 → would **interrupt** at 0.5 or 0.6; suppressed at 0.75.
  - `田中: じゃあそれで予約しておいて` (follow-up to Caty's previous line) → addressed 0.63 → Caty stays **silent** at 0.75.
  - `田中: まず前提として、今期の` → addressed 0.60 but finished 0.08 → correctly not spoken (the AND saves it).
- With both thresholds at 0.75, 11/12 combined decisions were right; the one miss was a silence, not an interruption.
- Cost: jev bills input tokens only, about USD 0.04 per million. A request is a few hundred tokens, so a one-hour meeting with a few hundred calls costs about 1 yen.
- The key is the same lazy `TYPESAFE_API_KEY` env the emotion judge already uses (`src/emotion/jev.js`, never a registry/startup credential). Whether the live VPS has it is **unverified**; adding it there needs the owner's OK.

## §1 Today (code facts, origin/main 23e385b)

- `src/stt-soniox.js` emits `utterance_end` on Soniox's semantic `<end>` token (plus a 120-char cap and flush on reconnect/finish).
- `src/pipeline.js` `onSttUtteranceEnd` → `handleUtteranceEnd`:
  - sleeps `POST_UTTERANCE_BUFFER_MS` (500 ms),
  - then, in the non-hub path, `detectWakeAgent(text)`.
  - With no wake word, the line goes to `transcriptBuffer` and the conversation log as `[会議音声・未指名]` and returns.
  - With a wake word and the gate OPEN → close the gate → `processUserInput` (LLM → TTS).
  - With the gate CLOSED (Caty is busy) → `enqueuePending`. `reopenGateAndRescan` later replays pending lines by **re-running the wake check**.
- In the hub path (`config.hub.enabled`), `floorClient.reportText` extracts wake hits locally and the hub assigns the floor. A line without wake hits settles as `empty`.
- The wake gate applies in both `one_to_one` and `group` conversation modes. `wakeMode` only switches the meeting-context injection and the `wake_decision` metric.
- jev today: `faceListenCue` calls `judgeEmotion(..., { listening: true })` on each `utterance_end` (face-package sessions only, throttled to one call per 4 s). #269: this function and `faceListenPulse` crash when `session.localAvatarSession` is null after a leave.

## §2 Proposed shape

### Setting

- `agent_reply_trigger` → `agent.replyTrigger`: `"wake"` (default, today's behaviour byte-for-byte) | `"jev"` (trial). `apply: "live"`, shown on the settings screen **[owner]**, with a short "trial" hint.
- Advanced (config only, not on the screen):
  - `agent.replyJudge.addressedMin` = 0.75
  - `agent.replyJudge.finishedMin` = 0.75 **[owner: cautious]**
  - `agent.replyJudge.continuationWaitMs` = 3000
  - `agent.replyJudge.timeoutMs` = 800
  - `agent.replyJudge.contextLines` = 6

### Flow (non-hub path only)

1. In `handleUtteranceEnd`, run the wake check before the 500 ms buffer sleep. The check is pure and cheap. This also answers wake+cancel early.
2. If `replyTrigger !== "jev"`, or a wake word was heard, or the hub is on → today's path unchanged, and **jev is never called**. The wake path gains 0 ms.
3. Otherwise start `judgeTurn()` (new `src/turn-judge.js`) **concurrently with** the existing 500 ms sleep, and wait for both. At the measured p90 of 349 ms, the judge finishes inside the sleep. Worst case the extra wait is `timeoutMs - 500` = 300 ms.
4. Inputs to jev:
   - the last `contextLines` entries of `transcriptBuffer` with speaker labels,
   - Caty's last 1–2 spoken replies (from the conversation log, labelled as Caty),
   - the latest line.
   - One request asks both `noul` questions (wording as in §0; final wording pinned by the offline eval).
5. Decision:
   - `addressed ≥ addressedMin && finished ≥ finishedMin` → **speak**. Treat the line exactly like a wake-addressed line: `entry.addressed = true`, same gate logic, same `processUserInput`, same ack behaviour.
   - `addressed ≥ addressedMin && finished < finishedMin` → **wait** **[owner: wait up to 3 s, then speak]**:
     - Hold the line.
     - If another `utterance_end` from the same speaker arrives within `continuationWaitMs`, merge the texts and judge again (a single wait; a second "not finished" means **ignore**).
     - If nothing arrives and no interim speech is seen during the wait (`liveUserSpeechUntil`), speak with the held line.
     - Any other speaker's speech during the wait cancels it (they took the turn).
   - Otherwise → **ignore**: exactly today's un-addressed handling.
6. Busy gate: while Caty is processing or speaking (gate CLOSED), jev mode does **not** interrupt her. Only a wake word interrupts, as today. Lines arriving in that window go to `pendingQueue` as today. On `reopenGateAndRescan`:
   - A wake word in the queue wins, as today.
   - With none, the **newest** pending line (only that one) is judged by jev. Stale lines are not answered.
7. Fail-closed: no key, HTTP error, invalid answer, timeout or abort → **ignore** (silent). The line then behaves exactly as in wake mode. Log `reason`.
8. Hub path **[owner: out of scope for the trial]**: with `hub.enabled`, `replyTrigger: "jev"` behaves as `"wake"`. Log one warning line per session.

### Logging (for tuning)

One line per judged utterance: `🧭 [turn-judge] decision=speak|wait|ignore addressed=0.83 finished=0.93 ms=291 reason=… "<first 40 chars>"`.

Plus a `turn_judge` metric: `turn_id`, `decision`, `addressed`, `finished`, `latency_ms`, `reason`. It carries no transcript text; the text already appears in the existing `[user]` log lines. Keys and headers are never logged.

### Offline evaluation **[owner: synthetic + #264 live logs]**

- `tools/eval-turn-judge.mjs` runs the real `judgeTurn()` over a labelled JSONL set and prints a confusion table, latency p50/p90 and per-threshold sweeps.
- The set combines:
  - hand-written meeting lines (varied speakers, follow-ups to Caty, greetings, mid-sentence pauses, remarks *about* Caty),
  - `[user]` / `[会議音声・未指名]` lines read from the VPS service journal of the #264/#266 live checks. The journal is only read; nothing on the VPS is changed.
- Real names are replaced before anything is committed. Only the anonymised set is committed.

### #269

It is folded into this lane as a separate commit (`Fixes #269`): null-guard every `session.localAvatarSession.*` read in the pipeline, plus a test for "utterance end after the face session closed". It lives in the same file and the same `utterance_end` path.

## §3 Failure forms (worst first)

1. **Caty interrupts people who were talking to each other**. This is the most damaging, because it breaks the meeting and the owner's trust in the mode. Mitigations:
   - the AND of two thresholds at 0.75,
   - fail-closed on every error,
   - no jev-triggered interruption while Caty is busy,
   - only the newest pending line is judged,
   - another speaker cancels the wait.
2. **The default wake mode changes behaviour or latency**, for example jev being called, or the wake check being moved in a way that changes wake+cancel or exit handling. Mitigation: tests that pin today's decisions and that jev is not called when `replyTrigger` is `"wake"` or a wake word was heard.
3. Caty answers an old line after a long reply (stale pending replay).
4. Caty stays silent too often, which makes the mode useless. The offline eval measures it and the thresholds are tunable.
5. Crash or unhandled rejection on the utterance path, for example the judge throwing inside `utteranceChain`, or #269.
6. Key leakage in logs or metrics.

## §4 Done when (owner-confirmed 2026-10-01)

1. `agent.replyTrigger` exists with default `"wake"`. With the default, behaviour is unchanged, and a test proves jev is never called.
2. In `"jev"` mode:
   - wake-word lines behave as today with no jev call,
   - lines without a wake word are answered only when both scores reach the thresholds,
   - the wait rule of §2.5 holds.
3. Every jev failure (no key, error, invalid answer, timeout, abort) results in silence. No crash or unhandled rejection is possible.
4. One judge log line and one metric per judged utterance. No key in logs or metrics (test).
5. Offline eval on ≥ 60 labelled lines:
   - "spoke when it should not" ≤ 5%,
   - "silent when it should speak" is recorded (target ≤ 30%),
   - the added wait for judged lines stays p90 ≤ 0.5 s beyond today's 500 ms buffer.
   - The anonymised set and the results are committed under `docs/` / `test/fixtures/`.
6. `make test` green, the review seats pass, and #269 is fixed with a test.
7. Live check with the owner at an agreed time. Turning the mode on for the live VPS service needs the owner's OK. Merging does not change the live service, which runs the npm release.

## §5 Files to touch (declared on #267, 2026-09-30)

- `src/turn-judge.js` (new)
- `src/pipeline.js`
- `src/settings/registry.js`
- `public/settings.js`
- `config.json.example`
- `docs/settings-contract.md`
- `docs/settings-env-inventory.json` (if needed)
- `docs/design/267-jev-turn-taking.md`
- `tools/eval-turn-judge.mjs`
- `test/fixtures/turn-judge/*`
- `test/turn-judge.test.js`
- `test/pipeline-turn-judge.test.js`
- `test/settings-ui.test.js`
- `test/pipeline-face-listen-null.test.js` (new, for #269; to be added to the WIP when implementation starts)

Overlap: #266 has merged (none of its files are here). #266's follow-up (`faceAudio` default in `registry.js` / `settings.js`) is serialised behind #267.

## §6 Questions for reviewers

- **Q0**: if the framing itself is wrong (e.g. jev should not be the judge, the decision should sit elsewhere than `handleUtteranceEnd`, or the hub path must be in scope from day one), say so and propose the alternative.
- Q1: Is fail-closed plus "no jev-triggered interruption while busy" enough to keep failure form 1 rare? What sequence still interrupts?
- Q2: Does moving the wake check before the 500 ms sleep change any existing behaviour (exit command, wake+cancel, hub path, metrics order)?
- Q3: Is "judge only the newest pending line on gate reopen" right, or should jev-mode lines never be queued?
- Q4: The wait rule: any race with `utteranceChain` serialisation, speaker slots (`MAX_ATTRIBUTED_STT`) or `liveUserSpeechUntil`?
- Q5: Is the offline-eval bar (≥ 60 lines, ≤ 5% false speak) meaningful for a trial, and is the labelling plan sound?
