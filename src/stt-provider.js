// stt-provider.js — STT provider dispatcher
// Selects the STT backend via options.provider (from config.js) or the
// STT_PROVIDER env var (default: "deepgram"). Keeps the
// createSTT(deepgramKey, options) signature so the pipeline call site is
// provider-agnostic.
//
// provider=deepgram → src/stt.js        (default, unchanged behavior)
// provider=soniox   → src/stt-soniox.js
//
// Revert is instant: set STT_PROVIDER=deepgram (or config) and restart.

const { createSTT: createDeepgramSTT, buildKeyterms } = require("./stt");
const { createSonioxSTT } = require("./stt-soniox");
const { getEffectiveValue } = require("./settings/resolver");

function createSTT(deepgramKey, options = {}) {
  const provider = String(
    options.provider || getEffectiveValue("stt_provider") || "soniox",
  ).toLowerCase();

  if (provider === "soniox") {
    const key = options.sonioxKey || getEffectiveValue("soniox_api_key");
    if (!key) {
      console.error(
        "❌  STT provider=soniox ですが SONIOX_API_KEY が未設定です。.env を確認してください。",
      );
    }
    const sx = options.soniox || {};
    return createSonioxSTT(key, {
      model: sx.model,
      wsUrl: sx.wsUrl,
      language: options.language,
      sampleRate: options.sampleRate,
      // Merge dynamic wake/agent keyterms with config-defined context terms.
      keyterms: [...(options.keyterms || []), ...(sx.contextTerms || [])],
      endpointSensitivity: sx.endpointSensitivity,
      maxEndpointDelayMs: sx.maxEndpointDelayMs,
      endpointLatencyLevel: sx.endpointLatencyLevel,
    });
  }

  return createDeepgramSTT(deepgramKey, options);
}

module.exports = { createSTT, buildKeyterms };
