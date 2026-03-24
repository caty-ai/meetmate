// agent-profile.js — Resolve and cache agent profile from agents.json + prompt files + avatars
// Generalized agent resolution: CLI arg > AGENT_ID env > 'caty' default

const fs = require("fs");
const path = require("path");
const { loadAgents } = require("./config");

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
 * Resolve an agent profile from agents.json, prompt files, and avatar assets.
 *
 * Priority: explicit agentId param > AGENT_ID env > 'caty' default.
 * If AGENT_ID is explicitly set but not found, throws AgentNotFoundError.
 *
 * @param {string} [agentId] - Explicit agent ID (e.g. from CLI arg)
 * @returns {AgentProfile}
 */
function resolveAgentProfile(agentId) {
  // Determine effective agent ID
  const explicit = agentId || process.env.AGENT_ID || null;
  const effectiveId = explicit || "caty";

  // Return cached if same agent
  if (_cached && _cached.agentId === effectiveId) return _cached;

  const agents = loadAgents();
  const agent = agents[effectiveId];

  // If explicitly requested but not found, throw
  if (!agent && explicit) {
    throw new AgentNotFoundError(effectiveId);
  }

  // If not found and not explicit (default caty fallback), try caty
  if (!agent) {
    const catyAgent = agents["caty"];
    if (!catyAgent) {
      throw new AgentNotFoundError("caty");
    }
    return _buildProfile("caty", catyAgent);
  }

  return _buildProfile(effectiveId, agent);
}

function _buildProfile(agentId, agent) {
  // Load system prompt: try prompts/{agentId}-system.md, fallback to caty-system.md
  const promptsDir = path.join(__dirname, "prompts");
  const agentPromptPath = path.join(promptsDir, `${agentId}-system.md`);
  const catyPromptPath = path.join(promptsDir, "caty-system.md");

  let systemPrompt;
  if (fs.existsSync(agentPromptPath)) {
    systemPrompt = fs.readFileSync(agentPromptPath, "utf-8");
  } else {
    console.warn(`[${agentId}] prompt file not found: ${agentPromptPath}, falling back to caty-system.md`);
    systemPrompt = fs.existsSync(catyPromptPath)
      ? fs.readFileSync(catyPromptPath, "utf-8")
      : "";
  }

  // Check avatar existence
  const avatarPath = path.join(__dirname, "..", "assets", `${agentId}-avatar.png`);
  let avatarExists = false;
  try {
    avatarExists = fs.existsSync(avatarPath);
  } catch { /* ignore */ }
  if (!avatarExists) {
    console.warn(`[${agentId}] avatar not found: ${avatarPath}`);
  }

  const profile = {
    agentId,
    name: agent.name || agentId,
    displayName: agent.displayName || agent.name || agentId,
    systemPrompt,
    greeting: agent.greeting || null,
    model: agent.model || null,
    voiceId: agent.voiceId || null,
    wakeWords: agent.wakeWords || [],
    keyterms: agent.keyterms || [],
    emotionTags: agent.emotionTags !== false,
    ackVariants: Array.isArray(agent.ackVariants) ? agent.ackVariants : null,
    avatarPath: avatarExists ? avatarPath : null,
    avatarUrl: agent.avatarUrl || null,
    gatewayUrl: agent.gatewayUrl || null,
    gatewayToken: agent.gatewayToken || null,
    attendeeApiKey: agent.attendeeApiKey || null,
    isDefault: !!agent.default,
    // New optional fields from agents.json
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
