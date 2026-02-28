// twilio-bridge.js — Phase 1 outbound-call bridge for Twilio Media Streams
// Separate process from Meet bridge (does NOT touch src/index.js)

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });

const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");
const querystring = require("querystring");
const { WebSocketServer, WebSocket } = require("ws");

const { createPipeline } = require("../pipeline");
const { getPipelineConfig } = require("../config");
const {
  initiateCall,
  updateCallStatus,
  canPlaceCall,
  getActiveCalls,
} = require("./call-manager");
const {
  mulawToLinear16,
  linear16ToMulaw,
  createJitterBuffer,
} = require("./twilio-adapter");

const PORT = Number(process.env.TWILIO_BRIDGE_PORT || 5006);
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const CALL_SECRET = process.env.TWILIO_CALL_SECRET || "";
const PUBLIC_URL = (process.env.TWILIO_PUBLIC_URL || "").replace(/\/$/, "");
const ALLOWED_NUMBERS = new Set(
  String(process.env.TWILIO_ALLOWED_NUMBERS || "")
    .split(",")
    .map((v) => normalizePhone(v.trim()))
    .filter(Boolean)
);

const RATE_LIMIT_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_CALLS = 1;
const JITTER_MAX_MS = Number(process.env.TWILIO_JITTER_MAX_MS || 200);

let lastCallAt = 0;

if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
  console.error("❌  Missing Twilio credentials. Check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER");
  process.exit(1);
}

if (!CALL_SECRET) {
  console.error("❌  TWILIO_CALL_SECRET is required for POST /call-me");
  process.exit(1);
}

if (!PUBLIC_URL || !/^https?:\/\//.test(PUBLIC_URL)) {
  console.error("❌  TWILIO_PUBLIC_URL is required (https://...)");
  process.exit(1);
}

if (ALLOWED_NUMBERS.size === 0) {
  console.error("❌  TWILIO_ALLOWED_NUMBERS is required (comma-separated)");
  process.exit(1);
}

function normalizePhone(input) {
  if (!input) return "";
  const trimmed = String(input).trim().replace(/[\s()-]/g, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  if (trimmed.startsWith("00")) return `+${trimmed.slice(2).replace(/\D/g, "")}`;
  return `+${trimmed.replace(/\D/g, "")}`;
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function parseRawBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve({
        raw,
        text: raw.toString("utf8"),
      });
    });

    req.on("error", reject);
  });
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildTwilioSignatureBase(url, params) {
  let base = url;
  const keys = Object.keys(params || {}).sort();
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const v of value) base += `${key}${v}`;
    } else {
      base += `${key}${value}`;
    }
  }
  return base;
}

function makeCandidateUrls(req) {
  const urls = new Set();

  try {
    urls.add(new URL(req.url || "/", PUBLIC_URL).toString());
  } catch {
    // ignore
  }

  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers.host;
  if (host) {
    urls.add(`${proto}://${host}${req.url || "/"}`);
  }

  return Array.from(urls);
}

function validateTwilioSignature(req, params = {}) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;

  const candidates = makeCandidateUrls(req);
  for (const candidateUrl of candidates) {
    const payload = buildTwilioSignatureBase(candidateUrl, params);
    const digest = crypto.createHmac("sha1", AUTH_TOKEN).update(payload, "utf8").digest("base64");
    if (timingSafeEqualString(digest, signature)) {
      return true;
    }
  }

  return false;
}

function isAuthorizedCallRequest(req) {
  const auth = String(req.headers.authorization || "");
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) return false;
  const token = auth.slice(prefix.length).trim();
  return timingSafeEqualString(token, CALL_SECRET);
}

function getDefaultToNumber() {
  return normalizePhone(process.env.TWILIO_DEFAULT_TO || "") || Array.from(ALLOWED_NUMBERS)[0] || "";
}

function makeTwimlResponse(streamWsUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${streamWsUrl}" />\n  </Connect>\n</Response>`;
}

function splitMulawFrames(mulawBuffer, frameSize = 160) {
  const out = [];
  for (let i = 0; i < mulawBuffer.length; i += frameSize) {
    out.push(mulawBuffer.subarray(i, i + frameSize));
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    const active = getActiveCalls();
    writeJson(res, 200, {
      ok: true,
      service: "twilio-bridge",
      port: PORT,
      activeCalls: active.length,
      allowedNumbers: Array.from(ALLOWED_NUMBERS),
      hasPublicUrl: Boolean(PUBLIC_URL),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/call-me") {
    if (!isAuthorizedCallRequest(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const now = Date.now();
    const remaining = RATE_LIMIT_MS - (now - lastCallAt);
    if (remaining > 0) {
      writeJson(res, 429, {
        error: "rate_limited",
        retryAfterSec: Math.ceil(remaining / 1000),
      });
      return;
    }

    if (!canPlaceCall(MAX_CONCURRENT_CALLS)) {
      writeJson(res, 409, { error: "concurrent_call_limit_reached" });
      return;
    }

    const { text } = await parseRawBody(req);
    const body = parseJsonSafe(text) || {};
    const requestedTo = normalizePhone(body.to || "");
    const to = requestedTo || getDefaultToNumber();

    if (!to) {
      writeJson(res, 400, { error: "missing_to_number" });
      return;
    }

    if (!ALLOWED_NUMBERS.has(to)) {
      writeJson(res, 403, { error: "number_not_allowed", to });
      return;
    }

    try {
      const twimlUrl = `${PUBLIC_URL}/twilio/voice`;
      const statusCallback = `${PUBLIC_URL}/twilio/status`;

      const result = await initiateCall(to, {
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        from: FROM_NUMBER,
        twimlUrl,
        statusCallback,
        maxConcurrent: MAX_CONCURRENT_CALLS,
      });

      lastCallAt = now;

      writeJson(res, 200, {
        status: "calling",
        callSid: result.sid,
        to,
      });
      return;
    } catch (err) {
      console.error("❌  initiateCall failed:", err.message);
      writeJson(res, 502, {
        error: "twilio_call_failed",
        message: err.message,
      });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/twilio/voice") {
    const { text } = await parseRawBody(req);
    const params = querystring.parse(text);

    if (!validateTwilioSignature(req, params)) {
      writeText(res, 403, "Forbidden");
      return;
    }

    const publicWsUrl = PUBLIC_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const streamWsUrl = `${publicWsUrl}/twilio/stream`;

    const twiml = makeTwimlResponse(streamWsUrl);
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(twiml);
    return;
  }

  if (req.method === "POST" && url.pathname === "/twilio/status") {
    const { text } = await parseRawBody(req);
    const params = querystring.parse(text);

    if (!validateTwilioSignature(req, params)) {
      writeText(res, 403, "Forbidden");
      return;
    }

    updateCallStatus(params.CallSid, params.CallStatus, params);
    writeText(res, 204, "");
    return;
  }

  writeText(res, 404, "Not Found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/twilio/stream") {
    socket.destroy();
    return;
  }

  // WebSocket upgrade may include Twilio signature header. If present, verify.
  const signature = req.headers["x-twilio-signature"];
  if (signature) {
    const queryParams = Object.fromEntries(url.searchParams.entries());
    if (!validateTwilioSignature(req, queryParams)) {
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const ctx = {
    streamSid: null,
    callSid: null,
    pipeline: null,
    jitter: createJitterBuffer(JITTER_MAX_MS, 16000, 2),
  };

  console.log(`📞  Twilio stream connected: ${req.socket.remoteAddress || "unknown"}`);

  function closePipeline() {
    if (!ctx.pipeline) return;
    try {
      ctx.pipeline.close();
    } catch {
      // no-op
    }
    ctx.pipeline = null;
  }

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.event === "connected") {
      return;
    }

    if (message.event === "start") {
      ctx.streamSid = message.start?.streamSid || null;
      ctx.callSid = message.start?.callSid || null;
      if (ctx.callSid) {
        updateCallStatus(ctx.callSid, "in-progress", message.start);
      }

      if (!ctx.pipeline) {
        const sessionId = ctx.callSid || ctx.streamSid || crypto.randomUUID();
        const session = {
          id: sessionId,
          createdAt: new Date().toISOString(),
          meetingUrl: "twilio://outbound-call",
          config: {},
          conversationLog: [],
        };

        const turnState = {
          isAgentSpeaking: false,
          inputCooldownUntil: 0,
          droppedEchoFrames: 0,
        };

        const config = getPipelineConfig({ wakeMode: "off" });
        ctx.pipeline = createPipeline(session, turnState, (pcmChunk) => {
          if (ws.readyState !== WebSocket.OPEN || !ctx.streamSid) return;

          const mulaw = linear16ToMulaw(pcmChunk);
          if (!mulaw.length) return;

          const frames = splitMulawFrames(mulaw, 160);
          for (const frame of frames) {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(
              JSON.stringify({
                event: "media",
                streamSid: ctx.streamSid,
                media: { payload: frame.toString("base64") },
              })
            );
          }
        }, config);
      }

      return;
    }

    if (message.event === "media") {
      if (!ctx.pipeline) return;
      const payload = message.media?.payload;
      if (!payload) return;

      try {
        const mulaw = Buffer.from(payload, "base64");
        const pcm16 = mulawToLinear16(mulaw);
        ctx.jitter.push(pcm16);
        const ready = ctx.jitter.flush();
        if (ready.length > 0) {
          ctx.pipeline.sendAudio(ready);
        }
      } catch (err) {
        console.error("❌  Failed to process inbound media:", err.message);
      }

      return;
    }

    if (message.event === "stop") {
      if (ctx.callSid) {
        updateCallStatus(ctx.callSid, "completed", message.stop || message);
      }
      closePipeline();
      return;
    }
  });

  ws.on("close", () => {
    closePipeline();
    if (ctx.callSid) {
      updateCallStatus(ctx.callSid, "completed");
    }
    console.log(`📴  Twilio stream closed: ${ctx.callSid || ctx.streamSid || "unknown"}`);
  });

  ws.on("error", (err) => {
    console.error("❌  Twilio stream error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`🚀  Twilio Bridge started: http://localhost:${PORT}`);
  console.log(`🌐  Twilio public URL: ${PUBLIC_URL}`);
  console.log(`📟  Allowed numbers: ${Array.from(ALLOWED_NUMBERS).join(", ")}`);
});
