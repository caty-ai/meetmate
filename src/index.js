// index.js — AI Meet Participant Bridge Server
// Routes audio between Attendee (Google Meet bot) and voice pipeline
// Supports two modes:
//   - "fish-audio": Decomposed pipeline (Deepgram STT → Claude LLM → Fish Audio TTS)
//   - "deepgram-agent": Legacy all-in-one (Deepgram Voice Agent API)

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { WebSocketServer, WebSocket } = require("ws");
const { createClient, AgentEvents } = require("@deepgram/sdk");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("querystring");
const { getPipelineConfig, SAMPLE_RATE, TTS_PROVIDER, loadConfig } = require("./config");
const { createPipeline } = require("./pipeline");
const { warmUpGatewaySession } = require("./gateway-warmup");

// Track first warm-up for await (subsequent calls are fire-and-forget)
let _firstWarmupDone = false;
const { SessionLifecycle } = require("./session-events");
const { SlackNotifier } = require("./slack-notifier");
const { summarizeConversation } = require("./summarizer");
const { resolveAgentProfile, AgentNotFoundError } = require("./agent-profile");

const _configForPort = loadConfig();
const PORT = Number(_configForPort?.server?.port || process.env.PORT || 5005);
const ATTENDEE_API_BASE_URL = process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev";
const ATTENDEE_TIMEOUT_MS = Number(process.env.ATTENDEE_TIMEOUT_MS || 15_000);
const ATTENDEE_RETRY_ATTEMPTS = Number(process.env.ATTENDEE_RETRY_ATTEMPTS || 3);
const ATTENDEE_RETRY_BASE_MS = Number(process.env.ATTENDEE_RETRY_BASE_MS || 800);
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 1_000_000);
const SESSION_GRACE_CLOSE_MS = Number(process.env.SESSION_GRACE_CLOSE_MS || 15_000);
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);
const JOIN_SHARED_TOKEN = process.env.JOIN_SHARED_TOKEN || "";
const WS_SHARED_TOKEN = process.env.WS_SHARED_TOKEN || "";

// Supported meeting URL patterns:
//   Google Meet: https://meet.google.com/abc-defg-hij
//   Zoom:        https://us04web.zoom.us/j/12345678 or https://zoom.us/j/12345678
const MEETING_URL_RE = /^https:\/\/(meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/(j|my)\/[a-zA-Z0-9?=&._%-]+)(?:\?.*)?$/i;
const CONVERSATION_MODES = new Set(["one_to_one", "group"]);

// ── Validate API keys ──────────────────────────────────────────────
const DG_KEY = process.env.DEEPGRAM_API_KEY;
if (!DG_KEY) {
  console.error("❌  DEEPGRAM_API_KEY が設定されていません。.env ファイルを確認してください。");
  process.exit(1);
}

const ATTENDEE_API_KEY = _configForPort?.attendee?.apiKey || process.env.ATTENDEE_API_KEY;
if (!ATTENDEE_API_KEY) {
  console.error("❌  ATTENDEE_API_KEY が設定されていません。config.json または .env ファイルを確認してください。");
  process.exit(1);
}

if (TTS_PROVIDER === "fish-audio") {
  if (!process.env.FISH_AUDIO_API_KEY) {
    console.error("❌  FISH_AUDIO_API_KEY が設定されていません。");
    process.exit(1);
  }
}

// Resolve agent profile at startup (catches AgentNotFoundError)
let _startupAgentProfile = null;
try {
  _startupAgentProfile = resolveAgentProfile();
} catch (err) {
  if (err instanceof AgentNotFoundError) {
    console.error(`❌  ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Bot avatar image (loaded at startup, cached as base64)
let botImageData = null;

const BOT_IMAGE_PATH = _startupAgentProfile?.avatarPath
  || path.join(__dirname, "..", "assets", "avatar.png");
const BOT_IMAGE_URL = process.env.BOT_IMAGE_URL
  || _startupAgentProfile?.avatarUrl
  || "";

(async function loadBotImage() {
  // Try local file first, then download from URL
  try {
    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const data = fs.readFileSync(BOT_IMAGE_PATH);
      botImageData = { type: "image/png", data: data.toString("base64") };
      console.log("🖼️  Bot avatar loaded (local)");
      return;
    }
  } catch { /* fall through to download */ }

  try {
    const data = await new Promise((resolve, reject) => {
      https.get(BOT_IMAGE_URL, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    });
    botImageData = { type: "image/png", data: data.toString("base64") };
    // Cache locally for next startup
    const assetsDir = path.join(__dirname, "..", "assets");
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(BOT_IMAGE_PATH, data);
    console.log("🖼️  Bot avatar downloaded and cached");
  } catch (err) {
    console.warn("⚠️  Bot avatar load failed:", err.message);
  }
})();

// Auto-detect ngrok public URL for WebSocket
// config.server.ngrokDomain takes priority; falls back to localhost:4040 auto-detection
let detectedNgrokUrl = "";
(async function detectNgrok() {
  const ngrokDomain = _configForPort?.server?.ngrokDomain;
  if (ngrokDomain) {
    detectedNgrokUrl = `wss://${ngrokDomain}`;
    console.log(`🌐  ngrok WSS URL (config.json): ${detectedNgrokUrl}`);
    return;
  }
  try {
    const ngrokRes = await new Promise((resolve, reject) => {
      http.get("http://localhost:4040/api/tunnels", (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }).on("error", reject);
    });
    const tunnels = JSON.parse(ngrokRes);
    const httpsTunnel = tunnels.tunnels?.find((t) => t.public_url?.startsWith("https://"));
    if (httpsTunnel) {
      detectedNgrokUrl = httpsTunnel.public_url.replace("https://", "wss://");
      console.log(`🌐  ngrok WSS URL 検出: ${detectedNgrokUrl}`);
    }
  } catch {
    // ngrok not running, that's fine
  }
})();

if (!JOIN_SHARED_TOKEN) {
  console.warn("⚠️  JOIN_SHARED_TOKEN 未設定: /join-meeting はローカルネットワーク公開時に保護されません。");
}
if (!WS_SHARED_TOKEN) {
  console.warn("⚠️  WS_SHARED_TOKEN 未設定: WebSocket は sid のみで接続可能です。");
}

/** @type {Map<string, {
 *   id: string,
 *   createdAt: string,
 *   meetingUrl: string,
 *   config: {prompt: string|null, greeting: string|null, model: string|null, voice: string|null, wakeMode: "off"|"wake"},
 *   conversationLog: Array<{timestamp:string, role:string, content:string}>,
 *   closeTimer?: NodeJS.Timeout
 * }>} */
const meetingSessions = new Map();

/** @type {Map<string, {client: import("ws").WebSocket, handler: any}>} */
const activeConnections = new Map();

/** @type {Map<string, import("./session-events").SessionLifecycle>} */
const meetLifecycles = new Map();

/** Sessions in the process of leaving — block reconnection + greeting replay */
const leavingSessionIds = new Set();
/** Track which leaving sessions have already been logged (avoid log spam) */
const leavingLoggedOnce = new Set();

// Slack notifier for Meet sessions
let meetSlackNotifier = null;
function getMeetSlackNotifier() {
  if (!meetSlackNotifier) {
    const notifyEnabled = String(process.env.SLACK_NOTIFY_ENABLED || "true").toLowerCase() !== "false";

    // Read notification config from config.json (DM-first architecture)
    const slackConfig = _configForPort?.slack || {};
    const notifications = slackConfig.notifications || {};

    const notifyTarget = notifications.target || "dm";
    const dmUserId = notifications.dmUserId || "";

    const fallback = slackConfig.notifyChannel || process.env.SLACK_NOTIFY_CHANNEL || "";
    const summaryChannel = slackConfig.summaryChannel || process.env.SLACK_SUMMARY_CHANNEL || fallback;
    const statusChannel = slackConfig.statusChannel || process.env.SLACK_STATUS_CHANNEL || summaryChannel || fallback;

    const agentSlackToken =
      slackConfig.botToken
      || process.env.SLACK_BOT_TOKEN
      || "";

    meetSlackNotifier = new SlackNotifier(
      agentSlackToken,
      fallback,
      {
        enabled: notifyEnabled,
        notifyTarget,
        dmUserId,
        statusChannelId: statusChannel,
        summaryChannelId: summaryChannel,
      }
    );

    if (meetSlackNotifier.enabled) {
      if (notifyTarget === "dm") {
        console.log(`📢  Meet Slack通知有効: target=DM (user=${dmUserId})`);
      } else {
        console.log(`📢  Meet Slack通知有効: target=channel (status=${statusChannel}, summary=${summaryChannel})`);
      }
    }
  }
  return meetSlackNotifier;
}

/** Handle Meet session end: summarize + Slack. */
async function handleMeetSessionEnd(lifecycle) {
  const notifier = getMeetSlackNotifier();
  notifier.stopElapsedUpdates(lifecycle.sessionId);
  await notifier.postStatus(lifecycle);

  const summaryEnabled = String(process.env.SUMMARY_ENABLED || "true").toLowerCase() !== "false";
  if (summaryEnabled && lifecycle._conversationLog && lifecycle._conversationLog.length > 0) {
    try {
      const summary = await summarizeConversation(lifecycle._conversationLog, {
        openclawUrl: process.env.OPENCLAW_GATEWAY_URL,
        openclawToken: process.env.OPENCLAW_GATEWAY_TOKEN,
      });
      await notifier.postSummary(lifecycle, summary);
      console.log("📋  Meetサマリー投稿完了");

      // Post full transcript to Slack thread
      await postMeetFullTranscript(notifier, lifecycle);
    } catch (err) {
      console.error("⚠️  Meetサマリー生成/投稿失敗:", err.message);
    }
  }

  // LCM ingest — capture conversation into Lossless Claw (background, non-blocking)
  sendLcmIngest(lifecycle, notifier).catch((err) => {
    console.warn(`⚠️  LCM ingest failed (non-fatal):`, err.message);
  });

  meetLifecycles.delete(lifecycle.sessionId);
}

/** Send [[[lcm:ingest]]] tag to Gateway via Chat Completions API. */
const _lcmIngestedSessions = new Map();

async function sendLcmIngest(lifecycle, notifier) {
  const sid = lifecycle.sessionId;
  const agentId = (_startupAgentProfile?.agentId || "unknown").toLowerCase();
  const lcmKey = `${agentId}:${sid}`;

  if (_lcmIngestedSessions.has(lcmKey)) {
    console.log(`⏭️  LCM ingest skipped — already ingested for ${lcmKey}`);
    return;
  }
  _lcmIngestedSessions.set(lcmKey, true);

  // Resolve agent-specific gateway credentials
  let openclawUrl = process.env.OPENCLAW_GATEWAY_URL;
  let openclawToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (_startupAgentProfile) {
    if (_startupAgentProfile.gatewayUrl) openclawUrl = _startupAgentProfile.gatewayUrl;
    if (_startupAgentProfile.gatewayToken) openclawToken = _startupAgentProfile.gatewayToken;
  }

  if (!openclawUrl || !openclawToken) {
    console.log("⏭️  LCM ingest skipped — no Gateway credentials");
    return;
  }

  const log = lifecycle._conversationLog;
  if (!log || log.length === 0) {
    console.log("⏭️  LCM ingest skipped — empty conversation log");
    return;
  }

  const sessionUser = `meet-${sid}-${agentId}`;
  const ingestStart = Date.now();
  console.log(`📝  Sending LCM ingest (background) — session=${sessionUser}, entries=${log.length}`);

  const ingestMessages = [
    ...log
      .filter(e => (e.role === "user" || e.role === "assistant") && typeof e.content === "string")
      .map(e => ({ role: e.role, content: e.content })),
    { role: "user", content: "[[[lcm:ingest]]] セッション終了。この会話を長期記憶に保存してください。" },
  ];

  const gatewayUrl = new URL(openclawUrl);
  const isHttps = gatewayUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const body = JSON.stringify({
    // Route to OpenClaw Gateway default agent/model selection.
    model: "openclaw",
    stream: false,
    temperature: 0.3,
    max_tokens: 1,
    messages: ingestMessages,
    user: sessionUser,
  });

  try {
    const responseText = await new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: gatewayUrl.hostname,
          port: gatewayUrl.port || (isHttps ? 443 : 80),
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            Authorization: `Bearer ${openclawToken}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`LCM ingest Gateway error (${res.statusCode}): ${data.slice(0, 200)}`));
              return;
            }
            resolve(data);
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    const elapsed = Date.now() - ingestStart;
    console.log(`✅  LCM ingest completed (background) — session=${sessionUser}, id=${sid}, ${elapsed}ms`);
    if (notifier?.enabled) {
      notifier.postTranscript(lifecycle, `✅ LCM ingest 完了 (${(elapsed / 1000).toFixed(1)}s)`).catch(() => {});
    }
  } catch (err) {
    const elapsed = Date.now() - ingestStart;
    console.warn(`⚠️  LCM ingest failed (non-fatal, ${elapsed}ms):`, err.message);
    if (notifier?.enabled) {
      notifier.postTranscript(lifecycle, `⚠️ LCM ingest 失敗: ${err.message}`).catch(() => {});
    }
  }
}

/** Post full conversation transcript as Slack thread reply. */
async function postMeetFullTranscript(notifier, lifecycle) {
  if (!notifier.enabled) return;
  const log = lifecycle._conversationLog;
  if (!log || log.length === 0) return;

  const lines = ["📜 全文ログ", "━━━━━━━━━━━━━━━", ""];
  for (const entry of log) {
    const agentDisplayName = _startupAgentProfile?.displayName || "AI";
    const speaker = entry.role === "assistant" || entry.role === "agent" ? `🤖 ${agentDisplayName}` : "👤 参加者";
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
    console.log("📜  Meet全文ログSlack投稿完了");
  } catch (err) {
    console.error("⚠️  Meet全文ログSlack投稿失敗:", err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

function toSafeString(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function resolveWakeMode(conversationMode) {
  return conversationMode === "group" ? "wake" : "off";
}

function buildWsUrlWithSession(baseWsUrl, sessionId) {
  const u = new URL(baseWsUrl);
  u.searchParams.set("sid", sessionId);
  if (WS_SHARED_TOKEN) {
    u.searchParams.set("token", WS_SHARED_TOKEN);
  }
  return u.toString();
}

function checkJoinAuthorization(req, formData) {
  if (!JOIN_SHARED_TOKEN) return true;

  const headerToken = req.headers["x-join-token"];
  const bodyToken = formData.joinToken || formData.token;
  const candidate = toSafeString(Array.isArray(headerToken) ? headerToken[0] : headerToken) || toSafeString(bodyToken);
  return candidate && candidate === JOIN_SHARED_TOKEN;
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let received = 0;

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > BODY_LIMIT_BYTES) {
        reject(new Error(`Request body too large (>${BODY_LIMIT_BYTES} bytes)`));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => resolve(parse(body)));
    req.on("error", reject);
  });
}

function createAttendeeBot(attendeePayload) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ATTENDEE_API_BASE_URL,
      port: 443,
      path: "/api/v1/bots",
      method: "POST",
      headers: {
        Authorization: `Token ${ATTENDEE_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(attendeePayload),
      },
    };

    const attendeeReq = https.request(options, (attendeeRes) => {
      let responseData = "";
      attendeeRes.on("data", (chunk) => {
        responseData += chunk;
      });
      attendeeRes.on("end", () => {
        resolve({ statusCode: attendeeRes.statusCode || 0, body: responseData });
      });
    });

    attendeeReq.setTimeout(ATTENDEE_TIMEOUT_MS, () => {
      attendeeReq.destroy(new Error(`Attendee request timeout (${ATTENDEE_TIMEOUT_MS}ms)`));
    });

    attendeeReq.on("error", reject);
    attendeeReq.write(attendeePayload);
    attendeeReq.end();
  });
}

async function createAttendeeBotWithRetry(attendeePayload) {
  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= ATTENDEE_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await createAttendeeBot(attendeePayload);
      lastResult = result;

      if (result.statusCode >= 200 && result.statusCode < 300) {
        return result;
      }

      if (!shouldRetryStatus(result.statusCode) || attempt === ATTENDEE_RETRY_ATTEMPTS) {
        return result;
      }

      const delay = ATTENDEE_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️  Attendee API retry ${attempt}/${ATTENDEE_RETRY_ATTEMPTS} in ${delay}ms (status=${result.statusCode})`);
      await sleep(delay);
    } catch (err) {
      lastError = err;
      if (attempt === ATTENDEE_RETRY_ATTEMPTS) break;
      const delay = ATTENDEE_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️  Attendee API network retry ${attempt}/${ATTENDEE_RETRY_ATTEMPTS} in ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error("Unknown attendee request error");
}

/**
 * Request bot to leave the meeting via Attendee API (POST /api/v1/bots/{id}/leave).
 */
function requestBotLeave(botId, reason) {
  const payload = JSON.stringify({});
  const options = {
    hostname: ATTENDEE_API_BASE_URL,
    port: 443,
    path: `/api/v1/bots/${botId}/leave`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${ATTENDEE_API_KEY}`,
      "Content-Length": Buffer.byteLength(payload),
    },
  };
  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      console.log(`🚪  Attendee bot leave (${reason}): ${botId} → ${res.statusCode} ${data.slice(0, 200)}`);
    });
  });
  req.on("error", (err) => console.error(`❌  Attendee bot leave error (${reason}): ${err.message}`));
  req.write(payload);
  req.end();
}

function saveConversationLog(session) {
  if (!session || !Array.isArray(session.conversationLog) || session.conversationLog.length === 0) {
    return;
  }

  const logDir = path.join(__dirname, "..", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `meeting-${timestamp}-${session.id}`;

  const jsonPath = path.join(logDir, `${baseName}.json`);
  const jsonData = {
    session_id: session.id,
    meeting_url: session.meetingUrl,
    created_at: session.createdAt,
    saved_at: new Date().toISOString(),
    tts_provider: TTS_PROVIDER,
    messages: session.conversationLog,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`📝  会話ログ保存: ${jsonPath}`);

  const mdPath = path.join(logDir, `${baseName}.md`);
  const mdContent = [
    `# Meeting Log — ${new Date().toLocaleString("ja-JP")}`,
    "",
    `- session_id: ${session.id}`,
    `- meeting_url: ${session.meetingUrl}`,
    `- tts_provider: ${TTS_PROVIDER}`,
    "",
    ...session.conversationLog.map((e) => `**${e.role === "assistant" || e.role === "agent" ? (_startupAgentProfile?.displayName || "AI") : "参加者"}** (${e.timestamp}):\n${e.content}\n`),
  ].join("\n");
  fs.writeFileSync(mdPath, mdContent);
  console.log(`📝  会話ログ(MD)保存: ${mdPath}`);

  appendToMemory(session);
}

function appendToMemory(session) {
  try {
    const WORKSPACE = process.env.OPENCLAW_WORKSPACE
      || path.join(require("os").homedir(), ".openclaw", "workspace");
    const memoryDir = path.join(WORKSPACE, "memory");
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const memoryFile = path.join(memoryDir, `${today}.md`);

    const msgCount = session.conversationLog.length;
    const userMsgs = session.conversationLog
      .filter((e) => e.role !== "assistant" && e.role !== "agent")
      .map((e) => e.content)
      .slice(0, 10);
    const agentMsgs = session.conversationLog
      .filter((e) => e.role === "assistant" || e.role === "agent")
      .map((e) => e.content)
      .slice(0, 10);

    const agentLabel = _startupAgentProfile?.agentId || "agent";
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Bangkok" });
    const summary = [
      "",
      `## 🎙️ Google Meet セッション (${now})`,
      `- Session ID: ${session.id}`,
      `- TTS: ${TTS_PROVIDER}`,
      `- 発話数: ${msgCount}`,
      "",
      "### 会話ハイライト",
      ...userMsgs.slice(0, 5).map((m) => `- 参加者: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      ...agentMsgs.slice(0, 5).map((m) => `- ${agentLabel}: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      "",
    ].join("\n");

    fs.appendFileSync(memoryFile, summary);
    console.log(`🧠  メモリに追記: ${memoryFile}`);

    // Also save full conversation log to memory/calls/ for memory_search indexing
    const callsDir = path.join(memoryDir, "calls");
    if (!fs.existsSync(callsDir)) fs.mkdirSync(callsDir, { recursive: true });
    const callLogPath = path.join(callsDir, `meet-${today}-${session.id.slice(0, 12)}.md`);
    const fullLog = [
      `# Google Meet ログ — ${now}`,
      "",
      `- Session ID: ${session.id}`,
      `- Meeting URL: ${session.meetingUrl || "—"}`,
      `- 発話数: ${msgCount}`,
      "",
      "## 全文",
      "",
      ...session.conversationLog.map((e) => {
        const speaker = e.role === "assistant" || e.role === "agent"
          ? (_startupAgentProfile?.displayName || "AI")
          : "参加者";
        return `**${speaker}**: ${e.content}\n`;
      }),
    ].join("\n");
    fs.writeFileSync(callLogPath, fullLog);
    console.log(`🧠  Meetログ memory/calls/ 保存: ${callLogPath}`);
  } catch (err) {
    console.error("⚠️  メモリ追記失敗:", err.message);
  }
}

function finalizeSessionIfInactive(sessionId) {
  const active = activeConnections.get(sessionId);
  if (active) return;

  const session = meetingSessions.get(sessionId);
  if (!session) return;

  saveConversationLog(session);
  meetingSessions.delete(sessionId);
  leavingSessionIds.delete(sessionId);
  leavingLoggedOnce.delete(sessionId);
  console.log(`🧹  Session closed: ${sessionId}`);
}

function scheduleFinalizeSession(sessionId) {
  const session = meetingSessions.get(sessionId);
  if (!session) return;

  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
  }

  session.closeTimer = setTimeout(() => {
    finalizeSessionIfInactive(sessionId);
  }, SESSION_GRACE_CLOSE_MS);
}

function cancelFinalizeSession(sessionId) {
  const session = meetingSessions.get(sessionId);
  if (!session?.closeTimer) return;
  clearTimeout(session.closeTimer);
  session.closeTimer = undefined;
}

// ── Create Deepgram Voice Agent (legacy mode) ──────────────────────
function createLegacyAgent(session, turnState, onAudio) {
  const deepgram = createClient(DG_KEY);
  const agent = deepgram.agent();

  agent.on(AgentEvents.Open, () => {
    console.log(`🟢  Deepgram Voice Agent 接続完了 (sid=${session.id})`);

    const config = buildAgentConfig({
      prompt: session.config.prompt,
      greeting: session.config.greeting,
      model: session.config.model,
      voice: session.config.voice,
    });
    agent.configure(config);
  });

  agent.on(AgentEvents.Audio, (raw) => onAudio(Buffer.from(raw)));
  agent.on(AgentEvents.Error, (err) => console.error(`❌  Deepgram error (sid=${session.id}):`, err));
  agent.on(AgentEvents.Close, () => {
    turnState.isAgentSpeaking = false;
    turnState.inputCooldownUntil = 0;
    console.log(`🔴  Deepgram Voice Agent 切断 (sid=${session.id})`);
  });
  agent.on(AgentEvents.Welcome, (w) => console.log(`🙌  Agent ready (sid=${session.id}):`, w));
  agent.on(AgentEvents.ConversationText, (m) => {
    session.conversationLog.push({
      timestamp: new Date().toISOString(),
      role: m.role,
      content: m.content,
    });
    console.log(`💬  [${m.role}] ${m.content}`);
  });
  agent.on(AgentEvents.AgentThinking, () => console.log(`🤔  [${_startupAgentProfile?.agentId || "agent"}] thinking… (sid=${session.id})`));
  agent.on(AgentEvents.AgentStartedSpeaking, (s) => {
    turnState.isAgentSpeaking = true;
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`🗣️  [${_startupAgentProfile?.agentId || "agent"}] speaking (sid=${session.id}):`, s);
  });
  agent.on(AgentEvents.UserStartedSpeaking, () => console.log(`🎙️  User speaking (sid=${session.id})`));
  agent.on(AgentEvents.AgentAudioDone, () => {
    turnState.isAgentSpeaking = false;
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`✅  Audio done (sid=${session.id})`);
  });

  const keepAlive = setInterval(() => {
    try { agent.keepAlive?.(); } catch { /* no-op */ }
  }, 8_000);
  agent.once(AgentEvents.Close, () => clearInterval(keepAlive));

  return { send: (buf) => agent.send(buf), close: () => agent.finish?.() };
}

// ── Create handler (pipeline or legacy agent) ──────────────────────
function createHandler(session, turnState, onAudio) {
  if (TTS_PROVIDER === "fish-audio") {
    console.log(`🐟  Fish Audio パイプラインモード (sid=${session.id})`);
    const config = getPipelineConfig({
      prompt: session.config.prompt,
      greeting: session.config.greeting,
      model: session.config.model,
      wakeMode: session.config.wakeMode,
    }, null, null, _configForPort);
    const pipeline = createPipeline(session, turnState, onAudio, config);
    return {
      send: (buf) => pipeline.sendAudio(buf),
      close: () => pipeline.close(),
      on: pipeline.on,
      once: pipeline.once,
      removeListener: pipeline.removeListener,
    };
  } else {
    console.log(`🔊  Deepgram Voice Agent モード (sid=${session.id})`);
    return createLegacyAgent(session, turnState, onAudio);
  }
}

function writePlainResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// ── HTTP + WebSocket Server ────────────────────────────────────────
const SERVER_START_TIME = Date.now();

const server = http.createServer(async (req, res) => {
  // Health check endpoint for watchdog
  if (req.method === "GET" && req.url === "/health") {
    const uptimeSeconds = ((Date.now() - SERVER_START_TIME) / 1000).toFixed(1);
    const payload = JSON.stringify({ ok: true, uptime: Number(uptimeSeconds), activeSessions: meetingSessions.size });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    fs.readFile(path.join(__dirname, "..", "public", "index.html"), (err, data) => {
      if (err) {
        writePlainResponse(res, 500, "Error loading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (req.method === "GET" && req.url === "/info") {
    // Compute public WSS URL: prefer detected ngrok, then env, then request host
    let publicWsUrl = "";
    const host = req.headers.host || "";
    if (host.includes("ngrok")) {
      publicWsUrl = `wss://${host}`;
    } else if (detectedNgrokUrl) {
      publicWsUrl = detectedNgrokUrl;
    } else if (process.env.PUBLIC_WSS_URL) {
      publicWsUrl = process.env.PUBLIC_WSS_URL;
    }

    const info = {
      ttsProvider: TTS_PROVIDER,
      lang: process.env.AGENT_LANG || "ja",
      publicWsUrl,
      ready: true,
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(info));
    return;
  }

  if (req.method === "POST" && req.url === "/join-meeting") {
    try {
      const formData = await parseRequestBody(req);

      // Join token check: skip if request comes from the UI (same origin)
      // and there's no external token header set
      const hasExternalToken = req.headers["x-join-token"];
      if (hasExternalToken && !checkJoinAuthorization(req, formData)) {
        writePlainResponse(res, 401, "Unauthorized: invalid join token");
        return;
      }

      const meetingUrl = toSafeString(formData.meetingUrl);
      const wsUrl = toSafeString(formData.wsUrl);
      const conversationMode = toSafeString(formData.conversationMode) || "one_to_one";
      const briefing = toSafeString(formData.briefing) || null;

      if (!meetingUrl || !wsUrl) {
        writePlainResponse(res, 400, "meetingUrl と wsUrl は必須です。");
        return;
      }
      if (!CONVERSATION_MODES.has(conversationMode)) {
        writePlainResponse(res, 400, "conversationMode は one_to_one または group を指定してください。");
        return;
      }

      if (!MEETING_URL_RE.test(meetingUrl)) {
        writePlainResponse(res, 400, "meetingUrl が Google Meet または Zoom の URL 形式ではありません。");
        return;
      }

      let parsedWs;
      try {
        parsedWs = new URL(wsUrl);
      } catch {
        writePlainResponse(res, 400, "wsUrl が不正なURLです。");
        return;
      }
      if (!["ws:", "wss:"].includes(parsedWs.protocol)) {
        writePlainResponse(res, 400, "wsUrl は ws:// または wss:// で指定してください。");
        return;
      }

      const sessionId = crypto.randomUUID();
      const session = {
        id: sessionId,
        createdAt: new Date().toISOString(),
        meetingUrl,
        config: {
          prompt: toSafeString(formData.prompt) || null,
          greeting: toSafeString(formData.greeting) || null,
          model: toSafeString(formData.model) || null,
          voice: toSafeString(formData.voice) || null,
          wakeMode: resolveWakeMode(conversationMode),
        },
        conversationLog: [],
      };

      meetingSessions.set(sessionId, session);

      // Create session lifecycle for Meet
      const lifecycle = new SessionLifecycle(sessionId, "meet", {
        meetingUrl,
        conversationMode,
      });
      lifecycle.on("session_end", () => handleMeetSessionEnd(lifecycle));
      lifecycle.transition("initiating");
      meetLifecycles.set(sessionId, lifecycle);
      getMeetSlackNotifier().postStatus(lifecycle).catch(() => {});

      const warmupConfig = getPipelineConfig({
        prompt: session.config.prompt,
        model: session.config.model,
        wakeMode: session.config.wakeMode,
        exitDetection: conversationMode !== "group",
      }, null, null, _configForPort);
      // pipeline.js builds runtime sessionUser as `meet-${sessionId}-${agentId}`,
      // so the warm-up key must include agentId to actually warm Caty's session
      // (matches the fix in src/transport-meet/meet-routes.js).
      const warmupAgentId = _startupAgentProfile?.agentId || "default";
      const warmupSessionKey = `meet-${sessionId}-${warmupAgentId}`;
      if (!_firstWarmupDone) {
        // First warm-up: await with configurable timeout to prevent initial race condition
        _firstWarmupDone = true;
        const firstWarmupRaceMs = Math.min(warmupConfig.warmupTimeoutMs || 10_000, 60_000);
        console.log(`🔥  First warm-up (awaiting up to ${firstWarmupRaceMs / 1000}s)...`);
        try {
          const warmupResult = await Promise.race([
            warmUpGatewaySession(warmupSessionKey, warmupConfig, briefing),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`warmup timeout ${firstWarmupRaceMs}ms`)), firstWarmupRaceMs)),
          ]);
          console.log(`✅  First warm-up completed: ${warmupResult.status}`);
        } catch (e) {
          console.warn(`⚠️  First warm-up failed (non-blocking): ${e.message}`);
        }
      } else {
        warmUpGatewaySession(warmupSessionKey, warmupConfig, briefing);
      }

      const wsWithSession = buildWsUrlWithSession(wsUrl, sessionId);
      console.log("📹  Meeting URL:", meetingUrl);
      console.log("🔗  WebSocket URL:", wsWithSession.replace(/token=[^&]+/, "token=***"));
      console.log("🧾  Session ID:", sessionId);
      console.log("💬  Conversation Mode:", conversationMode, `(${session.config.wakeMode})`);

      const botPayload = {
        meeting_url: meetingUrl,
        bot_name: toSafeString(formData.botName) || `${_startupAgentProfile?.name || "AI"} (${_startupAgentProfile?.displayName || "AI"})`,
        websocket_settings: {
          audio: {
            url: wsWithSession,
            sample_rate: SAMPLE_RATE,
          },
        },
      };

      // Attach bot avatar if available (loaded at startup)
      if (botImageData) {
        botPayload.bot_image = botImageData;
      }

      const attendeePayload = JSON.stringify(botPayload);

      const attendeeResult = await createAttendeeBotWithRetry(attendeePayload);
      if (attendeeResult.statusCode >= 200 && attendeeResult.statusCode < 300) {
        console.log("✅  Bot起動成功:", attendeeResult.body);
        // Parse botId from Attendee API response for leave functionality
        try {
          const parsed = JSON.parse(attendeeResult.body);
          if (parsed.id) {
            session.botId = parsed.id;
            console.log(`🤖  Bot ID: ${parsed.id}`);
          }
        } catch { /* body may not be JSON */ }
        const agentName = _startupAgentProfile?.displayName || "AI";
        writePlainResponse(
          res,
          200,
          `成功！Botが30秒以内にMeetに参加し、さらに30秒後に${agentName}が挨拶を開始します。\nsession_id=${sessionId}`
        );
        return;
      }

      console.error("❌  Bot起動失敗:", attendeeResult.statusCode, attendeeResult.body);
      // Mark lifecycle as failed
      const failedLifecycle = meetLifecycles.get(sessionId);
      if (failedLifecycle && !failedLifecycle.isTerminal) {
        failedLifecycle.transition("failed", { reason: "bot_launch_failed", statusCode: attendeeResult.statusCode });
      }
      meetingSessions.delete(sessionId);
      writePlainResponse(res, 502, `Bot起動エラー: ${attendeeResult.statusCode} - ${attendeeResult.body}`);
      return;
    } catch (err) {
      console.error("❌  /join-meeting error:", err);
      writePlainResponse(res, 500, `join-meeting エラー: ${err.message}`);
      return;
    }
  }

  // /agents — list the configured agent
  if (req.method === "GET" && req.url === "/agents") {
    let agentList = [];
    if (_startupAgentProfile) {
      agentList = [{
        id: _startupAgentProfile.agentId,
        displayName: _startupAgentProfile.displayName,
        voiceId: _startupAgentProfile.voiceId || null,
      }];
    }
    const response = { agents: agentList, fixedAgentId: _startupAgentProfile?.agentId || null };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(response));
    return;
  }

  // /active-session — list active meeting sessions (for UI polling)
  if (req.method === "GET" && req.url === "/active-session") {
    const sessions = [];
    for (const [sid, session] of meetingSessions) {
      const lc = meetLifecycles.get(sid);
      sessions.push({
        sessionId: sid,
        meetingUrl: session.meetingUrl,
        startedAt: session.startedAt,
        state: lc?.state || "unknown",
        botId: session.botId || null,
        hasConnection: activeConnections.has(sid),
        agentIds: session.config?.agentIds || [],
        agentDisplayNames: session.agents || [],
      });
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ active: sessions.length > 0, sessions }));
    return;
  }

  // /leave-meeting — force-remove bot from meeting
  if (req.method === "POST" && req.url === "/leave-meeting") {
    try {
      const formData = await parseRequestBody(req);
      let targetSid = formData?.sessionId;

      if (!targetSid || !meetingSessions.has(targetSid)) {
        // If no specific session, try to leave the first active one
        const firstSid = meetingSessions.keys().next().value;
        if (!firstSid) {
          writePlainResponse(res, 404, "アクティブなセッションがありません。");
          return;
        }
        targetSid = firstSid;
      }

      const session = meetingSessions.get(targetSid);
      const botId = session?.botId;

      // Mark as leaving to prevent reconnection
      leavingSessionIds.add(targetSid);

      // Close the WebSocket connection
      const conn = activeConnections.get(targetSid);
      if (conn?.client) {
        try { conn.client.close(1000, "leave_requested"); } catch { /* ignore */ }
      }

      // Call Attendee API to leave the meeting
      if (botId) {
        requestBotLeave(botId, "web_ui_leave");
      }

      // Transition lifecycle
      const lc = meetLifecycles.get(targetSid);
      if (lc && !lc.isTerminal) {
        lc.transition("completed", { reason: "leave_requested" });
      }

      // Immediate cleanup
      if (session) {
        if (session.closeTimer) clearTimeout(session.closeTimer);
        saveConversationLog(session);
        meetingSessions.delete(targetSid);
        leavingSessionIds.delete(targetSid);
        leavingLoggedOnce.delete(targetSid);
        console.log(`🧹  Session closed (leave): ${targetSid}`);
      }

      writePlainResponse(res, 200, `退出リクエスト送信: session=${targetSid}, bot=${botId || "unknown"}`);
      return;
    } catch (err) {
      console.error("❌  /leave-meeting error:", err);
      writePlainResponse(res, 500, `leave-meeting エラー: ${err.message}`);
      return;
    }
  }

  writePlainResponse(res, 404, "Not Found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (client, req) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || "/", "http://localhost");
  } catch {
    client.close(1008, "Bad URL");
    return;
  }

  const sid = parsedUrl.searchParams.get("sid");
  const token = parsedUrl.searchParams.get("token") || "";

  if (!sid || !meetingSessions.has(sid)) {
    client.close(1008, "Unknown session");
    return;
  }

  // Block reconnection for sessions that are leaving (prevents greeting replay)
  if (leavingSessionIds.has(sid)) {
    // Log only once per session to avoid spam
    if (!leavingLoggedOnce.has(sid)) {
      leavingLoggedOnce.add(sid);
      console.log(`⛔  Blocked reconnection for leaving session ${sid} (further attempts silenced)`);
    }
    // Use 4000 (custom close) to signal "do not retry"
    client.close(4000, "Session terminated");
    return;
  }

  if (WS_SHARED_TOKEN && token !== WS_SHARED_TOKEN) {
    client.close(1008, "Unauthorized websocket token");
    return;
  }

  const session = meetingSessions.get(sid);
  cancelFinalizeSession(sid);

  const previous = activeConnections.get(sid);
  if (previous?.client && previous.client !== client) {
    console.warn(`⚠️  Existing connection replaced (sid=${sid})`);
    try {
      previous.client.close(1012, "Superseded by a new connection");
      previous.handler?.close?.();
    } catch {
      // no-op
    }
    activeConnections.delete(sid);
  }

  console.log(`⇦  Attendee Bot 接続: ${req.socket.remoteAddress} (sid=${sid})`);

  // Transition lifecycle to in-progress
  const lifecycle = meetLifecycles.get(sid);
  if (lifecycle && lifecycle.state !== "in-progress") {
    lifecycle.transition("in-progress", { remoteAddress: req.socket.remoteAddress });
    getMeetSlackNotifier().postStatus(lifecycle).catch(() => {});
    getMeetSlackNotifier().startElapsedUpdates(lifecycle);

    // Bind conversation log for summary
    lifecycle.setConversationLog(session.conversationLog);
  }

  const turnState = {
    isAgentSpeaking: false,
    inputCooldownUntil: 0,
    droppedEchoFrames: 0,
  };

  // Create handler (pipeline or legacy); wire response audio → Attendee
  const handler = createHandler(session, turnState, (buffer) => {
    if (client.readyState !== WebSocket.OPEN) return;

    const payload = {
      trigger: "realtime_audio.bot_output",
      data: { chunk: buffer.toString("base64"), sample_rate: SAMPLE_RATE },
    };

    try {
      client.send(JSON.stringify(payload));
    } catch (err) {
      console.error(`❌  Failed sending bot_output (sid=${sid}):`, err.message);
    }
  });

  activeConnections.set(sid, { client, handler });

  // Listen for exit_requested from pipeline (Meet exit command detection)
  if (handler.on) {
    handler.on("exit_requested", (evt) => {
      console.log(`🚪  Exit requested for session ${sid}: ${evt.trigger}`);

      // Mark as leaving to prevent reconnection greeting replay
      leavingSessionIds.add(sid);

      // Call Attendee API to remove bot from Meet
      const session = meetingSessions.get(sid);
      if (session?.botId) {
        requestBotLeave(session.botId, "exit_requested");
      }

      // Close the Attendee bot connection, which triggers cleanup
      try {
        client.close(1000, "Exit requested by user");
      } catch {
        client.terminate();
      }
    });
  }

  // Basic ws heartbeat to kill stale links
  client.isAlive = true;
  client.on("pong", () => {
    client.isAlive = true;
  });

  const heartbeat = setInterval(() => {
    if (!client.isAlive) {
      console.warn(`⚠️  WS heartbeat timeout (sid=${sid})`);
      client.terminate();
      return;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      client.terminate();
    }
  }, 30_000);

  // Attendee → handler: forward meeting audio
  client.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.trigger === "realtime_audio.mixed" && parsed?.data?.chunk) {
        const now = Date.now();
        if (turnState.isAgentSpeaking || now < turnState.inputCooldownUntil) {
          turnState.droppedEchoFrames += 1;
          if (turnState.droppedEchoFrames % 50 === 0) {
            console.log(
              `🛡️  Echo gate active (sid=${sid}): dropped ${turnState.droppedEchoFrames} frames ` +
              `(isSpeaking=${turnState.isAgentSpeaking}, cooldownLeft=${Math.max(0, turnState.inputCooldownUntil - now)}ms)`
            );
          }
          return;
        }

        if (turnState.droppedEchoFrames > 0) {
          console.log(`🛡️  Echo gate released (sid=${sid}), dropped total frames: ${turnState.droppedEchoFrames}`);
          turnState.droppedEchoFrames = 0;
        }

        const audio = Buffer.from(parsed.data.chunk, "base64");
        handler.send(audio);
      } else {
        console.log("📩  Non-audio message:", parsed.trigger || parsed);
      }
    } catch (err) {
      console.error(`❌  Bad WS message (sid=${sid}):`, err.message);
    }
  });

  client.on("error", (err) => {
    console.error(`❌  WS error (sid=${sid}):`, err.message);
  });

  client.on("close", () => {
    clearInterval(heartbeat);
    console.log(`⇨  Attendee Bot 切断 (sid=${sid})`);

    const current = activeConnections.get(sid);
    if (current?.client === client) {
      activeConnections.delete(sid);
    }

    try {
      handler?.close?.();
    } catch {
      // no-op
    }

    // Transition lifecycle to completed (triggers summary + Slack)
    const lc = meetLifecycles.get(sid);
    if (lc && !lc.isTerminal) {
      lc.transition("completed", { reason: "ws_close" });
    }

    scheduleFinalizeSession(sid);
  });
});

server.listen(PORT, () => {
  const displayName = _startupAgentProfile?.displayName || "AI";
  const agentId = _startupAgentProfile?.agentId || "agent";
  console.log(`🚀  AI Meet Participant Bridge Server 起動: http://localhost:${PORT}`);
  console.log(`📡  TTS Provider: ${TTS_PROVIDER}`);
  console.log(`🤖  [${agentId}] ${displayName} がMeetで待機中…`);
});
