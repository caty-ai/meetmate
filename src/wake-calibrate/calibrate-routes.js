// calibrate-routes.js — Wake word calibration HTTP + WS handlers
const fs = require("fs");
const { bundledPath } = require("../paths");
const { REGISTRY_BY_ID } = require("../settings/registry");
const { getEffectiveValue, getRawConfig, getRuntime } = require("../settings/resolver");
const { saveFields } = require("../settings/store");

const HTML_PATH = bundledPath("src", "wake-calibrate", "calibrate.html");
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
    const json = JSON.stringify({ enabled: isEnabled(), revision: getRuntime().revision });
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
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to read calibration page");
  }
}

function handleApply(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      const variants = parsed.variants;
      const revision = parsed.revision;
      if (Object.keys(parsed).some((key) => !["variants", "revision"].includes(key))
          || !Array.isArray(variants) || variants.length === 0
          || !/^[a-f0-9]{64}$/.test(revision)) {
        writeJson(res, 422, { ok: false, error: "invalid calibration request" });
        return;
      }

      try {
        const config = getRawConfig();

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
        const nextVariants = Array.from(normalizedExisting.values());
        const validated = REGISTRY_BY_ID.agent_stt_wake_variants.schema.safeParse(nextVariants);
        if (!validated.success) {
          writeJson(res, 422, { ok: false, error: "invalid calibration variants" });
          return;
        }
        const committed = saveFields({
          configPath: getRuntime().startup.configPath,
          revision,
          fields: { agent_stt_wake_variants: validated.data },
        });
        writeJson(res, 200, {
          ok: true,
          added,
          total: nextVariants.length,
          revision: committed.revision,
        });
      } catch (error) {
        writeJson(res, error.status || 500, { ok: false, error: error.code || "settings write failed" });
      }
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid calibration request" });
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
  const provider = getEffectiveValue("stt_provider");
  const dgKey = getEffectiveValue("deepgram_api_key");
  const sonioxKey = getEffectiveValue("soniox_api_key");
  if (provider === "soniox" && !sonioxKey) {
    wsSend(ws, { type: "error", message: "Speech service is not configured" });
    ws.close(1011, "Missing API key");
    return;
  }
  if (provider === "deepgram" && !dgKey) {
    wsSend(ws, { type: "error", message: "Speech service is not configured" });
    ws.close(1011, "Missing API key");
    return;
  }

  const lang = getEffectiveValue("agent_language") || "ja";
  const keyterms = [
    ...(getEffectiveValue("agent_keyterms") || []),
    ...(getEffectiveValue("agent_wake_words") || []),
  ];

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
  let pendingFinalText = "";
  const sttModel = provider === "soniox"
    ? getEffectiveValue("soniox_model")
    : "nova-3";

  function flushPendingFinalText() {
    const text = pendingFinalText.trim();
    if (text) {
      wsSend(ws, { type: "transcript", text, isFinal: true });
    }
    pendingFinalText = "";
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    try { stt.close(); } catch { /* ignore */ }
    try { if (ws.readyState <= 1) ws.close(); } catch { /* ignore */ }
  }

  stt.on("open", () => {
    console.log(`🎙️  [calibrate] ${provider} connection opened (model=${sttModel}, lang=${lang})`);
    wsSend(ws, { type: "ready" });
  });

  stt.on("transcript", (text, isFinal) => {
    if (!text) return;
    console.log(`🎙️  [calibrate] ${isFinal ? "FINAL" : "interim"}: "${text}"`);
    if (isFinal) {
      pendingFinalText += text;
    } else {
      wsSend(ws, { type: "transcript", text, isFinal: false });
    }
  });

  stt.on("utterance_end", (text) => {
    if (!text) return;
    console.log(`🎙️  [calibrate] utterance_end: "${text}"`);
    wsSend(ws, { type: "transcript", text, isFinal: true });
    pendingFinalText = "";
  });

  stt.on("error", () => {
    console.error(`❌  [calibrate] ${provider} STT error`);
    flushPendingFinalText();
    wsSend(ws, { type: "error", message: "Speech service error" });
    cleanup();
  });

  stt.on("close", () => {
    console.log(`🎙️  [calibrate] ${provider} connection closed`);
    if (!closed) {
      flushPendingFinalText();
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
          flushPendingFinalText();
          wsSend(ws, { type: "timeout" });
          cleanup();
        }, TIMEOUT_MS);
      }
      try {
        stt.send(Buffer.from(data));
      } catch {
        console.error("❌  Calibrate relay error");
      }
    }
  });

  ws.on("close", () => {
    cleanup();
  });

  ws.on("error", () => {
    console.error("❌  Calibrate WS error");
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
