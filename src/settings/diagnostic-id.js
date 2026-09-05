"use strict";

const AREA_BY_SYSTEM = Object.freeze({
  soniox: "STT", deepgram: "STT",
  "fish-audio": "TTS", elevenlabs: "TTS", "openai-compatible": "TTS",
  llm: "LLM", attendee: "ATT", tunnel: "TUN", discord: "DSC", slack: "SLK", settings: "MMT",
});
const CAUSE_BY_CODE = Object.freeze({
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
const STATIC_CODES = Object.freeze([
  "VALUE_REQUIRED", "VALUE_INVALID", "PROVIDER_DEPENDENCY_REQUIRED",
  "LLM_CONNECTION_ENV_REQUIRED", "AGENT_ID_RECONCILIATION_REQUIRED",
  "LEGACY_CONNECTION_CONFIG_PRESENT", "CONFIG_DOCUMENT_INVALID",
]);

function areaFor(system, code) {
  return Object.hasOwn(AREA_BY_SYSTEM, system)
    ? AREA_BY_SYSTEM[system]
    : (STATIC_CODES.includes(code) ? "SET" : "MMT");
}

function diagnosticIdFor(system, code) {
  if (!code || code === "CONNECTED") return null;
  const cause = Object.hasOwn(CAUSE_BY_CODE, code) ? CAUSE_BY_CODE[code] : CAUSE_BY_CODE.PROVIDER_ERROR;
  return `MM-${areaFor(system, code)}-${cause}`;
}

module.exports = { AREA_BY_SYSTEM, CAUSE_BY_CODE, STATIC_CODES, diagnosticIdFor, areaFor };
