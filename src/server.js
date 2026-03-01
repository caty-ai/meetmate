require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const { URL } = require("url");
const { WebSocketServer } = require("ws");

const meetRoutes = require("./transport-meet/meet-routes");
const twilioRoutes = require("./transport-twilio/twilio-routes");

const PORT = Number(process.env.PORT || 5005);

function isTwilioHttpPath(pathname) {
  return pathname === "/health"
    || pathname === "/call-me"
    || pathname.startsWith("/twilio/");
}

function isTwilioWsPath(pathname) {
  return pathname.startsWith("/twilio/stream/");
}

async function bootstrap() {
  await meetRoutes.init({ detectNgrok: true, loadAvatar: true });
  await twilioRoutes.init({ port: PORT });

  const server = http.createServer((req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      // keep default path
    }

    if (isTwilioHttpPath(pathname)) {
      twilioRoutes.handleHttp(req, res);
      return;
    }

    meetRoutes.handleHttp(req, res);
  });

  const meetWss = new WebSocketServer({ noServer: true });
  meetWss.on("connection", (ws, req) => {
    meetRoutes.handleWsConnection(ws, req);
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (isTwilioWsPath(pathname)) {
      twilioRoutes.handleUpgrade(req, socket, head);
      return;
    }

    meetWss.handleUpgrade(req, socket, head, (ws) => {
      meetWss.emit("connection", ws, req);
    });
  });

  server.listen(PORT, () => {
    console.log(`🚀  Unified Meet + Twilio Server started: http://localhost:${PORT}`);
    console.log("📡  HTTP routing: /twilio/*,/call-me,/health -> Twilio, others -> Meet");
    console.log("🔌  WS routing: /twilio/stream/* -> Twilio, others -> Meet");
  });
}

bootstrap().catch((err) => {
  console.error("❌  Failed to start unified server:", err);
  process.exit(1);
});
