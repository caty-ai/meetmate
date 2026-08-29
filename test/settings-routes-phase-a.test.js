"use strict";

require("./settings-audio-cases");
require("./settings-connections-preview-cases");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const { EMOTION_TAGS } = require("../src/messages");
const { SETTINGS_REGISTRY } = require("../src/settings/registry");
const { initializeRuntime, resetRuntimeForTest } = require("../src/settings/resolver");
const { createSettingsHandler, _test } = require("../src/settings/routes");
const { exportDocumentSchema } = require("../src/settings/schemas");
const { readConfigState } = require("../src/settings/store");

function startup(directory) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({
      openclawUrl: "https://gateway.example",
      openclawToken: "configured-token",
      openaiApiKey: "",
    }),
  });
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

function request(method, url, body, headers = {}) {
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
      ...headers,
    },
    socket: { localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

function fixture(t, document, handlerOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-routes-phase-a-"));
  t.after(() => {
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const runtimeStartup = startup(directory);
  fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  const configState = readConfigState(runtimeStartup.configPath);
  resetRuntimeForTest();
  initializeRuntime({ state: configState, startup: runtimeStartup });
  return { directory, runtimeStartup, configState, handler: createSettingsHandler({ port: 5005, ...handlerOptions }) };
}

test("settings save automatically probes all gate systems with billing explicitly allowed", async (t) => {
  const calls = [];
  const readinessController = {
    configure() {},
    async probeGateSystems(options) { calls.push(options); },
  };
  const { handler, configState } = fixture(t, { agent: { greeting: "before" } }, { readinessController });
  const res = response();
  await handler(request("PUT", "/api/settings", {
    schemaVersion: 1,
    revision: configState.revision,
    fields: { agent_greeting: "after" },
  }), res);
  assert.equal(res.status, 200, res.body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, "settings-save");
  assert.equal(calls[0].allowBilling, true);
  assert.equal(calls[0].force, true);
});

test("Phase A export is an attachment containing only validated stored noncredentials", async (t) => {
  const { handler } = fixture(t, {
    agent: { language: "ja", greeting: "", emotionTags: false },
    llm: { historyMaxTurns: 0 },
    stt: { sonioxApiKey: "must-not-export" },
    audio: { clips: [] },
    server: { port: 5005 },
    unknown: { preserved: true },
  });
  const res = response();
  const handled = await createSettingsHandler({ port: 5005, now: () => new Date("2026-08-27T01:02:03.000Z") })(
    request("GET", "/api/settings/export"),
    res,
  );

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.equal(res.headers["Content-Disposition"], 'attachment; filename="meetmate-settings.json"');
  const document = JSON.parse(res.body);
  assert.equal(exportDocumentSchema.safeParse(document).success, true);
  assert.deepEqual(document, {
    format: "meetmate-settings",
    version: 1,
    exportedAt: "2026-08-27T01:02:03.000Z",
    settings: { agent_emotion_tags: false, agent_language: "ja", llm_history_max_turns: 0 },
  });
  assert.equal(res.body.includes("must-not-export"), false);
  const settings = response();
  assert.equal(await handler(request("GET", "/api/settings"), settings), true);
  assert.equal(settings.status, 200);
  assert.match(JSON.parse(settings.body).revision, /^[a-f0-9]{64}$/);
});

test("Phase A import reports stored-value skips, imports changes, and preserves unknown config", async (t) => {
  const { handler, configState, runtimeStartup } = fixture(t, {
    agent: { language: "ja", greeting: "before" },
    stt: { sonioxApiKey: "preserved-secret" },
    unknown: { nested: [1, 2, 3] },
  });
  const res = response();
  await handler(request("POST", "/api/settings/import", {
    revision: configState.revision,
    document: {
      format: "meetmate-settings",
      version: 1,
      exportedAt: "2026-08-27T01:02:03.000Z",
      settings: { agent_language: "ja", agent_greeting: "after", server_ngrok_domain: "meetmate.example" },
    },
  }), res);

  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.deepEqual(payload.import, {
    imported: ["agent_greeting", "server_ngrok_domain"],
    skipped: ["agent_language"],
  });
  assert.match(payload.revision, /^[a-f0-9]{64}$/);
  const stored = JSON.parse(fs.readFileSync(runtimeStartup.configPath, "utf8"));
  assert.deepEqual(stored.unknown, { nested: [1, 2, 3] });
  assert.equal(stored.stt.sonioxApiKey, "preserved-secret");
  assert.equal(stored.agent.greeting, "after");
  assert.equal(stored.server.ngrokDomain, "meetmate.example");
});

test("Phase A import maps unsupported format/version to 409 and disallowed IDs to 422", async (t) => {
  const { handler, configState } = fixture(t, { agent: { language: "ja" } });
  const baseDocument = {
    format: "meetmate-settings",
    version: 1,
    exportedAt: "2026-08-27T01:02:03.000Z",
    settings: {},
  };
  for (const patch of [
    { format: "other-settings" },
    { version: 0 },
    { version: -1 },
    { version: 1.5 },
    { version: 2 },
  ]) {
    const res = response();
    await handler(request("POST", "/api/settings/import", {
      revision: configState.revision,
      document: { ...baseDocument, ...patch },
    }), res);
    assert.equal(res.status, 409, `${JSON.stringify(patch)} ${res.body}`);
    assert.equal(JSON.parse(res.body).error.code, "SETTINGS_IMPORT_VERSION_UNSUPPORTED");
  }

  for (const id of ["unknown_id", "soniox_api_key", "audio_clips", "server_port", "resolved_home", "mcp_base_url"]) {
    const res = response();
    await handler(request("POST", "/api/settings/import", {
      revision: configState.revision,
      document: { ...baseDocument, settings: { [id]: id === "audio_clips" ? [] : "rejected" } },
    }), res);
    assert.equal(res.status, 422, `${id} ${res.body}`);
    assert.equal(JSON.parse(res.body).error.code, "SETTINGS_VALIDATION_FAILED");
  }
});

test("Phase A PUT preserves, replaces, and explicitly clears masked credentials", async (t) => {
  const { handler, configState, runtimeStartup } = fixture(t, {
    stt: { sonioxApiKey: "original-secret" },
    unknown: { preserved: true },
  });
  const put = async (revision, value) => {
    const res = response();
    await handler(request("PUT", "/api/settings", {
      schemaVersion: 1,
      revision,
      fields: { soniox_api_key: value },
    }), res);
    return res;
  };

  const preserved = await put(configState.revision, "••••••••");
  assert.equal(preserved.status, 200, preserved.body);
  let revision = JSON.parse(preserved.body).revision;
  assert.equal(readConfigState(runtimeStartup.configPath).parsed.stt.sonioxApiKey, "original-secret");
  assert.equal(readConfigState(runtimeStartup.configPath).parsed.unknown.preserved, true);
  assert.equal(preserved.body.includes("original-secret"), false);
  assert.equal(fs.readFileSync(runtimeStartup.configPath, "utf8").includes("••••••••"), false);

  const replaced = await put(revision, "replacement-secret");
  assert.equal(replaced.status, 200, replaced.body);
  revision = JSON.parse(replaced.body).revision;
  assert.equal(readConfigState(runtimeStartup.configPath).parsed.stt.sonioxApiKey, "replacement-secret");
  assert.equal(replaced.body.includes("replacement-secret"), false);

  const empty = await put(revision, "");
  assert.equal(empty.status, 422, empty.body);
  assert.equal(readConfigState(runtimeStartup.configPath).parsed.stt.sonioxApiKey, "replacement-secret");

  const cleared = await put(revision, null);
  assert.equal(cleared.status, 200, cleared.body);
  assert.equal(readConfigState(runtimeStartup.configPath).parsed.stt?.sonioxApiKey, undefined);
  assert.deepEqual(JSON.parse(cleared.body).fields.soniox_api_key, { state: "unset", value: "" });
});

test("Phase A handler mutation proof covers conflict, import reports, and live emotion apply", async (t) => {
  const { handler, configState } = fixture(t, {
    agent: { language: "ja", emotionTags: true },
  });
  const invoke = async (method, url, body) => {
    const res = response();
    await handler(request(method, url, body), res);
    return res;
  };

  const initial = await invoke("GET", "/api/settings");
  assert.equal(initial.status, 200, initial.body);
  assert.equal(JSON.parse(initial.body).revision, configState.revision);

  const changed = await invoke("PUT", "/api/settings", {
    schemaVersion: 1,
    revision: configState.revision,
    fields: { agent_language: "en" },
  });
  assert.equal(changed.status, 200, changed.body);
  let envelope = JSON.parse(changed.body);
  assert.equal(envelope.fields.agent_language, "en");
  assert.equal(envelope.effective.agent_language, "ja");
  assert.equal(envelope.restartRequired.includes("agent_language"), true);

  const stale = await invoke("PUT", "/api/settings", {
    schemaVersion: 1,
    revision: configState.revision,
    fields: { agent_language: "ja" },
  });
  assert.equal(stale.status, 409, stale.body);
  assert.equal(JSON.parse(stale.body).error.code, "SETTINGS_REVISION_CONFLICT");

  const exported = await invoke("GET", "/api/settings/export");
  assert.equal(exported.status, 200, exported.body);
  const document = JSON.parse(exported.body);

  const identical = await invoke("POST", "/api/settings/import", {
    revision: envelope.revision,
    document,
  });
  assert.equal(identical.status, 200, identical.body);
  envelope = JSON.parse(identical.body);
  assert.deepEqual(envelope.import.imported, []);
  assert.deepEqual(envelope.import.skipped, ["agent_emotion_tags", "agent_language"]);

  const modified = await invoke("POST", "/api/settings/import", {
    revision: envelope.revision,
    document: { ...document, settings: { ...document.settings, agent_language: "ja" } },
  });
  assert.equal(modified.status, 200, modified.body);
  envelope = JSON.parse(modified.body);
  assert.deepEqual(envelope.import.imported, ["agent_language"]);
  assert.deepEqual(envelope.import.skipped, ["agent_emotion_tags"]);

  const live = await invoke("PUT", "/api/settings", {
    schemaVersion: 1,
    revision: envelope.revision,
    fields: { agent_emotion_tags: false },
  });
  assert.equal(live.status, 200, live.body);
  envelope = JSON.parse(live.body);
  assert.equal(envelope.fields.agent_emotion_tags, false);
  assert.equal(envelope.effective.agent_emotion_tags, false);
  assert.equal(envelope.restartRequired.includes("agent_emotion_tags"), false);
});

test("connection routes retain all providers and require a SHA-256 revision", async (t) => {
  const { handler, configState } = fixture(t, {});
  for (const provider of ["soniox", "fish-audio"]) {
    const res = response();
    await handler(request("POST", `/api/settings/connections/${provider}/test`, { revision: configState.revision }), res);
    assert.equal(res.status, 200, `${provider} ${res.body}`);
    assert.deepEqual(JSON.parse(res.body), {
      ok: false, provider, code: "NOT_CONFIGURED", message: "Connection is not configured", durationMs: 0,
    });
  }
  for (const provider of ["deepgram", "attendee", "llm", "tunnel"]) {
    const res = response();
    await handler(request("POST", `/api/settings/connections/${provider}/test`, { revision: configState.revision }), res);
    assert.equal(res.status, 200, `${provider} ${res.body}`);
    assert.equal(JSON.parse(res.body).code, "NOT_CONFIGURED");
  }
  for (const provider of ["slack"]) {
    const res = response();
    await handler(request("POST", `/api/settings/connections/${provider}/test`, { revision: configState.revision }), res);
    assert.equal(res.status, 501, `${provider} ${res.body}`);
    const error = JSON.parse(res.body).error;
    assert.deepEqual(Object.keys(error).sort(), ["code", "message", "requestId"]);
    assert.equal(error.code, "TEST_NOT_IMPLEMENTED");
    assert.equal(error.message, "Settings feature is not implemented");
    assert.equal(typeof error.requestId, "string");
  }

  for (const revision of ["bootstrap", "A".repeat(64), "a".repeat(63)]) {
    const res = response();
    await handler(request("POST", "/api/settings/connections/soniox/test", { revision }), res);
    assert.equal(res.status, 422, `${revision} ${res.body}`);
  }

  const unknown = response();
  await handler(request("POST", "/api/settings/connections/not-a-provider/test", { revision: configState.revision }), unknown);
  assert.equal(unknown.status, 422, unknown.body);
  assert.equal(JSON.parse(unknown.body).error.code, "SETTINGS_VALIDATION_FAILED");

  const wrongMethod = response();
  await handler(request("GET", "/api/settings/connections/soniox/test"), wrongMethod);
  assert.equal(wrongMethod.status, 404);
});

test("Phase A settings HTML metadata is registry-derived and script-safe", () => {
  const manifest = _test.buildSettingsUiManifest();
  assert.deepEqual(manifest.fields.map((field) => field.id), SETTINGS_REGISTRY.map((entry) => entry.id));
  for (const field of manifest.fields) {
    const entry = SETTINGS_REGISTRY.find((candidate) => candidate.id === field.id);
    assert.deepEqual(
      { ux: field.ux, credential: field.credential, apply: field.apply, envAlias: field.envAlias, writeSurface: field.writeSurface },
      { ux: entry.ux, credential: entry.credential, apply: entry.apply, envAlias: entry.envAlias, writeSurface: entry.writeSurface },
    );
    assert.match(field.control, /^(credential|boolean|number|array|textarea|select|text)$/);
    if (Object.prototype.hasOwnProperty.call(entry, "defaultValue")) assert.deepEqual(field.defaultValue, entry.defaultValue);
  }
  assert.deepEqual(manifest.fields.find((field) => field.id === "agent_language").options, ["ja", "en"]);
  assert.deepEqual(manifest.fields.find((field) => field.id === "fish_audio_latency").options, ["normal", "balanced", "low"]);
  assert.deepEqual(EMOTION_TAGS.length, 5);

  const rendered = _test.renderSettingsHtml([
    '<script id="settingsUiManifest" type="application/json">__SETTINGS_UI_MANIFEST__</script>',
    '<script id="emotionTagsData" type="application/json">__MEETMATE_EMOTION_TAGS__</script>',
  ].join(""));
  assert.equal(rendered.includes("__SETTINGS_UI_MANIFEST__"), false);
  assert.equal(rendered.includes("__MEETMATE_EMOTION_TAGS__"), false);
  assert.equal(rendered.includes("settingsUiManifest"), true);
  assert.equal(rendered.includes("emotionTagsData"), true);
  assert.equal(_test.safeEmbeddedJson({ value: "</script>&\u2028" }).includes("</script>"), false);
});
