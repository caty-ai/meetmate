"use strict"; // Loaded by paths.test.js so the canonical suite manifest stays fail-closed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = module.parent ? require("node:test") : () => {};
const { Readable } = require("node:stream");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const bootstrap = require("../src/settings/bootstrap");
const { scanLegacyClass2, stripLegacyClass2 } = require("../src/settings/class2-migration");
const { ENV_DIAGNOSTICS, MASK, REGISTRY_BY_ID, SETTINGS_REGISTRY } = require("../src/settings/registry");
const {
  buildEnvelope,
  getEffectiveValue,
  initializeRuntime,
  publishCommittedState,
  registerCacheInvalidator,
  resetRuntimeForTest,
  resolveDiagnostic,
  resolveDynamicSlackToken,
} = require("../src/settings/resolver");
const { settingsMutationSchema } = require("../src/settings/schemas");
const { readConfigState, saveFields } = require("../src/settings/store");
const { createSettingsHandler } = require("../src/settings/routes");

const HERMETIC_READINESS = Object.freeze({
  configure() {},
  async probeGateSystems() {},
});

function createHermeticSettingsHandler(options = {}) {
  return createSettingsHandler({ readinessController: HERMETIC_READINESS, ...options });
}

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
    const match = line.match(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/);
    if (!match) continue;
    const [, id, rawPath, typeDefault, ux, credential, apply, rawAlias, rawTransferable] = match.map((value) => value.trim());
    if (!SETTINGS_REGISTRY.some((entry) => entry.id === id)) continue;
    assert.equal(["default", "false"].includes(rawTransferable), true, `${id} transferable marker`);
    const expectedDefault = parseDefault(typeDefault);
    rows.push({
      id,
      path: rawPath === "synthetic" ? null : rawPath.replaceAll("`", ""),
      ux,
      credential,
      apply,
      envAlias: rawAlias === "none" ? null : rawAlias.replaceAll("`", ""),
      writeSurface: id === "audio_clips" ? "audio-only" : ux === "deployment-readonly" ? "none" : "settings",
      transferable: rawTransferable !== "false",
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
  } else if (base === "ws-url") {
    valid = "wss://example.com/socket"; invalid = "https://example.com/socket";
    assert.equal(schema.safeParse("ws://127.0.0.1:8787/socket").success, true, `${id} accepts ws URL`);
  } else if (base === "https-origin-or-empty") {
    valid = "https://meet.example.com:8443"; invalid = "https://meet.example.com/";
    assert.equal(schema.safeParse("").success, true, `${id} empty HTTPS origin`);
  } else if (base === "hostname" || base === "hostname-or-empty") {
    valid = "meet.example.com"; invalid = "https://meet.example.com/path";
    assert.equal(schema.safeParse("").success, base.endsWith("-or-empty"), `${id} empty hostname`);
  } else if (base === "header-token-or-empty") {
    valid = "X-Hermes-Session-Id"; invalid = "invalid header name";
    assert.equal(schema.safeParse("").success, true, `${id} empty header token`);
    assert.equal(schema.safeParse("x".repeat(129)).success, false, `${id} header token length`);
    assert.equal(schema.safeParse("Authorization").success, false, `${id} reserved header name`);
    assert.equal(schema.safeParse("authorization").success, false, `${id} reserved header name case-insensitive`);
  } else if (base === "secret") {
    valid = "secret"; invalid = "";
  } else if (base === "hex-color") {
    valid = "#08111f"; invalid = "green";
  } else if (base.startsWith("str[]")) {
    if (id === "discord_guild_allowlist") {
      valid = ["12345678901234567", "12345678901234567890"];
      invalid = ["not-a-snowflake"];
    } else {
      valid = ["one", "two"]; invalid = ["same", "same"];
    }
  } else if (base === "absolute path") {
    valid = path.resolve("/tmp/meetmate"); invalid = "relative/path";
  } else if (base === "clip-record[]") {
    valid = []; invalid = [{}];
  } else if (base === "iso-datetime") {
    valid = "2026-09-05T12:34:56.000Z"; invalid = "yesterday";
  } else {
    assert.fail(`unhandled contract type ${id}: ${type}`);
  }
  assert.equal(schema.safeParse(valid).success, true, `${id} accepts ${type}`);
  assert.equal(schema.safeParse(invalid).success, false, `${id} rejects invalid ${type}`);
}

test("T12-01 registry metadata and generated mutation/effective surfaces deep-match v1.3.0", () => {
  const actual = SETTINGS_REGISTRY.map((entry) => ({
    id: entry.id,
    path: entry.path,
    ux: entry.ux,
    credential: entry.credential,
    apply: entry.apply,
    envAlias: entry.envAlias,
    writeSurface: entry.writeSurface,
    transferable: entry.transferable,
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
    SETTINGS_REGISTRY.filter((entry) => entry.requiredWhen)
      .map((entry) => [entry.id, structuredClone(entry.requiredWhen)])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ["agent_display_name", { always: true }],
      ["agent_id", { always: true }],
      ["agent_wake_words", { always: true }],
      ["attendee_api_key", { transport: ["meet", "zoom"] }],
      ["deepgram_api_key", { setting: "stt_provider", equals: "deepgram" }],
      ["discord_bot_token", { transport: ["discord"] }],
      ["elevenlabs_api_key", { setting: "tts_provider", equals: "elevenlabs" }],
      ["elevenlabs_voice_id", { setting: "tts_provider", equals: "elevenlabs" }],
      ["fish_audio_api_key", { setting: "tts_provider", equals: "fish-audio" }],
      ["fish_audio_voice_id", { setting: "tts_provider", equals: "fish-audio" }],
      ["openai_compatible_tts_api_key", { setting: "tts_provider", equals: "openai-compatible" }],
      ["slack_bot_token", { setting: "slack_notifications_enabled", equals: true, explicit: true }],
      ["soniox_api_key", { setting: "stt_provider", equals: "soniox" }],
    ],
  );
  assert.equal(REGISTRY_BY_ID.agent_greeting.schema.safeParse("😀".repeat(4096)).success, true);
  assert.equal(REGISTRY_BY_ID.agent_greeting.schema.safeParse("😀".repeat(4097)).success, false);
  assert.equal(REGISTRY_BY_ID.agent_wake_words.schema.safeParse(["😀".repeat(128)]).success, true);
  assert.equal(REGISTRY_BY_ID.agent_wake_words.schema.safeParse(["😀".repeat(129)]).success, false);
  const clip = {
    id: "550e8400-e29b-41d4-a716-446655440000", role: "ack", text: "x",
    sourceRelativePath: "assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.mp3",
    pcmRelativePath: "assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.pcm",
    sourceSha256: "a".repeat(64), pcmSha256: "b".repeat(64), cacheKey: "c".repeat(64),
    referenceId: null, model: "s2-pro", sampleRate: 24000, speed: 1,
    durationMs: 1, sourceBytes: 1, pcmBytes: 2, createdAt: "2026-08-27T00:00:00.000Z",
  };
  assert.equal(REGISTRY_BY_ID.audio_clips.schema.safeParse([{ ...clip, text: "😀".repeat(4096) }]).success, true);
  assert.equal(REGISTRY_BY_ID.audio_clips.schema.safeParse([{ ...clip, text: "😀".repeat(4097) }]).success, false);
  assert.equal(REGISTRY_BY_ID.audio_clips.schema.safeParse([{ ...clip, createdAt: "2026-08-27T07:00:00+07:00" }]).success, false);
});

test("T12-07 Discord transport predicates stay context-free unambiguous", () => {
  for (const entry of SETTINGS_REGISTRY.filter((item) => item.requiredWhen?.transport)) {
    assert.equal(!entry.requiredWhen.transport.includes("discord") || JSON.stringify(entry.requiredWhen.transport) === '["discord"]', true, entry.id);
  }
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
  assert.equal(inventoryByName.size, 99);
  assert.deepEqual(inventory.startupSnapshotReferences, [{
    name: "FFMPEG",
    references: ["src/settings/audio.js:361", "src/settings/audio.js:362"],
    ux: "deployment-readonly",
    credentialClass: "none",
    handling: "startup-snapshot-consumed-binary-override",
  }]);
  for (const reference of inventory.startupSnapshotReferences[0].references) {
    const [, file, rawLine] = reference.match(/^(.+):(\d+)$/);
    assert.match(fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/)[Number(rawLine) - 1], /startup\.(?:preDotenvEnv|dotenvSeeds)\.FFMPEG/);
  }
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
  resetRuntimeForTest();
  initializeRuntime({ state: before, startup: startup({ configPath, resolvedHome: directory }) });
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

  const ready = {
    agent: { id: "alpha", displayName: "Alpha", wakeWords: ["alpha"] },
    stt: { provider: "soniox", sonioxApiKey: "soniox" },
    tts: { apiKey: "fish", voiceId: "voice" },
    attendee: { apiKey: "attendee" },
  };
  resetRuntimeForTest();
  initializeRuntime({ state: state({ ...ready, server: { port: "bad" } }), startup: startup() });
  assert.equal(buildEnvelope().issues.find((issue) => issue.fieldId === "server_port"), undefined);
  assert.equal(getEffectiveValue("server_port"), 5005);
  assert.equal(buildEnvelope().setupMode, false);

  resetRuntimeForTest();
  initializeRuntime({ state: state({ ...ready, audio: { clips: [{}] } }), startup: startup() });
  assert.equal(buildEnvelope().issues.find((issue) => issue.fieldId === "audio_clips"), undefined);
  assert.deepEqual(buildEnvelope().fields.audio_clips, []);
  assert.equal(buildEnvelope().setupMode, false);

  resetRuntimeForTest();
  initializeRuntime({ state: state({ gateway: { token: "legacy" } }), startup: startup() });
  assert.equal(buildEnvelope().issues.some((issue) => issue.code === "LEGACY_CONNECTION_CONFIG_PRESENT"), false);
  resetRuntimeForTest();
  initializeRuntime({ state: state({ gateway: { token: "legacy" } }), startup: startup({ connection: { openclawUrl: "", openclawToken: "" } }) });
  assert.equal(buildEnvelope().issues.some((issue) => issue.code === "LEGACY_CONNECTION_CONFIG_PRESENT"), true);
});

test("TTS setup issues reject provider-incompatible sample rates and canonicalize the hosted OpenAI hostname", () => {
  const base = {
    agent: { id: "alpha", displayName: "Alpha", wakeWords: ["alpha"] },
    stt: { provider: "soniox", sonioxApiKey: "soniox" },
    attendee: { apiKey: "attendee" },
  };
  const issuesFor = (tts) => {
    resetRuntimeForTest();
    initializeRuntime({ state: state({ ...base, tts }), startup: startup() });
    return buildEnvelope().issues;
  };

  assert.deepEqual(
    issuesFor({
      provider: "openai-compatible",
      sampleRate: 48_000,
      openaiCompatibleTts: { baseUrl: "http://127.0.0.1:8080", model: "local", voice: "voice" },
    }).find((issue) => issue.fieldId === "tts_sample_rate"),
    { fieldId: "tts_sample_rate", code: "VALUE_INVALID" },
  );
  assert.equal(
    issuesFor({ provider: "fish-audio", apiKey: "fish", voiceId: "voice", sampleRate: 48_000 })
      .some((issue) => issue.fieldId === "tts_sample_rate"),
    false,
  );
  assert.deepEqual(
    issuesFor({
      provider: "elevenlabs",
      sampleRate: 48_000,
      elevenlabs: { apiKey: "key", voiceId: "voice", model: "model" },
    }).find((issue) => issue.fieldId === "tts_sample_rate"),
    { fieldId: "tts_sample_rate", code: "VALUE_INVALID" },
  );
  assert.equal(
    issuesFor({
      provider: "elevenlabs",
      sampleRate: 8_000,
      elevenlabs: { apiKey: "key", voiceId: "voice", model: "model" },
    }).some((issue) => issue.fieldId === "tts_sample_rate"),
    false,
  );

  for (const baseUrl of ["https://api.openai.com.", "https://API.OPENAI.COM"]) {
    assert.deepEqual(
      issuesFor({
        provider: "openai-compatible",
        sampleRate: 24_000,
        openaiCompatibleTts: { baseUrl, model: "model", voice: "voice" },
      }).find((issue) => issue.fieldId === "openai_compatible_tts_api_key"),
      { fieldId: "openai_compatible_tts_api_key", code: "VALUE_REQUIRED" },
      baseUrl,
    );
  }
});

test("TTS meeting-start requirements apply only to the selected provider", () => {
  const base = {
    agent: { id: "alpha", displayName: "Alpha", wakeWords: ["alpha"] },
    stt: { provider: "soniox", sonioxApiKey: "soniox" },
    attendee: { apiKey: "attendee" },
  };
  const issuesFor = (tts) => {
    resetRuntimeForTest();
    initializeRuntime({ state: state({ ...base, tts }), startup: startup() });
    return buildEnvelope().issues;
  };

  let issues = issuesFor({ provider: "fish-audio", apiKey: "fish", voiceId: "fish-voice" });
  assert.equal(issues.some((issue) => issue.fieldId.startsWith("elevenlabs_")), false);
  assert.equal(issues.some((issue) => issue.fieldId.startsWith("openai_compatible_tts_")), false);

  issues = issuesFor({
    provider: "elevenlabs",
    elevenlabs: { apiKey: "eleven", voiceId: "eleven-voice" },
  });
  assert.equal(issues.some((issue) => issue.fieldId.startsWith("fish_audio_")), false);
  assert.equal(issues.some((issue) => issue.fieldId === "elevenlabs_api_key"), false);

  issues = issuesFor({ provider: "elevenlabs", elevenlabs: { voiceId: "eleven-voice" } });
  assert.deepEqual(issues.find((issue) => issue.fieldId === "elevenlabs_api_key"), {
    fieldId: "elevenlabs_api_key", code: "VALUE_REQUIRED",
  });

  issues = issuesFor({
    provider: "openai-compatible",
    openaiCompatibleTts: { baseUrl: "http://127.0.0.1:8080", model: "local", voice: "local" },
  });
  assert.equal(issues.some((issue) => issue.fieldId === "openai_compatible_tts_api_key"), false);

  issues = issuesFor({ provider: "openai-compatible" });
  assert.deepEqual(issues.find((issue) => issue.fieldId === "openai_compatible_tts_api_key"), {
    fieldId: "openai_compatible_tts_api_key", code: "VALUE_REQUIRED",
  });
});

test("restart-required unset-to-set changes stay on the boot snapshot until restart", () => {
  const agentProfilePath = require.resolve("../src/agent-profile");
  delete require.cache[agentProfilePath];

  resetRuntimeForTest();
  initializeRuntime({ state: state({ agent: { id: "alpha" } }), startup: startup() });
  const profileModule = require(agentProfilePath);
  profileModule.clearProfileCache();
  assert.equal(profileModule.resolveAgentProfile().name, "alpha");

  require("../src/settings/resolver").publishState(state({ agent: { id: "alpha", name: "Next Alpha" } }, "b".repeat(64)));
  profileModule.clearProfileCache();

  assert.equal(buildEnvelope().restartRequired.includes("agent_name"), true);
  assert.equal(profileModule.resolveAgentProfile().name, "alpha");
});

test("published saves invalidate delegation and summary message caches", () => {
  resetRuntimeForTest();
  initializeRuntime({ state: state({}), startup: startup() });
  const meetRoutes = require("../src/transport-meet/meet-routes");
  require("../src/settings/resolver").publishState(state({
    delegation: { sectionHeading: "## Before" },
    prompts: { summary: "before summary" },
  }, "b".repeat(64)));
  assert.match(meetRoutes._test.buildConfiguredDelegationResultsSection([{ status: "ok", resultText: "done" }]), /## Before/);
  assert.equal(meetRoutes._test.configuredSummaryPrompt(), "before summary");

  require("../src/settings/resolver").publishState(state({
    delegation: { sectionHeading: "## After" },
    prompts: { summary: "after summary" },
  }, "c".repeat(64)));
  assert.match(meetRoutes._test.buildConfiguredDelegationResultsSection([{ status: "ok", resultText: "done" }]), /## After/);
  assert.equal(meetRoutes._test.configuredSummaryPrompt(), "after summary");
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
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith(".settings-backup-")), []);
  fs.writeFileSync(path.join(directory, ".meetmate-settings.lock"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
  assert.throws(
    () => saveFields({ configPath, revision: committed.revision, fields: { agent_greeting: "blocked" } }),
    (error) => error.code === "SETTINGS_MULTI_PROCESS_UNSUPPORTED" && error.status === 503,
  );
  fs.unlinkSync(path.join(directory, ".meetmate-settings.lock"));
});

test("backup cleanup failure restores the original bytes and publishes nothing", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-backup-cleanup-failure-"));
  const configPath = path.join(directory, "config.json");
  const originalBytes = Buffer.from('{\n  "agent": { "greeting": "before" },\n  "future": [1, 2, 3]\n}\n');
  fs.writeFileSync(configPath, originalBytes, { mode: 0o600 });
  const before = readConfigState(configPath);
  resetRuntimeForTest();
  initializeRuntime({ state: before, startup: startup({ configPath, resolvedHome: directory }) });
  let invalidations = 0;
  const unregister = registerCacheInvalidator(() => { invalidations += 1; });
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function rejectBackupCleanup(target, ...args) {
    if (path.basename(String(target)).startsWith(".settings-backup-")) {
      const error = new Error("backup cleanup failed");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink.call(this, target, ...args);
  };
  t.after(() => {
    fs.unlinkSync = originalUnlink;
    unregister();
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(
    () => saveFields({ configPath, revision: before.revision, fields: { agent_greeting: "after" } }),
    (error) => error.code === "SETTINGS_TRANSACTION_FAILED" && error.status === 500,
  );
  assert.deepEqual(fs.readFileSync(configPath), originalBytes);
  assert.equal(invalidations, 0);
  assert.equal(buildEnvelope().revision, before.revision);
  assert.equal(buildEnvelope().effective.agent_greeting, "before");
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith(".settings-backup-")), []);
});

test("pre-replacement rename failure cleans up the backup artifact and keeps the original config", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-pre-replacement-failure-"));
  const configPath = path.join(directory, "config.json");
  const originalBytes = Buffer.from('{\n  "agent": { "greeting": "before" },\n  "future": [1, 2, 3]\n}\n');
  fs.writeFileSync(configPath, originalBytes, { mode: 0o600 });
  const before = readConfigState(configPath);
  resetRuntimeForTest();
  initializeRuntime({ state: before, startup: startup({ configPath, resolvedHome: directory }) });
  const originalRename = fs.renameSync;
  fs.renameSync = function failSettingsCommit(source, target, ...args) {
    if (
      String(target) === configPath &&
      path.basename(String(source)).startsWith(".settings-write-")
    ) {
      const error = new Error("rename blocked");
      error.code = "EACCES";
      throw error;
    }
    return originalRename.call(this, source, target, ...args);
  };
  t.after(() => {
    fs.renameSync = originalRename;
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(
    () => saveFields({ configPath, revision: before.revision, fields: { agent_greeting: "after" } }),
    (error) => error.code === "SETTINGS_TRANSACTION_FAILED" && error.status === 500,
  );
  assert.deepEqual(fs.readFileSync(configPath), originalBytes);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith(".settings-backup-")), []);
});

test("publish failure preserves committed config bytes and path mismatch never no-ops", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-publish-failure-"));
  t.after(() => {
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, '{"agent":{"greeting":"before"}}\n', { mode: 0o600 });
  const before = readConfigState(configPath);
  initializeRuntime({
    state: before,
    startup: startup({ configPath: path.join(directory, "different.json"), resolvedHome: directory }),
  });

  assert.throws(
    () => saveFields({ configPath, revision: before.revision, fields: { agent_greeting: "committed" } }),
    (error) => error.code === "SETTINGS_PUBLISH_FAILED" && error.status === 500,
  );
  assert.equal(readConfigState(configPath).parsed.agent.greeting, "committed");
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith(".settings-backup-")), []);
  assert.throws(
    () => publishCommittedState(configPath, readConfigState(configPath)),
    (error) => error.code === "SETTINGS_PUBLISH_PATH_MISMATCH" && error.status === 500,
  );

  resetRuntimeForTest();
  assert.throws(
    () => publishCommittedState(path.join(directory, "still-different.json"), before),
    (error) => error.code === "SETTINGS_PUBLISH_PATH_MISMATCH" && error.status === 500,
  );
});

test("lock acquisition owns first-home creation and blocks pre-lock filesystem writes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-lock-order-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockConfig = path.join(directory, "owner", "config.json");
  const release = require("../src/settings/store")._test.acquireLock(lockConfig);
  assert.equal(fs.existsSync(path.dirname(lockConfig)), true);
  const blockedDirectory = path.join(directory, "blocked-home");
  try {
    assert.throws(
      () => saveFields({ configPath: path.join(blockedDirectory, "config.json"), revision: "bootstrap", fields: {} }),
      (error) => error.code === "SETTINGS_MULTI_PROCESS_UNSUPPORTED",
    );
    assert.equal(fs.existsSync(blockedDirectory), false);
  } finally {
    release();
  }
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
  await createHermeticSettingsHandler({ port: 5005 })(request("PUT", "/api/settings", {
    host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json",
  }, JSON.stringify({
    schemaVersion: 1,
    revision: before.revision,
    fields: {
      llm_model: "next-model",
      llm_temperature: 0.8,
      gateway_warmup_timeout_ms: 9876,
      discord_guild_allowlist: [" 12345678901234567 "],
    },
  })), saved);
  assert.equal(saved.status, 200, saved.body);
  assert.deepEqual(readConfigState(settingsPath).parsed.discord.guildAllowlist, ["12345678901234567"]);
  const running = getPipelineConfig({}, null, null, nextConfig);
  assert.deepEqual(
    { provider: running.llm.provider, model: running.llm.model, temperature: running.llm.temperature, warmup: running.warmupTimeoutMs },
    { provider: "openai-compatible", model: "boot-model", temperature: 0.2, warmup: 1234 },
  );
  assert.deepEqual(buildEnvelope().restartRequired.filter((id) => ["llm_model", "llm_temperature", "gateway_warmup_timeout_ms"].includes(id)), [
    "gateway_warmup_timeout_ms", "llm_model", "llm_temperature",
  ]);
});

test("T12-11 pipeline config resolves and forwards streaming-equivalent at the config boundary", () => {
  resetRuntimeForTest();
  initializeRuntime({
    state: state({
      features: { streamingEquivalentEnabled: false },
      llm: { provider: "openai-compatible", model: "model" },
    }),
    startup: startup({ connection: { openaiApiKey: "key" } }),
  });
  const config = require("../src/config").getPipelineConfig({}, null, null, {});
  assert.equal(config.llm.openaiCompatible.streamingEquivalentEnabled, false);
});

test("gateway warm-up timeout preserves stored zero and falls back to 8000 only when unset", async () => {
  const providerPath = require.resolve("../src/llm-provider");
  const warmupPath = require.resolve("../src/gateway-warmup");
  const originalProviderModule = require.cache[providerPath];
  const observed = [];

  require.cache[providerPath] = {
    exports: {
      createLlmProvider: () => ({
        complete: (_messages, options) => {
          observed.push(options.timeoutMs);
          return Promise.resolve({ statusCode: 500, text: "" });
        },
      }),
    },
  };
  delete require.cache[warmupPath];

  try {
    resetRuntimeForTest();
    initializeRuntime({ state: state({ gateway: { warmupTimeoutMs: 0 } }), startup: startup() });
    await require(warmupPath).warmUpGatewaySession("session-zero", {
      llm: { provider: "openclaw" }, openclawUrl: "http://gateway.test", openclawToken: "token",
    });

    resetRuntimeForTest();
    initializeRuntime({ state: state({}), startup: startup() });
    await require(warmupPath).warmUpGatewaySession("session-default", {
      llm: { provider: "openclaw" }, openclawUrl: "http://gateway.test", openclawToken: "token",
    });
  } finally {
    if (originalProviderModule === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProviderModule;
    delete require.cache[warmupPath];
  }

  assert.deepEqual(observed, [0, 8000]);
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

test("meet-routes runtime diagnostics use the same launch/seed/default parsing as the envelope", () => {
  const routesPath = require.resolve("../src/transport-meet/meet-routes");

  resetRuntimeForTest();
  initializeRuntime({
    state: state({}),
    startup: startup({
      preDotenvEnv: {
        ATTENDEE_RETRY_ATTEMPTS: "99",
        BODY_LIMIT_BYTES: "500",
        ATTENDEE_TIMEOUT_MS: "bad",
      },
      dotenvSeeds: {
        ATTENDEE_RETRY_ATTEMPTS: "4",
        BODY_LIMIT_BYTES: "2048",
        ATTENDEE_TIMEOUT_MS: "1200",
      },
    }),
  });
  let envelope = buildEnvelope();
  let seededDiagnostics = require(routesPath)._test.runtimeDiagnostics();
  assert.deepEqual({
    attendeeRetryAttempts: seededDiagnostics.attendeeRetryAttempts,
    bodyLimitBytes: seededDiagnostics.bodyLimitBytes,
    attendeeTimeoutMs: seededDiagnostics.attendeeTimeoutMs,
  }, {
    attendeeRetryAttempts: envelope.diagnostics.attendee_retry_attempts.value,
    bodyLimitBytes: envelope.diagnostics.body_limit_bytes.value,
    attendeeTimeoutMs: envelope.diagnostics.attendee_timeout_ms.value,
  });

  resetRuntimeForTest();
  initializeRuntime({
    state: state({}),
    startup: startup({
      preDotenvEnv: {
        ATTENDEE_RETRY_ATTEMPTS: "6",
        BODY_LIMIT_BYTES: "4096",
        ATTENDEE_TIMEOUT_MS: "2500",
      },
      dotenvSeeds: {
        ATTENDEE_RETRY_ATTEMPTS: "4",
        BODY_LIMIT_BYTES: "2048",
        ATTENDEE_TIMEOUT_MS: "1200",
      },
    }),
  });
  envelope = buildEnvelope();
  const launchDiagnostics = require(routesPath)._test.runtimeDiagnostics();
  assert.deepEqual({
    attendeeRetryAttempts: launchDiagnostics.attendeeRetryAttempts,
    bodyLimitBytes: launchDiagnostics.bodyLimitBytes,
    attendeeTimeoutMs: launchDiagnostics.attendeeTimeoutMs,
  }, {
    attendeeRetryAttempts: envelope.diagnostics.attendee_retry_attempts.value,
    bodyLimitBytes: envelope.diagnostics.body_limit_bytes.value,
    attendeeTimeoutMs: envelope.diagnostics.attendee_timeout_ms.value,
  });

  resetRuntimeForTest();
  initializeRuntime({ state: state({}), startup: startup() });
  envelope = buildEnvelope();
  const defaultDiagnostics = require(routesPath)._test.runtimeDiagnostics();
  assert.deepEqual({
    attendeeRetryAttempts: defaultDiagnostics.attendeeRetryAttempts,
    bodyLimitBytes: defaultDiagnostics.bodyLimitBytes,
    attendeeTimeoutMs: defaultDiagnostics.attendeeTimeoutMs,
  }, {
    attendeeRetryAttempts: envelope.diagnostics.attendee_retry_attempts.value,
    bodyLimitBytes: envelope.diagnostics.body_limit_bytes.value,
    attendeeTimeoutMs: envelope.diagnostics.attendee_timeout_ms.value,
  });
});

test("diagnostic coercion falls from invalid launch to valid seed", () => {
  const diagnostic = ENV_DIAGNOSTICS.find((entry) => entry.id === "attendee_retry_attempts");
  assert.deepEqual(resolveDiagnostic(diagnostic, startup({
    preDotenvEnv: { ATTENDEE_RETRY_ATTEMPTS: "99" },
    dotenvSeeds: { ATTENDEE_RETRY_ATTEMPTS: "4" },
  })), { value: 4, source: ".env-seed" });
  const metrics = ENV_DIAGNOSTICS.find((entry) => entry.id === "metrics_disabled");
  const calibrate = ENV_DIAGNOSTICS.find((entry) => entry.id === "wake_calibrate_enabled");
  const localAvatarEnvelope = ENV_DIAGNOSTICS.find((entry) => entry.id === "local_avatar_envelope_enabled");
  const localAvatarSlack = ENV_DIAGNOSTICS.find((entry) => entry.id === "local_avatar_envelope_slack_ms");
  assert.equal(resolveDiagnostic(metrics, startup({ preDotenvEnv: { METRICS_DISABLED: "yes" } })).value, true);
  assert.equal(resolveDiagnostic(calibrate, startup({ preDotenvEnv: { WAKE_CALIBRATE_ENABLED: "true" } })).value, false);
  assert.equal(resolveDiagnostic(localAvatarEnvelope, startup({ preDotenvEnv: { LOCAL_AVATAR_ENVELOPE: "off" } })).value, false);
  assert.equal(resolveDiagnostic(localAvatarEnvelope, startup({ preDotenvEnv: { LOCAL_AVATAR_ENVELOPE: "false" } })).value, true);
  assert.equal(resolveDiagnostic(localAvatarSlack, startup({ preDotenvEnv: { LOCAL_AVATAR_ENVELOPE_SLACK_MS: "2000.5" } })).value, 2000.5);
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

test("T12-15 settings remain singular-agent; legacy `agents` is never consumed", () => {
  const settingsSurface = ["registry.js", "schemas.js", "routes.js", "resolver.js", "audio.js"]
    .map((name) => fs.readFileSync(path.join(ROOT, "src/settings", name), "utf8")).join("\n");
  assert.doesNotMatch(settingsSurface, /\bagents\b/);
  const warmup = fs.readFileSync(path.join(ROOT, "src/gateway-warmup.js"), "utf8");
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
  await createHermeticSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
    host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json",
  }, JSON.stringify({ revision: before.revision })), res);
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.imported, ["soniox_api_key"]);
  assert.deepEqual(body.skipped, ["attendee_api_key", "deepgram_api_key", "discord_bot_token", "elevenlabs_api_key", "fish_audio_api_key", "hub_room_salt", "hub_token", "openai_compatible_tts_api_key", "slack_bot_token"]);
  assert.equal(res.body.includes("seed-soniox"), false);
  const committed = readConfigState(configPath);
  assert.equal(committed.parsed.stt.sonioxApiKey, "seed-soniox");
  assert.equal(committed.parsed.gateway.token, undefined);
  assert.equal(fs.readFileSync(envPath, "utf8"), envBytes);

  const invalid = response();
  await createHermeticSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
    host: "localhost:5005", origin: "http://localhost:5005", "content-type": "application/json",
  }, JSON.stringify({ revision: committed.revision, extra: true })), invalid);
  assert.equal(invalid.status, 422);

  const revisionBeforeFailure = buildEnvelope().revision;
  const originalRename = fs.renameSync;
  fs.renameSync = () => { const error = new Error("private path and value must not escape"); error.code = "EACCES"; throw error; };
  try {
    const failed = response();
    await createHermeticSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
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
  await createHermeticSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
    host: "localhost:5005", origin: "http://localhost:5005", "content-type": "application/json",
  }, JSON.stringify({ revision: "bootstrap" })), recovered);
  assert.equal(recovered.status, 200, recovered.body);
  assert.match(JSON.parse(recovered.body).revision, /^[a-f0-9]{64}$/);
  assert.equal(readConfigState(bootstrapPath).parsed.tts.apiKey, "bootstrap-fish");
});

test("T12-12 protocol mask is never migrated or persisted by the store credential path", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-mask-seed-"));
  t.after(() => {
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, '{"stt":{"sonioxApiKey":"original"}}\n', { mode: 0o600 });
  let current = readConfigState(configPath);
  initializeRuntime({
    state: current,
    startup: startup({ configPath, resolvedHome: directory, dotenvSeeds: { FISH_AUDIO_API_KEY: MASK } }),
  });
  const res = response();
  await createHermeticSettingsHandler({ port: 5005 })(request("POST", "/api/settings/migrate-env-class1", {
    host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json",
  }, JSON.stringify({ revision: current.revision })), res);
  assert.equal(res.status, 200, res.body);
  assert.equal(readConfigState(configPath).parsed.tts?.apiKey, undefined);

  current = readConfigState(configPath);
  const committed = saveFields({ configPath, revision: current.revision, fields: { soniox_api_key: MASK } });
  assert.equal(committed.parsed.stt.sonioxApiKey, "original");
  assert.equal(fs.readFileSync(configPath, "utf8").includes(MASK), false);
});

test("actual child-process lock ownership rejects a second writer", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-live-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, '{"agent":{"language":"ja"}}\n', { mode: 0o600 });
  const before = readConfigState(configPath);

  const child = spawn(process.execPath, ["-e", `
    const store = require(process.argv[1]);
    const release = store._test.acquireLock(process.argv[2]);
    process.stdout.write("ready\\n");
    const done = () => {
      try { release(); } catch {}
      process.exit(0);
    };
    process.on("SIGTERM", done);
    process.on("SIGINT", done);
    setInterval(() => {}, 1000);
  `, require.resolve("../src/settings/store"), configPath], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  });

  await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("ready")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`lock holder exited early: ${code}`)));
  });

  assert.throws(
    () => saveFields({ configPath, revision: before.revision, fields: { agent_language: "en" } }),
    (error) => error.code === "SETTINGS_MULTI_PROCESS_UNSUPPORTED" && error.status === 503,
  );
});

test("T12-06/T12-07 settings HTTP negative matrix conceals forwarding and returns generic closed errors", async () => {
  resetRuntimeForTest();
  initializeRuntime({ state: state({}), startup: startup() });
  const handler = createHermeticSettingsHandler({ port: 5005 });
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

function runSetupServer(directory, { connected = false, env = {} } = {}) {
  const script = String.raw`
    const { EventEmitter } = require("node:events");
    const { Readable } = require("node:stream");
    const http = require("node:http");
    const https = require("node:https");
    const blockedNetwork = () => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = () => {};
      request.write = () => {};
      request.end = () => {};
      queueMicrotask(() => request.emit("error", Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" })));
      return request;
    };
    http.get = blockedNetwork;
    http.request = blockedNetwork;
    https.get = blockedNetwork;
    https.request = blockedNetwork;
    global.fetch = async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); };
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
          const readiness = require(${JSON.stringify(path.join(ROOT, "src/settings/readiness.js"))});
          if (${connected}) {
            for (const system of readiness.gateSystems()) readiness.reportRuntimeSuccess(system);
          }
          const payload = readiness.getReadiness();
          const health = await run(handler, "GET", "/health");
          const join = await run(handler, "POST", "/join-meeting");
          const tunnelHome = await run(handler, "GET", "/", "public.ngrok.app:5005");
          const tunnelHealth = await run(handler, "GET", "/health", "public.ngrok.app:5005");
          const tunnelSettings = await run(handler, "GET", "/settings", "public.ngrok.app:5005");
          const settingsUpgradeDestroyed = [];
          for (const url of ["/settings", "/api/settings/audio", "/settings-assets/settings.js"]) {
            const socket = { destroy() { settingsUpgradeDestroyed.push(url); } };
            server.emit("upgrade", { url }, socket, Buffer.alloc(0));
          }
          process.stdout.write("SETUP_RESULT=" + JSON.stringify({ payload, health, join, tunnelHome, tunnelHealth, tunnelSettings, settingsUpgradeDestroyed, alive: process.exitCode == null }) + "\n");
          process.exit(0);
        });
        return server;
      };
      return server;
    };
    require(${JSON.stringify(path.join(ROOT, "src/server.js"))});
  `;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: directory,
    env: { ...process.env, AI_MEET_HOME: directory, PORT: "5005", WAKE_CALIBRATE_ENABLED: "", ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("T12-07 empty-home server bootstrap stays alive and serves health plus setup-gated join in a child process", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-setup-spawn-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = runSetupServer(directory);
  assert.equal(child.status, 0, child.stderr);
  const match = child.stdout.match(/SETUP_RESULT=(\{.*\})/);
  assert.ok(match, child.stdout);
  const result = JSON.parse(match[1]);
  assert.equal(result.health.status, 200);
  const health = JSON.parse(result.health.body);
  assert.equal(health.setupMode, true);
  assert.equal(health.meetingReady, false);
  assert.equal(Array.isArray(health.settingsIssues), true);
  assert.equal(typeof health.instanceId, "string");
  assert.deepEqual(Object.keys(health).filter((key) => !["ok", "service", "agentId", "version", "uptime"].includes(key)).sort(), [
    "instanceId", "meetingReady", "settingsIssues", "setupMode",
  ]);
  assert.equal(result.join.status, 503);
  assert.equal(JSON.parse(result.join.body).error.code, "MEETING_SETUP_REQUIRED");
  assert.equal(result.alive, true);
  assert.equal(result.tunnelHome.status, 200);
  assert.equal(result.tunnelHealth.status, 200);
  assert.equal(result.tunnelSettings.status, 404);
  assert.deepEqual(result.settingsUpgradeDestroyed, ["/settings", "/api/settings/audio", "/settings-assets/settings.js"]);
});

test("T12-07 unreadable and symlink-rejected startup configs stay in non-bootstrap setup mode", (t) => {
  const run = (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `meetmate-read-failure-${mode}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    if (mode === "symlink") {
      const target = path.join(directory, "target.json");
      fs.writeFileSync(target, "{}\n", { mode: 0o600 });
      fs.symlinkSync(target, path.join(directory, "config.json"));
    }
    const script = String.raw`
      const { EventEmitter } = require("node:events");
      const { Readable } = require("node:stream");
      const http = require("node:http");
      const https = require("node:https");
      const blockedNetwork = () => {
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.destroy = () => {};
        request.write = () => {};
        request.end = () => {};
        queueMicrotask(() => request.emit("error", Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" })));
        return request;
      };
      http.get = blockedNetwork;
      http.request = blockedNetwork;
      https.get = blockedNetwork;
      https.request = blockedNetwork;
      global.fetch = async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); };
      if (process.argv[1] === "eacces") {
        const store = require(${JSON.stringify(require.resolve("../src/settings/store"))});
        store.readConfigState = () => { const error = new Error("denied"); error.code = "EACCES"; throw error; };
      }
      function request(handler, method, url, body = "", headers = {}) {
        return new Promise((resolve) => {
          const req = Readable.from(body ? [Buffer.from(body)] : []);
          Object.assign(req, { method, url, headers: { host: "localhost:5005", ...headers }, socket: { localAddress: "127.0.0.1", localPort: 5005 } });
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
            const get = await request(handler, "GET", "/api/settings");
            let put = null;
            if (process.argv[1] === "symlink") {
              const revision = JSON.parse(get.body).revision;
              put = await request(handler, "PUT", "/api/settings", JSON.stringify({ schemaVersion: 1, revision, fields: {} }), {
                origin: "http://localhost:5005", "sec-fetch-site": "same-origin", "content-type": "application/json",
              });
            }
            process.stdout.write("READ_FAILURE_RESULT=" + JSON.stringify({ get, put }) + "\n");
            process.exit(0);
          });
          return server;
        };
        return server;
      };
      require(${JSON.stringify(path.join(ROOT, "src/server.js"))});
    `;
    const child = spawnSync(process.execPath, ["-e", script, mode], {
      cwd: directory,
      env: { ...process.env, AI_MEET_HOME: directory, PORT: "5005", WAKE_CALIBRATE_ENABLED: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const match = child.stdout.match(/READ_FAILURE_RESULT=(\{.*\})/);
    assert.ok(match, child.stdout);
    return JSON.parse(match[1]);
  };

  for (const mode of ["eacces", "symlink"]) {
    const result = run(mode);
    assert.equal(result.get.status, 200, mode);
    const envelope = JSON.parse(result.get.body);
    assert.equal(envelope.setupMode, true, mode);
    assert.match(envelope.revision, /^[a-f0-9]{64}$/, mode);
    assert.notEqual(envelope.revision, "bootstrap", mode);
    if (mode === "symlink") {
      assert.equal(result.put.status, 422);
      assert.equal(JSON.parse(result.put.body).error.code, "SETTINGS_SYMLINK_REJECTED");
    }
  }
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
    const generatedConfig = fs.readFileSync(path.join(generatedHome, "config.json"), "utf8");
    assert.doesNotMatch(generatedConfig, /\[soft voice\].{0,240}\[warm\].{0,240}\[friendly, warm\].{0,240}\[empathetic, unhurried\].{0,240}\[thoughtful\]/);
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

test("init avoids runtime bootstrap and paths imports on the frozen file-I/O path", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-init-bootstrap-"));
  try {
    fs.writeFileSync(path.join(directory, ".env"), "AI_MEET_BASE_URL=https://poison.example\n");
    const preload = path.join(directory, "track-loads.js");
    fs.writeFileSync(preload, `
      const Module = require("node:module");
      const counts = { bootstrap: 0, paths: 0 };
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        const loaded = originalLoad.call(this, request, parent, isMain);
        if (String(request).includes("settings/bootstrap")) counts.bootstrap += 1;
        if (String(request).endsWith("/src/paths") || String(request).endsWith("/src/paths.js") || request === "../src/paths") counts.paths += 1;
        return loaded;
      };
      process.on("exit", () => process.stderr.write("LOAD_COUNTS=" + JSON.stringify(counts) + "\\n"));
    `);
    const result = spawnSync(process.execPath, ["--require", preload, path.join(ROOT, "bin/ai-meet.js"), "init"], {
      cwd: directory,
      env: { ...process.env, AI_MEET_HOME: directory },
      input: [
        "seed-soniox",
        "seed-fish",
        "seed-voice",
        "seed-attendee",
        "openclaw",
        "http://localhost:18789",
        "seed-token",
      ].join("\n") + "\n",
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const match = result.stderr.match(/LOAD_COUNTS=(\{.*\})/);
    assert.ok(match, result.stderr);
    assert.deepEqual(JSON.parse(match[1]), { bootstrap: 0, paths: 0 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

async function requestSettingsStatic(method, url) {
  const res = response();
  const handled = await createSettingsHandler({ port: 5005 })(request(method, url, { host: "localhost:5005" }), res);
  return { handled, status: res.status, headers: res.headers, body: res.body };
}

test("settings page and allowlisted assets are served with exact MIME types and no-store", async () => {
  const page = await requestSettingsStatic("GET", "/settings");
  assert.equal(page.handled, true);
  assert.equal(page.status, 200);
  assert.equal(page.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(page.headers["Cache-Control"], "no-store");
  assert.equal(Number(page.headers["Content-Length"]), Buffer.byteLength(page.body));
  assert.match(page.body, /<title>設定 · Meetmate<\/title>/);
  assert.match(page.body, /\/settings-assets\/settings\.css/);
  assert.match(page.body, /\/settings-assets\/settings\.js/);
  assert.doesNotMatch(page.body, /delivered by the next Epic child/i);

  const css = await requestSettingsStatic("GET", "/settings-assets/settings.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers["Content-Type"], "text/css; charset=utf-8");
  assert.equal(css.headers["Cache-Control"], "no-store");
  assert.match(css.body, /\.settings-panel/);

  const js = await requestSettingsStatic("GET", "/settings-assets/settings.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["Content-Type"], "application/javascript; charset=utf-8");
  assert.equal(js.headers["Cache-Control"], "no-store");
  assert.match(js.body, /ArrowRight/);
  assert.match(js.body, /Home/);
  assert.match(js.body, /End/);
});

test("settings static routes are GET-only and the asset namespace is allowlisted", async () => {
  for (const [method, url] of [
    ["POST", "/settings"],
    ["HEAD", "/settings"],
    ["POST", "/settings-assets/settings.css"],
    ["GET", "/settings-assets/unknown.css"],
    ["GET", "/settings-assets/settings.css/extra"],
  ]) {
    const result = await requestSettingsStatic(method, url);
    assert.equal(result.handled, true, `${method} ${url}`);
    assert.equal(result.status, 404, `${method} ${url}`);
    assert.equal(result.body, "Not Found", `${method} ${url}`);
  }
});

test("settings UI keeps seven accessible tabs and uses injected registry data without fixtures", () => {
  const publicDir = path.join(ROOT, "public");
  const html = fs.readFileSync(path.join(publicDir, "settings.html"), "utf8");
  const js = fs.readFileSync(path.join(publicDir, "settings.js"), "utf8");
  const labels = Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g), (match) => match[1]);
  assert.deepEqual(labels, ["基本", "音声プリセット", "詳細", "デプロイ", "接続テスト", "エクスポート・インポート", "アバター"]);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 7);
  assert.match(html, /aria-selected="true" aria-controls="panel-basic" tabindex="0"/);
  assert.match(html, /id="settingsUiManifest">__SETTINGS_UI_MANIFEST__<\/script>/);
  assert.match(html, /id="emotionTagsData">__MEETMATE_EMOTION_TAGS__<\/script>/);
  for (const marker of ["basicFields", "avatarFields", "avatarAssets", "voiceFields", "detailFields", "diagnosticsList", "変更を保存"]) {
    assert.match(html, new RegExp(marker));
  }
  assert.match(html, /id="audioRole"/);
  assert.match(html, /id="audioFile"[^>]*accept="audio\/mpeg,\.mp3"/);
  assert.match(html, /id="audioClipList"/);
  assert.doesNotMatch(html, /audio-drop-zone[^>]*disabled/);
  assert.match(js, /fetch\("\/api\/settings"/);
  assert.match(js, /method: "PUT"/);
  assert.match(js, /NULLABLE_NUMBER_FIELDS\.has\(entry\.id\) \? null : ""/);
  assert.match(js, /保存 → 再起動 → Join/);
  for (const fixture of ["meeting-assistant", "U012MOCK345", "meetmate-demo.ngrok.app", "greeting-friendly.mp3"]) {
    assert.doesNotMatch(`${html}\n${js}`, new RegExp(fixture.replaceAll(".", "\\.")));
  }
  for (const tag of ["soft voice", "friendly, warm", "empathetic, unhurried"]) {
    assert.doesNotMatch(`${html}\n${js}`, new RegExp(tag));
  }
});

test("home page remains the four-block meeting UI with only a settings header link", () => {
  const publicDir = path.join(ROOT, "public");
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
  const js = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  assert.equal((html.match(/<section\b/g) || []).length, 4);
  for (const marker of ["Bot を起動", "activeCard", "metricsCard", "toolsCard"]) assert.match(html, new RegExp(marker));
  assert.match(html, /<a class="settings-link" href="\/settings">⚙ 設定<\/a>/);
  assert.doesNotMatch(html, /mockSettingsForm|Local admin preview|credential-item|settingsToast/);
  assert.doesNotMatch(css, /Settings UI mock|\.settings-demo|\.credential-item/);
  assert.doesNotMatch(js, /mockSettingsForm|settingsToast|initMockSettings/);
});

test("touched public UI sources do not contain circled step-number literals", () => {
  const publicDir = path.join(ROOT, "public");
  for (const filename of ["index.html", "style.css", "app.js", "settings.html", "settings.css", "settings.js"]) {
    const source = fs.readFileSync(path.join(publicDir, filename), "utf8");
    assert.doesNotMatch(source, /[②③]/, filename);
  }
});

test("#201 legacy readiness notices preserve health, join, secrets, and config bytes", (t) => {
  for (const name of ["registry", "schemas", "routes", "resolver", "audio"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, `src/settings/${name}.js`), "utf8"), /\bagents\b/);
  }
  const parsed = {
    agent: { id: "caty", displayName: "Caty", name: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "main" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-key" },
    tts: { provider: "fish-audio", apiKey: "fish-key", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-key", baseUrl: "app.attendee.dev" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
  };
  const results = [];
  for (const legacy of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-legacy-notices-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const document = structuredClone(parsed);
    if (legacy) {
      document.agents = [{ apiKey: "legacy.secret.value" }];
      document.agent.messages = { groupGreetingTemplate: "secret-template" };
    }
    const configPath = path.join(directory, "config.json");
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    fs.writeFileSync(configPath, bytes);
    const child = runSetupServer(directory, {
      connected: true,
      env: {
        AGENT_ID: "", OPENCLAW_GATEWAY_URL: "https://gateway.example", OPENCLAW_GATEWAY_TOKEN: "gateway-token",
        JOIN_SHARED_TOKEN: "", AI_MEET_JOIN_TOKEN: "",
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stdout + child.stderr, /legacy\.secret\.value|secret-template/);
    const match = child.stdout.match(/SETUP_RESULT=(\{.*\})/);
    assert.ok(match, child.stdout);
    const result = JSON.parse(match[1]);
    assert.equal(result.health.status, 200);
    assert.equal(result.payload.ready, true);
    assert.equal(result.payload.notices.length, legacy ? 2 : 0);
    assert.notEqual(result.join.status, 503);
    assert.deepEqual(fs.readFileSync(configPath), bytes);
    results.push(result);
  }
  const [baseline, legacy] = results;
  assert.deepEqual({ ...legacy.payload, notices: [] }, baseline.payload);
  assert.deepEqual(JSON.parse(legacy.health.body).settingsIssues, JSON.parse(baseline.health.body).settingsIssues);
  assert.equal(JSON.parse(legacy.health.body).meetingReady, JSON.parse(baseline.health.body).meetingReady);
  assert.equal(legacy.join.status, baseline.join.status);
});
