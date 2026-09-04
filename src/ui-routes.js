const fs = require("fs");
const path = require("path");
const { bundledPublicDir, metricsLogDir, resolveHome } = require("./paths");
const { scrubLogMessage } = require("./log-scrub");

function scrubErrorMessage(err, secret) {
  return scrubLogMessage(err && err.message ? err.message : err, secret);
}

const PUBLIC_DIR = bundledPublicDir();
const METRICS_TAIL_BYTES = 5 * 1024 * 1024;
const MAX_WINDOW_HOURS = 168;
const LOCAL_AVATAR_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "style-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const LOCAL_AVATAR_ASSETS = new Map([
  ["/local-avatar/index.html", { filename: "local-avatar/index.html", contentType: "text/html; charset=utf-8" }],
  ["/local-avatar/local-avatar.js", { filename: "local-avatar/local-avatar.js", contentType: "application/javascript; charset=utf-8" }],
  ["/local-avatar/frames.html", { filename: "local-avatar/frames.html", contentType: "text/html; charset=utf-8" }],
  ["/local-avatar/frames.js", { filename: "local-avatar/frames.js", contentType: "application/javascript; charset=utf-8" }],
  ["/local-avatar/attendee-overlay-guard.js", { filename: "local-avatar/attendee-overlay-guard.js", contentType: "application/javascript; charset=utf-8" }],
]);

const LOCAL_AVATAR_FRAME_ASSETS = new Map([
  ["/local-avatar/frames/idle.png", "idle.png"],
  ["/local-avatar/frames/talk1.png", "talk1.png"],
  ["/local-avatar/frames/talk2.png", "talk2.png"],
  ["/local-avatar/frames/talk3.png", "talk3.png"],
  ["/local-avatar/frames/blink.png", "blink.png"],
  ["/local-avatar/frames/talk_blink.png", "talk_blink.png"],
]);

const PUBLIC_ASSETS = new Map([
  ["/style.css", { filename: "style.css", contentType: "text/css; charset=utf-8" }],
  ["/app.js", { filename: "app.js", contentType: "application/javascript; charset=utf-8" }],
  ["/manifest.json", { filename: "manifest.json", contentType: "application/manifest+json; charset=utf-8" }],
  ["/icons/icon-192.png", { filename: "icons/icon-192.png", contentType: "image/png" }],
  ["/icons/icon-512.png", { filename: "icons/icon-512.png", contentType: "image/png" }],
  ["/icons/icon-maskable-512.png", { filename: "icons/icon-maskable-512.png", contentType: "image/png" }],
  ["/icons/apple-touch-icon-180.png", { filename: "icons/apple-touch-icon-180.png", contentType: "image/png" }],
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

function serveLocalAvatar(req, res, url = new URL(req.url || "/", "http://localhost")) {
  const isLocalAvatarPath = url.pathname === "/local-avatar" || url.pathname.startsWith("/local-avatar/");
  if (!isLocalAvatarPath) return false;
  if (hasTraversal(req)) {
    writeLocalAvatarPlain(res, 404, "Not Found");
    return true;
  }

  const asset = LOCAL_AVATAR_ASSETS.get(url.pathname);
  if (asset) {
    if (req.method !== "GET") {
      writeLocalAvatarPlain(res, 404, "Not Found");
      return true;
    }
    const { getLocalAvatarSession, hasLocalAvatarSessions } = require("./transport-meet/local-avatar-session");
    const allowedQuery = url.pathname.endsWith(".html")
      ? hasExactQueryKeys(url, ["v"]) && Boolean(getLocalAvatarSession(url.searchParams.get("v")))
      : !url.search && hasLocalAvatarSessions();
    if (!allowedQuery) {
      writeLocalAvatarPlain(res, 404, "Not Found");
      return true;
    }
    fs.readFile(path.join(PUBLIC_DIR, asset.filename), (err, data) => {
      if (err) {
        writeLocalAvatarPlain(res, 404, "Not Found");
        return;
      }
      res.writeHead(200, localAvatarHeaders({
        "Content-Type": asset.contentType,
        "Content-Length": data.length,
      }));
      res.end(data);
    });
    return true;
  }

  const frameFilename = LOCAL_AVATAR_FRAME_ASSETS.get(url.pathname);
  if (frameFilename) {
    if (req.method !== "GET" || !hasExactQueryKeys(url, ["v"])) {
      writeLocalAvatarPlain(res, 404, "Not Found");
      return true;
    }
    const visualId = url.searchParams.get("v") || "";
    const capability = readBearerCapability(req.headers?.authorization);
    const { getLocalAvatarSession } = require("./transport-meet/local-avatar-session");
    const session = getLocalAvatarSession(visualId);
    if (!session || !capability || !session.verifyCapability(capability)) {
      writeLocalAvatarPlain(res, 404, "Not Found");
      return true;
    }
    fs.readFile(path.join(resolveHome(), "assets", "avatar-frames", frameFilename), (err, data) => {
      if (err) {
        writeLocalAvatarPlain(res, 404, "Not Found");
        return;
      }
      res.writeHead(200, localAvatarHeaders({
        "Content-Type": "image/png",
        "Content-Length": data.length,
      }));
      res.end(data);
    });
    return true;
  }

  if (url.pathname !== "/local-avatar/state" || req.method !== "POST") {
    writeLocalAvatarPlain(res, 404, "Not Found");
    return true;
  }

  const visualId = url.searchParams.get("v") || "";
  const capability = readBearerCapability(req.headers?.authorization);
  const origin = String(req.headers?.origin || "");
  const { getLocalAvatarSession } = require("./transport-meet/local-avatar-session");
  const session = getLocalAvatarSession(visualId);
  if (!session || !capability) {
    writeLocalAvatarPlain(res, 404, "Not Found");
    return true;
  }

  if (url.searchParams.get("connect") === "1" && hasExactQueryKeys(url, ["connect", "v"])) {
    const state = session.connect({ capability, origin });
    if (!state) {
      writeLocalAvatarPlain(res, 404, "Not Found");
      return true;
    }
    writeLocalAvatarJson(res, 200, state);
    return true;
  }

  if (!hasExactQueryKeys(url, ["after", "generation", "v"])) {
    writeLocalAvatarPlain(res, 404, "Not Found");
    return true;
  }
  const state = session.readState({
    capability,
    origin,
    generation: url.searchParams.get("generation"),
    afterSequence: url.searchParams.get("after"),
  });
  if (state === null) {
    writeLocalAvatarPlain(res, 404, "Not Found");
  } else if (state === undefined) {
    res.writeHead(204, localAvatarHeaders());
    res.end();
  } else {
    writeLocalAvatarJson(res, 200, state);
  }
  return true;
}

function hasExactQueryKeys(url, expected) {
  const keys = [...url.searchParams.keys()].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function readBearerCapability(value) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(String(value || ""));
  return match ? match[1] : "";
}

function localAvatarHeaders(extra = {}) {
  return {
    "Content-Security-Policy": LOCAL_AVATAR_CSP,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

function writeLocalAvatarJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, localAvatarHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  }));
  res.end(json);
}

function writeLocalAvatarPlain(res, status, body) {
  res.writeHead(status, localAvatarHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }));
  res.end(body);
}

async function sendMetricsSummary(req, res, url = new URL(req.url || "/", "http://localhost")) {
  if (req.method !== "GET" || url.pathname !== "/metrics") return false;
  let summary;
  try {
    summary = await readMetricsSummary(url.searchParams.get("hours"));
  } catch (err) {
    console.warn("metrics summary failed:", scrubErrorMessage(err));
    summary = { enabled: false };
  }
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
    if (typeof event !== "object" || event === null) continue;

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
  return path.join(metricsLogDir(), "metrics.jsonl");
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
  serveLocalAvatar,
  sendMetricsSummary,
  readMetricsSummary,
  _test: {
    LOCAL_AVATAR_CSP,
    clampHours,
    readTail,
    getMetricsLogFile,
  },
};
