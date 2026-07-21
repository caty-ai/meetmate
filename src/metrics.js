const fs = require("node:fs");
const path = require("node:path");
const { logsDir } = require("./paths");

// Metrics default to a repo-local logs directory. Set METRICS_LOG_DIR to move
// the JSONL file, or METRICS_DISABLED=1 to make recording a true no-op.
const METRICS_LOG_DIR = logsDir();
const METRICS_DISABLED = ["1", "true", "yes"].includes(
  String(process.env.METRICS_DISABLED || "").toLowerCase()
);
const METRICS_LOG_FILE = path.join(METRICS_LOG_DIR, "metrics.jsonl");
const SHUTDOWN_FLUSH_TIMEOUT_MS = 250;

let warned = false;
let writeFailed = false;
let appendFile = fs.promises.appendFile;
let mkdir = fs.promises.mkdir;
const pendingWrites = new Set();
let beforeExitHandler = null;
let sigtermHandler = null;

if (!METRICS_DISABLED) {
  console.info(`metrics recording enabled: ${METRICS_LOG_FILE}`);
}

function warnOnce(err) {
  if (warned) return;
  writeFailed = true;
  warned = true;
  console.warn("metrics recording disabled after error:", err?.message || err);
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

if (!METRICS_DISABLED) {
  beforeExitHandler = () => flushPendingWrites().catch(warnOnce);
  sigtermHandler = () => flushPendingWrites({ bounded: true }).catch(warnOnce);
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
    dispose() {
      if (beforeExitHandler) {
        process.removeListener("beforeExit", beforeExitHandler);
        beforeExitHandler = null;
      }
      if (sigtermHandler) {
        process.removeListener("SIGTERM", sigtermHandler);
        sigtermHandler = null;
      }
    },
  },
};
