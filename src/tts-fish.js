// tts-fish.js — Fish Audio TTS streaming wrapper
// Uses Fish Audio REST API with chunked transfer encoding (no SDK needed)
//
// Safety guards:
//   - MAX_AUDIO_DURATION_MS: hard cap on total audio output per synthesize() call
//     Prevents Fish Audio hallucination loops (e.g. repeating "ケイケイ" indefinitely)
//   - STALL_TIMEOUT_MS: kills request if no data received for this long
//   - Both are in addition to the HTTP-level 30s connect timeout

const https = require("https");
const { stripCanonicalEmotionTags } = require("./messages");
const { getEffectiveValue } = require("./settings/resolver");

// Max audio duration per sentence: 15 seconds at any sample rate
// (a single sentence should never produce more than this)
const MAX_AUDIO_DURATION_MS = 15_000;

// If no new data arrives for 5 seconds, consider the stream stalled
const STALL_TIMEOUT_MS = 5_000;

// Retry: 429 / 5xx pre-audio failures only. Once a 200 stream starts emitting
// audio, _synthesizeOnce never throws with a statusCode tag, so partial audio
// is never duplicated by retries. Honors Retry-After (numeric seconds), but
// caps it so a bogus value doesn't stall live audio.
function _resolveRetryMax(raw) {
  // Guards against NaN / negative / non-integer env input. A NaN here would
  // make `attempt >= RETRY_MAX` always false → unbounded retry loop.
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.floor(n);
}
const RETRY_MAX = process.env.FISH_AUDIO_RETRY_MAX != null
  ? _resolveRetryMax(process.env.FISH_AUDIO_RETRY_MAX)
  : 2;
const RETRY_BASE_MS = 100;
const RETRY_AFTER_MAX_MS = 1500;

function parseRetryAfter(raw) {
  if (typeof raw !== "string") return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return null;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Fish Audio retry sleep aborted"));
      return;
    }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    function onAbort() {
      cleanup();
      reject(new Error("Fish Audio retry sleep aborted"));
    }
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Synthesize text to PCM audio via Fish Audio REST API.
 * Returns audio chunks via callback (streaming). Retries on 429 / 5xx
 * with exponential backoff (RETRY_MAX attempts, 100ms then 400ms). Retries
 * only fire before any audio bytes have been emitted to onAudio.
 *
 * @param {string} text - Text to synthesize
 * @param {object} options
 * @param {string} options.apiKey - Fish Audio API key
 * @param {string} [options.referenceId] - Voice model ID (null = default voice)
 * @param {number} [options.sampleRate=24000] - Output sample rate
 * @param {string} [options.latency="balanced"] - "normal" | "balanced"
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @param {function} options.onAudio - Callback for audio chunks: (buffer: Buffer) => void
 * @returns {Promise<void>} Resolves when synthesis complete
 */
async function synthesize(text, options = {}) {
  let attempt = 0;
  while (true) {
    try {
      await _synthesizeOnce(text, options);
      return;
    } catch (err) {
      if (options.signal?.aborted) throw err;
      const sc = err.statusCode;
      const retryable = sc === 429 || (sc >= 500 && sc <= 599);
      if (!retryable || attempt >= RETRY_MAX) throw err;
      attempt += 1;
      const exponential = RETRY_BASE_MS * Math.pow(4, attempt - 1); // 100, 400
      const delay = err.retryAfterMs != null
        ? Math.min(err.retryAfterMs, RETRY_AFTER_MAX_MS)
        : exponential;
      console.warn(`⚠️  Fish Audio retry ${attempt}/${RETRY_MAX} in ${delay}ms (status=${sc})`);
      await abortableSleep(delay, options.signal);
    }
  }
}

async function _synthesizeOnce(text, options = {}) {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY is required for TTS");
  const requestText = getEffectiveValue("agent_emotion_tags") === false
    ? stripCanonicalEmotionTags(text)
    : String(text || "").trim();
  if (!requestText) return;

  const sampleRate = options.sampleRate || 24_000;
  const latency = options.latency || "balanced";
  const onAudio = options.onAudio;
  if (!onAudio) throw new Error("onAudio callback is required");

  // Calculate max bytes based on duration limit
  // PCM int16: 2 bytes per sample, mono
  const maxBytes = Math.floor((sampleRate * MAX_AUDIO_DURATION_MS) / 1000) * 2;

  const requestBody = {
    text: requestText,
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

  // Speech-rate control: only forwarded when the caller explicitly sets a
  // valid finite number in [0.5, 2.0]. Older Fish models that don't recognize
  // the field will ignore unknown keys, so this stays safe to send.
  if (Number.isFinite(options.speed) && options.speed > 0) {
    requestBody.speed = Math.min(2.0, Math.max(0.5, options.speed));
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
          // FISH_AUDIO_MODEL env (default "s2-pro") controls which Fish Audio
          // engine handles synthesis. Known values: "s2-pro" (current default,
          // Qwen3-4B backbone, more natural Japanese delivery, chosen 2026-05-04
          // after live A/B vs s1), "s1" (older, fallback for emergency rollback).
          // env is kept as an escape hatch only — change the default below for
          // permanent moves so there is one source of truth.
          model: getEffectiveValue("fish_audio_model"),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (c) => (errBody += c));
          res.on("end", () => {
            const error = new Error(`Fish Audio API error (${res.statusCode}): ${errBody.slice(0, 300)}`);
            error.statusCode = res.statusCode;
            const retryAfterMs = parseRetryAfter(res.headers["retry-after"]);
            if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
            finish(error);
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
                `⚠️  TTS duration cap hit: ${MAX_AUDIO_DURATION_MS}ms (${maxBytes} bytes) for text: "${requestText.slice(0, 60)}…" — truncating`
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
