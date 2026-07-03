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

const { EventEmitter } = require("events");

const DEFAULT_SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const STT_ACCUMULATED_MAX_CHARS = Number(process.env.STT_ACCUMULATED_MAX_CHARS || 120);
const DEFAULT_SONIOX_KEEPALIVE_INTERVAL_MS = 8_000;
const DEFAULT_SONIOX_PENDING_MAX = 200;
const DEFAULT_SONIOX_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_SONIOX_RECONNECT_MAX_DELAY_MS = 10_000;

// Read an optional numeric setting: prefer the explicit option, fall back to
// the env var, return null when neither is set (so we omit it from config).
function numOpt(optVal, envVal) {
  if (optVal !== undefined && optVal !== null) return Number(optVal);
  if (envVal !== undefined && envVal !== "") return Number(envVal);
  return null;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

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
  const wsUrl = options.wsUrl || process.env.SONIOX_WS_URL || DEFAULT_SONIOX_WS_URL;
  // Test-only injection points keep the wrapper hermetic without changing production defaults.
  const WebSocketCtor = options._wsCtor || require("ws");
  const keepAliveIntervalMs = positiveInt(
    process.env.SONIOX_KEEPALIVE_INTERVAL_MS,
    DEFAULT_SONIOX_KEEPALIVE_INTERVAL_MS,
  );
  const pendingMax = positiveInt(
    process.env.SONIOX_PENDING_MAX,
    DEFAULT_SONIOX_PENDING_MAX,
  );
  const reconnectBaseDelayMs = positiveInt(
    options._reconnectBaseDelayMs,
    DEFAULT_SONIOX_RECONNECT_BASE_DELAY_MS,
  );

  const endpointSensitivity = numOpt(
    options.endpointSensitivity,
    process.env.SONIOX_ENDPOINT_SENSITIVITY,
  );
  const maxEndpointDelayMs = numOpt(
    options.maxEndpointDelayMs,
    process.env.SONIOX_MAX_ENDPOINT_DELAY_MS,
  );
  const endpointLatencyLevel = numOpt(
    options.endpointLatencyLevel,
    process.env.SONIOX_ENDPOINT_LATENCY_LEVEL,
  );

  if (!apiKey) {
    // Defer the error so callers can attach listeners first.
    setImmediate(() =>
      emitter.emit("error", new Error("SONIOX_API_KEY is not set")),
    );
  }

  let accumulated = "";
  let opened = false;
  let closedByUser = false;
  let ws = null;
  let keepAlive = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let pendingDropCount = 0;
  let finalCloseEmitted = false;
  const pending = []; // audio buffered until the socket is open

  const buildKeyterms = options._buildKeyterms || require("./stt").buildKeyterms;
  const keyterms = buildKeyterms(options.keyterms || []);

  function buildConfig() {
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
    // Optional endpoint tuning (resolved from config.js / env in #51).
    if (endpointSensitivity !== null) {
      config.endpoint_sensitivity = endpointSensitivity;
    }
    if (maxEndpointDelayMs !== null) {
      config.max_endpoint_delay_ms = maxEndpointDelayMs;
    }
    if (endpointLatencyLevel !== null) {
      config.endpoint_latency_adjustment_level = endpointLatencyLevel;
    }
    return config;
  }

  function clearKeepAlive() {
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function startKeepAlive(socket) {
    clearKeepAlive();
    keepAlive = setInterval(() => {
      if (closedByUser) {
        clearKeepAlive();
        return;
      }
      if (socket !== ws || socket.readyState !== WebSocketCtor.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "keepalive" }));
      } catch {
        // The close/error handlers own recovery and error reporting.
      }
    }, keepAliveIntervalMs);
  }

  function flushPending(socket) {
    while (pending.length) {
      try {
        socket.send(pending.shift());
      } catch (err) {
        console.error("❌  STT(Soniox) flush error:", err.message);
        break;
      }
    }
    if (pending.length === 0) pendingDropCount = 0;
  }

  function flushAccumulatedBeforeReconnect() {
    if (!accumulated.trim()) {
      accumulated = "";
      return;
    }
    const utterance = accumulated.trim();
    accumulated = "";
    emitter.emit("utterance_end", utterance);
  }

  function scheduleReconnect() {
    if (closedByUser) return;
    reconnectAttempt += 1;
    const attempt = reconnectAttempt;
    const delay = Math.min(
      reconnectBaseDelayMs * (2 ** (attempt - 1)),
      DEFAULT_SONIOX_RECONNECT_MAX_DELAY_MS,
    );
    console.log(`🔁  STT(Soniox): 予期しない切断 — 再接続します (attempt ${attempt})`);
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleMessage(raw) {
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
      return false;
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
      if (accumulated.length >= STT_ACCUMULATED_MAX_CHARS && accumulated.trim()) {
        const utterance = accumulated.trim();
        accumulated = "";
        console.log(`✂️  STT accumulated cap reached (${STT_ACCUMULATED_MAX_CHARS} chars), forcing utterance_end`);
        emitter.emit("utterance_end", utterance);
      }
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
  }

  function connect() {
    if (closedByUser) return;
    opened = false;
    const socket = new WebSocketCtor(wsUrl);
    ws = socket;

    socket.on("open", () => {
      if (closedByUser || socket !== ws) return;
      try {
        socket.send(JSON.stringify(buildConfig()));
      } catch (err) {
        emitter.emit("error", err);
        return;
      }

      opened = true;
      startKeepAlive(socket);
      const label = keyterms.length
        ? `(context terms: ${keyterms.slice(0, 3).join(", ")}...)`
        : "(no context terms)";
      console.log(`🎤  STT(Soniox ${model}): 接続完了 ${label}`);
      emitter.emit("open");

      // Flush any audio that arrived before the socket opened.
      flushPending(socket);
    });

    socket.on("message", (raw) => {
      if (socket !== ws) return;
      // Reset the reconnect backoff only on healthy frames: an error_code frame
      // followed by a server close must keep escalating the delay, otherwise a
      // persistent rejection (e.g. bad API key) becomes a fast reconnect storm.
      const healthy = handleMessage(raw);
      if (healthy !== false && reconnectAttempt !== 0) reconnectAttempt = 0;
    });

    socket.on("error", (err) => {
      if (socket !== ws) return;
      clearKeepAlive();
      console.error("❌  STT(Soniox) error:", err?.message || err);
      emitter.emit("error", err);
    });

    socket.on("close", () => {
      if (socket !== ws) return;
      clearKeepAlive();
      opened = false;

      if (closedByUser) {
        console.log("🔴  STT(Soniox): 切断");
        if (!finalCloseEmitted) {
          finalCloseEmitted = true;
          emitter.emit("close");
        }
        return;
      }

      flushAccumulatedBeforeReconnect();
      scheduleReconnect();
    });
  }

  connect();

  function bufferAudio(audioBuffer) {
    if (pending.length >= pendingMax) {
      pending.shift();
      pendingDropCount += 1;
      if (pendingDropCount % 100 === 0) {
        console.warn(`⚠️  STT(Soniox): reconnect buffer overflow, dropped ${pendingDropCount} chunks`);
      }
    }
    pending.push(audioBuffer);
  }

  emitter.send = function (audioBuffer) {
    if (closedByUser) return;
    if (!opened || !ws || ws.readyState !== WebSocketCtor.OPEN) {
      bufferAudio(audioBuffer);
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
    clearKeepAlive();
    clearReconnectTimer();
    accumulated = "";
    pending.length = 0;
    try {
      // Empty frame = graceful finish; server flushes then closes.
      if (ws?.readyState === WebSocketCtor.OPEN) ws.send("");
    } catch {
      // no-op
    }
    try {
      ws?.close();
    } catch {
      // no-op
    }
  };

  return emitter;
}

module.exports = { createSonioxSTT };
