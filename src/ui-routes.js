const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DEFAULT_METRICS_LOG_DIR = path.join(__dirname, "..", "logs");
const METRICS_TAIL_BYTES = 5 * 1024 * 1024;
const MAX_WINDOW_HOURS = 168;

const PUBLIC_ASSETS = new Map([
  ["/style.css", { filename: "style.css", contentType: "text/css; charset=utf-8" }],
  ["/app.js", { filename: "app.js", contentType: "application/javascript; charset=utf-8" }],
]);

function hasTraversal(req) {
  const rawPath = String(req.url || "").split(/[?#]/, 1)[0];
  if (rawPath.includes("..")) return true;
  try {
    return decodeURIComponent(rawPath).includes("..");
  } catch {
    return true;
  }
}

function servePublicAsset(req, res, url = new URL(req.url || "/", "http://localhost")) {
  if (req.method !== "GET") return false;
  if (hasTraversal(req)) {
    writePlain(res, 404, "Not Found");
    return true;
  }

  const asset = PUBLIC_ASSETS.get(url.pathname);
  if (!asset) return false;

  fs.readFile(path.join(PUBLIC_DIR, asset.filename), (err, data) => {
    if (err) {
      writePlain(res, 404, "Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": data.length,
    });
    res.end(data);
  });
  return true;
}

async function sendMetricsSummary(req, res, url = new URL(req.url || "/", "http://localhost")) {
  if (req.method !== "GET" || url.pathname !== "/metrics") return false;
  const summary = await readMetricsSummary(url.searchParams.get("hours"));
  writeJson(res, 200, summary);
  return true;
}

async function readMetricsSummary(hoursParam) {
  const windowHours = clampHours(hoursParam);
  const logFile = getMetricsLogFile();
  let text;
  try {
    text = await readTail(logFile, METRICS_TAIL_BYTES);
  } catch {
    return { enabled: false };
  }

  if (!text.trim()) {
    return {
      enabled: true,
      windowHours,
      totals: emptyTotals(),
      recentSessions: [],
    };
  }

  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  const totals = emptyTotals();
  const sessions = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const timestampMs = Number(event.timestamp_ms);
    if (!Number.isFinite(timestampMs) || timestampMs < cutoff) continue;
    const sessionId = toSessionId(event);
    const session = sessionId ? getSessionSummary(sessions, sessionId, timestampMs) : null;
    if (session) {
      session.startedAtMs = Math.min(session.startedAtMs, timestampMs);
      session.lastEventMs = Math.max(session.lastEventMs, timestampMs);
    }

    switch (event.type) {
      case "wake_decision":
        totals.wakeDecisions += 1;
        if (event.addressed === true) {
          totals.addressed += 1;
          if (session) session.wakeAddressed += 1;
        } else if (event.addressed === false && session) {
          session.wakeIgnored += 1;
        }
        break;
      case "turn_end":
        totals.turns += 1;
        if (session) session.turns += 1;
        break;
      case "utterance_end":
        totals.utterances += 1;
        break;
      case "tts_playback_start":
        totals.ttsPlaybacks += 1;
        break;
      default:
        break;
    }
  }

  const recentSessions = [...sessions.values()]
    .sort((a, b) => b.lastEventMs - a.lastEventMs)
    .slice(0, 5);

  return {
    enabled: true,
    windowHours,
    totals,
    recentSessions,
  };
}

function getMetricsLogFile() {
  const dir = process.env.METRICS_LOG_DIR
    ? path.resolve(process.env.METRICS_LOG_DIR)
    : DEFAULT_METRICS_LOG_DIR;
  return path.join(dir, "metrics.jsonl");
}

function clampHours(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return Math.min(Math.floor(parsed), MAX_WINDOW_HOURS);
}

function emptyTotals() {
  return {
    wakeDecisions: 0,
    addressed: 0,
    turns: 0,
    utterances: 0,
    ttsPlaybacks: 0,
  };
}

function toSessionId(event) {
  return String(event.session_id || event.sessionId || event.meeting_id || "").trim();
}

function getSessionSummary(sessions, sessionId, timestampMs) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      startedAtMs: timestampMs,
      lastEventMs: timestampMs,
      turns: 0,
      wakeAddressed: 0,
      wakeIgnored: 0,
    });
  }
  return sessions.get(sessionId);
}

async function readTail(file, maxBytes) {
  const stat = await fs.promises.stat(file);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function writePlain(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

module.exports = {
  servePublicAsset,
  sendMetricsSummary,
  readMetricsSummary,
  _test: {
    clampHours,
    readTail,
    getMetricsLogFile,
  },
};
