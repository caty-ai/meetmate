// agent-profile.js — Resolve and cache agent profile from config.json
// 1 server = 1 agent. config.json is the sole source of agent configuration.

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config");

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
    const effectiveId = config.agent.id || agentId || process.env.AGENT_ID;
    if (!effectiveId) {
      throw new AgentNotFoundError("(no agent id in config.json)");
    }
    if (_cached && _cached.agentId === effectiveId) return _cached;
    return _buildProfileFromConfig(config);
  }

  throw new AgentNotFoundError(
    agentId || process.env.AGENT_ID || "(no config.json found — create one from config.json.example)"
  );
}

/**
 * Build profile from config.json.
 */
function _buildProfileFromConfig(config) {
  const agent = config.agent;
  const agentId = agent.id;

  // Check avatar: single generic name since 1 server = 1 agent
  const avatarPath = path.join(__dirname, "..", "assets", "avatar.png");
  let avatarExists = false;
  try { avatarExists = fs.existsSync(avatarPath); } catch { /* ignore */ }

  const profile = {
    agentId,
    name: agent.name || agentId,
    displayName: agent.displayName || agent.name || agentId,
    systemPrompt: "", // Gateway manages prompts via SOUL.md
    greeting: agent.greeting || "",
    model: agent.model || null,
    voiceId: config.tts?.voiceId || null,
    wakeWords: agent.wakeWords || [],
    keyterms: agent.keyterms || [],
    emotionTags: agent.emotionTags !== false,
    ackVariants: Array.isArray(agent.ackVariants) ? agent.ackVariants : null,
    progressPings: Array.isArray(agent.progressPings) ? agent.progressPings : null,
    timeoutFallback: agent.timeoutFallback || null,
    exitFarewell: agent.exitFarewell || null,
    cancelAck: agent.cancelAck || null,
    avatarPath: avatarExists ? avatarPath : null,
    avatarUrl: agent.avatarUrl || null,
    gatewayUrl: config.gateway?.url || null,
    gatewayToken: config.gateway?.token || null,
    attendeeApiKey: null,
    isDefault: true,
    sttWakeVariants: Array.isArray(agent.sttWakeVariants) ? agent.sttWakeVariants : [],
    exitCommands: Array.isArray(agent.exitCommands) ? agent.exitCommands : [],

    toString() {
      const masked = { ...this };
      if (masked.gatewayToken) masked.gatewayToken = "***";
      delete masked.toString;
      delete masked.toJSON;
      return JSON.stringify(masked, null, 2);
    },

    toJSON() {
      const obj = { ...this };
      if (obj.gatewayToken) obj.gatewayToken = "***";
      delete obj.toString;
      delete obj.toJSON;
      return obj;
    },
  };

  _cached = profile;
  return profile;
}

/**
 * Clear the cached profile (useful for testing or agent switching).
 */
function clearProfileCache() {
  _cached = null;
}

module.exports = {
  AgentNotFoundError,
  resolveAgentProfile,
  clearProfileCache,
};
