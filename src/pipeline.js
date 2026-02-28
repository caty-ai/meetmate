// pipeline.js — Orchestrates STT → LLM → TTS pipeline
// Replaces Deepgram Voice Agent (all-in-one) with decomposed components

const { createSTT } = require("./stt");
const { streamChat } = require("./llm");
const { synthesize } = require("./tts-fish");

// Sentence splitter for Japanese + English
// Splits on: 。！？!?\n and also on 、when the segment is long enough
const SENTENCE_RE = /[。！？!?\n]+/;
const MIN_SENTENCE_LEN = 8;

// Inter-sentence pause: insert silence between sentences for natural rhythm
const SENTENCE_PAUSE_MS = Number(process.env.SENTENCE_PAUSE_MS || 500);

// Wake word detection: only respond when addressed
// Modes: "off" (respond to everything), "wake" (require wake word), "context" (LLM decides)
const WAKE_MODE = process.env.WAKE_MODE || "off";
const WAKE_WORDS = (process.env.WAKE_WORDS || "ケイティ,けいてぃ,caty,katie,ケイケイ").toLowerCase().split(",").map(w => w.trim());

// Exit commands (for Meet sessions — triggers bot exit)
const EXIT_COMMANDS = [
  "退出して", "退出していいよ", "今日はここまで",
  "もういいよ", "終わりにして", "退出", "終了して",
  "ありがとう退出", "おつかれ退出",
];

// Extended wake word variants to handle STT transcription inaccuracies
// Deepgram may output: けいてい, ケーティー, ケイティー, キーティ, テイティー, けーてぃ, etc.
const EXTENDED_WAKE_VARIANTS = [
  "けいてい", "けーてぃ", "けーてい", "けいてぃー", "けいていー",
  "キーティ", "ケーティ", "ケーティー", "ケイティー", "テイティー",
  "keity", "katy", "kaity", "keithi", "keiti",
];

/**
 * Normalize katakana: strip long vowel marks (ー) and normalize common variations.
 */
function normalizeKana(text) {
  return text
    .replace(/ー/g, "")        // Remove long vowel marks
    .replace(/ッ/g, "")        // Remove small tsu
    .replace(/っ/g, "")        // Remove small tsu (hiragana)
    .replace(/\s+/g, "");      // Remove spaces
}

/**
 * Check if utterance is an exit command.
 * Only active in Meet sessions (not Twilio calls).
 */
function isExitCommand(text) {
  const lower = text.toLowerCase().trim();
  const normalized = normalizeKana(lower);

  // Check exit commands
  for (const cmd of EXIT_COMMANDS) {
    const cmdNorm = normalizeKana(cmd.toLowerCase());
    if (normalized.includes(cmdNorm) || lower.includes(cmd)) {
      return true;
    }
  }

  // Also check wake word + exit pattern: "ケイティ、退出して"
  if (containsWakeWord(text)) {
    for (const cmd of EXIT_COMMANDS) {
      if (lower.includes(cmd.toLowerCase())) return true;
    }
  }

  return false;
}

/**
 * Check if utterance contains a wake word.
 * Uses both exact matching and fuzzy katakana-normalized matching.
 */
function containsWakeWord(text) {
  const lower = text.toLowerCase();
  const normalized = normalizeKana(lower);

  // Exact substring match against configured wake words
  if (WAKE_WORDS.some(w => lower.includes(w))) return true;

  // Extended variants match
  if (EXTENDED_WAKE_VARIANTS.some(v => lower.includes(v))) return true;

  // Normalized match (strips ー and ッ from both sides)
  const normalizedWake = WAKE_WORDS.map(w => normalizeKana(w));
  if (normalizedWake.some(w => normalized.includes(w))) return true;

  return false;
}

/**
 * Generate a Buffer of PCM silence (16-bit LE zeros) for a given duration.
 */
function generateSilence(durationMs, sampleRate) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2); // 2 bytes per int16 sample
}

function splitSentences(text) {
  const parts = text.split(SENTENCE_RE).filter((s) => s.trim().length > 0);
  return parts.map((s) => s.trim());
}

/**
 * Create the decomposed voice pipeline.
 *
 * @param {object} session - Meeting session object
 * @param {object} turnState - Shared turn state { isAgentSpeaking, inputCooldownUntil, droppedEchoFrames }
 * @param {function} onAudio - Callback: (buffer: Buffer) => void (sends audio to Attendee)
 * @param {object} config - Pipeline config from getPipelineConfig()
 * @returns {{ sendAudio(buf: Buffer): void, close(): void }}
 */
function createPipeline(session, turnState, onAudio, config) {
  const { EventEmitter } = require("events");
  const emitter = new EventEmitter();

  const dgKey = config.dgKey;
  const openrouterKey = config.openrouterKey;
  const fishKey = config.fishKey;
  const systemPrompt = config.systemPrompt;
  const wakeMode = config.wakeMode || WAKE_MODE;

  // OpenClaw Gateway integration
  const useOpenClaw = !!(config.openclawUrl && config.openclawToken);
  if (useOpenClaw) {
    console.log("🔗  OpenClaw Gateway モード: フルCaty体験 ✨");
  } else {
    console.log("📡  OpenRouter モード: 直接Claude API");
  }

  // Conversation history (for OpenRouter fallback; OpenClaw manages its own)
  const MAX_HISTORY = 20;
  const history = []; // {role: "user"|"assistant", content: string}

  // Current LLM/TTS abort controller (for interruption)
  let currentAbort = null;
  let isProcessing = false;

  // ── STT ──────────────────────────────────────────────────────────
  const stt = createSTT(dgKey, {
    model: config.stt.model,
    language: config.stt.language,
    sampleRate: config.stt.sampleRate,
  });

  stt.on("transcript", (text, isFinal) => {
    if (isFinal) {
      console.log(`🎤  [interim→final] ${text}`);
    }
  });

  stt.on("utterance_end", async (userText) => {
    console.log(`💬  [user] ${userText}`);

    // Exit command detection (Meet sessions only, not Twilio)
    if (config.exitDetection !== false && isExitCommand(userText)) {
      console.log("🚪  Exit command detected!");
      session.conversationLog.push({
        timestamp: new Date().toISOString(),
        role: "user",
        content: userText,
      });

      // Speak farewell and emit exit event
      turnState.isAgentSpeaking = true;
      try {
        await speakSentence("(happy) 了解です！退出しますね。お疲れさまでした！", null);
      } catch {
        // ignore TTS error during exit
      }
      turnState.isAgentSpeaking = false;

      session.conversationLog.push({
        timestamp: new Date().toISOString(),
        role: "assistant",
        content: "了解です！退出しますね。お疲れさまでした！",
      });

      emitter.emit("exit_requested", { sessionId: session.id, trigger: "voice_command", text: userText });
      return;
    }

    // Wake word detection
    if (wakeMode === "wake") {
      if (!containsWakeWord(userText)) {
        console.log(`🔇  Wake word not detected, ignoring: "${userText.slice(0, 50)}..."`);
        // Still log for context, but don't respond
        session.conversationLog.push({
          timestamp: new Date().toISOString(),
          role: "user",
          content: `[会議音声・未指名] ${userText}`,
        });
        return;
      }
      console.log("🔔  Wake word detected!");
    }

    // Log to session
    session.conversationLog.push({
      timestamp: new Date().toISOString(),
      role: "user",
      content: userText,
    });

    // If agent is currently speaking/processing, interrupt
    if (isProcessing && currentAbort) {
      console.log("⚡  User interrupted — aborting current response");
      currentAbort.abort();
      currentAbort = null;
      isProcessing = false;
      turnState.isAgentSpeaking = false;
    }

    // Process user input
    await processUserInput(userText);
  });

  stt.on("error", (err) => {
    console.error("❌  STT error:", err.message || err);
  });

  // ── Process user input: LLM → TTS ──────────────────────────────
  async function processUserInput(userText) {
    isProcessing = true;
    const abort = new AbortController();
    currentAbort = abort;

    // Add to history (used by OpenRouter fallback; OpenClaw manages its own)
    history.push({ role: "user", content: userText });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    try {
      // ── LLM streaming ──
      let fullResponse = "";
      let sentenceBuffer = "";
      const sentencesToSpeak = [];

      console.log("🤔  Caty thinking…");

      // Build LLM options based on mode
      const llmMessages = useOpenClaw
        ? [{ role: "user", content: userText }] // OpenClaw manages history
        : history; // OpenRouter needs full history

      for await (const chunk of streamChat(
        useOpenClaw ? null : systemPrompt,
        llmMessages,
        {
          // OpenClaw Gateway
          openclawUrl: config.openclawUrl,
          openclawToken: config.openclawToken,
          sessionUser: `meet-${session.id}`,
          // OpenRouter fallback
          apiKey: openrouterKey,
          // Shared
          model: config.llm.model,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          signal: abort.signal,
        }
      )) {
        if (abort.signal.aborted) break;

        fullResponse += chunk;
        sentenceBuffer += chunk;

        // Check for complete sentences
        const match = sentenceBuffer.match(SENTENCE_RE);
        if (match) {
          const idx = sentenceBuffer.search(SENTENCE_RE);
          const punctuation = match[0];
          const sentence = sentenceBuffer.slice(0, idx + punctuation.length).trim();
          sentenceBuffer = sentenceBuffer.slice(idx + punctuation.length);

          if (sentence.length >= MIN_SENTENCE_LEN) {
            sentencesToSpeak.push(sentence);

            // Insert pause between sentences (not before the first one)
            if (sentencesToSpeak.length > 1 && SENTENCE_PAUSE_MS > 0) {
              const silence = generateSilence(SENTENCE_PAUSE_MS, config.stt.sampleRate);
              onAudio(silence);
            }

            // Start TTS for this sentence immediately (first one triggers speaking state)
            if (sentencesToSpeak.length === 1) {
              turnState.isAgentSpeaking = true;
              console.log(`🗣️  Caty speaking: "${sentence}"`);
            } else {
              console.log(`🗣️  Caty continue: "${sentence}"`);
            }

            await speakSentence(sentence, abort.signal);
            if (abort.signal.aborted) break;
          }
        }
      }

      if (abort.signal.aborted) {
        console.log("⚡  Response aborted");
        return;
      }

      // Flush remaining text
      if (sentenceBuffer.trim() && sentenceBuffer.trim().length >= 3) {
        if (!turnState.isAgentSpeaking) {
          turnState.isAgentSpeaking = true;
        }
        console.log(`🗣️  Caty speaking (flush): "${sentenceBuffer.trim()}"`);
        await speakSentence(sentenceBuffer.trim(), abort.signal);
      }

      // Log assistant response
      if (fullResponse.trim()) {
        console.log(`💬  [assistant] ${fullResponse.trim()}`);
        session.conversationLog.push({
          timestamp: new Date().toISOString(),
          role: "assistant",
          content: fullResponse.trim(),
        });
        history.push({ role: "assistant", content: fullResponse.trim() });
        if (history.length > MAX_HISTORY) {
          history.splice(0, history.length - MAX_HISTORY);
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error("❌  Pipeline error:", err.message);

      // Speak error message
      try {
        turnState.isAgentSpeaking = true;
        await speakSentence("すみません、ちょっとエラーが起きちゃいました。", abort.signal);
      } catch {
        // give up
      }
    } finally {
      turnState.isAgentSpeaking = false;
      turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);
      isProcessing = false;
      currentAbort = null;
    }
  }

  // ── TTS: synthesize one sentence ────────────────────────────────
  async function speakSentence(text, signal) {
    try {
      await synthesize(text, {
        apiKey: fishKey,
        referenceId: config.tts.referenceId || null,
        sampleRate: config.tts.sampleRate,
        latency: config.tts.latency,
        signal,
        onAudio: (chunk) => {
          if (signal?.aborted) return;
          onAudio(chunk);
        },
      });
    } catch (err) {
      if (signal?.aborted) return;
      console.error("❌  TTS error:", err.message);
    }
  }

  // ── Greeting ────────────────────────────────────────────────────
  async function sendGreeting() {
    const greeting = config.greeting;
    if (!greeting) return;

    console.log(`💬  [assistant] ${greeting}`);
    session.conversationLog.push({
      timestamp: new Date().toISOString(),
      role: "assistant",
      content: greeting,
    });
    history.push({ role: "assistant", content: greeting });

    turnState.isAgentSpeaking = true;
    try {
      await speakSentence(greeting, null);
    } catch (err) {
      console.error("❌  Greeting TTS error:", err.message);
    }
    turnState.isAgentSpeaking = false;
    turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);
  }

  // Send greeting after a short delay (give STT time to connect)
  setTimeout(() => sendGreeting(), 2000);

  // ── Public API ──────────────────────────────────────────────────
  return {
    sendAudio(buffer) {
      stt.send(buffer);
    },
    close() {
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
      stt.close();
    },
    /** EventEmitter for exit_requested and other pipeline events. */
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  };
}

module.exports = { createPipeline };
