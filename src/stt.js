// stt.js — Deepgram STT streaming wrapper
// Uses @deepgram/sdk live transcription (Nova 3)

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { EventEmitter } = require("events");

/**
 * Build keyterm prompts for Nova-3.
 * Nova-3 uses `keyterm` (not `keywords`). No intensifier needed — just the term.
 * See: https://developers.deepgram.com/docs/keyterm
 */
function buildKeyterms(extraKeyterms = []) {
  const enabled = String(process.env.STT_ENABLE_KEYWORDS || "true").toLowerCase() !== "false";
  if (!enabled) return [];

  const baseTerms = (process.env.WAKE_WORDS || "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);

  const extraTerms = [];

  const dynamicTerms = Array.isArray(extraKeyterms)
    ? extraKeyterms.map((w) => String(w || "").trim()).filter(Boolean)
    : [];

  return [...new Set([...baseTerms, ...extraTerms, ...dynamicTerms])];
}

// Legacy: build keywords for Nova-2 fallback (with intensifier)
function buildWakeKeywords(keyterms = []) {
  return keyterms.map((w) => `${w}:5`);
}

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
 *   'transcript' (text: string, isFinal: boolean, confidence: number|null) — interim/final transcripts
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
  let opened = false;
  let closedByUser = false;
  let retriedWithoutKeywords = false;

  function connect({ withKeywords = true } = {}) {
    if (closedByUser) return;

    const baseOptions = {
      model,
      language,
      sample_rate: sampleRate,
      encoding: "linear16",
      channels: 1,
      smart_format: true,
      interim_results: true,
      utterance_end_ms: Number(options.utteranceEndMs || process.env.LISTEN_UTTERANCE_END_MS || 1800),
      endpointing: Number(options.endpointingMs || process.env.LISTEN_ENDPOINTING_MS || 700),
      vad_events: true,
    };

    const keyterms = buildKeyterms(options.keyterms || []);
    const wakeKeywords = buildWakeKeywords(keyterms);
    const isNova3 = model.includes("nova-3");

    // Nova-3: use `keyterm` parameter; Nova-2/earlier: use `keywords` parameter
    let keytermConfig = {};
    let keytermLabel = "(no keyterms)";
    if (withKeywords && keyterms.length > 0) {
      if (isNova3) {
        keytermConfig = { keyterm: keyterms };
        keytermLabel = `(keyterm: ${keyterms.slice(0, 3).join(", ")}...)`;
      } else if (wakeKeywords.length > 0) {
        keytermConfig = { keywords: wakeKeywords };
        keytermLabel = `(keywords: ${wakeKeywords.slice(0, 3).join(", ")}...)`;
      }
    }

    connection = deepgram.listen.live({
      ...baseOptions,
      ...keytermConfig,
    });

    connection.on(LiveTranscriptionEvents.Open, () => {
      opened = true;
      console.log(`🎤  STT: 接続完了 ${keytermLabel}`);
      emitter.emit("open");
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data?.channel?.alternatives?.[0];
      if (!alt) return;

      const text = alt.transcript || "";
      if (!text) return;

      const isFinal = data.is_final === true;
      const confidence = Number.isFinite(alt.confidence) ? alt.confidence : null;
      emitter.emit("transcript", text, isFinal, confidence);

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
      // Recovery path: if handshake fails before open with keywords,
      // retry once without keywords (some DG setups reject keywords param).
      const hasKeyterms = Object.keys(keytermConfig).length > 0;
      const errMsg = String(err?.message || "");
      const canFallback =
        hasKeyterms &&
        !opened &&
        !retriedWithoutKeywords &&
        /non-101|ready\s*state|readystate|error|failed/i.test(errMsg);

      if (canFallback) {
        retriedWithoutKeywords = true;
        console.warn("⚠️  STT keyword handshake failed. Retrying without keywords...");
        try {
          connection?.requestClose?.();
        } catch {
          // no-op
        }
        setTimeout(() => connect({ withKeywords: false }), 150);
        return;
      }

      console.error("❌  STT error:", err);
      emitter.emit("error", err);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      console.log("🔴  STT: 切断");
      emitter.emit("close");
    });
  }

  // Start immediately
  connect({ withKeywords: true });

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
    closedByUser = true;
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

module.exports = { createSTT, buildKeyterms };
