"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { collectLegacyMultiAgentKeys, warnLegacyMultiAgentKeys } = require("../src/agent-profile");
const { readConfigState } = require("../src/settings/store");
const resolver = require("../src/settings/resolver");
const readiness = require("../src/settings/readiness");

test("legacy keys produce one warning containing key names and the singular id, never values", () => {
  const apiKey = "old-" + "secret";
  const parsed = {
    agents: [{ openaiCompatible: { apiKey } }],
    agent: { id: "caty", messages: { groupGreetingTemplate: "private greeting" } },
  };
  const before = structuredClone(parsed);
  const lines = [];
  warnLegacyMultiAgentKeys(parsed, { warn: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agents, agent\.messages\.groupGreetingTemplate/);
  assert.match(lines[0], /one agent: "caty"/);
  assert.equal(lines[0].includes(apiKey), false);
  assert.equal(lines[0].includes("private greeting"), false);
  assert.deepEqual(parsed, before);
});

test("no legacy keys produce no warning", () => {
  const lines = [];
  const logger = { warn: (line) => lines.push(line) };
  warnLegacyMultiAgentKeys({}, logger);
  warnLegacyMultiAgentKeys({ agent: { id: "caty", messages: {} } }, logger);
  warnLegacyMultiAgentKeys(Object.create({ agents: [] }), logger);
  assert.deepEqual(lines, []);
});

test("null and non-object input are ignored without throwing", () => {
  const lines = [];
  for (const parsed of [null, "str", undefined, 1, false]) {
    assert.doesNotThrow(() => warnLegacyMultiAgentKeys(parsed, { warn: (line) => lines.push(line) }));
  }
  assert.deepEqual(lines, []);
});

test("presence detection does not read legacy values or stringify a non-string agent id", () => {
  const parsed = {
    get agents() { throw new Error("legacy value must not be read"); },
    agent: {
      id: { toString() { throw new Error("id must not be stringified"); } },
      messages: {
        get groupGreetingTemplate() { throw new Error("legacy value must not be read"); },
      },
    },
  };
  const lines = [];
  assert.doesNotThrow(() => warnLegacyMultiAgentKeys(parsed, { warn: (line) => lines.push(line) }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /one agent: "unset"/);
  assert.match(lines[0], /agents, agent\.messages\.groupGreetingTemplate/);
});

test("boot loader preserves legacy config bytes and leaves readiness and settings non-blocking", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-legacy-agent-keys-"));
  t.after(() => {
    readiness.reset();
    resolver.resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "config.json");
  const parsed = {
    agent: { id: "caty", displayName: "Caty", name: "Caty", wakeWords: ["ケイティ"] },
    llm: { provider: "openclaw", model: "main" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-key" },
    tts: { provider: "fish-audio", apiKey: "fish-key", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-key", baseUrl: "app.attendee.dev" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
    agents: [{ openaiCompatible: { apiKey: "old-" + "secret" }, gatewayToken: "old-" + "token" }],
  };
  const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
  fs.writeFileSync(configPath, bytes);
  // Same read-only startup path as server.js and the settings preservation tests.
  const initialSettingsState = readConfigState(configPath);
  assert.equal(initialSettingsState.valid, true);
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: initialSettingsState,
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: directory,
      configPath,
      connection: Object.freeze({
        openclawUrl: "https://gateway.example",
        openclawToken: "gateway-token",
        openaiApiKey: "openai-key",
      }),
    }),
  });
  const beforeStatus = resolver.getStatus();
  const lines = [];
  warnLegacyMultiAgentKeys(initialSettingsState.parsed, { warn: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.deepEqual(fs.readFileSync(configPath), bytes);
  assert.deepEqual(initialSettingsState.parsed, parsed);
  assert.deepEqual(resolver.getStatus(), beforeStatus);
  assert.deepEqual(resolver.getStatus().issues, []);
  assert.equal(resolver.getStatus().meetingReady, true);
  assert.deepEqual(readiness.createReadinessController().getReadiness().blockers, []);
});

test("legacy key collection uses own presence checks and never reads legacy values", () => {
  const both = ["agents", "agent.messages.groupGreetingTemplate"];
  assert.deepEqual(collectLegacyMultiAgentKeys({ agents: [], agent: { messages: { groupGreetingTemplate: "" } } }), both);
  for (const parsed of [null, undefined, 1, false, "str", {}, { agent: { messages: {} } }]) {
    assert.deepEqual(collectLegacyMultiAgentKeys(parsed), []);
  }
  const inherited = Object.create({ agents: [] });
  inherited.agent = { messages: Object.create({ groupGreetingTemplate: "" }) };
  assert.deepEqual(collectLegacyMultiAgentKeys(inherited), []);
  assert.deepEqual(collectLegacyMultiAgentKeys({ agents: null }), ["agents"]);
  assert.deepEqual(collectLegacyMultiAgentKeys({ agent: { messages: { groupGreetingTemplate: null } } }), [both[1]]);
  assert.deepEqual(collectLegacyMultiAgentKeys({
    get agents() { throw new Error("must not read legacy value"); },
    agent: { messages: {
      get groupGreetingTemplate() { throw new Error("must not read legacy value"); },
    } },
  }), both);
});
