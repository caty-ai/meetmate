"use strict";

// #274: page-audio default in settings, shown only for self-hosted Attendee (design v1.2 §8).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const { SETTINGS_REGISTRY, REGISTRY_BY_ID } = require("../src/settings/registry");
const resolver = require("../src/settings/resolver");
const readiness = require("../src/settings/readiness");
const { attendeeHostKind } = require("../src/attendee-host-kind");
const app = require("../public/app.js");

const ROOT = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const SELF_HOSTED_ATTENDEE = "attendee.example.com";

function startup(directory) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: "gateway-secret", openaiApiKey: "" }),
  });
}

// `botHost` (#260 PR B) is stored only when given; every #274 case leaves it out.
function settingsDocument({ attendeeBaseUrl = "app.attendee.dev", faceAudioDefault, botHost } = {}) {
  return {
    agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "main" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-secret" },
    tts: { provider: "fish-audio", apiKey: "fish-secret", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-secret", baseUrl: attendeeBaseUrl, ...(botHost === undefined ? {} : { host: botHost }) },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
    ...(faceAudioDefault === undefined ? {} : { avatar: { faceAudioDefault } }),
  };
}

function initRuntime(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-face-audio-default-"));
  t.after(() => {
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: settingsDocument(options), revision: "c".repeat(64), fingerprint: "c".repeat(64) },
    startup: startup(directory),
    serverPort: 5005,
  });
  return directory;
}

// ---- T1 registry row -------------------------------------------------------------------------

test("#274 T1 registry row: face_audio_default shape, counts and pins", (t) => {
  const entry = REGISTRY_BY_ID.face_audio_default;
  assert.ok(entry);
  assert.equal(entry.path, "avatar.faceAudioDefault");
  assert.equal(entry.apply, "next-join");
  assert.equal(entry.defaultValue, "");
  assert.equal(entry.transferable, true);
  assert.equal(entry.envAlias, null);
  assert.equal(entry.credential, "none");
  assert.equal(entry.ux, "detail");
  assert.equal(entry.writeSurface, "settings");
  assert.deepEqual(entry.visibleWhen, { id: "avatar_experiment", value: "face-package" });
  assert.deepEqual(entry.schema.options, ["", "page"]);
  for (const bad of ["on", "PAGE", "websocket", true, null]) assert.equal(entry.schema.safeParse(bad).success, false, String(bad));
  const ids = SETTINGS_REGISTRY.map((item) => item.id);
  assert.equal(ids.indexOf("face_audio_default"), ids.indexOf("face_timeline_offset_ms") + 1);
  assert.equal(SETTINGS_REGISTRY.length, 102);
  assert.equal(SETTINGS_REGISTRY.filter((item) => item.credential === "class-1").length, 11);
  initRuntime(t);
  const envelope = resolver.buildEnvelope();
  assert.equal(Object.keys(envelope.diagnostics).length, 61);
  assert.equal(envelope.effective.face_audio_default, "");
  assert.equal(envelope.sources.face_audio_default, "default");
});

test("#274 T1: a stored page default is the effective next-join value", (t) => {
  initRuntime(t, { faceAudioDefault: "page" });
  assert.equal(resolver.getEffectiveValue("face_audio_default"), "page");
  assert.equal(resolver.getEffectiveSource("face_audio_default"), "config");
  resolver.publishState({ exists: true, valid: true, parsed: settingsDocument({ faceAudioDefault: "" }), revision: "d".repeat(64) });
  assert.equal(resolver.getEffectiveValue("face_audio_default"), "", "next-join: a publish applies without restart");
});

// ---- T2 host kind ----------------------------------------------------------------------------

test("#274 T2 attendeeHostKind: rule on both snapshots, trimmed and case-folded", (t) => {
  const cases = [
    ["app.attendee.dev", "cloud"], [undefined, "cloud"], ["", "cloud"], [null, "cloud"],
    ["App.Attendee.DEV", "cloud"], ["  app.attendee.dev\t", "cloud"],
    [SELF_HOSTED_ATTENDEE, "self-hosted"], ["  Attendee.Example.com ", "self-hosted"], ["app.attendee.dev.example", "self-hosted"],
  ];
  for (const [value, expected] of cases) {
    const effective = t.mock.method(resolver, "getEffectiveValue", (id) => (id === "attendee_base_url" ? value : undefined));
    const published = t.mock.method(resolver, "getPublishedValue", (id) => (id === "attendee_base_url" ? value : undefined));
    assert.equal(attendeeHostKind({ snapshot: "effective" }), expected, `effective ${JSON.stringify(value)}`);
    assert.equal(attendeeHostKind({ snapshot: "published" }), expected, `published ${JSON.stringify(value)}`);
    effective.mock.restore();
    published.mock.restore();
  }
  for (const snapshot of [undefined, "boot", "Effective"]) {
    assert.throws(() => attendeeHostKind({ snapshot }), TypeError);
  }
});

test("#274 T2: a staged custom URL with a boot default is cloud on effective and self-hosted on published", (t) => {
  initRuntime(t);
  assert.equal(attendeeHostKind({ snapshot: "effective" }), "cloud");
  resolver.publishState({ exists: true, valid: true, parsed: settingsDocument({ attendeeBaseUrl: SELF_HOSTED_ATTENDEE }), revision: "e".repeat(64) });
  assert.equal(attendeeHostKind({ snapshot: "effective" }), "cloud");
  assert.equal(attendeeHostKind({ snapshot: "published" }), "self-hosted");
  initRuntime(t, { attendeeBaseUrl: "App.Attendee.Dev" });
  assert.equal(attendeeHostKind({ snapshot: "effective" }), "cloud", "a mixed-case stored cloud host");
});

test("#274 T2: no other src/ or public/ file compares against app.attendee.dev for host kind", () => {
  const offenders = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (/\.(?:js|mjs|cjs|html|md)$/.test(entry.name)) {
        const relative = path.relative(ROOT, target);
        const source = fs.readFileSync(target, "utf8");
        const count = source.split("app.attendee.dev").length - 1;
        if (!count || relative === path.join("src", "attendee-host-kind.js")) continue;
        if (relative === path.join("src", "settings", "registry.js")) {
          assert.equal(count, 1, "registry carries only the attendee_base_url default");
          assert.match(source, /d\("attendee_base_url", "attendee\.baseUrl", hostname\(\), \{ envAlias: "ATTENDEE_API_BASE_URL", defaultValue: "app\.attendee\.dev" \}\)/);
          continue;
        }
        offenders.push(relative);
      }
    }
  }
  walk(path.join(ROOT, "src"));
  walk(path.join(ROOT, "public"));
  assert.deepEqual(offenders, []);
  assert.match(read("src/attendee-host-kind.js"), /#260: a stored `bot_host` decides; with none stored, the pre-#260 URL rule holds\. This is the only host-kind source\./);
});

// ---- envelope member (§4.1) -------------------------------------------------------------------

const HERMETIC_READINESS = Object.freeze({
  configure() {},
  async probeGateSystems() {},
  async probeSystem() { return { ok: false, code: "NOT_CONFIGURED" }; },
});

function settingsResponse() {
  return {
    status: null,
    body: "",
    writeHead(status) { this.status = status; },
    end(chunk = "") { this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
  };
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

test("#274 envelope: attendeeHostKind is a top-level member on GET and PUT, outside effective and diagnostics", async (t) => {
  const { createSettingsHandler } = require("../src/settings/routes");
  const { readConfigState } = require("../src/settings/store");
  for (const [attendeeBaseUrl, expected] of [["app.attendee.dev", "cloud"], [SELF_HOSTED_ATTENDEE, "self-hosted"]]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-face-audio-envelope-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const runtimeStartup = startup(directory);
    fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify(settingsDocument({ attendeeBaseUrl }))}\n`, { mode: 0o600 });
    const state = readConfigState(runtimeStartup.configPath);
    resolver.resetRuntimeForTest();
    resolver.initializeRuntime({ state, startup: runtimeStartup });
    t.after(() => resolver.resetRuntimeForTest());
    const handler = createSettingsHandler({ port: 5005, readinessController: HERMETIC_READINESS });

    const get = settingsResponse();
    await handler(settingsRequest("GET", "/api/settings"), get);
    assert.equal(get.status, 200, get.body);
    const envelope = JSON.parse(get.body);
    assert.equal(envelope.attendeeHostKind, expected);
    assert.equal(Object.hasOwn(envelope.effective, "attendeeHostKind"), false);
    assert.equal(Object.hasOwn(envelope.diagnostics, "attendeeHostKind"), false);
    assert.equal(Object.keys(envelope.diagnostics).length, 61);

    const put = settingsResponse();
    await handler(settingsRequest("PUT", "/api/settings", { schemaVersion: 1, revision: envelope.revision, fields: { face_audio_default: "page" } }), put);
    assert.equal(put.status, 200, put.body);
    const saved = JSON.parse(put.body);
    assert.equal(saved.attendeeHostKind, expected);
    assert.equal(saved.fields.face_audio_default, "page");
    assert.equal(saved.effective.face_audio_default, "page");
    assert.equal(JSON.parse(fs.readFileSync(runtimeStartup.configPath, "utf8")).avatar.faceAudioDefault, "page");
  }
});

// ---- T9 GET /info ----------------------------------------------------------------------------

function unavailableNgrokHttpGet() {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  queueMicrotask(() => request.emit("error", Object.assign(new Error("ngrok unavailable in test"), { code: "ECONNREFUSED" })));
  return request;
}

async function unavailable() {
  throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" });
}

async function getInfo(t, options) {
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  initRuntime(t, options);
  readiness.reset();
  delete require.cache[routesPath];
  t.after(() => {
    delete require.cache[routesPath];
    readiness.reset();
  });
  const routes = require(routesPath);
  await routes.init({ detectNgrok: false, loadAvatar: false,
    readinessProbeOptions: { fetchFn: unavailable, requestFn: unavailable, httpGet: unavailableNgrokHttpGet } });
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url: "/info", headers: { host: "meetmate.example" },
    socket: { remoteAddress: "203.0.113.8", localAddress: "127.0.0.1", localPort: 5005 } });
  const output = { status: 0, text: "" };
  await routes.handleHttp(req, {
    writeHead(status) { output.status = status; },
    end(chunk = "") { output.text += String(chunk); },
  });
  assert.equal(output.status, 200);
  return JSON.parse(output.text);
}

test("#274 T9 GET /info gains exactly attendeeHostKind and faceAudioDefault; previous members unchanged", async (t) => {
  const previousMembers = ["ttsProvider", "lang", "publicWsUrl", "ready", "fixedAgentId", "primaryAgent"];
  let baseline = null;
  for (const attendeeBaseUrl of ["app.attendee.dev", SELF_HOSTED_ATTENDEE]) {
    for (const faceAudioDefault of [undefined, "", "page"]) {
      const info = await getInfo(t, { attendeeBaseUrl, faceAudioDefault });
      const label = `${attendeeBaseUrl} ${faceAudioDefault}`;
      const text = JSON.stringify(info);
      for (const secret of ["attendee-secret", "fish-secret", "soniox-secret", "gateway-secret", SELF_HOSTED_ATTENDEE]) {
        assert.equal(text.includes(secret), false, `${label}: ${secret}`);
      }
      assert.deepEqual(Object.keys(info), [...previousMembers, "attendeeHostKind", "faceAudioDefault"], label);
      assert.equal(info.attendeeHostKind, attendeeBaseUrl === SELF_HOSTED_ATTENDEE ? "self-hosted" : "cloud", label);
      assert.equal(info.faceAudioDefault, faceAudioDefault === "page" ? "page" : "", label);
      const previous = Object.fromEntries(previousMembers.map((key) => [key, info[key]]));
      baseline ||= previous;
      assert.deepEqual(previous, baseline, `${label}: existing members do not depend on the new settings`);
    }
  }
  assert.deepEqual(baseline, {
    ttsProvider: "fish-audio",
    lang: "ja",
    publicWsUrl: "",
    ready: true,
    fixedAgentId: "caty",
    primaryAgent: { id: "caty", name: "Caty", displayName: "Caty", greeting: null },
  });
});

// ---- T6 join form ----------------------------------------------------------------------------

function fakeElement(props) {
  const listeners = {};
  return Object.assign({
    hidden: false,
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    dispatch(type) { for (const listener of listeners[type] || []) listener(); },
  }, props);
}

const BASE_FORM = { meetingUrl: "https://meet.google.com/abc-defg-hij", availableAgents: [], wsUrl: "wss://meetmate.example/realtime" };
const SELF_PAGE = { attendeeHostKind: "self-hosted", faceAudioDefault: "page" };

// Mirrors the page: the select, the option label, the box and the hint, wired by the real helper.
function joinForm(selection = "follow-settings") {
  const select = fakeElement({ value: selection });
  const option = fakeElement({ hidden: true });
  const box = fakeElement({ checked: false });
  const hint = fakeElement({ hidden: true });
  const control = app.createFaceAudioControl({ selectEl: select, optionEl: option, boxEl: box, hintEl: hint });
  return {
    select, option, box, hint, control,
    choose(value) { select.value = value; select.dispatch("change"); },
    click() { box.checked = !box.checked; box.dispatch("change"); },
    // The submit handler's call: buildMeetJoinFormData({ ..., avatarExperiment, ...faceAudioControl.joinInputs() }).
    field() {
      const body = app.buildMeetJoinFormData({ ...BASE_FORM, avatarExperiment: select.value, ...control.joinInputs() });
      return body.has("faceAudio") ? body.get("faceAudio") : null;
    },
  };
}

test("#274 T6 pristine box sends no field for both default values; touched sends the click", () => {
  for (const info of [SELF_PAGE, { attendeeHostKind: "self-hosted", faceAudioDefault: "" }]) {
    const form = joinForm();
    form.control.setInfo(info);
    form.choose("face-package");
    assert.equal(form.option.hidden, false);
    assert.equal(form.box.checked, info.faceAudioDefault === "page", "display follows the /info default");
    assert.equal(form.hint.hidden, true);
    assert.equal(form.field(), null, "pristine -> no field, the server default applies");
    form.click();
    assert.equal(form.field(), info.faceAudioDefault === "page" ? "" : "page", "touched -> the click");
    form.click();
    assert.equal(form.field(), info.faceAudioDefault === "page" ? "page" : "");
  }
  const cloud = joinForm("face-package");
  cloud.control.setInfo({ attendeeHostKind: "cloud", faceAudioDefault: "page" });
  assert.equal(cloud.box.checked, false, "a cloud host never pre-sets the box");
  assert.equal(cloud.field(), null);
});

test("#274 T6 touched+checked -> page, touched+unchecked -> explicit off, non-face-package -> no field", () => {
  const form = joinForm();
  form.control.setInfo({ attendeeHostKind: "self-hosted", faceAudioDefault: "" });
  form.choose("face-package");
  form.click();
  assert.equal(form.field(), "page");
  form.click();
  assert.equal(form.field(), "");
  for (const other of ["follow-settings", "", "hybrid-local-l0", "hybrid-local-frames"]) {
    form.choose("face-package");
    form.click();
    form.choose(other);
    assert.equal(form.option.hidden, true, other);
    assert.equal(form.box.checked, false, other);
    assert.equal(form.field(), null, other);
    for (const pristine of [true, false]) {
      for (const checked of [true, false]) {
        assert.deepEqual(app.faceAudioJoinInputs({ selection: other, pristine, checked }), { faceAudioPage: false, faceAudioOff: false });
      }
    }
  }
});

test("#274 T6 re-selecting face-package re-applies the displayed default and resets to pristine", () => {
  const form = joinForm();
  form.control.setInfo(SELF_PAGE);
  form.choose("face-package");
  form.click();
  assert.equal(form.box.checked, false);
  assert.equal(form.field(), "");
  form.choose("hybrid-local-l0");
  form.choose("face-package");
  assert.equal(form.box.checked, true, "default re-applied");
  assert.equal(form.field(), null, "pristine again");
});

test("#274 T6 a late /info after a touch: the body follows the click and the display is not rewritten", () => {
  const checkedBeforeInfo = joinForm("face-package");
  assert.equal(checkedBeforeInfo.hint.hidden, false, "hint while /info is pending");
  checkedBeforeInfo.click();
  checkedBeforeInfo.control.setInfo({ attendeeHostKind: "self-hosted", faceAudioDefault: "" });
  assert.equal(checkedBeforeInfo.box.checked, true, "a touched box is never rewritten");
  assert.equal(checkedBeforeInfo.field(), "page");
  assert.equal(checkedBeforeInfo.hint.hidden, true);

  const uncheckedBeforeInfo = joinForm("face-package");
  uncheckedBeforeInfo.click();
  uncheckedBeforeInfo.click();
  uncheckedBeforeInfo.control.setInfo(SELF_PAGE);
  assert.equal(uncheckedBeforeInfo.box.checked, false, "a touched box is never rewritten");
  assert.equal(uncheckedBeforeInfo.field(), "");

  const pristine = joinForm("face-package");
  pristine.control.setInfo(SELF_PAGE);
  assert.equal(pristine.box.checked, true, "a late /info updates a pristine box");
  assert.equal(pristine.field(), null);
});

test("#274 T6 missing #faceAudioOption or #faceAudioPage: no throw, the submit path sends no faceAudio field", () => {
  const select = fakeElement({ value: "face-package" });
  for (const elements of [{ optionEl: null, boxEl: fakeElement({ checked: true }) }, { optionEl: fakeElement({}), boxEl: null }, { optionEl: null, boxEl: null }]) {
    const control = app.createFaceAudioControl({ selectEl: select, hintEl: null, ...elements });
    assert.doesNotThrow(() => control.setInfo(SELF_PAGE));
    assert.doesNotThrow(() => control.setInfo(null));
    assert.deepEqual(control.joinInputs(), { faceAudioPage: false, faceAudioOff: false });
    assert.equal(app.buildMeetJoinFormData({ ...BASE_FORM, avatarExperiment: "face-package", ...control.joinInputs() }).has("faceAudio"), false);
  }
  const page = read("public/app.js");
  assert.match(page, /let faceAudioHintEl = null;\n  if \(faceAudioOptionEl && faceAudioPageEl\) \{/, "the hint is only built when both elements exist");
});

test("#274 T6 /info failed: box unchecked with the hint, pristine sends nothing", () => {
  const form = joinForm("face-package");
  form.control.setInfo(null);
  assert.equal(form.box.checked, false);
  assert.equal(form.hint.hidden, false);
  assert.equal(form.field(), null);
  form.choose("follow-settings");
  assert.equal(form.hint.hidden, true, "no hint without face-package");
});

test("#274 T6 §4.2c input table, and legacy callers keep today's body (F13)", () => {
  const body = (avatarExperiment, inputs) => app.buildMeetJoinFormData({ ...BASE_FORM, avatarExperiment, ...inputs });
  for (const selection of ["follow-settings", "", "hybrid-local-l0", "hybrid-local-frames"]) {
    for (const faceAudioPage of [true, false]) {
      for (const faceAudioOff of [true, false]) assert.equal(body(selection, { faceAudioPage, faceAudioOff }).has("faceAudio"), false, selection);
    }
  }
  assert.equal(body("face-package", { faceAudioPage: true, faceAudioOff: false }).get("faceAudio"), "page");
  assert.equal(body("face-package", { faceAudioPage: true, faceAudioOff: true }).get("faceAudio"), "page");
  assert.equal(body("face-package", { faceAudioPage: false, faceAudioOff: false }).has("faceAudio"), false);
  assert.equal(body("face-package", { faceAudioPage: false, faceAudioOff: true }).get("faceAudio"), "");
  assert.equal(body("face-package", { faceAudioPage: false, faceAudioOff: true }).toString().endsWith("&avatarExperiment=face-package&faceAudio="), true);
  assert.equal(body("face-package", { faceAudioPage: true }).get("faceAudio"), "page");
  assert.equal(body("face-package", {}).has("faceAudio"), false);
  assert.deepEqual(app.faceAudioJoinInputs({ selection: "face-package", pristine: true, checked: true }), { faceAudioPage: false, faceAudioOff: false });
  assert.deepEqual(app.faceAudioJoinInputs({ selection: "face-package", pristine: false, checked: true }), { faceAudioPage: true, faceAudioOff: false });
  assert.deepEqual(app.faceAudioJoinInputs({ selection: "face-package", pristine: false, checked: false }), { faceAudioPage: false, faceAudioOff: true });
});

test("#274 T6 the submit handler passes the helper's output, wired to the page elements and /info", () => {
  const source = read("public/app.js");
  const calls = source.match(/(?<!function )buildMeetJoinFormData\(\{[\s\S]*?\}\)/g);
  assert.equal(calls.length, 1, "one live call site");
  assert.match(calls[0], /avatarExperiment: avatarExperimentEl\.value,\s*\.\.\.faceAudioControl\.joinInputs\(\),\s*\}\)$/);
  assert.equal(calls[0].includes("faceAudioPage"), false, "the raw checkbox is never passed");
  assert.match(source, /const faceAudioControl = createFaceAudioControl\(\{\s*selectEl: avatarExperimentEl, optionEl: faceAudioOptionEl, boxEl: faceAudioPageEl, hintEl: faceAudioHintEl,\s*\}\);/);
  const loadInfo = source.match(/async function loadInfo\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(loadInfo, /fetch\("\/info"\)/);
  assert.match(loadInfo, /faceAudioControl\.setInfo\(res\.ok \? info : null\);/);
  assert.match(loadInfo, /catch \{[\s\S]*faceAudioControl\.setInfo\(null\);/);
  const settingsRead = source.match(/async function loadAvatarExperimentDefault\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.equal(settingsRead.includes("faceAudio"), false, "the page-audio default never comes from /api/settings");
  assert.match(source, /faceAudioHintEl\.textContent = "チェックを触らずに参加すると、サーバー側の既定値が使われます。";/);
});

// ---- T7 / T5 settings screen -----------------------------------------------------------------

function settingsSource() {
  return read("public/settings.js");
}

function pick(source, name) {
  return source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    }\\n`))[0];
}

function fakeField() {
  return { hidden: false, classList: { toggle(name, force) { if (name === "is-hidden") this.owner.hidden = Boolean(force); } } };
}

// Runs the real updateConditionalVisibility against a minimal DOM for the face-package area.
function visibility({ avatar, attendeeHostKind: hostKind }) {
  const { CLIENT_FIELD_SETS } = require("../public/settings.js");
  const { _test } = require("../src/settings/routes");
  const source = settingsSource();
  const manifest = _test.buildSettingsUiManifest().fields
    .filter((entry) => ["avatar_experiment", "emotion_judge", "face_audio_default"].includes(entry.id));
  const nodes = {};
  for (const id of ["avatar_experiment", "emotion_judge", "face_audio_default", "faceAudioCloudNote"]) {
    nodes[id] = fakeField();
    nodes[id].classList.owner = nodes[id];
  }
  const inputs = { avatar_experiment: { value: avatar, dataset: {} } };
  const context = {
    ...CLIENT_FIELD_SETS,
    BOOLEAN_FIELDS: new Set(), ARRAY_FIELDS: new Set(), NUMBER_FIELDS: new Set(),
    manifest,
    loadedValues: { avatar_experiment: avatar },
    envelope: hostKind === undefined ? {} : { attendeeHostKind: hostKind },
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
  vm.runInNewContext(`${pick(source, "controlFor")}${pick(source, "readControlValue")}${pick(source, "currentProvider")}${pick(source, "updateConditionalVisibility")}
    updateConditionalVisibility();`, context);
  return {
    field: !nodes.face_audio_default.hidden,
    note: !nodes.faceAudioCloudNote.hidden,
    emotion: !nodes.emotion_judge.hidden,
  };
}

test("#274 T7/T5 settings: the field shows only for face-package + self-hosted; the note shows on cloud", () => {
  assert.deepEqual(visibility({ avatar: "face-package", attendeeHostKind: "self-hosted" }), { field: true, note: false, emotion: true });
  assert.deepEqual(visibility({ avatar: "face-package", attendeeHostKind: "cloud" }), { field: false, note: true, emotion: true });
  assert.deepEqual(visibility({ avatar: "face-package", attendeeHostKind: undefined }), { field: false, note: true, emotion: true });
  for (const avatar of ["", "hybrid-local-l0", "hybrid-local-frames"]) {
    for (const hostKind of ["self-hosted", "cloud"]) {
      assert.deepEqual(visibility({ avatar, attendeeHostKind: hostKind }), { field: false, note: false, emotion: false }, `${avatar} ${hostKind}`);
    }
  }
});

test("#274 T7 settings: AVATAR_FIELDS, label, option labels, cloud note and guidance text", () => {
  const { CLIENT_FIELD_SETS, fieldContainerId } = require("../public/settings.js");
  assert.equal(CLIENT_FIELD_SETS.AVATAR_FIELDS.has("face_audio_default"), true);
  assert.equal(fieldContainerId({ id: "face_audio_default", ux: "detail" }), "avatarFields");
  const source = settingsSource();
  const labels = source.match(/const FACE_AUDIO_DEFAULT_OPTION_LABELS = \{[\s\S]*?\};/)[0];
  const context = { entry: { id: "face_audio_default" } };
  vm.runInNewContext(`${labels}${pick(source, "optionLabel")}
    result = [optionLabel(entry, "", ""), optionLabel(entry, "page", "page")];`, context);
  assert.deepEqual([...context.result], ["WebSocket（既定）", "フェイス画面から声を流す"]);
  assert.match(source, /face_audio_default: "声の出し方の既定（フェイス画面の音声）"/);
  assert.match(source, /const FACE_AUDIO_CLOUD_NOTE = "フェイス画面から声を流す設定は、セルフホストの Attendee で利用できます。";/);
  assert.match(pick(source, "renderFields"), /const faceAudioNote = notice\("warning", "フェイス画面の音声", FACE_AUDIO_CLOUD_NOTE\);\s*faceAudioNote\.id = "faceAudioCloudNote";\s*document\.getElementById\("avatarFields"\)\.append\(faceAudioNote\);/);
  const help = source.match(/\n      face_audio_default: "([^"]*8000[^"]*)",\n/)[1];
  assert.match(help, /8000 \/ 16000 \/ 24000 Hz/);
  assert.match(help, /tts_sample_rate/);
  assert.match(help, /WEBPAGE_STREAMER_AUDIO_SAMPLE_RATE/);
  assert.match(help, /Attendee サーバー側の設定/);
  assert.match(help, /meetmate からは変更も読み取りもできません/);
});

// ---- T8 docs ---------------------------------------------------------------------------------

test("#274 T8 docs: fixed 16 kHz reasons, Attendee-side guidance, precedence and the envelope member", () => {
  const contract = read("docs/settings-contract.md");
  const faces = read("docs/face-packages.md");
  for (const doc of [contract, faces]) {
    assert.match(doc, /fixed 16 kHz/);
    assert.match(doc, /Deepgram\/Soniox STT/);
    assert.match(doc, /Discord 48k→16k\s+decimation/);
    assert.match(doc, /wake calibration/);
    assert.match(doc, /8000, 16000\s+or 24000/);
    assert.match(doc, /WEBPAGE_STREAMER_AUDIO_SAMPLE_RATE/);
    assert.match(doc, /meetmate does not\s+change it and cannot read it/);
    assert.match(doc, /face_audio_default/);
  }
  assert.match(contract, /\| `face_audio_default` \| `avatar\.faceAudioDefault` \| `enum\(,page\)` \/ empty \| detail \| none \| next-join \| none \| default \|/);
  assert.match(contract, /type SettingsEnvelope = \{[\s\S]*?attendeeHostKind: "cloud" \| "self-hosted";[\s\S]*?\n\};/);
  assert.match(contract, /Only an\s+absent field consults this default/);
  assert.equal(faces.includes("there is no settings key"), false);
  const example = JSON.parse(read("config.json.example"));
  assert.equal(example.avatar.faceAudioDefault, "");
  assert.match(example._comments["avatar.faceAudioDefault"], /empty \(WebSocket, default\) or page/);
});

// ---- #260 PR B, T19 / T22 / T23: host kind rule 1 (a stored bot_host) over rule 2 (the URL rule) ----

test("#260 T19 rule 1: a stored bot_host decides on both snapshots whatever attendee_base_url is", (t) => {
  for (const [botHost, attendeeBaseUrl, expected] of [
    ["attendee-self-hosted", "app.attendee.dev", "self-hosted"],
    ["attendee-cloud", SELF_HOSTED_ATTENDEE, "cloud"],
    ["attendee-self-hosted", SELF_HOSTED_ATTENDEE, "self-hosted"],
    ["attendee-cloud", "app.attendee.dev", "cloud"],
  ]) {
    initRuntime(t, { botHost, attendeeBaseUrl });
    const label = `${botHost} ${attendeeBaseUrl}`;
    assert.equal(attendeeHostKind({ snapshot: "effective" }), expected, label);
    assert.equal(attendeeHostKind({ snapshot: "published" }), expected, label);
    assert.equal(resolver.buildEnvelope().attendeeHostKind, expected, `${label}: envelope`);
  }
  // Published follows a saved bot_host at once (next-join); unstored again -> the URL rule.
  initRuntime(t, { attendeeBaseUrl: SELF_HOSTED_ATTENDEE });
  assert.equal(attendeeHostKind({ snapshot: "published" }), "self-hosted");
  resolver.publishState({ exists: true, valid: true, parsed: settingsDocument({ attendeeBaseUrl: SELF_HOSTED_ATTENDEE, botHost: "attendee-cloud" }), revision: "e".repeat(64) });
  assert.equal(attendeeHostKind({ snapshot: "published" }), "cloud");
  assert.equal(attendeeHostKind({ snapshot: "effective" }), "cloud");
  // The value alone is not "stored": a default-sourced bot_host leaves rule 2 in charge.
  const value = t.mock.method(resolver, "getEffectiveValue", (id) => ({ bot_host: "attendee-cloud", attendee_base_url: SELF_HOSTED_ATTENDEE })[id]);
  const source = t.mock.method(resolver, "getEffectiveSource", () => "default");
  assert.equal(attendeeHostKind({ snapshot: "effective" }), "self-hosted");
  value.mock.restore();
  source.mock.restore();
});

test("#260 T19 { target }: the kind recorded at resolution; exactly one of snapshot / target", (t) => {
  const { resolveBotHostTarget } = require("../src/attendee-endpoint");
  initRuntime(t, { botHost: "attendee-self-hosted" });
  const target = resolveBotHostTarget({ snapshot: "effective" });
  resolver.publishState({ exists: true, valid: true, parsed: settingsDocument({ botHost: "attendee-cloud" }), revision: "e".repeat(64) });
  assert.equal(attendeeHostKind({ snapshot: "effective" }), "cloud");
  assert.equal(attendeeHostKind({ target }), "self-hosted", "the target keeps its join-time kind");
  for (const bad of [{ snapshot: "effective", target }, {}, { target: null }, { target: { hostKind: "other" } }, { target: "attendee-cloud" }]) {
    assert.throws(() => attendeeHostKind(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => attendeeHostKind(), TypeError);
});

async function settingsHandlerFor(t, directory, runtimeStartup) {
  const { createSettingsHandler } = require("../src/settings/routes");
  const { readConfigState } = require("../src/settings/store");
  t.after(() => {
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({ state: readConfigState(runtimeStartup.configPath), startup: runtimeStartup });
  return createSettingsHandler({ port: 5005, readinessController: HERMETIC_READINESS });
}

test("#260 T19 an unrelated save leaves bot_host unstored and the kind unchanged; a save naming cloud stores it (D1c)", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-bot-host-save-"));
  const runtimeStartup = startup(directory);
  fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify(settingsDocument({ attendeeBaseUrl: SELF_HOSTED_ATTENDEE }))}\n`, { mode: 0o600 });
  const handler = await settingsHandlerFor(t, directory, runtimeStartup);
  const get = settingsResponse();
  await handler(settingsRequest("GET", "/api/settings"), get);
  const envelope = JSON.parse(get.body);
  assert.equal(envelope.attendeeHostKind, "self-hosted");
  assert.equal(Object.hasOwn(envelope.fields, "bot_host"), false, "the page sees an unstored bot_host");
  assert.equal(envelope.sources.bot_host, "default");

  const unrelated = settingsResponse();
  await handler(settingsRequest("PUT", "/api/settings", { schemaVersion: 1, revision: envelope.revision, fields: { face_audio_default: "page", face_timeline_offset_ms: -200 } }), unrelated);
  assert.equal(unrelated.status, 200, unrelated.body);
  const saved = JSON.parse(unrelated.body);
  assert.equal(saved.attendeeHostKind, "self-hosted", "an unrelated save never flips the kind");
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(runtimeStartup.configPath, "utf8")).attendee, "host"), false);

  const cloud = settingsResponse();
  await handler(settingsRequest("PUT", "/api/settings", { schemaVersion: 1, revision: saved.revision, fields: { bot_host: "attendee-cloud" } }), cloud);
  assert.equal(cloud.status, 200, cloud.body);
  const explicit = JSON.parse(cloud.body);
  assert.equal(JSON.parse(fs.readFileSync(runtimeStartup.configPath, "utf8")).attendee.host, "attendee-cloud");
  assert.deepEqual([explicit.sources.bot_host, explicit.fields.bot_host, explicit.attendeeHostKind], ["config", "attendee-cloud", "cloud"]);
});

test("#260 T19 bootstrap (D1b): a bootstrap-revision save of another field does not seed bot_host; naming it stores it", async (t) => {
  for (const named of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-bot-host-bootstrap-"));
    const runtimeStartup = Object.freeze({ ...startup(directory), preDotenvEnv: Object.freeze({ ATTENDEE_API_BASE_URL: SELF_HOSTED_ATTENDEE }) });
    const handler = await settingsHandlerFor(t, directory, runtimeStartup);
    assert.equal(fs.existsSync(runtimeStartup.configPath), false);
    assert.equal(Object.hasOwn(resolver.getBootstrapSeedFields(), "bot_host"), false);
    assert.equal(resolver.buildEnvelope().attendeeHostKind, "self-hosted", "an env-only custom host is self-hosted today");
    const put = settingsResponse();
    const fields = { agent_display_name: "Caty", ...(named ? { bot_host: "attendee-cloud" } : {}) };
    await handler(settingsRequest("PUT", "/api/settings", { schemaVersion: 1, revision: "bootstrap", fields }), put);
    assert.equal(put.status, 200, put.body);
    const stored = JSON.parse(fs.readFileSync(runtimeStartup.configPath, "utf8"));
    assert.equal(stored.attendee?.host, named ? "attendee-cloud" : undefined, `named=${named}`);
    assert.equal(stored.avatar?.faceTimelineOffsetMsSelfHosted, 300, "every other default is still seeded");
    assert.equal(JSON.parse(put.body).attendeeHostKind, named ? "cloud" : "self-hosted", `named=${named}`);
  }
});

test("#260 T22/T23 settings visibility follows the envelope value under both rules", (t) => {
  for (const [options, expected] of [
    [{ botHost: "attendee-self-hosted", attendeeBaseUrl: "app.attendee.dev" }, { field: true, note: false, emotion: true }],
    [{ botHost: "attendee-cloud", attendeeBaseUrl: SELF_HOSTED_ATTENDEE }, { field: false, note: true, emotion: true }],
    // T23: a custom legacy hostname and no new setting -> exactly as on 4a2281b (self-hosted: field shown).
    [{ attendeeBaseUrl: SELF_HOSTED_ATTENDEE }, { field: true, note: false, emotion: true }],
  ]) {
    initRuntime(t, options);
    const hostKind = resolver.buildEnvelope().attendeeHostKind;
    assert.deepEqual(visibility({ avatar: "face-package", attendeeHostKind: hostKind }), expected, JSON.stringify(options));
  }
});

test("#260 T19 GET /info carries the stored bot_host's kind", async (t) => {
  for (const [options, expected] of [
    [{ botHost: "attendee-self-hosted", faceAudioDefault: "page" }, "self-hosted"],
    [{ botHost: "attendee-cloud", attendeeBaseUrl: SELF_HOSTED_ATTENDEE }, "cloud"],
  ]) {
    const info = await getInfo(t, options);
    assert.equal(info.attendeeHostKind, expected, JSON.stringify(options));
    assert.deepEqual(Object.keys(info), ["ttsProvider", "lang", "publicWsUrl", "ready", "fixedAgentId", "primaryAgent", "attendeeHostKind", "faceAudioDefault"]);
  }
});
