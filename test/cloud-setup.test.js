"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");

const { createCloudSetup, refreshHubConfigIfStale, _test } = require("../src/cloud-setup");
const { MASK } = require("../src/settings/registry");
const { initializeRuntime, resetRuntimeForTest } = require("../src/settings/resolver");
const { createSettingsHandler } = require("../src/settings/routes");
const { readConfigState, saveFields } = require("../src/settings/store");

const INSTALLATION = Object.freeze({
  installation_id: "installation-190",
  hub_token: "cati_hub_secret",
  hub_url: "wss://hub.example.test/ws",
  plan_id: "hub_personal",
  room_salt: "room-salt-secret",
  room_salt_version: "v4",
  expires_at: "2026-12-04T00:00:00Z",
});

const HERMETIC_READINESS = Object.freeze({
  configure() {},
  async probeGateSystems() {},
  async probeSystem() { return { ok: false, code: "NOT_CONFIGURED" }; },
});

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = "") { this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
  };
}

function request(method, url, body) {
  const bytes = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(bytes ? [Buffer.from(bytes)] : []);
  Object.assign(req, {
    method,
    url,
    headers: {
      host: "localhost:5005",
      ...(method === "GET" ? {} : {
        origin: "http://localhost:5005",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      }),
    },
    socket: { localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

function fixture(t, document, handlerOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cloud-setup-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  const state = readConfigState(configPath);
  resetRuntimeForTest();
  initializeRuntime({
    state,
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: directory,
      configPath,
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
  });
  t.after(() => {
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    configPath,
    revision: state.revision,
    handler: createSettingsHandler({ port: 5005, readinessController: HERMETIC_READINESS, ...handlerOptions }),
  };
}

async function invoke(handler, method, url, body) {
  const res = response();
  await handler(request(method, url, body), res);
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

function fakeServerFactory() {
  const servers = [];
  let nextPort = 41000;
  return {
    servers,
    createServer(handler) {
      const server = new EventEmitter();
      server.handler = handler;
      server.closed = false;
      server.port = nextPort++;
      server.listen = (_port, host, callback) => {
        server.listenHost = host;
        queueMicrotask(callback);
      };
      server.address = () => ({ port: server.port, address: server.listenHost });
      server.close = (callback) => {
        server.closed = true;
        queueMicrotask(() => callback?.());
      };
      server.dispatch = (url, { abort = false } = {}) => new Promise((resolve, reject) => {
        if (server.closed) return reject(new Error("server closed"));
        const res = {
          status: null,
          body: "",
          writeHead(status) { this.status = status; },
          end(chunk = "", callback) {
            this.body += String(chunk);
            if (!abort) callback?.();
            resolve({ status: this.status, text: this.body });
          },
        };
        handler({ method: "GET", url }, res);
      });
      servers.push(server);
      return server;
    },
  };
}

test("PKCE callback rejects the wrong state, accepts one setup code, and then closes", async () => {
  let openedUrl;
  const fake = fakeServerFactory();
  const cloud = createCloudSetup({ openUrl(url) { openedUrl = url; }, createServer: fake.createServer });
  const session = await cloud.beginConnect({ cloudUrl: "https://cloud.example.test" });
  const authorize = new URL(session.authorizeUrl);
  assert.equal(openedUrl, session.authorizeUrl);
  assert.equal(authorize.pathname, "/v1/auth/google/start");
  assert.match(authorize.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("state").length >= 22);
  assert.equal(authorize.searchParams.get("redirect_uri"), `http://127.0.0.1:${session.port}/hub/callback`);
  assert.match(session.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  const wrong = await fake.servers[0].dispatch("/hub/callback?setup_code=wrong&state=wrong");
  assert.equal(wrong.status, 400);
  const callback = new URL(authorize.searchParams.get("redirect_uri"));
  callback.searchParams.set("setup_code", "setup-once");
  callback.searchParams.set("state", authorize.searchParams.get("state"));
  const accepted = await fake.servers[0].dispatch(`${callback.pathname}${callback.search}`);
  assert.equal(accepted.status, 200);
  assert.match(accepted.text, /close this window/i);
  const completion = await session.completion;
  assert.equal(completion.ok, true);
  assert.equal(completion.setupCode, "setup-once");
  assert.match(completion.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(fake.servers[0].dispatch(`${callback.pathname}${callback.search}`));
});

test("loopback bind and redirect ignore a caller-supplied host override", async () => {
  const fake = fakeServerFactory();
  const cloud = createCloudSetup({
    listenHost: "0.0.0.0",
    openUrl() {},
    createServer: fake.createServer,
  });
  const session = await cloud.beginConnect({ cloudUrl: "https://cloud.example.test" });
  assert.equal(fake.servers[0].address().address, "127.0.0.1");
  assert.equal(new URL(session.authorizeUrl).searchParams.get("redirect_uri"),
    `http://127.0.0.1:${session.port}/hub/callback`);
  session.cancel();
  await session.completion;
});

test("provider callback errors render failure, skip exchange, and close the listener", async () => {
  let fetches = 0;
  const fake = fakeServerFactory();
  const cloud = createCloudSetup({
    openUrl() {},
    createServer: fake.createServer,
    fetchFn: async () => { fetches += 1; throw new Error("must not exchange"); },
  });
  const session = await cloud.beginConnect({ cloudUrl: "https://cloud.example.test" });
  const authorize = new URL(session.authorizeUrl);
  const callback = `/hub/callback?error=access_denied&state=${encodeURIComponent(authorize.searchParams.get("state"))}`;
  const response = await fake.servers[0].dispatch(callback);
  assert.equal(response.status, 400);
  assert.match(response.text, /access_denied/);
  assert.match(response.text, /retry/i);
  assert.deepEqual(await session.completion, {
    ok: false, error: "access_denied", code: "SETTINGS_CLOUD_CONNECT_FAILED",
  });
  assert.equal(fake.servers[0].closed, true);
  assert.equal(fetches, 0);
});

test("aborted callback response still closes the listener and resolves completion", async () => {
  const fake = fakeServerFactory();
  const cloud = createCloudSetup({ openUrl() {}, createServer: fake.createServer });
  const session = await cloud.beginConnect({ cloudUrl: "https://cloud.example.test" });
  const authorize = new URL(session.authorizeUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri"));
  callback.searchParams.set("setup_code", "setup-after-abort");
  callback.searchParams.set("state", authorize.searchParams.get("state"));
  await fake.servers[0].dispatch(`${callback.pathname}${callback.search}`, { abort: true });
  assert.equal(fake.servers[0].closed, true);
  assert.equal((await session.completion).setupCode, "setup-after-abort");
});

test("loopback listener closes at the authorize TTL", async () => {
  const fake = fakeServerFactory();
  const cloud = createCloudSetup({ openUrl() {}, authorizeTtlMs: 20, createServer: fake.createServer });
  const session = await cloud.beginConnect({ cloudUrl: "https://cloud.example.test" });
  assert.deepEqual(await session.completion, {
    ok: false, error: "timeout", code: "SETTINGS_CLOUD_CONNECT_TIMEOUT",
  });
  await assert.rejects(fake.servers[0].dispatch("/hub/callback"));
});

test("installation exchange sends exact PKCE body and maps all seven response fields", async () => {
  let observed;
  let logged;
  const cloud = createCloudSetup({
    logger: { info(entry) { logged = entry; } },
    fetchFn: async (url, options) => {
      observed = { url, options };
      return new Response(JSON.stringify(INSTALLATION), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await cloud.completeConnect({
    cloudUrl: "https://cloud.example.test/", setupCode: "one-time", codeVerifier: "v".repeat(43),
  });
  assert.deepEqual(result, INSTALLATION);
  assert.equal(observed.url, "https://cloud.example.test/v1/hub/installations");
  assert.equal(observed.options.method, "POST");
  assert.deepEqual(JSON.parse(observed.options.body), { setup_code: "one-time", code_verifier: "v".repeat(43) });
  assert.equal(observed.options.headers.Authorization, undefined);
  assert.deepEqual(logged, {
    event: "cloud_installation_connected",
    token_id: _test.tokenId(INSTALLATION.hub_token),
  });
  assert.match(logged.token_id, /^[a-f0-9]{8}$/);
  assert.equal(JSON.stringify(logged).includes(INSTALLATION.hub_token), false);
});

test("installation exchange propagates a 401 problem type", async () => {
  const cloud = createCloudSetup({
    fetchFn: async () => new Response(JSON.stringify({ type: "urn:caty:auth:setup-code-invalid" }), {
      status: 401, headers: { "Content-Type": "application/problem+json" },
    }),
  });
  assert.deepEqual(await cloud.completeConnect({
    cloudUrl: "https://cloud.example.test", setupCode: "expired", codeVerifier: "v".repeat(43),
  }), { ok: false, status: 401, type: "urn:caty:auth:setup-code-invalid" });
});

test("fresh hub config cache is a no-op", async () => {
  let fetches = 0;
  const result = await refreshHubConfigIfStale({
    cloudUrl: "https://cloud.example.test",
    hubToken: INSTALLATION.hub_token,
    configRefreshedAt: "2026-09-05T00:00:00.000Z",
    now: () => Date.parse("2026-09-05T23:59:59.000Z"),
    fetchFn: async () => { fetches += 1; },
  });
  assert.deepEqual(result, { ok: true, refreshed: false, stale: false });
  assert.equal(fetches, 0);
});

test("stale hub config cache refetches and returns the new expiry inputs", async () => {
  let fetches = 0;
  const result = await refreshHubConfigIfStale({
    cloudUrl: "https://cloud.example.test",
    hubToken: INSTALLATION.hub_token,
    configRefreshedAt: "2026-09-04T00:00:00.000Z",
    now: () => Date.parse("2026-09-05T00:00:00.000Z"),
    fetchFn: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        hub_url: INSTALLATION.hub_url,
        room_salt: INSTALLATION.room_salt,
        room_salt_version: INSTALLATION.room_salt_version,
        refresh_after_s: 86400,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(fetches, 1);
  assert.equal(result.refreshed, true);
  assert.equal(result.configRefreshedAt, "2026-09-05T00:00:00.000Z");
  assert.equal(result.refreshAfterSeconds, 86400);
  assert.equal(result.config.hub_url, INSTALLATION.hub_url);
});

test("stale hub config failure reports lastError without replacing last-good", async () => {
  const result = await refreshHubConfigIfStale({
    cloudUrl: "https://cloud.example.test",
    hubToken: INSTALLATION.hub_token,
    configRefreshedAt: "2026-09-04T00:00:00.000Z",
    now: () => Date.parse("2026-09-05T00:00:00.000Z"),
    fetchFn: async () => new Response(JSON.stringify({ type: "urn:caty:unavailable" }), {
      status: 503, headers: { "Content-Type": "application/problem+json" },
    }),
  });
  assert.deepEqual(result, {
    ok: false,
    refreshed: false,
    stale: true,
    lastError: "urn:caty:unavailable",
  });
});

test("settings cloud status and settings GET never expose token or room salt", { concurrency: false }, async (t) => {
  const { handler } = fixture(t, { hub: {
    cloudUrl: "https://cloud.example.test",
    token: INSTALLATION.hub_token,
    installationId: INSTALLATION.installation_id,
    cloudHubUrl: INSTALLATION.hub_url,
    roomSalt: INSTALLATION.room_salt,
    roomSaltVersion: INSTALLATION.room_salt_version,
    planId: INSTALLATION.plan_id,
    expiresAt: INSTALLATION.expires_at,
    configRefreshedAt: "2026-09-05T00:00:00.000Z",
  } }, { cloudSetup: {}, cloud: { now: () => Date.parse("2026-09-05T12:00:00.000Z") } });
  const status = await invoke(handler, "GET", "/api/settings/cloud/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.connected, true);
  assert.deepEqual(Object.keys(status.json).sort(), [
    "config_refreshed_at", "connected", "expires_at", "hub_url",
    "installation_id", "plan_id", "room_salt_version",
  ]);
  assert.equal(status.json.plan_id, INSTALLATION.plan_id);
  assert.equal(status.json.installation_id, INSTALLATION.installation_id);
  assert.equal(status.json.hub_url, INSTALLATION.hub_url);
  assert.equal(status.json.room_salt_version, INSTALLATION.room_salt_version);
  assert.equal(status.json.expires_at, INSTALLATION.expires_at);
  assert.equal(Object.hasOwn(status.json, "token"), false);
  assert.equal(Object.hasOwn(status.json, "hubToken"), false);
  assert.equal(Object.hasOwn(status.json, "roomSalt"), false);
  assert.equal(status.body.includes(INSTALLATION.hub_token), false);
  assert.equal(status.body.includes(INSTALLATION.room_salt), false);

  const settings = await invoke(handler, "GET", "/api/settings");
  assert.deepEqual(settings.json.fields.hub_token, { state: "set", value: MASK });
  assert.deepEqual(settings.json.fields.hub_room_salt, { state: "set", value: MASK });
  assert.equal(settings.body.includes(INSTALLATION.hub_token), false);
  assert.equal(settings.body.includes(INSTALLATION.room_salt), false);
});

test("concurrent connect requests start one listener and reject the second", { concurrency: false }, async (t) => {
  const fake = fakeServerFactory();
  const { handler, revision } = fixture(t, { hub: { cloudUrl: "https://cloud.example.test" } }, {
    cloud: { openUrl() {}, authorizeTtlMs: 5_000, createServer: fake.createServer },
  });
  const [first, second] = await Promise.all([
    invoke(handler, "POST", "/api/settings/cloud/connect", { revision }),
    invoke(handler, "POST", "/api/settings/cloud/connect", { revision }),
  ]);
  assert.equal(first.status, 200, first.body);
  const authorize = new URL(first.json.authorizeUrl);
  for (const name of ["redirect_uri", "code_challenge", "code_challenge_method", "state"]) {
    assert.ok(authorize.searchParams.get(name), name);
  }
  assert.equal(second.status, 409, second.body);
  assert.equal(second.json.error.code, "SETTINGS_CLOUD_CONNECT_IN_PROGRESS");
  assert.equal(fake.servers.length, 1);
  const pending = await invoke(handler, "GET", "/api/settings/cloud/status");
  assert.equal(pending.json.connected, false);
  assert.equal(Object.hasOwn(pending.json, "pending"), false);
  const stopped = await invoke(handler, "POST", "/api/settings/cloud/disconnect", { revision, force: true });
  assert.equal(stopped.status, 200, stopped.body);
});

test("connect route enforces a one-second minimum interval", { concurrency: false }, async (t) => {
  let starts = 0;
  const { handler, revision } = fixture(t, { hub: { cloudUrl: "https://cloud.example.test" } }, {
    cloud: { now: () => 1_000 },
    cloudSetup: {
      async beginConnect() {
        starts += 1;
        return {
          authorizeUrl: "https://cloud.example.test/start",
          expiresAt: "2026-09-05T00:10:00.000Z",
          completion: Promise.resolve({ ok: false, error: "access_denied" }),
          cancel() {},
        };
      },
    },
  });
  assert.equal((await invoke(handler, "POST", "/api/settings/cloud/connect", { revision })).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const retry = await invoke(handler, "POST", "/api/settings/cloud/connect", { revision });
  assert.equal(retry.status, 429, retry.body);
  assert.equal(retry.json.error.code, "SETTINGS_CLOUD_CONNECT_RATE_LIMITED");
  assert.equal(starts, 1);
});

test("valid callback is exchanged immediately and persists the cloud installation", { concurrency: false }, async (t) => {
  const fake = fakeServerFactory();
  let exchangeBody;
  const { handler, revision, configPath } = fixture(t, { hub: { cloudUrl: "https://cloud.example.test" } }, {
    cloud: {
      openUrl() {},
      createServer: fake.createServer,
      now: () => Date.parse("2026-09-05T12:00:00.000Z"),
      fetchFn: async (_url, options) => {
        exchangeBody = JSON.parse(options.body);
        return new Response(JSON.stringify(INSTALLATION), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  });
  const connect = await invoke(handler, "POST", "/api/settings/cloud/connect", { revision });
  const authorize = new URL(connect.json.authorizeUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri"));
  callback.searchParams.set("setup_code", "setup-immediate");
  callback.searchParams.set("state", authorize.searchParams.get("state"));
  assert.equal((await fake.servers[0].dispatch(`${callback.pathname}${callback.search}`)).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchangeBody.setup_code, "setup-immediate");
  assert.match(exchangeBody.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(readConfigState(configPath).parsed, { hub: {
    cloudUrl: "https://cloud.example.test",
    token: INSTALLATION.hub_token,
    installationId: INSTALLATION.installation_id,
    cloudHubUrl: INSTALLATION.hub_url,
    roomSalt: INSTALLATION.room_salt,
    roomSaltVersion: INSTALLATION.room_salt_version,
    planId: INSTALLATION.plan_id,
    expiresAt: INSTALLATION.expires_at,
    configRefreshedAt: "2026-09-05T12:00:00.000Z",
    configRefreshAfterSeconds: 86400,
  } });
  const status = await invoke(handler, "GET", "/api/settings/cloud/status");
  assert.equal(status.json.connected, true);
  assert.equal(Object.hasOwn(status.json, "pending"), false);
});

test("connect completion survives an unrelated settings revision change", { concurrency: false }, async (t) => {
  const fake = fakeServerFactory();
  const { handler, revision, configPath } = fixture(t, {
    summary: { enabled: true },
    hub: { cloudUrl: "https://cloud.example.test" },
  }, {
    cloud: {
      openUrl() {},
      createServer: fake.createServer,
      now: () => Date.parse("2026-09-05T12:00:00.000Z"),
      fetchFn: async () => new Response(JSON.stringify(INSTALLATION), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    },
  });
  const connect = await invoke(handler, "POST", "/api/settings/cloud/connect", { revision });
  saveFields({ configPath, revision, fields: { summary_enabled: false } });
  const authorize = new URL(connect.json.authorizeUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri"));
  callback.searchParams.set("setup_code", "setup-after-settings-edit");
  callback.searchParams.set("state", authorize.searchParams.get("state"));
  await fake.servers[0].dispatch(`${callback.pathname}${callback.search}`);
  await new Promise((resolve) => setImmediate(resolve));
  const stored = readConfigState(configPath).parsed;
  assert.equal(stored.summary.enabled, false);
  assert.equal(stored.hub.token, INSTALLATION.hub_token);
  assert.equal(stored.hub.cloudHubUrl, INSTALLATION.hub_url);
});

test("successful config refresh atomically replaces cached hub values", { concurrency: false }, async (t) => {
  let authorization;
  const { handler, revision, configPath } = fixture(t, { hub: {
    cloudUrl: "https://cloud.example.test", token: INSTALLATION.hub_token,
    installationId: INSTALLATION.installation_id, cloudHubUrl: "wss://old.example.test/ws",
    roomSalt: "old-salt", roomSaltVersion: "v3", planId: INSTALLATION.plan_id,
    expiresAt: INSTALLATION.expires_at,
    configRefreshedAt: "2026-09-04T00:00:00.000Z",
  } }, {
    cloud: {
      now: () => Date.parse("2026-09-05T13:00:00.000Z"),
      fetchFn: async (_url, options) => {
        authorization = options.headers.Authorization;
        return new Response(JSON.stringify({
          hub_url: INSTALLATION.hub_url,
          room_salt: INSTALLATION.room_salt,
          room_salt_version: INSTALLATION.room_salt_version,
          refresh_after_s: 86400,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  });
  const result = await invoke(handler, "POST", "/api/settings/cloud/refresh", { revision });
  assert.equal(result.status, 200, result.body);
  assert.equal(result.json.refreshAfterSeconds, 86400);
  assert.equal(authorization, `Bearer ${INSTALLATION.hub_token}`);
  assert.deepEqual(readConfigState(configPath).parsed, { hub: {
    cloudUrl: "https://cloud.example.test", token: INSTALLATION.hub_token,
    installationId: INSTALLATION.installation_id, cloudHubUrl: INSTALLATION.hub_url,
    roomSalt: INSTALLATION.room_salt, roomSaltVersion: INSTALLATION.room_salt_version,
    planId: INSTALLATION.plan_id, expiresAt: INSTALLATION.expires_at,
    configRefreshedAt: "2026-09-05T13:00:00.000Z",
    configRefreshAfterSeconds: 86400,
  } });
});

test("status refreshes stale hub config and persists the new cache timestamp", { concurrency: false }, async (t) => {
  let fetches = 0;
  const { handler, configPath } = fixture(t, { hub: {
    cloudUrl: "https://cloud.example.test", token: INSTALLATION.hub_token,
    installationId: INSTALLATION.installation_id, cloudHubUrl: "wss://old.example.test/ws",
    roomSalt: "old-salt", roomSaltVersion: "v3", planId: INSTALLATION.plan_id,
    expiresAt: INSTALLATION.expires_at,
    configRefreshedAt: "2026-09-04T00:00:00.000Z",
  } }, {
    cloud: {
      now: () => Date.parse("2026-09-05T00:00:00.000Z"),
      fetchFn: async () => {
        fetches += 1;
        return new Response(JSON.stringify({
          hub_url: INSTALLATION.hub_url,
          room_salt: INSTALLATION.room_salt,
          room_salt_version: INSTALLATION.room_salt_version,
          refresh_after_s: 86400,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  });
  const status = await invoke(handler, "GET", "/api/settings/cloud/status");
  assert.equal(status.status, 200, status.body);
  assert.equal(fetches, 1);
  assert.equal(status.json.hub_url, INSTALLATION.hub_url);
  const stored = readConfigState(configPath).parsed.hub;
  assert.equal(stored.cloudHubUrl, INSTALLATION.hub_url);
  assert.equal(stored.roomSalt, INSTALLATION.room_salt);
  assert.equal(stored.configRefreshedAt, "2026-09-05T00:00:00.000Z");
  assert.equal(stored.configRefreshAfterSeconds, 86400);
});

test("failed config refresh preserves the stored last-good hub configuration", { concurrency: false }, async (t) => {
  const original = { hub: {
    cloudUrl: "https://cloud.example.test", token: INSTALLATION.hub_token,
    installationId: INSTALLATION.installation_id, cloudHubUrl: INSTALLATION.hub_url,
    roomSalt: INSTALLATION.room_salt, roomSaltVersion: INSTALLATION.room_salt_version,
    planId: INSTALLATION.plan_id, expiresAt: INSTALLATION.expires_at,
    configRefreshedAt: "2026-09-04T00:00:00.000Z",
  } };
  const { handler, revision, configPath } = fixture(t, original, {
    cloudSetup: createCloudSetup({ fetchFn: async () => new Response(JSON.stringify({ type: "urn:caty:unavailable" }), {
      status: 503, headers: { "Content-Type": "application/problem+json" },
    }) }),
  });
  const result = await invoke(handler, "POST", "/api/settings/cloud/refresh", { revision });
  assert.equal(result.status, 502, result.body);
  assert.deepEqual(readConfigState(configPath).parsed, original);
  const status = await invoke(handler, "GET", "/api/settings/cloud/status");
  assert.equal(Object.hasOwn(status.json, "lastError"), false);
});

for (const remoteStatus of [204, 404]) {
  test(`disconnect ${remoteStatus} wipes cloud identity but preserves shared settings`, { concurrency: false }, async (t) => {
    const { handler, revision, configPath } = fixture(t, { keep: true, hub: {
      cloudUrl: "https://cloud.example.test", token: INSTALLATION.hub_token,
      installationId: INSTALLATION.installation_id, cloudHubUrl: INSTALLATION.hub_url,
      roomSalt: INSTALLATION.room_salt, roomSaltVersion: INSTALLATION.room_salt_version,
      planId: INSTALLATION.plan_id, expiresAt: INSTALLATION.expires_at,
      configRefreshedAt: "2026-09-04T00:00:00.000Z",
      url: "wss://shared.example.test/ws", roomCode: "shared-room", sharedToken: "shared-token",
    } }, {
      cloudSetup: createCloudSetup({ fetchFn: async () => new Response(null, { status: remoteStatus }) }),
    });
    const result = await invoke(handler, "POST", "/api/settings/cloud/disconnect", { revision });
    assert.equal(result.status, 200, result.body);
    assert.deepEqual(readConfigState(configPath).parsed, { keep: true, hub: {
      cloudUrl: "https://cloud.example.test",
      url: "wss://shared.example.test/ws",
      roomCode: "shared-room",
      sharedToken: "shared-token",
    } });
  });
}

test("disconnect failure keeps credentials unless force is confirmed", { concurrency: false }, async (t) => {
  const original = { hub: {
    cloudUrl: "https://cloud.example.test", token: INSTALLATION.hub_token,
    installationId: INSTALLATION.installation_id, cloudHubUrl: INSTALLATION.hub_url,
    roomSalt: INSTALLATION.room_salt, roomSaltVersion: INSTALLATION.room_salt_version,
    planId: INSTALLATION.plan_id, expiresAt: INSTALLATION.expires_at,
    configRefreshedAt: "2026-09-04T00:00:00.000Z",
  } };
  const { handler, revision, configPath } = fixture(t, original, {
    cloudSetup: { async disconnect() { return { ok: false, status: 500 }; } },
  });
  const refused = await invoke(handler, "POST", "/api/settings/cloud/disconnect", { revision });
  assert.equal(refused.status, 502, refused.body);
  assert.deepEqual(readConfigState(configPath).parsed, original);
  const forced = await invoke(handler, "POST", "/api/settings/cloud/disconnect", { revision, force: true });
  assert.equal(forced.status, 200, forced.body);
  assert.deepEqual(readConfigState(configPath).parsed, { hub: { cloudUrl: "https://cloud.example.test" } });
});
