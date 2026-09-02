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

test("successful saves render a persistent status strip until the next edit", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { failedSaveStatus, successfulSaveStatus } = require("../public/settings.js");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  const showStatus = source.match(/function showSaveStatus\([\s\S]*?\n    }\n\n    function clearSaveStatus/)?.[0] || "";
  const savePath = source.match(/async function saveSettings\([\s\S]*?\n    }\n\n    function renderConnectionButtons/)?.[0] || "";

  assert.match(html, /id="saveStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.equal(successfulSaveStatus({ live_field: true }, [{ id: "live_field", apply: "live" }], new Date(2026, 0, 2, 9, 7)), "保存しました（09:07）");
  assert.match(failedSaveStatus("入力値が不正です。"), /入力値が不正です。[\s\S]*確認し、もう一度保存してください。/);
  assert.match(showStatus, /saveStatus\.hidden = false/);
  assert.doesNotMatch(showStatus, /setTimeout|clearTimeout|classList\.remove/);
  assert.doesNotMatch(savePath, /setTimeout|clearTimeout|clearSaveStatus/);
  assert.match(source, /function clearSaveStatus[\s\S]*saveStatus\.hidden = true/);
  assert.match(source, /if \(count && \["success", "restart"\]\.includes\(saveStatus\.dataset\.kind\)\) clearSaveStatus\(\)/);
  assert.match(source, /showSaveStatus\(restartRequired \? "restart" : "success", successfulSaveStatus\(fields, manifest\)\)/);
  assert.match(source, /showSaveStatus\("error", failedSaveStatus\(error\.message\)\)/);
});

test("revision conflicts persist with guidance and a reload affordance on every 409 path", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  const showStatus = source.match(/function showSaveStatus\([\s\S]*?\n    }\n\n    function clearSaveStatus/)?.[0] || "";

  assert.match(html, /id="reloadSettingsPage"[^>]*type="button"/);
  assert.match(showStatus, /function showSaveStatus\(kind, message, reload = false\)/);
  assert.match(showStatus, /reloadSettingsPage\.hidden = !reload/);
  assert.match(source, /showSaveStatus\("conflict", [^\n]+, true\)/);
  assert.match(source, /showSaveStatus\("error", failedSaveStatus\(error\.message\)\)/);
  assert.match(source, /showSaveStatus\(restartRequired \? "restart" : "success", successfulSaveStatus\(fields, manifest\)\)/);
  assert.match(source, /他の場所で設定が変更されました。ページを再読み込みしてください。/);
  assert.match(source, /if \(conflict\)[\s\S]*showRevisionConflict\(\)/);
  assert.equal((source.match(/loadSettings\(true\)/g) || []).length, 3);
  assert.match(source, /reloadSettingsPage\.addEventListener\("click", \(\) => location\.reload\(\)\)/);
});

test("restart-required save status comes from manifest metadata and is separate from setup mode", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { savedFieldsRequireRestart, successfulSaveStatus } = require("../public/settings.js");
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  const savePath = source.match(/async function saveSettings\([\s\S]*?\n    }\n\n    function renderConnectionButtons/)?.[0] || "";
  const manifest = [
    { id: "live_field", apply: "live" },
    { id: "manifest_only_restart_field", apply: "restart-required" },
  ];

  assert.equal(savedFieldsRequireRestart({ live_field: true }, manifest), false);
  assert.equal(savedFieldsRequireRestart({ manifest_only_restart_field: "changed" }, manifest), true);
  assert.match(savePath, /const restartRequired = savedFieldsRequireRestart\(fields, manifest\)/);
  assert.equal(
    successfulSaveStatus({ manifest_only_restart_field: "changed" }, manifest, new Date(2026, 0, 2, 9, 7)),
    "保存済み・再起動で反映（09:07）",
  );

  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  const actions = html.match(/<div class="settings-actions">[\s\S]*?<\/div>\s*<\/form>/)?.[0] || "";
  assert.match(actions, /id="saveStatus"/);
  assert.doesNotMatch(actions, /id="settingsState"/);
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
    ["FISH_TTS_FIELDS", { id: "tts_provider", value: "fish-audio" }],
    ["ELEVENLABS_TTS_FIELDS", { id: "tts_provider", value: "elevenlabs" }],
    ["OPENAI_COMPATIBLE_TTS_FIELDS", { id: "tts_provider", value: "openai-compatible" }],
  ]) {
    assert.deepEqual(ids(CLIENT_FIELD_SETS[setName]), SETTINGS_REGISTRY
      .filter((entry) => JSON.stringify(entry.visibleWhen) === JSON.stringify(condition))
      .map((entry) => entry.id).sort());
  }
  assert.deepEqual(ids(CLIENT_FIELD_SETS.AVATAR_FIELDS), SETTINGS_REGISTRY
    .filter((entry) => entry.path?.startsWith("avatar."))
    .map((entry) => entry.id).sort());

  const source = require("node:fs").readFileSync(require.resolve("../public/settings.js"), "utf8");
  assert.match(source, /currentProvider\("tts_provider", loadedValues\.tts_provider\)/);
  assert.match(source, /FISH_TTS_FIELDS\.has\(entry\.id\) && tts !== "fish-audio"/);
  assert.match(source, /ELEVENLABS_TTS_FIELDS\.has\(entry\.id\) && tts !== "elevenlabs"/);
  assert.match(source, /OPENAI_COMPATIBLE_TTS_FIELDS\.has\(entry\.id\) && tts !== "openai-compatible"/);
});

test("Hermes session header setting is default-off and visible only for OpenAI-compatible providers", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { REGISTRY_BY_ID } = require("../src/settings/registry");
  const entry = REGISTRY_BY_ID.openai_session_header;

  assert.equal(entry.defaultValue, "");
  assert.deepEqual(entry.visibleWhen, { id: "llm_provider", value: "openai-compatible" });
  assert.equal(entry.envAlias, null);
  assert.equal(entry.schema.safeParse("").success, true);
  assert.equal(entry.schema.safeParse("X-Hermes-Session-Id").success, true);
  assert.equal(entry.schema.safeParse("Authorization").success, false);
  assert.equal(entry.schema.safeParse("authorization").success, false);
  assert.equal(entry.schema.safeParse("invalid header name").success, false);
  assert.equal(entry.schema.safeParse("x".repeat(129)).success, false);

  const source = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  assert.match(source, /openai_session_header: "セッションヘッダー名"/);
  assert.match(source, /Hermes Agent api_server 専用/);
});

test("avatar settings mount exactly once in panel-avatar with pinned labels and next-join help", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { CLIENT_FIELD_SETS, fieldContainerId } = require("../public/settings.js");
  const { _test } = require("../src/settings/routes");
  const manifest = _test.buildSettingsUiManifest().fields;
  const { AVATAR_FIELDS, VOICE_FIELDS } = CLIENT_FIELD_SETS;
  for (const id of AVATAR_FIELDS) assert.equal(VOICE_FIELDS.has(id), false, `${id} is routed by two field sets`);
  for (const field of manifest) {
    const eligibleContainers = [
      AVATAR_FIELDS.has(field.id) ? "avatarFields" : null,
      !AVATAR_FIELDS.has(field.id) && VOICE_FIELDS.has(field.id) ? "voiceFields" : null,
      !AVATAR_FIELDS.has(field.id) && !VOICE_FIELDS.has(field.id) && field.ux === "basic" ? "basicFields" : null,
      !AVATAR_FIELDS.has(field.id) && !VOICE_FIELDS.has(field.id) && field.ux !== "basic" ? "detailFields" : null,
    ].filter(Boolean);
    assert.deepEqual(eligibleContainers, [fieldContainerId(field)], `${field.id} must route to exactly one container`);
  }
  const avatarEntries = manifest.filter((field) => AVATAR_FIELDS.has(field.id));
  assert.equal(avatarEntries.some((field) => field.id === "avatar_experiment"), true);
  assert.equal(avatarEntries.some((field) => field.id === "avatar_rig_background_mode"), true);
  assert.equal(avatarEntries.some((field) => field.id === "avatar_rig_background_color"), true);
  assert.equal(avatarEntries.every((field) => fieldContainerId(field) === "avatarFields"), true);
  const entry = avatarEntries.find((field) => field.id === "avatar_experiment");
  assert.equal(fieldContainerId(entry), "avatarFields");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  const panel = html.match(/<section id="panel-avatar"[\s\S]*?<\/section>\s*<\/section>/)?.[0] || "";
  assert.equal((panel.match(/id="avatarFields"/g) || []).length, 1);
  assert.match(js, /"": "標準（静止画）"/);
  assert.match(js, /"hybrid-local-l0": "2\.5Dリグ"/);
  assert.match(js, /"hybrid-local-frames": "フレームセット"/);
  assert.match(js, /avatar_experiment: "次回の会議参加から反映されます"/);
  assert.match(js, /avatar_rig_background_mode: "アバター背景"/);
  assert.match(js, /avatar_rig_background_color: "アバター背景色"/);
  assert.match(js, /2\.5Dリグとフレームセットの両方に適用され/);
  assert.match(js, /solid: "単色"/);
  assert.match(js, /image: "埋め込み画像"/);
  assert.match(js, /chroma: "クロマキー"/);
  assert.match(js, /このビルドには背景画像が埋め込まれていません/);
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
