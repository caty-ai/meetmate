// config.js — Voice Agent configuration
const fs = require("fs");
const path = require("path");

// Load Caty's system prompt from markdown file
const CATY_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "caty-system.md"),
  "utf-8"
);

const SAMPLE_RATE = 16_000;

/**
 * Build the Deepgram Voice Agent configuration.
 * Keeps it simple: STT (Nova 3) → LLM (Claude) → TTS (Aura)
 */
function buildAgentConfig(overrides = {}) {
  return {
    audio: {
      input:  { encoding: "linear16", sample_rate: SAMPLE_RATE },
      output: { encoding: "linear16", sample_rate: SAMPLE_RATE, container: "none" },
    },
    agent: {
      listen: {
        provider: { type: "deepgram", model: "nova-3" },
      },
      think: {
        provider: {
          type: "anthropic",
          model: overrides.model || "claude-sonnet-4-5",
          temperature: 0.7,
        },
        prompt: overrides.prompt || CATY_PROMPT,
      },
      speak: {
        provider: {
          type: "deepgram",
          model: overrides.voice || "aura-2-thalia-en",
        },
      },
      greeting: overrides.greeting || "Hi! I'm Caty. Nice to meet you!",
    },
  };
}

module.exports = { buildAgentConfig, SAMPLE_RATE, CATY_PROMPT };
