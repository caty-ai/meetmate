// stt.js — Deepgram STT streaming wrapper
// Uses @deepgram/sdk live transcription (Nova 3)

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { EventEmitter } = require("events");

/**
 * Create a streaming STT instance.
 * @param {string} dgKey - Deepgram API key
 * @param {object} options
 * @param {string} options.model - STT model (default: "nova-3")
 * @param {string} options.language - Language code (default: "ja")
 * @param {number} options.sampleRate - Audio sample rate (default: 16000)
 * @returns {EventEmitter & { send(buf: Buffer): void, close(): void }}
 *
 * Events:
 *   'transcript' (text: string, isFinal: boolean) — interim/final transcripts
 *   'utterance_end' (text: string) — user finished speaking, accumulated text
 *   'error' (err: Error)
 *   'open' ()
 *   'close' ()
 */
function createSTT(dgKey, options = {}) {
  const emitter = new EventEmitter();
  const model = options.model || "nova-3";
  const language = options.language || "ja";
  const sampleRate = options.sampleRate || 16_000;

  const deepgram = createClient(dgKey);

  let accumulated = "";
  let connection = null;

  function start() {
    connection = deepgram.listen.live({
      model,
      language,
      sample_rate: sampleRate,
      encoding: "linear16",
      channels: 1,
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1200,
      endpointing: 400,
      vad_events: true,
    });

    connection.on(LiveTranscriptionEvents.Open, () => {
      console.log("🎤  STT: 接続完了");
      emitter.emit("open");
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data?.channel?.alternatives?.[0];
      if (!alt) return;

      const text = alt.transcript || "";
      if (!text) return;

      const isFinal = data.is_final === true;
      emitter.emit("transcript", text, isFinal);

      if (isFinal) {
        accumulated += text;
      }

      // speech_final = user paused long enough for this to be a complete thought
      if (data.speech_final === true && accumulated.trim()) {
        const utterance = accumulated.trim();
        accumulated = "";
        emitter.emit("utterance_end", utterance);
      }
    });

    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      // Fallback: if speech_final didn't fire but utterance ended
      if (accumulated.trim()) {
        const utterance = accumulated.trim();
        accumulated = "";
        emitter.emit("utterance_end", utterance);
      }
    });

    connection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error("❌  STT error:", err);
      emitter.emit("error", err);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      console.log("🔴  STT: 切断");
      emitter.emit("close");
    });
  }

  // Start immediately
  start();

  // Keep alive
  const keepAlive = setInterval(() => {
    try {
      connection?.keepAlive?.();
    } catch {
      // no-op
    }
  }, 8_000);

  emitter.send = function (audioBuffer) {
    try {
      connection?.send(audioBuffer);
    } catch (err) {
      console.error("❌  STT send error:", err.message);
    }
  };

  emitter.close = function () {
    clearInterval(keepAlive);
    accumulated = "";
    try {
      connection?.requestClose?.();
    } catch {
      // no-op
    }
  };

  return emitter;
}

module.exports = { createSTT };
