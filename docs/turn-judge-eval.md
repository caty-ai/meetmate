# Offline eval: jev reply trigger (#267)

Manual, offline evaluation of `src/turn-judge.js` for `agent.replyTrigger: "jev"`.
It is never part of `make test`; unit tests stub `fetch`.

- Set: `test/fixtures/turn-judge/eval-set.jsonl`, 101 rows. 81 are synthetic and 20 are live.
- Results: `test/fixtures/turn-judge/eval-results-report.json` (held-out half, the reported numbers) and `eval-results-tune.json` (tune half). Both use the frozen v3 wording on the re-anonymised set.
- Tool: `tools/eval-turn-judge.mjs`. It calls the real `judgeTurn()` and builds the request state the same way the pipeline does: the last 6 person lines plus Caty's last 2 lines, with speakers sent as pseudonyms (`参加者A`, `unknown`). Thresholds and timeout are read from the registry defaults (0.75 / 0.75 / 800 ms).
- Run: `<wrapper that exports TYPESAFE_API_KEY> node tools/eval-turn-judge.mjs --split report --runs 3 --out …`. Each row is judged 3 times. The runs were made from the Mac in Japan on 2026-10-01 (JST).

## The set

| Source | Rows | speak | wait | ignore |
|---|---|---|---|---|
| synthetic | 81 | 24 | 12 | 45 |
| live | 20 | 5 | 7 | 8 |

- **Synthetic** meeting lines cover:
  - greetings between people,
  - remarks about Caty without the wake word,
  - follow-ups to Caty's previous line,
  - mid-sentence pauses,
  - cap-split lines (a line cut at the 120-char cap, then its tail),
  - questions between people,
  - requests to "AIさん" / "アシスタントさん",
  - fillers and backchannels,
  - the §0 misses (`よろしくお願いします`, `じゃあそれで予約しておいて`, `まず前提として、今期の`).
  - Twenty rows have an **unlabelled-speaker** variant (`-u`), in which every person line has no speaker.
- **Live** rows are the non-wake `[user]` lines from the owner's own 1:1 checks with Caty (#264/#266 VPS journal, read-only pull). The context is the preceding lines of the same session, including wake lines and Caty's replies. Live audio had no speaker attribution, so every live person line is `unknown`.
- **Anonymisation.** The whole set (live and synthetic) contains no real person names, no real place names, no holidays, no calendar dates and no named venues or personal projects.
  - Log prefixes and emotion tags were stripped.
  - Person names are placeholders (田中 / 佐藤 / 鈴木 / 高橋, and a pet ポチ).
  - Cities and airports are `A市` / `B市` / `近くの3都市`, the trip venue is `テーマパーク`, and the holiday is `大型連休`.
  - Weekday and date references were generalised to `週末` / `今週末`.
  - The owner's project was generalised to `資料`.
  - Kept as generic, non-identifying words: `海外`, `直行便`, `今週末の土日`.
  - The labels did not change when this second pass was applied (review r1 A1).
  - Third pass (impl delta, Kimi N1 / Devin N3). This pass was applied **after** the eval runs below, to the fixture and the results text only. Three quasi-identifying trip details were generalised:
    - the signature attraction → `人気のアトラクションがあって`
    - `深夜便` → `夜の便`
    - the visa question → `必要な手続きがあるかどうか`
    - The judge therefore saw the pre-edit wording for these rows (live-012/013/019/020 and their context in later rows). Labels, splits and every reported number are unchanged. The meaning of each line is the same, so it was not re-run.
- **Labels** were set by reading the context (`labelled_with_context: true`):
  - `speak`: a reply from Caty now is right, and silence would be a miss.
  - `wait`: the line is addressed to Caty, but the speaker is about to continue.
  - `ignore`: Caty should stay quiet (people talking to each other, remarks, fillers).
- **Split.** Rows are grouped: a base row, its `-u` variant and both parts of a cap-split pair share a group. Groups are stratified by source and label, then alternated into `tune` (52 rows) and `report` (49 rows).
  - The §0 follow-up miss (`syn-016` `じゃあそれで予約しておいて` and `syn-016-u`) fell in the **tune** half, so it is not part of the reported numbers.
  - Rows were not moved. In the final tune run, `syn-016` flipped once (addressed 0.74 → ignore, then 0.75 and 0.76 → speak), and `syn-016-u` scored speak on all 3 calls.

## Question wording (tuned on the tune half only)

The thresholds were never changed (owner-fixed 0.75 / 0.75). Only the question wording was refined, and only against the tune half. After the wording was frozen, the report half was run once. After the r1 re-anonymisation, both halves were run once more on the same frozen wording.

| Version | Change | Tune: false speak | Tune: false silence | Tune: wait on ignore |
|---|---|---|---|---|
| v1 (§0 probe wording) | — | 0.0% | 24.4% | 3.7% |
| v2 | "addressed" also counts a reply to something Caty just asked or offered, and excludes pure fillers or backchannels | 1.8% | 6.7% | 0.0% |
| v3 (shipped) | "finished" says that a line stopping mid-phrase (on a particle or an unfinished modifier) is not finished | 0.0% | 6.7% | 0.0% |
| v3, re-anonymised set | none (same wording) | 0.0% | 8.9% | 0.0% |

The shipped wording is in `buildQuestions()` in `src/turn-judge.js`. It is recorded verbatim in both results files.

## Results on the held-out report half (49 rows × 3 calls = 147 calls)

The confusion tables count individual calls. Rows are the label; columns are the decision.

**synthetic** (40 rows, 120 calls)

| label \ decision | speak | wait | ignore |
|---|---|---|---|
| speak | 31 | 5 | 0 |
| wait | 0 | 18 | 0 |
| ignore | 0 | 0 | 66 |

**live** (9 rows, 27 calls)

| label \ decision | speak | wait | ignore |
|---|---|---|---|
| speak | 3 | 3 | 0 |
| wait | 0 | 3 | 6 |
| ignore | 0 | 0 | 12 |

| Metric | synthetic | live | all | Done-when bar |
|---|---|---|---|---|
| **Spoke when it should not** (speak on a wait/ignore row) | 0.0% | 0.0% | **0.0%** | ≤ 5% — met |
| Wait on an ignore row (could speak at the 3 s deadline if nobody talks) | 0.0% | 0.0% | 0.0% | reported |
| **Silent when it should speak** (ignore on a speak row) | 0.0% | 0.0% | **0.0%** | target ≤ 30% — met |
| Wait on a speak row (answered after the 3 s wait, or merged with a continuation) | 13.9% | 50.0% | 19.0% | reported |

- **Stability:** 1 of 49 rows flipped across its 3 calls (2.0%). That row is `syn-017`, whose "finished" score sat at 0.73–0.76 (wait / wait / speak). Among the 13 rows with a score within ±0.10 of 0.75, the flip rate is 1/13 = 7.7%. No row flipped between `speak` and `ignore`.
- **Latency:**
  - `extra_wait = max(0, judge_ms − 500)` over speak/ignore decisions (118 calls): **p50 0 ms, p90 0 ms** (bar p90 ≤ 500 ms, met). Judge time over the same calls was p50 289 ms and p90 372 ms, so every call finished inside today's 500 ms buffer. No call timed out.
  - The `wait` branch is reported separately (29 calls): judge time p50 296 ms and p90 351 ms, then the owner-chosen continuation wait of 3000 ms.

**What changed after re-anonymisation (same wording, same thresholds).** Compared with the first report run:
- `syn-017` went from speak/wait/speak to wait/wait/speak, so synthetic speak→wait rose from 4 to 5 calls. The wait-on-speak rate rose from 11.1% to 13.9% (synthetic) and from 16.7% to 19.0% (all).
- The near-threshold row count went from 14 to 13 (flip rate 7.1% → 7.7%).
- Judge p90 went from 319 ms to 372 ms (network variation; extra wait is still 0).
- False speak and false silence are unchanged at 0.0%.
- On the tune half, false silence went from 6.7% to 8.9% (the single `syn-016` flip above).

## Honest reading

- **The main cost is lateness, not interruption.** On the report half, 8 of 42 speak-row calls chose `wait`:
  - `syn-017` / `syn-017-u`: `うん、競合の最新キャンペーンを調べて`.
  - `live-006`: `で、近場のところをピックアップってできたりするかな。`
  - In production these are answered after 3 s of silence, or merged if the speaker continues.
- **Two live `wait` rows came back `ignore`.**
  - `live-003`: `えっと、佐藤様、なんか。`, addressed to a named person.
  - `live-005`: `海外？`, a one-word fragment.
  - Both are silences, not interruptions. The live `wait` labels are the least certain in the set.
- **The unlabelled variants behave like the labelled rows.** The report half has no false speak on them. Their "addressed" scores are higher on some ignore rows, though:
  - `syn-044-u`: 0.44–0.48 against 0.13–0.15 for the labelled row,
  - `syn-057-u`: 0.55–0.59.
  - This is the direction to watch when attribution is missing.
- **The sample is small.** The live rows come from one person in 1:1 calls (9 rows on the report half), so the live percentages have wide error bars. A multi-person live meeting with attribution has not been measured yet; that is Done-when item 7 (a live check with the owner).
- **Latency was measured from the Mac.** The live service runs on the VPS, which is outside Japan. Its latency to `api.typesafe.ai` was not measured here. The judge timeout (800 ms) bounds the worst case at +300 ms.
- **Labels are one annotator's reading of the context** (the implementer's). No rows were dropped after the runs, and the thresholds were not touched.
