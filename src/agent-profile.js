// agent-profile.js — Resolve and cache agent profile from config.json or agents.json (deprecated)
// Priority: config.json > agents.json + AGENT_ID env

const fs = require("fs");
const path = require("path");
const { loadConfig, loadAgents } = require("./config");

class AgentNotFoundError extends Error {
  constructor(agentId) {
    super(`Agent "${agentId}" not found in agents.json`);
    this.name = "AgentNotFoundError";
    this.agentId = agentId;
  }
}

/** @type {AgentProfile|null} */
let _cached = null;

/**
 * Resolve an agent profile.
 *
 * Resolution priority:
 *   1. config.json (new single-agent format) — if present, always used
 *   2. agents.json + agentId param / AGENT_ID env (deprecated fallback)
 *
 * If neither config.json nor agents.json provides an agent, throws AgentNotFoundError.
 * No implicit default agent fallback.
 *
 * @param {string} [agentId] - Explicit agent ID (only used for agents.json fallback path)
 * @returns {AgentProfile}
 */
function resolveAgentProfile(agentId) {
  // Try config.json first (new way)
  const config = loadConfig();
  if (config?.agent) {
    const effectiveId = config.agent.id || agentId || process.env.AGENT_ID;
    if (!effectiveId) {
      throw new AgentNotFoundError("(no agent id in config.json)");
    }
    if (_cached && _cached.agentId === effectiveId) return _cached;
    return _buildProfileFromConfig(config);
  }

  // Fallback: agents.json (deprecated)
  const explicit = agentId || process.env.AGENT_ID || null;
  if (!explicit) {
    throw new AgentNotFoundError("(no AGENT_ID set and no config.json found)");
  }

  if (_cached && _cached.agentId === explicit) return _cached;

  console.warn("⚠️  DEPRECATED: Using agents.json — migrate to config.json (see config.json.example)");

  const agents = loadAgents();
  const agent = agents[explicit];
  if (!agent) {
    throw new AgentNotFoundError(explicit);
  }

  return _buildProfileFromAgentsJson(explicit, agent);
}

/**
 * Build profile from config.json (new format).
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
 * Build profile from agents.json entry (deprecated path).
 */
function _buildProfileFromAgentsJson(agentId, agent) {
  // No prompt file loading — Gateway manages prompts via SOUL.md
  const systemPrompt = "";

  // Check avatar: try generic avatar.png first, then legacy {agentId}-avatar.png
  let avatarPath = path.join(__dirname, "..", "assets", "avatar.png");
  let avatarExists = false;
  try { avatarExists = fs.existsSync(avatarPath); } catch { /* ignore */ }
  if (!avatarExists) {
    avatarPath = path.join(__dirname, "..", "assets", `${agentId}-avatar.png`);
    try { avatarExists = fs.existsSync(avatarPath); } catch { /* ignore */ }
  }

  const profile = {
    agentId,
    name: agent.name || agentId,
    displayName: agent.displayName || agent.name || agentId,
    systemPrompt,
    greeting: agent.greeting || "",
    model: agent.model || null,
    voiceId: agent.voiceId || null,
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
    gatewayUrl: agent.gatewayUrl || null,
    gatewayToken: agent.gatewayToken || null,
    attendeeApiKey: agent.attendeeApiKey || null,
    isDefault: !!agent.default,
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
