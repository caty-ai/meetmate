// config.js — Voice Agent / Pipeline configuration
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

// TTS Provider: "fish-audio" (decomposed pipeline) or "deepgram-agent" (legacy all-in-one)
const TTS_PROVIDER = process.env.TTS_PROVIDER || "fish-audio";

// Cartesia voice ID (for legacy deepgram-agent mode)
// Japanese Woman Conversational: 2b568345-1d48-4047-b25f-7baccf842eb0
// Anime Girl: 1001d611-b1a8-46bd-a5ca-551b23505334
// Sweet Lady: e3827ec5-697a-4b7c-9704-1a23041bbc51
const CARTESIA_VOICE_ID =
  process.env.CARTESIA_VOICE_ID || "1001d611-b1a8-46bd-a5ca-551b23505334";

// Audio quality / turn-taking tuning
const LISTEN_ENDPOINTING_MS = Number(process.env.LISTEN_ENDPOINTING_MS || 400);
const LISTEN_UTTERANCE_END_MS = Number(
  process.env.LISTEN_UTTERANCE_END_MS || 1200
);

// LLM tuning
const AGENT_TEMPERATURE = Number(process.env.AGENT_TEMPERATURE || 0.5);
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 300);

// Echo loop protection
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);

// Slack integration
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_NOTIFY_CHANNEL = process.env.SLACK_NOTIFY_CHANNEL || "";
const SLACK_NOTIFY_ENABLED = String(process.env.SLACK_NOTIFY_ENABLED || "true").toLowerCase() !== "false";
const SUMMARY_ENABLED = String(process.env.SUMMARY_ENABLED || "true").toLowerCase() !== "false";

/**
 * Get pipeline config for the decomposed STT → LLM → TTS flow.
 */
function getPipelineConfig(overrides = {}) {
  const isJapanese = LANG === "ja";

  return {
    dgKey: process.env.DEEPGRAM_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY,
    fishKey: process.env.FISH_AUDIO_API_KEY,
    openclawUrl: process.env.OPENCLAW_GATEWAY_URL || null,
    openclawToken: process.env.OPENCLAW_GATEWAY_TOKEN || null,
    systemPrompt: overrides.prompt || CATY_PROMPT,
    wakeMode: overrides.wakeMode || null,
    echoCooldownMs: ECHO_LOOP_COOLDOWN_MS,
    stt: {
      model: "nova-3",
      language: LANG,
      sampleRate: SAMPLE_RATE,
    },
    llm: {
      model: overrides.model || "anthropic/claude-sonnet-4-5",
      temperature: AGENT_TEMPERATURE,
      maxTokens: AGENT_MAX_TOKENS,
    },
    tts: {
      provider: "fish-audio",
      referenceId: process.env.FISH_AUDIO_VOICE_ID || null,
      sampleRate: SAMPLE_RATE,
      latency: process.env.FISH_AUDIO_LATENCY || "balanced",
    },
    greeting:
      overrides.greeting ||
      (isJapanese
        ? "(happy) こんにちは！ケイティです。よろしくお願いします！"
        : "(happy) Hi! I'm Caty. Nice to meet you!"),
    slack: {
      botToken: SLACK_BOT_TOKEN,
      channelId: SLACK_NOTIFY_CHANNEL,
      enabled: SLACK_NOTIFY_ENABLED,
    },
    summary: {
      enabled: SUMMARY_ENABLED,
    },
  };
}

/**
 * Build Voice Agent config (legacy deepgram-agent mode).
 */
function buildAgentConfig(overrides = {}) {
  const lang = overrides.language || LANG;
  const isJapanese = lang === "ja";
  const selectedCartesiaVoiceId =
    overrides.voice || CARTESIA_VOICE_ID;

  // TTS config: Cartesia managed for Japanese, Deepgram Aura for English
  // NOTE: Deepgram-managed Cartesia does NOT support `language` field.
  const speakConfig = isJapanese
    ? {
        provider: {
          type: "cartesia",
          model_id: "sonic-2",
          voice: {
            mode: "id",
            id: selectedCartesiaVoiceId,
          },
        },
      }
    : {
        provider: {
          type: "deepgram",
          model: overrides.voice || "aura-2-thalia-en",
        },
      };

  return {
    experimental: true,
    audio: {
      input: { encoding: "linear16", sample_rate: SAMPLE_RATE },
      output: {
        encoding: "linear16",
        sample_rate: SAMPLE_RATE,
        container: "none",
      },
    },
    agent: {
      listen: {
        provider: {
          type: "deepgram",
          model: "nova-3",
          language: lang,
          smart_format: true,
        },
      },
      think: {
        provider: {
          type: "anthropic",
          model: overrides.model || "claude-sonnet-4-5",
          temperature: AGENT_TEMPERATURE,
        },
        prompt: overrides.prompt || CATY_PROMPT,
      },
      speak: speakConfig,
      greeting:
        overrides.greeting ||
        (isJapanese
          ? "こんにちは！ケイティです。よろしくお願いします！"
          : "Hi! I'm Caty. Nice to meet you!"),
    },
  };
}

module.exports = {
  buildAgentConfig,
  getPipelineConfig,
  SAMPLE_RATE,
  CATY_PROMPT,
  TTS_PROVIDER,
  SLACK_BOT_TOKEN,
  SLACK_NOTIFY_CHANNEL,
  SLACK_NOTIFY_ENABLED,
  SUMMARY_ENABLED,
};
