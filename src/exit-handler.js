// exit-handler.js — Generalized exit command detection and exit sequence
// Moved from pipeline.js hardcoded EXIT_COMMANDS to agent-configurable exit handling

const DEFAULT_EXIT_COMMANDS = [
  "退出して", "退出していいよ", "退出", "退出して大丈夫",
  "退室して", "退室していいよ", "退室", "退室して大丈夫", "退室してもらって",
];

/**
 * Get exit commands for an agent. Uses agent-specific commands if available,
 * otherwise falls back to defaults.
 * @param {object} [agentProfile] - Agent profile with optional exitCommands
 * @returns {string[]}
 */
function getExitCommands(agentProfile) {
  if (agentProfile?.exitCommands && agentProfile.exitCommands.length > 0) {
    return agentProfile.exitCommands;
  }
  return DEFAULT_EXIT_COMMANDS;
}

/**
 * Normalize katakana: strip long vowel marks and small tsu for fuzzy matching.
 */
function _normalizeKana(text) {
  return text
    .replace(/ー/g, "")
    .replace(/ッ/g, "")
    .replace(/っ/g, "")
    .replace(/\s+/g, "");
}

/**
 * Detect if text contains an exit intent.
 * Checks against exit commands (default or agent-specific).
 *
 * @param {string} text - User utterance
 * @param {object} [agents] - All loaded agents
 * @param {string[]} [selectedAgentIds] - Currently selected agent IDs
 * @param {string} [defaultAgentId] - Default agent ID
 * @param {object} [agentProfile] - Agent profile for exit commands
 * @returns {boolean}
 */
function detectExitIntent(text, agents, selectedAgentIds, defaultAgentId, agentProfile) {
  const lower = text.toLowerCase().trim();
  const normalized = _normalizeKana(lower);
  const exitCmds = getExitCommands(agentProfile);

  for (const cmd of exitCmds) {
    const cmdNorm = _normalizeKana(cmd.toLowerCase());
    if (normalized.includes(cmdNorm) || lower.includes(cmd)) {
      return true;
    }
  }

  return false;
}

/**
 * Run the exit sequence: speak farewell, emit exit event, wait grace period.
 *
 * @param {object} options
 * @param {import("events").EventEmitter} options.emitter - Pipeline event emitter
 * @param {object} options.session - Session object
 * @param {object} [options.agentProfile] - Agent profile
 * @param {function} options.speakFn - async function(text, signal) to speak
 * @param {string} [options.currentAgentId] - Current agent ID for logging
 * @param {number} [options.timeoutMs=5000] - Grace period timeout
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function runExitSequence(options) {
  const {
    emitter,
    session,
    agentProfile,
    speakFn,
    currentAgentId,
    timeoutMs = 5000,
  } = options;

  const EXIT_GRACE_MS = timeoutMs;
  let exitTimer = null;

  try {
    // Speak farewell
    const farewell = options.farewell || agentProfile?.exitFarewell || "(happy) 了解です！退出しますね。お疲れさまでした！";
    try {
      await speakFn(farewell, null);
    } catch {
      // ignore TTS error during exit
    }

    // Wait for farewell audio to finish playing
    await new Promise((resolve) => {
      exitTimer = setTimeout(resolve, EXIT_GRACE_MS);
    });

    // Emit exit event
    emitter.emit("exit_requested", {
      sessionId: session.id,
      trigger: "voice_command",
      agentId: currentAgentId || agentProfile?.agentId || null,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "EXIT_TIMEOUT" };
  } finally {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
  }
}

module.exports = {
  getExitCommands,
  detectExitIntent,
  runExitSequence,
  DEFAULT_EXIT_COMMANDS,
};
