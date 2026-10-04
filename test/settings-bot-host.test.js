"use strict";

// #260 PR B: the bot host setting (Attendee cloud / self-hosted Attendee). Design v2.2 §9 rows
// T1, T2, T7, T9, T10, T13, T14, T16, T17, T18 and re-base delta v2.1 T21.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { Readable } = require("node:stream");

const { SETTINGS_REGISTRY, REGISTRY_BY_ID, MASK } = require("../src/settings/registry");
const resolver = require("../src/settings/resolver");
const { createReadinessController } = require("../src/settings/readiness");
const { isPrivateAddress, resolveBotHostTarget } = require("../src/attendee-endpoint");

const ROOT = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
// Distinct sentinel values per slot; short identifiers (commit guard).
const KEY_C = "SENTINEL-CLOUD-c1";
const KEY_S = "SENTINEL-SELF-s1";
const KEY_S2 = "SENTINEL-SELF-s2";
const CLOUD_HOST = "attendee-cloud.example";
const SELF_URL = "https://attendee.self.example:8443/base";

function startup(directory) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: "gateway-secret", openaiApiKey: "" }),
  });
}

function settingsDocument({ botHost, cloudHost = CLOUD_HOST, cloudKey = KEY_C, selfUrl = SELF_URL, selfKey = KEY_S } = {}) {
  const attendee = { baseUrl: cloudHost };
  if (cloudKey !== null) attendee.apiKey = cloudKey;
  const selfHosted = {};
  if (selfUrl !== null) selfHosted.url = selfUrl;
  if (selfKey !== null) selfHosted.apiKey = selfKey;
  attendee.selfHosted = selfHosted;
  if (botHost !== undefined) attendee.host = botHost;
  return {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "main" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-secret" },
    tts: { provider: "fish-audio", apiKey: "fish-secret", voiceId: "voice-id" },
    attendee,
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
  };
}

// A committed config file (connection tests and imports need a real revision).
function initFile(t, options = {}) {
  const { readConfigState } = require("../src/settings/store");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-bot-host-"));
  t.after(() => {
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const runtimeStartup = startup(directory);
  fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify(settingsDocument(options))}\n`, { mode: 0o600 });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({ state: readConfigState(runtimeStartup.configPath), startup: runtimeStartup, serverPort: 5005 });
  return runtimeStartup;
}

function initMemory(t, options = {}) {
  t.after(() => resolver.resetRuntimeForTest());
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: settingsDocument(options), revision: "a".repeat(64), fingerprint: "bot-host" },
    startup: startup(path.join(os.tmpdir(), "meetmate-bot-host-memory")),
    serverPort: 5005,
  });
}

function publish(options) {
  resolver.publishState({ exists: true, valid: true, parsed: settingsDocument(options), revision: "b".repeat(64), fingerprint: "bot-host-2" });
}

function settingsRequest(method, url, body) {
  const bytes = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(bytes ? [Buffer.from(bytes)] : []);
  Object.assign(req, {
    method,
    url,
    headers: {
      host: "localhost:5005",
      ...(method === "GET" ? {} : { origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json" }),
    },
    socket: { localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

async function call(handler, method, url, body) {
  const res = {
    status: null,
    body: "",
    writeHead(status) { this.status = status; },
    end(chunk = "") { this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
  };
  await handler(settingsRequest(method, url, body), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non-JSON bodies are compared as text */ }
  return { status: res.status, text: res.body, json };
}

// ---- T1 registry -------------------------------------------------------------------------------

test("T1 registry: the four entries, their shape and order; counts 102 / class-1 11; no existing entry changed", () => {
  const ids = SETTINGS_REGISTRY.map((entry) => entry.id);
  assert.equal(SETTINGS_REGISTRY.length, 102);
  assert.equal(SETTINGS_REGISTRY.filter((entry) => entry.credential === "class-1").length, 11);
  const shape = (id) => {
    const { schema: _schema, ...rest } = REGISTRY_BY_ID[id];
    return rest;
  };
  assert.deepEqual(shape("bot_host"), {
    id: "bot_host", path: "attendee.host", ux: "basic", credential: "none", apply: "next-join", envAlias: null,
    defaultValue: "attendee-cloud", requiredWhen: null, writeSurface: "settings", transferable: false, multiline: false, visibleWhen: null,
  });
  assert.deepEqual(REGISTRY_BY_ID.bot_host.schema.options, ["attendee-cloud", "attendee-self-hosted"]);
  assert.deepEqual(shape("attendee_self_hosted_url"), {
    id: "attendee_self_hosted_url", path: "attendee.selfHosted.url", ux: "basic", credential: "none", apply: "next-join", envAlias: null,
    defaultValue: "", requiredWhen: { transport: ["meet", "zoom"] }, writeSurface: "settings", transferable: false, multiline: false,
    visibleWhen: { id: "bot_host", value: "attendee-self-hosted" },
  });
  assert.deepEqual(shape("attendee_self_hosted_api_key"), {
    id: "attendee_self_hosted_api_key", path: "attendee.selfHosted.apiKey", ux: "basic", credential: "class-1", apply: "next-join", envAlias: null,
    requiredWhen: { transport: ["meet", "zoom"] }, writeSurface: "settings", transferable: true, multiline: false,
    visibleWhen: { id: "bot_host", value: "attendee-self-hosted" },
  });
  assert.deepEqual(shape("face_timeline_offset_ms_self_hosted"), {
    id: "face_timeline_offset_ms_self_hosted", path: "avatar.faceTimelineOffsetMsSelfHosted", ux: "detail", credential: "none", apply: "next-join",
    envAlias: null, defaultValue: 300, requiredWhen: null, writeSurface: "settings", transferable: true, multiline: false,
    visibleWhen: { id: "avatar_experiment", value: "face-package" },
  });
  assert.equal(ids.indexOf("face_timeline_offset_ms_self_hosted"), ids.indexOf("face_audio_default") + 1);
  assert.equal(ids.indexOf("face_audio_default"), ids.indexOf("face_timeline_offset_ms") + 1);
  assert.deepEqual(ids.slice(ids.indexOf("attendee_api_key"), ids.indexOf("attendee_api_key") + 5),
    ["attendee_api_key", "attendee_base_url", "bot_host", "attendee_self_hosted_url", "attendee_self_hosted_api_key"]);
  assert.deepEqual({ ...shape("attendee_base_url") }, {
    id: "attendee_base_url", path: "attendee.baseUrl", ux: "detail", credential: "none", apply: "restart-required",
    envAlias: "ATTENDEE_API_BASE_URL", defaultValue: "app.attendee.dev", requiredWhen: null, writeSurface: "settings", transferable: true,
    multiline: false, visibleWhen: null,
  });
  assert.deepEqual(REGISTRY_BY_ID.attendee_api_key.requiredWhen, { transport: ["meet", "zoom"] });
  for (const offset of [-3000, 0, 3000]) assert.equal(REGISTRY_BY_ID.face_timeline_offset_ms_self_hosted.schema.safeParse(offset).success, true);
  for (const offset of [-3001, 3001, 1.5, "300"]) assert.equal(REGISTRY_BY_ID.face_timeline_offset_ms_self_hosted.schema.safeParse(offset).success, false);
});

// ---- T2 validator and P ------------------------------------------------------------------------

test("T2 validator matrix: https anywhere, http only to private literals or names, shape rules", () => {
  const schema = REGISTRY_BY_ID.attendee_self_hosted_url.schema;
  const accepted = [
    "", "https://attendee.example.com", "https://attendee.example.com:8443/base/path", "https://8.8.8.8", "https://[2001:db8::1]:8443",
    "http://127.0.0.1:8000", "http://127.9.9.9", "http://[::1]:8000", "http://10.1.2.3", "http://172.16.0.1", "http://172.31.255.254",
    "http://192.168.1.20:8000/attendee", "http://100.64.0.1", "http://100.127.255.254", "http://[fc00::1]", "http://[fdab::5]",
    "http://[::ffff:192.168.1.5]", "http://192.168.1.20:65535", "http://localhost:8000", "http://attendee.internal",
  ];
  const rejected = [
    "http://8.8.8.8", "http://100.128.0.1", "http://172.32.0.1", "http://[2001:4860:4860::8888]", "http://169.254.1.1",
    "http://[fe80::1]", "http://0.0.0.0", "http://[::]", "http://[::ffff:8.8.8.8]", "http://224.0.0.1",
    "https://user@attendee.example.com", "https://user:pass@attendee.example.com", "https://attendee.example.com/?q=1",
    "https://attendee.example.com/#frag", "https://attendee.example.com#", "https://attendee.example.com:0", "https://attendee.example.com:65536",
    " https://attendee.example.com", "https://attendee.example.com ", "https://attendee.example.com/", "https://attendee.example.com/base/",
    "ftp://attendee.example.com", "wss://attendee.example.com", "attendee.example.com", `https://a.example/${"x".repeat(2048)}`,
  ];
  for (const value of accepted) assert.equal(schema.safeParse(value).success, true, `accepts ${value}`);
  for (const value of rejected) assert.equal(schema.safeParse(value).success, false, `rejects ${value}`);
});

test("T2 private set P: one implementation; mapped addresses unwrapped; everything else outside", () => {
  const inside = ["127.0.0.1", "127.255.0.9", "::1", "10.0.0.1", "172.16.5.4", "172.31.0.1", "192.168.0.1", "100.64.0.1", "100.127.1.1",
    "fc00::1", "fdff:ffff::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "[::1]"];
  const outside = ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "100.63.255.255", "100.128.0.0", "169.254.1.1", "0.0.0.0", "::",
    "fe80::1", "fe80::1%lo0", "ff02::1", "224.0.0.1", "255.255.255.255", "2001:4860:4860::8888", "::ffff:8.8.8.8", "localhost", "", null, 7];
  for (const address of inside) assert.equal(isPrivateAddress(address), true, String(address));
  for (const address of outside) assert.equal(isPrivateAddress(address), false, String(address));
  assert.equal(read("src/settings/registry.js").includes("isPrivateAddress"), true, "the validator uses the endpoint module's P");
  assert.equal(/function isPrivateAddress/.test(read("src/settings/registry.js")), false, "no second implementation");
});

test("T2 base path: stored without a trailing slash and carried to the target as written", (t) => {
  for (const [url, basePath, port] of [
    ["https://attendee.self.example", "", 443], ["https://attendee.self.example:8443/base", "/base", 8443],
    ["http://192.168.1.20:8000/a/b", "/a/b", 8000], ["http://192.168.1.20", "", 80],
  ]) {
    initMemory(t, { botHost: "attendee-self-hosted", selfUrl: url });
    const target = resolveBotHostTarget({ snapshot: "published" });
    assert.deepEqual([target.basePath, target.port, target.configured], [basePath, port, true], url);
  }
});

// ---- T7 connection test ------------------------------------------------------------------------

test("T7 connection test: the selected slot's saved endpoint and key; GET; redirect error; no endpoint override", async (t) => {
  const { createSettingsHandler } = require("../src/settings/routes");
  const cases = [
    [{ botHost: undefined }, `https://${CLOUD_HOST}/api/v1/bots?page_size=1`, KEY_C],
    [{ botHost: "attendee-cloud" }, `https://${CLOUD_HOST}/api/v1/bots?page_size=1`, KEY_C],
    [{ botHost: "attendee-self-hosted" }, `${SELF_URL}/api/v1/bots?page_size=1`, KEY_S],
    [{ botHost: "attendee-self-hosted", selfUrl: "http://127.0.0.1:8000" }, "http://127.0.0.1:8000/api/v1/bots?page_size=1", KEY_S],
  ];
  for (const [options, url, key] of cases) {
    for (const [status, code] of [[200, "CONNECTED"], [401, "AUTH_FAILED"], [403, "AUTH_FAILED"]]) {
      initFile(t, options);
      const calls = [];
      const handler = createSettingsHandler({
        port: 5005,
        readinessController: createReadinessController(),
        connections: {
          minIntervalMs: 0,
          endpoints: { attendee: "https://override.example/x" },
          fetchFn: async (requestUrl, init) => {
            calls.push({ url: requestUrl, init });
            return new Response(`{"detail":"${key}"}`, { status });
          },
        },
      });
      const envelope = (await call(handler, "GET", "/api/settings")).json;
      const res = await call(handler, "POST", "/api/settings/connections/attendee/test", { revision: envelope.revision });
      const label = `${JSON.stringify(options)} ${status}`;
      assert.equal(res.status, 200, label);
      assert.equal(res.json.code, code, label);
      assert.equal(res.text.includes(key), false, label);
      assert.equal(calls.length, 1, label);
      assert.equal(calls[0].url, url, label);
      assert.deepEqual([calls[0].init.method, calls[0].init.redirect, calls[0].init.headers.Authorization], ["GET", "error", `Token ${key}`], label);
      assert.equal(JSON.stringify(calls[0].init.headers).includes(key === KEY_C ? KEY_S : KEY_C), false, label);
    }
  }
});

test("T7 connection test: unreachable and timeout are reported; an unconfigured selected slot sends nothing", async (t) => {
  const { createSettingsHandler } = require("../src/settings/routes");
  for (const [fetchFn, code] of [
    [async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }, "UNREACHABLE"],
    [(_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))), "TIMEOUT"],
  ]) {
    initFile(t, { botHost: "attendee-self-hosted" });
    const handler = createSettingsHandler({ port: 5005, readinessController: createReadinessController(), connections: { minIntervalMs: 0, timeoutMs: 20, fetchFn } });
    const envelope = (await call(handler, "GET", "/api/settings")).json;
    assert.equal((await call(handler, "POST", "/api/settings/connections/attendee/test", { revision: envelope.revision })).json.code, code);
  }
  initFile(t, { botHost: "attendee-self-hosted", selfKey: null });
  let calls = 0;
  const handler = createSettingsHandler({ port: 5005, readinessController: createReadinessController(), connections: { minIntervalMs: 0, fetchFn: async () => { calls += 1; return new Response("{}"); } } });
  const envelope = (await call(handler, "GET", "/api/settings")).json;
  assert.equal((await call(handler, "POST", "/api/settings/connections/attendee/test", { revision: envelope.revision })).json.code, "NOT_CONFIGURED");
  assert.equal(calls, 0, "the cloud key is never used for an unconfigured self-hosted slot");
});

// ---- T9 probe value source ---------------------------------------------------------------------

test("T9 a staged cloud edit: the probe targets the published value; the join is refused RESTART_REQUIRED whichever host is selected", async (t) => {
  const probes = require("../src/settings/probes");
  for (const botHost of [undefined, "attendee-self-hosted"]) {
    initMemory(t, { botHost, cloudHost: "attendee-boot.example" });
    publish({ botHost, cloudHost: "attendee-staged.example" });
    const urls = [];
    await probes.probeSystem("attendee", { fetchFn: async (url) => { urls.push(url); return new Response("{}"); } });
    if (botHost === undefined) assert.deepEqual(urls, ["https://attendee-staged.example/api/v1/bots?page_size=1"]);
    else assert.deepEqual(urls, [`${SELF_URL}/api/v1/bots?page_size=1`]);
    if (botHost === undefined) assert.equal(resolveBotHostTarget({ snapshot: "effective" }).hostname, "attendee-boot.example", "the join keeps the boot value");
    const controller = createReadinessController({ probeFn: async () => ({ ok: true, code: "CONNECTED" }) });
    for (const system of controller.gateSystems()) controller.setProbeObservation(system, { ok: true, code: "CONNECTED" });
    const state = controller.getReadiness({ transport: "meet", target: resolveBotHostTarget({ snapshot: "effective" }) });
    assert.equal(state.ready, false, String(botHost));
    assert.deepEqual(state.blockers.map(({ system, code, fieldId }) => ({ system, code, fieldId })),
      [{ system: "attendee", code: "RESTART_REQUIRED", fieldId: "attendee_base_url" }], String(botHost));
  }
});

// ---- T10 readiness ids -------------------------------------------------------------------------

// A controller whose probe answers per target (by hostId + key fingerprint) and records the targets it saw.
function idController(answers, clock) {
  const seen = [];
  const controller = createReadinessController({
    now: () => clock.now,
    probeFn: async (system, options) => {
      seen.push({ system, targetId: options.target?.targetId });
      if (system !== "attendee") return { ok: true, code: "CONNECTED" };
      return answers(options.target);
    },
  });
  for (const system of controller.gateSystems().filter((id) => id !== "attendee")) controller.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  return { controller, seen };
}

test("T10 (a)/(b) another target's record is re-probed for the join target; the outcome follows the fresh record", async (t) => {
  for (const [label, before, after] of [
    ["host switch", { botHost: "attendee-cloud" }, { botHost: "attendee-self-hosted" }],
    ["same endpoint, key changed", { botHost: "attendee-self-hosted" }, { botHost: "attendee-self-hosted", selfKey: KEY_S2 }],
  ]) {
    for (const [fresh, expectReady, expectCode] of [
      [{ ok: true, code: "CONNECTED" }, true, null],
      [{ ok: false, code: "PAYMENT_REQUIRED" }, false, "PAYMENT_REQUIRED"],
    ]) {
      initMemory(t, before);
      const clock = { now: 1_000_000 };
      const first = resolveBotHostTarget({ snapshot: "published" });
      const { controller, seen } = idController((target) => (target.targetId === first.targetId ? { ok: false, code: "AUTH_FAILED" } : fresh), clock);
      await controller.probeSystem("attendee", { allowBilling: true });
      assert.equal(controller.inspect("attendee").code, "AUTH_FAILED");
      // No invalidator is attached: the other target's record is still there when the join comes.
      publish(after);
      const joinTarget = resolveBotHostTarget({ snapshot: "effective" });
      assert.notEqual(joinTarget.targetId, first.targetId, label);
      await controller.revalidateForJoin({ transport: "meet", target: joinTarget });
      assert.deepEqual(seen.filter((entry) => entry.system === "attendee").map((entry) => entry.targetId), [first.targetId, joinTarget.targetId], label);
      const state = controller.getReadiness({ transport: "meet", target: joinTarget });
      assert.equal(state.ready, expectReady, `${label} ${fresh.code}`);
      assert.deepEqual(state.blockers.map((blocker) => blocker.code), expectCode ? [expectCode] : [], `${label}: never the other target's AUTH_FAILED`);
    }
  }
});

test("T10 (c)/(d)/(e) a seeded record without an id still applies; a settled SOFT record does not refuse; targetId never leaves", async (t) => {
  initMemory(t, { botHost: "attendee-self-hosted" });
  const clock = { now: 1_000_000 };
  const joinTarget = resolveBotHostTarget({ snapshot: "effective" });
  const seeded = idController(() => assert.fail("a fresh seeded CONNECTED record is not re-probed"), clock);
  seeded.controller.setProbeObservation("attendee", { ok: true, code: "CONNECTED" });
  await seeded.controller.revalidateForJoin({ transport: "meet", target: joinTarget });
  assert.equal(seeded.controller.getReadiness({ transport: "meet", target: joinTarget }).ready, true);
  seeded.controller.setProbeObservation("attendee", { ok: false, code: "AUTH_FAILED" });
  assert.deepEqual(seeded.controller.getReadiness({ transport: "meet", target: joinTarget }).blockers.map((blocker) => blocker.code), ["AUTH_FAILED"]);

  const soft = idController(() => ({ ok: false, code: "UNREACHABLE" }), clock);
  const record = await soft.controller.probeSystem("attendee", { allowBilling: true });
  assert.equal(record.code, "UNREACHABLE");
  await soft.controller.revalidateForJoin({ transport: "meet", target: joinTarget });
  const state = soft.controller.getReadiness({ transport: "meet", target: joinTarget });
  assert.deepEqual([state.ready, state.blockers], [true, []]);
  assert.equal(state.systems.find((system) => system.id === "attendee").code, "UNREACHABLE");

  const outputs = JSON.stringify([record, state, soft.controller.inspect("attendee"), soft.controller.getReadiness()]);
  assert.equal(outputs.includes("targetId"), false);
  assert.equal(outputs.includes(joinTarget.targetId), false);
  assert.equal(outputs.includes("attendee-self-hosted|"), false);
});

test("T10 (f)/(g) a missing record, or another target's record whose re-probe does not settle, is PENDING (503 retry later)", async (t) => {
  initMemory(t, { botHost: "attendee-cloud" });
  const clock = { now: 1_000_000 };
  const joinTarget = resolveBotHostTarget({ snapshot: "effective" });
  const missing = idController(() => assert.fail("a missing record is not probed by the join"), clock);
  await missing.controller.revalidateForJoin({ transport: "meet", target: joinTarget });
  const pending = missing.controller.getReadiness({ transport: "meet", target: joinTarget });
  assert.deepEqual([pending.ready, pending.blockers, pending.systems.find((system) => system.id === "attendee").code], [false, [], "PENDING"]);
  assert.equal(missing.seen.length, 0);

  const first = resolveBotHostTarget({ snapshot: "published" });
  const stalled = idController((target) => (target.targetId === first.targetId ? { ok: false, code: "AUTH_FAILED" } : new Promise(() => {})), clock);
  await stalled.controller.probeSystem("attendee", { allowBilling: true });
  publish({ botHost: "attendee-self-hosted" });
  const other = resolveBotHostTarget({ snapshot: "effective" });
  // Without the allowance the join only reads readiness: the other target's record is excluded.
  const unrevalidated = stalled.controller.getReadiness({ transport: "meet", target: other });
  assert.deepEqual([unrevalidated.ready, unrevalidated.blockers], [false, []]);
  await stalled.controller.revalidateForJoin({ transport: "meet", target: other, budgetMs: 10 });
  const state = stalled.controller.getReadiness({ transport: "meet", target: other });
  assert.deepEqual([state.ready, state.blockers, state.systems.find((system) => system.id === "attendee").code], [false, [], "PENDING"]);
  // Context-free readers (no target) keep today's view of the record.
  assert.equal(stalled.controller.getReadiness().systems.find((system) => system.id === "attendee").code, "AUTH_FAILED");
});

test("T10 fieldFor points at the selected slot", (t) => {
  const { _test } = require("../src/settings/readiness");
  initMemory(t, {});
  assert.equal(_test.fieldFor("attendee", "AUTH_FAILED"), "attendee_api_key");
  assert.equal(_test.fieldFor("attendee", "UNREACHABLE"), "attendee_api_key");
  initMemory(t, { botHost: "attendee-self-hosted" });
  assert.equal(_test.fieldFor("attendee", "AUTH_FAILED"), "attendee_self_hosted_api_key");
  assert.equal(_test.fieldFor("attendee", "UNREACHABLE"), "attendee_self_hosted_url");
  assert.equal(_test.fieldFor("attendee", "TIMEOUT"), "attendee_self_hosted_url");
  initMemory(t, { botHost: "attendee-self-hosted", selfUrl: null });
  assert.equal(_test.fieldFor("attendee", "NOT_CONFIGURED"), "attendee_self_hosted_url");
});

// ---- T13 / T14 import, export, masking ---------------------------------------------------------

test("T13 import naming bot_host or the self-hosted URL is 422 and changes nothing; export carries neither nor any key", async (t) => {
  const { createSettingsHandler } = require("../src/settings/routes");
  const runtimeStartup = initFile(t, { botHost: "attendee-self-hosted" });
  const handler = createSettingsHandler({ port: 5005, readinessController: createReadinessController() });
  const exported = await call(handler, "GET", "/api/settings/export");
  assert.equal(exported.status, 200);
  for (const id of ["bot_host", "attendee_self_hosted_url", "attendee_self_hosted_api_key", "attendee_api_key"]) {
    assert.equal(Object.hasOwn(exported.json.settings, id), false, id);
  }
  for (const value of [KEY_C, KEY_S, SELF_URL]) assert.equal(exported.text.includes(value), false, value);
  assert.equal(exported.json.settings.face_timeline_offset_ms_self_hosted, undefined, "unstored values are not exported");
  const before = fs.readFileSync(runtimeStartup.configPath, "utf8");
  const envelope = (await call(handler, "GET", "/api/settings")).json;
  for (const settings of [{ bot_host: "attendee-cloud" }, { attendee_self_hosted_url: "https://other.example" }, { attendee_self_hosted_api_key: "x" }]) {
    const res = await call(handler, "POST", "/api/settings/import", {
      revision: envelope.revision,
      document: { format: "meetmate-settings", version: 1, exportedAt: "2026-10-05T00:00:00.000Z", settings },
    });
    assert.equal(res.status, 422, JSON.stringify(settings));
    assert.equal(fs.readFileSync(runtimeStartup.configPath, "utf8"), before);
  }
});

test("T14 GET masks both keys; clearing one key leaves the other; each slot keeps its own values", async (t) => {
  const { createSettingsHandler } = require("../src/settings/routes");
  const runtimeStartup = initFile(t, { botHost: "attendee-self-hosted" });
  const handler = createSettingsHandler({ port: 5005, readinessController: { configure() {}, async probeGateSystems() {} } });
  const get = await call(handler, "GET", "/api/settings");
  for (const id of ["attendee_api_key", "attendee_self_hosted_api_key"]) {
    assert.deepEqual(get.json.fields[id], { state: "set", value: MASK }, id);
    assert.deepEqual(get.json.effective[id], { state: "set", value: MASK }, id);
  }
  assert.equal(get.text.includes(KEY_C) || get.text.includes(KEY_S), false);
  const cleared = await call(handler, "PUT", "/api/settings", { schemaVersion: 1, revision: get.json.revision, fields: { attendee_self_hosted_api_key: null } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(cleared.json.fields.attendee_self_hosted_api_key, { state: "unset", value: "" });
  assert.deepEqual(cleared.json.fields.attendee_api_key, { state: "set", value: MASK });
  const stored = JSON.parse(fs.readFileSync(runtimeStartup.configPath, "utf8"));
  assert.deepEqual([stored.attendee.apiKey, stored.attendee.selfHosted.apiKey, stored.attendee.selfHosted.url], [KEY_C, undefined, SELF_URL]);
  const switched = await call(handler, "PUT", "/api/settings", { schemaVersion: 1, revision: cleared.json.revision, fields: { bot_host: "attendee-cloud", attendee_self_hosted_api_key: KEY_S2 } });
  assert.equal(switched.status, 200, switched.text);
  const after = JSON.parse(fs.readFileSync(runtimeStartup.configPath, "utf8"));
  assert.deepEqual([after.attendee.host, after.attendee.apiKey, after.attendee.selfHosted.apiKey, after.attendee.selfHosted.url], ["attendee-cloud", KEY_C, KEY_S2, SELF_URL], "switching loses neither slot");
  assert.equal((fs.statSync(runtimeStartup.configPath).mode & 0o777).toString(8), "600");
});

// ---- T16 required-ness -------------------------------------------------------------------------

function valueRequired(status) {
  return status.issues.filter((issue) => issue.code === "VALUE_REQUIRED").map((issue) => issue.fieldId).sort();
}

test("T16 required-ness: only the selected slot is required, Meet/Zoom only; resolution never throws", (t) => {
  initMemory(t, { botHost: "attendee-self-hosted", selfUrl: "", cloudKey: null });
  assert.deepEqual(valueRequired(resolver.getStatus({ transport: "meet" })), ["attendee_self_hosted_url"]);
  assert.deepEqual(valueRequired(resolver.getStatus({ transport: "zoom" })), ["attendee_self_hosted_url"]);
  assert.deepEqual(valueRequired(resolver.getStatus({ transport: "discord" })).filter((id) => id.startsWith("attendee")), []);
  assert.equal(resolveBotHostTarget({ snapshot: "effective" }).configured, false);

  initMemory(t, { botHost: "attendee-self-hosted", selfKey: null, cloudKey: null });
  assert.deepEqual(valueRequired(resolver.getStatus({ transport: "meet" })), ["attendee_self_hosted_api_key"]);

  for (const botHost of [undefined, "attendee-cloud"]) {
    initMemory(t, { botHost, cloudKey: null, selfUrl: null, selfKey: null });
    assert.deepEqual(valueRequired(resolver.getStatus({ transport: "meet" })), ["attendee_api_key"], String(botHost));
    assert.deepEqual(valueRequired(resolver.getStatus()), ["attendee_api_key"], `${botHost} context-free`);
  }
});

test("T16 a self-hosted Meet join with an empty URL is the existing 503 setup response, not a 500", { concurrency: false }, async (t) => {
  initMemory(t, { botHost: "attendee-self-hosted", selfUrl: "", cloudKey: null });
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  delete require.cache[routesPath];
  t.after(() => { delete require.cache[routesPath]; });
  const routes = require(routesPath);
  const req = Readable.from([]);
  Object.assign(req, { method: "POST", url: "/join-meeting", headers: {}, socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" } });
  const res = { status: 0, body: "", writeHead(status) { this.status = status; }, end(chunk = "") { this.body += String(chunk); } };
  await routes.handleHttp(req, res);
  assert.equal(res.status, 503);
  assert.equal(res.body, '{"error":{"code":"MEETING_SETUP_REQUIRED","message":"Meeting setup is incomplete","issues":[{"fieldId":"attendee_self_hosted_url","code":"VALUE_REQUIRED"}]}}');
});

// ---- T17 UI ------------------------------------------------------------------------------------

function settingsSource() {
  return read("public/settings.js");
}

function pick(source, name) {
  return source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    }\\n`))[0];
}

function fakeNode() {
  const node = { hidden: false, text: "" };
  node.classList = { toggle(name, force) { if (name === "is-hidden") node.hidden = Boolean(force); } };
  node.querySelector = () => ({ set textContent(value) { node.text = value; } });
  return node;
}

// Runs the page's real visibility and note functions against a minimal DOM.
function renderAttendee({ botHost, loadedBotHost = botHost, url = "", loadedUrl = url, keyState = "unset", baseUrl = "app.attendee.dev", avatar = "face-package" }) {
  const { CLIENT_FIELD_SETS } = require("../public/settings.js");
  const { _test } = require("../src/settings/routes");
  const source = settingsSource();
  const ids = ["bot_host", "attendee_self_hosted_url", "attendee_self_hosted_api_key", "attendee_api_key", "attendee_base_url",
    "avatar_experiment", "face_timeline_offset_ms", "face_timeline_offset_ms_self_hosted"];
  const manifest = _test.buildSettingsUiManifest().fields.filter((entry) => ids.includes(entry.id));
  const nodes = {};
  for (const id of [...ids, "faceAudioCloudNote", "inUse-face_timeline_offset_ms", "inUse-face_timeline_offset_ms_self_hosted",
    "attendeeHttpNote", "attendeeOriginNote", "attendeeCustomCloudNote"]) nodes[id] = fakeNode();
  const inputs = {
    bot_host: { value: botHost, dataset: {} },
    attendee_self_hosted_url: { value: url, dataset: {} },
    avatar_experiment: { value: avatar, dataset: {} },
  };
  const context = {
    ...CLIENT_FIELD_SETS,
    BOOLEAN_FIELDS: new Set(), ARRAY_FIELDS: new Set(), NUMBER_FIELDS: new Set(),
    manifest,
    loadedValues: { bot_host: loadedBotHost, attendee_self_hosted_url: loadedUrl, attendee_base_url: baseUrl, avatar_experiment: avatar },
    envelope: { attendeeHostKind: "cloud", fields: { attendee_self_hosted_api_key: { state: keyState, value: keyState === "unset" ? "" : "••••••••" } } },
    URL,
    document: {
      querySelector(selector) {
        const field = selector.match(/^\[data-field-id="([^"]+)"\]$/);
        if (field) return nodes[field[1]] || null;
        const setting = selector.match(/^\[data-setting-id="([^"]+)"\]$/);
        return setting ? inputs[setting[1]] || null : null;
      },
      getElementById(id) { return nodes[id] || null; },
    },
  };
  vm.runInNewContext(`${pick(source, "controlFor")}${pick(source, "readControlValue")}${pick(source, "currentProvider")}${pick(source, "updateConditionalVisibility")}${pick(source, "urlOrigin")}${pick(source, "updateAttendeeNotes")}
    updateConditionalVisibility(); updateAttendeeNotes();`, context);
  const shown = (id) => !nodes[id].hidden;
  return {
    selfFields: shown("attendee_self_hosted_url") && shown("attendee_self_hosted_api_key"),
    cloudFields: shown("attendee_api_key") && shown("attendee_base_url"),
    inUse: ["face_timeline_offset_ms", "face_timeline_offset_ms_self_hosted"].filter((id) => shown(`inUse-${id}`)),
    offsets: shown("face_timeline_offset_ms") && shown("face_timeline_offset_ms_self_hosted"),
    httpNote: shown("attendeeHttpNote"),
    originNote: shown("attendeeOriginNote"),
    customNote: shown("attendeeCustomCloudNote") ? nodes.attendeeCustomCloudNote.text : null,
  };
}

test("T17 UI: the select and its options; self-hosted fields only when selected; legacy fields as today; in-use marker", () => {
  const { _test } = require("../src/settings/routes");
  const entry = _test.buildSettingsUiManifest().fields.find((field) => field.id === "bot_host");
  assert.deepEqual([entry.control, entry.options, entry.ux, entry.apply], ["select", ["attendee-cloud", "attendee-self-hosted"], "basic", "next-join"]);
  const self = renderAttendee({ botHost: "attendee-self-hosted" });
  assert.deepEqual([self.selfFields, self.cloudFields, self.offsets, self.inUse], [true, true, true, ["face_timeline_offset_ms_self_hosted"]]);
  for (const botHost of ["attendee-cloud", ""]) {
    const cloud = renderAttendee({ botHost });
    assert.deepEqual([cloud.selfFields, cloud.cloudFields, cloud.inUse], [false, true, ["face_timeline_offset_ms"]], JSON.stringify(botHost));
  }
  assert.equal(renderAttendee({ botHost: "attendee-cloud", avatar: "" }).offsets, false, "both offsets stay face-package fields");
  const source = settingsSource();
  assert.match(source, /"": "未選択（従来どおり Attendee ホスト名・API key の設定を使う）"/);
  assert.match(source, /"attendee-cloud": "Attendee cloud（既定）"/);
  assert.match(source, /"attendee-self-hosted": "セルフホストの Attendee"/);
  assert.match(source, /bot_host: "ボットの実行先"/);
  assert.match(source, /inUse\.textContent = "使用中（選択中の実行先）";/);
});

test("T17 UI notes: http URL; origin changed with a stored key; cloud slot with a non-default hostname", () => {
  assert.equal(renderAttendee({ botHost: "attendee-self-hosted", url: "http://192.168.1.20:8000" }).httpNote, true);
  assert.equal(renderAttendee({ botHost: "attendee-self-hosted", url: "HTTP://192.168.1.20:8000" }).httpNote, true);
  assert.equal(renderAttendee({ botHost: "attendee-self-hosted", url: SELF_URL }).httpNote, false);
  assert.equal(renderAttendee({ botHost: "attendee-cloud", url: "http://192.168.1.20:8000" }).httpNote, false);

  const changed = { botHost: "attendee-self-hosted", url: "https://other.example", loadedUrl: SELF_URL };
  assert.equal(renderAttendee({ ...changed, keyState: "set" }).originNote, true);
  assert.equal(renderAttendee({ ...changed, keyState: "unset" }).originNote, false);
  assert.equal(renderAttendee({ ...changed, url: `${SELF_URL}/deeper`, keyState: "set" }).originNote, false, "same origin, other path");
  assert.equal(renderAttendee({ botHost: "attendee-self-hosted", url: SELF_URL, keyState: "set" }).originNote, false);

  const custom = renderAttendee({ botHost: "", baseUrl: "attendee.example.com" });
  assert.match(custom.customNote, /既定以外の Attendee ホスト名（attendee\.example\.com）/);
  assert.match(custom.customNote, /セルフホストの Attendee には専用の枠があり/);
  assert.equal(renderAttendee({ botHost: "attendee-cloud", baseUrl: "App.Attendee.Dev" }).customNote, null, "compared with the registry default");
  assert.equal(renderAttendee({ botHost: "attendee-self-hosted", baseUrl: "attendee.example.com" }).customNote, null);
  assert.equal(settingsSource().includes("app.attendee.dev"), false);
});

test("T17/D1c UI: an unstored bot_host loads as a placeholder, so an unrelated save omits it and picking cloud stores it", () => {
  const { pendingChangesForValues } = require("../public/settings.js");
  const source = settingsSource();
  assert.match(pick(source, "renderFields"), /const value = entry\.id === "bot_host" && !Object\.hasOwn\(envelope\?\.fields \|\| \{\}, "bot_host"\) \? "" : shownValue\(entry, envelope\);\n\s*loadedValues\[entry\.id\] = value;/);
  assert.match(pick(source, "createField"), /for \(const rawOption of \[\.\.\.\(entry\.id === "bot_host" && value === "" \? \[""\] : \[\]\), \.\.\.\(entry\.options \|\| \[\]\)\]\)/);
  assert.deepEqual(pendingChangesForValues({ bot_host: "", agent_name: "Caty" }, { bot_host: "", agent_name: "Kate" }), { agent_name: "Kate" });
  assert.deepEqual(pendingChangesForValues({ bot_host: "" }, { bot_host: "attendee-cloud" }), { bot_host: "attendee-cloud" });
  assert.deepEqual(pendingChangesForValues({ bot_host: "attendee-cloud" }, { bot_host: "attendee-cloud" }), {});
});

// ---- T18 docs, T21 literal ---------------------------------------------------------------------

test("T18 docs: the setup-guide section with its facts, the README pointers, the contract and the example", () => {
  const guide = read("docs/setup-guide.md");
  const section = guide.slice(guide.indexOf("## ボットの実行先を選ぶ（Choosing where the bot runs）"));
  assert.ok(guide.includes("## ボットの実行先を選ぶ（Choosing where the bot runs）"));
  const body = section.slice(0, section.indexOf("\n## ", 5));
  for (const fact of [/10 CPU コア・12 GB メモリ/, /GPU は不要/, /15 fps/, /Elastic License 2\.0/, /ATTENDEE_API_BASE_URL/, /環境変数のエイリアスはない/,
    /100\.64\.0\.0\/10/, /どちらの実行先を選んでいても/, /-700/, /既定値は 300/, /### セルフホストへ移行する（Upgrading a self-hosted setup）/]) {
    assert.match(body, fact);
  }
  for (const readme of ["README.md", "docs/i18n/README.ja.md", "docs/i18n/README.th.md", "docs/i18n/README.zh.md"]) {
    assert.ok(read(readme).includes("docs/setup-guide.md#ボットの実行先を選ぶchoosing-where-the-bot-runs"), readme);
  }
  const contract = read("docs/settings-contract.md");
  assert.match(contract, /\| `bot_host` \| `attendee\.host` \| `enum\(attendee-cloud,attendee-self-hosted\)` \/ `attendee-cloud` \| basic \| none \| next-join \| none \| false \|/);
  assert.match(contract, /\| `attendee_self_hosted_url` \| `attendee\.selfHosted\.url` \| `attendee-endpoint-or-empty` \/ empty \| basic \| none \| next-join \| none \| false \|/);
  assert.match(contract, /\| `attendee_self_hosted_api_key` \| `attendee\.selfHosted\.apiKey` \| `secret` \| basic \| class-1 \| next-join \| none \| default \|/);
  assert.match(contract, /The registry contains exactly 102 rows\./);
  assert.match(contract, /`attendee\.selfHosted\.apiKey` \(`attendee_self_hosted_api_key`\) is a class-1 credential/);
  assert.match(contract, /an entry of the Attendee slot that `bot_host` does not select is never reported missing/);
  assert.match(contract, /\| `attendee` \| optional gate \| the selected slot's endpoint with that slot's class-1 key \|/);
  assert.match(contract, /class 1 credential of the latest published settings snapshot/);
  assert.match(contract, /Attendee host kind \(#260\): \(1\) when `bot_host` is stored/);
  assert.equal(contract.includes("#260 later swaps its"), false);
  assert.match(read("docs/face-packages.md"), /face_timeline_offset_ms_self_hosted/);
  const example = JSON.parse(read("config.json.example"));
  assert.equal(Object.hasOwn(example.attendee, "host"), false, "the example never stores bot_host");
  assert.deepEqual(example.attendee.selfHosted, { url: "", apiKey: "" });
  assert.equal(example.avatar.faceTimelineOffsetMsSelfHosted, 300);
});

test("T21 literal: the Attendee cloud hostname appears in no src/ or public/ file but the helper and the one registry default", () => {
  const hits = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:js|mjs|cjs|html|md|css)$/.test(entry.name)) {
        const count = fs.readFileSync(file, "utf8").split("app.attendee.dev").length - 1;
        if (count) hits.push([path.relative(ROOT, file), count]);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  walk(path.join(ROOT, "public"));
  assert.deepEqual(hits.sort(), [[path.join("src", "attendee-host-kind.js"), 1], [path.join("src", "settings", "registry.js"), 1]]);
});
