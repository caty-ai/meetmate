// agent-profile.js — Resolve and cache agent profile from config.json
// 1 server = 1 agent. config.json is the sole source of agent configuration.

const fs = require("fs");
const { loadConfig } = require("./config");
const { avatarCachePath, bundledAssetPath } = require("./paths");
const { getEffectiveValue, registerCacheInvalidator } = require("./settings/resolver");

class AgentNotFoundError extends Error {
  constructor(agentId) {
    super(`Agent "${agentId}" not found. Create config.json from config.json.example.`);
    this.name = "AgentNotFoundError";
    this.agentId = agentId;
  }
}

/** @type {AgentProfile|null} */
let _cached = null;

/**
 * Resolve an agent profile from config.json.
 *
 * If config.json is missing or has no agent section, throws AgentNotFoundError.
 *
 * @param {string} [agentId] - Ignored (kept for call-site compatibility)
 * @returns {AgentProfile}
 */
function resolveAgentProfile(agentId) {
  const config = loadConfig();
  if (config?.agent) {
    const effectiveId = getEffectiveValue("agent_id") || agentId;
    if (!effectiveId) {
      throw new AgentNotFoundError("(no agent id in config.json)");
    }
    if (_cached && _cached.agentId === effectiveId) return _cached;
    return _buildProfileFromConfig(config, effectiveId);
  }

  throw new AgentNotFoundError(
    agentId || getEffectiveValue("agent_id") || "(no config.json found — create one from config.json.example)"
  );
}

/**
 * Build profile from config.json.
 */
function _buildProfileFromConfig(config, effectiveAgentId) {
  const agent = config.agent;
  const agentId = effectiveAgentId;
  const agentName = getEffectiveValue("agent_name");
  const agentDisplayName = getEffectiveValue("agent_display_name");

  // Check avatar: single generic name since 1 server = 1 agent
  const cachedAvatarPath = avatarCachePath();
  const avatarPath = fs.existsSync(cachedAvatarPath)
    ? cachedAvatarPath
    : bundledAssetPath("avatar.png");
  let avatarExists = false;
  try { avatarExists = fs.existsSync(avatarPath); } catch { /* ignore */ }

  const profile = {
    agentId,
    name: agentName || agentId,
    displayName: agentDisplayName || agentName || agentId,
    systemPrompt: "", // Gateway manages prompts via SOUL.md
    greeting: getEffectiveValue("agent_greeting") || "",
    model: getEffectiveValue("llm_model") || null,
    voiceId: getEffectiveValue("tts_provider") === "fish-audio"
      ? getEffectiveValue("fish_audio_voice_id") || null
      : null,
    wakeWords: getEffectiveValue("agent_wake_words") || [],
    keyterms: getEffectiveValue("agent_keyterms") || [],
    emotionTags: getEffectiveValue("agent_emotion_tags") !== false,
    ackVariants: getEffectiveValue("agent_ack_variants") || null,
    progressPings: getEffectiveValue("agent_progress_pings") || null,
    timeoutFallback: getEffectiveValue("agent_timeout_fallback") || null,
    exitFarewell: getEffectiveValue("agent_exit_farewell") || null,
    cancelAck: getEffectiveValue("agent_cancel_ack") || null,
    avatarPath: avatarExists ? avatarPath : null,
    avatarUrl: getEffectiveValue("agent_avatar_url") || null,
    attendeeApiKey: getEffectiveValue("attendee_api_key") || null,
    isDefault: true,
    sttWakeVariants: getEffectiveValue("agent_stt_wake_variants") || [],
    exitCommands: Array.isArray(agent.exitCommands) ? agent.exitCommands : [],

    toString() {
      const masked = { ...this };
      if (masked.attendeeApiKey) masked.attendeeApiKey = "••••••••";
      delete masked.toString;
      delete masked.toJSON;
      return JSON.stringify(masked, null, 2);
    },

    toJSON() {
      const obj = { ...this };
      if (obj.attendeeApiKey) obj.attendeeApiKey = "••••••••";
      delete obj.toString;
      delete obj.toJSON;
      return obj;
    },
  };

  _cached = profile;
  return profile;
}

/**
 * Clear the cached profile (useful for testing).
 */
function clearProfileCache() {
  _cached = null;
}

registerCacheInvalidator(clearProfileCache);

/** Collect unsupported key names without reading their potentially secret values. */
function collectLegacyMultiAgentKeys(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  const keys = [];
  if (Object.prototype.hasOwnProperty.call(parsed, "agents")) keys.push("agents");
  if (parsed?.agent?.messages
      && Object.prototype.hasOwnProperty.call(parsed.agent.messages, "groupGreetingTemplate")) {
    keys.push("agent.messages.groupGreetingTemplate");
  }
  return keys;
}

/** Warn about unsupported keys without reading their potentially secret values. */
function warnLegacyMultiAgentKeys(parsed, logger = console) {
  const keys = collectLegacyMultiAgentKeys(parsed);
  if (keys.length === 0) return;
  const agentId = typeof parsed.agent?.id === "string" ? parsed.agent.id : "unset";
  logger.warn(`Legacy multi-agent keys are ignored (this server runs one agent: "${agentId}"): ${keys.join(", ")} — run one Meetmate instance per agent; see docs/setup-guide.md`);
}

module.exports = {
  AgentNotFoundError,
  resolveAgentProfile,
  clearProfileCache,
  collectLegacyMultiAgentKeys,
  warnLegacyMultiAgentKeys,
};
