// tts-fish.js — Fish Audio TTS streaming wrapper
// Uses Fish Audio REST API with chunked transfer encoding (no SDK needed)

const https = require("https");

/**
 * Synthesize text to PCM audio via Fish Audio REST API.
 * Returns audio chunks via callback (streaming).
 *
 * @param {string} text - Text to synthesize
 * @param {object} options
 * @param {string} options.apiKey - Fish Audio API key
 * @param {string} [options.referenceId] - Voice model ID (null = default voice)
 * @param {number} [options.sampleRate=16000] - Output sample rate
 * @param {string} [options.latency="balanced"] - "normal" | "balanced"
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @param {function} options.onAudio - Callback for audio chunks: (buffer: Buffer) => void
 * @returns {Promise<void>} Resolves when synthesis complete
 */
async function synthesize(text, options = {}) {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY is required for TTS");
  if (!text || !text.trim()) return;

  const sampleRate = options.sampleRate || 16_000;
  const latency = options.latency || "balanced";
  const onAudio = options.onAudio;
  if (!onAudio) throw new Error("onAudio callback is required");

  const requestBody = {
    text: text.trim(),
    format: "pcm",
    sample_rate: sampleRate,
    latency,
    temperature: 0.7,
    top_p: 0.7,
    chunk_length: 300,
    normalize: true,
  };

  if (options.referenceId) {
    requestBody.reference_id = options.referenceId;
  }

  const body = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.fish.audio",
        port: 443,
        path: "/v1/tts",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          model: "s1",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (c) => (errBody += c));
          res.on("end", () => {
            reject(new Error(`Fish Audio API error (${res.statusCode}): ${errBody.slice(0, 300)}`));
          });
          return;
        }

        res.on("data", (chunk) => {
          if (options.signal?.aborted) return;
          // Fish Audio returns raw PCM bytes in chunked transfer
          onAudio(chunk);
        });

        res.on("end", () => resolve());
        res.on("error", reject);
      }
    );

    req.on("error", reject);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(new Error("TTS request aborted"));
      });
    }

    req.setTimeout(30_000, () => {
      req.destroy(new Error("TTS request timeout"));
    });

    req.write(body);
    req.end();
  });
}

module.exports = { synthesize };
