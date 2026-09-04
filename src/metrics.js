const fs = require("node:fs");
const path = require("node:path");
const { metricsLogDir } = require("./paths");
const { scrubLogMessage } = require("./log-scrub");

// Metrics default to the home logs directory (AI_MEET_HOME, else cwd). Set
// METRICS_LOG_DIR to move the JSONL file (metrics only — conversation logs
// stay in logsDir()), or METRICS_DISABLED=1 to make recording a true no-op.
const METRICS_LOG_DIR = metricsLogDir();
const METRICS_DISABLED = ["1", "true", "yes"].includes(
  String(process.env.METRICS_DISABLED || "").toLowerCase()
);
const METRICS_LOG_FILE = path.join(METRICS_LOG_DIR, "metrics.jsonl");
const SHUTDOWN_FLUSH_TIMEOUT_MS = 250;
const SIGTERM_EXIT_TIMEOUT_MS = 2_000;
const SIGTERM_RERAISE_FALLBACK_MS = 100;
const SIGTERM_EXIT_CODE = 128 + 15;

const defaultKillProcess = (pid, signal) => process.kill(pid, signal);
const defaultExitProcess = (code) => process.exit(code);

let warned = false;
let writeFailed = false;
let appendFile = fs.promises.appendFile;
let mkdir = fs.promises.mkdir;
const pendingWrites = new Set();
let beforeExitHandler = null;
let sigtermHandler = null;
let sigtermExitRequested = false;
let killProcess = defaultKillProcess;
let exitProcess = defaultExitProcess;

if (!METRICS_DISABLED) {
  console.info(`metrics recording enabled: ${METRICS_LOG_FILE}`);
}

function warnOnce(err) {
  if (warned) return;
  writeFailed = true;
  warned = true;
  console.warn("metrics recording disabled after error:", scrubLogMessage((err || {}).message || err, undefined));
}

function queueWrite(line) {
  if (writeFailed) return;
  const write = Promise.resolve()
    .then(() => mkdir(METRICS_LOG_DIR, { recursive: true }))
    .then(() => appendFile(METRICS_LOG_FILE, line, "utf8"))
    .catch(warnOnce);

  pendingWrites.add(write);
  write
    .finally(() => pendingWrites.delete(write))
    .catch(() => {});
}

function recordEvent(type, fields = {}) {
  try {
    if (METRICS_DISABLED || writeFailed) return;
    const event = {
      timestamp_ms: Date.now(),
      type,
      ...fields,
    };
    queueWrite(`${JSON.stringify(event)}\n`);
  } catch (err) {
    warnOnce(err);
  }
}

function getMetricsLogPath() {
  return METRICS_LOG_FILE;
}

function flushPendingWrites({ bounded = false } = {}) {
  const flush = Promise.allSettled([...pendingWrites]);
  if (!bounded) return flush;
  return Promise.race([
    flush,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

function terminateWithSigterm() {
  if (sigtermExitRequested) return;
  sigtermExitRequested = true;
  if (sigtermHandler) {
    process.removeListener("SIGTERM", sigtermHandler);
    sigtermHandler = null;
  }
  try {
    // Re-raise first to preserve the conventional signal exit status. Linux PID 1
    // ignores default-disposition signals, so a referenced fallback must follow.
    killProcess(process.pid, "SIGTERM");
  } finally {
    setTimeout(() => exitProcess(SIGTERM_EXIT_CODE), SIGTERM_RERAISE_FALLBACK_MS);
  }
}

if (!METRICS_DISABLED) {
  beforeExitHandler = () => flushPendingWrites().catch(warnOnce);
  sigtermHandler = () => {
    // Keep this timer referenced so shutdown cannot outlive the hard cap even if
    // the bounded flush chain unexpectedly fails to settle.
    const exitTimer = setTimeout(() => exitProcess(SIGTERM_EXIT_CODE), SIGTERM_EXIT_TIMEOUT_MS);
    flushPendingWrites({ bounded: true })
      .catch(warnOnce)
      .finally(() => {
        clearTimeout(exitTimer);
        terminateWithSigterm();
      });
  };
  process.once("beforeExit", beforeExitHandler);
  process.once("SIGTERM", sigtermHandler);
}

module.exports = {
  recordEvent,
  getMetricsLogPath,
  _test: {
    async flush() {
      await flushPendingWrites();
    },
    setAppendFileForTest(fn) {
      appendFile = fn;
    },
    setMkdirForTest(fn) {
      mkdir = fn;
    },
    setTerminationForTest({ kill, exit }) {
      killProcess = kill;
      exitProcess = exit;
    },
    terminateWithSigterm,
    dispose() {
      if (beforeExitHandler) {
        process.removeListener("beforeExit", beforeExitHandler);
        beforeExitHandler = null;
      }
      if (sigtermHandler) {
        process.removeListener("SIGTERM", sigtermHandler);
        sigtermHandler = null;
      }
      killProcess = defaultKillProcess;
      exitProcess = defaultExitProcess;
    },
  },
};
