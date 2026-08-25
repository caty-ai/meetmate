"use strict"; // Loaded by paths.test.js so the canonical suite manifest stays fail-closed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const bootstrap = require("../src/settings/bootstrap");
const { scanLegacyClass2, stripLegacyClass2 } = require("../src/settings/class2-migration");
const { ENV_DIAGNOSTICS, MASK, REGISTRY_BY_ID, SETTINGS_REGISTRY } = require("../src/settings/registry");
const {
  buildEnvelope,
  getEffectiveValue,
  initializeRuntime,
  registerCacheInvalidator,
  resetRuntimeForTest,
  resolveDiagnostic,
  resolveDynamicSlackToken,
} = require("../src/settings/resolver");
const { settingsMutationSchema } = require("../src/settings/schemas");
const { readConfigState, saveFields } = require("../src/settings/store");
const { createSettingsHandler } = require("../src/settings/routes");

function startup(overrides = {}) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({ ...(overrides.preDotenvEnv || {}) }),
    dotenvSeeds: Object.freeze({ ...(overrides.dotenvSeeds || {}) }),
    resolvedHome: overrides.resolvedHome || "/tmp/meetmate-settings-hardening",
    configPath: overrides.configPath || "/tmp/meetmate-settings-hardening/config.json",
    connection: Object.freeze({
      openclawUrl: "https://gateway.example",
      openclawToken: "configured-token",
      openaiApiKey: "",
      ...(overrides.connection || {}),
    }),
  });
}

function state(parsed, revision = "a".repeat(64)) {
  return { exists: true, valid: true, parsed, revision, fingerprint: `bytes:${revision}` };
}

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = "") { this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
  };
}

function request(method, url, headers = {}, body = "") {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, headers, socket: { localAddress: "127.0.0.1", localPort: 5005 } });
  return req;
}

function parseDefault(cell) {
  const match = cell.match(/\s\/\s(?:`([^`]*)`|(empty))/);
  if (!match) return { present: false };
  const raw = match[1] ?? "";
  if (raw === "true") return { present: true, value: true };
  if (raw === "false") return { present: true, value: false };
  if (raw === "[]") return { present: true, value: [] };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return { present: true, value: Number(raw) };
  return { present: true, value: raw };
}

function contractRegistry() {
  const contract = fs.readFileSync(path.join(ROOT, "docs/settings-contract.md"), "utf8");
  const rows = [];
  for (const line of contract.split(/\r?\n/)) {
    const match = line.match(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/);
    if (!match) continue;
    const [, id, rawPath, typeDefault, ux, credential, apply, rawAlias] = match.map((value) => value.trim());
    if (!SETTINGS_REGISTRY.some((entry) => entry.id === id)) continue;
    const expectedDefault = parseDefault(typeDefault);
    rows.push({
      id,
      path: rawPath === "synthetic" ? null : rawPath.replaceAll("`", ""),
      ux,
      credential,
      apply,
      envAlias: rawAlias === "none" ? null : rawAlias.replaceAll("`", ""),
      writeSurface: id === "audio_clips" ? "audio-only" : ux === "deployment-readonly" ? "none" : "settings",
      hasDefault: expectedDefault.present,
      defaultValue: expectedDefault.value,
      type: typeDefault.split(/\s\/\s/, 1)[0].replaceAll("`", ""),
    });
  }
  return rows;
}

function assertContractType(type, schema, id) {
  const nullableType = type.endsWith("-or-null");
  const base = nullableType ? type.slice(0, -"-or-null".length) : type;
  assert.equal(schema.safeParse(null).success, nullableType, `${id} nullable`);
  let valid;
  let invalid;
  if (/^str\((\d+)\)$/.test(base)) {
    const max = Number(base.match(/\d+/)[0]);
    valid = "x".repeat(max);
    invalid = "x".repeat(max + 1);
    assert.equal(schema.safeParse("").success, false, `${id} nonempty`);
  } else if (/^text\((\d+)\)$/.test(base)) {
    const max = Number(base.match(/\d+/)[0]);
    valid = "x".repeat(max);
    invalid = "x".repeat(max + 1);
    assert.equal(schema.safeParse("").success, true, `${id} empty text`);
  } else if (base === "bool") {
    valid = true; invalid = "true";
  } else if (/^(int|num)\((-?[\d.]+),(-?[\d.]+)\)$/.test(base)) {
    const [, kind, rawMin, rawMax] = base.match(/^(int|num)\((-?[\d.]+),(-?[\d.]+)\)$/);
    const min = Number(rawMin); const max = Number(rawMax);
    valid = min; invalid = max + 1;
    if (kind === "int" && max > min) assert.equal(schema.safeParse(min + 0.5).success, false, `${id} integer`);
  } else if (base.startsWith("enum(")) {
    const values = base.slice(5, -1).split(",");
    valid = values[0]; invalid = "not-in-enum";
    for (const value of values) assert.equal(schema.safeParse(value).success, true, `${id}:${value}`);
  } else if (base === "url" || base === "url-or-empty") {
    valid = "https://example.com/path?q=1"; invalid = "https://user:pass@example.com/#fragment";
    assert.equal(schema.safeParse("").success, base.endsWith("-or-empty"), `${id} empty URL`);
  } else if (base === "wss-url" || base === "wss-url-or-empty") {
    valid = "wss://example.com/socket"; invalid = "https://example.com/socket";
    assert.equal(schema.safeParse("").success, base.endsWith("-or-empty"), `${id} empty WSS URL`);
  } else if (base === "hostname" || base === "hostname-or-empty") {
    valid = "meet.example.com"; invalid = "https://meet.example.com/path";
    assert.equal(schema.safeParse("").success, base.endsWith("-or-empty"), `${id} empty hostname`);
  } else if (base === "secret") {
    valid = "secret"; invalid = "";
  } else if (base === "str[]") {
    valid = ["one", "two"]; invalid = ["same", "same"];
  } else if (base === "absolute path") {
    valid = path.resolve("/tmp/meetmate"); invalid = "relative/path";
  } else if (base === "clip-record[]") {
    valid = []; invalid = [{}];
  } else {
    assert.fail(`unhandled contract type ${id}: ${type}`);
  }
  assert.equal(schema.safeParse(valid).success, true, `${id} accepts ${type}`);
  assert.equal(schema.safeParse(invalid).success, false, `${id} rejects invalid ${type}`);
}

test("T12-01 registry metadata and generated mutation/effective surfaces deep-match v1.2.1", () => {
  const actual = SETTINGS_REGISTRY.map((entry) => ({
    id: entry.id,
    path: entry.path,
    ux: entry.ux,
    credential: entry.credential,
    apply: entry.apply,
    envAlias: entry.envAlias,
    writeSurface: entry.writeSurface,
    hasDefault: Object.prototype.hasOwnProperty.call(entry, "defaultValue"),
    defaultValue: entry.defaultValue,
  }));
  const contract = contractRegistry();
  assert.deepEqual(actual, contract.map(({ type: _type, ...entry }) => entry));
  for (const expected of contract) assertContractType(expected.type, REGISTRY_BY_ID[expected.id].schema, expected.id);

  const writable = SETTINGS_REGISTRY.filter((entry) => entry.writeSurface === "settings").map((entry) => entry.id).sort();
  const mutationKeys = Object.keys(settingsMutationSchema.shape.fields.shape).sort();
  assert.deepEqual(mutationKeys, writable);
  resetRuntimeForTest();
  initializeRuntime({ state: state({}), startup: startup() });
  const envelope = buildEnvelope();
  assert.deepEqual(Object.keys(envelope.effective).sort(), Object.keys(envelope.sources).sort());
  assert.equal(Object.keys(envelope.effective).every((id) => writable.includes(id)), true);
  assert.deepEqual(
    SETTINGS_REGISTRY.filter((entry) => entry.requiredAtMeetingStart).map((entry) => entry.id).sort(),
    ["agent_display_name", "agent_id", "agent_wake_words", "attendee_api_key", "deepgram_api_key", "fish_audio_api_key", "fish_audio_voice_id", "soniox_api_key"],
  );
});

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const push = (type, value, startLine = line) => tokens.push({ type, value, line: startLine });
  while (index < source.length) {
    const char = source[index];
    if (char === "\n") { line += 1; index += 1; continue; }
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      const startLine = line;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
          continue;
        }
        if (source[index] === "\n") line += 1;
        value += source[index++];
      }
      index += 1;
      push(quote === "`" ? "template" : "string", value, startLine);
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (identifier) {
      push("identifier", identifier[0]);
      index += identifier[0].length;
      continue;
    }
    const punctuator = ["...", "?.", "=>", "==="].find((candidate) => source.startsWith(candidate, index));
    if (punctuator) {
      push("punctuator", punctuator);
      index += punctuator.length;
      continue;
    }
    push("punctuator", char);
    index += 1;
  }
  return tokens;
}

function scanProcessEnv(source) {
  const tokens = tokenize(source);
  const accesses = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "identifier" || tokens[index].value !== "process") continue;
    const previous = tokens[index - 1];
    if (previous && ["const", "let", "var"].includes(previous.value)) throw new Error("shadowed process identifier");
    if (tokens[index + 1]?.value === "?.") throw new Error("optional process.env access");
    if (tokens[index + 1]?.value !== "." || tokens[index + 2]?.value !== "env") continue;
    const next = tokens[index + 3];
    if (next?.value === "?.") throw new Error("optional process.env property access");
    if (next?.value === "." && tokens[index + 4]?.type === "identifier") {
      accesses.push({ kind: "direct", name: tokens[index + 4].value, line: tokens[index].line });
    } else if (next?.value === "[") {
      const key = tokens[index + 4];
      const close = tokens[index + 5];
      if (key?.type === "string" && close?.value === "]") accesses.push({ kind: "literal", name: key.value, line: tokens[index].line });
      else accesses.push({ kind: "computed", expression: key?.value || "", line: tokens[index].line });
    } else {
      accesses.push({ kind: "bare", line: tokens[index].line });
    }
  }
  const functionParamShadow = /function\s*[A-Za-z_$]*\s*\([^)]*\bprocess\b[^)]*\)/.test(source);
  if (functionParamShadow) throw new Error("shadowed process identifier");
  return accesses;
}

function productionJavaScript() {
  const files = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target);
      else if (entry.name.endsWith(".js")) files.push(target);
    }
  };
  collect(path.join(ROOT, "src"));
  collect(path.join(ROOT, "bin"));
  return files.sort();
}

test("T12-02 syntax-consuming environment inventory locks direct, computed, and rejected forms", () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/settings-env-inventory.json"), "utf8"));
  const inventoryByName = new Map(inventory.directReferences.map((entry) => [entry.name, entry]));
  assert.equal(inventoryByName.size, 89);
  const actual = [];
  for (const file of productionJavaScript()) {
    const relative = path.relative(ROOT, file);
    for (const access of scanProcessEnv(fs.readFileSync(file, "utf8"))) actual.push({ ...access, file: relative });
  }
  for (const access of actual.filter((entry) => ["direct", "literal"].includes(entry.kind))) {
    const inventoried = inventoryByName.get(access.name);
    assert.ok(inventoried, `${access.file}:${access.line} ${access.name}`);
    assert.equal(["ordinary-setting", "masked-ui-config-store-export-excluded"].includes(inventoried.handling), false, `${access.name} bypasses resolver`);
  }
  for (const entry of inventory.directReferences) {
    const references = actual.filter((access) => ["direct", "literal"].includes(access.kind) && access.name === entry.name)
      .map((access) => `${access.file}:${access.line}`).filter((value, index, values) => values.indexOf(value) === index).sort();
    assert.deepEqual(entry.references, references, `${entry.name} exact references`);
    assert.equal(entry.remainingDirectReads, references.length, `${entry.name} remainingDirectReads`);
    for (const reference of references) {
      const [file, rawLine] = reference.match(/^(.*):(\d+)$/).slice(1);
      assert.match(fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/)[Number(rawLine) - 1], new RegExp(`process\\.env(?:\\.|\\[['\"])${entry.name}`));
    }
  }
  const migratedNames = new Set(inventory.directReferences
    .filter((entry) => ["ordinary-setting", "masked-ui-config-store-export-excluded"].includes(entry.handling))
    .map((entry) => entry.name));
  assert.equal(actual.filter((entry) => migratedNames.has(entry.name)).length, 0);

  const computed = actual.filter((entry) => entry.kind === "computed");
  const declaredHelpers = new Map(inventory.dynamicReferences.map((entry) => [entry.helper, entry]));
  const configSource = fs.readFileSync(path.join(ROOT, "src/config.js"), "utf8");
  for (const helper of ["boolEnv", "nonNegativeMsEnv", "positiveIntEnv", "nonNegativeIntEnv"]) {
    const declaration = declaredHelpers.get(helper);
    assert.ok(declaration, helper);
    const access = computed.find((entry) => entry.file === "src/config.js" && `${entry.file}:${entry.line}` === declaration.references[0]);
    assert.deepEqual(access && { expression: access.expression }, { expression: "name" }, helper);
    const callNames = [...configSource.matchAll(new RegExp(`${helper}\\(\"([A-Z0-9_]+)\"`, "g"))].map((match) => match[1]).sort();
    assert.deepEqual(callNames, [...declaration.names].sort(), `${helper} names`);
  }
  const bootstrapLines = fs.readFileSync(path.join(ROOT, "src/settings/bootstrap.js"), "utf8").split(/\r?\n/);
  const bootstrapComputedLine = bootstrapLines.findIndex((line) => line.includes("process.env[name]")) + 1;
  assert.deepEqual(computed.filter((entry) => entry.file === "src/settings/bootstrap.js").map((entry) => entry.line), [bootstrapComputedLine, bootstrapComputedLine]);
  const slackDynamic = declaredHelpers.get("per-agent Slack token compatibility lookup");
  assert.deepEqual(slackDynamic.names, []);
  assert.equal(slackDynamic.pattern, "^[A-Z0-9_-]+_SLACK_BOT_TOKEN$");
  for (const reference of slackDynamic.references) {
    const [file, rawLine] = reference.match(/^(.*):(\d+)$/).slice(1);
    assert.match(fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/)[Number(rawLine) - 1], /runtime\.startup\.(?:preDotenvEnv|dotenvSeeds)\[name\]/);
  }
  assert.deepEqual(actual.filter((entry) => entry.kind === "bare").map((entry) => entry.file), ["src/settings/bootstrap.js"]);

  for (const entry of inventory.directReferences) {
    for (const reference of entry.references) {
      const match = reference.match(/^(.+):(\d+)$/);
      assert.ok(match, reference);
      const lines = fs.readFileSync(path.join(ROOT, match[1]), "utf8").split(/\r?\n/);
      assert.ok(Number(match[2]) >= 1 && Number(match[2]) <= lines.length, reference);
      assert.notEqual(lines[Number(match[2]) - 1].trim(), "", reference);
    }
  }
  for (const [source, message] of [
    ["const { X } = process.env", "bare"],
    ["process?.env.X", "optional"],
    ["process.env?.X", "optional"],
    ["function bad(process) { return process.env.X }", "shadowed"],
  ]) assert.throws(() => {
    const found = scanProcessEnv(source);
    if (found.some((entry) => entry.kind === "bare")) throw new Error("bare process.env alias");
  }, new RegExp(message));
  assert.deepEqual(scanProcessEnv('process.env["BRACKET_NAME"]'), [{ kind: "literal", name: "BRACKET_NAME", line: 1 }]);

  const registryByAlias = new Map(SETTINGS_REGISTRY.filter((entry) => entry.envAlias).map((entry) => [entry.envAlias, entry]));
  for (const item of inventory.directReferences) {
    const registry = registryByAlias.get(item.name);
    if (!registry) continue;
    assert.equal(item.ux, registry.ux, item.name);
    assert.equal(item.credentialClass, registry.credential === "class-1" ? "class-1-external-vendor" : "none", item.name);
  }
});

test("T12-04 empty and null tiers fall through while nullable null persists", (t) => {
  const cases = [
    [{ preDotenvEnv: { BOT_IMAGE_URL: "" }, dotenvSeeds: { BOT_IMAGE_URL: "https://seed.example/avatar.png" } }, { agent: { avatarUrl: "" } }, "https://seed.example/avatar.png", ".env-seed"],
    [{ preDotenvEnv: { BOT_IMAGE_URL: "${BOT_IMAGE_URL}" } }, { agent: { avatarUrl: "https://stored.example/avatar.png" } }, "https://stored.example/avatar.png", "config"],
    [{ preDotenvEnv: { BOT_IMAGE_URL: "your-agent" }, dotenvSeeds: { BOT_IMAGE_URL: "https://seed.example/sentinel.png" } }, { agent: { avatarUrl: "your-model-id" } }, "https://seed.example/sentinel.png", ".env-seed"],
    [{ dotenvSeeds: { SONIOX_ENDPOINT_LATENCY_LEVEL: "4" } }, { stt: { soniox: { endpointLatencyLevel: null } } }, 4, ".env-seed"],
    [{}, { stt: { soniox: { endpointLatencyLevel: null } } }, undefined, "unset"],
  ];
  for (const [startupOptions, config, value, source] of cases) {
    resetRuntimeForTest();
    initializeRuntime({ state: state(config), startup: startup(startupOptions) });
    assert.equal(buildEnvelope().effective[config.agent ? "agent_avatar_url" : "soniox_endpoint_latency_level"], value);
    assert.equal(buildEnvelope().sources[config.agent ? "agent_avatar_url" : "soniox_endpoint_latency_level"], value === undefined ? undefined : source);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-null-persist-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const before = readConfigState(configPath);
  const committed = saveFields({ configPath, revision: before.revision, fields: { soniox_endpoint_latency_level: null } });
  assert.equal(committed.parsed.stt.soniox.endpointLatencyLevel, null);
});

test("T12-07 setup issues are registry-derived, semantic, provider-aware, and absence-safe", () => {
  resetRuntimeForTest();
  initializeRuntime({ state: { exists: false, valid: false, parsed: null, revision: "bootstrap", fingerprint: "missing" }, startup: startup() });
  assert.deepEqual(buildEnvelope().issues.find((issue) => issue.fieldId === "agent_id"), { fieldId: "agent_id", code: "VALUE_REQUIRED" });
  assert.equal(buildEnvelope().issues.some((issue) => issue.code === "CONFIG_DOCUMENT_INVALID"), false);

  resetRuntimeForTest();
  initializeRuntime({ state: state({ agent: { language: "xx" } }), startup: startup() });
  assert.deepEqual(buildEnvelope().issues.find((issue) => issue.fieldId === "agent_language"), { fieldId: "agent_language", code: "VALUE_INVALID" });

  resetRuntimeForTest();
  initializeRuntime({ state: state({ server: { port: "bad" } }), startup: startup() });
  assert.deepEqual(buildEnvelope().issues.find((issue) => issue.fieldId === "server_port"), { fieldId: "server_port", code: "VALUE_INVALID" });
  assert.equal(getEffectiveValue("server_port"), 5005);
  assert.equal(buildEnvelope().setupMode, true);

  resetRuntimeForTest();
  initializeRuntime({ state: state({ gateway: { token: "legacy" } }), startup: startup() });
  assert.equal(buildEnvelope().issues.some((issue) => issue.code === "LEGACY_CONNECTION_CONFIG_PRESENT"), false);
  resetRuntimeForTest();
  initializeRuntime({ state: state({ gateway: { token: "legacy" } }), startup: startup({ connection: { openclawUrl: "", openclawToken: "" } }) });
  assert.equal(buildEnvelope().issues.some((issue) => issue.code === "LEGACY_CONNECTION_CONFIG_PRESENT"), true);
});

test("save publishes and invalidates caches while the shared lock is still owned", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-lock-publish-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, '{"agent":{"greeting":"before"}}\n', { mode: 0o600 });
  const before = readConfigState(configPath);
  resetRuntimeForTest();
  initializeRuntime({ state: before, startup: startup({ configPath, resolvedHome: directory }) });
  const observed = [];
  const unregister = registerCacheInvalidator(() => {
    observed.push({ lock: fs.existsSync(path.join(directory, ".meetmate-settings.lock")), greeting: buildEnvelope().effective.agent_greeting });
  });
  t.after(unregister);
  const committed = saveFields({ configPath, revision: before.revision, fields: { agent_greeting: "after" } });
  assert.deepEqual(observed, [{ lock: true, greeting: "after" }]);
  fs.writeFileSync(path.join(directory, ".meetmate-settings.lock"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
  assert.throws(
    () => saveFields({ configPath, revision: committed.revision, fields: { agent_greeting: "blocked" } }),
    (error) => error.code === "SETTINGS_MULTI_PROCESS_UNSUPPORTED" && error.status === 503,
  );
  fs.unlinkSync(path.join(directory, ".meetmate-settings.lock"));
});

test("T12-04 PUT cannot bypass the boot operational snapshot", async (t) => {
  const bootConfig = {
    llm: { provider: "openai-compatible", model: "boot-model", temperature: 0.2 },
    gateway: { warmupTimeoutMs: 1234 },
  };
  const nextConfig = {
    llm: { provider: "openai-compatible", model: "next-model", temperature: 0.8 },
    gateway: { warmupTimeoutMs: 9876 },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-boot-snapshot-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settingsPath = path.join(directory, "config.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify(bootConfig)}\n`, { mode: 0o600 });
  const before = readConfigState(settingsPath);
  resetRuntimeForTest();
  initializeRuntime({
    state: before,
    startup: startup({ configPath: settingsPath, resolvedHome: directory, connection: { openaiApiKey: "openai-key" } }),
  });
  const configPath = require.resolve("../src/config");
  delete require.cache[configPath];
  const { getPipelineConfig } = require(configPath);
  assert.deepEqual(
    ((config) => ({ provider: config.llm.provider, model: config.llm.model, temperature: config.llm.temperature, warmup: config.warmupTimeoutMs }))(getPipelineConfig({}, null, null, bootConfig)),
    { provider: "openai-compatible", model: "boot-model", temperature: 0.2, warmup: 1234 },
  );
  const saved = response();
  await createSettingsHandler({ port: 5005 })(request("PUT", "/api/settings", {
    host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json",
  }, JSON.stringify({
    schemaVersion: 1,
    revision: before.revision,
    fields: { llm_model: "next-model", llm_temperature: 0.8, gateway_warmup_timeout_ms: 9876 },
  })), saved);
  assert.equal(saved.status, 200, saved.body);
  const running = getPipelineConfig({}, null, null, nextConfig);
  assert.deepEqual(
    { provider: running.llm.provider, model: running.llm.model, temperature: running.llm.temperature, warmup: running.warmupTimeoutMs },
    { provider: "openai-compatible", model: "boot-model", temperature: 0.2, warmup: 1234 },
  );
  assert.deepEqual(buildEnvelope().restartRequired.filter((id) => ["llm_model", "llm_temperature", "gateway_warmup_timeout_ms"].includes(id)), [
    "gateway_warmup_timeout_ms", "llm_model", "llm_temperature",
  ]);
});

test("dynamic Slack token uses meaningful launch/seed priority and setup requires explicit enablement", () => {
  resetRuntimeForTest();
  initializeRuntime({
    state: state({ agent: { id: "alpha" }, slack: { notifications: { enabled: true } } }),
    startup: startup({ preDotenvEnv: { ALPHA_SLACK_BOT_TOKEN: "your_slack_bot_token", SLACK_NOTIFY_ENABLED: "true" }, dotenvSeeds: { ALPHA_SLACK_BOT_TOKEN: "seed-token" } }),
  });
  assert.equal(resolveDynamicSlackToken(), "seed-token");
  assert.equal(buildEnvelope().issues.some((issue) => issue.fieldId === "slack_bot_token"), false);

  resetRuntimeForTest();
  initializeRuntime({ state: state({ agent: { id: "bad id" } }), startup: startup({ preDotenvEnv: { BAD_ID_SLACK_BOT_TOKEN: "must-not-use" } }) });
  assert.equal(resolveDynamicSlackToken(), "");
  assert.equal(buildEnvelope().issues.some((issue) => issue.fieldId === "slack_bot_token"), false);
});

test("diagnostic coercion falls from invalid launch to valid seed", () => {
  const diagnostic = ENV_DIAGNOSTICS.find((entry) => entry.id === "attendee_retry_attempts");
  assert.deepEqual(resolveDiagnostic(diagnostic, startup({
    preDotenvEnv: { ATTENDEE_RETRY_ATTEMPTS: "99" },
    dotenvSeeds: { ATTENDEE_RETRY_ATTEMPTS: "4" },
  })), { value: 4, source: ".env-seed" });
  const metrics = ENV_DIAGNOSTICS.find((entry) => entry.id === "metrics_disabled");
  const calibrate = ENV_DIAGNOSTICS.find((entry) => entry.id === "wake_calibrate_enabled");
  assert.equal(resolveDiagnostic(metrics, startup({ preDotenvEnv: { METRICS_DISABLED: "yes" } })).value, true);
  assert.equal(resolveDiagnostic(calibrate, startup({ preDotenvEnv: { WAKE_CALIBRATE_ENABLED: "true" } })).value, false);
});

test("numeric aliases accept finite base-10 only and preserve canonical equality", () => {
  for (const launch of ["0x10", "0b10", "Infinity", "NaN"]) {
    resetRuntimeForTest();
    initializeRuntime({ state: state({ llm: { temperature: 0.7 } }), startup: startup({ preDotenvEnv: { AGENT_TEMPERATURE: launch } }) });
    assert.equal(buildEnvelope().effective.llm_temperature, 0.7, launch);
    assert.equal(buildEnvelope().sources.llm_temperature, "config", launch);
  }
  resetRuntimeForTest();
  initializeRuntime({ state: state({ llm: { temperature: 0.5 } }), startup: startup({ preDotenvEnv: { AGENT_TEMPERATURE: "1.0" } }) });
  const next = state({ llm: { temperature: 1 } }, "b".repeat(64));
  require("../src/settings/resolver").publishState(next);
  assert.equal(buildEnvelope().restartRequired.includes("llm_temperature"), false);
});

test("class-2 scan and strip are symmetric while unrelated unknowns survive", () => {
  const original = {
    unknown: { gatewayUrl: "preserve-outside-deny-context" },
    gateway: { url: "legacy-url", token: "legacy-token", displayName: "keep" },
    agent: { gatewayUrl: "legacy-agent-url", gatewayToken: "legacy-agent-token", extra: true },
    agents: [{ gatewayUrl: "legacy-array-url", openaiCompatible: { apiKey: "legacy-key", other: 1 }, keep: "yes" }],
    sessions: [{ overrides: { gatewayToken: "legacy-override-token", untouched: 2 } }],
  };
  const paths = scanLegacyClass2(original).map((entry) => entry.path);
  assert.deepEqual(paths, [
    "agent.gatewayToken", "agent.gatewayUrl", "agents.0.gatewayUrl", "agents.0.openaiCompatible.apiKey",
    "gateway.token", "gateway.url", "sessions.0.overrides.gatewayToken",
  ]);
  const stripped = stripLegacyClass2(structuredClone(original));
  assert.deepEqual(stripped.unknown, original.unknown);
  assert.equal(stripped.gateway.displayName, "keep");
  assert.equal(stripped.agent.extra, true);
  assert.equal(stripped.agents[0].keep, "yes");
  assert.equal(stripped.agents[0].openaiCompatible.other, 1);
  assert.equal(stripped.sessions[0].overrides.untouched, 2);
  assert.deepEqual(scanLegacyClass2(stripped), []);
});

test("T12-15 settings remain singular-agent while the frozen multi-agent warmup API stays compatible", () => {
  const settingsSurface = ["registry.js", "schemas.js", "routes.js", "resolver.js", "audio.js"]
    .map((name) => fs.readFileSync(path.join(ROOT, "src/settings", name), "utf8")).join("\n");
  assert.doesNotMatch(settingsSurface, /\bagents\b/);
  const warmup = fs.readFileSync(path.join(ROOT, "src/gateway-warmup.js"), "utf8");
  assert.equal(typeof require("../src/gateway-warmup").warmUpMultipleAgents, "function");
  assert.doesNotMatch(warmup, /config\?\.warmupTimeoutMs|baseConfig\?\.warmupTimeoutMs/);
  assert.match(warmup, /getEffectiveValue\("gateway_warmup_timeout_ms"\)/);
  assert.equal(SETTINGS_REGISTRY.some((entry) => entry.id === "agents" || entry.path?.startsWith("agents")), false);
});

test("calibration UI and handler round-trip revision through the shared snapshot store", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-calibrate-revision-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, '{"agent":{"wakeWords":["ケイティ"],"sttWakeVariants":[]}}\n', { mode: 0o600 });
  const before = readConfigState(configPath);
  resetRuntimeForTest();
  initializeRuntime({ state: before, startup: startup({ configPath, resolvedHome: directory }) });
  const previous = process.env.WAKE_CALIBRATE_ENABLED;
  process.env.WAKE_CALIBRATE_ENABLED = "1";
  t.after(() => { if (previous === undefined) delete process.env.WAKE_CALIBRATE_ENABLED; else process.env.WAKE_CALIBRATE_ENABLED = previous; });
  const { handleCalibrate } = require("../src/wake-calibrate/calibrate-routes");
  const applied = response();
  handleCalibrate(request("POST", "/calibrate/apply", { "content-type": "application/json" }, JSON.stringify({ variants: ["けいてぃ"], revision: before.revision })), applied);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied.status, 200, applied.body);
  const result = JSON.parse(applied.body);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(buildEnvelope().revision, result.revision);

  const stale = response();
  handleCalibrate(request("POST", "/calibrate/apply", { "content-type": "application/json" }, JSON.stringify({ variants: ["けいてぃー"], revision: before.revision })), stale);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stale.status, 409);

  const html = fs.readFileSync(path.join(ROOT, "src/wake-calibrate/calibrate.html"), "utf8");
  assert.match(html, /fetch\('\/calibrate\/status'\)/);
  assert.match(html, /JSON\.stringify\(\{ variants, revision: settingsRevision \}\)/);
  const routes = fs.readFileSync(path.join(ROOT, "src/wake-calibrate/calibrate-routes.js"), "utf8");
  assert.doesNotMatch(routes, /readFileSync\([^\n]*CONFIG_PATH|agent\.lang/);
});

test("T12-12 class-1 migration is strict, seed-only, transactional, and value-free", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-migrate-class1-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  const envBytes = "SONIOX_API_KEY=seed-soniox\n# untouched\n";
  fs.writeFileSync(envPath, envBytes, { mode: 0o600 });
  fs.writeFileSync(configPath, '{"gateway":{"token":"legacy-class2"}}\n', { mode: 0o600 });
  const before = readConfigState(configPath);
  resetRuntimeForTest();
  initializeRuntime({ state: before, startup: startup({ configPath, resolvedHome: directory, dotenvSeeds: { SONIOX_API_KEY: "seed-soniox" } }) });
  const res = response();
  await createSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
    host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json",
  }, JSON.stringify({ revision: before.revision })), res);
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.imported, ["soniox_api_key"]);
  assert.deepEqual(body.skipped, ["attendee_api_key", "deepgram_api_key", "fish_audio_api_key", "slack_bot_token"]);
  assert.equal(res.body.includes("seed-soniox"), false);
  const committed = readConfigState(configPath);
  assert.equal(committed.parsed.stt.sonioxApiKey, "seed-soniox");
  assert.equal(committed.parsed.gateway.token, undefined);
  assert.equal(fs.readFileSync(envPath, "utf8"), envBytes);

  const invalid = response();
  await createSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
    host: "localhost:5005", origin: "http://localhost:5005", "content-type": "application/json",
  }, JSON.stringify({ revision: committed.revision, extra: true })), invalid);
  assert.equal(invalid.status, 422);

  const revisionBeforeFailure = buildEnvelope().revision;
  const originalRename = fs.renameSync;
  fs.renameSync = () => { const error = new Error("private path and value must not escape"); error.code = "EACCES"; throw error; };
  try {
    const failed = response();
    await createSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
      host: "localhost:5005", origin: "http://localhost:5005", "content-type": "application/json",
    }, JSON.stringify({ revision: revisionBeforeFailure })), failed);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.includes("private path"), false);
    assert.equal(buildEnvelope().revision, revisionBeforeFailure);
    assert.equal(readConfigState(configPath).revision, revisionBeforeFailure);
    assert.equal(fs.readFileSync(envPath, "utf8"), envBytes);
  } finally {
    fs.renameSync = originalRename;
  }

  const bootstrapDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-migrate-bootstrap-"));
  t.after(() => fs.rmSync(bootstrapDirectory, { recursive: true, force: true }));
  const bootstrapPath = path.join(bootstrapDirectory, "config.json");
  resetRuntimeForTest();
  initializeRuntime({
    state: { exists: false, valid: false, parsed: null, revision: "bootstrap", fingerprint: "missing" },
    startup: startup({ configPath: bootstrapPath, resolvedHome: bootstrapDirectory, dotenvSeeds: { FISH_AUDIO_API_KEY: "bootstrap-fish" } }),
  });
  const recovered = response();
  await createSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
    host: "localhost:5005", origin: "http://localhost:5005", "content-type": "application/json",
  }, JSON.stringify({ revision: "bootstrap" })), recovered);
  assert.equal(recovered.status, 200, recovered.body);
  assert.match(JSON.parse(recovered.body).revision, /^[a-f0-9]{64}$/);
  assert.equal(readConfigState(bootstrapPath).parsed.tts.apiKey, "bootstrap-fish");
});

test("T12-06/T12-07 settings HTTP negative matrix conceals forwarding and returns generic closed errors", async () => {
  resetRuntimeForTest();
  initializeRuntime({ state: state({}), startup: startup() });
  const handler = createSettingsHandler({ port: 5005 });
  const cases = [
    [{ host: "localhost:5005", forwarded: "" }, 404],
    [{ host: "localhost:5005", "x-forwarded-for": "" }, 404],
    [{ host: "localhost:5006" }, 404],
    [{ host: "public.ngrok.app:5005" }, 404],
  ];
  for (const [headers, status] of cases) {
    const res = response();
    await handler(request("GET", "/api/settings", headers), res);
    assert.equal(res.status, status);
    assert.equal(res.headers.Connection, "close");
  }
  for (const host of ["localhost:5005", "127.0.0.1:5005", "[::1]:5005"]) {
    const res = response();
    await handler(request("GET", "/api/settings", { host }), res);
    assert.equal(res.status, 200, host);
  }
  const nonloop = request("GET", "/api/settings", { host: "localhost:5005" });
  nonloop.socket.localAddress = "192.0.2.1";
  const concealed = response();
  await handler(nonloop, concealed);
  assert.equal(concealed.status, 404);
  for (const existingPath of ["/", "/health", "/calibrate", "/agents", "/join-meeting"]) {
    assert.equal(await handler(request("GET", existingPath, { host: "public.example" }), response()), false, existingPath);
  }
  for (const [headers, status, code] of [
    [{ host: "localhost:5005", "content-type": "text/plain", origin: "http://localhost:5005" }, 415, "SETTINGS_MEDIA_TYPE_UNSUPPORTED"],
    [{ host: "localhost:5005", "content-type": "application/json" }, 403, "SETTINGS_ORIGIN_REJECTED"],
    [{ host: "localhost:5005", "content-type": "application/json", origin: "http://localhost:5005", "sec-fetch-site": "cross-site" }, 403, "SETTINGS_ORIGIN_REJECTED"],
  ]) {
    const res = response();
    await handler(request("PUT", "/api/settings", headers, "SENSITIVE-SUBMITTED-VALUE"), res);
    assert.equal(res.status, status);
    assert.equal(JSON.parse(res.body).error.code, code);
    assert.equal(res.body.includes("SENSITIVE-SUBMITTED-VALUE"), false);
    assert.equal(res.headers.Connection, "close");
  }
  for (const [body, status, code] of [
    ["{broken", 400, "SETTINGS_MALFORMED_JSON"],
    [JSON.stringify({ schemaVersion: 1, revision: "bootstrap", fields: { padding: "x".repeat(256 * 1024) } }), 413, "SETTINGS_BODY_TOO_LARGE"],
  ]) {
    const res = response();
    await handler(request("PUT", "/api/settings", {
      host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json",
    }, body), res);
    assert.equal(res.status, status);
    assert.equal(JSON.parse(res.body).error.code, code);
  }

  const serverSource = fs.readFileSync(path.join(ROOT, "src/server.js"), "utf8");
  for (const key of ["setupMode", "meetingReady", "settingsIssues"]) assert.match(serverSource, new RegExp(`\\b${key}\\b`));
  assert.equal((serverSource.match(/settingsStatus\.(?:setupMode|meetingReady|issues)/g) || []).length, 3);
});

test("T12-07 empty-home server bootstrap stays alive and serves health plus setup-gated join in a child process", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-setup-spawn-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = String.raw`
    const { EventEmitter } = require("node:events");
    const { Readable } = require("node:stream");
    const http = require("node:http");
    function run(handler, method, url, host = "localhost:5005") {
      return new Promise((resolve) => {
        const req = Readable.from([]);
        Object.assign(req, { method, url, headers: { host }, socket: { localAddress: "127.0.0.1", localPort: 5005 } });
        const res = { status: 0, body: "", writeHead(status) { this.status = status; }, end(chunk = "") { this.body += String(chunk); resolve({ status: this.status, body: this.body }); } };
        Promise.resolve(handler(req, res)).catch((error) => resolve({ status: 599, body: error.message }));
      });
    }
    http.createServer = (handler) => {
      const server = new EventEmitter();
      server.address = () => ({ port: 5005 });
      server.listen = (_port, callback) => {
        callback();
        setImmediate(async () => {
          const health = await run(handler, "GET", "/health");
          const join = await run(handler, "POST", "/join-meeting");
          const tunnelHome = await run(handler, "GET", "/", "public.ngrok.app:5005");
          const tunnelHealth = await run(handler, "GET", "/health", "public.ngrok.app:5005");
          const tunnelSettings = await run(handler, "GET", "/settings", "public.ngrok.app:5005");
          process.stdout.write("SETUP_RESULT=" + JSON.stringify({ health, join, tunnelHome, tunnelHealth, tunnelSettings, alive: process.exitCode == null }) + "\n");
          process.exit(0);
        });
        return server;
      };
      return server;
    };
    require(${JSON.stringify(path.join(ROOT, "src/server.js"))});
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: directory,
    env: { ...process.env, AI_MEET_HOME: directory, PORT: "5005", WAKE_CALIBRATE_ENABLED: "" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const match = child.stdout.match(/SETUP_RESULT=(\{.*\})/);
  assert.ok(match, child.stdout);
  const result = JSON.parse(match[1]);
  assert.equal(result.health.status, 200);
  const health = JSON.parse(result.health.body);
  assert.equal(health.setupMode, true);
  assert.equal(health.meetingReady, false);
  assert.equal(Array.isArray(health.settingsIssues), true);
  assert.deepEqual(Object.keys(health).filter((key) => !["ok", "service", "agentId", "version", "uptime"].includes(key)).sort(), [
    "meetingReady", "settingsIssues", "setupMode",
  ]);
  assert.equal(result.join.status, 503);
  assert.equal(JSON.parse(result.join.body).error.code, "MEETING_SETUP_REQUIRED");
  assert.equal(result.alive, true);
  assert.equal(result.tunnelHome.status, 200);
  assert.equal(result.tunnelHealth.status, 200);
  assert.equal(result.tunnelSettings.status, 404);
});

test("T12-13 bootstrap, MCP direct main, warmup, profiles, and templates remain value-safe", async () => {
  const bootstrapSource = fs.readFileSync(path.join(ROOT, "src/settings/bootstrap.js"), "utf8");
  assert.match(bootstrapSource, /connectionUrl/);
  const mcpSource = fs.readFileSync(path.join(ROOT, "src/mcp/server.js"), "utf8");
  assert.match(mcpSource, /if \(require\.main === module\) \{\s*captureStartup\(\)/);
  assert.doesNotMatch(mcpSource.split("if (require.main === module)", 1)[0], /captureStartup\(\)/);
  assert.doesNotMatch(mcpSource, /process\.env/);
  const importHome = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-mcp-import-"));
  try {
    fs.writeFileSync(path.join(importHome, ".env"), "AI_MEET_BASE_URL=https://import-side-effect.invalid\n");
    const imported = spawnSync(process.execPath, ["-e", `
      delete process.env.AI_MEET_HOME;
      delete process.env.AI_MEET_BASE_URL;
      require(${JSON.stringify(path.join(ROOT, "src/mcp/server.js"))});
      process.stdout.write(String(process.env.AI_MEET_BASE_URL || "unset"));
    `], { cwd: importHome, env: { ...process.env, AI_MEET_HOME: "", AI_MEET_BASE_URL: "" }, encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "unset");
  } finally {
    fs.rmSync(importHome, { recursive: true, force: true });
  }

  const secretUrl = "https://user:secret@invalid.example/#fragment";
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const result = await require("../src/gateway-warmup").warmUpGatewaySession("session", {
      llm: { provider: "openclaw" }, openclawUrl: secretUrl, openclawToken: "secret-token",
    });
    assert.equal(result.status, "skipped_invalid_gateway_url");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(logs.join("\n").includes(secretUrl), false);
  assert.equal(logs.join("\n").includes("secret-token"), false);

  for (const relative of [".env.example", "config.json.example", "src/agents-template.md"]) {
    const contents = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(contents, /(?:sk-[A-Za-z0-9_-]{12,}|xoxb-[A-Za-z0-9-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/, relative);
  }

  const forbiddenAdminNames = [
    "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN", "OPENAI_COMPATIBLE_API_KEY",
    "WS_SHARED_TOKEN", "JOIN_SHARED_TOKEN", "AI_MEET_JOIN_TOKEN",
    "gateway.url", "gateway.token", "agent.gatewayUrl", "agent.gatewayToken", "openaiCompatible.apiKey",
  ];
  const publicAndAdmin = [
    ...fs.readdirSync(path.join(ROOT, "public")).filter((name) => fs.statSync(path.join(ROOT, "public", name)).isFile()).map((name) => path.join(ROOT, "public", name)),
    ...["registry.js", "schemas.js", "routes.js", "store.js", "audio.js", "resolver.js"].map((name) => path.join(ROOT, "src/settings", name)),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const forbidden of forbiddenAdminNames) assert.equal(publicAndAdmin.includes(forbidden), false, forbidden);

  const generatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-template-scan-"));
  try {
    const prefix = "TEMPLATE-HIGH-ENTROPY";
    const input = [
      `${prefix}-soniox`, `${prefix}-fish`, `${prefix}-voice`, `${prefix}-attendee`,
      "openai-compatible", "http://localhost:4000/v1", `${prefix}-openai-key`, `${prefix}-model`,
    ].join("\n") + "\n";
    const generated = spawnSync(process.execPath, [path.join(ROOT, "bin/ai-meet.js"), "init"], {
      cwd: generatedHome,
      env: { ...process.env, AI_MEET_HOME: generatedHome },
      input,
      encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stderr);
    const agents = fs.readFileSync(path.join(generatedHome, "AGENTS.md"), "utf8");
    assert.doesNotMatch(agents, /^[A-Z][A-Z0-9_]*\s*=/m);
    for (const suffix of ["soniox", "fish", "voice", "attendee", "openai-key", "model"]) {
      assert.equal(agents.includes(`${prefix}-${suffix}`), false, suffix);
    }
    const env = fs.readFileSync(path.join(generatedHome, ".env"), "utf8");
    for (const key of ["OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN"]) {
      assert.match(env, new RegExp(`^${key}=$`, "m"));
    }
  } finally {
    fs.rmSync(generatedHome, { recursive: true, force: true });
  }

  resetRuntimeForTest();
  initializeRuntime({ state: state({ attendee: { apiKey: "attendee-secret" }, agent: { id: "alpha" } }), startup: startup() });
  const profileModule = require("../src/agent-profile");
  profileModule.clearProfileCache();
  const profile = profileModule.resolveAgentProfile();
  assert.equal(JSON.stringify(profile).includes("attendee-secret"), false);
  assert.equal(profile.toString().includes("attendee-secret"), false);
  assert.equal(profile.attendeeApiKey, "attendee-secret");
});

test("invalid startup connection URLs become value-free setup issues", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-invalid-connection-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previous = Object.fromEntries(["AI_MEET_HOME", "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN"].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    bootstrap.resetStartupForTest();
    resetRuntimeForTest();
  });
  for (const badUrl of [" https://gateway.invalid/path ", "https://user:secret@gateway.invalid/path", "ftp://gateway.invalid/path#secret"]) {
    process.env.AI_MEET_HOME = directory;
    process.env.OPENCLAW_GATEWAY_URL = badUrl;
    process.env.OPENCLAW_GATEWAY_TOKEN = "valid-but-private-token";
    bootstrap.resetStartupForTest();
    resetRuntimeForTest();
    const captured = bootstrap.captureStartup();
    assert.equal(captured.connection.openclawUrl, "");
    initializeRuntime({ state: state({}), startup: captured });
    const serialized = JSON.stringify(buildEnvelope());
    assert.deepEqual(buildEnvelope().issues.filter((issue) => issue.fieldId === "llm_provider"), [
      { fieldId: "llm_provider", code: "LLM_CONNECTION_ENV_REQUIRED" },
    ]);
    assert.equal(serialized.includes(badUrl.trim()), false);
    assert.equal(serialized.includes("OPENCLAW_GATEWAY"), false);
    assert.equal(serialized.includes("valid-but-private-token"), false);
  }
});
