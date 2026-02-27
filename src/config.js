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

// Cartesia voice ID (override via env)
// Japanese Woman Conversational: 2b568345-1d48-4047-b25f-7baccf842eb0
// Anime Girl: 1001d611-b1a8-46bd-a5ca-551b23505334
// Sweet Lady: e3827ec5-697a-4b7c-9704-1a23041bbc51
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || "1001d611-b1a8-46bd-a5ca-551b23505334";

// Audio quality / turn-taking tuning (Phase 1 hardening)
const LISTEN_ENDPOINTING_MS = Number(process.env.LISTEN_ENDPOINTING_MS || 450);
const LISTEN_UTTERANCE_END_MS = Number(process.env.LISTEN_UTTERANCE_END_MS || 1_200);
const AGENT_TEMPERATURE = Number(process.env.AGENT_TEMPERATURE || 0.5);
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 220);

/**
 * Build the Deepgram Voice Agent configuration.
 * STT (Nova 3) → LLM (Claude) → TTS (Cartesia Sonic / Deepgram Aura)
 */
function buildAgentConfig(overrides = {}) {
  const lang = overrides.lang || LANG;
  const isJapanese = lang === "ja";

  // Keep UI -> join-meeting -> runtime voice selection working for Japanese mode.
  // UI sends `voice` field, so we accept either voiceId or voice as Cartesia ID.
  const selectedCartesiaVoiceId = overrides.voiceId || overrides.voice || CARTESIA_VOICE_ID;

  // TTS config: Cartesia managed for Japanese, Deepgram Aura for English
  const speakConfig = isJapanese
    ? {
        provider: {
          type: "cartesia",
          model_id: "sonic-2",
          voice: {
            mode: "id",
            id: selectedCartesiaVoiceId,
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
    // AgentStartedSpeaking event is emitted only in experimental mode.
    experimental: true,
    audio: {
      input: { encoding: "linear16", sample_rate: SAMPLE_RATE },
      output: { encoding: "linear16", sample_rate: SAMPLE_RATE, container: "none" },
    },
    agent: {
      listen: {
        provider: {
          type: "deepgram",
          model: "nova-3",
          language: lang,
          smart_format: true,
          vad_events: true,
          endpointing: LISTEN_ENDPOINTING_MS,
          utterance_end_ms: LISTEN_UTTERANCE_END_MS,
        },
      },
      think: {
        provider: {
          type: "anthropic",
          model: overrides.model || "claude-sonnet-4-5",
          temperature: AGENT_TEMPERATURE,
          max_tokens: AGENT_MAX_TOKENS,
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
