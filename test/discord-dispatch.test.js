"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const adapterRegistry = require("../src/adapter-registry");
const { createDiscordAdapter } = require("../src/transport-discord");
const { createHttpRoutes } = require("../src/transport-discord/http-routes");

function createRequest({ method = "GET", url = "/api/discord/status", remoteAddress = "127.0.0.1", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.destroy = () => {};
  req.resume = () => { req.resumed = true; };
  return req;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body += Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    },
  };
}

async function runHttp(handler, req, body = null) {
  const res = createResponse();
  const pending = handler(req, res);
  await Promise.resolve();
  if (body != null) req.emit("data", Buffer.from(body));
  req.emit("end");
  await pending;
  return res;
}

test("adapter-registry matches bare discord prefix, rejects /api/discordX, and requires capabilities", async () => {
  adapterRegistry._test.reset();

  assert.throws(
    () => adapterRegistry.register({ prefixes: ["/api/discord"], handleHttp() {} }),
    /capabilities/
  );

  const adapter = adapterRegistry.register({
    transport: "discord",
    prefixes: ["/api/discord"],
    capabilities: {},
    handleHttp() {},
  });

  assert.equal(adapterRegistry.match("/api/discord"), adapter);
  assert.equal(adapterRegistry.match("/api/discord/join"), adapter);
  assert.equal(adapterRegistry.match("/api/discordX"), null);
});

test("adapter-registry derives auth transport from explicit paths and validate-all fallthrough", async () => {
  adapterRegistry._test.reset();
  adapterRegistry.register({
    transport: "discord",
    prefixes: ["/api/discord"],
    capabilities: {},
    handleHttp() {},
  });

  assert.equal(adapterRegistry.deriveTransportForAuth("/health"), null);
  assert.equal(adapterRegistry.deriveTransportForAuth("/calibrate"), null);
  assert.equal(adapterRegistry.deriveTransportForAuth("/calibrate/custom"), null);
  assert.equal(adapterRegistry.deriveTransportForAuth("/calibrateX"), adapterRegistry.AUTH_VALIDATE_ALL);
  assert.equal(adapterRegistry.deriveTransportForAuth("/api/settings"), null);
  assert.equal(adapterRegistry.deriveTransportForAuth("/api/settings/profile"), null);
  assert.equal(adapterRegistry.deriveTransportForAuth("/api/settingsX"), adapterRegistry.AUTH_VALIDATE_ALL);
  assert.equal(adapterRegistry.deriveTransportForAuth("/join-meeting"), "meet");
  assert.equal(adapterRegistry.deriveTransportForAuth("/readiness"), "meet");
  assert.equal(adapterRegistry.deriveTransportForAuth("/realtime"), adapterRegistry.AUTH_VALIDATE_ALL);
  assert.equal(adapterRegistry.deriveTransportForAuth("/api/discord/join"), "discord");
  assert.equal(adapterRegistry.deriveTransportForAuth("/unknown-path"), adapterRegistry.AUTH_VALIDATE_ALL);
});

test("discord http routes conceal non-local and forwarded requests behind the shared plain 404 shape", async () => {
  const handler = createHttpRoutes();

  const remoteDenied = await runHttp(
    handler,
    createRequest({ remoteAddress: "127.0.0.2" })
  );
  assert.equal(remoteDenied.statusCode, 404);
  assert.deepEqual(remoteDenied.headers, { "Content-Type": "text/plain; charset=utf-8" });
  assert.equal(remoteDenied.body, "Not Found");

  const forwardedDenied = await runHttp(
    handler,
    createRequest({ headers: { "x-forwarded-for": "" } })
  );
  assert.equal(forwardedDenied.statusCode, 404);
  assert.deepEqual(forwardedDenied.headers, { "Content-Type": "text/plain; charset=utf-8" });
  assert.equal(forwardedDenied.body, "Not Found");

  const forwardedProtoDenied = await runHttp(
    handler,
    createRequest({ headers: { forwarded: "for=127.0.0.1", "x-forwarded-proto": "https" } })
  );
  assert.equal(forwardedProtoDenied.statusCode, 404);
  assert.equal(forwardedProtoDenied.body, "Not Found");

  for (const request of [
    createRequest({ remoteAddress: "::ffff:10.0.0.1" }),
    createRequest({ headers: { "x-forwarded-host": "public.example" } }),
  ]) {
    const denied = await runHttp(handler, request);
    assert.equal(denied.statusCode, 404);
    assert.deepEqual(denied.headers, { "Content-Type": "text/plain; charset=utf-8" });
    assert.equal(denied.body, "Not Found");
  }
});

test("discord status route stays localhost-only and does not echo secrets or allowlist contents", async () => {
  const adapter = createDiscordAdapter({
    getDiscordConfig() {
      return {
        token: "discord.secret.value",
        guildAllowlist: ["11111111111111111"],
      };
    },
  });

  const local = await runHttp(
    adapter.handleHttp,
    createRequest({ method: "GET", url: "/api/discord/status" })
  );

  assert.equal(local.statusCode, 200);
  const body = JSON.parse(local.body);
  assert.equal(body.configured, true);
  assert.equal(body.transport, "discord");
  assert.equal(JSON.stringify(body).includes("discord.secret.value"), false);
  assert.equal(JSON.stringify(body).includes("11111111111111111"), false);
});

test("discord routes enforce exact methods and keep setup refusal explicit after localhost gate", async () => {
  const adapter = createDiscordAdapter();

  const wrongMethod = await runHttp(
    adapter.handleHttp,
    createRequest({ method: "GET", url: "/api/discord/join" })
  );
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(JSON.parse(wrongMethod.body).code, "METHOD_NOT_ALLOWED");

  const joinRefused = await runHttp(
    adapter.handleHttp,
    createRequest({ method: "POST", url: "/api/discord/join" }),
    JSON.stringify({ guildId: "11111111111111111", channelId: "22222222222222222" })
  );
  assert.equal(joinRefused.statusCode, 503);
  assert.equal(JSON.parse(joinRefused.body).code, "DISCORD_SETUP_REQUIRED");

  const statusFailure = createHttpRoutes({
    getSessionStatus() { throw new Error("status failed"); },
  });
  const failedStatus = await runHttp(
    statusFailure,
    createRequest({ method: "GET", url: "/api/discord/status" })
  );
  assert.equal(failedStatus.statusCode, 500);
  assert.deepEqual(JSON.parse(failedStatus.body), { ok: false, code: "DISCORD_INTERNAL_ERROR" });
});

test("server destroys websocket upgrades for adapter prefixes without a Discord upgrade handler", () => {
  const probe = runServerProbe("upgrade");
  assert.equal(probe.status, 0, probe.stderr);
  const result = parseProbe(probe.stdout, "UPGRADE_SENTINEL");
  assert.deepEqual(result, { destroyed: true, upgradeHandled: false });
});

test("server concealed Discord rejection byte-matches its real unknown-path fallthrough and catches adapter failures", () => {
  const concealedProbe = runServerProbe("conceal");
  assert.equal(concealedProbe.status, 0, concealedProbe.stderr);
  const concealed = parseProbe(concealedProbe.stdout, "CONCEAL_SENTINEL");
  assert.deepEqual(concealed.discord, concealed.unknown);
  assert.deepEqual(concealed.discord, {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: "Not Found",
  });

  const errorProbe = runServerProbe("adapter-error");
  assert.equal(errorProbe.status, 0, errorProbe.stderr);
  const failure = parseProbe(errorProbe.stdout, "ADAPTER_ERROR_SENTINEL");
  assert.equal(failure.status, 500);
  assert.equal(JSON.parse(failure.body).code, "ADAPTER_INTERNAL_ERROR");
});

test("server health endpoint keeps the pinned JSON envelope", () => {
  const probe = runServerProbe("health");
  assert.equal(probe.status, 0, probe.stderr);
  const result = parseProbe(probe.stdout, "HEALTH_SENTINEL");

  assert.equal(result.status, 200, result.body);
  assert.equal(getHeader(result.headers, "Content-Type"), "application/json");
  const contentLength = getHeader(result.headers, "Content-Length");
  assert.match(String(contentLength), /^\d+$/);
  assert.equal(Number(contentLength), Buffer.byteLength(result.body));

  const body = JSON.parse(result.body);
  assert.deepEqual(Object.keys(body), [
    "ok",
    "service",
    "agentId",
    "version",
    "instanceId",
    "uptime",
    "setupMode",
    "meetingReady",
    "settingsIssues",
  ]);
  assert.equal(body.ok, true);
  assert.equal(body.service, "ai-meet-participant");
  assert.equal(body.agentId, "caty");
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.instanceId, "string");
  assert.equal(typeof body.uptime, "number");
  assert.equal(body.setupMode, true);
  assert.equal(body.meetingReady, false);
  assert.deepEqual(body.settingsIssues, [{ code: "TEST_ISSUE" }]);
  assert.match(result.transportProbe, /^(ephemeral-port|listen-eperm-fallback)$/);
});

function parseProbe(stdout, sentinel) {
  const match = stdout.match(new RegExp(`${sentinel}=(\\{.*\\})`));
  assert.ok(match, stdout);
  return JSON.parse(match[1]);
}

function getHeader(headers, expectedName) {
  const expected = expectedName.toLowerCase();
  const entry = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === expected);
  return entry?.[1];
}

function runServerProbe(mode) {
  const root = path.join(__dirname, "..");
  const src = path.join(root, "src");
  const serverPath = path.join(src, "server.js");
  const meetRoutesPath = path.join(src, "transport-meet", "meet-routes.js");
  const settingsBootstrapPath = path.join(src, "settings", "bootstrap.js");
  const settingsStorePath = path.join(src, "settings", "store.js");
  const settingsResolverPath = path.join(src, "settings", "resolver.js");
  const settingsClass2Path = path.join(src, "settings", "class2-migration.js");
  const settingsRoutesPath = path.join(src, "settings", "routes.js");
  const transportDiscordPath = path.join(src, "transport-discord", "index.js");
  const wakeCalibratePath = path.join(src, "wake-calibrate", "calibrate-routes.js");
  const configPath = path.join(src, "config.js");
  const agentProfilePath = path.join(src, "agent-profile.js");

  const script = String.raw`
    const path = require("node:path");
    const Module = require("node:module");
    const realHttp = require("node:http");
    const { EventEmitter } = require("node:events");

    function cacheEntry(filename, exports) {
      return { id: filename, filename, loaded: true, exports };
    }

    const mode = ${JSON.stringify(mode)};
    const serverPath = ${JSON.stringify(serverPath)};
    const meetRoutesPath = ${JSON.stringify(meetRoutesPath)};
    const settingsBootstrapPath = ${JSON.stringify(settingsBootstrapPath)};
    const settingsStorePath = ${JSON.stringify(settingsStorePath)};
    const settingsResolverPath = ${JSON.stringify(settingsResolverPath)};
    const settingsClass2Path = ${JSON.stringify(settingsClass2Path)};
    const settingsRoutesPath = ${JSON.stringify(settingsRoutesPath)};
    const transportDiscordPath = ${JSON.stringify(transportDiscordPath)};
    const wakeCalibratePath = ${JSON.stringify(wakeCalibratePath)};
    const configPath = ${JSON.stringify(configPath)};
    const agentProfilePath = ${JSON.stringify(agentProfilePath)};

    require.cache[meetRoutesPath] = cacheEntry(meetRoutesPath, {
      init: async () => {},
      handleHttp(_req, res) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
      },
      handleWsConnection() {
        globalThis.__upgradeHandled = true;
      },
      startReadinessBootstrap() {},
      writePlainResponse(res, status, text) {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(text);
      },
    });
    require.cache[settingsBootstrapPath] = cacheEntry(settingsBootstrapPath, {
      captureStartup() {
        return { configPath: path.join(process.cwd(), "config.json") };
      },
    });
    require.cache[settingsStorePath] = cacheEntry(settingsStorePath, {
      readConfigState() {
        return {
          exists: false,
          valid: false,
          bytes: null,
          parsed: null,
          revision: "test-revision",
          fingerprint: "missing",
        };
      },
    });
    require.cache[settingsResolverPath] = cacheEntry(settingsResolverPath, {
      getEffectiveValue(key) {
        return key === "server_port" ? 0 : null;
      },
      initializeRuntime() {},
      getStatus() {
        return {
          setupMode: true,
          meetingReady: false,
          issues: [{ code: "TEST_ISSUE" }],
        };
      },
      setServerPort() {},
    });
    require.cache[settingsClass2Path] = cacheEntry(settingsClass2Path, {
      warnLegacyClass2() {},
    });
    require.cache[settingsRoutesPath] = cacheEntry(settingsRoutesPath, {
      createSettingsHandler() {
        return async () => false;
      },
    });
    require.cache[transportDiscordPath] = cacheEntry(transportDiscordPath, {
      createDiscordAdapter() {
        return {
          transport: "discord",
          prefixes: ["/api/discord"],
          capabilities: { chat: false },
          handleHttp(_req, res) {
            if (mode === "adapter-error") throw new Error("adapter failed");
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
          },
        };
      },
    });
    require.cache[wakeCalibratePath] = cacheEntry(wakeCalibratePath, {
      handleCalibrate(_req, res) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
      },
      handleCalibrateWs() {
        globalThis.__upgradeHandled = true;
      },
    });
    require.cache[configPath] = cacheEntry(configPath, {
      loadConfig() {
        return { agent: { id: "ai-meet-participant" } };
      },
    });
    require.cache[agentProfilePath] = cacheEntry(agentProfilePath, {
      resolveAgentProfile() {
        return { agentId: "caty" };
      },
    });

    class FakeWebSocketServer {
      on() {}

      handleUpgrade() {
        globalThis.__upgradeHandled = true;
      }
    }

    const fakeHttp = { ...realHttp };
    fakeHttp.createServer = (handler) => {
      if (mode === "health") {
        function emitHealthSentinel(payload) {
          process.stdout.write("HEALTH_SENTINEL=" + JSON.stringify(payload) + "\n");
        }

        function invokeDirectly(transportProbe) {
          const req = {
            method: "GET",
            url: "/health",
            headers: { host: "localhost" },
            socket: { remoteAddress: "127.0.0.1" },
          };
          const res = {
            status: null,
            headers: null,
            body: "",
            writeHead(status, headers) {
              this.status = status;
              this.headers = headers;
            },
            end(chunk = "") {
              this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              emitHealthSentinel({
                status: this.status,
                headers: this.headers,
                body: this.body,
                transportProbe,
              });
              process.exit(0);
            },
          };
          Promise.resolve(handler(req, res)).catch((error) => {
            emitHealthSentinel({
              status: 599,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
              body: error.message,
              transportProbe,
            });
            process.exit(0);
          });
        }

        const server = realHttp.createServer((req, res) => {
          Promise.resolve(handler(req, res)).catch((error) => {
            res.writeHead(599, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(error.message);
          });
        });
        server.once("error", (error) => {
          if (error?.code === "EPERM") {
            invokeDirectly("listen-eperm-fallback");
            return;
          }
          emitHealthSentinel({
            status: 597,
            headers: {},
            body: error.message,
            transportProbe: "server-error",
          });
          process.exit(0);
        });
        const originalListen = server.listen.bind(server);
        server.listen = (_port, callback) => originalListen(0, "127.0.0.1", () => {
          callback();
          const port = server.address().port;
          realHttp.get({
            host: "127.0.0.1",
            port,
            path: "/health",
            headers: { host: "localhost" },
          }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
              emitHealthSentinel({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8"),
                transportProbe: "ephemeral-port",
              });
              server.close(() => process.exit(0));
            });
          }).on("error", (error) => {
            emitHealthSentinel({
              status: 598,
              headers: {},
              body: error.message,
              transportProbe: "client-error",
            });
            server.close(() => process.exit(0));
          });
        });
        return server;
      }

      if (mode === "conceal" || mode === "adapter-error") {
        const server = new EventEmitter();
        server.address = () => ({ port: 43123 });
        server.listen = (_port, callback) => {
          callback();
          setImmediate(async () => {
            async function invoke(url) {
              const snapshot = { status: null, headers: null, body: "" };
              const res = {
                headersSent: false,
                writeHead(status, headers) { snapshot.status = status; snapshot.headers = headers; this.headersSent = true; },
                end(chunk = "") { snapshot.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
                destroy() { snapshot.destroyed = true; },
              };
              await handler({ method: "GET", url, headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res);
              return snapshot;
            }
            if (mode === "conceal") {
              const discord = await invoke("/api/discord/status");
              const unknown = await invoke("/genuinely-unknown-path");
              process.stdout.write("CONCEAL_SENTINEL=" + JSON.stringify({ discord, unknown }) + "\n");
            } else {
              const failure = await invoke("/api/discord/status");
              process.stdout.write("ADAPTER_ERROR_SENTINEL=" + JSON.stringify(failure) + "\n");
            }
            process.exit(0);
          });
          return server;
        };
        return server;
      }

      const server = new EventEmitter();
      let upgradeHandler = null;
      const originalOn = server.on.bind(server);
      server.on = (event, callback) => {
        if (event === "upgrade") upgradeHandler = callback;
        return originalOn(event, callback);
      };
      server.address = () => ({ port: 43123 });
      server.listen = (_port, callback) => {
        callback();
        setImmediate(async () => {
          let destroyed = false;
          const socket = {
            destroy() {
              destroyed = true;
            },
          };
          upgradeHandler(
            { url: "/api/discord/voice", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
            socket,
            Buffer.alloc(0)
          );
          process.stdout.write("UPGRADE_SENTINEL=" + JSON.stringify({
            destroyed,
            upgradeHandled: globalThis.__upgradeHandled === true,
          }) + "\n");
          process.exit(0);
        });
        return server;
      };
      return server;
    };

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "node:http" || request === "http") return fakeHttp;
      if (request === "ws") return { WebSocketServer: FakeWebSocketServer };
      return originalLoad.call(this, request, parent, isMain);
    };

    require(serverPath);
  `;

  return spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}
