// tts-fish.js — Fish Audio TTS streaming wrapper
// Uses Fish Audio REST API with chunked transfer encoding (no SDK needed)
//
// Safety guards:
//   - MAX_AUDIO_DURATION_MS: hard cap on total audio output per synthesize() call
//     Prevents Fish Audio hallucination loops (e.g. repeating "ケイケイ" indefinitely)
//   - STALL_TIMEOUT_MS: kills request if no data received for this long
//   - Both are in addition to the HTTP-level 30s connect timeout

const https = require("https");

// Max audio duration per sentence: 15 seconds at any sample rate
// (a single sentence should never produce more than this)
const MAX_AUDIO_DURATION_MS = 15_000;

// If no new data arrives for 5 seconds, consider the stream stalled
const STALL_TIMEOUT_MS = 5_000;

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

  // Calculate max bytes based on duration limit
  // PCM int16: 2 bytes per sample, mono
  const maxBytes = Math.floor((sampleRate * MAX_AUDIO_DURATION_MS) / 1000) * 2;

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
    let totalBytesReceived = 0;
    let stallTimer = null;
    let resolved = false;

    function cleanup() {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    }

    function finish(err) {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    }

    function resetStallTimer(req) {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.warn(`⚠️  TTS stall detected: no data for ${STALL_TIMEOUT_MS}ms, aborting (received ${totalBytesReceived} bytes)`);
        req.destroy(new Error("TTS stream stalled"));
      }, STALL_TIMEOUT_MS);
    }

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
            finish(new Error(`Fish Audio API error (${res.statusCode}): ${errBody.slice(0, 300)}`));
          });
          return;
        }

        // PCM int16 alignment buffer: ensure we only emit even-byte chunks
        // Fish Audio can return odd-byte chunks which misalign 16-bit samples
        let leftover = null;

        // Start stall timer on first response
        resetStallTimer(req);

        res.on("data", (chunk) => {
          if (options.signal?.aborted || resolved) return;

          // Reset stall timer on each chunk
          resetStallTimer(req);

          let data = chunk;
          // Prepend leftover byte from previous chunk
          if (leftover) {
            data = Buffer.concat([leftover, chunk]);
            leftover = null;
          }

          // If odd length, hold the last byte for next chunk
          if (data.length % 2 !== 0) {
            leftover = data.subarray(data.length - 1);
            data = data.subarray(0, data.length - 1);
          }

          if (data.length > 0) {
            // Check duration cap BEFORE sending audio
            if (totalBytesReceived + data.length > maxBytes) {
              // Trim to max and stop
              const remaining = maxBytes - totalBytesReceived;
              if (remaining > 0) {
                // Ensure even alignment
                const trimmed = remaining - (remaining % 2);
                if (trimmed > 0) {
                  onAudio(data.subarray(0, trimmed));
                }
              }
              totalBytesReceived = maxBytes;
              console.warn(
                `⚠️  TTS duration cap hit: ${MAX_AUDIO_DURATION_MS}ms (${maxBytes} bytes) for text: "${text.slice(0, 60)}…" — truncating`
              );
              // Destroy request to stop receiving more data
              res.destroy();
              finish();
              return;
            }

            totalBytesReceived += data.length;
            onAudio(data);
          }
        });

        res.on("end", () => {
          // Flush any leftover byte (pad with zero)
          if (leftover && leftover.length > 0 && totalBytesReceived < maxBytes) {
            const padded = Buffer.alloc(2);
            leftover.copy(padded);
            onAudio(padded);
          }
          finish();
        });

        res.on("error", (err) => finish(err));
      }
    );

    req.on("error", (err) => finish(err));

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        cleanup();
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
