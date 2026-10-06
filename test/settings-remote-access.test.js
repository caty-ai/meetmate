"use strict";

// #288: opt-in remote settings access through the operator's Tailscale Serve origin.
// Design v2.1 §6 rows T1–T8 (T9, the settings page, lives in test/settings-ui.test.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const resolver = require("../src/settings/resolver");
const { MASK, REGISTRY_BY_ID, SETTINGS_REGISTRY } = require("../src/settings/registry");
const { readConfigState } = require("../src/settings/store");
const { createSettingsHandler, _test } = require("../src/settings/routes");

const ROOT = path.join(__dirname, "..");
// Obviously fake tailnet names and short fake values (public repository, commit secret guard).
const SERVE_ORIGIN = "https://node-a.tailnet-x.ts.net:8453";
const SERVE_AUTHORITY = "node-a.tailnet-x.ts.net:8453";
const LOGIN = "owner@example.com";
const CLIENT_IP = "100.101.102.103";
const SONIOX_VALUE = "k-test-soniox";
const NOT_FOUND = Object.freeze({
  status: 404,
  headers: { "Content-Type": "text/plain; charset=utf-8", Connection: "close" },
  text: "Not Found",
});
const HERMETIC_READINESS = Object.freeze({ configure() {}, async probeGateSystems() {} });

function startup(directory) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: "k-gw", openaiApiKey: "" }),
  });
}

function settingsDocument(server = {}, extra = {}) {
  return {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "main" },
    stt: { provider: "soniox", sonioxApiKey: SONIOX_VALUE },
    tts: { provider: "fish-audio", voiceId: "voice-id" },
    slack: { notifications: { enabled: false } },
    server: { publicOrigin: SERVE_ORIGIN, remoteSettingsAccess: true, ...server },
    ...extra,
  };
}

// A committed config file under a temporary home; the runtime boots from it.
function initFile(t, server = {}, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-remote-settings-"));
  t.after(() => {
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const runtimeStartup = startup(directory);
  const document = settingsDocument(server, extra);
  for (const [key, value] of Object.entries(server)) if (value === undefined) delete document.server[key];
  fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({ state: readConfigState(runtimeStartup.configPath), startup: runtimeStartup, serverPort: 5005 });
  return runtimeStartup;
}

function fakeCloud() {
  const calls = { beginConnect: 0, refreshConfig: 0 };
  return {
    calls,
    async beginConnect() {
      calls.beginConnect += 1;
      return { authorizeUrl: "https://cloud.example/authorize", expiresAt: "2026-10-06T00:10:00.000Z", completion: new Promise(() => {}), cancel() {} };
    },
    async refreshConfig() {
      calls.refreshConfig += 1;
      return { ok: true, hub_url: "wss://hub.example/ws2", room_salt: "s-test-2", room_salt_version: "v2", refresh_after_s: 3600 };
    },
    async disconnect() { return { ok: true }; },
    async completeConnect() { return { ok: false, status: 0 }; },
  };
}

function handler(cloud = fakeCloud()) {
  return createSettingsHandler({
    port: 5005,
    readinessController: HERMETIC_READINESS,
    cloudSetup: cloud,
    logger: { info() {} },
  });
}

// Builds a request the way Node does: `rawHeaders` keeps every line, `headers` joins duplicates
// (and keeps the first Host). `rawHeaders: false` builds a request object without it.
function buildRequest(method, url, pairs, { body, socket = {}, rawHeaders = true } = {}) {
  const bytes = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from(bytes ? [Buffer.from(bytes)] : []);
  const headers = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    if (key === "host" && Object.hasOwn(headers, key)) continue;
    headers[key] = Object.hasOwn(headers, key) ? `${headers[key]}, ${value}` : value;
  }
  Object.assign(req, {
    method,
    url,
    headers,
    socket: { localAddress: "127.0.0.1", localPort: 5005, remoteAddress: "127.0.0.1", ...socket },
  });
  if (rawHeaders) req.rawHeaders = pairs.flat();
  return req;
}

const SERVE_PAIRS = Object.freeze([
  ["Host", SERVE_AUTHORITY],
  ["User-Agent", "test"],
  ["X-Forwarded-For", CLIENT_IP],
  ["X-Forwarded-Host", SERVE_AUTHORITY],
  ["X-Forwarded-Proto", "https"],
  ["Tailscale-User-Login", LOGIN],
  ["Tailscale-User-Name", "Owner"],
]);

// A Serve-shaped request. `set` replaces (or with null removes) a header by name; `add` appends
// extra lines (duplicates included). Writes carry the allowed Origin unless `set` says otherwise.
function serve(method, url, { set = {}, add = [], body, socket, rawHeaders } = {}) {
  const write = method !== "GET";
  const base = [
    ...SERVE_PAIRS,
    ...(write ? [["Origin", SERVE_ORIGIN], ["Sec-Fetch-Site", "same-origin"], ["Content-Type", "application/json"]] : []),
  ];
  const names = Object.keys(set).map((name) => name.toLowerCase());
  const pairs = base.filter(([name]) => !names.includes(name.toLowerCase()));
  for (const [name, value] of Object.entries(set)) if (value !== null) pairs.push([name, value]);
  pairs.push(...add);
  return buildRequest(method, url, pairs, { body, socket, rawHeaders });
}

function local(method, url, { set = {}, body } = {}) {
  const write = method !== "GET";
  const base = [["Host", "localhost:5005"],
    ...(write ? [["Origin", "http://localhost:5005"], ["Sec-Fetch-Site", "same-origin"], ["Content-Type", "application/json"]] : [])];
  const names = Object.keys(set).map((name) => name.toLowerCase());
  const pairs = base.filter(([name]) => !names.includes(name.toLowerCase()));
  for (const [name, value] of Object.entries(set)) if (value !== null) pairs.push([name, value]);
  // Local requests are built like the existing guard tests: no rawHeaders, no remoteAddress.
  const req = buildRequest(method, url, pairs, { body, rawHeaders: false });
  delete req.socket.remoteAddress;
  return req;
}

async function call(settingsHandler, req) {
  const res = {
    status: null,
    headers: null,
    text: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = "") { this.text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
  };
  const handled = await settingsHandler(req, res);
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* non-JSON bodies are compared as text */ }
  return { handled, status: res.status, headers: res.headers, text: res.text, json };
}

function assertNotFound(result, label) {
  assert.deepEqual({ status: result.status, headers: result.headers, text: result.text }, NOT_FOUND, label);
}

function revisionOf(runtimeStartup) {
  return readConfigState(runtimeStartup.configPath).revision;
}

function configBytes(runtimeStartup) {
  return fs.readFileSync(runtimeStartup.configPath, "utf8");
}

function storedServer(runtimeStartup) {
  return JSON.parse(configBytes(runtimeStartup)).server;
}

// ---- T1 admission matrix -------------------------------------------------------------------------

const ADMISSION_ROWS = [
  // [label, request builder, admitted when the switch is on]
  ["Serve-shaped request", () => serve("GET", "/api/settings"), true],
  ["Host in mixed case", () => serve("GET", "/api/settings", { set: { Host: "Node-A.Tailnet-X.TS.NET:8453" } }), true],
  ["other Host", () => serve("GET", "/api/settings", { set: { Host: "other.example:8453" } }), false],
  ["a .ts.net Host that is not public_origin", () => serve("GET", "/api/settings", { set: { Host: "node-b.tailnet-x.ts.net:8453", "X-Forwarded-Host": "node-b.tailnet-x.ts.net:8453" } }), false],
  ["Serve client posing as local (Host localhost)", () => serve("GET", "/api/settings", { set: { Host: "localhost:5005", "X-Forwarded-Host": "localhost:5005" } }), false],
  ["missing Tailscale-User-Login", () => serve("GET", "/api/settings", { set: { "Tailscale-User-Login": null } }), false],
  ["empty Tailscale-User-Login", () => serve("GET", "/api/settings", { set: { "Tailscale-User-Login": "" } }), false],
  ["duplicated Tailscale-User-Login", () => serve("GET", "/api/settings", { add: [["Tailscale-User-Login", "other@example.com"]] }), false],
  ["missing X-Forwarded-Proto", () => serve("GET", "/api/settings", { set: { "X-Forwarded-Proto": null } }), false],
  ["X-Forwarded-Proto http", () => serve("GET", "/api/settings", { set: { "X-Forwarded-Proto": "http" } }), false],
  ["X-Forwarded-Proto HTTPS", () => serve("GET", "/api/settings", { set: { "X-Forwarded-Proto": "HTTPS" } }), false],
  ["X-Forwarded-Host differs from Host", () => serve("GET", "/api/settings", { set: { "X-Forwarded-Host": "evil.example" } }), false],
  ["missing X-Forwarded-Host", () => serve("GET", "/api/settings", { set: { "X-Forwarded-Host": null } }), false],
  ["Forwarded present", () => serve("GET", "/api/settings", { add: [["Forwarded", "for=100.64.0.1"]] }), false],
  ["non-loopback localAddress", () => serve("GET", "/api/settings", { socket: { localAddress: "100.64.0.9" } }), false],
  ["non-loopback remoteAddress", () => serve("GET", "/api/settings", { socket: { remoteAddress: "100.101.102.103" } }), false],
  ["missing remoteAddress", () => serve("GET", "/api/settings", { socket: { remoteAddress: undefined } }), false],
  ["X-Forwarded-For public address", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "203.0.113.9" } }), false],
  ["missing X-Forwarded-For", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": null } }), false],
  ["X-Forwarded-For two addresses", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "100.64.0.1, 100.64.0.2" } }), false],
  ["X-Forwarded-For duplicated header", () => serve("GET", "/api/settings", { add: [["X-Forwarded-For", "100.64.0.2"]] }), false],
  ["Host duplicated in rawHeaders", () => serve("GET", "/api/settings", { add: [["host", SERVE_AUTHORITY]] }), false],
  ["X-Forwarded-Proto duplicated in rawHeaders", () => serve("GET", "/api/settings", { add: [["x-forwarded-proto", "https"]] }), false],
  ["X-Forwarded-Host duplicated in rawHeaders", () => serve("GET", "/api/settings", { add: [["X-FORWARDED-HOST", SERVE_AUTHORITY]] }), false],
  ["request object without rawHeaders", () => serve("GET", "/api/settings", { rawHeaders: false }), false],
  // R6 parser rows (v2.1).
  ["X-Forwarded-For compressed IPv6 in range", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "fd7a:115c:a1e0::1" } }), true],
  ["X-Forwarded-For full IPv6 in range", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240" } }), true],
  ["X-Forwarded-For upper-case IPv6 in range", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "FD7A:115C:A1E0:0:0:0:0:1" } }), true],
  ["X-Forwarded-For IPv4-mapped tailnet address", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "::ffff:100.64.0.1" } }), true],
  ["X-Forwarded-For IPv4-mapped public address", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "::ffff:203.0.113.9" } }), false],
  ["X-Forwarded-For IPv6 outside the range", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "fd7a:115c:a1e1::1" } }), false],
  ["X-Forwarded-For 100.128.0.1", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "100.128.0.1" } }), false],
  ["X-Forwarded-For bracketed IPv6", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "[fd7a:115c:a1e0::1]" } }), false],
  ["X-Forwarded-For with a port", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "100.64.0.1:443" } }), false],
  ["X-Forwarded-For with a zone id", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "fd7a:115c:a1e0::1%en0" } }), false],
  ["X-Forwarded-For comma list", () => serve("GET", "/api/settings", { set: { "X-Forwarded-For": "100.64.0.1,100.64.0.2" } }), false],
];

test("T1 switch off: every non-local row answers today's 404 bytes; local stays 200", async (t) => {
  for (const switchValue of [false, undefined]) {
    initFile(t, { remoteSettingsAccess: switchValue });
    const settingsHandler = handler();
    assert.equal((await call(settingsHandler, local("GET", "/api/settings"))).status, 200);
    for (const [label, build] of ADMISSION_ROWS) {
      assertNotFound(await call(settingsHandler, build()), `${label} (switch ${switchValue})`);
    }
    for (const url of ["/settings", "/settings-assets/settings.js", "/api/settings/export", "/api/settings/cloud/status"]) {
      assertNotFound(await call(settingsHandler, serve("GET", url)), `${url} (switch ${switchValue})`);
    }
    assertNotFound(await call(settingsHandler, serve("PUT", "/api/settings", { body: { schemaVersion: 1, revision: "a".repeat(64), fields: {} } })), "PUT");
  }
});

test("T1 switch on: admission matrix R0–R6", async (t) => {
  initFile(t);
  const settingsHandler = handler();
  assert.equal((await call(settingsHandler, local("GET", "/api/settings"))).status, 200);
  for (const [label, build, admitted] of ADMISSION_ROWS) {
    const result = await call(settingsHandler, build());
    if (admitted) {
      assert.equal(result.status, 200, label);
      assert.equal(result.json.remoteAccess.via, "remote", label);
    } else {
      assertNotFound(result, label);
    }
  }
});

test("T1 public_origin rows: empty, non-.ts.net, normalised (mixed case, :443), explicit :443 Host", async (t) => {
  initFile(t, { publicOrigin: "" });
  assertNotFound(await call(handler(), serve("GET", "/api/settings")), "public_origin empty");

  initFile(t, { publicOrigin: "https://meet.example.com:8453" });
  assertNotFound(await call(handler(), serve("GET", "/api/settings", {
    set: { Host: "meet.example.com:8453", "X-Forwarded-Host": "meet.example.com:8453" },
  })), "non-.ts.net public_origin");

  initFile(t, { publicOrigin: "https://Node-A.Tailnet-X.ts.net:443" });
  let settingsHandler = handler();
  const plain = { Host: "node-a.tailnet-x.ts.net", "X-Forwarded-Host": "node-a.tailnet-x.ts.net" };
  const admitted = await call(settingsHandler, serve("GET", "/api/settings", { set: plain }));
  assert.equal(admitted.status, 200, "mixed case + :443 public_origin admits the normalised Host");
  assert.equal(admitted.json.remoteAccess.origin, "https://node-a.tailnet-x.ts.net");
  const write = await call(settingsHandler, serve("PUT", "/api/settings", {
    set: { ...plain, Origin: "https://node-a.tailnet-x.ts.net" },
    body: { schemaVersion: 1, revision: admitted.json.revision, fields: { agent_name: "Remote" } },
  }));
  assert.equal(write.status, 200, "the normalised Origin is the allowed origin");
  assertNotFound(await call(settingsHandler, serve("GET", "/api/settings", {
    set: { Host: "node-a.tailnet-x.ts.net:443", "X-Forwarded-Host": "node-a.tailnet-x.ts.net:443" },
  })), "an explicit :443 Host is refused");

  initFile(t, { publicOrigin: "https://node-a.tailnet-x.ts.net" });
  settingsHandler = handler();
  assert.equal((await call(settingsHandler, serve("GET", "/api/settings", { set: plain }))).status, 200);
  assertNotFound(await call(settingsHandler, serve("GET", "/api/settings", {
    set: { Host: "node-a.tailnet-x.ts.net:443", "X-Forwarded-Host": "node-a.tailnet-x.ts.net:443" },
  })), "explicit :443 Host with a port-less public_origin");
});

test("T1 a saved-but-not-restarted public_origin does not move the door", async (t) => {
  const runtimeStartup = initFile(t);
  const settingsHandler = handler();
  const next = "https://node-b.tailnet-x.ts.net:8453";
  const saved = await call(settingsHandler, local("PUT", "/api/settings", {
    body: { schemaVersion: 1, revision: revisionOf(runtimeStartup), fields: { public_origin: next } },
  }));
  assert.equal(saved.status, 200);
  assert.equal(storedServer(runtimeStartup).publicOrigin, next);
  assert.deepEqual(saved.json.restartRequired, ["public_origin"]);
  assert.equal((await call(settingsHandler, serve("GET", "/api/settings"))).status, 200, "the running origin still admits");
  assertNotFound(await call(settingsHandler, serve("GET", "/api/settings", {
    set: { Host: "node-b.tailnet-x.ts.net:8453", "X-Forwarded-Host": "node-b.tailnet-x.ts.net:8453" },
  })), "the saved origin does not admit before a restart");
});

test("T1 login pin: empty admits any identity; set admits the same login in any letter case only", async (t) => {
  initFile(t, { remoteSettingsLogin: "" });
  assert.equal((await call(handler(), serve("GET", "/api/settings", { set: { "Tailscale-User-Login": "anyone@example.org" } }))).status, 200);

  initFile(t, { remoteSettingsLogin: "Owner@Example.com" });
  const settingsHandler = handler();
  for (const login of [LOGIN, "OWNER@EXAMPLE.COM", "Owner@Example.com"]) {
    assert.equal((await call(settingsHandler, serve("GET", "/api/settings", { set: { "Tailscale-User-Login": login } }))).status, 200, login);
  }
  assertNotFound(await call(settingsHandler, serve("GET", "/api/settings", { set: { "Tailscale-User-Login": "shared@example.org" } })), "other login");
  assertNotFound(await call(settingsHandler, serve("GET", "/api/settings", { set: { "Tailscale-User-Login": null } })), "missing login");
  // The comparison folds ASCII letters only: the Kelvin sign is not "k".
  initFile(t, { remoteSettingsLogin: "k@example.com" });
  assertNotFound(await call(handler(), serve("GET", "/api/settings", { set: { "Tailscale-User-Login": "K@example.com" } })), "non-ASCII fold");
});

test("T1 login pin: a stored pin the registry rejects keeps the door shut; local is unchanged", async (t) => {
  for (const pin of [42, null, ["a"], { a: 1 }, true, `${"a".repeat(250)}@example.com`]) {
    const label = JSON.stringify(pin).slice(0, 24);
    initFile(t, { remoteSettingsLogin: pin });
    const settingsHandler = handler();
    assertNotFound(await call(settingsHandler, serve("GET", "/api/settings")), label);
    assert.equal((await call(settingsHandler, local("GET", "/api/settings"))).status, 200, label);
  }
  for (const pin of [undefined, "", LOGIN]) {
    initFile(t, { remoteSettingsLogin: pin });
    assert.equal((await call(handler(), serve("GET", "/api/settings"))).status, 200, String(pin));
  }
});

// The store resolves a malformed stored pin to its "" default, so a non-string effective value
// cannot be produced through config.json; load a fresh routes.js against a resolver whose pin is
// replaced, and check that only unset / blank / matching pins admit.
test("T1 login pin: an effective value that is neither a string nor unset is not remote", async (t) => {
  initFile(t);
  const routesPath = require.resolve("../src/settings/routes");
  const resolverModule = require.cache[require.resolve("../src/settings/resolver")];
  const real = resolverModule.exports;
  const cached = require.cache[routesPath];
  const admitWithPin = (pin) => {
    resolverModule.exports = { ...real, getEffectiveValue: (id) => (id === "settings_remote_login" ? pin : real.getEffectiveValue(id)) };
    delete require.cache[routesPath];
    try {
      return require(routesPath)._test.isRemoteAdminRequest(serve("GET", "/api/settings"));
    } finally {
      resolverModule.exports = real;
      require.cache[routesPath] = cached;
    }
  };
  for (const pin of [undefined, "", "   ", LOGIN, "OWNER@example.com"]) {
    assert.equal(admitWithPin(pin)?.plane, "remote", String(pin));
  }
  for (const pin of [null, 42, true, [LOGIN], { login: LOGIN }, "other@example.org"]) {
    assert.equal(admitWithPin(pin), null, JSON.stringify(pin));
  }
});

test("T1 admission never throws and never reveals the identity header", async (t) => {
  initFile(t);
  const hostile = serve("GET", "/api/settings");
  hostile.rawHeaders = ["Host", { toString() { throw new Error("boom"); } }];
  assert.equal(_test.isRemoteAdminRequest(hostile), null);
  assert.equal(_test.isRemoteAdminRequest({ method: "GET", url: "/api/settings" }), null);
  const admitted = await call(handler(), serve("GET", "/api/settings"));
  assert.equal(admitted.status, 200);
  assert.equal(admitted.text.includes(LOGIN), false);
  const rejected = await call(handler(), serve("PUT", "/api/settings", { set: { Origin: "https://evil.example" }, body: {} }));
  assert.equal(rejected.status, 403);
  assert.equal(rejected.text.includes(LOGIN), false);
});

// ---- T2 every route of handleSettings answers through the remote plane --------------------------

const UUID = "550e8400-e29b-41d4-a716-446655440000";
// key → the request sent on both planes. `remoteStatus` is set only where the design makes the
// remote answer differ (X2). Bodies are functions of the current committed revision.
const ROUTE_TABLE = {
  "GET /settings": { url: "/settings" },
  "GET /settings-assets/settings.css": { url: "/settings-assets/settings.css" },
  "GET /settings-assets/settings.js": { url: "/settings-assets/settings.js" },
  "GET /api/settings": { url: "/api/settings" },
  "PUT /api/settings": { url: "/api/settings", body: (revision) => ({ schemaVersion: 1, revision, fields: { agent_name: "Route Table" } }) },
  "POST /api/settings/migrate-env-class1": { url: "/api/settings/migrate-env-class1", body: (revision) => ({ revision }) },
  "GET /api/settings/cloud/status": { url: "/api/settings/cloud/status" },
  "POST /api/settings/cloud/connect": { url: "/api/settings/cloud/connect", body: (revision) => ({ revision }), remoteStatus: 403 },
  "POST /api/settings/cloud/refresh": { url: "/api/settings/cloud/refresh", body: (revision) => ({ revision }) },
  "POST /api/settings/cloud/disconnect": { url: "/api/settings/cloud/disconnect", body: (revision) => ({ revision }) },
  "GET /api/settings/export": { url: "/api/settings/export" },
  "POST /api/settings/import": {
    url: "/api/settings/import",
    body: (revision) => ({ revision, document: { format: "meetmate-settings", version: 1, exportedAt: "2026-10-06T00:00:00.000Z", settings: { agent_language: "ja" } } }),
  },
  "GET /api/settings/avatar": { url: "/api/settings/avatar" },
  "GET /api/settings/avatar/static/preview": { url: "/api/settings/avatar/static/preview" },
  "GET framePreview": { url: "/api/settings/avatar/frames/idle/preview" },
  "POST /api/settings/avatar/static": { url: "/api/settings/avatar/static", body: () => ({}) },
  "POST frameAsset": { url: "/api/settings/avatar/frames/idle", body: () => ({}) },
  "DELETE /api/settings/avatar/static": { url: "/api/settings/avatar/static" },
  "DELETE /api/settings/avatar/frames": { url: "/api/settings/avatar/frames" },
  "DELETE frameAsset": { url: "/api/settings/avatar/frames/idle" },
  "GET /api/settings/avatar/background/preview": { url: "/api/settings/avatar/background/preview" },
  "POST /api/settings/avatar/background": { url: "/api/settings/avatar/background", body: () => ({}) },
  "DELETE /api/settings/avatar/background": { url: "/api/settings/avatar/background" },
  "POST /api/settings/audio": { url: "/api/settings/audio", body: () => ({}) },
  "DELETE audioDeleteMatch": { url: `/api/settings/audio/${UUID}`, body: (revision) => ({ revision }) },
  "POST connectionMatch": { url: "/api/settings/connections/slack/test", body: (revision) => ({ revision }) },
  "POST /api/settings/tts-preview": { url: "/api/settings/tts-preview", body: (revision) => ({ revision }) },
};

const DISPATCH_LINE = /req\.method === "([A-Z]+)" && (?:url\.pathname === "([^"]+)"|(\w+))\)/g;

function routesSource() {
  return fs.readFileSync(path.join(ROOT, "src/settings/routes.js"), "utf8");
}

function handlerBody(source = routesSource()) {
  return source.slice(source.indexOf("return async function handleSettings"), source.indexOf("\nmodule.exports"));
}

function countOf(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function handlerRoutes() {
  const source = routesSource();
  const body = handlerBody(source);
  const routes = new Set();
  for (const match of body.matchAll(DISPATCH_LINE)) {
    const [, method, literal, variable] = match;
    if (variable === "staticAsset") {
      const assets = source.match(/const SETTINGS_ASSETS = new Map\(\[([\s\S]*?)\]\);/)[1];
      for (const [, asset] of assets.matchAll(/\["([^"]+)", \{ filename/g)) routes.add(`${method} ${asset}`);
    } else {
      routes.add(`${method} ${literal || variable}`);
    }
  }
  return routes;
}

test("T2 the route table names every route handleSettings dispatches", () => {
  const routes = handlerRoutes();
  assert.ok(routes.size >= 20, "the dispatch parser found the routes");
  assert.deepEqual([...routes].sort(), Object.keys(ROUTE_TABLE).sort());
});

// The parser above reads one dispatch shape. These counts make any other shape (operands swapped,
// a switch, a destructured method or pathname, a new matcher) change a number and fail here.
test("T2 lock: every req.method / url.pathname use and every matcher in handleSettings is accounted for", () => {
  const body = handlerBody();
  const dispatch = [...body.matchAll(DISPATCH_LINE)];
  const literalDispatch = dispatch.filter((match) => match[2] !== undefined).length;
  // req.method outside a dispatch line:
  const methodElsewhere = [
    'if (isAvatarPath && req.method !== "GET") requireSameOrigin', // avatar writes: Origin check before dispatch
  ];
  // url.pathname outside a literal dispatch line:
  const pathnameElsewhere = [
    'url.pathname === "/settings"', // isSettingsPath (the 404 boundary)
    'url.pathname === "/api/settings"\n', // isSettingsPath
    'url.pathname.startsWith("/api/settings/")\n', // isSettingsPath
    'url.pathname.startsWith("/settings-assets/")', // isSettingsPath
    'access.plane === "remote" && (url.pathname === "/api/settings" || url.pathname.startsWith("/api/settings/"))', // Sec-Fetch-Site gate (2 uses)
    'const isAvatarPath = url.pathname === "/api/settings/avatar"', // avatar Origin check
    '|| url.pathname.startsWith("/api/settings/avatar/")', // avatar Origin check
    "SETTINGS_ASSETS.get(url.pathname)", // staticAsset dispatch variable
    "/^\\/api\\/settings\\/avatar\\/frames\\/[^/]+\\/preview$/.test(url.pathname)", // framePreview dispatch variable
    "const name = parseFrameName(url.pathname)", // framePreview / frameAsset name (2 uses)
    "/^\\/api\\/settings\\/avatar\\/frames\\/[^/]+$/.test(url.pathname)", // frameAsset dispatch variable
    "parseFrameName(url.pathname))", // DELETE frameAsset name
    "url.pathname.match(/^\\/api\\/settings\\/audio\\/([^/]+)$/)", // audioDeleteMatch dispatch variable
    "url.pathname.match(/^\\/api\\/settings\\/connections\\/([^/]+)\\/test$/)", // connectionMatch dispatch variable
  ];
  for (const snippet of [...methodElsewhere, ...pathnameElsewhere]) assert.equal(body.includes(snippet), true, snippet);
  assert.equal(countOf(body, /req\.method/g), dispatch.length + methodElsewhere.length, "req.method uses = dispatch lines + listed");
  assert.equal(countOf(body, /\bmethod\b/g), countOf(body, /req\.method/g), "method is only read as req.method");
  // 14 snippets above, two of which hold two uses each.
  assert.equal(countOf(body, /url\.pathname/g), literalDispatch + pathnameElsewhere.length + 2, "url.pathname uses = literal dispatch + listed");
  assert.equal(countOf(body, /\bpathname\b/g), countOf(body, /url\.pathname/g), "pathname is only read as url.pathname");
  // Matchers: isSettingsPath ×2, Sec-Fetch-Site ×1, isAvatarPath ×1 startsWith; framePreview/frameAsset .test;
  // audioDeleteMatch/connectionMatch .match; no .exec; error-code prefix check in cloud/connect.
  assert.equal(countOf(body, /\.startsWith\(/g), 5, ".startsWith( uses");
  assert.equal(countOf(body, /\.test\(/g), 2, ".test( uses");
  assert.equal(countOf(body, /\.match\(/g), 2, ".match( uses");
  assert.equal(countOf(body, /\.exec\(/g), 0, ".exec( uses");
});

// Every config write in routes.js, named by the function or route that owns it.
//   importSettings / migrateClass1 / PUT /api/settings — refuseRemoteBootstrap + assertRemoteFieldsAllowed (X1)
//     on the final field map; both functions take the plane with no default (missing plane throws).
//   saveServerOwnedCloudFields — fixed hub_* fields only; called from refreshStaleCloudConfig (local
//     plane only) and monitorCloudConnect (cloud/connect is local-only, X2).
//   POST cloud/refresh (saveCloudFields) / POST cloud/disconnect (deleteCloudFields) — fixed hub_*
//     fields only, never a locked row; the bootstrap revision is refused on the remote plane.
test("T2 lock: the config write call sites in routes.js are exactly the reviewed ones", () => {
  const source = routesSource();
  const owner = /function (\w+)\(|const (\w+) = (?:async )?\(|req\.method === "([A-Z]+)" && url\.pathname === "([^"]+)"/g;
  const sites = [...source.matchAll(/\b(?:saveFields|saveCloudFields|deleteCloudFields|deleteFields)\(/g)].map((call) => {
    const before = [...source.slice(0, call.index).matchAll(owner)].at(-1);
    return `${call[0]} in ${before[1] || before[2] || `${before[3]} ${before[4]}`}`;
  });
  assert.deepEqual(sites, [
    "saveFields( in importSettings",
    "saveFields( in migrateClass1",
    "saveCloudFields( in saveServerOwnedCloudFields",
    "saveFields( in PUT /api/settings",
    "saveCloudFields( in POST /api/settings/cloud/refresh",
    "deleteCloudFields( in POST /api/settings/cloud/disconnect",
  ]);
  assert.equal(countOf(source, /saveServerOwnedCloudFields\(/g), 2, "refreshStaleCloudConfig + monitorCloudConnect");
  assert.equal(countOf(source, /refreshStaleCloudConfig\(\)/g), 1);
  assert.equal(source.includes('if (access.plane === "local") await refreshStaleCloudConfig();'), true);
  assert.equal(countOf(source, /\bimportSettings\(/g), 2, "definition + the import route");
  assert.equal(countOf(source, /\bmigrateClass1\(/g), 2, "definition + the migrate route");
  assert.equal(source.includes("importSettings(await readJson(req, JSON_LIMIT), access)"), true);
  assert.equal(source.includes("migrateClass1(req, settingsOptions, access)"), true);
});

test("T2 every route answers through the remote plane as it does locally", async (t) => {
  const runtimeStartup = initFile(t);
  const answer = async (plane, key) => {
    const route = ROUTE_TABLE[key];
    const [method] = key.split(" ");
    const body = route.body ? route.body(revisionOf(runtimeStartup)) : undefined;
    const settingsHandler = handler();
    const req = plane === "local" ? local(method, route.url, { body }) : serve(method, route.url, { body });
    return call(settingsHandler, req);
  };
  for (const key of Object.keys(ROUTE_TABLE)) {
    const localAnswer = await answer("local", key);
    const remoteAnswer = await answer("remote", key);
    assert.notEqual(localAnswer.status, null, key);
    if (ROUTE_TABLE[key].remoteStatus) {
      assert.equal(remoteAnswer.status, ROUTE_TABLE[key].remoteStatus, key);
      continue;
    }
    assert.equal(remoteAnswer.status, localAnswer.status, key);
    assert.equal(remoteAnswer.json?.error?.code, localAnswer.json?.error?.code, key);
    if (localAnswer.status === 404) assert.notEqual(remoteAnswer.text, "Not Found", `${key} reached dispatch`);
  }
  // An unknown settings path falls through to the handler's own 404 on both planes.
  assert.equal((await call(handler(), local("GET", "/api/settings/nope"))).status, 404);
  assert.equal((await call(handler(), serve("GET", "/api/settings/nope"))).status, 404);
});

test("T2 framing: /settings and every /settings-assets/* forbid framing on both planes", async (t) => {
  initFile(t);
  for (const url of ["/settings", "/settings-assets/settings.css", "/settings-assets/settings.js"]) {
    for (const req of [local("GET", url), serve("GET", url), serve("GET", url, { set: { "Sec-Fetch-Site": "cross-site" } })]) {
      const result = await call(handler(), req);
      assert.equal(result.status, 200, url);
      assert.equal(result.headers["Content-Security-Policy"], "frame-ancestors 'none'", url);
      assert.equal(result.headers["X-Frame-Options"], "DENY", url);
      assert.equal(Object.keys(result.headers).some((name) => /^access-control-/i.test(name)), false, url);
    }
  }
});

// ---- T3 same-origin and remote reads ---------------------------------------------------------------

test("T3 remote writes need the allowed Origin; the planes never share an origin set", async (t) => {
  const runtimeStartup = initFile(t);
  const settingsHandler = handler();
  const put = (options) => call(settingsHandler, serve("PUT", "/api/settings", {
    ...options,
    body: { schemaVersion: 1, revision: revisionOf(runtimeStartup), fields: { agent_name: "Origin Row" } },
  }));
  for (const [label, set] of [
    ["missing Origin", { Origin: null }],
    ["null Origin", { Origin: "null" }],
    ["loopback Origin", { Origin: "http://localhost:5005" }],
    ["other Origin", { Origin: "https://evil.example" }],
    ["Origin with an explicit :443", { Origin: "https://node-a.tailnet-x.ts.net:443" }],
    ["Sec-Fetch-Site cross-site", { "Sec-Fetch-Site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { "Sec-Fetch-Site": "same-site" }],
    ["Sec-Fetch-Site none on a write", { "Sec-Fetch-Site": "none" }],
  ]) {
    const before = configBytes(runtimeStartup);
    const result = await put({ set });
    assert.equal(result.status, 403, label);
    assert.equal(result.json.error.code, "SETTINGS_ORIGIN_REJECTED", label);
    assert.equal(configBytes(runtimeStartup), before, `${label}: nothing saved`);
  }
  assert.equal((await put({})).status, 200, "allowed Origin with same-origin");
  assert.equal((await put({ set: { "Sec-Fetch-Site": null } })).status, 200, "allowed Origin without Sec-Fetch-Site");
  const before = configBytes(runtimeStartup);
  const localWithRemoteOrigin = await call(settingsHandler, local("PUT", "/api/settings", {
    set: { Origin: SERVE_ORIGIN },
    body: { schemaVersion: 1, revision: revisionOf(runtimeStartup), fields: { agent_name: "Local Row" } },
  }));
  assert.equal(localWithRemoteOrigin.status, 403);
  assert.equal(configBytes(runtimeStartup), before);
  // The structural avatar check runs with the plane too.
  const avatar = await call(settingsHandler, serve("DELETE", "/api/settings/avatar/frames", { set: { Origin: "http://localhost:5005" } }));
  assert.equal(avatar.status, 403);
  assert.equal(avatar.json.error.code, "SETTINGS_ORIGIN_REJECTED");
});

test("T3 remote API requests: Sec-Fetch-Site other than same-origin / none is refused before dispatch", async (t) => {
  initFile(t);
  const settingsHandler = handler();
  for (const url of ["/api/settings", "/api/settings/cloud/status", "/api/settings/export"]) {
    for (const site of ["cross-site", "same-site"]) {
      const result = await call(settingsHandler, serve("GET", url, { set: { "Sec-Fetch-Site": site } }));
      assert.equal(result.status, 403, `${url} ${site}`);
      assert.equal(result.json.error.code, "SETTINGS_ORIGIN_REJECTED");
    }
    for (const site of ["same-origin", "none", null]) {
      assert.equal((await call(settingsHandler, serve("GET", url, { set: { "Sec-Fetch-Site": site } }))).status, 200, `${url} ${site}`);
    }
  }
  // The page itself stays reachable from a link; the local plane is unchanged.
  assert.equal((await call(settingsHandler, serve("GET", "/settings", { set: { "Sec-Fetch-Site": "cross-site" } }))).status, 200);
  assert.equal((await call(settingsHandler, local("GET", "/api/settings", { set: { "Sec-Fetch-Site": "cross-site" } }))).status, 200);
});

test("T3 remote GET cloud/status has no side effect (no refresh, revision unchanged)", async (t) => {
  const staleHub = {
    hub: {
      cloudUrl: "https://cloud.example", token: "k-hub", installationId: "inst-1",
      cloudHubUrl: "wss://hub.example/ws", roomSalt: "s-test", roomSaltVersion: "v1",
      configRefreshedAt: "2020-01-01T00:00:00.000Z",
    },
  };
  const runtimeStartup = initFile(t, {}, staleHub);
  const cloud = fakeCloud();
  const settingsHandler = handler(cloud);
  const before = revisionOf(runtimeStartup);
  const remote = await call(settingsHandler, serve("GET", "/api/settings/cloud/status", { set: { "Sec-Fetch-Site": null } }));
  assert.equal(remote.status, 200);
  assert.equal(remote.json.connected, true);
  assert.equal(cloud.calls.refreshConfig, 0);
  assert.equal(revisionOf(runtimeStartup), before);
  // Control: the same stale configuration does refresh on the local plane.
  assert.equal((await call(settingsHandler, local("GET", "/api/settings/cloud/status"))).status, 200);
  assert.equal(cloud.calls.refreshConfig, 1);
  assert.notEqual(revisionOf(runtimeStartup), before);
  // A remote operator refreshes explicitly.
  const refreshed = await call(settingsHandler, serve("POST", "/api/settings/cloud/refresh", { body: { revision: revisionOf(runtimeStartup) } }));
  assert.equal(refreshed.status, 200);
  assert.equal(cloud.calls.refreshConfig, 2);
});

// ---- T4 X1 locked fields, bootstrap, remoteAccess -------------------------------------------------

function remotePut(settingsHandler, runtimeStartup, fields, options = {}) {
  return call(settingsHandler, serve("PUT", "/api/settings", {
    ...options,
    body: { schemaVersion: 1, revision: options.revision || revisionOf(runtimeStartup), fields },
  }));
}

function exportedDocument(settingsHandler) {
  return call(settingsHandler, local("GET", "/api/settings/export")).then((result) => result.json);
}

test("T4 X1: a remote request cannot widen its own door", async (t) => {
  const runtimeStartup = initFile(t);
  const settingsHandler = handler();
  for (const [label, fields] of [
    ["change public_origin", { public_origin: "https://node-b.tailnet-x.ts.net:8453" }],
    ["clear public_origin", { public_origin: "" }],
    ["re-affirm the switch", { settings_remote_access: true }],
    ["switch plus an allowed field", { settings_remote_access: true, agent_name: "Nope" }],
    ["pin set", { settings_remote_login: "someone@example.com" }],
    ["pin cleared", { settings_remote_login: "" }],
  ]) {
    const before = configBytes(runtimeStartup);
    const revision = revisionOf(runtimeStartup);
    const result = await remotePut(settingsHandler, runtimeStartup, fields);
    assert.equal(result.status, 403, label);
    assert.deepEqual(Object.keys(result.json.error).sort(), ["code", "message", "requestId"], label);
    assert.equal(result.json.error.code, "SETTINGS_REMOTE_FIELD_LOCKED", label);
    assert.equal(configBytes(runtimeStartup), before, `${label}: nothing saved`);
    assert.equal(revisionOf(runtimeStartup), revision, `${label}: revision unchanged`);
  }
  const unchanged = await remotePut(settingsHandler, runtimeStartup, { public_origin: SERVE_ORIGIN, agent_name: "Same Origin" });
  assert.equal(unchanged.status, 200, "the stored public_origin unchanged is a no-op");
  assert.equal(storedServer(runtimeStartup).publicOrigin, SERVE_ORIGIN);
  assert.equal(JSON.parse(configBytes(runtimeStartup)).agent.name, "Same Origin");
});

test("T4 X1 pin: stored value is locked remotely; local sets and clears it", async (t) => {
  const runtimeStartup = initFile(t, { remoteSettingsLogin: LOGIN });
  const settingsHandler = handler();
  const before = configBytes(runtimeStartup);
  const sameValue = await remotePut(settingsHandler, runtimeStartup, { settings_remote_login: LOGIN });
  assert.equal(sameValue.status, 403);
  assert.equal(configBytes(runtimeStartup), before);
  const cleared = await call(settingsHandler, local("PUT", "/api/settings", {
    body: { schemaVersion: 1, revision: revisionOf(runtimeStartup), fields: { settings_remote_login: "" } },
  }));
  assert.equal(cleared.status, 200);
  assert.equal(storedServer(runtimeStartup).remoteSettingsLogin, "");
  const set = await call(settingsHandler, local("PUT", "/api/settings", {
    body: { schemaVersion: 1, revision: revisionOf(runtimeStartup), fields: { settings_remote_login: "  Other@Example.com " } },
  }));
  assert.equal(set.status, 200);
  assert.equal(storedServer(runtimeStartup).remoteSettingsLogin, "Other@Example.com");
  assertNotFound(await call(settingsHandler, serve("GET", "/api/settings")), "the new pin applies live");
  assert.equal((await call(settingsHandler, serve("GET", "/api/settings", { set: { "Tailscale-User-Login": "other@example.com" } }))).status, 200);
});

test("T4 X1: turning the switch off remotely is allowed and closes the door from the next request", async (t) => {
  const runtimeStartup = initFile(t);
  const settingsHandler = handler();
  const result = await remotePut(settingsHandler, runtimeStartup, { settings_remote_access: false });
  assert.equal(result.status, 200);
  assert.equal(storedServer(runtimeStartup).remoteSettingsAccess, false);
  assert.deepEqual(result.json.remoteAccess, { enabled: false, origin: "", via: "remote" });
  assertNotFound(await call(settingsHandler, serve("GET", "/api/settings")), "next remote request");
  assert.equal((await call(settingsHandler, local("GET", "/api/settings"))).status, 200);
});

test("T4 X1: local PUT of the switch and public_origin is allowed", async (t) => {
  const runtimeStartup = initFile(t, { remoteSettingsAccess: false });
  const settingsHandler = handler();
  const result = await call(settingsHandler, local("PUT", "/api/settings", {
    body: { schemaVersion: 1, revision: revisionOf(runtimeStartup), fields: { settings_remote_access: true, public_origin: "https://node-b.tailnet-x.ts.net:8453" } },
  }));
  assert.equal(result.status, 200);
  assert.equal(storedServer(runtimeStartup).remoteSettingsAccess, true);
  assert.equal(storedServer(runtimeStartup).publicOrigin, "https://node-b.tailnet-x.ts.net:8453");
  assert.deepEqual(result.json.remoteAccess, { enabled: true, origin: SERVE_ORIGIN, via: "local" });
  assert.equal((await call(settingsHandler, serve("GET", "/api/settings"))).status, 200, "live: on from the next request");
});

test("T4 X1 import: changing public_origin is refused; the stored value passes; non-transferable rows cannot enter", async (t) => {
  const runtimeStartup = initFile(t);
  const settingsHandler = handler();
  const importBody = (settings) => ({
    revision: revisionOf(runtimeStartup),
    document: { format: "meetmate-settings", version: 1, exportedAt: "2026-10-06T00:00:00.000Z", settings },
  });
  let before = configBytes(runtimeStartup);
  const changed = await call(settingsHandler, serve("POST", "/api/settings/import", { body: importBody({ public_origin: "https://node-b.tailnet-x.ts.net:8453" }) }));
  assert.equal(changed.status, 403);
  assert.equal(changed.json.error.code, "SETTINGS_REMOTE_FIELD_LOCKED");
  assert.equal(configBytes(runtimeStartup), before);
  for (const settings of [{ settings_remote_access: false }, { settings_remote_access: true }, { settings_remote_login: "" }]) {
    const result = await call(settingsHandler, serve("POST", "/api/settings/import", { body: importBody(settings) }));
    assert.equal(result.status, 422, JSON.stringify(settings));
    assert.equal(configBytes(runtimeStartup), before);
  }
  const exported = await exportedDocument(settingsHandler);
  assert.equal(exported.settings.public_origin, SERVE_ORIGIN);
  const ownExport = await call(settingsHandler, serve("POST", "/api/settings/import", {
    body: { revision: revisionOf(runtimeStartup), document: { ...exported, settings: { ...exported.settings, agent_name: "Imported" } } },
  }));
  assert.equal(ownExport.status, 200, "an export of this instance imports remotely");
  assert.equal(ownExport.json.import.skipped.includes("public_origin"), true);
  assert.deepEqual(ownExport.json.remoteAccess, { enabled: true, origin: SERVE_ORIGIN, via: "remote" });
  before = configBytes(runtimeStartup);
  assert.equal(JSON.parse(before).agent.name, "Imported");
});

test("T4 importSettings has no default plane: a missing or unknown plane throws and saves nothing", async (t) => {
  const runtimeStartup = initFile(t);
  const before = configBytes(runtimeStartup);
  const request = (revision) => ({
    revision,
    document: { format: "meetmate-settings", version: 1, exportedAt: "2026-10-06T00:00:00.000Z", settings: { agent_language: "en" } },
  });
  for (const access of [undefined, null, {}, { plane: "elsewhere", origin: SERVE_ORIGIN }]) {
    assert.throws(() => _test.importSettings(request(revisionOf(runtimeStartup)), access), /access plane is required/, JSON.stringify(access));
  }
  assert.equal(configBytes(runtimeStartup), before);
  // The same document with the plane passed explicitly does save.
  _test.importSettings(request(revisionOf(runtimeStartup)), { plane: "local", origin: "" });
  assert.notEqual(configBytes(runtimeStartup), before);
});

test("T4 remote revision bootstrap is refused on every route that takes a revision", async (t) => {
  const runtimeStartup = initFile(t);
  const cloud = fakeCloud();
  const settingsHandler = handler(cloud);
  const before = configBytes(runtimeStartup);
  for (const [method, url, body] of [
    ["PUT", "/api/settings", { schemaVersion: 1, revision: "bootstrap", fields: {} }],
    ["PUT", "/api/settings", { schemaVersion: 1, revision: "bootstrap", fields: { agent_name: "Seed" } }],
    ["POST", "/api/settings/migrate-env-class1", { revision: "bootstrap" }],
    ["POST", "/api/settings/cloud/refresh", { revision: "bootstrap" }],
    ["POST", "/api/settings/cloud/disconnect", { revision: "bootstrap" }],
  ]) {
    const result = await call(settingsHandler, serve(method, url, { body }));
    assert.equal(result.status, 403, `${method} ${url}`);
    assert.equal(result.json.error.code, "SETTINGS_REMOTE_FIELD_LOCKED", `${method} ${url}`);
    assert.equal(configBytes(runtimeStartup), before, `${method} ${url}: nothing saved`);
  }
  assert.equal(cloud.calls.refreshConfig, 0);
  // The schemas that accept only a sha256 revision reject it before any action, on both planes.
  const imported = await call(settingsHandler, serve("POST", "/api/settings/import", {
    body: { revision: "bootstrap", document: { format: "meetmate-settings", version: 1, exportedAt: "2026-10-06T00:00:00.000Z", settings: {} } },
  }));
  assert.equal(imported.status, 422);
});

test("T4 remoteAccess is on every envelope (GET, PUT, import) with the plane it was served on", async (t) => {
  const runtimeStartup = initFile(t);
  const settingsHandler = handler();
  const expectRemote = { enabled: true, origin: SERVE_ORIGIN, via: "remote" };
  const expectLocal = { enabled: true, origin: SERVE_ORIGIN, via: "local" };
  assert.deepEqual((await call(settingsHandler, serve("GET", "/api/settings"))).json.remoteAccess, expectRemote);
  assert.deepEqual((await call(settingsHandler, local("GET", "/api/settings"))).json.remoteAccess, expectLocal);
  assert.deepEqual((await remotePut(settingsHandler, runtimeStartup, { agent_name: "A" })).json.remoteAccess, expectRemote);
  const localPut = await call(settingsHandler, local("PUT", "/api/settings", {
    body: { schemaVersion: 1, revision: revisionOf(runtimeStartup), fields: { agent_name: "B" } },
  }));
  assert.deepEqual(localPut.json.remoteAccess, expectLocal);
  const importBody = { revision: revisionOf(runtimeStartup), document: { format: "meetmate-settings", version: 1, exportedAt: "2026-10-06T00:00:00.000Z", settings: { agent_name: "C" } } };
  const imported = await call(settingsHandler, serve("POST", "/api/settings/import", { body: importBody }));
  assert.deepEqual(imported.json.remoteAccess, expectRemote);
  assert.deepEqual(Object.keys(imported.json.remoteAccess), ["enabled", "origin", "via"]);

  initFile(t, { remoteSettingsAccess: false });
  assert.deepEqual((await call(handler(), local("GET", "/api/settings"))).json.remoteAccess, { enabled: false, origin: "", via: "local" });
  initFile(t, { publicOrigin: "https://meet.example.com" });
  assert.deepEqual((await call(handler(), local("GET", "/api/settings"))).json.remoteAccess, { enabled: true, origin: "", via: "local" });
});

// ---- T5 X2 cloud connect is local-only -------------------------------------------------------------

test("T5 X2: remote cloud/connect is 403 and opens no listener; local is unchanged", async (t) => {
  const runtimeStartup = initFile(t);
  const cloud = fakeCloud();
  const settingsHandler = handler(cloud);
  for (const body of [{ revision: revisionOf(runtimeStartup) }, { revision: revisionOf(runtimeStartup), cloudUrl: "https://cloud.example" }]) {
    const remote = await call(settingsHandler, serve("POST", "/api/settings/cloud/connect", { body }));
    assert.equal(remote.status, 403);
    assert.equal(remote.json.error.code, "SETTINGS_REMOTE_LOCAL_ONLY");
    assert.equal(cloud.calls.beginConnect, 0);
  }
  const localConnect = await call(settingsHandler, local("POST", "/api/settings/cloud/connect", {
    body: { revision: revisionOf(runtimeStartup), cloudUrl: "https://cloud.example" },
  }));
  assert.equal(localConnect.status, 200);
  assert.equal(cloud.calls.beginConnect, 1);
});

// ---- T6 class-1 credentials stay write-only over the remote plane ---------------------------------

test("T6 credentials over the remote plane: masked GET, MASK keeps, value replaces, null clears, export omits", async (t) => {
  const runtimeStartup = initFile(t);
  const settingsHandler = handler();
  const read = await call(settingsHandler, serve("GET", "/api/settings"));
  assert.deepEqual(read.json.fields.soniox_api_key, { state: "set", value: MASK });
  assert.equal(read.text.includes(SONIOX_VALUE), false);

  assert.equal((await remotePut(settingsHandler, runtimeStartup, { soniox_api_key: MASK, agent_name: "Keep" })).status, 200);
  assert.equal(JSON.parse(configBytes(runtimeStartup)).stt.sonioxApiKey, SONIOX_VALUE);

  const replaced = await remotePut(settingsHandler, runtimeStartup, { soniox_api_key: "k-test-new" });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.text.includes("k-test-new"), false);
  assert.equal(JSON.parse(configBytes(runtimeStartup)).stt.sonioxApiKey, "k-test-new");

  const exported = await call(settingsHandler, serve("GET", "/api/settings/export"));
  assert.equal(exported.status, 200);
  assert.equal(Object.hasOwn(exported.json.settings, "soniox_api_key"), false);
  assert.equal(exported.text.includes("k-test-new"), false);

  const cleared = await remotePut(settingsHandler, runtimeStartup, { soniox_api_key: null });
  assert.equal(cleared.status, 200);
  assert.equal(Object.hasOwn(JSON.parse(configBytes(runtimeStartup)).stt, "sonioxApiKey"), false);
  assert.deepEqual(cleared.json.fields.soniox_api_key, { state: "unset", value: "" });
});

// ---- T7 surfaces outside the settings plane are untouched -----------------------------------------

test("T7 public surfaces are not handled by the settings plane, switch on or off, for any caller", async (t) => {
  const paths = ["/", "/health", "/info", "/readiness", "/join-meeting", "/leave-meeting", "/session/abc", "/local-avatar/x/index.html", "/calibrate", "/settingsx", "/api/settingsx"];
  for (const switchValue of [true, false]) {
    initFile(t, { remoteSettingsAccess: switchValue });
    const settingsHandler = handler();
    for (const url of paths) {
      for (const req of [
        local("GET", url),
        serve("GET", url),
        serve("POST", url, { body: {} }),
        buildRequest("GET", url, [["Host", "meetmate.ngrok.example"], ["X-Forwarded-For", "203.0.113.9"]], { socket: { remoteAddress: "127.0.0.1" } }),
      ]) {
        const result = await call(settingsHandler, req);
        assert.equal(result.handled, false, `${url} switch ${switchValue}`);
        assert.equal(result.status, null, `${url} switch ${switchValue}`);
      }
    }
  }
});

// ---- T8 registry rows ------------------------------------------------------------------------------

test("T8 registry: two live, non-transferable detail rows next to public_origin, no alias", () => {
  const ids = SETTINGS_REGISTRY.map((entry) => entry.id);
  assert.equal(ids.indexOf("settings_remote_access"), ids.indexOf("public_origin") + 1);
  assert.equal(ids.indexOf("settings_remote_login"), ids.indexOf("public_origin") + 2);
  const shape = (id) => {
    const { schema: _schema, ...rest } = REGISTRY_BY_ID[id];
    return rest;
  };
  assert.deepEqual(shape("settings_remote_access"), {
    id: "settings_remote_access", path: "server.remoteSettingsAccess", ux: "detail", credential: "none", apply: "live", envAlias: null,
    defaultValue: false, requiredWhen: null, writeSurface: "settings", transferable: false, multiline: false, visibleWhen: null,
  });
  assert.deepEqual(shape("settings_remote_login"), {
    id: "settings_remote_login", path: "server.remoteSettingsLogin", ux: "detail", credential: "none", apply: "live", envAlias: null,
    defaultValue: "", requiredWhen: null, writeSurface: "settings", transferable: false, multiline: false, visibleWhen: null,
  });
  const pin = REGISTRY_BY_ID.settings_remote_login.schema;
  assert.equal(pin.safeParse("").success, true);
  assert.equal(pin.parse("  a@b.c "), "a@b.c");
  assert.equal(pin.safeParse("x".repeat(254)).success, true);
  assert.equal(pin.safeParse("x".repeat(255)).success, false);
  assert.equal(REGISTRY_BY_ID.settings_remote_access.schema.safeParse("true").success, false);
});

test("T8 transferable:false — neither row is exported or importable", async (t) => {
  const runtimeStartup = initFile(t, { remoteSettingsLogin: LOGIN });
  const settingsHandler = handler();
  const exported = await exportedDocument(settingsHandler);
  assert.equal(Object.hasOwn(exported.settings, "settings_remote_access"), false);
  assert.equal(Object.hasOwn(exported.settings, "settings_remote_login"), false);
  const before = configBytes(runtimeStartup);
  for (const settings of [{ settings_remote_access: false }, { settings_remote_login: "" }]) {
    const result = await call(settingsHandler, local("POST", "/api/settings/import", {
      body: { revision: revisionOf(runtimeStartup), document: { format: "meetmate-settings", version: 1, exportedAt: "2026-10-06T00:00:00.000Z", settings } },
    }));
    assert.equal(result.status, 422, JSON.stringify(settings));
    assert.equal(configBytes(runtimeStartup), before);
  }
});

test("T8 docs: config.json.example lists both paths; the setup guide states the precondition without real host data", () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json.example"), "utf8"));
  assert.equal(example.server.remoteSettingsAccess, false);
  assert.equal(example.server.remoteSettingsLogin, "");
  const guide = fs.readFileSync(path.join(ROOT, "docs/setup-guide.md"), "utf8");
  const section = guide.slice(guide.indexOf("#### 外から設定を変える（Tailscale Serve）"), guide.indexOf("### Gateway URL の制約"));
  assert.ok(section.length > 0, "the setup-guide subsection exists inside アクセス制限");
  for (const phrase of ["Funnel", "1.102.2", "タグ", "スクリプト", "共有"]) assert.equal(section.includes(phrase), true, phrase);
  assert.doesNotMatch(section, /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i, "placeholders only, no real tailnet name");
  const contract = fs.readFileSync(path.join(ROOT, "docs/settings-contract.md"), "utf8");
  for (const code of ["SETTINGS_REMOTE_FIELD_LOCKED", "SETTINGS_REMOTE_LOCAL_ONLY", "remoteAccess", "R0", "R6"]) {
    assert.equal(contract.includes(code), true, code);
  }
});
