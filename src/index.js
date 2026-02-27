// index.js — AI Meet Participant Bridge Server
// Routes audio between Attendee (Google Meet bot) and Deepgram Voice Agent API

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { WebSocketServer, WebSocket } = require("ws");
const { createClient, AgentEvents } = require("@deepgram/sdk");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("querystring");
const { buildAgentConfig, SAMPLE_RATE } = require("./config");

const PORT = Number(process.env.PORT || 5005);
const ATTENDEE_API_BASE_URL = process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev";
const ATTENDEE_TIMEOUT_MS = Number(process.env.ATTENDEE_TIMEOUT_MS || 15_000);
const ATTENDEE_RETRY_ATTEMPTS = Number(process.env.ATTENDEE_RETRY_ATTEMPTS || 3);
const ATTENDEE_RETRY_BASE_MS = Number(process.env.ATTENDEE_RETRY_BASE_MS || 800);
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 1_000_000);
const SESSION_GRACE_CLOSE_MS = Number(process.env.SESSION_GRACE_CLOSE_MS || 15_000);
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);
const JOIN_SHARED_TOKEN = process.env.JOIN_SHARED_TOKEN || "";
const WS_SHARED_TOKEN = process.env.WS_SHARED_TOKEN || "";

const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?.*)?$/i;

// ── Validate API keys ──────────────────────────────────────────────
const DG_KEY = process.env.DEEPGRAM_API_KEY;
if (!DG_KEY) {
  console.error("❌  DEEPGRAM_API_KEY が設定されていません。.env ファイルを確認してください。");
  process.exit(1);
}

const ATTENDEE_API_KEY = process.env.ATTENDEE_API_KEY;
if (!ATTENDEE_API_KEY) {
  console.error("❌  ATTENDEE_API_KEY が設定されていません。.env ファイルを確認してください。");
  process.exit(1);
}

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
 *   config: {prompt: string|null, greeting: string|null, model: string|null, voice: string|null},
 *   conversationLog: Array<{timestamp:string, role:string, content:string}>,
 *   closeTimer?: NodeJS.Timeout
 * }>} */
const meetingSessions = new Map();

/** @type {Map<string, {client: import("ws").WebSocket, agent: any}>} */
const activeConnections = new Map();

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
    "",
    ...session.conversationLog.map((e) => `**${e.role === "assistant" || e.role === "agent" ? "Caty" : "参加者"}** (${e.timestamp}):\n${e.content}\n`),
  ].join("\n");
  fs.writeFileSync(mdPath, mdContent);
  console.log(`📝  会話ログ(MD)保存: ${mdPath}`);

  // ── Phase 2: Append summary to OpenClaw daily memory ───────────
  appendToMemory(session);
}

/**
 * Append a meeting summary to ~/.openclaw/workspace/memory/YYYY-MM-DD.md
 * This gives the "real" Caty (Slack/OpenClaw) memory of what happened in Meet.
 */
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
    const catyMsgs = session.conversationLog
      .filter((e) => e.role === "assistant" || e.role === "agent")
      .map((e) => e.content)
      .slice(0, 10);

    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Bangkok" });
    const summary = [
      "",
      `## 🎙️ Google Meet セッション (${now})`,
      `- Session ID: ${session.id}`,
      `- 発話数: ${msgCount}`,
      "",
      "### 会話ハイライト",
      ...userMsgs.slice(0, 5).map((m) => `- 参加者: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      ...catyMsgs.slice(0, 5).map((m) => `- Caty: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      "",
    ].join("\n");

    fs.appendFileSync(memoryFile, summary);
    console.log(`🧠  メモリに追記: ${memoryFile}`);
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

// ── Create Deepgram Voice Agent ────────────────────────────────────
function createAgent(session, turnState, onAudio) {
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

  // Route audio back to Attendee
  agent.on(AgentEvents.Audio, (raw) => onAudio(Buffer.from(raw)));

  // Logging
  agent.on(AgentEvents.Error, (err) => console.error(`❌  Deepgram error (sid=${session.id}):`, err));
  agent.on(AgentEvents.Close, () => {
    turnState.isAgentSpeaking = false;
    turnState.inputCooldownUntil = 0;
    console.log(`🔴  Deepgram Voice Agent 切断 (sid=${session.id})`);
  });
  agent.on(AgentEvents.Welcome, (w) => console.log(`🙌  Agent ready (sid=${session.id}):`, w));

  // Conversation tracking (for Phase 2 memory integration)
  agent.on(AgentEvents.ConversationText, (m) => {
    const entry = {
      timestamp: new Date().toISOString(),
      role: m.role,
      content: m.content,
    };
    session.conversationLog.push(entry);
    console.log(`💬  [${m.role}] ${m.content}`);
  });

  agent.on(AgentEvents.AgentThinking, (t) => console.log(`🤔  Caty thinking… (sid=${session.id})`, t));
  agent.on(AgentEvents.AgentStartedSpeaking, (s) => {
    turnState.isAgentSpeaking = true;
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`🗣️  Caty speaking (sid=${session.id}):`, s);
  });
  agent.on(AgentEvents.UserStartedSpeaking, (u) => console.log(`🎙️  User speaking (sid=${session.id}):`, u));
  agent.on(AgentEvents.AgentAudioDone, (d) => {
    turnState.isAgentSpeaking = false;
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`✅  Audio done (sid=${session.id}):`, d);
  });

  // Keep-alive
  const keepAlive = setInterval(() => {
    try {
      agent.keepAlive?.();
    } catch (err) {
      console.warn(`⚠️  Deepgram keepAlive failed (sid=${session.id}): ${err.message}`);
    }
  }, 8_000);
  agent.once(AgentEvents.Close, () => clearInterval(keepAlive));

  return agent;
}

function writePlainResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// ── HTTP + WebSocket Server ────────────────────────────────────────
const server = http.createServer(async (req, res) => {
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

  if (req.method === "POST" && req.url === "/join-meeting") {
    try {
      const formData = await parseRequestBody(req);

      if (!checkJoinAuthorization(req, formData)) {
        writePlainResponse(res, 401, "Unauthorized: invalid join token");
        return;
      }

      const meetingUrl = toSafeString(formData.meetingUrl);
      const wsUrl = toSafeString(formData.wsUrl);

      if (!meetingUrl || !wsUrl) {
        writePlainResponse(res, 400, "meetingUrl と wsUrl は必須です。");
        return;
      }

      if (!MEET_URL_RE.test(meetingUrl)) {
        writePlainResponse(res, 400, "meetingUrl が Google Meet URL 形式ではありません。");
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
        },
        conversationLog: [],
      };

      meetingSessions.set(sessionId, session);

      const wsWithSession = buildWsUrlWithSession(wsUrl, sessionId);
      console.log("📹  Meeting URL:", meetingUrl);
      console.log("🔗  WebSocket URL:", wsWithSession.replace(/token=[^&]+/, "token=***"));
      console.log("🧾  Session ID:", sessionId);

      const attendeePayload = JSON.stringify({
        meeting_url: meetingUrl,
        bot_name: toSafeString(formData.botName) || "Caty (ケイティ)",
        websocket_settings: {
          audio: {
            url: wsWithSession,
            sample_rate: SAMPLE_RATE,
          },
        },
      });

      const attendeeResult = await createAttendeeBotWithRetry(attendeePayload);
      if (attendeeResult.statusCode >= 200 && attendeeResult.statusCode < 300) {
        console.log("✅  Bot起動成功:", attendeeResult.body);
        writePlainResponse(
          res,
          200,
          `成功！Botが30秒以内にMeetに参加し、さらに30秒後にCatyが挨拶を開始します。\nsession_id=${sessionId}`
        );
        return;
      }

      console.error("❌  Bot起動失敗:", attendeeResult.statusCode, attendeeResult.body);
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
      previous.agent?.finish?.();
    } catch {
      // no-op
    }
    activeConnections.delete(sid);
  }

  console.log(`⇦  Attendee Bot 接続: ${req.socket.remoteAddress} (sid=${sid})`);

  const turnState = {
    isAgentSpeaking: false,
    inputCooldownUntil: 0,
    droppedEchoFrames: 0,
  };

  // Create Deepgram agent; wire response audio → Attendee
  const agent = createAgent(session, turnState, (buffer) => {
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

  activeConnections.set(sid, { client, agent });

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

  // Attendee → Deepgram: forward meeting audio
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
        agent.send(audio);
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
      agent.finish?.();
    } catch {
      // no-op
    }

    scheduleFinalizeSession(sid);
  });
});

server.listen(PORT, () => {
  console.log(`🚀  AI Meet Participant Bridge Server 起動: http://localhost:${PORT}`);
  console.log("🐱  Caty（ケイティ）がMeetで待機中…");
});
