// stt-soniox.js — Soniox real-time STT streaming wrapper
// Mirrors the createSTT() interface from stt.js (Deepgram) so the pipeline
// can switch providers without any downstream changes.
//
// Protocol (https://soniox.com/docs/api-reference/stt/websocket-api):
//   1. Open WebSocket to wss://stt-rt.soniox.com/transcribe-websocket
//   2. Send one JSON config frame (api_key, model, audio_format, ...)
//   3. Stream raw PCM (pcm_s16le, 16k, mono) as binary frames
//   4. Receive JSON results: { tokens: [{text, is_final, confidence}], ... }
//      - endpoint detection returns a special final token { text: "<end>" }
//   5. Send an empty frame to finish; server replies { finished: true } and closes.

const WebSocket = require("ws");
const { EventEmitter } = require("events");
const { buildKeyterms } = require("./stt");

const SONIOX_WS_URL =
  process.env.SONIOX_WS_URL || "wss://stt-rt.soniox.com/transcribe-websocket";

/**
 * Create a streaming Soniox STT instance.
 * @param {string} apiKey - Soniox API key (SONIOX_API_KEY)
 * @param {object} options - same shape as stt.js createSTT options
 * @returns {EventEmitter & { send(buf: Buffer): void, close(): void }}
 *
 * Events (identical to the Deepgram wrapper):
 *   'transcript' (text, isFinal, confidence)
 *   'utterance_end' (text)
 *   'error' (err), 'open' (), 'close' ()
 */
function createSonioxSTT(apiKey, options = {}) {
  const emitter = new EventEmitter();
  const model = options.model || process.env.SONIOX_MODEL || "stt-rt-v5";
  const language = options.language || "ja";
  const sampleRate = options.sampleRate || 16_000;

  if (!apiKey) {
    // Defer the error so callers can attach listeners first.
    setImmediate(() =>
      emitter.emit("error", new Error("SONIOX_API_KEY is not set")),
    );
  }

  let accumulated = "";
  let opened = false;
  let closedByUser = false;
  const pending = []; // audio buffered until the socket is open

  const ws = new WebSocket(SONIOX_WS_URL);

  ws.on("open", () => {
    const keyterms = buildKeyterms(options.keyterms || []);

    const config = {
      api_key: apiKey,
      model,
      audio_format: "pcm_s16le",
      sample_rate: sampleRate,
      num_channels: 1,
      language_hints: [language],
      enable_endpoint_detection: true,
    };
    if (keyterms.length > 0) {
      // Soniox "context.terms" is the equivalent of Deepgram keyterms.
      config.context = { terms: keyterms };
    }
    // Optional endpoint tuning (full config-ization is tracked in Step 2 / #51).
    if (process.env.SONIOX_ENDPOINT_SENSITIVITY) {
      config.endpoint_sensitivity = Number(process.env.SONIOX_ENDPOINT_SENSITIVITY);
    }
    if (process.env.SONIOX_MAX_ENDPOINT_DELAY_MS) {
      config.max_endpoint_delay_ms = Number(process.env.SONIOX_MAX_ENDPOINT_DELAY_MS);
    }
    if (process.env.SONIOX_ENDPOINT_LATENCY_LEVEL) {
      config.endpoint_latency_adjustment_level = Number(
        process.env.SONIOX_ENDPOINT_LATENCY_LEVEL,
      );
    }

    try {
      ws.send(JSON.stringify(config));
    } catch (err) {
      emitter.emit("error", err);
      return;
    }

    opened = true;
    const label = keyterms.length
      ? `(context terms: ${keyterms.slice(0, 3).join(", ")}...)`
      : "(no context terms)";
    console.log(`🎤  STT(Soniox ${model}): 接続完了 ${label}`);
    emitter.emit("open");

    // Flush any audio that arrived before the socket opened.
    while (pending.length) {
      try {
        ws.send(pending.shift());
      } catch (err) {
        console.error("❌  STT(Soniox) flush error:", err.message);
        break;
      }
    }
  });

  ws.on("message", (raw) => {
    let res;
    try {
      res = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON frames
    }

    if (res.error_code) {
      emitter.emit(
        "error",
        new Error(
          `Soniox ${res.error_code} ${res.error_type || ""}: ${res.error_message || "unknown"}`,
        ),
      );
      return;
    }

    const tokens = Array.isArray(res.tokens) ? res.tokens : [];
    let newFinal = "";
    let interim = "";
    let endpoint = false;
    let confidence = null;

    for (const t of tokens) {
      if (!t) continue;
      if (t.text === "<end>") {
        endpoint = true;
        continue;
      }
      if (typeof t.confidence === "number") confidence = t.confidence;
      if (t.is_final) newFinal += t.text || "";
      else interim += t.text || "";
    }

    if (newFinal) {
      accumulated += newFinal;
      emitter.emit("transcript", newFinal, true, confidence);
    }
    if (interim) {
      emitter.emit("transcript", interim, false, confidence);
    }

    // <end> = semantic endpoint → user finished speaking.
    if (endpoint && accumulated.trim()) {
      const utterance = accumulated.trim();
      accumulated = "";
      emitter.emit("utterance_end", utterance);
    }

    if (res.finished === true) {
      // Flush any trailing text not yet closed by an endpoint.
      if (accumulated.trim()) {
        const utterance = accumulated.trim();
        accumulated = "";
        emitter.emit("utterance_end", utterance);
      }
    }
  });

  ws.on("error", (err) => {
    console.error("❌  STT(Soniox) error:", err?.message || err);
    emitter.emit("error", err);
  });

  ws.on("close", () => {
    console.log("🔴  STT(Soniox): 切断");
    emitter.emit("close");
  });

  emitter.send = function (audioBuffer) {
    if (closedByUser) return;
    if (!opened || ws.readyState !== WebSocket.OPEN) {
      pending.push(audioBuffer);
      return;
    }
    try {
      ws.send(audioBuffer);
    } catch (err) {
      console.error("❌  STT(Soniox) send error:", err.message);
    }
  };

  emitter.close = function () {
    closedByUser = true;
    accumulated = "";
    pending.length = 0;
    try {
      // Empty frame = graceful finish; server flushes then closes.
      if (ws.readyState === WebSocket.OPEN) ws.send("");
    } catch {
      // no-op
    }
    try {
      ws.close();
    } catch {
      // no-op
    }
  };

  return emitter;
}

module.exports = { createSonioxSTT };
