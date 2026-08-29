"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("diffFields returns only values that differ from the loaded form state", () => {
  const { diffFields } = require("../public/settings.js");
  const loaded = {
    agent_name: "Meetmate",
    agent_wake_words: ["ミートメイト", "アシスタント"],
    summary_enabled: true,
    nullable_value: null,
  };
  const current = {
    agent_name: "Meetmate",
    agent_wake_words: ["ミートメイト", "アシスタント"],
    summary_enabled: false,
    nullable_value: null,
  };
  assert.deepEqual(diffFields(loaded, current), { summary_enabled: false });
});

test("diffFields supports explicit null, additions, and does not initialize the DOM", () => {
  const modulePath = require.resolve("../public/settings.js");
  delete require.cache[modulePath];
  assert.doesNotThrow(() => require(modulePath));
  const { diffFields } = require(modulePath);
  assert.deepEqual(
    diffFields({ credential: { state: "set", value: "masked" } }, { credential: null, added: 0 }),
    { credential: null, added: 0 },
  );
  assert.deepEqual(diffFields({ preserved: "value" }, {}), {});
});

test("bootstrap prefill and pendingChanges build an exact edited-only PUT body", () => {
  const { pendingChangesForValues, prefillValues, shownValue } = require("../public/settings.js");
  const { _test } = require("../src/settings/routes");
  const manifest = _test.buildSettingsUiManifest().fields.filter((entry) => entry.writeSurface === "settings");
  const envelope = {
    revision: "bootstrap",
    fields: { agent_language: "ja" },
    effective: { agent_name: "Seed Agent", summary_enabled: true },
  };
  assert.equal(shownValue(manifest.find((entry) => entry.id === "agent_name"), envelope), "Seed Agent");
  const loaded = prefillValues(manifest, envelope);
  const current = structuredClone(loaded);
  current.agent_name = "Edited Agent";
  const body = JSON.stringify({
    schemaVersion: 1,
    revision: envelope.revision,
    fields: pendingChangesForValues(loaded, current),
  });
  assert.equal(body, '{"schemaVersion":1,"revision":"bootstrap","fields":{"agent_name":"Edited Agent"}}');
});

test("client field sets deep-match registry UI metadata", () => {
  const { CLIENT_FIELD_SETS } = require("../public/settings.js");
  const { SETTINGS_REGISTRY } = require("../src/settings/registry");
  const { _test } = require("../src/settings/routes");
  const manifestById = new Map(_test.buildSettingsUiManifest().fields.map((entry) => [entry.id, entry]));
  const ids = (values) => [...values].sort();

  assert.deepEqual(ids(CLIENT_FIELD_SETS.TEXTAREA_FIELDS), SETTINGS_REGISTRY.filter((entry) => entry.multiline).map((entry) => entry.id).sort());
  assert.deepEqual(ids(CLIENT_FIELD_SETS.NULLABLE_NUMBER_FIELDS), SETTINGS_REGISTRY
    .filter((entry) => entry.schema.safeParse(null).success && manifestById.get(entry.id)?.control === "number")
    .map((entry) => entry.id).sort());
  for (const [setName, condition] of [
    ["OPENAI_FIELDS", { id: "llm_provider", value: "openai-compatible" }],
    ["SONIOX_FIELDS", { id: "stt_provider", value: "soniox" }],
    ["DEEPGRAM_FIELDS", { id: "stt_provider", value: "deepgram" }],
  ]) {
    assert.deepEqual(ids(CLIENT_FIELD_SETS[setName]), SETTINGS_REGISTRY
      .filter((entry) => JSON.stringify(entry.visibleWhen) === JSON.stringify(condition))
      .map((entry) => entry.id).sort());
  }
  assert.deepEqual(ids(CLIENT_FIELD_SETS.AVATAR_FIELDS), ["avatar_experiment"]);
  assert.equal(SETTINGS_REGISTRY.some((entry) => entry.id === "avatar_experiment"), true);
});

test("avatar_experiment mounts exactly once in panel-avatar with pinned labels and next-join help", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { fieldContainerId } = require("../public/settings.js");
  const { _test } = require("../src/settings/routes");
  const entry = _test.buildSettingsUiManifest().fields.find((field) => field.id === "avatar_experiment");
  assert.equal(fieldContainerId(entry), "avatarFields");
  assert.equal([entry].filter((field) => fieldContainerId(field) === "avatarFields").length, 1);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  const panel = html.match(/<section id="panel-avatar"[\s\S]*?<\/section>\s*<\/section>/)?.[0] || "";
  assert.equal((panel.match(/id="avatarFields"/g) || []).length, 1);
  assert.match(js, /"": "標準（静止画）"/);
  assert.match(js, /"hybrid-local-l0": "2\.5Dリグ"/);
  assert.match(js, /"hybrid-local-frames": "フレームセット"/);
  assert.match(js, /avatar_experiment: "次回の会議参加から反映されます"/);
});

test("main UI parses both setup and readiness 503 envelopes", () => {
  const { parseJoinErrorText } = require("../public/app.js");
  const setup = parseJoinErrorText(JSON.stringify({
    error: { code: "MEETING_SETUP_REQUIRED", message: "Meeting setup is incomplete", issues: [{ fieldId: "agent_id", code: "VALUE_REQUIRED" }] },
  }));
  assert.match(setup, /Meeting setup is incomplete/);
  assert.match(setup, /agent_id/);
  const readiness = parseJoinErrorText(JSON.stringify({
    error: { code: "MEETING_NOT_READY", message: "Not ready", blockers: [{ system: "llm", code: "NOT_ENABLED", message: "Enable chatCompletions" }] },
  }));
  assert.match(readiness, /Not ready/);
  assert.match(readiness, /Enable chatCompletions/);
});

test("dashboard avatar encoder omits follow-settings and preserves all three explicit values", () => {
  const { appendAvatarExperiment, avatarExperimentLabel } = require("../public/app.js");
  let body = appendAvatarExperiment(new URLSearchParams({ meetingUrl: "https://meet.google.com/abc-defg-hij" }), "follow-settings");
  assert.equal(body.has("avatarExperiment"), false);
  body = appendAvatarExperiment(new URLSearchParams(), "");
  assert.equal(body.has("avatarExperiment"), true);
  assert.equal(body.get("avatarExperiment"), "");
  for (const value of ["hybrid-local-l0", "hybrid-local-frames"]) {
    body = appendAvatarExperiment(new URLSearchParams(), value);
    assert.equal(body.get("avatarExperiment"), value);
  }
  assert.equal(avatarExperimentLabel("hybrid-local-l0"), "2.5Dリグ");
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /id="avatarExperiment"/);
  assert.doesNotMatch(html, /id="avatarExperiment"[^>]*\bname=/);
});

test("main UI uses the server-provided settings port for tunnel guidance", () => {
  const { localSettingsUrlFor, settingsPortFromReadiness } = require("../public/app.js");
  assert.equal(settingsPortFromReadiness({ settingsPort: 6123 }, "443"), "6123");
  assert.equal(
    localSettingsUrlFor("server_ngrok_domain", { settingsPort: 6123 }, "443"),
    "http://127.0.0.1:6123/settings#field-server_ngrok_domain",
  );
  assert.equal(
    localSettingsUrlFor("panel-connections", { settingsPort: "invalid" }, ""),
    "http://127.0.0.1:5005/settings#panel-connections",
  );
});

test("main UI keeps a visible recheck surface when readiness cannot be loaded", () => {
  const { readinessDisplayRows } = require("../public/app.js");
  assert.deepEqual(readinessDisplayRows({
    ready: false,
    systems: [],
    blockers: [],
    unavailable: true,
  }), [{ kind: "warning", text: "接続状態を取得できません" }]);
});

test("main UI shows setup-required guidance without manufacturing a blocker", () => {
  const { readinessDisplayRows } = require("../public/app.js");
  assert.deepEqual(readinessDisplayRows({
    ready: false,
    setupRequired: true,
    systems: [],
    blockers: [],
  }), [{
    kind: "setup",
    text: "初期設定が未完了です。設定画面で必須項目を保存してください",
    fieldId: "panel-connections",
  }]);
});
