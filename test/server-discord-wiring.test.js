"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REPO_ROOT = path.join(__dirname, "..");
const SERVER_PATH = path.join(REPO_ROOT, "src", "server.js");
const ALLOWED_GUILD_ID = "12345678901234567";
const OTHER_GUILD_ID = "22345678901234567";
const CHANNEL_ID = "32345678901234567";
let requestSequence = 0;

function supportsLoopbackListen() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", (error) => {
      if (["EACCES", "EPERM"].includes(error.code)) resolve(false);
      else reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function stopChild(child, timeoutMs = 750) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGINT");
  });
}

async function startProductionServer(discord, socketless) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-discord-wiring-"));
  const preloadPath = path.join(home, "ephemeral-listener.js");
  fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify({ discord }, null, 2)}\n`);
  fs.writeFileSync(preloadPath, socketless ? `
    const { EventEmitter } = require("node:events");
    const http = require("node:http");
    http.createServer = (handler) => {
      const server = new EventEmitter();
      server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 43123 });
      server.listen = (_port, callback) => setImmediate(callback);
      process.on("message", async (message) => {
        const req = new EventEmitter();
        Object.assign(req, {
          method: message.method,
          url: message.pathname,
          headers: message.headers || {},
          socket: { remoteAddress: "127.0.0.1" },
          resume() {},
          destroy() {},
        });
        let status = 200;
        let responseBody = "";
        const res = {
          headersSent: false,
          writeHead(nextStatus) {
            status = nextStatus;
            this.headersSent = true;
          },
          end(chunk = "") { responseBody += chunk; },
          destroy() {},
        };
        const handled = handler(req, res);
        queueMicrotask(() => {
          if (message.body) req.emit("data", Buffer.from(message.body));
          req.emit("end");
        });
        await handled;
        process.send({ id: message.id, status, body: responseBody });
      });
      return server;
    };
  ` : `
    const http = require("node:http");
    const createServer = http.createServer.bind(http);
    http.createServer = (...args) => {
      const server = createServer(...args);
      const listen = server.listen.bind(server);
      server.listen = (...listenArgs) => {
        const callback = typeof listenArgs.at(-1) === "function" ? listenArgs.at(-1) : undefined;
        return listen(0, "127.0.0.1", callback);
      };
      return server;
    };
  `);

  const env = { ...process.env, AI_MEET_HOME: home };
  delete env.DISCORD_BOT_TOKEN;
  delete env.NODE_OPTIONS;
  delete env.PORT;

  const child = spawn(process.execPath, ["--require", preloadPath, SERVER_PATH], {
    cwd: REPO_ROOT,
    env,
    stdio: socketless ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for production server:\n${output}`));
      }, 7_500);
      const inspect = () => {
        const match = output.match(/Settings UI: http:\/\/localhost:(\d+)\/settings/);
        if (!match) return;
        clearTimeout(timeout);
        child.off("exit", exited);
        resolve(Number(match[1]));
      };
      const exited = (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Production server exited (${code ?? signal}):\n${output}`));
      };
      child.on("exit", exited);
      child.stdout.on("data", inspect);
      inspect();
    });
    return { child, home, output: () => output, port, socketless };
  } catch (error) {
    await stopChild(child);
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

async function requestJson(running, pathname, options = {}) {
  if (!running.socketless) {
    const response = await fetch(`http://127.0.0.1:${running.port}${pathname}`, options);
    return { status: response.status, body: await response.json() };
  }

  const id = ++requestSequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for socketless production response:\n${running.output()}`));
    }, 2_000);
    const receive = (message) => {
      if (message?.id !== id) return;
      clearTimeout(timeout);
      running.child.off("message", receive);
      resolve({ status: message.status, body: JSON.parse(message.body) });
    };
    running.child.on("message", receive);
    running.child.send({
      id,
      method: options.method || "GET",
      pathname,
      headers: options.headers || {},
      body: options.body || "",
    }, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      running.child.off("message", receive);
      reject(error);
    });
  });
}

async function withProductionServer(discord, socketless, assertions) {
  const running = await startProductionServer(discord, socketless);
  try {
    const health = await requestJson(running, "/health");
    assert.equal(health.status, 200, running.output());
    await assertions(running);
  } finally {
    await stopChild(running.child);
    fs.rmSync(running.home, { recursive: true, force: true });
  }
}

test("production server wires Discord settings while preserving setup-mode refusal", async () => {
  // Managed test sandboxes can deny listen(2). The IPC path still boots the
  // production server and drives its registered HTTP handler; normal CI uses
  // the real ephemeral TCP listener above.
  const socketless = !(await supportsLoopbackListen());
  await withProductionServer({
    botToken: "test-discord-token",
    guildAllowlist: [ALLOWED_GUILD_ID],
  }, socketless, async (running) => {
    const status = await requestJson(running, "/api/discord/status");
    assert.equal(status.status, 200, running.output());
    assert.equal(status.body.configured, true);

    const join = await requestJson(running, "/api/discord/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId: OTHER_GUILD_ID, channelId: CHANNEL_ID }),
    });
    assert.equal(join.status, 403, running.output());
    assert.equal(join.body.code, "DISCORD_GUILD_NOT_ALLOWED");
    assert.notEqual(join.body.code, "DISCORD_SETUP_REQUIRED");
  });

  await withProductionServer({ guildAllowlist: [ALLOWED_GUILD_ID] }, socketless, async (running) => {
    const status = await requestJson(running, "/api/discord/status");
    assert.equal(status.status, 200, running.output());
    assert.equal(status.body.configured, false);

    const join = await requestJson(running, "/api/discord/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId: ALLOWED_GUILD_ID, channelId: CHANNEL_ID }),
    });
    assert.equal(join.status, 503, running.output());
    assert.equal(join.body.code, "DISCORD_SETUP_REQUIRED");
  });
});
