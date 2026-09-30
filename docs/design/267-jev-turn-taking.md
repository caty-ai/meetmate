# #267 — reply without a wake word when jev judges "addressed to Caty" and "turn finished" (opt-in trial)

Status: **v2**, after the L1-9 round 1 review (3 seats, GO-WITH-CONDITIONS ×3). The r1 adjudication is in §7. Owner decisions of 2026-09-29 / 2026-10-01 are marked **[owner]**.

## §0 Measured facts (2026-09-30, Mac in Japan, before any code)

Probe: 12 hand-written Japanese meeting lines × 3 calls each, one jev request per call asking both questions (`noul`), state = `{ assistant_name, recent_lines[], latest_line }`.

- Latency: p50 288 ms, p90 349 ms, max 411 ms (n=36). No errors.
- At a 0.5 cut: "addressed" 10/12, "finished" 11/12.
- Misses that matter:
  - `田中: よろしくお願いします` (a greeting between people) → addressed 0.62, finished 0.91. This **interrupts** at a 0.5 or 0.6 cut and is suppressed at 0.75.
  - `田中: じゃあそれで予約しておいて` (a follow-up to Caty's previous line) → addressed 0.63, so Caty stays **silent** at 0.75.
  - `田中: まず前提として、今期の` → addressed 0.60 but finished 0.08. It is correctly not spoken, because the AND of the two scores saves it.
- With both thresholds at 0.75, 11/12 combined decisions were right. The one miss was a silence, not an interruption.
- The probe lines carried speaker labels. Production context may not (see §2.4). The eval must include unlabelled variants.
- Cost: jev bills input tokens only, at about USD 0.04 per million. One request is a few hundred tokens, so a one-hour meeting with a few hundred calls costs about 1 yen.
- The key is the same lazy `TYPESAFE_API_KEY` env var the emotion judge already uses (`src/emotion/jev.js`). It is never a registry or startup credential. Whether the live VPS has it is **unverified**, and adding it there needs the owner's OK.

## §1 Today (code facts, origin/main 23e385b)

- `src/stt-soniox.js` emits `utterance_end` on Soniox's semantic `<end>` token, on a 120-char cap, and as a flush on reconnect or finish.
- In `src/pipeline.js`, `onSttUtteranceEnd` does three things **before** the chain:
  - runs `faceListenCue`,
  - reports to the floor hub (hub mode only),
  - handles wake+cancel when `isProcessing` (l.2005).
- It then appends `handleUtteranceEnd` to `utteranceChain` (l.2017).
- `handleUtteranceEnd` **awaits `processUserInput`** (l.2337). The chain is therefore blocked for Caty's whole reply, and lines spoken meanwhile run afterwards with the gate OPEN. `pendingQueue` / `enqueuePending` is reached only when `handleUtteranceEnd` itself sees a CLOSED gate, and only for wake hits (l.2277–2304). On the STT path this is effectively test-only (`_test.handleUtteranceEnd`).
- Inside `handleUtteranceEnd` the order is:
  1. sleep `POST_UTTERANCE_BUFFER_MS` (500 ms),
  2. write the `[user]` log,
  3. exit detection,
  4. then, in the non-hub path, `detectWakeAgent` → `wake_decision` metric → either un-addressed (`[会議音声・未指名]`, return) or addressed.
- In the hub path (`config.hub.enabled`), `floorClient.reportText` extracts wake hits and the hub assigns the floor. `detectWakeAgent` runs only in the degraded fallback (l.2187).
- The wake gate applies in both `one_to_one` and `group` conversation modes.
- `LIVE_USER_SPEECH_HOLD_MS` = 1200 ms. `liveUserSpeechUntil` is **global**, not per speaker. Any non-noise interim refreshes it (l.1947–1949), and so does every `handleUtteranceEnd` (l.2083).
- Speaker slots exist only with per-speaker audio. Up to `MAX_ATTRIBUTED_STT` = 4 speakers get a slot, evicted LRU. Everyone else, and all audio that cannot be attributed, goes to the `UNKNOWN_SPEAKER_ID` stream.
- jev today:
  - `faceListenCue` calls `judgeEmotion(..., { listening: true })`. `src/emotion/jev.js` hard-codes `state: { speaker, line }` and the emotion questions, so it **cannot** be reused for this judge.
  - #269: `session.localAvatarSession.*` is read unguarded at l.1920, 1927, 1935 (`faceListenPulse` / `faceListenCue`) and l.3073, 3079 (`speakSentence`). `faceMode` is latched at construction (l.577).

## §2 Proposed shape (v2)

### §2.1 Settings

- `agent_reply_trigger` → `agent.replyTrigger`, `z.enum(["wake","jev"])`:
  - default `"wake"` (today's behaviour, byte for byte),
  - `ux: "basic"`, `apply: "live"`, with a "trial" hint on the settings screen **[owner]**.
  - It is **read per utterance** with `getEffectiveValue` (like `emotion_judge`). It is never snapshotted at construction.
- Advanced knobs are registry rows with `ux: "hidden"`. They are in the registry, so they survive settings PUT (`docs/settings-contract.md`), but they are not shown on the screen:

  | Setting | Default |
  |---|---|
  | `agent.replyJudge.addressedMin` | 0.75 **[owner]** |
  | `agent.replyJudge.finishedMin` | 0.75 **[owner]** |
  | `agent.replyJudge.continuationWaitMs` | 3000 **[owner]** |
  | `agent.replyJudge.timeoutMs` | 800 |
  | `agent.replyJudge.contextLines` | 6 |

### §2.2 Default and hub paths stay byte-identical

- If `replyTrigger !== "jev"`, or the hub is on, `handleUtteranceEnd` is unchanged. The order stays: sleep → `[user]` log → exit → wake → `wake_decision` → un-addressed or addressed.
  - No early wake check.
  - `turn-judge.js` is never imported or called.
- Hub on + `"jev"` → behaves as `"wake"`, with one warning line per session **[owner]**.

### §2.3 jev mode — the judge call (non-hub only)

1. **Arrival snapshot, taken in `onSttUtteranceEnd` before the chain.** Record `busyAtArrival = isProcessing || gateState === "CLOSED" || turnState.isAgentSpeaking` on the utterance.
2. In `handleUtteranceEnd` (jev mode only), a **pure peek** `detectWakeAgent(text)` runs at t=0. It only decides whether to start the judge. All logging, exit detection, the `wake_decision` metric and wake+cancel handling stay exactly where they are today, after the sleep.
3. The judge is started only if all of these hold:
   - no wake word,
   - not an exit command,
   - `!busyAtArrival`,
   - still not busy.
   If started, `judgeTurn()` (new `src/turn-judge.js`) runs **concurrently with** the existing 500 ms sleep. At the measured p90 of 349 ms it finishes inside the sleep. Worst case adds `timeoutMs − 500` = 300 ms.
4. Lines that arrived while Caty was busy (`busyAtArrival`) are **never** jev-judged: they get today's un-addressed handling. A wake word still works as today. This closes the "Caty finishes a long reply, then answers stale chit-chat" sequence (r1 C2). `pendingQueue` and `reopenGateAndRescan` are **not** changed.
5. A jev "speak" never aborts a running reply. If `isProcessing` is true when the decision lands, the decision becomes **ignore**. Only a wake word can interrupt, as today.
6. `turn-judge.js` owns its own HTTP call. It shares nothing with `askJev` except the env var name.
   - Request state: `{ assistant_name, recent_lines, latest_line }`. `recent_lines` are the last `contextLines` entries of `transcriptBuffer` plus Caty's last 1–2 spoken replies, labelled `Caty`. Each entry carries its speaker label when one exists; otherwise it is labelled `unknown`.
   - Two `noul` questions (wording from §0; the eval may refine it).
   - Timeout `timeoutMs`. Aborted when the pipeline is `stopped`, and when the hold it belongs to is superseded.
   - **Fail-closed**: no key, non-OK HTTP, missing or non-finite `noul`, timeout or abort → `{ decision: "ignore", reason }`. It never throws or rejects on the utterance path.

### §2.4 Decision and the continuation hold (non-blocking; r1 C1)

- `addressed ≥ addressedMin && finished ≥ finishedMin` → **speak**. Handle the line exactly like a wake-addressed line (same gate logic, same `processUserInput`, same ack), inside the chain.
- `addressed < addressedMin` → **ignore** (today's un-addressed handling).
- `addressed ≥ addressedMin && finished < finishedMin` → **wait** **[owner: wait up to 3 s, then speak]**:
  - Store a single hold `{ text, speakerId, deadline = now + continuationWaitMs, generation, contextSnapshot }` and **return**. The chain is never blocked by the hold, and there is never a `sleep(3000)` in `handleUtteranceEnd`.
  - Treat the line as un-addressed for the log (`[会議音声・保留]`), so it is visible in context.
- **Resolving the hold.** Every entry point checks `hold.generation` first. Only one hold exists at a time; a new wait replaces the old one.
  - **Wake word or wake+cancel from anyone** → cancel the hold, then today's path runs.
  - **Next `utterance_end` from the same attributed `speaker.id`** (a real id, not `UNKNOWN_SPEAKER_ID` and not null) → merge `hold.text + text` and judge once more. On that second judgement:
    - speak → speak,
    - addressed but still unfinished → **ignore** (there is only ever one wait),
    - otherwise → ignore.
  - **`utterance_end` from any other speaker, or from an unknown/null speaker** → cancel the hold. The new line is judged normally, and the held line is in its context. Unknown speakers **never merge** (r1 Kimi F4 / Devin F2 / Grok F4).
  - **Interim transcript from a different attributed `speaker.id`** (in `onSttTranscript`) → cancel the hold immediately (Grok Q4.5).
  - **Deadline timer** → append a job to `utteranceChain`. The timer never calls `processUserInput` itself. The job re-checks, in order:
    1. the generation is current,
    2. `replyTrigger` is still `"jev"`,
    3. not busy,
    4. `Date.now() ≥ liveUserSpeechUntil` (nobody is speaking).
    - All four hold → **speak** the held text. This is the owner's rule: no continuation came, so speak.
    - Speech is still active and it is attributed to the same `speaker.id` → a continuation is in flight. Keep the hold until that speaker's `utterance_end` merges it, up to a hard cap of `deadline + continuationWaitMs`. At the cap → **ignore**.
    - Speech is active and not attributed to the held speaker → **ignore**. Someone else has the floor, so speaking now would interrupt.
  - `replyTrigger` switched away from `"jev"`, `stopped`, or leave → drop the hold.
- **Double-speak guard (r1 Kimi F5).** A speak decision (fresh, merged or deadline) re-checks `hold.generation` and `!isProcessing` inside the chain right before `processUserInput`. Only the newest decision can speak.

### §2.5 Logging and metric

- One line per judgement: `🧭 [turn-judge] decision=speak|wait|ignore addressed=0.83 finished=0.93 ms=291 reason=… "<first 40 chars>"`.
- One `turn_judge` metric reusing the utterance's `metricsTurnId`: `decision`, `addressed`, `finished`, `latency_ms`, `reason`, `stage` (`first` | `merged` | `deadline`). No transcript text in the metric.
- Keys, the `Authorization` header and `Bearer` never appear in either (test).

### §2.6 Offline evaluation **[owner: synthetic + #264/#266 live logs]**

- `tools/eval-turn-judge.mjs` runs the real `judgeTurn()` with the key on a labelled JSONL set. It is manual and offline, never in `make test` (unit tests mock the judge).
- Each row: `{ id, source, context[], latest, label: speak|wait|ignore, labelled_with_context: true }`.
- The set has ≥ 60 rows (target ~100) and must contain:
  - greetings between people,
  - remarks *about* Caty,
  - follow-ups to Caty's previous line,
  - mid-sentence pauses (`wait`),
  - cap-split lines,
  - **unlabelled-speaker variants**,
  - the §0 misses.
- VPS journal lines are read-only pulls (already done: 130 lines, 2026-10-01, kept outside the repo). `[user]` / `[会議音声・未指名]` prefixes and speaker tags are stripped, real names are replaced, and only the anonymised set is committed.
- Report:
  - a confusion table **per source**, on a **held-out half**: the question wording may be refined on one half, and the reported numbers come from the other half. The thresholds stay at the owner's 0.75;
  - decision stability: each row is judged 3×, and the flip rate is reported near the thresholds;
  - latency: `extra_wait = max(0, judge_ms − 500)` over speak/ignore rows, p50/p90. The `wait` branch is reported separately (see §4 item 5).

### §2.7 #269 (folded in, separate commit `Fixes #269`)

- Guard all five reads (l.1920, 1927, 1935, 3073, 3079) per read. `faceMode` is latched, so a check at construction is not enough.
- Tests:
  - an utterance end after the face session is closed does not throw and still processes the utterance,
  - a reply TTS (`speakSentence`) after close does not throw.

## §3 Failure forms (worst first)

1. **Caty interrupts people who were talking to each other.** Mitigations:
   - the AND of two 0.75 thresholds,
   - fail-closed judge,
   - no judging of lines that arrived while Caty was busy,
   - a jev speak never aborts a reply,
   - a non-blocking hold with other-speaker cancel (on utterance or interim),
   - unknown speakers never merge,
   - a deadline speak only when nobody is speaking,
   - a generation guard.
2. **The default wake mode changes.** §2.2 keeps the default and hub paths byte-identical. Tests pin that the judge is never called and that the sleep → log → exit → wake → metric order is unchanged.
3. A stale answer after a long reply is closed by `busyAtArrival` (§2.3.4).
4. Silence too often makes the mode useless. The eval measures it, and the thresholds are tunable (hidden settings).
5. A crash or unhandled rejection on the utterance path: the judge never rejects, the hold timer job is caught inside the chain, and #269 is fixed.
6. A key leaking into logs or metrics (test).

## §4 Done when (owner-confirmed 2026-10-01; item 5 population clarified after r1)

1. `agent.replyTrigger` exists with default `"wake"`. With the default the behaviour is unchanged, and a test shows jev is never called.
2. In `"jev"` mode:
   - wake-word lines behave as today, with no jev call,
   - lines without a wake word are answered only when both scores reach the thresholds,
   - the 3 s wait rule of §2.4 holds.
3. Every jev failure (no key / error / invalid answer / timeout / abort) → silence. No crash or unhandled rejection.
4. One judge log line and one metric per judgement. No key in logs or metrics (test).
5. Offline eval on ≥ 60 labelled lines:
   - "spoke when it should not" ≤ 5%,
   - "silent when it should speak" recorded (target ≤ 30%),
   - added wait p90 ≤ 0.5 s beyond today's 500 ms buffer. *Population: speak/ignore judgements. The owner-chosen 3 s continuation wait is reported separately.*
   - The anonymised set and the results are committed.
6. `make test` green, review seats pass, and #269 fixed with tests.
7. Live check with the owner at an agreed time. Enabling the mode on the live service needs the owner's OK.

## §5 Files to touch (declared on #267; `test/pipeline-face-listen-null.test.js` added)

**New**
- `src/turn-judge.js`
- `docs/design/267-jev-turn-taking.md`
- `tools/eval-turn-judge.mjs`
- `test/fixtures/turn-judge/*`
- `test/turn-judge.test.js`
- `test/pipeline-turn-judge.test.js`
- `test/pipeline-face-listen-null.test.js`

**Changed**
- `src/pipeline.js`
- `src/settings/registry.js`
- `public/settings.js`
- `config.json.example`
- `docs/settings-contract.md`
- `docs/settings-env-inventory.json` (if needed)
- `test/settings-ui.test.js`

## §6 Questions for the delta round

- D1: Does §2.4 (non-blocking hold, chain-queued deadline job, generation guard) close r1 C1 / Kimi F1+F3+F5 / Devin F1+F8 / Grok F1+F4 without a new race?
- D2: Does `busyAtArrival` (§2.3.1, §2.3.4) close r1 C2 / Kimi F2 / Devin F3 / Grok F2? Is there a path where a line arriving during a reply is still judged after it?
- D3: Is §2.2 byte-identical for the default and hub paths?
- D4: Does the deadline rule stay faithful to the owner's "wait up to 3 s, then speak"? Speak only when idle; a same-speaker continuation in flight extends the hold up to a hard cap; otherwise ignore.
- Q0 again: is anything in v2 the wrong frame?

## §7 Round 1 adjudication (2026-10-01)

Seats: Kimi K3, Grok 4.6, Devin SWE-2 High (writer Opus 5.5). All three returned **GO-WITH-CONDITIONS**. Every seat judged the frame sound (Q0).

| # | Finding (seats) | Verdict | Where fixed |
|---|---|---|---|
| C1 | The 3 s wait inside `handleUtteranceEnd` blocks `utteranceChain`: merge becomes impossible, other-speaker cancel lands late, and the deadline speaks into a conversation that has moved on (Kimi F1, Devin F1, Grok F1 CRITICAL) | adopted (3/3 converged) | §2.4 non-blocking hold |
| C2 | The §2.6 v1 premise was wrong: non-wake lines never reach `pendingQueue`. Because the chain awaits `processUserInput`, lines spoken during a reply run afterwards with the gate OPEN and would be judged stale (Kimi F2, Devin F3, Grok F2 CRITICAL) | adopted (3/3) | §2.3.1 / §2.3.4 `busyAtArrival`; `pendingQueue` untouched |
| C3 | Deadline behaviour under active interim speech was undefined; `liveUserSpeechUntil` is global and poisoned by the held line itself (Kimi F3, Devin F8, Grok F4) | adopted (3/3) | §2.4 deadline job |
| C4 | "Same speaker" is undefined for unknown/null speakers and slot LRU (Kimi F4, Devin F2, Grok F4) | adopted (3/3) | §2.4 match on attributed `speaker.id`; unknown never merges |
| C5 | Moving the wake check before the sleep changes the default/hub order (Kimi F6, Devin F5/F6, Grok F3) | adopted | §2.2 / §2.3.2 jev-only pure peek |
| C6 | Double-speak race (Kimi F5, Grok Q4.4) | adopted | §2.4 generation guard; timer re-enters via the chain |
| C7 | `askJev` cannot be reused (Grok F5) | adopted | §2.3.6 own client |
| C8 | Done-when 5's p90 is ambiguous against the 3 s wait (Devin F4, Grok F6) | adopted as a population clarification (not a weakening; the owner's 3 s wait is reported separately) | §4.5 |
| C9 | `apply: "live"` means a per-utterance read; hidden knobs must be registry rows (Devin F7, Grok F7) | adopted | §2.1 |
| C10 | Eval hygiene: held-out split, per-source breakdown, context labels, unlabelled variants, stability (Kimi F7, Devin F9, Grok F6/Q5) | adopted | §2.6 |
| C11 | #269 must also cover `speakSentence` l.3073/3079 (Devin F11, Grok F8, Kimi F8) | adopted | §2.7 |
| C12 | Reopen-time judgement latency (Devin F10) | moot: no reopen-time judging in v2 | — |
