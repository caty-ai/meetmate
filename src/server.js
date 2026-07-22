const path = require("path");
const { envPath } = require("./paths");
require("dotenv").config({ path: envPath() });

const http = require("http");
const { URL } = require("url");
const { WebSocketServer } = require("ws");

const meetRoutes = require("./transport-meet/meet-routes");
const { handleCalibrate, handleCalibrateWs } = require("./wake-calibrate/calibrate-routes");
const { loadConfig } = require("./config");
const { resolveAgentProfile } = require("./agent-profile");

const config = loadConfig();
const PORT = Number(config?.server?.port || process.env.PORT || 5005);
const pkg = (() => {
  try {
    return require("../package.json");
  } catch {
    return { version: "unknown" };
  }
})();

function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function bootstrap() {
  // AGENT_ID vs config.agent.id mismatch check
  if (process.env.AGENT_ID && config?.agent?.id &&
      process.env.AGENT_ID !== config.agent.id) {
    console.error(`❌  AGENT_ID mismatch: env="${process.env.AGENT_ID}" vs config="${config.agent.id}"`);
    process.exit(1);
  }

  await meetRoutes.init({ detectNgrok: true, loadAvatar: true });

  const server = http.createServer((req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      // keep default path
    }

    if (pathname === "/health") {
      let agentId = "unknown";
      try { agentId = resolveAgentProfile()?.agentId || agentId; } catch { /* ignore */ }
      writeJson(res, 200, {
        ok: true,
        service: config?.agent?.id || "ai-meet-participant",
        agentId,
        version: pkg.version,
        uptime: process.uptime(),
      });
      return;
    }

    if (
      pathname === "/calibrate" ||
      pathname === "/calibrate/status" ||
      (pathname === "/calibrate/apply" && req.method === "POST")
    ) {
      handleCalibrate(req, res);
      return;
    }

    meetRoutes.handleHttp(req, res);
  });

  const meetWss = new WebSocketServer({ noServer: true });
  meetWss.on("connection", (ws, req) => {
    meetRoutes.handleWsConnection(ws, req);
  });

  const calibrateWss = new WebSocketServer({ noServer: true });
  calibrateWss.on("connection", (ws, req) => {
    handleCalibrateWs(ws, req);
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === "/calibrate/stream") {
      calibrateWss.handleUpgrade(req, socket, head, (ws) => {
        calibrateWss.emit("connection", ws, req);
      });
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
