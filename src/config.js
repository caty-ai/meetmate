/*
 * Settings-boundary contract: docs/settings-contract.md.
 * Keep persistence, precedence, credential classes, allowlists, and migrations aligned with that contract.
 */

const { buildVoiceAddendum } = require("./llm");
const { buildGatewayBriefingSystem, buildVoiceAddendumFromMessages, resolveMessages } = require("./messages");
const { getStartup } = require("./settings/bootstrap");
const { getEffectiveValue, getRawConfig } = require("./settings/resolver");
const { stripLegacyClass2 } = require("./settings/class2-migration");

const SAMPLE_RATE = 16_000;
// TTS output rate. The code default is the single source of truth; env is kept
// as an escape hatch only. Invalid env values (NaN/zero/negative) fall back to
// the default so a typo can't propagate NaN into Fish Audio / silence buffers.
const TTS_SAMPLE_RATE = getEffectiveValue("tts_sample_rate");
const TTS_PROVIDER = getEffectiveValue("tts_provider");
const LANG = getEffectiveValue("agent_language");

const LISTEN_ENDPOINTING_MS = getEffectiveValue("listen_endpointing_ms");
const LISTEN_UTTERANCE_END_MS = getEffectiveValue("listen_utterance_end_ms");

// STT provider + Soniox settings. Soniox adopted as default 2026-06-23 (#52)
// after live A/B: dramatically better JA accuracy + latency than Deepgram.
// Instant revert: set STT_PROVIDER=deepgram and restart.
const STT_PROVIDER = getEffectiveValue("stt_provider");
const SONIOX_MODEL = getEffectiveValue("soniox_model");
const SONIOX_WS_URL = getEffectiveValue("soniox_ws_url");
const SONIOX_ENDPOINT_SENSITIVITY = getEffectiveValue("soniox_endpoint_sensitivity");
const SONIOX_MAX_ENDPOINT_DELAY_MS = getEffectiveValue("soniox_max_endpoint_delay_ms");
const SONIOX_ENDPOINT_LATENCY_LEVEL = getEffectiveValue("soniox_endpoint_latency_level");
const SONIOX_CONTEXT_TERMS = getEffectiveValue("agent_keyterms") || [];
const AGENT_TEMPERATURE = getEffectiveValue("llm_temperature");
const AGENT_MAX_TOKENS = getEffectiveValue("llm_max_tokens");
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

function nonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed > 0 ? Math.floor(parsed) : 0;
}

function boolOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return value.toLowerCase() !== "false";
  return Boolean(value);
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
const DELEGATE_REPLY_FRESH_MS = nonNegativeMsEnv("DELEGATE_REPLY_FRESH_MS", 90_000);
const PARENT_COMPACT_DELAY_MS = nonNegativeMsEnv("PARENT_COMPACT_DELAY_MS", 5_000);
// 0 = omit maxLines so the gateway runs real LLM compaction (issue #98: the
// line-trim path can never shrink a 1-line giant announce; transcripts are
// 3-15 lines so maxLines=40 always returned compacted:false). >0 keeps the
// legacy line-trim behaviour.
const PARENT_COMPACT_MAX_LINES = nonNegativeIntEnv("PARENT_COMPACT_MAX_LINES", 0);
const SHORT_UTTERANCE_SKIP_CHARS = nonNegativeIntEnv("SHORT_UTTERANCE_SKIP_CHARS", 24);
const CIRCUIT_BREAKER_TIMEOUTS = nonNegativeIntEnv("CIRCUIT_BREAKER_TIMEOUTS", 2);

const SLACK_BOT_TOKEN = getEffectiveValue("slack_bot_token") || "";
const SLACK_NOTIFY_CHANNEL = getEffectiveValue("slack_notify_channel") || "";
const SLACK_SUMMARY_CHANNEL = getEffectiveValue("slack_summary_channel") || "";
const SLACK_STATUS_CHANNEL = getEffectiveValue("slack_status_channel") || "";
const SLACK_NOTIFY_ENABLED = getEffectiveValue("slack_notifications_enabled");
const SUMMARY_ENABLED = getEffectiveValue("summary_enabled");

const HTTP_HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
let warnedInvalidSessionHeader = false;

function normalizeSessionHeader(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "string" ? value.trim() : null;
  if (normalized === "") return null;
  if (normalized && HTTP_HEADER_TOKEN.test(normalized)) return normalized;
  if (!warnedInvalidSessionHeader) {
    warnedInvalidSessionHeader = true;
    console.warn("⚠️  Ignoring invalid llm.openaiCompatible.sessionHeader; expected an RFC 7230 header token of at most 128 characters.");
  }
  return null;
}

function validateSttProviderApiKey(options = {}) {
  const {
    env = null,
    provider = String(env?.STT_PROVIDER || STT_PROVIDER).trim().toLowerCase(),
  } = options;

  // Mirrors the stt-provider.js dispatch: "soniox" → Soniox, anything else → Deepgram.
  let message = null;
  const sonioxKey = env?.SONIOX_API_KEY || getEffectiveValue("soniox_api_key");
  const deepgramKey = env?.DEEPGRAM_API_KEY || getEffectiveValue("deepgram_api_key");
  if (provider === "soniox" && !sonioxKey) {
    message = "❌  Set SONIOX_API_KEY for the soniox STT provider (STT_PROVIDER=soniox is the default).";
  } else if (provider !== "soniox" && !deepgramKey) {
    message = `❌  Set DEEPGRAM_API_KEY for the "${provider}" STT provider (any value other than "soniox" routes to Deepgram).`;
  }

  if (!message) return;

  throw new Error(message);
}

function resolveConfigEnv(raw, env = {}) {
  const unresolved = [];
  function resolveDeep(obj, keyPath = "") {
    if (typeof obj === "string") {
      const match = obj.match(/^\$\{(.+)\}$/);
      if (match) {
        const val = env[match[1]];
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

  return { resolved: resolveDeep(raw), unresolved };
}

/**
 * Load config.json (single-agent format).
 * Resolves ${ENV_VAR} placeholders in string values.
 * Returns parsed config or null if config.json not found.
 */
function loadConfig() {
  const raw = getRawConfig();
  return Object.keys(raw).length > 0 ? stripLegacyClass2(raw) : null;
}

function getFloorSettings() {
  const { parseFloorSettings } = require("./settings/schemas");
  const startup = getStartup();
  const rawConfig = getRawConfig();
  const resolve = (envName, configValue, fallback = "") => {
    for (const value of [startup.preDotenvEnv[envName], configValue, startup.dotenvSeeds[envName]]) {
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return fallback;
  };
  const tailValue = resolve("HUB_TAIL_MS", rawConfig?.hub?.tailMs, 500);
  const debugValue = resolve("FLOOR_DEBUG", rawConfig?.hub?.debug, false);
  const parsedTail = typeof tailValue === "number" ? tailValue : Number(String(tailValue).trim());
  const parsed = parseFloorSettings({
    url: String(resolve("HUB_URL", rawConfig?.hub?.url)).trim(),
    roomCode: String(resolve("HUB_ROOM_CODE", rawConfig?.hub?.roomCode)).trim(),
    sharedToken: String(resolve("HUB_SHARED_TOKEN", rawConfig?.hub?.sharedToken)),
    tailMs: parsedTail,
    debug: debugValue === true || debugValue === "1",
  });
  return {
    hub: {
      enabled: Boolean(parsed.url && parsed.roomCode),
      url: parsed.url || null,
      roomCode: parsed.roomCode || null,
      authToken: parsed.sharedToken,
      tailMs: parsed.tailMs,
    },
    debug: parsed.debug,
  };
}

function getHubConfig() {
  return getFloorSettings().hub;
}

const FLOOR_SETTINGS = getFloorSettings();
const HUB_CONFIG = Object.freeze(FLOOR_SETTINGS.hub);
const PIPELINE_HUB_CONFIG = Object.freeze({ ...HUB_CONFIG, debug: FLOOR_SETTINGS.debug });

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
  const envVoiceId = getEffectiveValue("fish_audio_voice_id") || null;
  const messages = resolveMessages(configJson);
  let provider = String(
    overrides.provider
      || getEffectiveValue("llm_provider")
      || "openclaw"
  ).trim().toLowerCase();
  if (provider !== "openclaw" && provider !== "openai-compatible") {
    console.error(`⚠️  Unknown LLM provider "${provider}"; falling back to "openclaw".`);
    provider = "openclaw";
  }
  if (provider !== "openclaw" && Object.prototype.hasOwnProperty.call(configJson?.prompts || {}, "voiceSystemAddendumTemplate") && !String(configJson.prompts.voiceSystemAddendumTemplate).includes("{openclawRules}")) console.warn("⚠️  Non-OpenClaw voiceSystemAddendumTemplate should include {openclawRules} so OpenClaw-only rules can be omitted.");
  // Build voice addendum: use per-agent emotionTags flag
  const agentEmotionTags = getEffectiveValue("agent_emotion_tags") !== false;
  const defaultVoiceAddendum = (agentEmotionTags && messages.prompts.voiceSystemAddendum)
    || buildVoiceAddendumFromMessages(messages, { emotionTags: agentEmotionTags, openclaw: true })
    || buildVoiceAddendum({ emotionTags: agentEmotionTags });
  const llmAddendum = agentEmotionTags
    ? (Object.prototype.hasOwnProperty.call(overrides, "openclawSystemAddendum")
        ? overrides.openclawSystemAddendum
        : (agent?.openclawSystemAddendum ?? defaultVoiceAddendum))
    : defaultVoiceAddendum;
  const ttsReferenceId = envVoiceId;

  // OpenClaw manages its persona via the Gateway. Standalone providers need a
  // usable persona even when no prompt was configured explicitly.
  const configuredSystemPrompt = overrides.prompt
    || getEffectiveValue("llm_system_prompt")
    || messages.prompts.standaloneSystemPrompt;
  const systemAddendum = (agentEmotionTags && messages.prompts.voiceSystemAddendum)
    || buildVoiceAddendumFromMessages(messages, {
      emotionTags: agentEmotionTags,
      openclaw: false,
    });
  const systemPrompt = provider === "openclaw"
    ? (agentProfile?.systemPrompt || overrides.prompt || "")
    : `${configuredSystemPrompt}\n\n${systemAddendum}`;

  // Normalize Gateway config here so downstream consumers only read config.llm.
  const resolvedOpenclawUrl = getStartup().connection.openclawUrl || null;
  const resolvedOpenclawToken = getStartup().connection.openclawToken || null;
  if (provider === "openclaw" && (!resolvedOpenclawUrl || !resolvedOpenclawToken)) {
    console.error("❌  The selected LLM connection is not configured in the environment.");
  }

  const llmTemperature = overrides.temperature
    ?? getEffectiveValue("llm_temperature")
    ?? 0.5;
  const llmMaxTokens = overrides.maxTokens
    ?? getEffectiveValue("llm_max_tokens")
    ?? 300;
  const llmModel = overrides.model || getEffectiveValue("llm_model")
    || (provider === "openclaw" ? "openclaw" : null);
  if (!llmModel) {
    throw new Error("❌  OpenAI-compatible model is required. Set llm.model in config.json or configure an agent model.");
  }
  const historyMaxTurns = overrides.historyMaxTurns
    ?? getEffectiveValue("llm_history_max_turns")
    ?? 12;
  const openaiCompatible = {
    baseUrl: overrides.openaiCompatible?.baseUrl
      || getEffectiveValue("openai_base_url")
      || null,
    apiKey: getStartup().connection.openaiApiKey
      || null,
    emptyResponseRetry: boolOption(
      overrides.openaiCompatible?.emptyResponseRetry
      ?? getEffectiveValue("openai_empty_response_retry"),
      true
    ),
    trustedAgentTools: boolOption(
      overrides.openaiCompatible?.trustedAgentTools
      ?? getEffectiveValue("openai_trusted_agent_tools"),
      false
    ),
    sessionHeader: normalizeSessionHeader(
      overrides.openaiCompatible?.sessionHeader
      ?? getEffectiveValue("openai_session_header")
    ),
    streamingEquivalentEnabled: boolOption(
      overrides.openaiCompatible?.streamingEquivalentEnabled
      ?? getEffectiveValue("streaming_equivalent_enabled"),
      true
    ),
  };

  // Resolve greeting: agentProfile > overrides > agent > empty (skip if unconfigured)
  const greeting =
    overrides.greeting ||
    agentProfile?.greeting ||
    agent?.greeting ||
    "";

  return {
    dgKey: getEffectiveValue("deepgram_api_key"),
    sonioxKey: getEffectiveValue("soniox_api_key"),
    fishKey: getEffectiveValue("fish_audio_api_key"),
    // Backward-compatible aliases. New consumers read the normalized llm fields.
    openclawUrl: resolvedOpenclawUrl,
    openclawToken: resolvedOpenclawToken,
    warmupTimeoutMs: getEffectiveValue("gateway_warmup_timeout_ms"),
    gatewayBriefingPrompt: agentEmotionTags
      ? messages.prompts.gatewayBriefingSystem
      : buildGatewayBriefingSystem({ emotionTags: false }),
    gatewayWarmupUserPrompt: messages.prompts.gatewayWarmupUser,
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
      provider,
      // Do not default to a foundation model here; let Gateway choose.
      // (If a foundation model is required, set it explicitly via overrides/agent config.)
      model: llmModel,
      temperature: llmTemperature,
      maxTokens: llmMaxTokens,
      systemPrompt,
      historyMaxTurns,
      openaiCompatible,
      gateway: {
        url: resolvedOpenclawUrl,
        token: resolvedOpenclawToken,
      },
      responseTimeoutMs: overrides.responseTimeoutMs ?? LLM_RESPONSE_TIMEOUT_MS,
      firstTokenDelegateMs: overrides.firstTokenDelegateMs ?? FIRST_TOKEN_DELEGATE_MS,
      openclawSystemAddendum: llmAddendum,
    },
    tts: {
      provider: "fish-audio",
      referenceId: ttsReferenceId,
      sampleRate: TTS_SAMPLE_RATE,
      latency: getEffectiveValue("fish_audio_latency"),
      // Speech rate, 0.5-2.0 (1.0 = native speed). Default 1.0, chosen
      // 2026-05-04 after switching the default model to s2-pro: 0.9 felt
      // unnaturally slow on s2-pro's already-calmer delivery. env is kept
      // as an escape hatch only — change the default here for permanent
      // moves so there is one source of truth.
      speed: getEffectiveValue("fish_audio_speed"),
    },
    hub: PIPELINE_HUB_CONFIG,
    briefing: overrides.briefing || null,
    purposeStatement: overrides.purposeStatement || null,
    greeting,
    slack: {
      botToken: SLACK_BOT_TOKEN,
      channelId: SLACK_NOTIFY_CHANNEL,
      statusChannelId: SLACK_STATUS_CHANNEL || SLACK_SUMMARY_CHANNEL || SLACK_NOTIFY_CHANNEL,
      summaryChannelId: SLACK_SUMMARY_CHANNEL || SLACK_NOTIFY_CHANNEL,
      enabled: SLACK_NOTIFY_ENABLED,
      notifyTarget: getEffectiveValue("slack_notifications_target"),
      dmUserId: getEffectiveValue("slack_dm_user_id") || "",
      labels: messages.slack,
    },
    summary: {
      enabled: SUMMARY_ENABLED,
      prompt: messages.prompts.summary,
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
      delegateReplyFreshMs: DELEGATE_REPLY_FRESH_MS,
      parentCompactDelayMs: PARENT_COMPACT_DELAY_MS,
      parentCompactMaxLines: PARENT_COMPACT_MAX_LINES,
      shortUtteranceSkipChars: SHORT_UTTERANCE_SKIP_CHARS,
      circuitBreakerTimeouts: CIRCUIT_BREAKER_TIMEOUTS,
      displayName: messages.gateway.displayName,
    },
    prompts: messages.prompts,
    messages: messages.speech,
    regex: messages.regex,
    delegation: messages.delegation,
    exit: messages.exit,
    // Per-agent voice extensions
    emotionTags: agentEmotionTags,
    ackVariants: overrides.ackVariants || agentProfile?.ackVariants || getEffectiveValue("agent_ack_variants") || messages.speech.ackVariants,
    progressPings: agentProfile?.progressPings || getEffectiveValue("agent_progress_pings") || messages.speech.progressPings,
    timeoutFallback: agentProfile?.timeoutFallback || getEffectiveValue("agent_timeout_fallback") || messages.speech.timeoutFallback,
    exitFarewell: agentProfile?.exitFarewell || getEffectiveValue("agent_exit_farewell") || messages.speech.exitFarewell,
    cancelAck: agentProfile?.cancelAck || getEffectiveValue("agent_cancel_ack") || null,
  };
}

module.exports = {
  getPipelineConfig,
  SAMPLE_RATE,
  TTS_SAMPLE_RATE,
  TTS_PROVIDER,
  validateSttProviderApiKey,
  SLACK_BOT_TOKEN,
  SLACK_NOTIFY_CHANNEL,
  SLACK_NOTIFY_ENABLED,
  SLACK_SUMMARY_CHANNEL,
  SLACK_STATUS_CHANNEL,
  SUMMARY_ENABLED,
  GATEWAY_EVENTS_ENABLED,
  getHubConfig,
  HUB_CONFIG,
  FORCED_DELEGATION_ABORT,
  HANDOFF_DELEGATE_SESSION,
  HANDOFF_INFLIGHT_MAX,
  HANDOFF_COOLDOWN_MS,
  REPORT_VOICE_GAP_MS,
  REPORT_CHAT_ENABLED,
  REPORT_VOICE_ENABLED,
  GATEWAY_EVENTS_AGENT_ID,
  loadConfig,
  resolveMessages,
  _test: { resolveConfigEnv },
};
