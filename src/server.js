const startup = require("./settings/bootstrap").captureStartup();

const crypto = require("node:crypto");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const { WebSocketServer } = require("ws");
const { readConfigState } = require("./settings/store");
const { getEffectiveValue, initializeRuntime, getStatus, setServerPort } = require("./settings/resolver");
const { warnLegacyClass2 } = require("./settings/class2-migration");
const { createSettingsHandler } = require("./settings/routes");
const adapterRegistry = require("./adapter-registry");

let initialSettingsState;
try {
  initialSettingsState = readConfigState(startup.configPath);
} catch (error) {
  const fingerprint = `read-error:${String(error.code || "unknown")}`;
  initialSettingsState = {
    exists: true,
    valid: false,
    bytes: null,
    parsed: null,
    revision: crypto.createHash("sha256").update(fingerprint).digest("hex"),
    fingerprint,
  };
  console.warn("Settings config could not be read; continuing in setup mode.");
}
initializeRuntime({ state: initialSettingsState, startup });
if (initialSettingsState.valid) warnLegacyClass2(initialSettingsState.parsed);

const meetRoutes = require("./transport-meet/meet-routes");
const { createDiscordAdapter } = require("./transport-discord");
const { handleCalibrate, handleCalibrateWs } = require("./wake-calibrate/calibrate-routes");
const { loadConfig } = require("./config");
const { resolveAgentProfile } = require("./agent-profile");

const config = loadConfig();
const PORT = getEffectiveValue("server_port") || 5005;
const pkg = (() => {
  try {
    return require("../package.json");
  } catch {
    return { version: "unknown" };
  }
})();
const INSTANCE_ID = crypto.randomUUID();

function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function bootstrap() {
  await meetRoutes.init({ detectNgrok: true, loadAvatar: true, instanceId: INSTANCE_ID });

  try {
    adapterRegistry.register(createDiscordAdapter({
      writePlainResponse: meetRoutes.writePlainResponse,
      getDiscordConfig: () => null,
    }));
  } catch (error) {
    console.warn(`Discord adapter bootstrap skipped: ${error.message}`);
  }

  let server;
  const handleSettings = createSettingsHandler({ port: () => server?.address()?.port || PORT });
  server = http.createServer(async (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      // keep default path
    }

    if (await handleSettings(req, res)) return;

    if (pathname === "/health") {
      let agentId = "unknown";
      try { agentId = resolveAgentProfile()?.agentId || agentId; } catch { /* ignore */ }
      const settingsStatus = getStatus();
      writeJson(res, 200, {
        ok: true,
        service: config?.agent?.id || "ai-meet-participant",
        agentId,
        version: pkg.version,
        instanceId: INSTANCE_ID,
        uptime: process.uptime(),
        setupMode: settingsStatus.setupMode,
        meetingReady: settingsStatus.meetingReady,
        settingsIssues: settingsStatus.issues,
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

    const adapter = adapterRegistry.match(pathname);
    if (adapter) {
      await adapter.handleHttp(req, res, new URL(req.url || "/", "http://localhost"));
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

    if (pathname === "/settings" || pathname === "/api/settings" || pathname.startsWith("/api/settings/")
        || pathname.startsWith("/settings-assets/")) {
      socket.destroy();
      return;
    }

    if (pathname === "/calibrate/stream") {
      calibrateWss.handleUpgrade(req, socket, head, (ws) => {
        calibrateWss.emit("connection", ws, req);
      });
      return;
    }

    const adapter = adapterRegistry.match(pathname);
    if (adapter) {
      if (typeof adapter.handleUpgrade === "function") {
        adapter.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
      return;
    }

    meetWss.handleUpgrade(req, socket, head, (ws) => {
      meetWss.emit("connection", ws, req);
    });
  });

  server.listen(PORT, () => {
    const address = server.address();
    setServerPort(address.port);
    console.log(`Settings UI: http://localhost:${address.port}/settings`);
    meetRoutes.startReadinessBootstrap();
  });
}

bootstrap().catch((err) => {
  console.error("❌  Failed to start Meet server:", err);
  process.exit(1);
});
