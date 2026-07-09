// calibrate-routes.js — Wake word calibration HTTP + WS handlers
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config.json");
const HTML_PATH = path.join(__dirname, "calibrate.html");
const LOCK_PATH = CONFIG_PATH + ".lock";
const TIMEOUT_MS = 30_000;

function isEnabled() {
  return process.env.WAKE_CALIBRATE_ENABLED === "1";
}

// --- Normalize ---

function normalize(str) {
  let s = str.trim().toLowerCase();
  // full-width ASCII → half-width
  s = s.replace(/[\uff01-\uff5e]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  // full-width space
  s = s.replace(/\u3000/g, " ");
  // normalize long vowels ー 〜 ～ → ー
  s = s.replace(/[〜～]/g, "ー");
  return s;
}

// --- HTTP handlers ---

function handleCalibrate(req, res) {
  let pathname = "/calibrate";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    // keep default
  }

  if (pathname === "/calibrate/status") {
    const json = JSON.stringify({ enabled: isEnabled() });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
    return;
  }

  if (!isEnabled()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  if (pathname === "/calibrate" && req.method === "GET") {
    serveHtml(req, res);
    return;
  }

  if (pathname === "/calibrate/apply" && req.method === "POST") {
    handleApply(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function serveHtml(_req, res) {
  try {
    const html = fs.readFileSync(HTML_PATH, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to read calibrate.html: " + err.message);
  }
}

function handleApply(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      const variants = parsed.variants;
      if (!Array.isArray(variants) || variants.length === 0) {
        writeJson(res, 400, { ok: false, error: "variants must be a non-empty array" });
        return;
      }

      let lockFd = null;
      try {
        lockFd = fs.openSync(LOCK_PATH, "wx");
        fs.writeFileSync(lockFd, String(process.pid), "utf8");
      } catch (err) {
        writeJson(res, 423, { ok: false, error: "Config is locked by another write" });
        return;
      }

      try {
        const configRaw = fs.readFileSync(CONFIG_PATH, "utf8");
        const config = JSON.parse(configRaw);
        config.agent ||= {};

        const existingVariants = Array.isArray(config.agent?.sttWakeVariants)
          ? config.agent.sttWakeVariants
          : [];
        const wakeWords = Array.isArray(config.agent?.wakeWords)
          ? config.agent.wakeWords
          : [];

        // Build normalized set of existing
        const normalizedExisting = new Map();
        for (const v of existingVariants) {
          normalizedExisting.set(normalize(v), v);
        }

        // Normalized wake words (to exclude)
        const normalizedWakeWords = new Set(wakeWords.map(normalize));

        // Merge new variants
        let added = 0;
        for (const v of variants) {
          const nv = normalize(v);
          if (!nv) continue;
          if (normalizedWakeWords.has(nv)) continue;
          if (normalizedExisting.has(nv)) continue;
          normalizedExisting.set(nv, v);
          added++;
        }

        // Rebuild array (keep original forms)
        config.agent.sttWakeVariants = Array.from(normalizedExisting.values());

        // Safe write: backup → tmp → rename
        fs.writeFileSync(CONFIG_PATH + ".bak", configRaw, "utf8");
        const newJson = JSON.stringify(config, null, 2) + "\n";
        fs.writeFileSync(CONFIG_PATH + ".tmp", newJson, "utf8");
        fs.renameSync(CONFIG_PATH + ".tmp", CONFIG_PATH);

        writeJson(res, 200, {
          ok: true,
          added,
          total: config.agent.sttWakeVariants.length,
        });
      } finally {
        // Clean up tmp remnant if rename didn't complete
        try { fs.unlinkSync(CONFIG_PATH + ".tmp"); } catch { /* ignore */ }
        // Release lock
        try { if (lockFd !== null) fs.closeSync(lockFd); } catch { /* ignore */ }
        try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
      }
    } catch (err) {
      writeJson(res, 500, { ok: false, error: err.message });
    }
  });
}

function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

// --- WebSocket handler ---

function handleCalibrateWs(ws, _req) {
  if (!isEnabled()) {
    ws.close(1008, "Calibration not enabled");
    return;
  }

  const { createSTT } = require("../stt-provider");
  const provider = String(process.env.STT_PROVIDER || "soniox").toLowerCase();
  const dgKey = process.env.DEEPGRAM_API_KEY;
  const sonioxKey = process.env.SONIOX_API_KEY;
  if (provider === "soniox" && !sonioxKey) {
    wsSend(ws, { type: "error", message: "SONIOX_API_KEY not configured" });
    ws.close(1011, "Missing API key");
    return;
  }
  if (provider === "deepgram" && !dgKey) {
    wsSend(ws, { type: "error", message: "DEEPGRAM_API_KEY not configured" });
    ws.close(1011, "Missing API key");
    return;
  }

  // Load language and calibration keyterms from config
  let lang = "ja";
  let keyterms = [];
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const agent = config.agent || {};
    lang = agent.lang || "ja";
    keyterms = [
      ...(Array.isArray(agent.keyterms) ? agent.keyterms : []),
      ...(Array.isArray(agent.wakeWords) ? agent.wakeWords : []),
    ];
  } catch { /* default */ }

  const stt = createSTT(dgKey, {
    provider,
    sonioxKey,
    model: "nova-3",
    language: lang,
    sampleRate: 16000,
    keyterms,
  });

  let timeoutTimer = null;
  let firstAudioReceived = false;
  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    try { stt.close(); } catch { /* ignore */ }
    try { if (ws.readyState <= 1) ws.close(); } catch { /* ignore */ }
  }

  stt.on("open", () => {
    console.log(`🎙️  [calibrate] ${provider} connection opened (model=nova-3, lang=${lang})`);
    wsSend(ws, { type: "ready" });
  });

  stt.on("transcript", (text, isFinal) => {
    if (!text) return;
    console.log(`🎙️  [calibrate] ${isFinal ? "FINAL" : "interim"}: "${text}"`);
    if (!isFinal) {
      wsSend(ws, { type: "transcript", text, isFinal: false });
    }
  });

  stt.on("utterance_end", (text) => {
    if (!text) return;
    console.log(`🎙️  [calibrate] utterance_end: "${text}"`);
    wsSend(ws, { type: "transcript", text, isFinal: true });
  });

  stt.on("error", (err) => {
    console.error(`❌  [calibrate] ${provider} STT error:`, err);
    wsSend(ws, { type: "error", message: String(err?.message || "STT error") });
    cleanup();
  });

  stt.on("close", () => {
    console.log(`🎙️  [calibrate] ${provider} connection closed`);
    if (!closed) {
      wsSend(ws, { type: "error", message: "STT connection closed" });
      cleanup();
    }
  });

  ws.on("message", (data) => {
    if (closed) return;

    // Binary audio frames → relay to STT provider
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
      if (!firstAudioReceived) {
        firstAudioReceived = true;
        // Start 30s timeout from first audio
        timeoutTimer = setTimeout(() => {
          wsSend(ws, { type: "timeout" });
          cleanup();
        }, TIMEOUT_MS);
      }
      try {
        stt.send(Buffer.from(data));
      } catch (err) {
        console.error("❌  Calibrate relay error:", err.message);
      }
    }
  });

  ws.on("close", () => {
    cleanup();
  });

  ws.on("error", (err) => {
    console.error("❌  Calibrate WS error:", err.message);
    cleanup();
  });
}

function wsSend(ws, obj) {
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  } catch { /* ignore */ }
}

module.exports = { handleCalibrate, handleCalibrateWs };
