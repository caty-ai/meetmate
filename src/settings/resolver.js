"use strict";

const { getStartup } = require("./bootstrap");
const path = require("node:path");
const { MASK, ENV_DIAGNOSTICS, SETTINGS_REGISTRY, REGISTRY_BY_ID } = require("./registry");
const { scanLegacyClass2 } = require("./class2-migration");

const PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;
const SENTINELS = new Set([
  "your_gateway_token_here", "your_deepgram_key", "your_soniox_key", "your_attendee_key",
  "your_fish_audio_key", "your_voice_id", "your_slack_bot_token", "your-model-id",
  "your_openai_compatible_key", "your-agent-id", "YourAgent", "your-agent", "エージェント名",
]);
const NUMERIC_IDS = new Set([
  "llm_temperature", "llm_max_tokens", "llm_history_max_turns", "soniox_endpoint_sensitivity",
  "soniox_max_endpoint_delay_ms", "soniox_endpoint_latency_level", "listen_endpointing_ms",
  "listen_utterance_end_ms", "fish_audio_speed", "tts_sample_rate", "gateway_warmup_timeout_ms", "server_port",
]);
const BOOLEAN_IDS = new Set([
  "agent_emotion_tags", "openai_empty_response_retry", "openai_trusted_agent_tools", "tts_cache_enabled",
  "tts_cache_prewarm", "slack_notifications_enabled", "summary_enabled", "task_extraction_enabled",
  "streaming_equivalent_enabled",
]);
const ARRAY_IDS = new Set(["agent_wake_words", "agent_keyterms", "agent_stt_wake_variants", "agent_ack_variants", "agent_progress_pings"]);
const BASE10_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CACHE_INVALIDATORS = new Set();
let currentRuntime = null;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function readPath(value, dottedPath) {
  if (!dottedPath) return undefined;
  return dottedPath.split(".").reduce((current, key) => current && typeof current === "object" ? current[key] : undefined, value);
}

function writePath(value, dottedPath, next) {
  const parts = dottedPath.split(".");
  const leaf = parts.pop();
  let current = value;
  for (const part of parts) {
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  if (next === undefined) delete current[leaf];
  else current[leaf] = clone(next);
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : value;
}

function meaningful(value) {
  if (value === undefined || value === null) return false;
  const normalized = normalize(value);
  return normalized !== ""
    && !(typeof normalized === "string" && (PLACEHOLDER.test(normalized) || SENTINELS.has(normalized)));
}

function coerceAlias(entry, raw) {
  const normalized = normalize(raw);
  if (!meaningful(normalized)) return undefined;
  if (ARRAY_IDS.has(entry.id)) return String(normalized).split(",").map((part) => part.trim()).filter(Boolean);
  if (BOOLEAN_IDS.has(entry.id)) {
    if (normalized === true || normalized === false) return normalized;
    if (String(normalized).toLowerCase() === "true") return true;
    if (String(normalized).toLowerCase() === "false") return false;
    return undefined;
  }
  if (NUMERIC_IDS.has(entry.id)) {
    if (String(normalized).toLowerCase() === "null") return null;
    if (typeof normalized === "string" && !BASE10_NUMBER.test(normalized)) return undefined;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return normalized;
}

function validValue(entry, value, fromAlias = false) {
  const candidate = fromAlias ? coerceAlias(entry, value) : value;
  const parsed = entry.schema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function tierValue(entry, value, fromAlias = false) {
  const candidate = fromAlias ? coerceAlias(entry, value) : value;
  if (!meaningful(candidate)) return undefined;
  return validValue(entry, candidate);
}

function resolveEntry(entry, config, startup) {
  if (entry.id === "resolved_home") return { value: startup.resolvedHome, source: "runtime" };
  if (entry.envAlias) {
    const launch = tierValue(entry, startup.preDotenvEnv[entry.envAlias], true);
    if (launch !== undefined) return { value: launch, source: "os-env" };
  }
  const stored = tierValue(entry, readPath(config, entry.path));
  if (stored !== undefined) return { value: stored, source: "config" };
  if (entry.envAlias) {
    const seed = tierValue(entry, startup.dotenvSeeds[entry.envAlias], true);
    if (seed !== undefined) return { value: seed, source: ".env-seed" };
  }
  if (Object.prototype.hasOwnProperty.call(entry, "defaultValue")) {
    return { value: validValue(entry, clone(entry.defaultValue)), source: "default" };
  }
  return { value: undefined, source: "unset" };
}

function resolveAll(config, startup) {
  const values = {};
  const sources = {};
  for (const entry of SETTINGS_REGISTRY) {
    const resolved = resolveEntry(entry, config, startup);
    values[entry.id] = resolved.value;
    sources[entry.id] = resolved.source;
  }
  return { values: deepFreeze(values), sources: deepFreeze(sources) };
}

function typedEqual(left, right) {
  if (typeof left === "number" && typeof right === "number") return Number.isFinite(left) && left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function credentialView(entry, value, source) {
  const set = meaningful(value);
  return { state: source === "os-env" && set ? "overridden" : set ? "set" : "unset", value: set ? MASK : "" };
}

const EXACT_TRUE_DIAGNOSTICS = new Set(["echo_gate_closed_bypass", "meeting_context_injection_enabled"]);
const INTEGER_DIAGNOSTICS = new Set([
  "mcp_join_timeout_ms", "attendee_retry_attempts", "attendee_retry_base_ms", "attendee_timeout_ms",
  "barge_in_min_chars", "body_limit_bytes", "clause_pause_ms", "echo_loop_cooldown_ms",
  "first_chunk_min_chars", "first_token_delegate_ms", "fish_audio_retry_max", "llm_response_timeout_ms",
  "meeting_context_raw_chars", "meeting_context_raw_utterances", "min_clause_len", "min_clause_prefix",
  "pending_queue_max", "post_utterance_buffer_ms", "progress_ping_interval_ms", "progress_ping_max",
  "sentence_pause_ms", "session_grace_close_ms", "soniox_keepalive_interval_ms", "soniox_pending_max",
  "stt_accumulated_max_chars", "transcript_buffer_max", "tts_gap_ms", "tts_lead_ms", "handoff_cooldown_ms",
  "report_voice_gap_ms", "delegate_reply_fresh_ms", "parent_compact_delay_ms", "handoff_inflight_max",
  "parent_compact_max_lines", "short_utterance_skip_chars", "circuit_breaker_timeouts",
]);
const POSITIVE_DIAGNOSTICS = new Set([
  "pending_queue_max", "soniox_pending_max", "stt_accumulated_max_chars", "transcript_buffer_max", "handoff_inflight_max",
]);
const MILLISECOND_DIAGNOSTICS = new Set([
  "mcp_join_timeout_ms", "attendee_retry_base_ms", "attendee_timeout_ms", "clause_pause_ms",
  "echo_loop_cooldown_ms", "first_token_delegate_ms", "llm_response_timeout_ms", "post_utterance_buffer_ms",
  "progress_ping_interval_ms", "sentence_pause_ms", "session_grace_close_ms", "soniox_keepalive_interval_ms",
  "tts_gap_ms", "tts_lead_ms", "handoff_cooldown_ms", "report_voice_gap_ms", "delegate_reply_fresh_ms",
  "parent_compact_delay_ms",
]);
const MAX_BY_DIAGNOSTIC = Object.freeze({
  attendee_retry_attempts: 10,
  fish_audio_retry_max: 10,
  barge_in_confidence_min: 1,
  body_limit_bytes: 1_048_576,
});

function parseDiagnosticValue(diagnostic, raw, startup) {
  if (!meaningful(raw)) return undefined;
  if (diagnostic.type === "number") {
    const value = Number(normalize(raw));
    const minimum = diagnostic.id === "body_limit_bytes" ? 1024 : POSITIVE_DIAGNOSTICS.has(diagnostic.id) ? 1 : 0;
    const maximum = MAX_BY_DIAGNOSTIC[diagnostic.id]
      ?? (MILLISECOND_DIAGNOSTICS.has(diagnostic.id) ? 3_600_000 : Number.POSITIVE_INFINITY);
    if (!Number.isFinite(value) || value < minimum || value > maximum) return undefined;
    if (INTEGER_DIAGNOSTICS.has(diagnostic.id) && !Number.isInteger(value)) return undefined;
    return value;
  }
  if (diagnostic.type === "boolean") {
    const value = String(normalize(raw)).toLowerCase();
    if (diagnostic.id === "metrics_disabled") return ["1", "true", "yes"].includes(value);
    if (diagnostic.id === "wake_calibrate_enabled") return value === "1";
    if (EXACT_TRUE_DIAGNOSTICS.has(diagnostic.id)) return value === "true";
    return value !== "false";
  }
  if (["metrics-path", "tts-path", "home-path"].includes(diagnostic.type)) {
    const value = String(normalize(raw));
    return path.isAbsolute(value) ? path.normalize(value) : undefined;
  }
  const value = String(normalize(raw));
  if (diagnostic.type === "url" || diagnostic.id === "public_wss_url") {
    if (diagnostic.id === "public_wss_url" && value === "") return value;
    try {
      const parsed = new URL(value);
      const protocols = diagnostic.id === "public_wss_url" ? ["wss:"] : ["http:", "https:"];
      return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return value;
}

function diagnosticDefault(diagnostic, startup) {
  if (diagnostic.type === "metrics-path") return path.join(startup.resolvedHome, "logs");
  if (diagnostic.type === "tts-path") return path.join(startup.resolvedHome, "assets", "tts-cache");
  if (diagnostic.type === "home-path") return startup.resolvedHome;
  return clone(diagnostic.defaultValue);
}

function resolveDiagnostic(diagnostic, startup) {
  for (const [source, raw] of [
    ["os-env", startup.preDotenvEnv[diagnostic.envAlias]],
    [".env-seed", startup.dotenvSeeds[diagnostic.envAlias]],
  ]) {
    const value = parseDiagnosticValue(diagnostic, raw, startup);
    if (value !== undefined) return { value, source };
  }
  return { value: diagnosticDefault(diagnostic, startup), source: "default" };
}

function buildIssues(runtime) {
  const values = {};
  for (const entry of SETTINGS_REGISTRY) {
    values[entry.id] = entry.apply === "live"
      ? runtime.published.resolved.values[entry.id]
      : runtime.boot.values[entry.id];
  }
  const issues = [];
  const add = (fieldId, code) => {
    if (!issues.some((issue) => issue.fieldId === fieldId && issue.code === code)) issues.push({ fieldId, code });
  };
  if (runtime.documentExists && !runtime.documentValid) add("agent_id", "CONFIG_DOCUMENT_INVALID");
  for (const entry of SETTINGS_REGISTRY.filter((item) => item.writeSurface === "settings" || item.id === "server_port")) {
    const stored = readPath(runtime.published.raw, entry.path);
    if (meaningful(stored) && entry.schema.safeParse(stored).success === false) add(entry.id, "VALUE_INVALID");
  }
  for (const entry of SETTINGS_REGISTRY.filter((item) => item.requiredAtMeetingStart)) {
    if (entry.id === "soniox_api_key" && values.stt_provider !== "soniox") continue;
    if (entry.id === "deepgram_api_key" && values.stt_provider !== "deepgram") continue;
    if (!meaningful(values[entry.id]) || (Array.isArray(values[entry.id]) && values[entry.id].length === 0)) {
      add(entry.id, "VALUE_REQUIRED");
    }
  }
  const connectionReady = values.llm_provider === "openai-compatible"
    ? meaningful(runtime.startup.connection.openaiApiKey) && meaningful(values.openai_base_url) && meaningful(values.llm_model)
    : meaningful(runtime.startup.connection.openclawUrl) && meaningful(runtime.startup.connection.openclawToken);
  if (!connectionReady) add("llm_provider", "LLM_CONNECTION_ENV_REQUIRED");
  if (!connectionReady && runtime.legacyClass2.length > 0) add("llm_provider", "LEGACY_CONNECTION_CONFIG_PRESENT");
  const slackSource = runtime.boot.sources.slack_notifications_enabled;
  if (values.slack_notifications_enabled && !["default", "unset"].includes(slackSource)
      && !meaningful(resolveDynamicSlackToken(runtime))) add("slack_bot_token", "VALUE_REQUIRED");
  const launchAgentId = coerceAlias(REGISTRY_BY_ID.agent_id, runtime.startup.preDotenvEnv.AGENT_ID);
  const storedAgentId = tierValue(REGISTRY_BY_ID.agent_id, readPath(runtime.published.raw, "agent.id"));
  if (launchAgentId && storedAgentId && launchAgentId !== storedAgentId) add("agent_id", "AGENT_ID_RECONCILIATION_REQUIRED");
  return issues;
}

function createRuntime({ state, startup = getStartup(), serverPort = 5005, bootSnapshot = null }) {
  const raw = state?.parsed && typeof state.parsed === "object" && !Array.isArray(state.parsed) ? clone(state.parsed) : {};
  const resolved = resolveAll(raw, startup);
  const boot = bootSnapshot || deepFreeze({ values: clone(resolved.values), sources: clone(resolved.sources) });
  const runtime = {
    startup,
    revision: state?.revision || "bootstrap",
    documentExists: state?.exists === true,
    documentValid: state?.valid === true,
    serverPort,
    boot,
    published: deepFreeze({ raw, resolved }),
    legacyClass2: scanLegacyClass2(raw),
  };
  return runtime;
}

function initializeRuntime(options = {}) {
  currentRuntime = createRuntime(options);
  return currentRuntime;
}

function ensureRuntime() {
  if (currentRuntime) return currentRuntime;
  const startup = getStartup();
  const { readConfigState } = require("./store");
  return initializeRuntime({ state: readConfigState(startup.configPath), startup });
}

function publishState(state) {
  const previous = ensureRuntime();
  currentRuntime = createRuntime({ state, startup: previous.startup, serverPort: previous.serverPort, bootSnapshot: previous.boot });
  for (const invalidate of CACHE_INVALIDATORS) {
    try { invalidate(); } catch { /* cache invalidation is best effort */ }
  }
  return currentRuntime;
}

function publishCommittedState(configPath, state) {
  if (currentRuntime) {
    if (path.resolve(currentRuntime.startup.configPath) === path.resolve(configPath)) publishState(state);
    return;
  }
  const startup = getStartup();
  if (path.resolve(startup.configPath) === path.resolve(configPath)) initializeRuntime({ state, startup });
}

function registerCacheInvalidator(invalidate) {
  CACHE_INVALIDATORS.add(invalidate);
  return () => CACHE_INVALIDATORS.delete(invalidate);
}

function getEffectiveValue(id) {
  const runtime = ensureRuntime();
  const entry = REGISTRY_BY_ID[id];
  if (!entry) return undefined;
  if (entry.apply === "live") return runtime.published.resolved.values[id];
  return runtime.boot.values[id];
}

function getEffectiveSource(id) {
  const runtime = ensureRuntime();
  const entry = REGISTRY_BY_ID[id];
  if (!entry) return undefined;
  return entry.apply === "live" ? runtime.published.resolved.sources[id] : runtime.boot.sources[id];
}

function resolveDynamicSlackToken(runtime = ensureRuntime()) {
  const agentId = String(runtime.boot.values.agent_id || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(agentId)) return getEffectiveValue("slack_bot_token") || "";
  const name = `${agentId}_SLACK_BOT_TOKEN`;
  if (!/^[A-Z0-9_-]+_SLACK_BOT_TOKEN$/.test(name)) return getEffectiveValue("slack_bot_token") || "";
  const launch = normalize(runtime.startup.preDotenvEnv[name]);
  if (meaningful(launch)) return launch;
  const seed = normalize(runtime.startup.dotenvSeeds[name]);
  if (meaningful(seed)) return seed;
  return getEffectiveValue("slack_bot_token") || "";
}

function getRawConfig() {
  return clone(ensureRuntime().published.raw);
}

function getBootstrapSeedFields() {
  const runtime = ensureRuntime();
  const seedStartup = {
    ...runtime.startup,
    preDotenvEnv: Object.freeze({}),
  };
  const seeded = resolveAll({}, seedStartup).values;
  return Object.fromEntries(SETTINGS_REGISTRY
    .filter((entry) => entry.writeSurface === "settings" && seeded[entry.id] !== undefined)
    .map((entry) => [entry.id, clone(seeded[entry.id])]));
}

function getStatus() {
  const runtime = ensureRuntime();
  const issues = buildIssues(runtime);
  return { setupMode: issues.length > 0, meetingReady: issues.length === 0, issues: clone(issues) };
}

function buildEnvelope() {
  const runtime = ensureRuntime();
  const fields = {};
  const effective = {};
  const sources = {};
  const restartRequired = [];
  for (const entry of SETTINGS_REGISTRY) {
    if (entry.writeSurface === "none") continue;
    const stored = validValue(entry, readPath(runtime.published.raw, entry.path));
    if (stored !== undefined || entry.id === "audio_clips" || entry.credential === "class-1") {
      fields[entry.id] = entry.credential === "class-1"
        ? credentialView(entry, stored, runtime.published.resolved.sources[entry.id])
        : clone(stored !== undefined ? stored : entry.defaultValue);
    }
    if (entry.writeSurface !== "settings") continue;
    const runningValue = entry.apply === "live" ? runtime.published.resolved.values[entry.id] : runtime.boot.values[entry.id];
    const runningSource = entry.apply === "live" ? runtime.published.resolved.sources[entry.id] : runtime.boot.sources[entry.id];
    if (runningValue === undefined && entry.credential !== "class-1") continue;
    effective[entry.id] = entry.credential === "class-1"
      ? credentialView(entry, runningValue, runningSource)
      : clone(runningValue);
    sources[entry.id] = runningSource;
    if (entry.apply === "restart-required" && !typedEqual(runtime.published.resolved.values[entry.id], runningValue)) {
      restartRequired.push(entry.id);
    }
  }
  const issues = buildIssues(runtime);
  const diagnostics = {
    server_port: { value: runtime.serverPort, source: "runtime" },
    resolved_home: { value: runtime.startup.resolvedHome, source: "runtime" },
  };
  for (const diagnostic of ENV_DIAGNOSTICS) {
    diagnostics[diagnostic.id] = resolveDiagnostic(diagnostic, runtime.startup);
  }
  return {
    schemaVersion: 1,
    revision: runtime.revision,
    setupMode: issues.length > 0,
    fields,
    effective,
    sources,
    restartRequired: restartRequired.sort(),
    issues,
    diagnostics,
  };
}

function setServerPort(port) {
  ensureRuntime().serverPort = port;
}

function resetRuntimeForTest() {
  currentRuntime = null;
  CACHE_INVALIDATORS.clear();
}

module.exports = {
  buildEnvelope,
  getBootstrapSeedFields,
  getEffectiveValue,
  getEffectiveSource,
  getRawConfig,
  getRuntime: ensureRuntime,
  getStatus,
  initializeRuntime,
  meaningful,
  normalize,
  publishState,
  publishCommittedState,
  readPath,
  resolveDiagnostic,
  resolveDynamicSlackToken,
  registerCacheInvalidator,
  resetRuntimeForTest,
  setServerPort,
  writePath,
};
