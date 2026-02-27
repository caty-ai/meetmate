// config.js — Voice Agent configuration
const fs = require("fs");
const path = require("path");

// Load Caty's system prompt from markdown file
const CATY_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "caty-system.md"),
  "utf-8"
);

const SAMPLE_RATE = 16_000;

// Language mode: "ja" for Japanese, "en" for English
const LANG = process.env.AGENT_LANG || "ja";

/**
 * Build the Deepgram Voice Agent configuration.
 * STT (Nova 3) → LLM (Claude) → TTS (Cartesia Sonic / Deepgram Aura)
 */
function buildAgentConfig(overrides = {}) {
  const lang = overrides.lang || LANG;
  const isJapanese = lang === "ja";

  // TTS config: Cartesia managed for Japanese, Deepgram Aura for English
  const speakConfig = isJapanese
    ? {
        provider: {
          type: "cartesia",
          model_id: "sonic-2",
          voice: {
            mode: "id",
            id: overrides.voiceId || "a167e0f3-df7e-4d52-a9c3-f949145efdab",
          },
          language: "ja",
        },
      }
    : {
        provider: {
          type: "deepgram",
          model: overrides.voice || "aura-2-thalia-en",
        },
      };

  return {
    audio: {
      input:  { encoding: "linear16", sample_rate: SAMPLE_RATE },
      output: { encoding: "linear16", sample_rate: SAMPLE_RATE, container: "none" },
    },
    agent: {
      listen: {
        provider: { type: "deepgram", model: "nova-3", language: lang },
      },
      think: {
        provider: {
          type: "anthropic",
          model: overrides.model || "claude-sonnet-4-5",
          temperature: 0.7,
        },
        prompt: overrides.prompt || CATY_PROMPT,
      },
      speak: speakConfig,
      greeting: overrides.greeting || (isJapanese
        ? "こんにちは！ケイティです。よろしくお願いします！"
        : "Hi! I'm Caty. Nice to meet you!"),
    },
  };
}

module.exports = { buildAgentConfig, SAMPLE_RATE, CATY_PROMPT };
