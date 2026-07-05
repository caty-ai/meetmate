const fs = require("fs");
const path = require("path");
const { buildVoiceAddendum } = require("./llm");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const SAMPLE_RATE = 16_000;
// TTS output rate. The code default is the single source of truth; env is kept
// as an escape hatch only. Invalid env values (NaN/zero/negative) fall back to
// the default so a typo can't propagate NaN into Fish Audio / silence buffers.
const _ttsRateEnv = Number(process.env.TTS_SAMPLE_RATE);
const TTS_SAMPLE_RATE = Number.isInteger(_ttsRateEnv) && _ttsRateEnv > 0 ? _ttsRateEnv : 24_000;
if (process.env.TTS_SAMPLE_RATE && TTS_SAMPLE_RATE !== _ttsRateEnv) {
  console.warn(`⚠️  Invalid TTS_SAMPLE_RATE "${process.env.TTS_SAMPLE_RATE}" — using default 24000`);
}
const TTS_PROVIDER = process.env.TTS_PROVIDER || "fish-audio";
const LANG = process.env.AGENT_LANG || "ja";

const LISTEN_ENDPOINTING_MS = Number(process.env.LISTEN_ENDPOINTING_MS || 400);
const LISTEN_UTTERANCE_END_MS = Number(process.env.LISTEN_UTTERANCE_END_MS || 1200);

// STT provider + Soniox settings. Soniox adopted as default 2026-06-23 (#52)
// after live A/B: dramatically better JA accuracy + latency than Deepgram.
// Instant revert: set STT_PROVIDER=deepgram and restart.
const STT_PROVIDER = String(process.env.STT_PROVIDER || "soniox").toLowerCase();
const SONIOX_MODEL = process.env.SONIOX_MODEL || "stt-rt-v5";
const SONIOX_WS_URL = process.env.SONIOX_WS_URL || "wss://stt-rt.soniox.com/transcribe-websocket";
const numOrNull = (v) => (v !== undefined && v !== "" ? Number(v) : null);
const SONIOX_ENDPOINT_SENSITIVITY = numOrNull(process.env.SONIOX_ENDPOINT_SENSITIVITY);
const SONIOX_MAX_ENDPOINT_DELAY_MS = numOrNull(process.env.SONIOX_MAX_ENDPOINT_DELAY_MS);
const SONIOX_ENDPOINT_LATENCY_LEVEL = numOrNull(process.env.SONIOX_ENDPOINT_LATENCY_LEVEL);
const SONIOX_CONTEXT_TERMS = (process.env.SONIOX_CONTEXT_TERMS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AGENT_TEMPERATURE = Number(process.env.AGENT_TEMPERATURE || 0.5);
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 300);
// First-audio timeout: aborts the LLM turn if no chunk arrives in this window.
// Pipeline clears the timer on the first streamed chunk (firstChunkSeen),
// so this is effectively a "first audible chunk" deadline. The budget covers
// the always-ack + up to 3 progress pings (~30s) plus buffer, so timeout
// fires only on genuine Gateway/tool hangs rather than legitimately slow
// turns. Set to 0 to disable.
const LLM_RESPONSE_TIMEOUT_MS = Number(process.env.LLM_RESPONSE_TIMEOUT_MS || 35_000);
// First-token forced delegation: if no LLM chunk arrives before this threshold,
// abort the turn and hand it off instead of leaving the user waiting.
// Set to 0 to disable; invalid values fall back to the production default.
const _firstTokenDelegateEnv = process.env.FIRST_TOKEN_DELEGATE_MS;
const _firstTokenDelegateParsed = _firstTokenDelegateEnv === undefined || String(_firstTokenDelegateEnv).trim() === ""
  ? 15_000
  : Number(_firstTokenDelegateEnv);
const FIRST_TOKEN_DELEGATE_MS = !Number.isFinite(_firstTokenDelegateParsed)
  ? 15_000
  : (_firstTokenDelegateParsed > 0 ? _firstTokenDelegateParsed : 0);
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  return String(raw).toLowerCase() !== "false";
}

function nonNegativeMsEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed > 0 ? parsed : 0;
}

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed >= 1 ? Math.floor(parsed) : fallback;
}

const GATEWAY_EVENTS_ENABLED = boolEnv("GATEWAY_EVENTS_ENABLED", false);
const FORCED_DELEGATION_ABORT = boolEnv("FORCED_DELEGATION_ABORT", true);
const HANDOFF_DELEGATE_SESSION = boolEnv("HANDOFF_DELEGATE_SESSION", true);
// Handoff concurrency is intentionally finite; 0 is invalid, not "unlimited".
const HANDOFF_INFLIGHT_MAX = positiveIntEnv("HANDOFF_INFLIGHT_MAX", 2);
const HANDOFF_COOLDOWN_MS = nonNegativeMsEnv("HANDOFF_COOLDOWN_MS", 20_000);
const REPORT_VOICE_GAP_MS = nonNegativeMsEnv("REPORT_VOICE_GAP_MS", 4_000);
const REPORT_CHAT_ENABLED = boolEnv("REPORT_CHAT_ENABLED", true);
const REPORT_VOICE_ENABLED = boolEnv("REPORT_VOICE_ENABLED", true);
const GATEWAY_EVENTS_AGENT_ID = process.env.GATEWAY_EVENTS_AGENT_ID || "main";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_NOTIFY_CHANNEL = process.env.SLACK_NOTIFY_CHANNEL || "";
const SLACK_SUMMARY_CHANNEL = process.env.SLACK_SUMMARY_CHANNEL || "";
const SLACK_STATUS_CHANNEL = process.env.SLACK_STATUS_CHANNEL || "";
const SLACK_NOTIFY_ENABLED = String(process.env.SLACK_NOTIFY_ENABLED || "true").toLowerCase() !== "false";
const SUMMARY_ENABLED = String(process.env.SUMMARY_ENABLED || "true").toLowerCase() !== "false";

/**
 * Load config.json (single-agent format).
 * Resolves ${ENV_VAR} placeholders in string values.
 * Returns parsed config or null if config.json not found.
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    console.error(`❌  Failed to parse config.json: ${err.message}`);
    process.exit(1);
  }

  // Deep-resolve ${ENV_VAR} tokens in all string values
  const unresolved = [];
  function resolveDeep(obj, keyPath = "") {
    if (typeof obj === "string") {
      const match = obj.match(/^\$\{(.+)\}$/);
      if (match) {
        const val = process.env[match[1]];
        if (val === undefined || val === "") {
          unresolved.push({ path: keyPath, envVar: match[1] });
        }
        return val || "";
      }
      return obj;
    }
    if (Array.isArray(obj)) return obj.map((v, i) => resolveDeep(v, `${keyPath}[${i}]`));
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = resolveDeep(v, keyPath ? `${keyPath}.${k}` : k);
      return out;
    }
    return obj;
  }

  const resolved = resolveDeep(raw);

  if (unresolved.length > 0) {
    console.error(`❌  config.json has unresolved environment variables:`);
    for (const { path: p, envVar } of unresolved) {
      console.error(`   ${p}: \${${envVar}} is not set`);
    }
    process.exit(1);
  }

  return resolved;
}

/**
 * Build pipeline config.
 * Accepts either an agentProfile (from resolveAgentProfile) or a raw agent object
 * for backward compatibility. agentProfile takes precedence for systemPrompt/greeting.
 *
 * @param {object} overrides - Per-session overrides
 * @param {object|null} agent - Raw agent object (backward compat)
 * @param {object|null} agentProfile - AgentProfile from resolveAgentProfile()
 */
function getPipelineConfig(overrides = {}, agent = null, agentProfile = null, configJson = null) {
  const isJapanese = LANG === "ja";
  const envVoiceId = process.env.FISH_AUDIO_VOICE_ID || null;
  // Build voice addendum: use per-agent emotionTags flag
  const agentEmotionTags = agent?.emotionTags !== false; // default true
  const defaultVoiceAddendum = buildVoiceAddendum({ emotionTags: agentEmotionTags });
  const llmAddendum = Object.prototype.hasOwnProperty.call(overrides, "openclawSystemAddendum")
    ? overrides.openclawSystemAddendum
    : (agent?.openclawSystemAddendum ?? defaultVoiceAddendum);
  const ttsReferenceId = agent && Object.prototype.hasOwnProperty.call(agent, "voiceId")
    ? (agent.voiceId || envVoiceId)
    : envVoiceId;

  // Resolve system prompt: agentProfile > overrides > empty (Gateway manages system prompts)
  const systemPrompt = agentProfile?.systemPrompt || overrides.prompt || "";

  // Validate Gateway config
  const resolvedOpenclawUrl = agent?.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || null;
  const resolvedOpenclawToken = agent?.gatewayToken || process.env.OPENCLAW_GATEWAY_TOKEN || null;
  if (!resolvedOpenclawUrl || !resolvedOpenclawToken) {
    console.error("❌  OpenClaw Gateway is required. Set OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN in config.json or .env.");
  }

  // Resolve greeting: agentProfile > overrides > agent > empty (skip if unconfigured)
  const greeting =
    overrides.greeting ||
    agentProfile?.greeting ||
    agent?.greeting ||
    "";

  return {
    dgKey: process.env.DEEPGRAM_API_KEY,
    sonioxKey: process.env.SONIOX_API_KEY,
    fishKey: process.env.FISH_AUDIO_API_KEY,
    openclawUrl: agent?.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || null,
    openclawToken: agent?.gatewayToken || process.env.OPENCLAW_GATEWAY_TOKEN || null,
    warmupTimeoutMs: configJson?.gateway?.warmupTimeoutMs || null,
    systemPrompt,
    exitDetection: overrides.exitDetection,
    echoCooldownMs: ECHO_LOOP_COOLDOWN_MS,
    stt: {
      provider: STT_PROVIDER,
      model: "nova-3", // Deepgram model
      language: LANG,
      sampleRate: SAMPLE_RATE,
      endpointingMs: LISTEN_ENDPOINTING_MS,
      utteranceEndMs: LISTEN_UTTERANCE_END_MS,
      soniox: {
        model: SONIOX_MODEL,
        wsUrl: SONIOX_WS_URL,
        endpointSensitivity: SONIOX_ENDPOINT_SENSITIVITY,
        maxEndpointDelayMs: SONIOX_MAX_ENDPOINT_DELAY_MS,
        endpointLatencyLevel: SONIOX_ENDPOINT_LATENCY_LEVEL,
        contextTerms: SONIOX_CONTEXT_TERMS,
      },
    },
    llm: {
      // Do not default to a foundation model here; let Gateway choose.
      // (If a foundation model is required, set it explicitly via overrides/agent config.)
      model: overrides.model || agent?.model || "openclaw",
      temperature: overrides.temperature ?? AGENT_TEMPERATURE,
      maxTokens: overrides.maxTokens ?? AGENT_MAX_TOKENS,
      responseTimeoutMs: overrides.responseTimeoutMs ?? LLM_RESPONSE_TIMEOUT_MS,
      firstTokenDelegateMs: overrides.firstTokenDelegateMs ?? FIRST_TOKEN_DELEGATE_MS,
      openclawSystemAddendum: llmAddendum,
    },
    tts: {
      provider: "fish-audio",
      referenceId: ttsReferenceId,
      sampleRate: TTS_SAMPLE_RATE,
      latency: process.env.FISH_AUDIO_LATENCY || "balanced",
      // Speech rate, 0.5-2.0 (1.0 = native speed). Default 1.0, chosen
      // 2026-05-04 after switching the default model to s2-pro: 0.9 felt
      // unnaturally slow on s2-pro's already-calmer delivery. env is kept
      // as an escape hatch only — change the default here for permanent
      // moves so there is one source of truth.
      speed: process.env.FISH_AUDIO_SPEED !== undefined
        ? Number(process.env.FISH_AUDIO_SPEED)
        : 1.0,
    },
    briefing: overrides.briefing || null,
    purposeStatement: overrides.purposeStatement || null,
    greeting,
    slack: {
      botToken: configJson?.slack?.botToken || SLACK_BOT_TOKEN,
      channelId: configJson?.slack?.notifyChannel || SLACK_NOTIFY_CHANNEL,
      statusChannelId:
        configJson?.slack?.statusChannel || SLACK_STATUS_CHANNEL || SLACK_SUMMARY_CHANNEL || SLACK_NOTIFY_CHANNEL,
      summaryChannelId: configJson?.slack?.summaryChannel || SLACK_SUMMARY_CHANNEL || SLACK_NOTIFY_CHANNEL,
      enabled: SLACK_NOTIFY_ENABLED,
    },
    summary: {
      enabled: SUMMARY_ENABLED,
    },
    gatewayEvents: {
      enabled: GATEWAY_EVENTS_ENABLED,
      forcedDelegationAbort: FORCED_DELEGATION_ABORT,
      handoffDelegateSession: HANDOFF_DELEGATE_SESSION,
      handoffInflightMax: HANDOFF_INFLIGHT_MAX,
      handoffCooldownMs: HANDOFF_COOLDOWN_MS,
      reportVoiceGapMs: REPORT_VOICE_GAP_MS,
      reportChatEnabled: REPORT_CHAT_ENABLED,
      reportVoiceEnabled: REPORT_VOICE_ENABLED,
      agentId: GATEWAY_EVENTS_AGENT_ID,
    },
    // Per-agent voice extensions
    emotionTags: agentEmotionTags,
    ackVariants: overrides.ackVariants || agentProfile?.ackVariants || agent?.ackVariants || null,
    progressPings: agentProfile?.progressPings || agent?.progressPings || null,
    timeoutFallback: agentProfile?.timeoutFallback || agent?.timeoutFallback || null,
    exitFarewell: agentProfile?.exitFarewell || agent?.exitFarewell || null,
    cancelAck: agentProfile?.cancelAck || agent?.cancelAck || null,
  };
}

module.exports = {
  getPipelineConfig,
  SAMPLE_RATE,
  TTS_SAMPLE_RATE,
  TTS_PROVIDER,
  SLACK_BOT_TOKEN,
  SLACK_NOTIFY_CHANNEL,
  SLACK_NOTIFY_ENABLED,
  SLACK_SUMMARY_CHANNEL,
  SLACK_STATUS_CHANNEL,
  SUMMARY_ENABLED,
  GATEWAY_EVENTS_ENABLED,
  FORCED_DELEGATION_ABORT,
  HANDOFF_DELEGATE_SESSION,
  HANDOFF_INFLIGHT_MAX,
  HANDOFF_COOLDOWN_MS,
  REPORT_VOICE_GAP_MS,
  REPORT_CHAT_ENABLED,
  REPORT_VOICE_ENABLED,
  GATEWAY_EVENTS_AGENT_ID,
  loadConfig,
};
