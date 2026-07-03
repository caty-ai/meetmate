// pipeline.js — Orchestrates STT → LLM → TTS pipeline
// Replaces Deepgram Voice Agent (all-in-one) with decomposed components

const http = require("http");
const https = require("https");
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

// Inter-segment pauses. Defaults tuned for natural Japanese pacing; both
// are env-overridable for live micro-tuning without redeploy.
const SENTENCE_PAUSE_MS = Number(process.env.SENTENCE_PAUSE_MS || 700); // full sentence boundary (。！？\n)
const CLAUSE_PAUSE_MS = Number(process.env.CLAUSE_PAUSE_MS || 300);     // clause boundary (、)
// Gap between independent TTS utterances (ack vs progress-ping vs LLM reply
// vs followup). Always-ack + progress pings made it possible for two speak
// operations to overlap into onAudio; this gap plus the queue in
// speakSentence keeps utterances cleanly separated.
const TTS_GAP_MS = Number(process.env.TTS_GAP_MS || 250);

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
const PENDING_QUEUE_MAX = Number(process.env.PENDING_QUEUE_MAX || 3);
const MEETING_CONTEXT_RAW_UTTERANCES = positiveInt(process.env.MEETING_CONTEXT_RAW_UTTERANCES, 10);
const MEETING_CONTEXT_RAW_CHARS = positiveInt(process.env.MEETING_CONTEXT_RAW_CHARS, 1800);
// Master kill-switch for unaddressed-utterance injection. Default OFF — when
// false, only the existing addressed-only context flows into LLM prompts
// (current main behavior preserved). Set to "true" to enable T3a's full
// unaddressed-context experiment; effective only in wake/group meetings.
const ENABLE_MEETING_CONTEXT_INJECTION = String(process.env.ENABLE_MEETING_CONTEXT_INJECTION || "false").toLowerCase() === "true";
// Cancel word detection: strict boundary match to avoid false positives
// (e.g. "ストップウォッチ", "キャンセルポリシー" should NOT trigger)
const CANCEL_RE = /^[\s\u3000]*(キャンセル|やめて|もういい|中止|ストップ|stop|cancel)[\s\u3000。！!]*$/i;
function isCancelWord(text) {
  return CANCEL_RE.test(text.trim());
}

function stripWakePrefix(text, agents = null, selectedAgentIds = []) {
  const wakePatterns = [...WAKE_WORDS, ...EXTENDED_WAKE_VARIANTS];
  const ids = Array.isArray(selectedAgentIds) ? selectedAgentIds : [];
  if (agents && ids.length > 0) {
    for (const agentId of ids) {
      const agent = agents[agentId] || {};
      for (const word of agent.wakeWords || []) wakePatterns.push(String(word || "").toLowerCase().trim());
      for (const variant of agent.sttWakeVariants || []) wakePatterns.push(String(variant || "").toLowerCase().trim());
    }
  }

  const allWakePatterns = wakePatterns.filter(Boolean).join("|");
  if (!allWakePatterns) return String(text || "").trim();
  const wakeStripRe = new RegExp(`^.*?(${allWakePatterns})[ー\\s、,.]*`, "i");
  return String(text || "").replace(wakeStripRe, "").trim();
}

function isWakeCancelText(text, agents = null, selectedAgentIds = []) {
  const cleaned = String(text || "").trim();
  return isCancelWord(stripWakePrefix(cleaned, agents, selectedAgentIds)) || isCancelWord(cleaned);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function selectMeetingContextEntries(transcriptBuffer, currentEntry, options = {}) {
  const maxUtterances = positiveInt(options.maxUtterances, MEETING_CONTEXT_RAW_UTTERANCES);
  const maxChars = positiveInt(options.maxChars, MEETING_CONTEXT_RAW_CHARS);
  const includeUnaddressed = options.includeUnaddressed === true;
  const beforeSeq = typeof currentEntry?.seq === "number" ? currentEntry.seq : null;

  const candidates = transcriptBuffer
    .filter((entry) => {
      if (!entry || entry === currentEntry) return false;
      if (entry.sentToLlm === true) return false;
      if (!includeUnaddressed && entry.injectToLlm === false) return false;
      if (beforeSeq !== null && typeof entry.seq === "number") return entry.seq < beforeSeq;
      return true;
    })
    .slice(-maxUtterances);

  const selected = [];
  let usedChars = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const text = String(candidates[i].text || "").trim();
    if (!text) continue;
    const line = `[${candidates[i].timestamp || "unknown-time"}] ${text}`;
    const separatorChars = selected.length > 0 ? 1 : 0;
    if (usedChars + separatorChars + line.length <= maxChars) {
      selected.unshift({ entry: candidates[i], line });
      usedChars += separatorChars + line.length;
      continue;
    }
    if (selected.length === 0) {
      selected.unshift({
        entry: candidates[i],
        line: maxChars <= 3 ? line.slice(0, maxChars) : `${line.slice(0, maxChars - 3)}...`,
      });
    }
    break;
  }

  return selected;
}

function buildMeetingContextBlock(transcriptBuffer, currentEntry, options = {}) {
  return selectMeetingContextEntries(transcriptBuffer, currentEntry, options)
    .map((item) => item.line)
    .join("\n");
}

function buildMeetingContextPrompt(transcriptBuffer, currentEntry, addressedText, options = {}) {
  return buildMeetingContextPromptWithEntries(transcriptBuffer, currentEntry, addressedText, options).text;
}

function buildMeetingContextPromptWithEntries(transcriptBuffer, currentEntry, addressedText, options = {}) {
  const selected = selectMeetingContextEntries(transcriptBuffer, currentEntry, options);
  const meetingContext = selected.map((item) => item.line).join("\n");
  return {
    text: meetingContext.length > 0
      ? `【直近の会議の流れ】\n${meetingContext}\n\n【指名された発言】\n${addressedText}`
      : addressedText,
    entries: selected.map((item) => item.entry),
  };
}

// Wake word detection: only respond when addressed
// In single-agent mode, use the agent's wakeWords from config.json
const _defaultWakeWords = (() => {
  if (process.env.WAKE_WORDS) return process.env.WAKE_WORDS;
  try {
    const { resolveAgentProfile } = require("./agent-profile");
    const profile = resolveAgentProfile();
    if (profile?.wakeWords?.length) return profile.wakeWords.join(",");
  } catch { /* fall through */ }
  return "";
})();
const WAKE_WORDS = _defaultWakeWords.toLowerCase().split(",").map(w => w.trim());

// Exit commands: now delegated to exit-handler.js getExitCommands()
// Kept as module-level reference for backward compat (resolved per-call via getExitCommands)
const EXIT_COMMANDS = getExitCommands();

// Extended wake word variants: no built-in defaults.
// All STT transcription variants are loaded per-agent from config.json agent.sttWakeVariants.
const EXTENDED_WAKE_VARIANTS = [];

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

  // Also check wake word + exit pattern: e.g. "{agentName}、退出して"
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
  // Check extended variants (built-in + per-agent sttWakeVariants from config.json)
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

// Fixed lines below: every line is anchored with an S2-Pro emotion tag.
// Tagless input causes S2-Pro to drift (sudden volume / pitch / voice quality
// changes), so we use [soft voice] as the default anchor across ack / progress
// / handoff. Two moments use a different tag because the moment genuinely
// calls for one: timeout fallback (apology) → [empathetic, unhurried],
// exit farewell → [warm].
const DEFAULT_ACK_VARIANTS = [
  "[soft voice] 了解、すぐ取りかかるね。",
  "[soft voice] 了解です。ちょっと待ってね。",
  "[soft voice] はい、今確認するね。",
];

const PROGRESS_PING_VARIANTS = [
  "[soft voice] いま処理中だよ、もう少し待ってね。",
  "[soft voice] 進めてるよ、あと少しで返せそう。",
  "[soft voice] ごめん、もう少しだけ待ってね。",
];

// Spoken first when the LLM never returns a chunk within the timeout budget.
// Intentionally does NOT promise Slack — that would be a lie if the handoff
// itself fails. The real Slack-confirmation line is spoken later, only on
// success of requestTimeoutHandoff().
const LLM_TIMEOUT_FALLBACK_VOICE = "[empathetic, unhurried] ごめん、ちょっと時間がかかってるね。少し待ってもらえるかな？";
const HANDOFF_SUCCESS_VOICE = "[soft voice] 続きはSlackに共有しておくね。";
const HANDOFF_FAILURE_VOICE = "[soft voice] ごめん、うまく繋げられなかったみたい。あとでもう一回試してね。";

function shouldSendImmediateAck(text) {
  // Always ack on any addressed turn so the user never hears silence after
  // calling Caty. The caller already gates this to addressed (post-wake)
  // turns, and exit/cancel turns short-circuit before reaching the ack path.
  // Pattern matching is preserved internally so pickImmediateAck() can pick
  // a task-flavored variant for request-like utterances.
  if (!ENABLE_IMMEDIATE_ACK) return false;
  const t = String(text || "").trim();
  if (!t) return false;
  return true;
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

function pickProgressPing(index, customVariants = null) {
  const variants = customVariants && customVariants.length > 0
    ? customVariants
    : PROGRESS_PING_VARIANTS;
  return variants[index % variants.length];
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
  const { createSTT } = require("./stt-provider");
  const emitter = new EventEmitter();

  // TTS serialization: every speakSentence call chains onto this lock so
  // ack / progress-ping / LLM stream chunks / fallback never overlap into
  // onAudio. ttsHasSpoken skips the gap before the very first utterance.
  let ttsLock = Promise.resolve();
  let ttsHasSpoken = false;

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
  let hasSentInitialWakeAck = false;

  // Multi-participant meeting mode: Injection Gate (wake mode only)
  const transcriptBuffer = []; // Accumulates all utterances (with seq numbers)
  const pendingQueue = []; // Utterances that arrive while Gate is CLOSED
  let gateState = "OPEN"; // "OPEN" = accepting input, "CLOSED" = processing
  let utteranceSeq = 0; // Monotonic sequence counter for ordering
  const meetingContextOptions = {
    includeUnaddressed:
      ENABLE_MEETING_CONTEXT_INJECTION &&
      (session?.config?.wakeMode === "wake" || config?.wakeMode === "wake"),
  };
  // Share gateState with transport layer (echo gate bypass for cancel detection)
  turnState.gateState = gateState;

  function pushTranscriptEntry(entry) {
    transcriptBuffer.push(entry);
    while (transcriptBuffer.length > TRANSCRIPT_BUFFER_MAX) transcriptBuffer.shift();
  }

  function enqueuePending(entry) {
    const maxPending = Number.isFinite(PENDING_QUEUE_MAX) ? Math.max(0, PENDING_QUEUE_MAX) : 3;
    // Drop the oldest pending entry when the queue is full; the newest wake always wins.
    pendingQueue.push(entry);
    while (pendingQueue.length > maxPending) {
      const dropped = pendingQueue.shift();
      console.log(
        `⚠️  Pending queue full (${maxPending}), dropping oldest: "${String(dropped?.text || "").slice(0, 50)}..."`
      );
    }
  }

  function markSentToLlm(contextEntries, currentEntry) {
    for (const entry of contextEntries || []) {
      if (entry) entry.sentToLlm = true;
    }
    if (currentEntry) currentEntry.sentToLlm = true;
  }

  async function handleWakeCancelAbort(cleanedText) {
    console.log(`🚫  Wake+cancel abort: "${cleanedText.slice(0, 50)}"`);
    if (currentAbort && !currentAbort.signal?.aborted) {
      currentAbort.abort();
      currentAbort = null;
    }
    isProcessing = false;
    gateState = "OPEN";
    turnState.gateState = gateState;
    turnState.isAgentSpeaking = false;
    turnState.inputCooldownUntil = 0;

    const cancelMsg = config.cancelAck;
    if (cancelMsg) {
      try {
        turnState.isAgentSpeaking = true;
        await speakSentence(cancelMsg, null);
        appendConversationEntry("assistant", cancelMsg.replace(/^\([^)]*\)\s*/, ""), currentAgentId || null);
      } catch { /* ignore */ }
      turnState.isAgentSpeaking = false;
    }
  }

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
    provider: config.stt.provider,
    sonioxKey: config.sonioxKey,
    model: config.stt.model,
    language: config.stt.language,
    sampleRate: config.stt.sampleRate,
    endpointingMs: config.stt.endpointingMs,
    utteranceEndMs: config.stt.utteranceEndMs,
    keyterms: sttExtraKeyterms,
    soniox: config.stt.soniox,
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

  let utteranceChain = Promise.resolve();
  stt.on("utterance_end", (userText) => {
    const cleanedText = String(userText || "").trim();
    if (isProcessing && cleanedText && isWakeCancelText(cleanedText, agents, selectedAgentIds)) {
      handleWakeCancelAbort(cleanedText)
        .catch((err) => console.error("❌  wake+cancel handler error:", err.message || err));
      return;
    }

    utteranceChain = utteranceChain
      .then(() => handleUtteranceEnd(userText))
      .catch((err) => console.error("❌  utterance_end handler error:", err.message || err));
  });

  async function handleUtteranceEnd(userText) {
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
      const farewellVoice = config.exitFarewell || "[warm] 了解です！退出しますね。お疲れさまでした！";
      // Strip leading emotion tag (S1 paren or S2 bracket) for clean console log
      const farewellLog = farewellVoice.replace(/^[\[(][^\])]*[\])]\s*/, "");
      turnState.isAgentSpeaking = true;
      try {
        await speakSentence(farewellVoice, null);
      } catch {
        // ignore TTS error during exit
      }
      turnState.isAgentSpeaking = false;

      appendConversationEntry("assistant", farewellLog, currentAgentId || null);

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
    // (e.g. "{agentName}、ストップ"). Handled in wake+cancel block below.

    let currentWakeEntry = null;

    // Wake word detection
    {
      // Multi-participant mode: create entry with sequence number
      utteranceSeq += 1;
      const wakeResult = detectWakeAgent(cleanedText, agents, selectedAgentIds, defaultAgentId);
      const entry = {
        seq: utteranceSeq,
        text: cleanedText,
        timestamp: new Date().toISOString(),
        addressed: wakeResult.detected,
        injectToLlm: wakeResult.detected,
        sentToLlm: false,
      };

      if (!wakeResult.detected) {
        // No wake word: keep for wake re-scan/ops logs, but don't inject into LLM context.
        pushTranscriptEntry(entry);
        console.log(`🔇  [会議音声・未指名] "${cleanedText.slice(0, 50)}..."`);
        appendConversationEntry("user", `[会議音声・未指名] ${cleanedText}`, currentAgentId || null);
        return;
      }

      // Wake word detected
      if (wakeResult.agentId && wakeResult.agentId !== currentAgentId) {
        switchAgent(wakeResult.agentId);
      }
      currentWakeEntry = entry;

      // Injection Gate logic
      if (gateState === "OPEN") {
        gateState = "CLOSED";
        turnState.gateState = gateState;
        // Keep the current turn in the ordered buffer; context selection excludes it.
        pushTranscriptEntry(entry);
        console.log("🔔  Wake word detected! Gate → CLOSED");
      } else {
        // Gate is CLOSED: check for wake+cancel combo (immediate abort)
        if (isWakeCancelText(cleanedText, agents, selectedAgentIds)) {
          await handleWakeCancelAbort(cleanedText);
          return;
        }
        // Regular wake during CLOSED: queue (don't add to buffer — merge happens in finally)
        console.log(`⏳  Wake word detected but gate CLOSED, queuing: "${cleanedText.slice(0, 50)}..."`);
        enqueuePending(entry);
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
    const prompt = buildMeetingContextPromptWithEntries(
      transcriptBuffer,
      currentWakeEntry,
      cleanedText,
      meetingContextOptions
    );
    console.log(`📋  Injected meeting context (${transcriptBuffer.length} buffered entries)`);

    // Process user input
    const forceImmediateAck = !hasSentInitialWakeAck;
    if (forceImmediateAck) {
      hasSentInitialWakeAck = true;
    }
    await processUserInput(prompt.text, {
      forceImmediateAck,
      ackSourceText: cleanedText,
      contextEntries: prompt.entries,
      currentEntry: currentWakeEntry,
    });
  }

  stt.on("error", (err) => {
    console.error("❌  STT error:", err.message || err);
  });

  // ── Process user input: LLM → TTS ──────────────────────────────
  async function processUserInput(userText, options = {}) {
    gateState = "CLOSED";
    turnState.gateState = gateState;
    const {
      hasRetriedOnFallback = false,
      forceImmediateAck = false,
      ackSourceText = userText,
      contextEntries = [],
      currentEntry = null,
    } = options;
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

    // Returns Promise<boolean>: true if Gateway accepted the handoff (HTTP 2xx/3xx),
    // false on HTTP error / network error / timeout. Caller uses this to decide
    // whether to speak the "shared to Slack" line — we no longer claim Slack
    // before the handoff actually succeeds.
    const requestTimeoutHandoff = (transcript) => {
      const trimmed = String(transcript || "").trim();
      if (!trimmed) {
        console.log("⏭️  Timeout handoff skipped (empty transcript)");
        return Promise.resolve(false);
      }

      if (!agentState.openclawUrl || !agentState.openclawToken) {
        console.log("⏭️  Timeout handoff skipped (OpenClaw Gateway unavailable)");
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        let settled = false;
        const finish = (success) => {
          if (settled) return;
          settled = true;
          resolve(success);
        };

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
            // Do not hardcode a foundation model; let Gateway choose.
            model: agentState.model || config.llm.model || "openclaw",
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
              const ok = res.statusCode >= 200 && res.statusCode < 400;
              if (!ok) console.error(`❌  Timeout handoff failed: HTTP ${res.statusCode}`);
              finish(ok);
            }
          );

          req.on("error", (err) => {
            console.error("❌  Timeout handoff request error:", err.message);
            finish(false);
          });

          req.setTimeout(5_000, () => {
            req.destroy(new Error("Timeout handoff request timeout"));
            finish(false);
          });

          req.write(body);
          req.end();

          console.log(`🔄  Timeout handoff spawned for: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}"`);
        } catch (err) {
          console.error("❌  Timeout handoff setup error:", err.message);
          finish(false);
        }
      });
    };

    const maybeSpeakLlmTimeoutFallback = async () => {
      if (!llmFirstResponseTimedOut || llmTimeoutFallbackPlayed) return;
      llmTimeoutFallbackPlayed = true;

      stopProgressTimer();
      turnState.isAgentSpeaking = true;
      const timeoutMsg = config.timeoutFallback || LLM_TIMEOUT_FALLBACK_VOICE;
      try {
        await speakSentence(timeoutMsg, null);
      } catch { /* ignore TTS error during fallback */ }
      appendAssistantLog(timeoutMsg);

      // Release barge-in window so the user can cancel/redirect during the
      // up-to-5s handoff await. Without this, Caty appears deaf for ~8-9s
      // between "ちょっと時間がかかってるね" and the Slack confirmation.
      turnState.isAgentSpeaking = false;
      turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);

      if (!handoffAttempted) {
        const transcriptForHandoff = String(lastUserTranscript || "").trim();
        if (transcriptForHandoff) {
          handoffAttempted = true;
          // Block the spoken Slack confirmation on actual handoff success
          // so we never tell the user we shared something we did not.
          const success = await requestTimeoutHandoff(transcriptForHandoff);
          // If user already barged-in or aborted during the handoff await,
          // skip the followup line — they have moved on.
          if (abort.signal.aborted) return;
          turnState.isAgentSpeaking = true;
          const followup = success ? HANDOFF_SUCCESS_VOICE : HANDOFF_FAILURE_VOICE;
          try {
            await speakSentence(followup, null);
          } catch { /* ignore TTS error during fallback */ }
          appendAssistantLog(followup.replace(/^\([^)]*\)\s*/, ""));
          turnState.isAgentSpeaking = false;
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

      const ping = pickProgressPing(progressPingIndex, config.progressPings);
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
      const ackDecisionText = String(ackSourceText ?? userText ?? "");
      if ((forceImmediateAck || shouldSendImmediateAck(ackDecisionText)) && !abort.signal.aborted) {
        const ack = pickImmediateAck(ackDecisionText, currentAgentConfig.ackVariants || config.ackVariants);
        turnState.isAgentSpeaking = true;
        console.log(`⚡  Immediate ack: "${ack}"`);
        await speakSentence(ack, abort.signal);
        if (!abort.signal.aborted) {
          appendAssistantLog(ack.replace(/^\([^)]*\)\s*/, ""));
          // Insert silence after ack (same as greeting→purpose transition)
          // so the first LLM sentence doesn't collide with the ack playback.
          const ackSilence = generateSilence(SENTENCE_PAUSE_MS, config.tts.sampleRate);
          onAudio(ackSilence);
          // Count ack as a spoken segment so the first LLM split-point sentence
          // also gets a pause via the spokenSentenceCount > 0 check.
          spokenSentenceCount = 1;
          // Release isAgentSpeaking so progress pings can fire while the LLM
          // is still thinking. inputCooldownUntil absorbs any echo from the
          // ack playback so STT noise doesn't trigger barge-in/re-entry.
          turnState.isAgentSpeaking = false;
          turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);
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
              const silence = generateSilence(split.pauseMs, config.tts.sampleRate);
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
        if (fullResponse.trim()) {
          markSentToLlm(contextEntries, currentEntry);
        }
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
        markSentToLlm(contextEntries, currentEntry);
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
        await processUserInput(userText, {
          hasRetriedOnFallback: true,
          ackSourceText,
          contextEntries,
          currentEntry,
        });
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

      try {
        // Multi-participant mode: re-scan pending before making OPEN visible.
        if (pendingQueue.length > 0) {
          for (const entry of pendingQueue) {
            pushTranscriptEntry(entry);
          }
          const pendingCopy = [...pendingQueue];
          pendingQueue.length = 0;

          for (let i = 0; i < pendingCopy.length; i++) {
            const entry = pendingCopy[i];
            const wakeResult = detectWakeAgent(entry.text, agents, selectedAgentIds, defaultAgentId);
            if (!wakeResult.detected) continue;

            console.log(`🔔  Pending wake word found: "${entry.text.slice(0, 50)}"`);
            if (wakeResult.agentId && wakeResult.agentId !== currentAgentId) {
              switchAgent(wakeResult.agentId);
            }
            // Keep later pending turns bounded; the current replay keeps the gate CLOSED.
            for (const remaining of pendingCopy.slice(i + 1)) {
              enqueuePending(remaining);
            }
            const pendingPrompt = buildMeetingContextPromptWithEntries(
              transcriptBuffer,
              entry,
              entry.text,
              meetingContextOptions
            );
            appendConversationEntry("user", entry.text, currentAgentId || null);
            lastUserTranscript = entry.text;
            const forceImmediateAck = !hasSentInitialWakeAck;
            if (forceImmediateAck) {
              hasSentInitialWakeAck = true;
            }
            await processUserInput(pendingPrompt.text, {
              forceImmediateAck,
              ackSourceText: entry.text,
              contextEntries: pendingPrompt.entries,
              currentEntry: entry,
            });
            return; // Recursive replay owns the final OPEN transition.
          }
        }
      } catch (err) {
        console.error("❌  Pending replay error:", err.message || err);
      }

      gateState = "OPEN";
      turnState.gateState = gateState;
    }
  }

  // ── TTS: synthesize one sentence ────────────────────────────────
  // Public entry: queues every speakSentence call so independent utterances
  // (ack, progress ping, LLM chunks, timeout fallback, greeting…) never
  // overlap into onAudio. A short silence (TTS_GAP_MS) is inserted between
  // utterances for natural breath; skipped before the very first speak.
  async function speakSentence(text, signal) {
    const prev = ttsLock;
    let release;
    ttsLock = new Promise((r) => { release = r; });
    try {
      await prev.catch(() => {});
      if (signal?.aborted) return;
      if (ttsHasSpoken && TTS_GAP_MS > 0) {
        const gap = generateSilence(TTS_GAP_MS, config.tts.sampleRate);
        onAudio(gap);
      }
      ttsHasSpoken = true;
      await _speakSentenceRaw(text, signal);
    } finally {
      release();
    }
  }

  async function _speakSentenceRaw(text, signal) {
    try {
      await synthesize(text, {
        apiKey: fishKey,
        referenceId: agentState.voiceId || config.tts.referenceId || null,
        sampleRate: config.tts.sampleRate,
        latency: config.tts.latency,
        speed: config.tts.speed,
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
        const silence = generateSilence(SENTENCE_PAUSE_MS || 500, config.tts.sampleRate);
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
  const api = {
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
  if (options._testExposeInternals) {
    api._test = {
      handleUtteranceEnd,
      getGateState: () => gateState,
      getPendingQueueLength: () => pendingQueue.length,
    };
  }
  return api;
}

module.exports = {
  createPipeline,
  _test: {
    selectMeetingContextEntries,
    isWakeCancelText,
    buildMeetingContextBlock,
    buildMeetingContextPrompt,
    buildMeetingContextPromptWithEntries,
  },
};
