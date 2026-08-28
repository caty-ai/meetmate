const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const util = require("node:util");
const { Readable } = require("node:stream");
const { ENV_DIAGNOSTICS, SETTINGS_REGISTRY, REGISTRY_BY_ID, MASK } = require("../src/settings/registry");
const { settingsMutationSchema } = require("../src/settings/schemas");
const { readConfigState, saveFields } = require("../src/settings/store");
const { createSettingsHandler } = require("../src/settings/routes");
const { scanLegacyClass2 } = require("../src/settings/class2-migration");
const {
  buildEnvelope,
  initializeRuntime,
  meaningful,
  publishState,
  registerCacheInvalidator,
  resetRuntimeForTest,
} = require("../src/settings/resolver");

const pathsModule = require.resolve("../src/paths");

require("./settings-hardening");

function withFreshPaths(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  require("../src/settings/bootstrap").resetStartupForTest();
  require("../src/settings/resolver").resetRuntimeForTest();
  delete require.cache[pathsModule];
  try {
    return fn(require(pathsModule));
  } finally {
    delete require.cache[pathsModule];
    require("../src/settings/bootstrap").resetStartupForTest();
    require("../src/settings/resolver").resetRuntimeForTest();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("writable paths prefer explicit cache and metrics overrides over AI_MEET_HOME", () => {
  withFreshPaths({
    AI_MEET_HOME: "/tmp/meetmate-home",
    TTS_CACHE_DIR: "/tmp/explicit-tts-cache",
    METRICS_LOG_DIR: "/tmp/explicit-metrics-log",
  }, (paths) => {
    assert.equal(paths.ttsCacheDir(), "/tmp/explicit-tts-cache");
    assert.equal(paths.metricsLogDir(), "/tmp/explicit-metrics-log");
    assert.equal(paths.logsDir(), "/tmp/meetmate-home/logs");
    assert.equal(paths.configPath(), "/tmp/meetmate-home/config.json");
    assert.equal(paths.envPath(), "/tmp/meetmate-home/.env");
  });
});

test("writable paths use launch-time AI_MEET_HOME before cwd", () => {
  withFreshPaths({
    AI_MEET_HOME: "/tmp/meetmate-home",
    TTS_CACHE_DIR: undefined,
    METRICS_LOG_DIR: undefined,
  }, (paths) => {
    assert.equal(paths.resolveHome(), "/tmp/meetmate-home");
    assert.equal(paths.ttsCacheDir(), "/tmp/meetmate-home/assets/tts-cache");
    assert.equal(paths.logsDir(), "/tmp/meetmate-home/logs");
    assert.equal(paths.metricsLogDir(), "/tmp/meetmate-home/logs");
    assert.equal(paths.avatarCachePath(), "/tmp/meetmate-home/assets/avatar.png");

    process.env.AI_MEET_HOME = "/tmp/late-home";
    assert.equal(paths.resolveHome(), "/tmp/meetmate-home");
    assert.equal(paths.configPath(), "/tmp/meetmate-home/config.json");
  });
});

test("writable paths pin cwd when AI_MEET_HOME is absent at launch", () => {
  withFreshPaths({ AI_MEET_HOME: undefined, TTS_CACHE_DIR: undefined, METRICS_LOG_DIR: undefined }, (paths) => {
    const launchCwd = process.cwd();
    assert.equal(paths.resolveHome(), launchCwd);
    assert.equal(paths.ttsCacheDir(), path.join(launchCwd, "assets", "tts-cache"));
    assert.equal(paths.logsDir(), path.join(launchCwd, "logs"));
  });
});

test("AI_MEET_HOME loaded from .env cannot redirect any resolved user path", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-paths-"));
  const poison = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-poison-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(poison, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, ".env"), `AI_MEET_HOME=${poison}\n`);

  const dotenvModule = require.resolve("dotenv");
  const script = `
    const paths = require(${JSON.stringify(pathsModule)});
    require(${JSON.stringify(dotenvModule)}).config({ path: paths.envPath(), quiet: true });
    process.stdout.write(JSON.stringify({
      dotenvHome: process.env.AI_MEET_HOME,
      home: paths.resolveHome(),
      config: paths.configPath(),
      env: paths.envPath(),
      logs: paths.logsDir(),
      metrics: paths.metricsLogDir(),
      tts: paths.ttsCacheDir(),
      avatar: paths.avatarCachePath()
    }));
  `;
  const env = { ...process.env };
  delete env.AI_MEET_HOME;
  delete env.TTS_CACHE_DIR;
  delete env.METRICS_LOG_DIR;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: directory,
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const resolved = JSON.parse(child.stdout);
  const canonicalDirectory = fs.realpathSync(directory);
  assert.equal(resolved.dotenvHome, poison);
  assert.deepEqual(resolved, {
    dotenvHome: poison,
    home: canonicalDirectory,
    config: path.join(canonicalDirectory, "config.json"),
    env: path.join(canonicalDirectory, ".env"),
    logs: path.join(canonicalDirectory, "logs"),
    metrics: path.join(canonicalDirectory, "logs"),
    tts: path.join(canonicalDirectory, "assets", "tts-cache"),
    avatar: path.join(canonicalDirectory, "assets", "avatar.png"),
  });
});

test("config loading resolves configPath lazily against the pinned home", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "config.json"), '{"agent":{"id":"lazy-path"}}\n');

  const configModule = require.resolve("../src/config");
  const script = `
    const config = require(${JSON.stringify(configModule)});
    process.stdout.write(JSON.stringify(config.loadConfig()));
  `;
  const env = { ...process.env, AI_MEET_HOME: directory };
  const child = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { agent: { id: "lazy-path" } });
});

test("bundled assets remain package-relative regardless of AI_MEET_HOME", () => {
  withFreshPaths({ AI_MEET_HOME: "/tmp/meetmate-home" }, (paths) => {
    assert.equal(paths.bundledPublicDir(), path.join(__dirname, "..", "public"));
    assert.equal(paths.bundledAssetPath("avatar.png"), path.join(__dirname, "..", "assets", "avatar.png"));
    assert.notEqual(paths.bundledAssetPath("avatar.png"), "/tmp/meetmate-home/assets/avatar.png");
  });
});

function settingsStartup(overrides = {}) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({ ...(overrides.preDotenvEnv || {}) }),
    dotenvSeeds: Object.freeze({ ...(overrides.dotenvSeeds || {}) }),
    resolvedHome: overrides.resolvedHome || "/tmp/meetmate-settings-test",
    configPath: overrides.configPath || "/tmp/meetmate-settings-test/config.json",
    connection: Object.freeze({
      provider: "openclaw",
      openclawUrl: "http://localhost:18789",
      openclawToken: "connection-token-not-for-output",
      openaiApiKey: "",
      ...(overrides.connection || {}),
    }),
  });
}

function settingsState(parsed, revision = "a".repeat(64)) {
  return { exists: true, valid: true, parsed, revision, fingerprint: `bytes:${revision}` };
}

function settingsResponse() {
  return {
    status: null, headers: null, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = "") { this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
  };
}

function settingsRequest(method, url, headers = {}, body = "") {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, headers, socket: { localAddress: "127.0.0.1", localPort: 5005 } });
  return req;
}

test("T12-01 registry/schema/type lock keeps the write allowlist strict", () => {
  assert.equal(SETTINGS_REGISTRY.length, 61);
  assert.equal(ENV_DIAGNOSTICS.length, 57);
  assert.equal(new Set(SETTINGS_REGISTRY.map((entry) => entry.id)).size, SETTINGS_REGISTRY.length);
  assert.equal(SETTINGS_REGISTRY.filter((entry) => entry.credential === "class-1").length, 5);
  assert.deepEqual(SETTINGS_REGISTRY.filter((entry) => entry.writeSurface === "audio-only").map((entry) => entry.id), ["audio_clips"]);
  const visible = JSON.stringify(SETTINGS_REGISTRY.map(({ id, path: configPath }) => ({ id, path: configPath })));
  for (const forbidden of ["gateway.token", "gateway.url", "openaiCompatible.apiKey", "WS_SHARED_TOKEN", "JOIN_SHARED_TOKEN"]) {
    assert.equal(visible.includes(forbidden), false, forbidden);
  }
  assert.equal(REGISTRY_BY_ID.server_ngrok_domain.schema.safeParse("meetmate.example").success, true);
  for (const invalid of ["https://meetmate.example", "meetmate.example:443", "user@meetmate.example", "meetmate.example/path"]) {
    assert.equal(REGISTRY_BY_ID.server_ngrok_domain.schema.safeParse(invalid).success, false, invalid);
  }
  assert.equal(settingsMutationSchema.safeParse({ schemaVersion: 1, revision: "bootstrap", fields: { unknown: true } }).success, false);
  resetRuntimeForTest();
  initializeRuntime({ state: settingsState({}), startup: settingsStartup(), serverPort: 5005 });
  assert.equal(Object.keys(buildEnvelope().diagnostics).length, 59);
});

test("T12-02 precedence table is pre-dotenv OS > config > .env seed > default", () => {
  const cases = [
    ["en", "ja", "ja", "en", "os-env"],
    [undefined, "en", "ja", "en", "config"],
    [undefined, undefined, "en", "en", ".env-seed"],
    [undefined, undefined, undefined, "ja", "default"],
    ["${AGENT_LANG}", "en", "ja", "en", "config"],
  ];
  for (const [launch, stored, seed, expected, source] of cases) {
    resetRuntimeForTest();
    initializeRuntime({
      state: settingsState({ agent: { language: stored } }),
      startup: settingsStartup({ preDotenvEnv: { AGENT_LANG: launch }, dotenvSeeds: { AGENT_LANG: seed } }),
    });
    assert.equal(buildEnvelope().effective.agent_language, expected);
    assert.equal(buildEnvelope().sources.agent_language, source);
  }
});

test("T12-02 environment inventory lock recognizes every retained direct read and all migration aliases", () => {
  const inventoryPath = path.join(__dirname, "..", "docs", "settings-env-inventory.json");
  const bytes = fs.readFileSync(inventoryPath, "utf8");
  assert.equal(bytes.endsWith("\n"), true);
  assert.equal(bytes.endsWith("\n\n"), false);
  const inventory = JSON.parse(bytes);
  assert.equal(inventory.baselineUniqueDirectCount, 89);
  assert.equal(inventory.directReferences.length, 89);
  assert.equal(new Set(inventory.directReferences.map((entry) => entry.name)).size, 89);
  const known = new Set(inventory.directReferences.map((entry) => entry.name));
  const productionFiles = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target);
      else if (entry.name.endsWith(".js")) productionFiles.push(target);
    }
  }
  collect(path.join(__dirname, "..", "src"));
  collect(path.join(__dirname, "..", "bin"));
  const production = productionFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const retained = [...production.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  for (const name of retained) assert.equal(known.has(name), true, name);
  const migrated = new Set(inventory.directReferences
    .filter((entry) => entry.handling === "ordinary-setting" || entry.handling === "masked-ui-config-store-export-excluded")
    .map((entry) => entry.name));
  for (const name of retained) assert.equal(migrated.has(name), false, `${name} still bypasses the resolver`);
  for (const entry of inventory.directReferences.filter((item) => item.credentialClass === "class-2-connection" || item.credentialClass === "class-3-internal-control")) {
    assert.equal(entry.ux, "hidden", entry.name);
  }
});

test("T12-03 startup/bootstrap boundary allows exactly eight settings modules", () => {
  const directory = path.join(__dirname, "..", "src", "settings");
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".js")).sort();
  assert.deepEqual(files, ["audio.js", "bootstrap.js", "class2-migration.js", "registry.js", "resolver.js", "routes.js", "schemas.js", "store.js"]);
  for (const file of files) {
    if (file === "bootstrap.js") continue;
    assert.doesNotMatch(fs.readFileSync(path.join(directory, file), "utf8"), /process\.env|dotenv\.parse|\benvPath\b|\.env["'`]/, file);
  }
  assert.match(fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8").split(/\r?\n/).slice(0, 4).join("\n"), /settings\/bootstrap.*captureStartup/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "bin", "ai-meet.js"), "utf8"), /function mcp\(\)[\s\S]*settings["', ]+bootstrap\.js["']\)\)\.captureStartup\(\)/);
});

test("T12-04 runtime snapshot keeps restart fields at boot and publishes live fields", () => {
  resetRuntimeForTest();
  const launch = settingsStartup();
  initializeRuntime({ state: settingsState({ agent: { language: "ja", greeting: "boot greeting" } }), startup: launch });
  let invalidations = 0;
  const unregister = registerCacheInvalidator(() => { invalidations += 1; });
  publishState(settingsState({ agent: { language: "en", greeting: "live greeting" } }, "b".repeat(64)));
  assert.equal(buildEnvelope().effective.agent_language, "ja");
  assert.equal(buildEnvelope().effective.agent_greeting, "live greeting");
  assert.equal(buildEnvelope().restartRequired.includes("agent_language"), true);
  assert.equal(buildEnvelope().restartRequired.includes("agent_greeting"), false);
  assert.equal(invalidations, 1);
  unregister();
  resetRuntimeForTest();
  initializeRuntime({ state: settingsState({ agent: { language: "en", greeting: "live greeting" } }, "b".repeat(64)), startup: launch });
  assert.deepEqual(buildEnvelope().restartRequired, []);

  resetRuntimeForTest();
  const numericOverride = settingsStartup({ preDotenvEnv: { AGENT_TEMPERATURE: "1.0" } });
  initializeRuntime({ state: settingsState({ llm: { temperature: 0.5 } }), startup: numericOverride });
  publishState(settingsState({ llm: { temperature: 1 } }, "c".repeat(64)));
  assert.equal(buildEnvelope().restartRequired.includes("llm_temperature"), false);

  resetRuntimeForTest();
  initializeRuntime({ state: settingsState({}), startup: launch });
  publishState(settingsState({}, "d".repeat(64)));
  assert.equal(buildEnvelope().restartRequired.includes("agent_language"), false);
});

test("T12-05 whole-store transaction preserves unknowns, strips class 2, and enforces 0600/symlink/revision", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-settings-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, `${JSON.stringify({
    _comments: { preserved: true }, agents: [{ future: true }],
    gateway: { url: "class2-url", token: "class2-token", displayName: "keep" },
    agent: { id: "agent", gatewayToken: "legacy-token" },
    llm: { openaiCompatible: { apiKey: "legacy-key", baseUrl: "http://localhost:4000/v1" } },
  })}\n`, { mode: 0o644 });
  const before = readConfigState(config);
  resetRuntimeForTest();
  initializeRuntime({ state: before, startup: settingsStartup({ configPath: config, resolvedHome: directory }) });
  const committed = saveFields({ configPath: config, revision: before.revision, fields: { agent_language: "ja" } });
  assert.deepEqual(committed.parsed._comments, { preserved: true });
  assert.deepEqual(committed.parsed.agents, [{ future: true }]);
  assert.equal(committed.parsed.gateway.url, undefined);
  assert.equal(committed.parsed.gateway.token, undefined);
  assert.equal(committed.parsed.gateway.displayName, "keep");
  assert.equal(committed.parsed.agent.gatewayToken, undefined);
  assert.equal(committed.parsed.llm.openaiCompatible.apiKey, undefined);
  if (process.platform !== "win32") assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(directory).some((name) => name.includes("settings-backup") || name.includes("settings-write")), false);
  const originalRename = fs.renameSync;
  t.after(() => { fs.renameSync = originalRename; });
  fs.renameSync = () => {
    const error = new Error("rename failed at /secret/settings/config.json");
    error.code = "EACCES";
    throw error;
  };
  assert.throws(
    () => saveFields({ configPath: config, revision: committed.revision, fields: { agent_language: "en" } }),
    (error) => error.code === "SETTINGS_TRANSACTION_FAILED" && !error.message.includes("/secret/")
  );
  fs.renameSync = originalRename;
  assert.throws(() => saveFields({ configPath: config, revision: before.revision, fields: {} }), (error) => error.code === "SETTINGS_REVISION_CONFLICT");
  const target = path.join(directory, "target.json");
  fs.writeFileSync(target, "{}\n");
  const link = path.join(directory, "linked.json");
  fs.symlinkSync(target, link);
  assert.throws(() => readConfigState(link), (error) => error.code === "SETTINGS_SYMLINK_REJECTED");
});

test("T12-05 bootstrap revision recovers absent and parse-invalid documents", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-settings-bootstrap-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  const missing = readConfigState(config);
  assert.equal(missing.revision, "bootstrap");
  resetRuntimeForTest();
  initializeRuntime({ state: missing, startup: settingsStartup({ configPath: config, resolvedHome: directory }) });
  assert.match(saveFields({ configPath: config, revision: "bootstrap", fields: { agent_language: "ja" } }).revision, /^[a-f0-9]{64}$/);
  assert.throws(() => saveFields({ configPath: config, revision: "bootstrap", fields: {} }), /revision changed/i);
  fs.writeFileSync(config, "{broken", { mode: 0o600 });
  assert.equal(saveFields({ configPath: config, revision: "bootstrap", fields: { agent_language: "en" } }).parsed.agent.language, "en");
});

test("T12-05/T12-13 sentinel semantics and class-2 scan stay exact and value-free", () => {
  const sentinels = [
    "your_gateway_token_here", "your_deepgram_key", "your_soniox_key", "your_attendee_key",
    "your_fish_audio_key", "your_voice_id", "your_slack_bot_token", "your-model-id",
    "your_openai_compatible_key", "your-agent-id", "YourAgent", "your-agent", "エージェント名",
  ];
  for (const sentinel of sentinels) {
    assert.equal(meaningful(sentinel), false, sentinel);
    assert.deepEqual(scanLegacyClass2({ gateway: { token: sentinel } }), [], sentinel);
  }
  assert.equal(meaningful("your-agent-ID"), true);
  assert.equal(scanLegacyClass2({ gateway: { token: "your-agent-ID" } }).length, 1);
});

test("T12-06/T12-07/T12-13 admin shell is local, masked, and setup-safe", async () => {
  resetRuntimeForTest();
  const class1 = "CLASS1-HIGH-ENTROPY-111111";
  const class2 = "CLASS2-HIGH-ENTROPY-222222";
  const class3 = "CLASS3-HIGH-ENTROPY-333333";
  initializeRuntime({
    state: settingsState({ stt: { sonioxApiKey: class1 }, gateway: { token: class2 }, unknownControl: { WS_SHARED_TOKEN: class3 } }),
    startup: settingsStartup({ connection: { openclawToken: class2 } }), serverPort: 5005,
  });
  const handler = createSettingsHandler({ port: 5005 });
  const local = settingsResponse();
  await handler(settingsRequest("GET", "/api/settings", { host: "localhost:5005" }), local);
  assert.equal(local.status, 200);
  for (const sentinel of [class1, class2, class3]) assert.equal(local.body.includes(sentinel), false);
  assert.deepEqual(JSON.parse(local.body).fields.soniox_api_key, { state: "set", value: MASK });
  const forwarded = settingsResponse();
  await handler(settingsRequest("GET", "/api/settings", { host: "localhost:5005", "x-forwarded-host": "public.example" }), forwarded);
  assert.equal(forwarded.status, 404);

  resetRuntimeForTest();
  initializeRuntime({ state: { exists: false, valid: false, parsed: null, revision: "bootstrap", fingerprint: "missing" }, startup: settingsStartup(), serverPort: 5005 });
  const setup = settingsResponse();
  await handler(settingsRequest("GET", "/api/settings", { host: "localhost:5005" }), setup);
  assert.equal(JSON.parse(setup.body).setupMode, true);
  const meeting = settingsResponse();
  await require("../src/transport-meet/meet-routes").handleHttp(settingsRequest("POST", "/join-meeting", { host: "localhost:5005" }), meeting);
  assert.equal(meeting.status, 503);
  assert.equal(JSON.parse(meeting.body).error.code, "MEETING_SETUP_REQUIRED");
});

test("T12-13 conjunctive class-1/2/3 sentinels stay out of every settings exit", { concurrency: false }, async (t) => {
  const class1 = "CLASS1-JOINT-SWEEP-29-a83f1c";
  const class2 = "CLASS2-JOINT-SWEEP-29-b94e2d";
  const class3 = "CLASS3-JOINT-SWEEP-29-c05f3e";
  const sentinels = [class1, class2, class3];
  const logs = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  t.after(() => Object.assign(console, originalConsole));
  console.log = (...args) => { logs.push(util.format(...args)); };
  console.warn = (...args) => { logs.push(util.format(...args)); };
  console.error = (...args) => { logs.push(util.format(...args)); };

  resetRuntimeForTest();
  initializeRuntime({
    state: settingsState({
      stt: { sonioxApiKey: class1 },
      gateway: { token: class2 },
      unknownControl: { WS_SHARED_TOKEN: class3 },
    }),
    startup: settingsStartup({
      preDotenvEnv: { WS_SHARED_TOKEN: class3 },
      connection: { openclawToken: class2 },
    }),
    serverPort: 5005,
  });
  const handler = createSettingsHandler({ port: 5005, now: () => new Date("2026-08-28T00:00:00.000Z") });
  const exits = [];

  for (const url of ["/api/settings", "/api/settings/export", "/settings", "/settings-assets/settings.js"]) {
    const response = settingsResponse();
    await handler(settingsRequest("GET", url, { host: "localhost:5005" }), response);
    assert.equal(response.status, 200, `${url}: ${response.body}`);
    exits.push([url, response.body]);
  }

  for (const [name, headers, body, status] of [
    ["origin error", { host: "localhost:5005", origin: "https://remote.example", "content-type": "application/json" }, "{}", 403],
    ["validation error", { host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json" }, JSON.stringify({ schemaVersion: 1, revision: "a".repeat(64), fields: { agent_temperature: class1 } }), 422],
  ]) {
    const response = settingsResponse();
    await handler(settingsRequest("PUT", "/api/settings", headers, body), response);
    assert.equal(response.status, status, `${name}: ${response.body}`);
    exits.push([name, response.body]);
  }

  exits.push(["captured logs", logs.join("\n")]);
  for (const [name, output] of exits) {
    for (const sentinel of sentinels) assert.equal(output.includes(sentinel), false, `${name} leaked ${sentinel}`);
  }
});

test("T12-06 PUT accepts bootstrap/mask round trips and publishes before success", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-settings-route-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previousHome = process.env.AI_MEET_HOME;
  process.env.AI_MEET_HOME = directory;
  const bootstrap = require("../src/settings/bootstrap");
  t.after(() => {
    if (previousHome === undefined) delete process.env.AI_MEET_HOME;
    else process.env.AI_MEET_HOME = previousHome;
    bootstrap.resetStartupForTest();
    resetRuntimeForTest();
  });
  bootstrap.resetStartupForTest();
  resetRuntimeForTest();
  const captured = bootstrap.captureStartup();
  const initial = saveFields({
    configPath: captured.configPath,
    revision: "bootstrap",
    fields: { soniox_api_key: "route-secret", agent_greeting: "before" },
  });
  initializeRuntime({ state: initial, startup: captured, serverPort: 5005 });
  const response = settingsResponse();
  const body = JSON.stringify({
    schemaVersion: 1,
    revision: initial.revision,
    fields: { soniox_api_key: MASK, agent_greeting: "after" },
  });
  await createSettingsHandler({ port: 5005 })(settingsRequest("PUT", "/api/settings", {
    host: "localhost:5005",
    origin: "http://localhost:5005",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  }, body), response);
  assert.equal(response.status, 200, response.body);
  const envelope = JSON.parse(response.body);
  assert.equal(envelope.effective.agent_greeting, "after");
  assert.equal(envelope.revision === initial.revision, false);
  assert.equal(readConfigState(captured.configPath).parsed.stt.sonioxApiKey, "route-secret");
  assert.equal(response.body.includes("route-secret"), false);
});

test("T12-05 bootstrap PUT materializes registry defaults and captured .env class-1 seeds", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-settings-route-bootstrap-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previousHome = process.env.AI_MEET_HOME;
  const previousSoniox = process.env.SONIOX_API_KEY;
  process.env.AI_MEET_HOME = directory;
  fs.writeFileSync(path.join(directory, ".env"), "SONIOX_API_KEY=bootstrap-seed-key\n", { mode: 0o600 });
  const bootstrap = require("../src/settings/bootstrap");
  t.after(() => {
    if (previousHome === undefined) delete process.env.AI_MEET_HOME;
    else process.env.AI_MEET_HOME = previousHome;
    if (previousSoniox === undefined) delete process.env.SONIOX_API_KEY;
    else process.env.SONIOX_API_KEY = previousSoniox;
    bootstrap.resetStartupForTest();
    resetRuntimeForTest();
  });
  bootstrap.resetStartupForTest();
  resetRuntimeForTest();
  const captured = bootstrap.captureStartup();
  initializeRuntime({
    state: { exists: false, valid: false, parsed: null, revision: "bootstrap", fingerprint: "missing" },
    startup: captured,
    serverPort: 5005,
  });
  const response = settingsResponse();
  await createSettingsHandler({ port: 5005 })(settingsRequest("PUT", "/api/settings", {
    host: "localhost:5005",
    origin: "http://localhost:5005",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  }, JSON.stringify({ schemaVersion: 1, revision: "bootstrap", fields: {} })), response);
  assert.equal(response.status, 200, response.body);
  const stored = readConfigState(captured.configPath).parsed;
  assert.equal(stored.stt.sonioxApiKey, "bootstrap-seed-key");
  assert.equal(stored.stt.provider, "soniox");
  assert.equal(stored.tts.provider, "fish-audio");
  assert.equal(stored.llm.provider, "openclaw");
  assert.equal(response.body.includes("bootstrap-seed-key"), false);
});

test("T12-06 optional connection tests remain exact value-free 501 responses", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-settings-optional-tests-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const state = readConfigState(configPath);
  resetRuntimeForTest();
  initializeRuntime({ state, startup: settingsStartup({ configPath, resolvedHome: directory }), serverPort: 5005 });
  const handler = createSettingsHandler({ port: 5005 });
  const cases = [
    ["POST", "/api/settings/connections/deepgram/test", { "content-type": "application/json" }, JSON.stringify({ revision: state.revision })],
    ["POST", "/api/settings/connections/attendee/test", { "content-type": "application/json" }, JSON.stringify({ revision: state.revision })],
    ["POST", "/api/settings/connections/slack/test", { "content-type": "application/json" }, JSON.stringify({ revision: state.revision })],
  ];
  for (const [method, url, headers, body] of cases) {
    const response = settingsResponse();
    await handler(settingsRequest(method, url, {
      host: "localhost:5005",
      ...(method === "GET" ? {} : { origin: "http://localhost:5005", "sec-fetch-site": "same-origin" }),
      ...headers,
    }, body), response);
    assert.equal(response.status, 501, `${method} ${url}: ${response.body}`);
    assert.equal(JSON.parse(response.body).error.code, "TEST_NOT_IMPLEMENTED");
  }
});

test("T12-19 Appendix A cardinality is 15 Epic rows and 23 child rows", () => {
  const contract = fs.readFileSync(path.join(__dirname, "..", "docs", "settings-contract.md"), "utf8");
  const declaredTests = new Set([...contract.matchAll(/^- \*\*(T12-\d{2})/gm)].map((match) => match[1]));
  const rows = [...contract.matchAll(/^\| `(E29|D30)-(\d{2})` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];
  const epic = rows.filter((match) => match[1] === "E29");
  const child = rows.filter((match) => match[1] === "D30");
  assert.equal(epic.length, 15);
  assert.equal(child.length, 23);
  assert.equal(new Set(epic.map((match) => match[2])).size, 15);
  assert.equal(new Set(child.map((match) => match[2])).size, 23);
  assert.equal(new Set(rows.map((match) => `${match[1]}-${match[2]}`)).size, rows.length);
  const declaredSections = new Set([...contract.matchAll(/^## (\d+)\./gm)].map((match) => match[1]));
  const hasStatus = /^Status:/m.test(contract);
  for (const [, prefix, suffix, doneWhen, sections, tests] of rows) {
    assert.notEqual(doneWhen.trim(), "", `${prefix}-${suffix} done-when`);
    assert.notEqual(sections.trim(), "", `${prefix}-${suffix} sections`);
    assert.notEqual(tests.trim(), "", `${prefix}-${suffix} tests`);
    const sectionRefs = [...sections.matchAll(/\d+/g)].map((match) => match[0]);
    assert.ok(sectionRefs.length > 0 || sections.includes("Status"), `${prefix}-${suffix} section refs`);
    for (const section of sectionRefs) {
      assert.equal(declaredSections.has(section), true, `${prefix}-${suffix} §${section} missing`);
    }
    if (sections.includes("Status")) assert.equal(hasStatus, true, `${prefix}-${suffix} Status missing`);
    for (const testId of tests.split(",").map((value) => value.trim())) {
      assert.match(testId, /^T12-\d{2}$/, `${prefix}-${suffix} test id`);
      assert.equal(declaredTests.has(testId), true, `${prefix}-${suffix} ${testId} missing from §12`);
    }
  }
});
