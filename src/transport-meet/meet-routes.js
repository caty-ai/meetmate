const { WebSocket } = require("ws");
const { createClient, AgentEvents } = require("@deepgram/sdk");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("querystring");

const {
  getPipelineConfig,
  SAMPLE_RATE,
  TTS_PROVIDER,
  loadConfig,
} = require("../config");
const { createPipeline } = require("../pipeline");
const { warmUpGatewaySession, warmUpMultipleAgents } = require("../gateway-warmup");
const { SessionLifecycle } = require("../session-events");
const { SlackNotifier } = require("../slack-notifier");
const { summarizeConversation } = require("../summarizer");
const { resolveAgentProfile, AgentNotFoundError } = require("../agent-profile");

const ATTENDEE_API_BASE_URL = process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev";
const ATTENDEE_TIMEOUT_MS = Number(process.env.ATTENDEE_TIMEOUT_MS || 15_000);
const ATTENDEE_RETRY_ATTEMPTS = Number(process.env.ATTENDEE_RETRY_ATTEMPTS || 3);
const ATTENDEE_RETRY_BASE_MS = Number(process.env.ATTENDEE_RETRY_BASE_MS || 800);
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 1_000_000);
const SESSION_GRACE_CLOSE_MS = Number(process.env.SESSION_GRACE_CLOSE_MS || 15_000);
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);
const ECHO_GATE_CLOSED_BYPASS = String(process.env.ECHO_GATE_CLOSED_BYPASS || "false").toLowerCase() === "true";
const JOIN_SHARED_TOKEN = process.env.JOIN_SHARED_TOKEN || "";
const WS_SHARED_TOKEN = process.env.WS_SHARED_TOKEN || "";

const MEETING_URL_RE = /^https:\/\/(meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/(j|my)\/[a-zA-Z0-9?=&._%-]+)(?:\?.*)?$/i;
const CONVERSATION_MODES = new Set(["one_to_one", "group"]);

const _configJson = loadConfig();
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const ATTENDEE_API_KEY = _configJson?.attendee?.apiKey || process.env.ATTENDEE_API_KEY;

// Single-agent mode: resolve profile once at startup from config.json
let _agentProfile = null;
try {
  _agentProfile = resolveAgentProfile();
} catch { /* will fail later with clear error */ }
const FIXED_AGENT_ID = _agentProfile?.agentId || null;

const FALLBACK_BOT_IMAGE_URL = process.env.BOT_IMAGE_URL || null;

function getBotImageConfig() {
  if (_agentProfile) {
    const localPath = _agentProfile.avatarPath || path.join(__dirname, "..", "..", "assets", "avatar.png");
    return {
      path: localPath,
      url: _agentProfile.avatarUrl || FALLBACK_BOT_IMAGE_URL,
    };
  }
  return {
    path: path.join(__dirname, "..", "..", "assets", "avatar.png"),
    url: FALLBACK_BOT_IMAGE_URL,
  };
}

let botImageData = null;
let detectedNgrokUrl = "";
let initialized = false;
let ngrokDetectionStarted = false;
let botImageLoadStarted = false;

const meetingSessions = new Map();
const activeConnections = new Map();
const meetLifecycles = new Map();
const sessionBotIds = new Map(); // sessionId → { botId, attendeeKey }
const leavingSessionIds = new Set(); // sessions that have been requested to leave (reject reconnections)

let meetSlackNotifier = null;

function getMeetSlackNotifier() {
  if (!meetSlackNotifier) {
    const notifyEnabled = String(process.env.SLACK_NOTIFY_ENABLED || "true").toLowerCase() !== "false";

    // Read notification config from config.json (new DM-first architecture)
    const slackConfig = _configJson?.slack || {};
    const notifications = slackConfig.notifications || {};

    // Notification target: "dm" (default) or "channel"
    const notifyTarget = notifications.target || "dm";
    const dmUserId = notifications.dmUserId || "";

    // Channel mode fallback (legacy env vars + config.json)
    const fallback = slackConfig.notifyChannel || process.env.SLACK_NOTIFY_CHANNEL || "";
    const summaryChannel = slackConfig.summaryChannel || process.env.SLACK_SUMMARY_CHANNEL || fallback;
    const statusChannel = slackConfig.statusChannel || process.env.SLACK_STATUS_CHANNEL || summaryChannel || fallback;

    // Per-agent Slack bot token: ${AGENT_ID}_SLACK_BOT_TOKEN → config.json → SLACK_BOT_TOKEN
    const agentIdForToken = FIXED_AGENT_ID || "unknown";
    const agentSlackToken =
      process.env[`${agentIdForToken.toUpperCase()}_SLACK_BOT_TOKEN`]
      || slackConfig.botToken
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

      await postMeetFullTranscript(notifier, lifecycle);
    } catch (err) {
      console.error("⚠️  Meetサマリー生成/投稿失敗:", err.message);
    }
  }

  // LCM ingest — capture conversation into Lossless Claw after bot has left the meeting.
  // Runs in the background cleanup phase; does not block exit experience.
  await sendLcmIngest(lifecycle);

  meetLifecycles.delete(lifecycle.sessionId);
}

/**
 * Send [[[lcm:ingest]]] tag to Gateway via Chat Completions API.
 * Uses the conversation log from the lifecycle to build messages,
 * then fires a minimal request (max_tokens=1) so Gateway's afterTurn()
 * triggers LCM ingest on the existing session.
 *
 * Non-fatal: failure is logged but does not affect session cleanup.
 */
// No hard timeout — Gateway processing time scales with conversation length.
// This runs in background cleanup after bot has already left, so no UX impact.
// Success/failure is logged for monitoring.
const _lcmIngestedSessions = new Map(); // idempotency guard — key: "agentId:meetingId" → Set of session IDs

async function sendLcmIngest(lifecycle) {
  const sid = lifecycle.sessionId;
  // Resolve agent ID for LCM key
  const agentIds = lifecycle._meta?.agentIds;
  const agentId = (Array.isArray(agentIds) && agentIds.length > 0 ? agentIds[0] : (FIXED_AGENT_ID || "unknown")).toLowerCase();
  const lcmKey = `${agentId}:${sid}`;

  if (_lcmIngestedSessions.has(lcmKey)) {
    console.log(`⏭️  LCM ingest skipped — already ingested for ${lcmKey}`);
    return;
  }
  _lcmIngestedSessions.set(lcmKey, true);

  // Try to resolve agent-specific gateway credentials
  let openclawUrl = process.env.OPENCLAW_GATEWAY_URL;
  let openclawToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (_agentProfile) {
    if (_agentProfile.gatewayUrl) openclawUrl = _agentProfile.gatewayUrl;
    if (_agentProfile.gatewayToken) openclawToken = _agentProfile.gatewayToken;
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

  // Build sessionUser to match the session key used during the meeting.
  const sessionUser = `meet-${sid}-${agentId}`;

  const ingestStart = Date.now();
  console.log(`📝  Sending LCM ingest (background) — session=${sessionUser}, entries=${log.length}`);

  const ingestMessages = [
    ...log
      .filter(e => (e.role === "user" || e.role === "assistant") && typeof e.content === "string")
      .map(e => ({ role: e.role, content: e.content })),
    { role: "user", content: "[[[lcm:ingest]]] セッション終了。この会話を長期記憶に保存してください。" },
  ];

  // Use stream:false (non-streaming) to avoid known streaming issue with LCM.
  // Same pattern as summarizer.js callOpenClaw().
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
      // No timeout — let Gateway finish regardless of conversation length.
      // Node.js default socket timeout (2min) acts as a safety net.
      req.write(body);
      req.end();
    });
    const elapsed = Date.now() - ingestStart;
    console.log(`✅  LCM ingest completed (background) — session=${sessionUser}, id=${sid}, ${elapsed}ms`);

    // Notify success to Slack log channel for monitoring
    const notifier = getMeetSlackNotifier();
    if (notifier.enabled) {
      notifier.postTranscript(lifecycle, `✅ LCM ingest 完了 (${(elapsed / 1000).toFixed(1)}s)`).catch(() => {});
    }
  } catch (err) {
    const elapsed = Date.now() - ingestStart;
    console.warn(`⚠️  LCM ingest failed (non-fatal, ${elapsed}ms):`, err.message);

    // Notify failure to Slack log channel for monitoring
    const notifier = getMeetSlackNotifier();
    if (notifier.enabled) {
      notifier.postTranscript(lifecycle, `⚠️ LCM ingest 失敗: ${err.message} (${(elapsed / 1000).toFixed(1)}s)`).catch(() => {});
    }
  } finally {
    // Keep in Set intentionally — prevents re-ingest on duplicate events.
    // Set is bounded by active sessions (cleaned on process restart).
  }
}

async function postMeetFullTranscript(notifier, lifecycle) {
  if (!notifier.enabled) return;
  const log = lifecycle._conversationLog;
  if (!log || log.length === 0) return;

  const lines = ["📜 全文ログ", "━━━━━━━━━━━━━━━", ""];
  for (const entry of log) {
    const speaker = entry.role === "assistant" || entry.role === "agent"
      ? `🤖 ${entry.agentId || "AI"}`
      : "👤 参加者";
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

function parseAgentIdsInput(rawValue) {
  const raw = Array.isArray(rawValue) ? rawValue.join(",") : toSafeString(rawValue);
  if (!raw) return [];
  return [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
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

function createAttendeeBot(attendeePayload, agentAttendeeKey) {
  const apiKey = agentAttendeeKey || ATTENDEE_API_KEY;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ATTENDEE_API_BASE_URL,
      port: 443,
      path: "/api/v1/bots",
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
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

async function createAttendeeBotWithRetry(attendeePayload, agentAttendeeKey) {
  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= ATTENDEE_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await createAttendeeBot(attendeePayload, agentAttendeeKey);
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

function saveConversationLog(session) {
  if (!session || !Array.isArray(session.conversationLog) || session.conversationLog.length === 0) {
    return;
  }

  const logDir = path.join(__dirname, "..", "..", "logs");
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
    agents: session.agents || [],
    messages: session.conversationLog,
    conversation_logs: session.conversationLogs || null,
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
    ...session.conversationLog.map((e) => {
      const speaker = e.role === "assistant" || e.role === "agent"
        ? (e.agentId ? `AI(${e.agentId})` : "AI")
        : "参加者";
      return `**${speaker}** (${e.timestamp}):\n${e.content}\n`;
    }),
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

    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Bangkok" });
    const agentLabel = FIXED_AGENT_ID || "unknown";
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
          ? (e.agentId ? `AI(${e.agentId})` : "AI")
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

/**
 * Request bot to leave the meeting via Attendee API (POST /api/v1/bots/{id}/leave).
 * Fire-and-forget — logs result but does not throw.
 */
function requestBotLeave(botId, reason, attendeeKey) {
  const apiKey = attendeeKey || ATTENDEE_API_KEY;
  const body = JSON.stringify({});
  const options = {
    hostname: ATTENDEE_API_BASE_URL,
    port: 443,
    path: `/api/v1/bots/${botId}/leave`,
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      console.log(`🚪  Attendee bot leave (${reason}): ${botId} → ${res.statusCode} ${data.slice(0, 200)}`);
    });
  });
  req.on("error", (err) => console.error(`❌  Attendee bot leave error (${reason}): ${err.message}`));
  req.setTimeout(10_000, () => req.destroy());
  req.write(body);
  req.end();
}

function finalizeSessionIfInactive(sessionId) {
  const active = activeConnections.get(sessionId);
  if (active) return;

  const session = meetingSessions.get(sessionId);
  if (!session) return;

  saveConversationLog(session);
  meetingSessions.delete(sessionId);
  sessionBotIds.delete(sessionId);
  leavingSessionIds.delete(sessionId);
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

function createLegacyAgent(session, turnState, onAudio) {
  const deepgram = createClient(DG_KEY);
  const agent = deepgram.agent();

  agent.on(AgentEvents.Open, () => {
    console.log(`🟢  Deepgram Voice Agent 接続完了 (sid=${session.id})`);

    const config = getPipelineConfig({
      prompt: session.config.prompt,
      greeting: session.config.greeting,
      model: session.config.model,
      voice: session.config.voice,
    }, null, null, _configJson);
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
  agent.on(AgentEvents.AgentThinking, () => console.log(`🤔  [${FIXED_AGENT_ID || "agent"}] thinking… (sid=${session.id})`));
  agent.on(AgentEvents.AgentStartedSpeaking, (s) => {
    turnState.isAgentSpeaking = true;
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`🗣️  [${FIXED_AGENT_ID || "agent"}] speaking (sid=${session.id}):`, s);
  });
  agent.on(AgentEvents.UserStartedSpeaking, () => console.log(`🎙️  User speaking (sid=${session.id})`));
  agent.on(AgentEvents.AgentAudioDone, () => {
    turnState.isAgentSpeaking = false;
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`✅  Audio done (sid=${session.id})`);
  });

  const keepAlive = setInterval(() => {
    try { agent.keepAlive?.(); } catch {
      // no-op
    }
  }, 8_000);
  agent.once(AgentEvents.Close, () => clearInterval(keepAlive));

  return { send: (buf) => agent.send(buf), close: () => agent.finish?.() };
}

function createHandler(session, turnState, onAudio) {
  if (TTS_PROVIDER === "fish-audio") {
    console.log(`🐟  Fish Audio パイプラインモード (sid=${session.id})`);
    const profile = _agentProfile;

    const config = getPipelineConfig({
      prompt: session.config.prompt,
      greeting: session.config.greeting,
      model: session.config.model,
      wakeMode: session.config.wakeMode,
    }, null, profile, _configJson);
    const singleAgentMap = {
      [profile.agentId]: {
        ...profile,
        gatewayUrl: profile.gatewayUrl,
        gatewayToken: profile.gatewayToken,
        voiceId: profile.voiceId,
        model: profile.model,
      },
    };
    const pipeline = createPipeline(session, turnState, onAudio, config, {
      agents: singleAgentMap,
      selectedAgentIds: [profile.agentId],
      defaultAgentId: profile.agentId,
      agentProfile: profile,
      onAgentSwitch: (from, to) => {
        console.log(`🔄  Agent switch: ${from || "none"} → ${to}`);
      },
    });
    return { send: (buf) => pipeline.sendAudio(buf), close: () => pipeline.close(), on: pipeline.on?.bind(pipeline) };
  }

  console.log(`🔊  Deepgram Voice Agent モード (sid=${session.id})`);
  return createLegacyAgent(session, turnState, onAudio);
}

function writePlainResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function validateRequiredEnv() {
  if (!DG_KEY) {
    console.error("❌  DEEPGRAM_API_KEY が設定されていません。.env ファイルを確認してください。");
    process.exit(1);
  }

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

  if (!JOIN_SHARED_TOKEN) {
    console.warn("⚠️  JOIN_SHARED_TOKEN 未設定: /join-meeting はローカルネットワーク公開時に保護されません。");
  }
  if (!WS_SHARED_TOKEN) {
    console.warn("⚠️  WS_SHARED_TOKEN 未設定: WebSocket は sid のみで接続可能です。");
  }
}

function startBotImageLoad() {
  if (botImageLoadStarted) return;
  botImageLoadStarted = true;

  const imgConfig = getBotImageConfig();

  (async () => {
    try {
      if (fs.existsSync(imgConfig.path)) {
        const data = fs.readFileSync(imgConfig.path);
        botImageData = { type: "image/png", data: data.toString("base64") };
        console.log(`🖼️  Bot avatar loaded (local): ${path.basename(imgConfig.path)}`);
        return;
      }
    } catch {
      // fall through
    }

    try {
      const data = await new Promise((resolve, reject) => {
        https.get(imgConfig.url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }).on("error", reject);
      });
      botImageData = { type: "image/png", data: data.toString("base64") };
      const assetsDir = path.join(__dirname, "..", "..", "assets");
      if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(imgConfig.path, data);
      console.log(`🖼️  Bot avatar downloaded and cached: ${path.basename(imgConfig.path)}`);
    } catch (err) {
      console.warn("⚠️  Bot avatar load failed:", err.message);
    }
  })();
}

function startNgrokDetection() {
  if (ngrokDetectionStarted) return;
  ngrokDetectionStarted = true;

  const ngrokDomain = _configJson?.server?.ngrokDomain;
  if (ngrokDomain) {
    detectedNgrokUrl = `wss://${ngrokDomain}`;
    console.log(`🌐  ngrok WSS URL (config.json): ${detectedNgrokUrl}`);
    return;
  }

  (async () => {
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
      // ngrok not running
    }
  })();
}

async function init(options = {}) {
  if (initialized) return;

  // Validate agent profile at startup — fail fast if not configured
  if (_agentProfile) {
    console.log(`[${_agentProfile.agentId}] Agent profile resolved: ${_agentProfile.displayName}`);
  } else {
    console.error(`❌  No agent configured. Create config.json from config.json.example.`);
    process.exit(1);
  }

  validateRequiredEnv();
  if (options.loadAvatar !== false) {
    startBotImageLoad();
  }
  if (options.detectNgrok !== false) {
    startNgrokDetection();
  }

  initialized = true;
}

async function handleHttp(req, res) {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    fs.readFile(path.join(__dirname, "..", "..", "public", "index.html"), (err, data) => {
      if (err) {
        writePlainResponse(res, 500, "Error loading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/info") {
    let publicWsUrl = "";
    const host = req.headers.host || "";
    if (host.includes("ngrok")) {
      publicWsUrl = `wss://${host}`;
    } else if (detectedNgrokUrl) {
      publicWsUrl = detectedNgrokUrl;
    } else if (process.env.PUBLIC_WSS_URL) {
      publicWsUrl = process.env.PUBLIC_WSS_URL;
    }

    // Resolve primary agent info for single-agent mode branding
    let primaryAgent = null;
    try {
      const profile = _agentProfile;
      primaryAgent = {
        id: profile.agentId,
        name: profile.name,
        displayName: profile.displayName,
        greeting: profile.greeting || null,
      };
    } catch {
      // no agent configured
    }

    const info = {
      ttsProvider: TTS_PROVIDER,
      lang: process.env.AGENT_LANG || "ja",
      publicWsUrl,
      ready: true,
      fixedAgentId: FIXED_AGENT_ID || null,
      primaryAgent,
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(info));
    return;
  }

  if (req.method === "GET" && url.pathname === "/agents") {
    let agentList = [];
    try {
      const profile = _agentProfile;
      agentList = [{
        id: profile.agentId,
        name: profile.name,
        displayName: profile.displayName,
        default: true,
        available: true,
        greeting: profile.greeting || "",
        wakeWords: Array.isArray(profile.wakeWords) ? profile.wakeWords : [],
      }];
    } catch {
      // no agent configured
    }
    const response = {
      agents: agentList,
      fixedAgentId: FIXED_AGENT_ID || null,
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(response));
    return;
  }

  // Active session status (for Web UI polling)
  if (req.method === "GET" && url.pathname === "/active-session") {
    const sessions = [];
    for (const [sid, session] of meetingSessions) {
      const lc = meetLifecycles.get(sid);
      sessions.push({
        sessionId: sid,
        meetingUrl: session.meetingUrl,
        startedAt: session.startedAt,
        state: lc?.state || "unknown",
        botId: sessionBotIds.get(sid)?.botId || null,
        hasConnection: activeConnections.has(sid),
        agentIds: session.config?.agentIds || [],
        agentDisplayNames: session.agents || [],
      });
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ active: sessions.length > 0, sessions }));
    return;
  }

  // Leave meeting (force-remove bot via Attendee API)
  if (req.method === "POST" && url.pathname === "/leave-meeting") {
    try {
      const formData = await parseRequestBody(req);
      const targetSid = toSafeString(formData.sessionId);

      if (!targetSid || !meetingSessions.has(targetSid)) {
        // If no specific session, try to leave the first active one
        const firstSid = meetingSessions.keys().next().value;
        if (!firstSid) {
          writePlainResponse(res, 404, "アクティブなセッションがありません。");
          return;
        }
        formData.sessionId = firstSid;
      }

      const sid = toSafeString(formData.sessionId);
      const botInfo = sessionBotIds.get(sid);
      const botId = botInfo?.botId;

      // Close the WebSocket connection
      const conn = activeConnections.get(sid);
      if (conn?.client) {
        try { conn.client.close(1000, "leave_requested"); } catch { /* ignore */ }
      }

      // Mark as leaving to prevent reconnection greeting
      leavingSessionIds.add(sid);

      // Call Attendee API to leave the meeting
      if (botId) {
        requestBotLeave(botId, "web_ui_leave", botInfo?.attendeeKey);
      }

      // Transition lifecycle
      const lc = meetLifecycles.get(sid);
      if (lc && !lc.isTerminal) {
        lc.transition("completed", { reason: "leave_requested" });
      }

      // Immediate cleanup (not scheduled — manual leave should be instant)
      const session = meetingSessions.get(sid);
      if (session) {
        if (session.closeTimer) clearTimeout(session.closeTimer);
        saveConversationLog(session);
        meetingSessions.delete(sid);
        sessionBotIds.delete(sid);
        console.log(`🧹  Session closed (leave): ${sid}`);
      }

      writePlainResponse(res, 200, `退出リクエスト送信: session=${sid}, bot=${botId || "unknown"}`);
      return;
    } catch (err) {
      console.error("❌  /leave-meeting error:", err);
      writePlainResponse(res, 500, `leave-meeting エラー: ${err.message}`);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/join-meeting") {
    try {
      const formData = await parseRequestBody(req);
      const hasExternalToken = req.headers["x-join-token"];
      if (hasExternalToken && !checkJoinAuthorization(req, formData)) {
        writePlainResponse(res, 401, "Unauthorized: invalid join token");
        return;
      }

      const meetingUrl = toSafeString(formData.meetingUrl);
      const wsUrl = toSafeString(formData.wsUrl);
      const conversationMode = toSafeString(formData.conversationMode) || "one_to_one";
      const briefing = toSafeString(formData.briefing) || null;
      const profile = _agentProfile;

      // Single-agent mode: always use config.json agent
      const selectedAgentIds = [profile.agentId];
      const defaultAgentId = profile.agentId;
      const selectedAgentNames = [profile.name];
      console.log(`🔒  Single-agent mode: ${profile.agentId}`);

      // Prevent duplicate joins — block if there's already an active session
      if (meetingSessions.size > 0) {
        const activeSids = [...meetingSessions.keys()];
        writePlainResponse(res, 409, `既にアクティブなセッションがあります（${activeSids.join(", ")}）。退出してから再度参加してください。`);
        return;
      }

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
          agentIds: selectedAgentIds,
          defaultAgentId,
        },
        conversationLog: [],
        // Per-agent conversation logs (scaffolding for future multi-agent log separation)
        conversationLogs: selectedAgentIds.reduce((acc, id) => {
          acc[id] = [];
          return acc;
        }, {}),
        agents: selectedAgentNames,
      };

      meetingSessions.set(sessionId, session);

      const lifecycle = new SessionLifecycle(sessionId, "meet", {
        meetingUrl,
        conversationMode,
        agents: selectedAgentNames,
        agentIds: selectedAgentIds,
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
      }, null, profile, _configJson);
      // Must include the agentId — pipeline.js builds sessionUser as
      // `meet-${sessionId}-${agentId}` (see switchAgent in pipeline.js).
      // Warming the bare `meet-${sessionId}` key left Caty's actual session
      // cold and contributed to first-turn latency / timeout fallbacks.
      warmUpGatewaySession(`meet-${sessionId}-${profile.agentId}`, warmupConfig, briefing);

      const wsWithSession = buildWsUrlWithSession(wsUrl, sessionId);
      console.log("📹  Meeting URL:", meetingUrl);
      console.log("🔗  WebSocket URL:", wsWithSession.replace(/token=[^&]+/, "token=***"));
      console.log("🧾  Session ID:", sessionId);
      console.log("💬  Conversation Mode:", conversationMode, `(${session.config.wakeMode})`);
      if (selectedAgentIds.length > 0) {
        console.log("🤖  Selected agents:", selectedAgentIds.join(", "));
      }

      // Derive default bot name from agent profile or selected agents
      let defaultBotName;
      if (selectedAgentNames.length > 0) {
        defaultBotName = `${selectedAgentNames.join(", ")} (AI)`;
      } else if (_agentProfile) {
        defaultBotName = `${_agentProfile.name || _agentProfile.agentId} (${_agentProfile.displayName || "AI"})`;
      } else {
        defaultBotName = "AI Agent";
      }

      const botPayload = {
        meeting_url: meetingUrl,
        bot_name: toSafeString(formData.botName) || defaultBotName,
        websocket_settings: {
          audio: {
            url: wsWithSession,
            sample_rate: SAMPLE_RATE,
          },
        },
      };

      if (botImageData) {
        botPayload.bot_image = botImageData;
      }

      // Use the agent's Attendee API key if available
      const agentAttendeeKey = profile.attendeeApiKey || null;

      const attendeePayload = JSON.stringify(botPayload);
      const attendeeResult = await createAttendeeBotWithRetry(attendeePayload, agentAttendeeKey);
      if (attendeeResult.statusCode >= 200 && attendeeResult.statusCode < 300) {
        console.log("✅  Bot起動成功:", attendeeResult.body);
        try {
          const botData = JSON.parse(attendeeResult.body);
          if (botData.id) sessionBotIds.set(sessionId, { botId: botData.id, attendeeKey: agentAttendeeKey });
        } catch { /* ignore parse errors */ }
        writePlainResponse(
          res,
          200,
          `成功！Botが30秒以内にMeetに参加し、さらに30秒後にAIが挨拶を開始します。\nsession_id=${sessionId}`
        );
        return;
      }

      console.error("❌  Bot起動失敗:", attendeeResult.statusCode, attendeeResult.body);
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

  writePlainResponse(res, 404, "Not Found");
}

function handleWsConnection(client, req) {
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

  // Reject reconnections for sessions that are leaving
  if (leavingSessionIds.has(sid)) {
    console.log(`🚫  Rejected reconnection for leaving session (sid=${sid})`);
    client.close(1000, "Session is leaving");
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

  const lifecycle = meetLifecycles.get(sid);
  if (lifecycle && lifecycle.state !== "in-progress") {
    lifecycle.transition("in-progress", { remoteAddress: req.socket.remoteAddress });
    getMeetSlackNotifier().postStatus(lifecycle).catch(() => {});
    getMeetSlackNotifier().startElapsedUpdates(lifecycle);
    lifecycle.setConversationLog(session.conversationLog);
  }

  const turnState = {
    isAgentSpeaking: false,
    inputCooldownUntil: 0,
    droppedEchoFrames: 0,
  };

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

  if (handler.on) {
    handler.on("exit_requested", (evt) => {
      console.log(`🚪  Exit requested for session ${sid}: ${evt.trigger}`);

      // Mark as leaving to prevent reconnection greeting
      leavingSessionIds.add(sid);

      // Remove bot from meeting via Attendee API (POST /leave)
      const botInfo = sessionBotIds.get(sid);
      if (botInfo?.botId) {
        requestBotLeave(botInfo.botId, "exit_requested", botInfo.attendeeKey);
      }

      try {
        client.close(1000, "Exit requested by user");
      } catch {
        client.terminate();
      }
    });
  }

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

  client.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.trigger === "realtime_audio.mixed" && parsed?.data?.chunk) {
        const now = Date.now();
        if (turnState.isAgentSpeaking || now < turnState.inputCooldownUntil) {
          // Optional legacy cancel-word bypass; default keeps TTS echo out of STT.
          if (ECHO_GATE_CLOSED_BYPASS && turnState.isAgentSpeaking && turnState.gateState === "CLOSED") {
            const audio = Buffer.from(parsed.data.chunk, "base64");
            handler.send(audio);
            return;
          }
          turnState.droppedEchoFrames += 1;
          if (turnState.droppedEchoFrames % 50 === 0) {
            console.log(
              `🛡️  Echo gate active (sid=${sid}): dropped ${turnState.droppedEchoFrames} frames `
              + `(isSpeaking=${turnState.isAgentSpeaking}, cooldownLeft=${Math.max(0, turnState.inputCooldownUntil - now)}ms)`
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

    const lc = meetLifecycles.get(sid);
    if (lc && !lc.isTerminal) {
      lc.transition("completed", { reason: "ws_close" });
    }

    scheduleFinalizeSession(sid);
  });
}

module.exports = {
  init,
  handleHttp,
  handleWsConnection,
};
