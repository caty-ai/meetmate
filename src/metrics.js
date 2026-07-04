const fs = require("node:fs");
const path = require("node:path");

// Metrics default to a repo-local logs directory. Set METRICS_LOG_DIR to move
// the JSONL file, or METRICS_DISABLED=1 to make recording a true no-op.
const DEFAULT_METRICS_LOG_DIR = path.join(__dirname, "..", "logs");
const METRICS_LOG_DIR = process.env.METRICS_LOG_DIR
  ? path.resolve(process.env.METRICS_LOG_DIR)
  : DEFAULT_METRICS_LOG_DIR;
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
  process.once("beforeExit", () => flushPendingWrites().catch(warnOnce));
  process.once("SIGTERM", () => flushPendingWrites({ bounded: true }).catch(warnOnce));
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
  },
};
