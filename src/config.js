const fs = require("fs");
const path = require("path");
const { buildVoiceAddendum } = require("./llm");

const AGENTS_PATH = path.join(__dirname, "..", "agents.json");
const CATY_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "caty-system.md"),
  "utf-8"
);

const SAMPLE_RATE = 16_000;
const TTS_PROVIDER = process.env.TTS_PROVIDER || "fish-audio";
const LANG = process.env.AGENT_LANG || "ja";

const LISTEN_ENDPOINTING_MS = Number(process.env.LISTEN_ENDPOINTING_MS || 400);
const LISTEN_UTTERANCE_END_MS = Number(process.env.LISTEN_UTTERANCE_END_MS || 1200);
const AGENT_TEMPERATURE = Number(process.env.AGENT_TEMPERATURE || 0.5);
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 300);
const LLM_RESPONSE_TIMEOUT_MS = Number(process.env.LLM_RESPONSE_TIMEOUT_MS || 0);
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_NOTIFY_CHANNEL = process.env.SLACK_NOTIFY_CHANNEL || "";
const SLACK_SUMMARY_CHANNEL = process.env.SLACK_SUMMARY_CHANNEL || "";
const SLACK_STATUS_CHANNEL = process.env.SLACK_STATUS_CHANNEL || "";
const SLACK_NOTIFY_ENABLED = String(process.env.SLACK_NOTIFY_ENABLED || "true").toLowerCase() !== "false";
const SUMMARY_ENABLED = String(process.env.SUMMARY_ENABLED || "true").toLowerCase() !== "false";

function resolveEnvToken(value, fieldName = "token") {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^\$\{(.+)\}$/);
  if (!match) {
    if (raw.length > 8) {
      console.warn(
        `⚠️  SECURITY: ${fieldName} appears to be a plaintext token in agents.json. Use \${ENV_VAR} syntax instead.`
      );
    }
    return raw;
  }
  return process.env[match[1]] || null;
}

function loadAgents() {
  if (!fs.existsSync(AGENTS_PATH)) return {};

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(AGENTS_PATH, "utf-8"));
  } catch (err) {
    console.warn(`⚠️  Failed to load agents.json: ${err.message}`);
    return {};
  }

  const resolved = {};
  for (const [id, agent] of Object.entries(raw || {})) {
    const token = resolveEnvToken(agent?.gatewayToken, `${id}.gatewayToken`);
    if (!token) {
      console.warn(`⚠️  Agent "${id}" skipped: gateway token not available`);
      continue;
    }

    resolved[id] = {
      ...agent,
      id,
      gatewayUrl:
        resolveEnvToken(agent?.gatewayUrl, `${id}.gatewayUrl`) ||
        agent?.gatewayUrl ||
        null,
      gatewayToken: token,
      attendeeApiKey: resolveEnvToken(agent?.attendeeApiKey, `${id}.attendeeApiKey`) || null,
      // Voice pipeline extensions (defaults for backward compat)
      emotionTags: agent?.emotionTags !== false, // default true
      ackVariants: Array.isArray(agent?.ackVariants) ? agent.ackVariants : null,
    };
  }

  return resolved;
}

function getDefaultAgent(agents) {
  const entries = Object.values(agents || {});
  return entries.find((a) => a.default) || entries[0] || null;
}

function getAgentById(agents, id) {
  if (!id) return null;
  return (agents || {})[id] || null;
}

function getPipelineConfig(overrides = {}, agent = null) {
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

  return {
    dgKey: process.env.DEEPGRAM_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY,
    fishKey: process.env.FISH_AUDIO_API_KEY,
    openclawUrl: agent?.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || null,
    openclawToken: agent?.gatewayToken || process.env.OPENCLAW_GATEWAY_TOKEN || null,
    systemPrompt: overrides.prompt || CATY_PROMPT,
    wakeMode: overrides.wakeMode || null,
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
      model: overrides.model || agent?.model || "anthropic/claude-sonnet-4-5",
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
    greeting:
      overrides.greeting ||
      agent?.greeting ||
      (isJapanese
        ? "(happy) こんにちは！ケイティです。よろしくお願いします！"
        : "(happy) Hi! I'm Caty. Glad to talk with you!"),
    slack: {
      botToken: SLACK_BOT_TOKEN,
      channelId: SLACK_NOTIFY_CHANNEL,
      statusChannelId:
        SLACK_STATUS_CHANNEL || SLACK_SUMMARY_CHANNEL || SLACK_NOTIFY_CHANNEL,
      summaryChannelId: SLACK_SUMMARY_CHANNEL || SLACK_NOTIFY_CHANNEL,
      enabled: SLACK_NOTIFY_ENABLED,
    },
    summary: {
      enabled: SUMMARY_ENABLED,
    },
    // Per-agent voice extensions
    emotionTags: agentEmotionTags,
    ackVariants: overrides.ackVariants || agent?.ackVariants || null,
  };
}

module.exports = {
  getPipelineConfig,
  SAMPLE_RATE,
  TTS_PROVIDER,
  CATY_PROMPT,
  SLACK_BOT_TOKEN,
  SLACK_NOTIFY_CHANNEL,
  SLACK_NOTIFY_ENABLED,
  SLACK_SUMMARY_CHANNEL,
  SLACK_STATUS_CHANNEL,
  SUMMARY_ENABLED,
  loadAgents,
  getDefaultAgent,
  getAgentById,
  resolveEnvToken,
};
