"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { FloorClient, STATES } = require("../src/floor-client");

const routesFile = path.join(__dirname, "..", "src", "transport-meet", "meet-routes.js");

class FakeTimers {
  constructor() { this.nowMs = 0; this.nextId = 1; this.tasks = new Map(); }
  setTimeout(fn, delay = 0) {
    const handle = { id: this.nextId++, unref() {} };
    this.tasks.set(handle.id, { at: this.nowMs + Number(delay), fn, handle });
    return handle;
  }
  clearTimeout(handle) { this.tasks.delete(handle?.id ?? handle); }
  advance(ms) {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.tasks.values()]
        .filter((task) => task.at <= target)
        .sort((left, right) => left.at - right.at || left.handle.id - right.handle.id)[0];
      if (!next) break;
      this.tasks.delete(next.handle.id);
      this.nowMs = next.at;
      next.fn();
    }
    this.nowMs = target;
  }
}

function makeWire() {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.emit("open"); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(message) { this.emit("message", Buffer.from(JSON.stringify(message))); }
    drop() { this.readyState = 3; this.emit("close", 1006, "lost"); }
    close() { this.drop(); }
  }
  FakeSocket.OPEN = 1;
  return { FakeSocket, sockets };
}

function harness(overrides = {}) {
  const timers = new FakeTimers();
  const wire = makeWire();
  const client = new FloorClient({
    url: "wss://hub.example.test/ws",
    roomCode: "r1-ROOM",
    authToken: "cati_hub_t1",
    mode: "cloud",
    agentId: "caty",
    displayName: "Caty",
    wakeWords: ["ケイティ"],
    WebSocketImpl: wire.FakeSocket,
    timers,
    now: () => timers.nowMs,
    random: () => 0.5,
    ...overrides,
  });
  return { client, timers, wire };
}

function open(h) {
  h.client.connect();
  const socket = h.wire.sockets.at(-1);
  socket.open();
  return socket;
}

function welcome(socket, overrides = {}) {
  socket.receive({
    type: "welcome", proto: 1, memberId: "m1", connectionEpoch: 1,
    members: [{ memberId: "m1", displayName: "Caty", wakeWords: ["ケイティ"] }],
    floorState: { holder: null, queue: [] }, ...overrides,
  });
}

function resolveSessionHubConfig({ debug, mode }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-session-hub-config-"));
  const childEnv = { ...process.env, AI_MEET_HOME: home };
  for (const name of [
    "CATY_CLOUD_URL",
    "FLOOR_DEBUG",
    "HUB_ROOM_CODE",
    "HUB_SHARED_TOKEN",
    "HUB_TOKEN",
    "HUB_URL",
  ]) delete childEnv[name];
  if (debug !== undefined) childEnv.FLOOR_DEBUG = debug;

  if (mode === "cloud") {
    fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify({
      hub: {
        token: "cloud-token",
        cloudHubUrl: "wss://cloud-floor.example.test/ws",
        roomSalt: "salt-1",
        roomSaltVersion: "v1",
        configRefreshedAt: "2999-01-01T00:00:00.000Z",
        configRefreshAfterSeconds: 3600,
      },
    })}\n`, { mode: 0o600 });
  } else {
    childEnv.HUB_URL = "wss://shared-floor.example.test/ws";
    childEnv.HUB_ROOM_CODE = "shared-room";
    childEnv.HUB_SHARED_TOKEN = "shared-token";
  }

  const result = spawnSync(process.execPath, ["-e", `
    console.log = () => {};
    const routes = require(${JSON.stringify(routesFile)});
    routes._test.resolveSessionHubConfig("https://zoom.us/j/123").then((value) => {
      process.stdout.write("\\n__SESSION_HUB_CONFIG__" + JSON.stringify(value));
    });
  `], { cwd: home, env: childEnv, encoding: "utf8" });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.split("__SESSION_HUB_CONFIG__").at(-1));
}

for (const mode of ["shared", "cloud"]) {
  test(`${mode} session hub config propagates the floor debug flag`, () => {
    assert.equal(resolveSessionHubConfig({ debug: "1", mode }).debug, true);
    assert.equal(Boolean(resolveSessionHubConfig({ mode }).debug), false);
  });
}

test("cloud hello carries the configured auth token", () => {
  const h = harness();
  const socket = open(h);
  assert.equal(socket.sent[0].authToken, "cati_hub_t1");
});

test("acceptance 1: terminal room_expired mutes and never reconnects", () => {
  const h = harness();
  const scheduled = [];
  h.client.on("reconnect_scheduled", (event) => scheduled.push(event));
  const socket = open(h);
  socket.receive({ type: "error", code: "room_expired", message: "expired", terminal: true, roomOccupied: false });
  socket.drop();
  assert.equal(h.client.state, STATES.DEGRADED);
  assert.equal(h.client.isMuted(), true);
  assert.equal(h.client.terminalReason(), "room_expired");
  assert.deepEqual(scheduled, []);
  assert.equal(h.client.reconnectTimer, null);
  assert.equal(h.timers.tasks.size, 0);
});

test("acceptance 3: retryable hub_unavailable remains degraded and schedules reconnect", () => {
  const h = harness();
  const scheduled = [];
  h.client.on("reconnect_scheduled", (event) => scheduled.push(event));
  const socket = open(h);
  socket.receive({ type: "error", code: "hub_unavailable", terminal: false });
  socket.drop();
  assert.equal(h.client.state, STATES.DEGRADED);
  assert.equal(h.client.isMuted(), false);
  assert.equal(scheduled.length, 1);
  assert.notEqual(h.client.reconnectTimer, null);
  assert.equal(scheduled[0].delayMs <= 10_000, true);
});

test("acceptance 6: crossing an explicit lease on disconnect is terminal", () => {
  const h = harness();
  const scheduled = [];
  h.client.on("reconnect_scheduled", (event) => scheduled.push(event));
  const socket = open(h);
  welcome(socket, { leaseExpiresAt: new Date(1_000).toISOString() });
  h.timers.advance(1_001);
  socket.drop();
  assert.equal(h.client.isMuted(), true);
  assert.equal(h.client.terminalReason(), "room_expired");
  assert.deepEqual(scheduled, []);
});

test("an automatic reconnect that crosses the lease becomes terminal without opening a socket", () => {
  const h = harness();
  const socket = open(h);
  welcome(socket, { leaseExpiresAt: new Date(1_000).toISOString() });
  h.timers.advance(900);
  socket.drop();
  assert.notEqual(h.client.reconnectTimer, null);

  h.timers.advance(250);

  assert.equal(h.wire.sockets.length, 1);
  assert.equal(h.client.isMuted(), true);
  assert.deepEqual(h.client.terminal, { code: "room_expired", cause: "lease_expired" });
  assert.equal(h.client.reconnectTimer, null);
});

test("welcome without a lease uses the first-welcome time plus two hours", () => {
  const h = harness();
  h.timers.advance(500);
  const socket = open(h);
  welcome(socket);
  assert.equal(h.client.leaseExpiresAt, 500 + (2 * 60 * 60_000));
  h.timers.advance(2 * 60 * 60_000);
  socket.drop();
  assert.equal(h.client.isMuted(), true);
  assert.equal(h.client.reconnectTimer, null);
});

test("shared mode treats a missing lease as unlimited and reconnects after two hours", () => {
  const h = harness({ mode: "shared" });
  const scheduled = [];
  h.client.on("reconnect_scheduled", (event) => scheduled.push(event));
  const socket = open(h);
  welcome(socket);
  assert.equal(h.client.leaseExpiresAt, null);

  h.timers.advance((2 * 60 * 60_000) + 1);
  socket.drop();

  assert.equal(h.client.isMuted(), false);
  assert.equal(h.client.terminalReason(), null);
  assert.equal(scheduled.length, 1);
  assert.notEqual(h.client.reconnectTimer, null);
  h.timers.advance(scheduled[0].delayMs);
  assert.equal(h.wire.sockets.length, 2);
});

test("cloud mode preserves a provided lease expiry", () => {
  const h = harness();
  const socket = open(h);
  const leaseExpiresAt = new Date(5_000).toISOString();
  welcome(socket, { leaseExpiresAt });
  assert.equal(h.client.leaseExpiresAt, Date.parse(leaseExpiresAt));
});

test("explicit connect stays muted until welcome releases terminal state", () => {
  const h = harness();
  const first = open(h);
  first.receive({ type: "error", code: "auth_failed", terminal: true, roomOccupied: true });
  first.drop();
  assert.equal(h.client.isMuted(), true);
  h.client.connect();
  const second = h.wire.sockets.at(-1);
  second.open();
  assert.equal(h.client.isMuted(), true);
  assert.equal(h.client.terminalReason(), "auth_failed");
  welcome(second, { connectionEpoch: 2 });
  assert.equal(h.client.state, STATES.READY);
  assert.equal(h.client.isMuted(), false);
  assert.equal(h.client.terminalReason(), null);
});

test("terminal proto_mismatch degrades without muting or reconnecting", () => {
  const h = harness();
  const scheduled = [];
  h.client.on("reconnect_scheduled", (event) => scheduled.push(event));
  const socket = open(h);
  socket.receive({ type: "error", code: "proto_mismatch", terminal: true });
  socket.drop();
  assert.equal(h.client.state, STATES.DEGRADED);
  assert.equal(h.client.isMuted(), false);
  assert.equal(h.client.terminalReason(), "proto_mismatch");
  assert.deepEqual(scheduled, []);
  assert.equal(h.client.reconnectTimer, null);
});
