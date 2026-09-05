"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const configFile = path.join(__dirname, "..", "src", "config.js");
const routesFile = path.join(__dirname, "..", "src", "transport-meet", "meet-routes.js");

function loadConfigWith(env = {}, config = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-floor-config-"));
  const childEnv = { ...process.env, AI_MEET_HOME: home };
  for (const name of ["HUB_URL", "HUB_ROOM_CODE", "HUB_SHARED_TOKEN", "HUB_TOKEN", "CATY_CLOUD_URL", "HUB_TAIL_MS"]) delete childEnv[name];
  Object.assign(childEnv, env);
  if (config) fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, ["-e", `
    const config = require(${JSON.stringify(configFile)});
    process.stdout.write(JSON.stringify(config.HUB_CONFIG));
  `], { cwd: home, env: childEnv, encoding: "utf8" });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

function resolveSessionHubConfigWithFrozenDisabled(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-live-floor-config-"));
  fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const childEnv = { ...process.env, AI_MEET_HOME: home };
  for (const name of ["HUB_URL", "HUB_ROOM_CODE", "HUB_SHARED_TOKEN", "HUB_TOKEN", "CATY_CLOUD_URL"]) delete childEnv[name];
  const result = spawnSync(process.execPath, ["-e", `
    console.log = () => {};
    const configPath = require.resolve(${JSON.stringify(configFile)});
    const config = require(configPath);
    require.cache[configPath].exports = {
      ...config,
      HUB_CONFIG: Object.freeze({ ...config.HUB_CONFIG, enabled: false }),
    };
    const routes = require(${JSON.stringify(routesFile)});
    routes._test.resolveSessionHubConfig("https://zoom.us/j/123").then((value) => {
      process.stdout.write("\\n__SESSION_HUB_CONFIG__" + JSON.stringify(value));
    });
  `], { cwd: home, env: childEnv, encoding: "utf8" });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

test("both hub settings absent preserves the disabled legacy path", () => {
  const result = loadConfigWith();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "shared", enabled: false, url: null, roomCode: null, authToken: "", tailMs: 500,
  });
});

test("HUB_URL and HUB_ROOM_CODE half-configuration fails at module startup", () => {
  const urlOnly = loadConfigWith({ HUB_URL: "wss://floor.example.test" });
  assert.notEqual(urlOnly.status, 0);
  assert.match(urlOnly.stderr, /HUB_URL and HUB_ROOM_CODE must be set together/);

  const roomOnly = loadConfigWith({ HUB_ROOM_CODE: "room-79" });
  assert.notEqual(roomOnly.status, 0);
  assert.match(roomOnly.stderr, /HUB_URL and HUB_ROOM_CODE must be set together/);
});

test("hub URL scheme and per-install tail are validated and resolved", () => {
  const invalid = loadConfigWith({ HUB_URL: "https://floor.example.test", HUB_ROOM_CODE: "room-79" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /absolute ws:\/\/ or wss:\/\/ URL/);

  const valid = loadConfigWith({
    HUB_URL: "wss://floor.example.test/ws",
    HUB_ROOM_CODE: "room-79",
    HUB_SHARED_TOKEN: "shared-secret",
    HUB_TAIL_MS: "725",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    mode: "shared",
    enabled: true,
    url: "wss://floor.example.test/ws",
    roomCode: "room-79",
    authToken: "shared-secret",
    tailMs: 725,
  });
});

test("cloud hub mode stays disabled until room-code derivation lands", () => {
  const result = loadConfigWith({ HUB_TOKEN: "env-hub-token" }, {
    hub: {
      cloudUrl: "https://cloud.example.test",
      token: "stored-hub",
      cloudHubUrl: "wss://cloud-floor.example.test/ws",
      roomSalt: "salt-secret",
      roomSaltVersion: "v7",
      installationId: "install-190",
      planId: "hub_personal",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    enabled: true,
    url: "wss://cloud-floor.example.test/ws",
    roomCode: null,
    authToken: "env-hub-token",
    tailMs: 500,
    roomSalt: "salt-secret",
    roomSaltVersion: "v7",
    installationId: "install-190",
    planId: "hub_personal",
    mode: "cloud",
  });
});

test("cloud hub mode ignores leftover shared settings until room-code derivation lands", () => {
  const result = loadConfigWith({}, {
    hub: {
      token: "stored-hub",
      cloudHubUrl: "wss://cloud-floor.example.test/ws",
      url: "wss://shared-floor.example.test/ws",
      roomCode: "leftover-shared-room",
      sharedToken: "leftover-shared",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    enabled: true,
    url: "wss://cloud-floor.example.test/ws",
    roomCode: null,
    authToken: "stored-hub",
    tailMs: 500,
    roomSalt: "",
    roomSaltVersion: "",
    installationId: "",
    planId: "",
    mode: "cloud",
  });
});

test("cloud hub mode ignores HUB_ROOM_CODE from the environment", () => {
  const result = loadConfigWith({ HUB_ROOM_CODE: "leftover-env-room" }, {
    hub: {
      token: "stored-hub",
      cloudHubUrl: "wss://cloud-floor.example.test/ws",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    enabled: true,
    url: "wss://cloud-floor.example.test/ws",
    roomCode: null,
    authToken: "stored-hub",
    tailMs: 500,
    roomSalt: "",
    roomSaltVersion: "",
    installationId: "",
    planId: "",
    mode: "cloud",
  });
});

test("cloud hub mode requires its dedicated hub URL alongside HUB_TOKEN", () => {
  const result = loadConfigWith({ HUB_TOKEN: "env-hub-token" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hub\.cloudHubUrl and HUB_TOKEN must be set together/);
});

test("session cloud arbitration uses live stored credentials after boot", () => {
  const result = resolveSessionHubConfigWithFrozenDisabled({
    hub: {
      cloudUrl: "https://cloud.example.test",
      token: "hub-token",
      cloudHubUrl: "wss://cloud-floor.example.test/ws",
      roomSalt: "salt-1",
      roomSaltVersion: "v1",
      configRefreshedAt: "2999-01-01T00:00:00.000Z",
      configRefreshAfterSeconds: 3600,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const session = JSON.parse(result.stdout.split("__SESSION_HUB_CONFIG__").at(-1));
  assert.equal(session.enabled, true);
  assert.equal(session.url, "wss://cloud-floor.example.test/ws");
  assert.equal(session.authToken, "hub-token");
  assert.match(session.roomCode, /^v1-[A-Z2-7]{26}$/u);
});
