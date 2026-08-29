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
