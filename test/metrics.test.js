const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { summarize } = require("../scripts/aggregate-metrics");

const loadedMetricsModules = new Set();

test.afterEach(() => {
  for (const metrics of loadedMetricsModules) {
    metrics._test?.dispose?.();
  }
  loadedMetricsModules.clear();
});

test("recordEvent writes one valid JSONL event with expected fields", async () => {
  const dir = tempDir();
  const metrics = freshMetrics({ METRICS_LOG_DIR: dir, METRICS_DISABLED: undefined });

  metrics.recordEvent("utterance_end", {
    meeting_id: "meeting-1",
    turn_id: "turn-1",
    transcript_char_count: 12,
  });
  await metrics._test.flush();

  const lines = fs.readFileSync(path.join(dir, "metrics.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);

  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "utterance_end");
  assert.equal(event.meeting_id, "meeting-1");
  assert.equal(event.turn_id, "turn-1");
  assert.equal(event.transcript_char_count, 12);
  assert.equal(Number.isInteger(event.timestamp_ms), true);
});

test("METRICS_DISABLED=1 performs no writes and creates no directory", async () => {
  const parent = tempDir();
  const dir = path.join(parent, "disabled-metrics");
  const metrics = freshMetrics({ METRICS_LOG_DIR: dir, METRICS_DISABLED: "1" });

  metrics.recordEvent("utterance_end", {
    meeting_id: "meeting-disabled",
    turn_id: "turn-disabled",
  });
  await metrics._test.flush();

  assert.equal(fs.existsSync(dir), false);
});

test("internal metrics write failures do not propagate to caller", async () => {
  const dir = tempDir();
  const metrics = freshMetrics({ METRICS_LOG_DIR: dir, METRICS_DISABLED: undefined });
  let appendCalls = 0;
  metrics._test.setAppendFileForTest(() => {
    appendCalls += 1;
    throw new Error("forced append failure");
  });

  assert.doesNotThrow(() => {
    metrics.recordEvent("first_token", {
      meeting_id: "meeting-2",
      turn_id: "turn-2",
    });
  });
  await metrics._test.flush();

  metrics.recordEvent("first_token", {
    meeting_id: "meeting-2",
    turn_id: "turn-2",
  });
  await metrics._test.flush();
  assert.equal(appendCalls, 1);
});

test("aggregate-metrics summarizes response and delegation data", () => {
  const dir = tempDir();
  const file = path.join(dir, "sample.jsonl");
  const events = [
    { timestamp_ms: 1_000, type: "utterance_end", meeting_id: "m", turn_id: "t1" },
    { timestamp_ms: 1_100, type: "ack_playback_start", meeting_id: "m", turn_id: "t1", ack_text: "はい" },
    { timestamp_ms: 1_500, type: "first_token", meeting_id: "m", turn_id: "t1" },
    { timestamp_ms: 3_000, type: "utterance_end", meeting_id: "m", turn_id: "t2" },
    { timestamp_ms: 3_800, type: "tts_playback_start", meeting_id: "m", turn_id: "t2" },
    { timestamp_ms: 3_900, type: "forced_delegation_fired", meeting_id: "m", turn_id: "t2", threshold_ms: 15000, elapsed_ms: 15010 },
    { timestamp_ms: 4_000, type: "handoff_requested", meeting_id: "m", turn_id: "t2", transcript_char_count: 20 },
  ];
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const output = execFileSync(process.execPath, ["scripts/aggregate-metrics.js", file], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });

  assert.match(output, /Turn count: 2/);
  assert.match(output, /Utterances observed \(incl\. unaddressed\): 2/);
  assert.match(output, /Perceived response time p50\/p90\/max: 100ms \/ 800ms \/ 800ms/);
  assert.match(output, /Ack immediacy rate: 1\/2 \(50\.0%\)/);
  assert.match(output, /Delegation events: 2/);
  assert.match(output, /Forced delegations \(Timer A\): 1/);
  assert.match(output, /Suspected misrouted turns: 1/);
});

test("aggregate-metrics handles empty event sets with sane zeros", () => {
  const summary = summarize([]);

  assert.equal(summary.utterancesObserved, 0);
  assert.equal(summary.turnCount, 0);
  assert.deepEqual(summary.responseTimes, []);
  assert.equal(summary.p50, null);
  assert.equal(summary.p90, null);
  assert.equal(summary.max, null);
  assert.equal(summary.ackTurns, 0);
  assert.equal(summary.ackRate, 0);
  assert.equal(summary.delegationCount, 0);
  assert.equal(summary.forcedDelegationCount, 0);

  const dir = tempDir();
  const file = path.join(dir, "empty.jsonl");
  fs.writeFileSync(file, "");
  const output = execFileSync(process.execPath, ["scripts/aggregate-metrics.js", file], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.match(output, /Turn count: 0/);
  assert.match(output, /Ack immediacy rate: 0\/0 \(0\.0%\)/);
});

test("aggregate-metrics counts silent addressed turns but excludes them from response samples", () => {
  const summary = summarize([
    { timestamp_ms: 1_000, type: "utterance_end", turn_id: "silent" },
    { timestamp_ms: 1_010, type: "wake_decision", turn_id: "silent", addressed: true },
  ]);

  assert.equal(summary.utterancesObserved, 1);
  assert.equal(summary.turnCount, 1);
  assert.deepEqual(summary.responseTimes, []);
  assert.equal(summary.ackRate, 0);
});

test("aggregate-metrics skips invalid JSONL lines and warns once per file", () => {
  const dir = tempDir();
  const file = path.join(dir, "truncated.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp_ms: 1_000, type: "utterance_end", turn_id: "t1" }),
    JSON.stringify({ timestamp_ms: 1_050, type: "ack_playback_start", turn_id: "t1" }),
    "{\"timestamp_ms\":",
  ].join("\n"));

  const result = spawnSync(process.execPath, ["scripts/aggregate-metrics.js", file], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /skipped 1 invalid line\(s\), first at line 3/);
  assert.match(result.stdout, /Turn count: 1/);
  assert.match(result.stdout, /Ack immediacy rate: 1\/1 \(100\.0%\)/);
});

test("aggregate-metrics excludes unaddressed wake turns and includes non-wake turns", () => {
  const summary = summarize([
    { timestamp_ms: 1_000, type: "utterance_end", turn_id: "wake-unaddressed" },
    { timestamp_ms: 1_010, type: "wake_decision", turn_id: "wake-unaddressed", addressed: false },
    { timestamp_ms: 1_020, type: "ack_playback_start", turn_id: "wake-unaddressed" },
    { timestamp_ms: 2_000, type: "utterance_end", turn_id: "wake-addressed" },
    { timestamp_ms: 2_010, type: "wake_decision", turn_id: "wake-addressed", addressed: true },
    { timestamp_ms: 2_200, type: "tts_playback_start", turn_id: "wake-addressed" },
    { timestamp_ms: 3_000, type: "utterance_end", turn_id: "non-wake" },
    { timestamp_ms: 3_100, type: "ack_playback_start", turn_id: "non-wake" },
  ]);

  assert.equal(summary.utterancesObserved, 3);
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.ackTurns, 1);
  assert.equal(summary.ackRate, 0.5);
  assert.deepEqual(summary.responseTimes, [200, 100]);
});

function freshMetrics(env) {
  const file = path.join(__dirname, "..", "src", "metrics.js");
  const resolved = require.resolve(file);
  require.cache[resolved]?.exports?._test?.dispose?.();
  const previousEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  delete require.cache[resolved];
  const metrics = require(file);
  loadedMetricsModules.add(metrics);
  delete require.cache[resolved];

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return metrics;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
}
