const crypto = require("crypto");
const { URL } = require("url");
const querystring = require("querystring");
const { WebSocketServer, WebSocket } = require("ws");

const { createPipeline } = require("../pipeline");
const { getPipelineConfig } = require("../config");
const { warmUpGatewaySession } = require("../gateway-warmup");
const { SessionLifecycle } = require("../session-events");
const { SlackNotifier } = require("../slack-notifier");
const { summarizeConversation } = require("../summarizer");
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
const VOICE_TOKEN_TTL_MS = Number(process.env.TWILIO_VOICE_TOKEN_TTL_MS || 60_000);
const STREAM_TOKEN_TTL_MS = Number(process.env.TWILIO_STREAM_TOKEN_TTL_MS || 60_000);

let bridgePort = Number(process.env.TWILIO_BRIDGE_PORT || 5006);
let initialized = false;
let lastCallAt = 0;

const ephemeralTokens = new Map();
const sessionLifecycles = new Map();

let slackNotifier = null;
let wss = null;
let connectionHandlerAttached = false;

function getSlackNotifier() {
  if (!slackNotifier) {
    const slackToken = process.env.SLACK_BOT_TOKEN || "";
    const fallback = process.env.SLACK_NOTIFY_CHANNEL || "";
    const summaryChannel = process.env.SLACK_SUMMARY_CHANNEL || fallback;
    const statusChannel = process.env.SLACK_STATUS_CHANNEL || summaryChannel || fallback;
    const notifyEnabled = String(process.env.SLACK_NOTIFY_ENABLED || "true").toLowerCase() !== "false";

    slackNotifier = new SlackNotifier(slackToken, fallback, {
      enabled: notifyEnabled,
      statusChannelId: statusChannel,
      summaryChannelId: summaryChannel,
    });

    if (slackNotifier.enabled) {
      console.log(`📢  Slack通知有効: status=${statusChannel}, summary=${summaryChannel}`);
    } else {
      console.log("📢  Slack通知無効（SLACK_BOT_TOKEN/SLACK_NOTIFY_CHANNEL未設定）");
    }
  }
  return slackNotifier;
}

function saveCallLog(lifecycle) {
  const log = lifecycle._conversationLog;
  if (!log || log.length === 0) return;

  const fs = require("fs");
  const path = require("path");
  const logDir = path.join(__dirname, "..", "..", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `twilio-${timestamp}-${lifecycle.sessionId}`;

  const jsonPath = path.join(logDir, `${baseName}.json`);
  const jsonData = {
    session_id: lifecycle.sessionId,
    transport: "twilio",
    to: lifecycle.meta.to || null,
    from: lifecycle.meta.from || null,
    created_at: new Date(lifecycle._createdAt).toISOString(),
    saved_at: new Date().toISOString(),
    duration: lifecycle.duration,
    duration_formatted: lifecycle.durationFormatted,
    messages: log,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`📝  通話ログ保存: ${jsonPath}`);

  const mdPath = path.join(logDir, `${baseName}.md`);
  const mdContent = [
    `# Twilio Call Log — ${new Date().toLocaleString("ja-JP")}`,
    "",
    `- session_id: ${lifecycle.sessionId}`,
    `- transport: twilio`,
    `- to: ${lifecycle.meta.to || "—"}`,
    `- from: ${lifecycle.meta.from || "—"}`,
    `- duration: ${lifecycle.durationFormatted}`,
    "",
    ...log.map((e) => `**${e.role === "assistant" || e.role === "agent" ? "Caty" : "参加者"}** (${e.timestamp}):\n${e.content}\n`),
  ].join("\n");
  fs.writeFileSync(mdPath, mdContent);
  console.log(`📝  通話ログ(MD)保存: ${mdPath}`);

  try {
    const WORKSPACE = process.env.OPENCLAW_WORKSPACE
      || require("path").join(require("os").homedir(), ".openclaw", "workspace");
    const memoryDir = require("path").join(WORKSPACE, "memory");
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const memoryFile = require("path").join(memoryDir, `${today}.md`);

    const userMsgs = log.filter((e) => e.role !== "assistant" && e.role !== "agent").map((e) => e.content).slice(0, 5);
    const catyMsgs = log.filter((e) => e.role === "assistant" || e.role === "agent").map((e) => e.content).slice(0, 5);

    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Bangkok" });
    const summary = [
      "",
      `## 📞 Twilio 通話セッション (${now})`,
      `- Call SID: ${lifecycle.sessionId}`,
      `- 発信先: ${lifecycle.meta.to || "—"}`,
      `- 通話時間: ${lifecycle.durationFormatted}`,
      `- 発話数: ${log.length}`,
      "",
      "### 会話ハイライト",
      ...userMsgs.slice(0, 3).map((m) => `- 参加者: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      ...catyMsgs.slice(0, 3).map((m) => `- Caty: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      "",
    ].join("\n");

    fs.appendFileSync(memoryFile, summary);
    console.log(`🧠  メモリに追記: ${memoryFile}`);

    const callsDir = require("path").join(memoryDir, "calls");
    if (!fs.existsSync(callsDir)) fs.mkdirSync(callsDir, { recursive: true });
    const callLogPath = require("path").join(callsDir, `twilio-${today}-${lifecycle.sessionId.slice(0, 12)}.md`);
    const fullLog = [
      `# Twilio 通話ログ — ${now}`,
      "",
      `- Call SID: ${lifecycle.sessionId}`,
      `- 発信先: ${lifecycle.meta.to || "—"}`,
      `- 発信元: ${lifecycle.meta.from || "—"}`,
      `- 通話時間: ${lifecycle.durationFormatted}`,
      `- 発話数: ${log.length}`,
      "",
      "## 全文",
      "",
      ...log.map((e) => {
        const speaker = e.role === "assistant" || e.role === "agent" ? "Caty" : "参加者";
        return `**${speaker}**: ${e.content}\n`;
      }),
    ].join("\n");
    fs.writeFileSync(callLogPath, fullLog);
    console.log(`🧠  通話ログ memory/calls/ 保存: ${callLogPath}`);
  } catch (err) {
    console.error("⚠️  メモリ追記失敗:", err.message);
  }
}

async function handleSessionEnd(lifecycle) {
  const notifier = getSlackNotifier();
  notifier.stopElapsedUpdates(lifecycle.sessionId);
  await notifier.postStatus(lifecycle);
  saveCallLog(lifecycle);

  const summaryEnabled = String(process.env.SUMMARY_ENABLED || "true").toLowerCase() !== "false";
  if (summaryEnabled && lifecycle._conversationLog && lifecycle._conversationLog.length > 0) {
    try {
      const summary = await summarizeConversation(lifecycle._conversationLog, {
        openclawUrl: process.env.OPENCLAW_GATEWAY_URL,
        openclawToken: process.env.OPENCLAW_GATEWAY_TOKEN,
        openrouterKey: process.env.OPENROUTER_API_KEY,
      });
      await notifier.postSummary(lifecycle, summary);
      console.log("📋  通話サマリー投稿完了");
      await postFullTranscript(notifier, lifecycle);
    } catch (err) {
      console.error("⚠️  サマリー生成/投稿失敗:", err.message);
    }
  }

  sessionLifecycles.delete(lifecycle.sessionId);
}

async function postFullTranscript(notifier, lifecycle) {
  if (!notifier.enabled) return;
  const log = lifecycle._conversationLog;
  if (!log || log.length === 0) return;

  const lines = [
    "📜 全文ログ",
    "━━━━━━━━━━━━━━━",
    "",
  ];

  for (const entry of log) {
    const speaker = entry.role === "assistant" || entry.role === "agent" ? "🤖 Caty" : "👤 参加者";
    const time = entry.timestamp ? `(${new Date(entry.timestamp).toLocaleTimeString("ja-JP")})` : "";
    lines.push(`${speaker} ${time}`);
    lines.push(entry.content);
    lines.push("");
  }

  const text = lines.join("\n");
  const MAX_CHUNK = 3800;
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > MAX_CHUNK && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);

  try {
    for (const chunk of chunks) {
      await notifier.postTranscript(lifecycle, chunk);
    }
    console.log("📜  全文ログSlack投稿完了");
  } catch (err) {
    console.error("⚠️  全文ログSlack投稿失敗:", err.message);
  }
}

function normalizePhone(input) {
  if (!input) return "";
  const trimmed = String(input).trim().replace(/[\s()-]/g, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  if (trimmed.startsWith("00")) return `+${trimmed.slice(2).replace(/\D/g, "")}`;
  return `+${trimmed.replace(/\D/g, "")}`;
}

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, entry] of ephemeralTokens.entries()) {
    if (!entry || entry.expiresAt <= now) {
      ephemeralTokens.delete(token);
    }
  }
}

function issueEphemeralToken(kind, ttlMs, meta = {}) {
  cleanupExpiredTokens();
  const token = crypto.randomBytes(24).toString("base64url");
  ephemeralTokens.set(token, {
    kind,
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.max(1_000, ttlMs),
    used: false,
    meta,
  });
  return token;
}

function consumeEphemeralToken(token, expectedKind) {
  cleanupExpiredTokens();

  const entry = ephemeralTokens.get(token);
  if (!entry) return null;
  if (entry.kind !== expectedKind) return null;
  if (entry.used) return null;
  if (entry.expiresAt <= Date.now()) {
    ephemeralTokens.delete(token);
    return null;
  }

  entry.used = true;
  ephemeralTokens.set(token, entry);
  return entry;
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

function escapeXmlAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeTwimlResponse(streamWsUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${escapeXmlAttr(streamWsUrl)}" />\n  </Connect>\n</Response>`;
}

function makeRejectTwiml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Reject />\n</Response>";
}

function splitMulawFrames(mulawBuffer, frameSize = 160) {
  const out = [];
  for (let i = 0; i < mulawBuffer.length; i += frameSize) {
    out.push(mulawBuffer.subarray(i, i + frameSize));
  }
  return out;
}

function validateRequiredEnv() {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    console.error("❌  Missing Twilio credentials. Check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER");
    process.exit(1);
  }

  if (!CALL_SECRET) {
    console.error("❌  TWILIO_CALL_SECRET is required for POST /call-me");
    process.exit(1);
  }

  if (!PUBLIC_URL || !/^https:\/\//.test(PUBLIC_URL)) {
    console.error("❌  TWILIO_PUBLIC_URL is required and must be https://...");
    process.exit(1);
  }

  if (ALLOWED_NUMBERS.size === 0) {
    console.error("❌  TWILIO_ALLOWED_NUMBERS is required (comma-separated)");
    process.exit(1);
  }
}

function handleWsConnection(ws, req) {
  const ctx = {
    streamSid: null,
    callSid: req.twilioMeta?.callSid || null,
    warmupSessionId: req.twilioMeta?.warmupSessionId || null,
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
      console.log(`📞  Twilio stream start: callSid=${ctx.callSid}, streamSid=${ctx.streamSid}`);

      const knownCall = Boolean(ctx.callSid) && getActiveCalls().some((c) => c.sid === ctx.callSid);
      const tokenCallSid = req.twilioMeta?.callSid || null;
      const tokenMatchesCall = !tokenCallSid || tokenCallSid === ctx.callSid;

      if (!knownCall || !tokenMatchesCall) {
        console.log(
          `🚫  Twilio stream: invalid start (knownCall=${knownCall}, tokenMatchesCall=${tokenMatchesCall}, callSid=${ctx.callSid}, tokenCallSid=${tokenCallSid})`
        );
        ws.close(1008, "Unknown call");
        return;
      }

      if (ctx.callSid) {
        updateCallStatus(ctx.callSid, "in-progress", message.start);

        const lifecycle = sessionLifecycles.get(ctx.callSid);
        if (lifecycle && lifecycle.state !== "in-progress") {
          lifecycle.transition("in-progress", { streamSid: ctx.streamSid });
          getSlackNotifier().postStatus(lifecycle).catch(() => {});
          getSlackNotifier().startElapsedUpdates(lifecycle);
        }
      }

      if (!ctx.pipeline) {
        const sessionId = ctx.warmupSessionId || ctx.callSid || ctx.streamSid || crypto.randomUUID();
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

        const lifecycle = sessionLifecycles.get(ctx.callSid);
        if (lifecycle) {
          lifecycle.setConversationLog(session.conversationLog);
        }

        const config = getPipelineConfig({
          wakeMode: "off",
          exitDetection: false,
          responseTimeoutMs: 25_000,
        });
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
        const lifecycle = sessionLifecycles.get(ctx.callSid);
        if (lifecycle && !lifecycle.isTerminal) {
          lifecycle.transition("completed", { reason: "stream_stop" });
        }
      }
      closePipeline();
    }
  });

  ws.on("close", () => {
    closePipeline();
    if (ctx.callSid) {
      updateCallStatus(ctx.callSid, "completed");
      const lifecycle = sessionLifecycles.get(ctx.callSid);
      if (lifecycle && !lifecycle.isTerminal) {
        lifecycle.transition("completed", { reason: "ws_close" });
      }
    }
    console.log(`📴  Twilio stream closed: ${ctx.callSid || ctx.streamSid || "unknown"}`);
  });

  ws.on("error", (err) => {
    console.error("❌  Twilio stream error:", err.message);
  });
}

function ensureWss() {
  if (!wss) {
    wss = new WebSocketServer({ noServer: true });
  }

  if (!connectionHandlerAttached) {
    wss.on("connection", handleWsConnection);
    connectionHandlerAttached = true;
  }

  return wss;
}

async function init(options = {}) {
  if (initialized) return;

  validateRequiredEnv();

  if (typeof options.port === "number" && Number.isFinite(options.port)) {
    bridgePort = options.port;
  }

  ensureWss();
  initialized = true;
}

async function handleHttp(req, res) {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    const active = getActiveCalls();
    writeJson(res, 200, {
      ok: true,
      service: "twilio-bridge",
      port: bridgePort,
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
    const briefing = typeof body.briefing === "string" ? body.briefing.trim() : "";
    const warmupSessionId = crypto.randomUUID();

    if (!to) {
      writeJson(res, 400, { error: "missing_to_number" });
      return;
    }

    if (!ALLOWED_NUMBERS.has(to)) {
      writeJson(res, 403, { error: "number_not_allowed", to });
      return;
    }

    try {
      const warmupConfig = getPipelineConfig({
        wakeMode: "off",
        exitDetection: false,
        responseTimeoutMs: 25_000,
      });
      await warmUpGatewaySession(`meet-${warmupSessionId}`, warmupConfig, briefing || null);

      const voiceToken = issueEphemeralToken("voice", VOICE_TOKEN_TTL_MS, {
        to,
        warmupSessionId,
      });
      const twimlUrl = `${PUBLIC_URL}/twilio/voice?vtoken=${encodeURIComponent(voiceToken)}`;
      const statusCallback = `${PUBLIC_URL}/twilio/status`;

      const result = await initiateCall(to, {
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        from: FROM_NUMBER,
        twimlUrl,
        statusCallback,
        maxConcurrent: MAX_CONCURRENT_CALLS,
      });

      const tokenEntry = ephemeralTokens.get(voiceToken);
      if (tokenEntry) {
        tokenEntry.meta.callSid = result.sid || null;
        ephemeralTokens.set(voiceToken, tokenEntry);
      }

      lastCallAt = now;

      if (result.sid) {
        const lifecycle = new SessionLifecycle(result.sid, "twilio", {
          to,
          from: FROM_NUMBER,
        });
        lifecycle.on("session_end", () => handleSessionEnd(lifecycle));
        lifecycle.transition("initiating");
        sessionLifecycles.set(result.sid, lifecycle);
        getSlackNotifier().postStatus(lifecycle).catch(() => {});
      }

      writeJson(res, 200, {
        status: "calling",
        callSid: result.sid,
        to,
        warmupSessionId,
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

    const voiceToken = String(url.searchParams.get("vtoken") || "").trim();
    const consumedVoiceToken = voiceToken ? consumeEphemeralToken(voiceToken, "voice") : null;
    const direction = String(params.Direction || "").toLowerCase();
    const callSid = String(params.CallSid || "").trim();
    const knownCall = Boolean(callSid) && getActiveCalls().some((c) => c.sid === callSid);

    console.log(`📞  /twilio/voice: CallSid=${callSid}, Direction=${direction}, knownCall=${knownCall}, vtokenOK=${!!consumedVoiceToken}`);
    if (!consumedVoiceToken || direction !== "outbound-api" || !knownCall) {
      console.log(`🚫  /twilio/voice: REJECTED (vtoken=${!!consumedVoiceToken}, dir=${direction}, known=${knownCall})`);
      const rejectTwiml = makeRejectTwiml();
      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      res.end(rejectTwiml);
      return;
    }

    const streamToken = issueEphemeralToken("stream", STREAM_TOKEN_TTL_MS, {
      callSid,
      warmupSessionId: consumedVoiceToken?.meta?.warmupSessionId || null,
    });

    const publicWsUrl = PUBLIC_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const streamWsUrl = `${publicWsUrl}/twilio/stream/${encodeURIComponent(streamToken)}`;

    const twiml = makeTwimlResponse(streamWsUrl);
    console.log(`✅  /twilio/voice: Stream URL = ${streamWsUrl.replace(/\/twilio\/stream\/.+$/, "/twilio/stream/***")}`);
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

    const callSid = String(params.CallSid || "");
    const callStatus = String(params.CallStatus || "").toLowerCase();
    const lifecycle = sessionLifecycles.get(callSid);
    if (lifecycle) {
      const stateMap = {
        initiated: "initiating",
        ringing: "ringing",
        "in-progress": "in-progress",
        completed: "completed",
        busy: "failed",
        "no-answer": "failed",
        canceled: "failed",
        failed: "failed",
      };
      const newState = stateMap[callStatus];
      if (newState && newState !== lifecycle.state) {
        lifecycle.transition(newState, { twilioStatus: callStatus });
        getSlackNotifier().postStatus(lifecycle).catch(() => {});

        if (newState === "in-progress") {
          getSlackNotifier().startElapsedUpdates(lifecycle);
        }
      }
    }

    writeText(res, 204, "");
    return;
  }

  writeText(res, 404, "Not Found");
}

function handleUpgrade(req, socket, head, wsServer) {
  const serverWss = wsServer || ensureWss();

  console.log(`🔌  WS upgrade request: ${req.url}`);
  const url = new URL(req.url || "/", "http://localhost");

  const pathMatch = url.pathname.match(/^\/twilio\/stream\/([^/]+)$/);
  if (!pathMatch) {
    console.log(`🚫  WS upgrade: wrong path ${url.pathname}`);
    socket.destroy();
    return;
  }

  let streamToken = "";
  try {
    streamToken = decodeURIComponent(pathMatch[1] || "").trim();
  } catch {
    console.log("🚫  WS upgrade: invalid token encoding");
    socket.destroy();
    return;
  }

  const consumedStreamToken = streamToken ? consumeEphemeralToken(streamToken, "stream") : null;
  if (!consumedStreamToken) {
    console.log("🚫  WS upgrade: invalid/expired stream token");
    socket.destroy();
    return;
  }

  req.twilioMeta = consumedStreamToken.meta || {};
  console.log("🔌  WS upgrade: stream token accepted (callSid will be validated on start)");

  serverWss.handleUpgrade(req, socket, head, (ws) => {
    serverWss.emit("connection", ws, req);
  });
}

module.exports = {
  init,
  handleHttp,
  handleUpgrade,
  handleWsConnection,
};
