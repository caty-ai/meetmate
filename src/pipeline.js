// pipeline.js — Orchestrates STT → LLM → TTS pipeline
// Replaces Deepgram Voice Agent (all-in-one) with decomposed components

const http = require("http");
const https = require("https");
const { createSTT } = require("./stt");
const { streamChat } = require("./llm");
const { synthesize } = require("./tts-fish");

// Sentence splitter for Japanese + English
// Splits on: 。！？!?\n and also on 、when the segment is long enough
const SENTENCE_RE = /[。！？!?\n]+/;
const MIN_SENTENCE_LEN = 8;
const FIRST_CHUNK_MIN_CHARS = Number(process.env.FIRST_CHUNK_MIN_CHARS || 12);

// Inter-sentence pause: insert silence between sentences for natural rhythm
const SENTENCE_PAUSE_MS = Number(process.env.SENTENCE_PAUSE_MS || 500);

// UX controls
const POST_UTTERANCE_BUFFER_MS = Number(process.env.POST_UTTERANCE_BUFFER_MS || 500);
const PROGRESS_PING_INTERVAL_MS = Number(process.env.PROGRESS_PING_INTERVAL_MS || 10_000);
const PROGRESS_PING_MAX = Number(process.env.PROGRESS_PING_MAX || 3);
const BARGE_IN_MIN_CHARS = Number(process.env.BARGE_IN_MIN_CHARS || 2);
const BARGE_IN_CONFIDENCE_MIN = Number(process.env.BARGE_IN_CONFIDENCE_MIN || 0.45);
const ENABLE_BARGE_IN = String(process.env.ENABLE_BARGE_IN || "true").toLowerCase() !== "false";
const ENABLE_IMMEDIATE_ACK = String(process.env.ENABLE_IMMEDIATE_ACK || "true").toLowerCase() !== "false";
const ENABLE_PROGRESS_GUARD = String(process.env.ENABLE_PROGRESS_GUARD || "true").toLowerCase() !== "false";

// Wake word detection: only respond when addressed
// Modes: "off" (respond to everything), "wake" (require wake word), "context" (LLM decides)
const WAKE_MODE = process.env.WAKE_MODE || "off";
// In single-agent mode, use the agent's wakeWords as default; otherwise fall back to Caty's
const _defaultWakeWords = (() => {
  if (process.env.WAKE_WORDS) return process.env.WAKE_WORDS;
  if (process.env.AGENT_ID) {
    try {
      const { loadAgents } = require("./config");
      const agents = loadAgents();
      const agent = agents[process.env.AGENT_ID];
      if (agent?.wakeWords?.length) return agent.wakeWords.join(",");
    } catch { /* fall through */ }
  }
  return "ケイティ,けいてぃ,caty,katie,ケイケイ";
})();
const WAKE_WORDS = _defaultWakeWords.toLowerCase().split(",").map(w => w.trim());

// Exit commands (for Meet sessions — triggers bot exit)
const EXIT_COMMANDS = [
  "退出して", "退出していいよ", "今日はここまで",
  "もういいよ", "終わりにして", "退出", "終了して",
  "ありがとう退出", "おつかれ退出",
];

// Extended wake word variants to handle STT transcription inaccuracies
// Deepgram may output: けいてい, ケーティー, ケイティー, キーティ, テイティー, けーてぃ, etc.
const EXTENDED_WAKE_VARIANTS = [
  // Hiragana variants
  "けいてい", "けーてぃ", "けーてい", "けいてぃー", "けいていー",
  "せいてぃ", "せいてい", "せーてぃ",
  // Katakana variants
  "キーティ", "ケーティ", "ケーティー", "ケイティー", "テイティー",
  "セイティ", "セーティ", "エイティ", "エイティー",
  "キャティ", "キャティー", "ケィティ",
  "ティーティー",
  // Romaji / English STT output
  "keity", "katy", "kaity", "keithi", "keiti",
  "kt", "k.t.", "katy", "katey", "catey",
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
function isExitCommand(text, agents = null, selectedAgentIds = [], defaultAgentId = null) {
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
  if (detectWakeAgent(text, agents, selectedAgentIds, defaultAgentId).detected) {
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
function detectWakeAgent(text, agents = null, selectedAgentIds = [], defaultAgentId = null) {
  const lower = text.toLowerCase();
  const normalized = normalizeKana(lower);

  const ids = Array.isArray(selectedAgentIds) ? selectedAgentIds : [];
  const defaultId = defaultAgentId || ids[0] || null;

  if (agents && ids.length > 0) {
    for (const agentId of ids) {
      const words = (agents[agentId]?.wakeWords || []).map((w) => String(w || "").toLowerCase().trim()).filter(Boolean);
      if (words.some((w) => lower.includes(w))) return { detected: true, agentId };
      const normalizedWords = words.map((w) => normalizeKana(w));
      if (normalizedWords.some((w) => normalized.includes(w))) return { detected: true, agentId };
    }
  }

  if (WAKE_WORDS.some((w) => lower.includes(w))) {
    return { detected: true, agentId: defaultId };
  }
  if (EXTENDED_WAKE_VARIANTS.some((v) => lower.includes(v))) {
    return { detected: true, agentId: defaultId };
  }
  const normalizedWake = WAKE_WORDS.map((w) => normalizeKana(w));
  if (normalizedWake.some((w) => normalized.includes(w))) {
    return { detected: true, agentId: defaultId };
  }

  return { detected: false, agentId: null };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAlphaNumericRatio(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return 0;

  const meaningfulChars = compact.match(/[A-Za-z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/g) || [];
  return meaningfulChars.length / compact.length;
}

function isNoiseInterim(text) {
  const compact = String(text || "").trim().replace(/\s+/g, "");
  if (!compact) return true;
  if (/^[A-Za-z]{1,4}$/.test(compact)) return true;
  if (/^[0-9０-９]+$/.test(compact)) return true;
  if (getAlphaNumericRatio(compact) < 0.5) return true;
  return false;
}

const IMMEDIATE_ACK_PATTERNS = [
  /お願い|やって|して|調べ|確認|探し|実装|作業|対応|予約|連絡|電話|送って|まとめ/i,
  /can you|please|check|find|implement|do this|call|book|summarize/i,
];

const IMMEDIATE_ACK_VARIANTS = [
  "(calm) 了解、すぐ取りかかるね。",
  "(calm) 了解です。ちょっと待ってね。",
  "(calm) はい、今確認するね。",
];

const PROGRESS_PING_VARIANTS = [
  "(soft tone) いま処理中だよ、もう少し待ってね。",
  "(calm) 進めてるよ、あと少しで返せそう。",
  "(empathetic) ごめん、もう少しだけ待ってね。",
];

const LLM_TIMEOUT_FALLBACK_VOICE = "ちょっと時間がかかってるから、詳細はあとでSlackで共有するね。";

function shouldSendImmediateAck(text) {
  if (!ENABLE_IMMEDIATE_ACK) return false;
  const t = String(text || "").trim();
  if (!t) return false;
  return IMMEDIATE_ACK_PATTERNS.some((re) => re.test(t));
}

function pickImmediateAck(text) {
  // Slightly prefer task-oriented wording when user asks for work.
  if (/調べ|確認|探し|予約|連絡|call|check|find|book/i.test(String(text || ""))) {
    return "(calm) 了解、いま確認するね。";
  }
  return IMMEDIATE_ACK_VARIANTS[Math.floor(Math.random() * IMMEDIATE_ACK_VARIANTS.length)];
}

function pickProgressPing(index) {
  return PROGRESS_PING_VARIANTS[index % PROGRESS_PING_VARIANTS.length];
}

/**
 * Create the decomposed voice pipeline.
 *
 * @param {object} session - Meeting session object
 * @param {object} turnState - Shared turn state { isAgentSpeaking, inputCooldownUntil, droppedEchoFrames }
 * @param {function} onAudio - Callback: (buffer: Buffer) => void (sends audio to Attendee)
 * @param {object} config - Pipeline config from getPipelineConfig()
 * @param {object} options - Multi-agent options
 * @returns {{ sendAudio(buf: Buffer): void, close(): void }}
 */
function createPipeline(session, turnState, onAudio, config, options = {}) {
  const { EventEmitter } = require("events");
  const emitter = new EventEmitter();

  const dgKey = config.dgKey;
  const openrouterKey = config.openrouterKey;
  const fishKey = config.fishKey;
  const systemPrompt = config.systemPrompt;
  const wakeMode = config.wakeMode || WAKE_MODE;
  const selectedAgentIds = Array.isArray(options.selectedAgentIds) ? options.selectedAgentIds.filter(Boolean) : [];
  const hasSelectedAgents = selectedAgentIds.length > 0;
  const agents = options.agents || {};
  const defaultAgentId = options.defaultAgentId || selectedAgentIds[0] || null;
  let currentAgentId = defaultAgentId || "caty";

  const agentState = {
    openclawUrl: config.openclawUrl,
    openclawToken: config.openclawToken,
    voiceId: config.tts.referenceId || null,
    model: config.llm.model,
    openclawSystemAddendum: config.llm.openclawSystemAddendum,
    sessionUser: `meet-${session.id}`,
  };

  function switchAgent(agentId) {
    if (!agentId || !agents[agentId]) return false;

    const oldId = currentAgentId;
    const agent = agents[agentId];

    agentState.openclawUrl = agent.gatewayUrl || config.openclawUrl;
    agentState.openclawToken = agent.gatewayToken || config.openclawToken;
    agentState.voiceId = agent.voiceId || config.tts.referenceId || null;
    agentState.model = agent.model || config.llm.model;
    agentState.openclawSystemAddendum = Object.prototype.hasOwnProperty.call(agent, "openclawSystemAddendum")
      ? agent.openclawSystemAddendum
      : config.llm.openclawSystemAddendum;
    agentState.sessionUser = `meet-${session.id}-${agentId}`;

    currentAgentId = agentId;

    console.log(`🔄  Agent switch: ${oldId || "unknown"} → ${agentId}`);
    options.onAgentSwitch?.(oldId, agentId);
    return { oldId };
  }

  if (hasSelectedAgents && defaultAgentId && agents[defaultAgentId]) {
    switchAgent(defaultAgentId);
  }

  // OpenClaw Gateway integration
  const hasOpenClaw = () => !!(agentState.openclawUrl && agentState.openclawToken);
  if (hasOpenClaw()) {
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
  let lastUserTranscript = "";

  function appendConversationEntry(role, content, agentId = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      role,
      content,
    };
    if (agentId) entry.agentId = agentId;
    session.conversationLog.push(entry);

    if (agentId && session.conversationLogs && Array.isArray(session.conversationLogs[agentId])) {
      session.conversationLogs[agentId].push(entry);
    }
  }

  // ── STT ──────────────────────────────────────────────────────────
  const sttExtraKeyterms = [];
  if (hasSelectedAgents) {
    for (const agentId of selectedAgentIds) {
      const agent = agents[agentId];
      if (!agent) continue;
      for (const term of (agent.keyterms || [])) sttExtraKeyterms.push(term);
      for (const term of (agent.wakeWords || [])) sttExtraKeyterms.push(term);
    }
  }

  const stt = createSTT(dgKey, {
    model: config.stt.model,
    language: config.stt.language,
    sampleRate: config.stt.sampleRate,
    keyterms: sttExtraKeyterms,
  });

  stt.on("transcript", (text, isFinal, confidence) => {
    if (isFinal) {
      console.log(`🎤  [interim→final] ${text}`);
      return;
    }

    const interim = String(text || "").trim();

    // #8 Barge-in: if user starts speaking while agent is speaking, abort immediately.
    if (
      ENABLE_BARGE_IN &&
      interim &&
      interim.length >= BARGE_IN_MIN_CHARS &&
      turnState.isAgentSpeaking &&
      currentAbort &&
      !currentAbort.signal?.aborted
    ) {
      const hasLowConfidence = Number.isFinite(confidence) && confidence < BARGE_IN_CONFIDENCE_MIN;
      const isNoise = isNoiseInterim(interim);

      if (hasLowConfidence || isNoise) {
        console.log("🧹  Barge-in ignored (noise/conf)");
        return;
      }

      console.log(`🛑  Barge-in detected: "${interim.slice(0, 50)}" — aborting TTS/LLM`);
      currentAbort.abort();
      currentAbort = null;
      turnState.isAgentSpeaking = false;
      turnState.inputCooldownUntil = 0;
    }
  });

  stt.on("utterance_end", async (userText) => {
    const cleanedText = String(userText || "").trim();
    if (!cleanedText) return;

    // #8 Barge-in companion: small post-utterance buffer to reduce premature turn-taking.
    if (POST_UTTERANCE_BUFFER_MS > 0) {
      await sleep(POST_UTTERANCE_BUFFER_MS);
    }

    console.log(`💬  [user] ${cleanedText}`);

    // Exit command detection (Meet sessions only, not Twilio)
    if (config.exitDetection !== false && isExitCommand(cleanedText, agents, selectedAgentIds, defaultAgentId)) {
      console.log("🚪  Exit command detected!");
      appendConversationEntry("user", cleanedText, currentAgentId || null);

      // Speak farewell and emit exit event
      turnState.isAgentSpeaking = true;
      try {
        await speakSentence("(happy) 了解です！退出しますね。お疲れさまでした！", null);
      } catch {
        // ignore TTS error during exit
      }
      turnState.isAgentSpeaking = false;

      appendConversationEntry("assistant", "了解です！退出しますね。お疲れさまでした！", currentAgentId || null);

      emitter.emit("exit_requested", { sessionId: session.id, trigger: "voice_command", text: cleanedText });
      return;
    }

    // Wake word detection
    if (wakeMode === "wake") {
      const wakeResult = detectWakeAgent(cleanedText, agents, selectedAgentIds, defaultAgentId);
      if (!wakeResult.detected) {
        console.log(`🔇  Wake word not detected, ignoring: "${cleanedText.slice(0, 50)}..."`);
        // Still log for context, but don't respond
        appendConversationEntry("user", `[会議音声・未指名] ${cleanedText}`, currentAgentId || null);
        return;
      }
      if (wakeResult.agentId && wakeResult.agentId !== currentAgentId) {
        switchAgent(wakeResult.agentId);
      }
      console.log("🔔  Wake word detected!");
    }

    // Keep the latest user transcript for timeout handoff fallback.
    lastUserTranscript = cleanedText;

    // Log to session
    appendConversationEntry("user", cleanedText, currentAgentId || null);

    // If agent is currently speaking/processing, interrupt
    if (isProcessing && currentAbort) {
      console.log("⚡  User interrupted — aborting current response");
      currentAbort.abort();
      currentAbort = null;
      isProcessing = false;
      turnState.isAgentSpeaking = false;
    }

    // Process user input
    await processUserInput(cleanedText);
  });

  stt.on("error", (err) => {
    console.error("❌  STT error:", err.message || err);
  });

  // ── Process user input: LLM → TTS ──────────────────────────────
  async function processUserInput(userText, hasRetriedOnFallback = false) {
    isProcessing = true;
    const abort = new AbortController();
    currentAbort = abort;
    const requestAgentId = currentAgentId;

    let progressTimer = null;
    let llmTimeoutTimer = null;
    let progressPingIndex = 0;
    let mainResponseStarted = false;
    let spokenSentenceCount = 0;
    let firstChunkSeen = false;
    let llmFirstResponseTimedOut = false;
    let llmTimeoutFallbackPlayed = false;
    let handoffAttempted = false;

    const stopProgressTimer = () => {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
    };

    const stopLlmTimeoutTimer = () => {
      if (llmTimeoutTimer) {
        clearTimeout(llmTimeoutTimer);
        llmTimeoutTimer = null;
      }
    };

    abort.signal.addEventListener("abort", stopLlmTimeoutTimer, { once: true });

    const appendAssistantLog = (text) => {
      appendConversationEntry("assistant", text, currentAgentId || null);
    };

    const fireAndForgetTimeoutHandoff = (transcript) => {
      const trimmed = String(transcript || "").trim();
      if (!trimmed) {
        console.log("⏭️  Timeout handoff skipped (empty transcript)");
        return;
      }

      if (!hasOpenClaw() || !agentState.openclawUrl || !agentState.openclawToken) {
        console.log("⏭️  Timeout handoff skipped (OpenClaw Gateway unavailable)");
        return;
      }

      try {
        const gatewayUrl = new URL(agentState.openclawUrl);
        const isHttps = gatewayUrl.protocol === "https:";
        const transport = isHttps ? https : http;
        const handoffPrompt = [
          "ユーザーの音声通話中に依頼処理がタイムアウトしました。",
          "必ず sessions_spawn を使って作業を委譲し、結果をSlackに投稿してください。",
          "まずユーザー依頼を短く要約し、実行計画を立ててからサブエージェントを起動してください。",
          "",
          `ユーザー依頼: ${trimmed}`,
        ].join("\n");

        const body = JSON.stringify({
          model: agentState.model || config.llm.model || "anthropic/claude-sonnet-4-6",
          stream: false,
          temperature: 0.2,
          max_tokens: 700,
          messages: [
            {
              role: "system",
              content: "あなたは音声タイムアウト時の自動委譲ハンドラーです。結果は必ずSlackに共有してください。",
            },
            { role: "user", content: handoffPrompt },
          ],
          user: agentState.sessionUser,
        });

        const req = transport.request(
          {
            hostname: gatewayUrl.hostname,
            port: gatewayUrl.port || (isHttps ? 443 : 80),
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              Authorization: `Bearer ${agentState.openclawToken}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.resume();
            if (res.statusCode >= 400) {
              console.error(`❌  Timeout handoff failed: HTTP ${res.statusCode}`);
            }
          }
        );

        req.on("error", (err) => {
          console.error("❌  Timeout handoff request error:", err.message);
        });

        req.setTimeout(5_000, () => {
          req.destroy(new Error("Timeout handoff request timeout"));
        });

        req.write(body);
        req.end();

        console.log(`🔄  Timeout handoff spawned for: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}"`);
      } catch (err) {
        console.error("❌  Timeout handoff setup error:", err.message);
      }
    };

    const maybeSpeakLlmTimeoutFallback = async () => {
      if (!llmFirstResponseTimedOut || llmTimeoutFallbackPlayed) return;
      llmTimeoutFallbackPlayed = true;

      stopProgressTimer();
      turnState.isAgentSpeaking = true;
      await speakSentence(LLM_TIMEOUT_FALLBACK_VOICE, null);
      appendAssistantLog(LLM_TIMEOUT_FALLBACK_VOICE);
      turnState.isAgentSpeaking = false;

      if (!handoffAttempted) {
        const transcriptForHandoff = String(lastUserTranscript || "").trim();
        if (transcriptForHandoff) {
          handoffAttempted = true;
          fireAndForgetTimeoutHandoff(transcriptForHandoff);
        } else {
          console.log("⏭️  Timeout handoff skipped (no transcript)");
        }
      }
    };

    const startLlmTimeoutTimer = () => {
      const timeoutMs = Number(config?.llm?.responseTimeoutMs || 0);
      if (!(timeoutMs > 0)) return;

      llmTimeoutTimer = setTimeout(() => {
        if (firstChunkSeen || abort.signal.aborted || !isProcessing) return;
        llmFirstResponseTimedOut = true;
        console.warn(`⏱️  LLM first-response timeout (${timeoutMs}ms) — aborting`);
        stopLlmTimeoutTimer();
        abort.abort();
      }, timeoutMs);
    };

    const maybeProgressPing = async () => {
      if (!ENABLE_PROGRESS_GUARD) return;
      if (abort.signal.aborted || !isProcessing || mainResponseStarted) return;
      if (turnState.isAgentSpeaking) return;
      if (progressPingIndex >= PROGRESS_PING_MAX) {
        stopProgressTimer();
        return;
      }

      const ping = pickProgressPing(progressPingIndex);
      progressPingIndex += 1;
      turnState.isAgentSpeaking = true;
      console.log(`⏳  Progress ping: "${ping}"`);
      await speakSentence(ping, abort.signal);
      if (!abort.signal.aborted) {
        appendAssistantLog(ping.replace(/^\([^)]*\)\s*/, ""));
        turnState.isAgentSpeaking = false;
      }

      if (progressPingIndex >= PROGRESS_PING_MAX) {
        stopProgressTimer();
      }
    };

    // Add to history (used by OpenRouter fallback; OpenClaw manages its own)
    history.push({ role: "user", content: userText });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    try {
      // #9 Immediate ack for request-like utterances
      if (shouldSendImmediateAck(userText) && !abort.signal.aborted) {
        const ack = pickImmediateAck(userText);
        turnState.isAgentSpeaking = true;
        console.log(`⚡  Immediate ack: "${ack}"`);
        await speakSentence(ack, abort.signal);
        if (!abort.signal.aborted) {
          appendAssistantLog(ack.replace(/^\([^)]*\)\s*/, ""));
          turnState.isAgentSpeaking = false;
        }
      }

      if (ENABLE_PROGRESS_GUARD && PROGRESS_PING_INTERVAL_MS > 0 && PROGRESS_PING_MAX > 0) {
        progressTimer = setInterval(() => {
          maybeProgressPing().catch(() => {});
        }, PROGRESS_PING_INTERVAL_MS);
      }

      // ── LLM streaming ──
      let fullResponse = "";
      let sentenceBuffer = "";

      console.log(`🤔  ${requestAgentId || "agent"} thinking…`);

      // Build LLM options based on mode
      const llmMessages = hasOpenClaw()
        ? [{ role: "user", content: userText }] // OpenClaw manages history
        : history; // OpenRouter needs full history

      startLlmTimeoutTimer();

      for await (const chunk of streamChat(
        hasOpenClaw() ? null : systemPrompt,
        llmMessages,
        {
          // OpenClaw Gateway
          openclawUrl: agentState.openclawUrl,
          openclawToken: agentState.openclawToken,
          openclawSystemAddendum: agentState.openclawSystemAddendum,
          sessionUser: agentState.sessionUser,
          // OpenRouter fallback
          apiKey: openrouterKey,
          // Shared
          model: agentState.model,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          signal: abort.signal,
        }
      )) {
        if (abort.signal.aborted) break;

        if (!firstChunkSeen) {
          firstChunkSeen = true;
          stopLlmTimeoutTimer();
        }

        fullResponse += chunk;
        sentenceBuffer += chunk;

        // #9 First chunk fast path: speak early even before punctuation.
        if (!mainResponseStarted && sentenceBuffer.trim().length >= FIRST_CHUNK_MIN_CHARS && !SENTENCE_RE.test(sentenceBuffer)) {
          mainResponseStarted = true;
          stopProgressTimer();
          turnState.isAgentSpeaking = true;
          const firstChunk = sentenceBuffer.trim();
          sentenceBuffer = "";
          console.log(`🗣️  ${requestAgentId || "agent"} speaking (first chunk): "${firstChunk}"`);
          await speakSentence(firstChunk, abort.signal);
          if (abort.signal.aborted) break;
          spokenSentenceCount += 1;
          continue;
        }

        // Check for complete sentence
        const match = sentenceBuffer.match(SENTENCE_RE);
        if (match) {
          const idx = sentenceBuffer.search(SENTENCE_RE);
          const punctuation = match[0];
          const sentence = sentenceBuffer.slice(0, idx + punctuation.length).trim();
          sentenceBuffer = sentenceBuffer.slice(idx + punctuation.length);

          if (sentence.length >= MIN_SENTENCE_LEN) {
            if (!mainResponseStarted) {
              mainResponseStarted = true;
              stopProgressTimer();
              turnState.isAgentSpeaking = true;
            }

            // Insert pause between sentences (not before the first one)
            if (spokenSentenceCount > 0 && SENTENCE_PAUSE_MS > 0) {
              const silence = generateSilence(SENTENCE_PAUSE_MS, config.stt.sampleRate);
              onAudio(silence);
            }

            if (spokenSentenceCount === 0) {
              console.log(`🗣️  ${requestAgentId || "agent"} speaking: "${sentence}"`);
            } else {
              console.log(`🗣️  ${requestAgentId || "agent"} continue: "${sentence}"`);
            }

            await speakSentence(sentence, abort.signal);
            if (abort.signal.aborted) break;
            spokenSentenceCount += 1;
          }
        }
      }

      stopLlmTimeoutTimer();

      if (abort.signal.aborted) {
        await maybeSpeakLlmTimeoutFallback();
        console.log("⚡  Response aborted");
        return;
      }

      // Flush remaining text
      if (sentenceBuffer.trim() && sentenceBuffer.trim().length >= 3) {
        if (!mainResponseStarted) {
          mainResponseStarted = true;
          stopProgressTimer();
        }
        if (!turnState.isAgentSpeaking) {
          turnState.isAgentSpeaking = true;
        }
        console.log(`🗣️  ${requestAgentId || "agent"} speaking (flush): "${sentenceBuffer.trim()}"`);
        await speakSentence(sentenceBuffer.trim(), abort.signal);
      }

      // Log assistant response
      if (fullResponse.trim()) {
        console.log(`💬  [assistant] ${fullResponse.trim()}`);
        appendConversationEntry("assistant", fullResponse.trim(), requestAgentId || null);
        history.push({ role: "assistant", content: fullResponse.trim() });
        if (history.length > MAX_HISTORY) {
          history.splice(0, history.length - MAX_HISTORY);
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        await maybeSpeakLlmTimeoutFallback();
        return;
      }
      const errMsg = String(err?.message || err || "");
      const isGatewayFailure = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout|socket hang up|network/i.test(errMsg);
      if (
        isGatewayFailure &&
        hasSelectedAgents &&
        requestAgentId &&
        defaultAgentId &&
        requestAgentId !== defaultAgentId &&
        !hasRetriedOnFallback &&
        agents[defaultAgentId]
      ) {
        console.warn(`⚠️  Agent "${requestAgentId}" gateway unavailable. Falling back to "${defaultAgentId}"`);
        switchAgent(defaultAgentId);
        await processUserInput(userText, true);
        return;
      }
      console.error("❌  Pipeline error:", err.message || err.code || JSON.stringify(err));

      // Speak error message
      try {
        turnState.isAgentSpeaking = true;
        await speakSentence("すみません、ちょっとエラーが起きちゃいました。", abort.signal);
      } catch {
        // give up
      }
    } finally {
      stopProgressTimer();
      stopLlmTimeoutTimer();
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
        referenceId: agentState.voiceId || config.tts.referenceId || null,
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
    if (hasSelectedAgents && defaultAgentId && currentAgentId !== defaultAgentId) {
      switchAgent(defaultAgentId);
    }

    let greeting = config.greeting;
    if (hasSelectedAgents && defaultAgentId && agents[defaultAgentId]) {
      const defaultGreeting = agents[defaultAgentId].greeting || config.greeting;
      const others = selectedAgentIds
        .filter((id) => id !== defaultAgentId)
        .map((id) => agents[id]?.displayName || agents[id]?.name || id)
        .filter(Boolean);
      if (others.length > 0) {
        const trimmed = String(defaultGreeting || "").replace(/[。.!！?？\s]+$/u, "");
        greeting = `${trimmed}。今日は${others.join("と")}も一緒だよ！`;
      } else {
        greeting = defaultGreeting;
      }
    }
    if (!greeting) return;

    console.log(`💬  [assistant] ${greeting}`);
    appendConversationEntry("assistant", greeting, currentAgentId || null);
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

  // ── Purpose Explanation (auto-LLM after greeting) ────────────────
  async function sendPurposeExplanation() {
    const briefing = config.briefing;
    if (!briefing) return;

    console.log(`📋  Briefing detected — auto-explaining purpose…`);

    isProcessing = true;
    const abort = new AbortController();
    currentAbort = abort;
    turnState.isAgentSpeaking = true;

    // The Gateway session already has the briefing from warm-up.
    // Send a system hint to trigger a natural purpose explanation.
    const purposePrompt = "挨拶が終わりました。今回この電話をかけた理由・目的を、自分の言葉で簡潔に1-2文で伝えてください。briefingの内容をそのまま読み上げるのではなく、自然な話し言葉にしてください。";

    const llmMessages = hasOpenClaw()
      ? [{ role: "user", content: purposePrompt }]
      : [
          ...history,
          { role: "system", content: `電話の目的: ${briefing}` },
          { role: "user", content: purposePrompt },
        ];

    try {
      let fullResponse = "";
      let sentenceBuffer = "";
      let spokenCount = 0;

      for await (const chunk of streamChat(
        hasOpenClaw() ? null : systemPrompt,
        llmMessages,
        {
          openclawUrl: agentState.openclawUrl,
          openclawToken: agentState.openclawToken,
          openclawSystemAddendum: agentState.openclawSystemAddendum,
          sessionUser: agentState.sessionUser,
          apiKey: openrouterKey,
          model: agentState.model,
          temperature: config.llm.temperature,
          maxTokens: 150, // Short purpose statement
          signal: abort.signal,
        }
      )) {
        if (abort.signal.aborted) break;

        fullResponse += chunk;
        sentenceBuffer += chunk;

        // Speak complete sentences
        const match = sentenceBuffer.match(SENTENCE_RE);
        if (match) {
          const idx = sentenceBuffer.search(SENTENCE_RE);
          const punctuation = match[0];
          const sentence = sentenceBuffer.slice(0, idx + punctuation.length).trim();
          sentenceBuffer = sentenceBuffer.slice(idx + punctuation.length);

          if (sentence.length >= MIN_SENTENCE_LEN) {
            if (spokenCount > 0 && SENTENCE_PAUSE_MS > 0) {
              const silence = generateSilence(SENTENCE_PAUSE_MS, config.stt.sampleRate);
              onAudio(silence);
            }
            console.log(`🗣️  [purpose] ${sentence}`);
            await speakSentence(sentence, abort.signal);
            if (abort.signal.aborted) break;
            spokenCount += 1;
          }
        }
      }

      // Flush remaining
      if (!abort.signal.aborted && sentenceBuffer.trim() && sentenceBuffer.trim().length >= 3) {
        console.log(`🗣️  [purpose flush] ${sentenceBuffer.trim()}`);
        await speakSentence(sentenceBuffer.trim(), abort.signal);
      }

      if (fullResponse.trim()) {
        console.log(`💬  [purpose] ${fullResponse.trim()}`);
        appendConversationEntry("assistant", fullResponse.trim(), currentAgentId || null);
        history.push({ role: "assistant", content: fullResponse.trim() });
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error("❌  Purpose explanation error:", err.message);
      }
    } finally {
      turnState.isAgentSpeaking = false;
      turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);
      isProcessing = false;
      currentAbort = null;
    }
  }

  // Send greeting after a short delay (give STT time to connect)
  // Then auto-explain purpose if briefing exists
  setTimeout(async () => {
    await sendGreeting();
    await sendPurposeExplanation();
  }, 2000);

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
