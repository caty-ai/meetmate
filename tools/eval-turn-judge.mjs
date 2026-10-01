#!/usr/bin/env node
// #267 offline evaluation of the jev reply trigger (manual; never part of make test).
//
//   /path/to/with-key.sh node tools/eval-turn-judge.mjs --split report --runs 3 \
//     --out test/fixtures/turn-judge/eval-results-report.json
//
// Runs the real judgeTurn() from src/turn-judge.js against the labelled set,
// with the request state shaped exactly like the pipeline does (last
// `contextLines` person lines + the last 2 assistant lines, speakers as
// pseudonyms) and the registry-default thresholds and timeout. The key comes
// from the environment only and is never printed.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { judgeTurn, buildJudgeState, buildQuestions } = require(path.join(root, "src", "turn-judge.js"));
const { REGISTRY_BY_ID } = require(path.join(root, "src", "settings", "registry.js"));

function parseArgs(argv) {
  const args = { set: path.join(root, "test", "fixtures", "turn-judge", "eval-set.jsonl"), split: "report", runs: 3, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--set") { args.set = path.resolve(value); i += 1; }
    else if (flag === "--split") { args.split = value; i += 1; }
    else if (flag === "--runs") { args.runs = Number(value); i += 1; }
    else if (flag === "--out") { args.out = path.resolve(value); i += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!["tune", "report", "all"].includes(args.split)) throw new Error("--split must be tune, report or all");
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error("--runs must be a positive integer");
  return args;
}

const defaults = {
  addressedMin: REGISTRY_BY_ID.agent_reply_judge_addressed_min.defaultValue,
  finishedMin: REGISTRY_BY_ID.agent_reply_judge_finished_min.defaultValue,
  timeoutMs: REGISTRY_BY_ID.agent_reply_judge_timeout_ms.defaultValue,
  contextLines: REGISTRY_BY_ID.agent_reply_judge_context_lines.defaultValue,
};
const ASSISTANT = { name: "Caty (ケイティ)", label: "Caty" };
const BUFFER_MS = 500;

// Same shaping as src/pipeline.js turnJudgeContext(): last N person lines plus
// the last two assistant lines, in conversation order.
function stateFor(row) {
  const indexed = row.context.map((line, index) => ({ ...line, index }));
  const people = indexed.filter((line) => !line.assistant).slice(-defaults.contextLines);
  const replies = indexed.filter((line) => line.assistant).slice(-2);
  const lines = [...people, ...replies].sort((a, b) => a.index - b.index)
    .map((line) => (line.assistant ? { assistant: true, text: line.text } : { speakerKey: line.speaker, text: line.text }));
  return buildJudgeState({
    assistantName: ASSISTANT.name,
    assistantLabel: ASSISTANT.label,
    lines,
    latest: { speakerKey: row.latest.speaker, text: row.latest.text },
  });
}

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};
const pct = (num, den) => (den === 0 ? null : Math.round((1000 * num) / den) / 10);

function summarise(results) {
  const labels = ["speak", "wait", "ignore"];
  const bySource = {};
  for (const source of ["synthetic", "live", "all"]) {
    const rows = results.filter((row) => source === "all" || row.source === source);
    const confusion = Object.fromEntries(labels.map((label) => [label, { speak: 0, wait: 0, ignore: 0 }]));
    for (const row of rows) for (const call of row.calls) confusion[row.label][call.decision] += 1;
    const total = (label) => labels.reduce((sum, decision) => sum + confusion[label][decision], 0);
    const notSpeak = total("wait") + total("ignore");
    bySource[source] = {
      rows: rows.length,
      calls: rows.reduce((sum, row) => sum + row.calls.length, 0),
      confusion,
      falseSpeakRate: pct(confusion.wait.speak + confusion.ignore.speak, notSpeak),
      waitOnIgnoreRate: pct(confusion.ignore.wait, total("ignore")),
      falseSilenceRate: pct(confusion.speak.ignore, total("speak")),
      waitOnSpeakRate: pct(confusion.speak.wait, total("speak")),
    };
  }
  const flips = results.filter((row) => new Set(row.calls.map((call) => call.decision)).size > 1);
  const nearThreshold = results.filter((row) => row.calls.some((call) => [call.addressed, call.finished].some((score) => {
    return typeof score === "number" && Math.abs(score - defaults.addressedMin) <= 0.1;
  })));
  const nearFlips = nearThreshold.filter((row) => new Set(row.calls.map((call) => call.decision)).size > 1);
  const calls = results.flatMap((row) => row.calls);
  const finalCalls = calls.filter((call) => call.decision === "speak" || call.decision === "ignore");
  const waitCalls = calls.filter((call) => call.decision === "wait");
  const reasons = {};
  for (const call of calls) reasons[call.reason] = (reasons[call.reason] || 0) + 1;
  return {
    bySource,
    stability: {
      flipRows: flips.length,
      flipRate: pct(flips.length, results.length),
      nearThresholdRows: nearThreshold.length,
      nearThresholdFlipRows: nearFlips.length,
      nearThresholdFlipRate: pct(nearFlips.length, nearThreshold.length),
      flippedIds: flips.map((row) => row.id),
    },
    latency: {
      speakIgnore: {
        calls: finalCalls.length,
        judgeMsP50: quantile(finalCalls.map((call) => call.latencyMs), 0.5),
        judgeMsP90: quantile(finalCalls.map((call) => call.latencyMs), 0.9),
        extraWaitMsP50: quantile(finalCalls.map((call) => Math.max(0, call.latencyMs - BUFFER_MS)), 0.5),
        extraWaitMsP90: quantile(finalCalls.map((call) => Math.max(0, call.latencyMs - BUFFER_MS)), 0.9),
      },
      wait: {
        calls: waitCalls.length,
        judgeMsP50: quantile(waitCalls.map((call) => call.latencyMs), 0.5),
        judgeMsP90: quantile(waitCalls.map((call) => call.latencyMs), 0.9),
        continuationWaitMs: REGISTRY_BY_ID.agent_reply_judge_continuation_wait_ms.defaultValue,
      },
    },
    reasons,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set; run through the key wrapper");
    process.exit(2);
  }
  const rows = fs.readFileSync(args.set, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => args.split === "all" || row.split === args.split);
  const questions = buildQuestions(ASSISTANT.label);
  const results = [];
  for (const row of rows) {
    const state = stateFor(row);
    const calls = [];
    for (let run = 0; run < args.runs; run += 1) {
      const result = await judgeTurn({ state, questions, addressedMin: defaults.addressedMin, finishedMin: defaults.finishedMin, timeoutMs: defaults.timeoutMs });
      calls.push(result);
    }
    results.push({ id: row.id, source: row.source, category: row.category, split: row.split, label: row.label, latest: row.latest.text, calls });
    const decisions = calls.map((call) => call.decision[0]).join("");
    const scores = calls.map((call) => `${call.addressed?.toFixed?.(2) ?? "-"}/${call.finished?.toFixed?.(2) ?? "-"}`).join(" ");
    console.log(`${row.id.padEnd(12)} ${row.label.padEnd(6)} ${decisions} ${scores} ${calls.map((call) => call.latencyMs).join(",")}ms`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    split: args.split,
    runsPerRow: args.runs,
    thresholds: { addressedMin: defaults.addressedMin, finishedMin: defaults.finishedMin },
    timeoutMs: defaults.timeoutMs,
    contextLines: defaults.contextLines,
    questions,
    summary: summarise(results),
    rows: results,
  };
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error) => {
  console.error(`eval failed: ${error.message}`);
  process.exit(1);
});
