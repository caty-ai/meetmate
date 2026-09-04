const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
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

test("warnOnce scrubs labelled secrets from write failures", async () => {
  const secret = "key" + "_" + "abc12";
  const metrics = freshMetrics({ METRICS_LOG_DIR: tempDir(), METRICS_DISABLED: undefined });
  const warnings = [];
  const originalWarn = console.warn;
  metrics._test.setAppendFileForTest(() => {
    throw new Error(`api_key=${secret}`);
  });
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    metrics.recordEvent("first_token", { meeting_id: "meeting-scrub" });
    await metrics._test.flush();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^metrics recording disabled after error:/);
  assert.match(warnings[0], /\[REDACTED\]/);
  assert.equal(warnings[0].includes(secret), false);
});

test("warnOnce preserves benign write failures", async () => {
  const metrics = freshMetrics({ METRICS_LOG_DIR: tempDir(), METRICS_DISABLED: undefined });
  const warnings = [];
  const originalWarn = console.warn;
  metrics._test.setAppendFileForTest(() => {
    throw new Error("upstream 503");
  });
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    metrics.recordEvent("first_token", { meeting_id: "meeting-benign" });
    await metrics._test.flush();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], "metrics recording disabled after error: upstream 503");
  assert.equal(warnings[0].includes("[REDACTED]"), false);
});

test("SIGTERM flushes pending metrics and terminates with signal semantics", async (t) => {
  const dir = tempDir();
  const metricsPath = path.join(__dirname, "..", "src", "metrics.js");
  const script = `
    const fs = require("node:fs");
    const metrics = require(${JSON.stringify(metricsPath)});
    const appendFile = fs.promises.appendFile.bind(fs.promises);

    metrics._test.setAppendFileForTest((...args) => new Promise((resolve, reject) => {
      process.once("SIGTERM", () => appendFile(...args).then(resolve, reject));
      process.stdout.write("ready\\n");
    }));
    metrics.recordEvent("sigterm_test", { meeting_id: "sigterm-meeting" });
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      METRICS_LOG_DIR: dir,
      METRICS_DISABLED: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitForChildOutput(child, () => output, /ready\n/, 3_000);

  assert.equal(child.kill("SIGTERM"), true);
  const exitTimeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
  const result = await exited.finally(() => clearTimeout(exitTimeout));

  assert.deepEqual(result, { code: null, signal: "SIGTERM" }, output);
  const lines = fs.readFileSync(path.join(dir, "metrics.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(Number.isInteger(event.timestamp_ms), true);
  assert.equal(event.type, "sigterm_test");
  assert.equal(event.meeting_id, "sigterm-meeting");
});

test("SIGTERM falls back to exit 143 when re-raise does not terminate", async () => {
  const metrics = freshMetrics({ METRICS_LOG_DIR: tempDir(), METRICS_DISABLED: undefined });
  const calls = [];
  let resolveExit;
  const exitCalled = new Promise((resolve) => { resolveExit = resolve; });
  metrics._test.setTerminationForTest({
    kill(pid, signal) {
      calls.push({ type: "kill", pid, signal });
    },
    exit(code) {
      calls.push({ type: "exit", code });
      resolveExit(code);
    },
  });

  const startedAt = Date.now();
  metrics._test.terminateWithSigterm();
  assert.deepEqual(calls, [{ type: "kill", pid: process.pid, signal: "SIGTERM" }]);

  let timeout;
  try {
    const code = await Promise.race([
      exitCalled,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for exit fallback")), 500);
      }),
    ]);
    assert.equal(code, 143);
    assert.ok(Date.now() - startedAt < 500, "exit fallback exceeded its bounded window");
  } finally {
    clearTimeout(timeout);
  }
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
    { timestamp_ms: 4_100, type: "delegate_replied_no_spawn", meeting_id: "m", runId: "r1", fresh: true },
    { timestamp_ms: 4_200, type: "delegate_replied_no_spawn", meeting_id: "m", runId: "r2", fresh: false },
    { timestamp_ms: 4_300, type: "circuit_breaker", meeting_id: "m", state: "open", consecutive_timeouts: 2 },
    { timestamp_ms: 4_400, type: "subagent_spawned", meeting_id: "m", source: "delegate", child_key: "c" },
    { timestamp_ms: 4_500, type: "handoff_received", meeting_id: "m", source: "forced", pending_key: "p" },
    { timestamp_ms: 4_600, type: "auto_announce_injected", meeting_id: "m", runId: "announce:v1:child:run" },
    { timestamp_ms: 4_700, type: "forced_delegation_skipped", meeting_id: "m", turn_id: "t3", reason: "ping" },
    { timestamp_ms: 4_800, type: "parent_compact", meeting_id: "m", ok: true, compacted: true },
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
  assert.match(output, /Delegation events: 10/);
  assert.match(output, /Forced delegations \(Timer A\): 1/);
  assert.match(output, /Delegate no-spawn replies: fresh=1, stale_or_dropped=1/);
  assert.match(output, /Circuit breaker opens: 1/);
  assert.match(output, /Gateway subagents spawned: 1/);
  assert.match(output, /Suspected misrouted turns: 1/);

  const summary = summarize(events);
  assert.equal(summary.eventTypeCounts.handoff_received, 1);
  assert.equal(summary.eventTypeCounts.auto_announce_injected, 1);
  assert.equal(summary.eventTypeCounts.forced_delegation_skipped, 1);
  assert.equal(summary.eventTypeCounts.parent_compact, 1);
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

function waitForChildOutput(child, getOutput, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}:\n${getOutput()}`));
    }, timeoutMs);
    const inspect = () => {
      const match = getOutput().match(pattern);
      if (!match) return;
      cleanup();
      resolve(match);
    };
    const exited = (code, signal) => {
      cleanup();
      reject(new Error(`Process exited before ${pattern} (${code ?? signal}):\n${getOutput()}`));
    };
    const errored = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", exited);
      child.off("error", errored);
    };

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", exited);
    child.once("error", errored);
    inspect();
  });
}
