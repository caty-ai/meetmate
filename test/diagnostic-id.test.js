"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AREA_BY_SYSTEM, CAUSE_BY_CODE, areaFor, diagnosticIdFor } = require("../src/settings/diagnostic-id");

test("#197 diagnosticIdFor covers every system × code without cause collisions", () => {
  const codesById = new Map();
  assert.equal(new Set(Object.values(CAUSE_BY_CODE)).size, Object.keys(CAUSE_BY_CODE).length);
  for (const [system, area] of Object.entries(AREA_BY_SYSTEM)) {
    for (const [code, cause] of Object.entries(CAUSE_BY_CODE)) {
      const id = diagnosticIdFor(system, code);
      assert.match(id, /^MM-[A-Z]{3}-\d{3}$/);
      assert.equal(id, `MM-${area}-${cause}`);
      // Provider aliases in one AREA intentionally share an ID for the same cause.
      if (codesById.has(id)) assert.equal(codesById.get(id), code);
      codesById.set(id, code);
    }
  }
});

test("#197 normal and missing codes have no diagnostic ID", () => {
  for (const system of [...Object.keys(AREA_BY_SYSTEM), undefined]) {
    for (const code of ["CONNECTED", "", undefined, null, false]) assert.equal(diagnosticIdFor(system, code), null);
  }
});

test("#197 unknown inputs use static or general fallbacks and ignore inherited properties", () => {
  for (const system of [...Object.keys(AREA_BY_SYSTEM), "unknown", "toString", undefined]) {
    assert.equal(diagnosticIdFor(system, "WHATEVER"), `MM-${areaFor(system, "WHATEVER")}-209`);
    assert.equal(diagnosticIdFor(system, "constructor"), `MM-${areaFor(system, "constructor")}-209`);
  }
  assert.equal(diagnosticIdFor("unknown", "VALUE_REQUIRED"), "MM-SET-002");
  assert.equal(diagnosticIdFor(undefined, "CONFIG_DOCUMENT_INVALID"), "MM-SET-008");
  assert.equal(diagnosticIdFor("unknown", "AUTH_FAILED"), "MM-MMT-100");
  assert.equal(diagnosticIdFor("soniox", "VALUE_REQUIRED"), "MM-STT-002");
});

test("#197 diagnostic tables are frozen append-only snapshots", () => {
assert.deepEqual(AREA_BY_SYSTEM, {
  soniox: "STT", deepgram: "STT",
  "fish-audio": "TTS", elevenlabs: "TTS", "openai-compatible": "TTS",
  llm: "LLM", attendee: "ATT", tunnel: "TUN", discord: "DSC", slack: "SLK", settings: "MMT",
});
assert.deepEqual(CAUSE_BY_CODE, {
  NOT_CONFIGURED: "001", VALUE_REQUIRED: "002", VALUE_INVALID: "003",
  PROVIDER_DEPENDENCY_REQUIRED: "004", LLM_CONNECTION_ENV_REQUIRED: "005",
  AGENT_ID_RECONCILIATION_REQUIRED: "006", LEGACY_CONNECTION_CONFIG_PRESENT: "007",
  CONFIG_DOCUMENT_INVALID: "008",
  AUTH_FAILED: "100", PAYMENT_REQUIRED: "101", RATE_LIMITED: "102", NOT_ENABLED: "103",
  ALLOWLIST_MISMATCH: "104",
  UNREACHABLE: "200", TIMEOUT: "201", MISMATCH: "202", PROVIDER_ERROR: "209",
  RESTART_REQUIRED: "300", PENDING: "301",
  gateway_no_response: "510", agent_no_output: "511", stream_no_content: "512",
});
  assert.equal(Object.isFrozen(AREA_BY_SYSTEM), true);
  assert.equal(Object.isFrozen(CAUSE_BY_CODE), true);
});

test("#197 diagnostic module has no environment reads", () => {
  const source = require("node:fs").readFileSync(require.resolve("../src/settings/diagnostic-id"), "utf8");
  assert.equal(source.includes("process.env"), false);
});
