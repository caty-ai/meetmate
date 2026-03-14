require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const { URL } = require("url");
const { WebSocketServer } = require("ws");

const meetRoutes = require("./transport-meet/meet-routes");

const PORT = Number(process.env.PORT || 5005);

function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function bootstrap() {
  await meetRoutes.init({ detectNgrok: true, loadAvatar: true });

  const server = http.createServer((req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      // keep default path
    }

    if (pathname === "/health") {
      writeJson(res, 200, {
        ok: true,
        service: "ai-meet-participant",
        uptime: process.uptime(),
      });
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

    meetWss.handleUpgrade(req, socket, head, (ws) => {
      meetWss.emit("connection", ws, req);
    });
  });

  server.listen(PORT, () => {
    console.log(`🚀  Meet Server started: http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error("❌  Failed to start Meet server:", err);
  process.exit(1);
});
