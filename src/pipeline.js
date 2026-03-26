// pipeline.js — Orchestrates STT → LLM → TTS pipeline
// Replaces Deepgram Voice Agent (all-in-one) with decomposed components

const http = require("http");
const https = require("https");
const { createSTT } = require("./stt");
const { streamChat } = require("./llm");
const { synthesize } = require("./tts-fish");
const { getExitCommands, detectExitIntent } = require("./exit-handler");
const { shouldSuppressReply } = require("./speech-policy");

// Two-tier sentence splitter for Japanese + English
// Tier 1: Full sentence boundary (。！？!?\n) — long pause
// Tier 2: Clause boundary (、) — short pause, only when buffer is long enough
const SENTENCE_END_RE = /[。！？!?\n]+/;
const CLAUSE_CHAR = "、";
const MIN_SENTENCE_LEN = 8;
const MIN_CLAUSE_LEN = Number(process.env.MIN_CLAUSE_LEN || 15);       // min buffer length to trigger clause split
const MIN_CLAUSE_PREFIX = Number(process.env.MIN_CLAUSE_PREFIX || 6);   // min chars before 、 to split
const FIRST_CHUNK_MIN_CHARS = Number(process.env.FIRST_CHUNK_MIN_CHARS || 12);

// Inter-segment pauses
const SENTENCE_PAUSE_MS = Number(process.env.SENTENCE_PAUSE_MS || 500); // full sentence boundary
const CLAUSE_PAUSE_MS = Number(process.env.CLAUSE_PAUSE_MS || 150);     // clause boundary (、)

// UX controls
const POST_UTTERANCE_BUFFER_MS = Number(process.env.POST_UTTERANCE_BUFFER_MS || 500);
const PROGRESS_PING_INTERVAL_MS = Number(process.env.PROGRESS_PING_INTERVAL_MS || 10_000);
const PROGRESS_PING_MAX = Number(process.env.PROGRESS_PING_MAX || 3);
const BARGE_IN_MIN_CHARS = Number(process.env.BARGE_IN_MIN_CHARS || 2);
const BARGE_IN_CONFIDENCE_MIN = Number(process.env.BARGE_IN_CONFIDENCE_MIN || 0.45);
const ENABLE_BARGE_IN = String(process.env.ENABLE_BARGE_IN || "true").toLowerCase() !== "false";
const ENABLE_IMMEDIATE_ACK = String(process.env.ENABLE_IMMEDIATE_ACK || "true").toLowerCase() !== "false";
const ENABLE_PROGRESS_GUARD = String(process.env.ENABLE_PROGRESS_GUARD || "true").toLowerCase() !== "false";

// Multi-participant meeting mode: Injection Gate
const TRANSCRIPT_BUFFER_MAX = Number(process.env.TRANSCRIPT_BUFFER_MAX || 50);
// Cancel word detection: strict boundary match to avoid false positives
// (e.g. "ストップウォッチ", "キャンセルポリシー" should NOT trigger)
const CANCEL_RE = /^[\s\u3000]*(キャンセル|やめて|もういい|中止|ストップ|stop|cancel)[\s\u3000。！!]*$/i;
function isCancelWord(text) {
  return CANCEL_RE.test(text.trim());
}

// Wake word detection: only respond when addressed
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
  return "";
})();
const WAKE_WORDS = _defaultWakeWords.toLowerCase().split(",").map(w => w.trim());

// Exit commands: now delegated to exit-handler.js getExitCommands()
// Kept as module-level reference for backward compat (resolved per-call via getExitCommands)
const EXIT_COMMANDS = getExitCommands();

// Extended wake word variants to handle STT transcription inaccuracies
// Deepgram may output: けいてい, ケーティー, ケイティー, キーティ, テイティー, けーてぃ, etc.
// Per-agent sttWakeVariants from agents.json are merged at pipeline creation time.
const EXTENDED_WAKE_VARIANTS = [
  // Hiragana variants
  "けいてい", "けーてぃ", "けーてい", "けいてぃー", "けいていー",
  "せいてぃ", "せいてい", "せーてぃ",
  "ていてい", "てぃてぃ",            // テイテイ (observed 2026-03-17)
  "らってぃ", "らっち",              // ラッティ (observed 2026-03-17)
  // Katakana variants
  "キーティ", "ケーティ", "ケーティー", "ケイティー", "テイティー",
  "セイティ", "セーティ", "エイティ", "エイティー",
  "キャティ", "キャティー", "ケィティ",
  "ティーティー",
  "テイテイ",                       // observed 2026-03-17
  "ラッティ", "ラッティー",          // observed 2026-03-17
  "ミーティー",                     // Meety → ケイティの誤認 (observed 2026-03-17)
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
 * Only active in Meet/Zoom sessions.
 * Now delegates to exit-handler.js detectExitIntent, with wake word check.
 */
function isExitCommand(text, agents = null, selectedAgentIds = [], defaultAgentId = null, agentProfile = null) {
  // Use exit-handler for primary detection
  if (detectExitIntent(text, agents, selectedAgentIds, defaultAgentId, agentProfile)) {
    return true;
  }

  // Also check wake word + exit pattern: "ケイティ、退出して"
  const exitCmds = getExitCommands(agentProfile);
  const lower = text.toLowerCase().trim();
  if (detectWakeAgent(text, agents, selectedAgentIds, defaultAgentId).detected) {
    for (const cmd of exitCmds) {
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
  // Check extended variants (built-in + per-agent sttWakeVariants from agents.json)
  const allExtended = [...EXTENDED_WAKE_VARIANTS];
  if (agents && ids.length > 0) {
    for (const agentId of ids) {
      const variants = agents[agentId]?.sttWakeVariants;
      if (Array.isArray(variants)) {
        for (const v of variants) allExtended.push(String(v).toLowerCase().trim());
      }
    }
  }
  if (allExtended.some((v) => lower.includes(v))) {
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

/**
 * Find the best split point in a text buffer.
 * Priority 1: Full sentence boundary (。！？!?\n) → long pause
 * Priority 2: Clause boundary (、) when buffer is long enough → short pause
 * Returns { splitAt, pauseMs, type } or null if no split point found.
 */
function findSplitPoint(buffer) {
  // Priority 1: Full sentence boundary
  const sentenceMatch = buffer.match(SENTENCE_END_RE);
  if (sentenceMatch) {
    const idx = buffer.search(SENTENCE_END_RE);
    return {
      splitAt: idx + sentenceMatch[0].length,
      pauseMs: SENTENCE_PAUSE_MS,
      type: "sentence",
    };
  }

  // Priority 2: Clause boundary (、) when buffer is long enough
  if (buffer.length >= MIN_CLAUSE_LEN) {
    const clauseIdx = buffer.indexOf(CLAUSE_CHAR);
    if (clauseIdx >= MIN_CLAUSE_PREFIX) {
      return {
        splitAt: clauseIdx + 1,
        pauseMs: CLAUSE_PAUSE_MS,
        type: "clause",
      };
    }
  }

  return null;
}

// Legacy helper (kept for backward compat)
function splitSentences(text) {
  const parts = text.split(SENTENCE_END_RE).filter((s) => s.trim().length > 0);
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

const DEFAULT_ACK_VARIANTS = [
  "(calm) 了解、すぐ取りかかるね。",
  "(calm) 了解です。ちょっと待ってね。",
  "(calm) はい、今確認するね。",
];

const PROGRESS_PING_VARIANTS = [
  "(soft tone) いま処理中だよ、もう少し待ってね。",
  "(calm) 進めてるよ、あと少しで返せそう。",
  "(empathetic) ごめん、もう少しだけ待ってね。",
];

const LLM_TIMEOUT_FALLBACK_VOICE = "(calm) ちょっと時間がかかってるから、詳細はあとでSlackで共有するね。";

function shouldSendImmediateAck(text) {
  if (!ENABLE_IMMEDIATE_ACK) return false;
  const t = String(text || "").trim();
  if (!t) return false;
  return IMMEDIATE_ACK_PATTERNS.some((re) => re.test(t));
}

function pickImmediateAck(text, agentAckVariants = null) {
  const variants = agentAckVariants && agentAckVariants.length > 0
    ? agentAckVariants
    : DEFAULT_ACK_VARIANTS;

  // Slightly prefer task-oriented wording when user asks for work.
  if (/調べ|確認|探し|予約|連絡|call|check|find|book/i.test(String(text || ""))) {
    const taskVariant = variants.find((v) => /確認|調べ|check/i.test(v));
    return taskVariant || variants[0];
  }
  return variants[Math.floor(Math.random() * variants.length)];
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
  const fishKey = config.fishKey;
  const selectedAgentIds = Array.isArray(options.selectedAgentIds) ? options.selectedAgentIds.filter(Boolean) : [];
  const hasSelectedAgents = selectedAgentIds.length > 0;
  const agents = options.agents || {};
  const agentProfile = options.agentProfile || null;
  const defaultAgentId = options.defaultAgentId || selectedAgentIds[0] || null;
  let currentAgentId = defaultAgentId || agentProfile?.agentId || "agent";

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

  console.log("🔗  OpenClaw Gateway モード ✨");

  // Current LLM/TTS abort controller (for interruption)
  let currentAbort = null;
  let isProcessing = false;
  let lastUserTranscript = "";

  // Multi-participant meeting mode: Injection Gate (wake mode only)
  const transcriptBuffer = []; // Accumulates all utterances (with seq numbers)
  const pendingQueue = []; // Utterances that arrive while Gate is CLOSED
  let gateState = "OPEN"; // "OPEN" = accepting input, "CLOSED" = processing
  let utteranceSeq = 0; // Monotonic sequence counter for ordering
  // Share gateState with transport layer (echo gate bypass for cancel detection)
  turnState.gateState = gateState;

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

    // Multi-participant mode: Skip barge-in during Gate CLOSED
    // (Cancel detection moved to utterance_end only — interim is too noisy from TTS echo)
    if (gateState === "CLOSED") {
      return;
    }

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

    // Exit command detection
    if (config.exitDetection !== false && isExitCommand(cleanedText, agents, selectedAgentIds, defaultAgentId, agentProfile)) {
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

      // LCM ingest is now handled in handleMeetSessionEnd() (meet-routes.js)
      // after the bot has already left — no blocking delay before exit.

      // Wait for farewell audio to finish playing on the remote end
      // (speakSentence resolves when chunks are sent, not when playback ends)
      const EXIT_GRACE_MS = 3000;
      console.log(`⏳  Waiting ${EXIT_GRACE_MS}ms for farewell playback before exit...`);
      await sleep(EXIT_GRACE_MS);

      emitter.emit("exit_requested", { sessionId: session.id, trigger: "voice_command", text: cleanedText });
      return;
    }

    // Standalone cancel disabled — cancel requires wake word prefix
    // (e.g. "ケイティ、ストップ"). Handled in wake+cancel block below.

    // Wake word detection
    {
      // Multi-participant mode: create entry with sequence number
      utteranceSeq += 1;
      const entry = { seq: utteranceSeq, text: cleanedText, timestamp: new Date().toISOString() };

      const wakeResult = detectWakeAgent(cleanedText, agents, selectedAgentIds, defaultAgentId);
      if (!wakeResult.detected) {
        // No wake word: add to buffer only (don't call LLM)
        transcriptBuffer.push(entry);
        while (transcriptBuffer.length > TRANSCRIPT_BUFFER_MAX) transcriptBuffer.shift();
        console.log(`🔇  [会議音声・未指名] "${cleanedText.slice(0, 50)}..."`);
        appendConversationEntry("user", `[会議音声・未指名] ${cleanedText}`, currentAgentId || null);
        return;
      }

      // Wake word detected
      if (wakeResult.agentId && wakeResult.agentId !== currentAgentId) {
        switchAgent(wakeResult.agentId);
      }

      // Injection Gate logic
      if (gateState === "OPEN") {
        gateState = "CLOSED";
        turnState.gateState = gateState;
        // Add to buffer AFTER taking context snapshot (avoid self-duplication)
        transcriptBuffer.push(entry);
        while (transcriptBuffer.length > TRANSCRIPT_BUFFER_MAX) transcriptBuffer.shift();
        console.log("🔔  Wake word detected! Gate → CLOSED");
      } else {
        // Gate is CLOSED: check for wake+cancel combo (immediate abort)
        // Strip wake word using all known variants (WAKE_WORDS + EXTENDED_WAKE_VARIANTS)
        const allWakePatterns = [...WAKE_WORDS, ...EXTENDED_WAKE_VARIANTS].join("|");
        const wakeStripRe = new RegExp(`^.*?(${allWakePatterns})[ー\\s、,.]*`, "i");
        const textAfterWake = cleanedText.replace(wakeStripRe, "").trim();
        if (isCancelWord(textAfterWake) || isCancelWord(cleanedText)) {
          console.log(`🚫  Wake+cancel abort: "${cleanedText.slice(0, 50)}"`);
          if (currentAbort && !currentAbort.signal?.aborted) {
            currentAbort.abort();
            currentAbort = null;
          }
          gateState = "OPEN";
          turnState.gateState = gateState;
          turnState.isAgentSpeaking = false;
          turnState.inputCooldownUntil = 0;
          return;
        }
        // Regular wake during CLOSED: queue (don't add to buffer — merge happens in finally)
        console.log(`⏳  Wake word detected but gate CLOSED, queuing: "${cleanedText.slice(0, 50)}..."`);
        pendingQueue.push(entry);
        return;
      }
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

    // Build user text with meeting context injection
    let textToProcess = cleanedText;
    {
      // Use slice(-21, -1) to exclude the current utterance (already in buffer)
      const contextEntries = transcriptBuffer.slice(-21, -1);
      const meetingContext = contextEntries
        .map(e => `[${e.timestamp}] ${e.text}`)
        .join("\n");
      textToProcess = meetingContext.length > 0
        ? `【直近の会議の流れ】\n${meetingContext}\n\n【指名された発言】\n${cleanedText}`
        : cleanedText;
      console.log(`📋  Injected meeting context (${transcriptBuffer.length} entries)`);
    }

    // Process user input
    await processUserInput(textToProcess);
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

      if (!agentState.openclawUrl || !agentState.openclawToken) {
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

    try {
      // #9 Immediate ack for request-like utterances
      const currentAgentConfig = agents[currentAgentId] || {};
      if (shouldSendImmediateAck(userText) && !abort.signal.aborted) {
        const ack = pickImmediateAck(userText, currentAgentConfig.ackVariants || config.ackVariants);
        turnState.isAgentSpeaking = true;
        console.log(`⚡  Immediate ack: "${ack}"`);
        await speakSentence(ack, abort.signal);
        if (!abort.signal.aborted) {
          appendAssistantLog(ack.replace(/^\([^)]*\)\s*/, ""));
          // Insert silence after ack (same as greeting→purpose transition)
          // so the first LLM sentence doesn't collide with the ack playback.
          const ackSilence = generateSilence(SENTENCE_PAUSE_MS, config.stt.sampleRate);
          onAudio(ackSilence);
          // Count ack as a spoken segment so the first LLM split-point sentence
          // also gets a pause via the spokenSentenceCount > 0 check.
          spokenSentenceCount = 1;
          // Keep isAgentSpeaking true — the LLM response will continue speaking.
          // Setting it to false here created a brief vulnerability window where
          // STT noise could trigger barge-in/re-entry.
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

      // OpenClaw Gateway manages conversation history
      const llmMessages = [{ role: "user", content: userText }];

      // ★ Diagnostic: dump what we're actually sending to Gateway
      console.log(`📤  [diag] Gateway payload — agent=${requestAgentId} user=${agentState.sessionUser}`);
      console.log(`📤  [diag] user.content (${userText.length} chars): "${userText.slice(0, 200)}${userText.length > 200 ? "…" : ""}"`);
      console.log(`📤  [diag] messages count=${llmMessages.length}, model=${agentState.model}`);

      startLlmTimeoutTimer();

      for await (const chunk of streamChat(
        llmMessages,
        {
          openclawUrl: agentState.openclawUrl,
          openclawToken: agentState.openclawToken,
          openclawSystemAddendum: agentState.openclawSystemAddendum,
          sessionUser: agentState.sessionUser,
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
          console.log(`📥  [diag] firstChunk transition: false→true, chunk="${chunk.slice(0, 40)}"`);
        }

        fullResponse += chunk;
        sentenceBuffer += chunk;

        // #9 First chunk fast path: speak early even before punctuation.
        // Skip when ack was already spoken (spokenSentenceCount > 0) — ack provides
        // sufficient responsiveness, so we wait for proper punctuation chunking instead.
        if (!mainResponseStarted && spokenSentenceCount === 0 && sentenceBuffer.trim().length >= FIRST_CHUNK_MIN_CHARS && !SENTENCE_END_RE.test(sentenceBuffer) && !findSplitPoint(sentenceBuffer)) {
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

        // Check for split point (two-tier: sentence boundary or clause boundary)
        const split = findSplitPoint(sentenceBuffer);
        if (split) {
          const sentence = sentenceBuffer.slice(0, split.splitAt).trim();
          sentenceBuffer = sentenceBuffer.slice(split.splitAt);

          if (sentence.length >= MIN_SENTENCE_LEN) {
            if (!mainResponseStarted) {
              mainResponseStarted = true;
              stopProgressTimer();
              turnState.isAgentSpeaking = true;
            }

            // Insert pause between segments (sentence=long, clause=short)
            if (spokenSentenceCount > 0 && split.pauseMs > 0) {
              const silence = generateSilence(split.pauseMs, config.stt.sampleRate);
              onAudio(silence);
            }

            const splitLabel = split.type === "clause" ? "clause" : "sentence";
            if (spokenSentenceCount === 0) {
              console.log(`🗣️  ${requestAgentId || "agent"} speaking [${splitLabel}]: "${sentence}"`);
            } else {
              console.log(`🗣️  ${requestAgentId || "agent"} continue [${splitLabel}]: "${sentence}"`);
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

      // ★ Diagnostic: dump final LLM response
      console.log(`📥  [diag] LLM response (${fullResponse.length} chars, ${firstChunkSeen ? "chunks received" : "NO chunks"}): "${fullResponse.slice(0, 200)}${fullResponse.length > 200 ? "…" : ""}"`);

      // ★ NO_REPLY guard: if entire LLM response is a silent reply, skip TTS
      if (shouldSuppressReply(fullResponse)) {
        console.log(`🔇  silent_reply_detected (pipeline): "${fullResponse.trim()}" — skipping TTS`);
        console.log(`🔇  [diag] NO_REPLY context dump:`);
        console.log(`🔇  [diag]   STT input: "${lastUserTranscript.slice(0, 200)}"`);
        console.log(`🔇  [diag]   Sent to LLM: "${userText.slice(0, 200)}"`);
        console.log(`🔇  [diag]   Agent: ${requestAgentId}, Session: ${agentState.sessionUser}`);
        console.log(`🔇  [diag]   firstChunk: ${firstChunkSeen}`);
        // Don't log as assistant response, don't add to history
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

      // Multi-participant mode: Open gate and re-scan pending queue
      {
        gateState = "OPEN";
        turnState.gateState = gateState;
        // Merge pending into buffer
        for (const entry of pendingQueue) {
          transcriptBuffer.push(entry);
          while (transcriptBuffer.length > TRANSCRIPT_BUFFER_MAX) transcriptBuffer.shift();
        }
        const pendingCopy = [...pendingQueue];
        pendingQueue.length = 0;

        // Re-scan for wake words in pending
        for (let i = 0; i < pendingCopy.length; i++) {
          const entry = pendingCopy[i];
          const wakeResult = detectWakeAgent(entry.text, agents, selectedAgentIds, defaultAgentId);
          if (wakeResult.detected) {
            console.log(`🔔  Pending wake word found: "${entry.text.slice(0, 50)}"`);
            if (wakeResult.agentId && wakeResult.agentId !== currentAgentId) {
              switchAgent(wakeResult.agentId);
            }
            // Push remaining unprocessed entries back to pendingQueue for next cycle
            pendingQueue.push(...pendingCopy.slice(i + 1));
            // Process this pending wake call
            const pendingContext = transcriptBuffer.slice(-20)
              .map(e => `[${e.timestamp}] ${e.text}`)
              .join("\n");
            const pendingPrefix = `【直近の会議の流れ】\n${pendingContext}\n\n【指名された発言】\n`;
            appendConversationEntry("user", entry.text, currentAgentId || null);
            lastUserTranscript = entry.text;
            await processUserInput(pendingPrefix + entry.text);
            break; // Process first wake only; rest are in pendingQueue for next finally cycle
          }
        }
      }
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

    // If purposeStatement exists, append it to greeting for seamless delivery
    const purposeStatement = config.purposeStatement;
    let fullGreeting = greeting;
    if (purposeStatement) {
      // Remove trailing punctuation from greeting, then append purpose
      const trimmedGreeting = greeting.replace(/[。.!！\s]+$/u, "");
      fullGreeting = `${trimmedGreeting}。${purposeStatement}`;
      console.log(`📋  Greeting + purpose combined: "${fullGreeting}"`);
    }

    console.log(`💬  [assistant] ${fullGreeting}`);
    appendConversationEntry("assistant", fullGreeting, currentAgentId || null);

    // Use AbortController so barge-in can interrupt greeting/purpose
    const greetAbort = new AbortController();
    currentAbort = greetAbort;
    isProcessing = true;
    turnState.isAgentSpeaking = true;
    try {
      await speakSentence(greeting, greetAbort.signal);
      if (purposeStatement && !greetAbort.signal.aborted) {
        // Small pause between greeting and purpose
        const silence = generateSilence(SENTENCE_PAUSE_MS || 500, config.stt.sampleRate);
        onAudio(silence);
        await speakSentence(purposeStatement, greetAbort.signal);
      }
    } catch (err) {
      if (!greetAbort.signal.aborted) {
        console.error("❌  Greeting TTS error:", err.message);
      }
    }
    turnState.isAgentSpeaking = false;
    isProcessing = false;
    if (currentAbort === greetAbort) currentAbort = null;
    turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);
  }

  // Send greeting (+ purpose statement if available) after a short delay
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
