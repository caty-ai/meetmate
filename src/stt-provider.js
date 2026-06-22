// stt-provider.js — STT provider dispatcher
// Selects the STT backend at runtime via STT_PROVIDER (default: "deepgram").
// Keeps the createSTT(deepgramKey, options) signature so the pipeline call
// site stays unchanged; the Soniox key is resolved from SONIOX_API_KEY.
//
// STT_PROVIDER=deepgram  → src/stt.js        (default, unchanged behavior)
// STT_PROVIDER=soniox    → src/stt-soniox.js
//
// Revert is instant: set STT_PROVIDER=deepgram and restart (no git ops).

const { createSTT: createDeepgramSTT, buildKeyterms } = require("./stt");
const { createSonioxSTT } = require("./stt-soniox");

function createSTT(deepgramKey, options = {}) {
  const provider = String(process.env.STT_PROVIDER || "deepgram").toLowerCase();

  if (provider === "soniox") {
    const key = process.env.SONIOX_API_KEY;
    if (!key) {
      console.error(
        "❌  STT_PROVIDER=soniox ですが SONIOX_API_KEY が未設定です。.env を確認してください。",
      );
    }
    return createSonioxSTT(key, options);
  }

  return createDeepgramSTT(deepgramKey, options);
}

module.exports = { createSTT, buildKeyterms };
