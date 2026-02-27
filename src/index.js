// index.js — AI Meet Participant Bridge Server
// Routes audio between Attendee (Google Meet bot) and Deepgram Voice Agent API

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { WebSocketServer } = require("ws");
const { createClient, AgentEvents } = require("@deepgram/sdk");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { parse } = require("querystring");
const { buildAgentConfig, SAMPLE_RATE } = require("./config");

const PORT = process.env.PORT || 5005;
const ATTENDEE_API_BASE_URL = process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev";

// Conversation log for memory integration (Phase 2)
let conversationLog = [];

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

// ── Agent configuration (from form or defaults) ────────────────────
let agentConfig = {
  prompt: null,   // null = use default from config.js
  greeting: null,
  model: null,
  voice: null,
};

// ── Create Deepgram Voice Agent ────────────────────────────────────
function createAgent(onAudio) {
  const deepgram = createClient(DG_KEY);
  const agent = deepgram.agent();

  agent.on(AgentEvents.Open, () => {
    console.log("🟢  Deepgram Voice Agent 接続完了");

    // Configure with our settings
    const config = buildAgentConfig({
      prompt: agentConfig.prompt,
      greeting: agentConfig.greeting,
      model: agentConfig.model,
      voice: agentConfig.voice,
    });
    agent.configure(config);
  });

  // Route audio back to Attendee
  agent.on(AgentEvents.Audio, (raw) => onAudio(Buffer.from(raw)));

  // Logging
  agent.on(AgentEvents.Error, (err) => console.error("❌  Deepgram error:", err));
  agent.on(AgentEvents.Close, () => {
    console.log("🔴  Deepgram Voice Agent 切断");
    saveConversationLog();
  });
  agent.on(AgentEvents.Welcome, (w) => console.log("🙌  Agent ready:", w));

  // Conversation tracking (for Phase 2 memory integration)
  agent.on(AgentEvents.ConversationText, (m) => {
    const entry = {
      timestamp: new Date().toISOString(),
      role: m.role,
      content: m.content,
    };
    conversationLog.push(entry);
    console.log(`💬  [${m.role}] ${m.content}`);
  });

  agent.on(AgentEvents.AgentThinking, (t) =>
    console.log("🤔  Caty thinking…", t)
  );
  agent.on(AgentEvents.AgentStartedSpeaking, (s) =>
    console.log("🗣️  Caty speaking:", s)
  );
  agent.on(AgentEvents.UserStartedSpeaking, (u) =>
    console.log("🎙️  User speaking:", u)
  );
  agent.on(AgentEvents.AgentAudioDone, (d) =>
    console.log("✅  Audio done:", d)
  );

  // Keep-alive
  const keepAlive = setInterval(() => agent.keepAlive?.(), 8_000);
  agent.once(AgentEvents.Close, () => clearInterval(keepAlive));

  return agent;
}

// ── Save conversation log (Phase 2 prep) ───────────────────────────
function saveConversationLog() {
  if (conversationLog.length === 0) return;

  const logDir = path.join(__dirname, "..", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logDir, `meeting-${timestamp}.json`);

  fs.writeFileSync(logFile, JSON.stringify(conversationLog, null, 2));
  console.log(`📝  会話ログ保存: ${logFile}`);

  // Also save as markdown for easy reading
  const mdFile = path.join(logDir, `meeting-${timestamp}.md`);
  const mdContent = [
    `# Meeting Log — ${new Date().toLocaleString("ja-JP")}`,
    "",
    ...conversationLog.map(
      (e) => `**${e.role === "agent" ? "Caty" : "参加者"}** (${e.timestamp}):\n${e.content}\n`
    ),
  ].join("\n");
  fs.writeFileSync(mdFile, mdContent);
  console.log(`📝  会話ログ(MD)保存: ${mdFile}`);

  conversationLog = [];
}

// ── HTTP + WebSocket Server ────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    fs.readFile(path.join(__dirname, "..", "public", "index.html"), (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error loading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else if (req.method === "POST" && req.url === "/join-meeting") {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      const formData = parse(body);

      // Update agent config from form (optional overrides)
      if (formData.prompt) agentConfig.prompt = formData.prompt;
      if (formData.greeting) agentConfig.greeting = formData.greeting;
      if (formData.model) agentConfig.model = formData.model;
      if (formData.voice) agentConfig.voice = formData.voice;

      console.log("📹  Meeting URL:", formData.meetingUrl);
      console.log("🔗  WebSocket URL:", formData.wsUrl);

      // Reset conversation log for new meeting
      conversationLog = [];

      // Call Attendee API to launch bot
      const attendeeData = JSON.stringify({
        meeting_url: formData.meetingUrl,
        bot_name: formData.botName || "Caty (ケイティ)",
        websocket_settings: {
          audio: {
            url: formData.wsUrl,
            sample_rate: SAMPLE_RATE,
          },
        },
      });

      const options = {
        hostname: ATTENDEE_API_BASE_URL,
        port: 443,
        path: "/api/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Token ${ATTENDEE_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(attendeeData),
        },
      };

      const attendeeReq = https.request(options, (attendeeRes) => {
        let responseData = "";
        attendeeRes.on("data", (chunk) => (responseData += chunk));
        attendeeRes.on("end", () => {
          if (attendeeRes.statusCode >= 200 && attendeeRes.statusCode < 300) {
            console.log("✅  Bot起動成功:", responseData);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(
              "成功！Botが30秒以内にMeetに参加し、さらに30秒後にCatyが挨拶を開始します。"
            );
          } else {
            console.error("❌  Bot起動失敗:", attendeeRes.statusCode, responseData);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Bot起動エラー: ${attendeeRes.statusCode} - ${responseData}`);
          }
        });
      });

      attendeeReq.on("error", (error) => {
        console.error("❌  API リクエストエラー:", error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`APIリクエストエラー: ${error.message}`);
      });

      attendeeReq.write(attendeeData);
      attendeeReq.end();
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });
server.listen(PORT, () => {
  console.log(`🚀  AI Meet Participant Bridge Server 起動: http://localhost:${PORT}`);
  console.log(`🐱  Caty（ケイティ）がMeetで待機中…`);
});

wss.on("connection", (client, req) => {
  console.log(`⇦  Attendee Bot 接続: ${req.socket.remoteAddress}`);

  // Create Deepgram agent; wire response audio → Attendee
  const agent = createAgent((buffer) => {
    const payload = {
      trigger: "realtime_audio.bot_output",
      data: { chunk: buffer.toString("base64"), sample_rate: SAMPLE_RATE },
    };
    client.send(JSON.stringify(payload));
  });

  // Attendee → Deepgram: forward meeting audio
  client.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.trigger === "realtime_audio.mixed" && parsed?.data?.chunk) {
        const audio = Buffer.from(parsed.data.chunk, "base64");
        agent.send(audio);
      } else {
        console.log("📩  Non-audio message:", parsed.trigger || parsed);
      }
    } catch (err) {
      console.error("Bad WS message:", err);
    }
  });

  client.on("close", () => {
    console.log("⇨  Attendee Bot 切断");
    agent.finish?.();
  });
});
