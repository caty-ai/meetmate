"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const configFile = path.join(__dirname, "..", "src", "config.js");

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

test("cloud hub mode uses the installation token and leaves room-code derivation to the caller", () => {
  const result = loadConfigWith({ HUB_TOKEN: "env-hub-token" }, {
    hub: {
      cloudUrl: "https://cloud.example.test",
      token: "stored-hub",
      cloudHubUrl: "wss://cloud-floor.example.test/ws",
      url: "wss://shared-floor.example.test/ws",
      roomCode: "shared-room",
      sharedToken: "shared-token",
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

test("cloud hub mode requires its dedicated hub URL alongside HUB_TOKEN", () => {
  const result = loadConfigWith({ HUB_TOKEN: "env-hub-token" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cloud hub URL and HUB_TOKEN must be set together/);
});
