const fs = require("fs");
const path = require("path");
const { buildVoiceAddendum } = require("./llm");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const SAMPLE_RATE = 16_000;
const TTS_PROVIDER = process.env.TTS_PROVIDER || "fish-audio";
const LANG = process.env.AGENT_LANG || "ja";

const LISTEN_ENDPOINTING_MS = Number(process.env.LISTEN_ENDPOINTING_MS || 400);
const LISTEN_UTTERANCE_END_MS = Number(process.env.LISTEN_UTTERANCE_END_MS || 1200);
const AGENT_TEMPERATURE = Number(process.env.AGENT_TEMPERATURE || 0.5);
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 300);
// First-audio timeout: aborts the LLM turn if no chunk arrives in this window.
// Pipeline clears the timer on the first streamed chunk (firstChunkSeen),
// so this is effectively a "first audible chunk" deadline. The budget covers
// the always-ack + up to 3 progress pings (~30s) plus buffer, so timeout
// fires only on genuine Gateway/tool hangs rather than legitimately slow
// turns. Set to 0 to disable.
const LLM_RESPONSE_TIMEOUT_MS = Number(process.env.LLM_RESPONSE_TIMEOUT_MS || 35_000);
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);

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
    fishKey: process.env.FISH_AUDIO_API_KEY,
    openclawUrl: agent?.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || null,
    openclawToken: agent?.gatewayToken || process.env.OPENCLAW_GATEWAY_TOKEN || null,
    warmupTimeoutMs: configJson?.gateway?.warmupTimeoutMs || null,
    systemPrompt,
    exitDetection: overrides.exitDetection,
    echoCooldownMs: ECHO_LOOP_COOLDOWN_MS,
    stt: {
      model: "nova-3",
      language: LANG,
      sampleRate: SAMPLE_RATE,
      endpointingMs: LISTEN_ENDPOINTING_MS,
      utteranceEndMs: LISTEN_UTTERANCE_END_MS,
    },
    llm: {
      // Do not default to a foundation model here; let Gateway choose.
      // (If a foundation model is required, set it explicitly via overrides/agent config.)
      model: overrides.model || agent?.model || "openclaw",
      temperature: overrides.temperature ?? AGENT_TEMPERATURE,
      maxTokens: overrides.maxTokens ?? AGENT_MAX_TOKENS,
      responseTimeoutMs: overrides.responseTimeoutMs ?? LLM_RESPONSE_TIMEOUT_MS,
      openclawSystemAddendum: llmAddendum,
    },
    tts: {
      provider: "fish-audio",
      referenceId: ttsReferenceId,
      sampleRate: SAMPLE_RATE,
      latency: process.env.FISH_AUDIO_LATENCY || "balanced",
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
  TTS_PROVIDER,
  SLACK_BOT_TOKEN,
  SLACK_NOTIFY_CHANNEL,
  SLACK_NOTIFY_ENABLED,
  SLACK_SUMMARY_CHANNEL,
  SLACK_STATUS_CHANNEL,
  SUMMARY_ENABLED,
  loadConfig,
};
