// pipeline.js — Orchestrates STT → LLM → TTS pipeline
// Replaces Deepgram Voice Agent (all-in-one) with decomposed components

const { createLlmProvider } = require("./llm-provider");
const { synthesize } = require("./tts-fish");
const { createTtsCache } = require("./tts-cache");
const { getExitCommands, detectExitIntent } = require("./exit-handler");
const { shouldSuppressReply, stripEmojis, stripRareScriptCharacters, extractChatTags } = require("./speech-policy");
const { recordEvent } = require("./metrics");
const gatewayEventsClient = require("./gateway-events");
const { DEFAULT_MESSAGES, renderTemplate, resolveMessages } = require("./messages");

const DEFAULT_RESOLVED_MESSAGES = resolveMessages();

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
const TTS_LEAD_MS = Number(process.env.TTS_LEAD_MS || 200);
const COMFORT_NOISE_AMPLITUDE = Number(process.env.COMFORT_NOISE_AMPLITUDE || 30);

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
const CANCEL_RE = new RegExp(DEFAULT_MESSAGES.regex.cancelPattern, DEFAULT_MESSAGES.regex.cancelFlags);
function compileRegex(pattern, flags) {
  return new RegExp(pattern, flags);
}

function regexFromConfig(regexConfig, patternKey, flagsKey) {
  return compileRegex(
    regexConfig?.[patternKey] || DEFAULT_RESOLVED_MESSAGES.regex[patternKey],
    regexConfig?.[flagsKey] || DEFAULT_RESOLVED_MESSAGES.regex[flagsKey]
  );
}

function isCancelWord(text, regexConfig = null) {
  const cancelRe = regexConfig ? regexFromConfig(regexConfig, "cancelPattern", "cancelFlags") : CANCEL_RE;
  return cancelRe.test(text.trim());
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

function isWakeCancelText(text, agents = null, selectedAgentIds = [], regexConfig = null) {
  const cleaned = String(text || "").trim();
  return isCancelWord(stripWakePrefix(cleaned, agents, selectedAgentIds), regexConfig) || isCancelWord(cleaned, regexConfig);
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
function isExitCommand(text, agents = null, selectedAgentIds = [], defaultAgentId = null, agentProfile = null, exitConfig = null) {
  const resolvedAgentProfile = agentProfile?.exitCommands?.length
    ? agentProfile
    : { ...(agentProfile || {}), exitCommands: exitConfig?.commands || DEFAULT_MESSAGES.exit.commands };
  // Use exit-handler for primary detection
  if (detectExitIntent(text, agents, selectedAgentIds, defaultAgentId, resolvedAgentProfile)) {
    return true;
  }

  // Also check wake word + exit pattern: e.g. "{agentName}、退出して"
  const exitCmds = getExitCommands(resolvedAgentProfile);
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
 * Generate a Buffer of PCM "silence" (16-bit LE) for a given duration.
 * Not pure digital zero: fills with low-amplitude white dither so downstream
 * VAD/noise-gates see a live signal instead of true silence. Set
 * COMFORT_NOISE_AMPLITUDE=0 to restore byte-exact pure zeros.
 */
function generateSilence(durationMs, sampleRate) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2); // 2 bytes per int16 sample
  if (COMFORT_NOISE_AMPLITUDE > 0) {
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.floor(Math.random() * (2 * COMFORT_NOISE_AMPLITUDE + 1)) - COMFORT_NOISE_AMPLITUDE;
      buf.writeInt16LE(sample, i * 2);
    }
  }
  return buf;
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

function previewForLog(text, max = 160) {
  const input = String(text || "").replace(/\s+/g, " ").trim();
  return input.length > max ? `${input.slice(0, max)}...` : input;
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
  new RegExp(DEFAULT_MESSAGES.regex.immediateAckPattern, DEFAULT_MESSAGES.regex.immediateAckFlags),
  new RegExp(DEFAULT_MESSAGES.regex.immediateAckEnglishPattern, DEFAULT_MESSAGES.regex.immediateAckEnglishFlags),
];

// Fixed lines below: every line is anchored with an S2-Pro emotion tag.
// Tagless input causes S2-Pro to drift (sudden volume / pitch / voice quality
// changes), so we use [soft voice] as the default anchor across ack / progress
// / handoff. Two moments use a different tag because the moment genuinely
// calls for one: timeout fallback (apology) → [empathetic, unhurried],
// exit farewell → [warm].
const DEFAULT_ACK_VARIANTS = [
  ...DEFAULT_MESSAGES.speech.ackVariants,
];

const PROGRESS_PING_VARIANTS = [
  ...DEFAULT_MESSAGES.speech.progressPings,
];

// Spoken first when the LLM never returns a chunk within the timeout budget.
// Intentionally does NOT promise Slack — that would be a lie if the handoff
// itself fails. The real Slack-confirmation line is spoken later, only on
// success of requestTimeoutHandoff().
const LLM_TIMEOUT_FALLBACK_VOICE = DEFAULT_MESSAGES.speech.timeoutFallback;
const FORCED_DELEGATION_FALLBACK_VOICE = DEFAULT_MESSAGES.speech.forcedDelegationFallback;
const HANDOFF_SUCCESS_VOICE = DEFAULT_MESSAGES.speech.handoffSuccess;
const HANDOFF_FAILURE_VOICE = DEFAULT_MESSAGES.speech.handoffFailure;
const FORCED_DELEGATION_FALLBACK_VOICE_MEET = DEFAULT_MESSAGES.speech.forcedDelegationFallbackMeet;
const HANDOFF_UNCONFIRMED_VOICE_MEET = DEFAULT_MESSAGES.speech.handoffUnconfirmedMeet;
const HANDOFF_BUSY_VOICE_MEET = DEFAULT_MESSAGES.speech.handoffBusyMeet;
const REPORT_POST_UNKNOWN_VOICE = DEFAULT_MESSAGES.speech.reportPostUnknown;
const CIRCUIT_BREAKER_RECOVERY_NOTICE = DEFAULT_MESSAGES.speech.circuitBreakerRecoveryNotice;
const HANDOFF_INFLIGHT_TTL_MS = 5 * 60 * 1000;
const PENDING_HANDOFF_TTL_MS = 5 * 60 * 1000;
const PENDING_HANDOFF_MAX = 5;
const REPORT_VOICE_DROP_MS = 90_000;
const REPORT_QUEUE_MAX = 10;
const LIVE_USER_SPEECH_HOLD_MS = 1_200;
const SEEN_RUN_ID_MAX = 1000;
const SHORT_UTTERANCE_PING_PATTERNS = [
  ...DEFAULT_MESSAGES.regex.shortUtterancePingPatterns.map((pattern) => new RegExp(pattern, DEFAULT_MESSAGES.regex.shortUtterancePingFlags)),
];

function shouldSendImmediateAck(text) {
  // Always ack on any addressed turn so the user never hears silence after
  // calling the agent. The caller already gates this to addressed (post-wake)
  // turns, and exit/cancel turns short-circuit before reaching the ack path.
  // Pattern matching is preserved internally so pickImmediateAck() can pick
  // a task-flavored variant for request-like utterances.
  if (!ENABLE_IMMEDIATE_ACK) return false;
  const t = String(text || "").trim();
  if (!t) return false;
  return true;
}

function pickImmediateAck(text, agentAckVariants = null, regexConfig = null) {
  const variants = agentAckVariants && agentAckVariants.length > 0
    ? agentAckVariants
    : DEFAULT_ACK_VARIANTS;
  const taskRe = regexFromConfig(regexConfig, "immediateAckTaskPattern", "immediateAckTaskFlags");
  const taskVariantRe = regexFromConfig(regexConfig, "immediateAckTaskVariantPattern", "immediateAckTaskVariantFlags");

  // Slightly prefer task-oriented wording when user asks for work.
  if (taskRe.test(String(text || ""))) {
    const taskVariant = variants.find((v) => taskVariantRe.test(v));
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

function collectFixedTtsPhrases(config, greeting) {
  // The dispatcher falls unknown names back to OpenClaw, so only the one
  // explicitly supported standalone provider is excluded here.
  const isOpenclaw = String(config?.llm?.provider || "openclaw").toLowerCase() !== "openai-compatible";
  const gatewayEventsEnabled = isOpenclaw && config?.gatewayEvents?.enabled === true;
  const messages = config?.messages || DEFAULT_RESOLVED_MESSAGES.speech;
  return [
    ...(config.ackVariants && config.ackVariants.length > 0 ? config.ackVariants : messages.ackVariants),
    ...(config.progressPings && config.progressPings.length > 0 ? config.progressPings : messages.progressPings),
    greeting || config.greeting,
    config.exitFarewell || messages.exitFarewell,
    config.cancelAck,
    ...(isOpenclaw && Number(config?.llm?.firstTokenDelegateMs || 0) > 0 ? [messages.forcedDelegationFallback] : []),
    config.timeoutFallback || messages.timeoutFallback,
    messages.handoffSuccess,
    messages.handoffFailure,
    ...(gatewayEventsEnabled ? [
      messages.handoffUnconfirmedMeet,
      messages.handoffBusyMeet,
      messages.circuitBreakerRecoveryNotice,
    ] : []),
  ].filter(Boolean);
}

function compileShortUtterancePingPatterns(regexConfig = null) {
  const patterns = regexConfig?.shortUtterancePingPatterns || DEFAULT_RESOLVED_MESSAGES.regex.shortUtterancePingPatterns;
  const flags = regexConfig?.shortUtterancePingFlags || DEFAULT_RESOLVED_MESSAGES.regex.shortUtterancePingFlags;
  return patterns.map((pattern) => new RegExp(pattern, flags));
}

function shouldForceDelegate({ thresholdMs, firstChunkSeen, abortSignal, isProcessing }) {
  // Lane seam: future fast/work intent policy can replace this timer decision
  // without touching the abort, spoken handoff, or metrics sequence below.
  return thresholdMs > 0 && !firstChunkSeen && !abortSignal?.aborted && isProcessing;
}

function getShortUtteranceSkipReason(text, thresholdChars, regexConfig = null) {
  const cleaned = String(text || "").trim();
  const threshold = Number(thresholdChars || 0);
  if (!(threshold > 0)) return null;
  if (cleaned.length > 0 && cleaned.length < threshold) {
    const patterns = regexConfig ? compileShortUtterancePingPatterns(regexConfig) : SHORT_UTTERANCE_PING_PATTERNS;
    return patterns.some((re) => re.test(cleaned)) ? "ping" : "short";
  }
  return null;
}

function rememberBounded(set, key, max = SEEN_RUN_ID_MAX) {
  set.add(key);
  if (set.size <= max) return;
  const first = set.values().next().value;
  if (first !== undefined) set.delete(first);
}

function isTtsCacheEnabled() {
  return process.env.TTS_CACHE_ENABLED !== "false";
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
  // onAudio. ttsHasSpoken selects first-utterance lead vs later gaps.
  let ttsLock = Promise.resolve();
  let ttsHasSpoken = false;
  const usePipelineTtsCache = !options._testExposeInternals;
  const ttsCache = createTtsCache({ synthesizeFn: synthesize });
  const prewarmAbort = new AbortController();

  const dgKey = config.dgKey;
  const fishKey = config.fishKey;
  const selectedAgentIds = Array.isArray(options.selectedAgentIds) ? options.selectedAgentIds.filter(Boolean) : [];
  const hasSelectedAgents = selectedAgentIds.length > 0;
  const agents = options.agents || {};
  const agentProfile = options.agentProfile || null;
  const onChatMessage = options.onChatMessage;
  const defaultAgentId = options.defaultAgentId || selectedAgentIds[0] || null;
  let currentAgentId = defaultAgentId || agentProfile?.agentId || "agent";
  const gatewayEventsConfig = config.gatewayEvents || {};
  const llmProvider = createLlmProvider({ provider: config?.llm?.provider });
  const isOpenclawProvider = llmProvider.name === "openclaw";
  const gatewayEventsEnabled = isOpenclawProvider && gatewayEventsConfig.enabled === true;
  const clientHistory = new Map();
  const resolvedSpeech = config.messages || DEFAULT_RESOLVED_MESSAGES.speech;
  const resolvedRegex = config.regex || DEFAULT_RESOLVED_MESSAGES.regex;
  const resolvedPrompts = config.prompts || DEFAULT_RESOLVED_MESSAGES.prompts;
  const resolvedDelegation = config.delegation || DEFAULT_RESOLVED_MESSAGES.delegation;
  const reportResults = [];
  const reportQueue = [];
  const handoffInflight = new Map();
  const relayedDelegateRunIds = new Set();
  const compactTimers = new Set();
  const pendingHandoffQueue = [];
  let lastUserSpeechAt = 0;
  let liveUserSpeechUntil = 0;
  let lastHandoffDispatchAt = 0;
  let pendingHandoffSeq = 0;
  let pendingHandoffDrainTimer = null;
  let greetingTimer = null;
  let reportDrainSleepTimer = null;
  let reportDrainSleepResolve = null;
  let reportQueueDraining = false;
  let stopped = false;
  let consecutiveTimerATimeouts = 0;
  let circuitBreakerOpen = false;
  let circuitBreakerNoticeQueued = false;

  const agentState = {
    openclawUrl: config.llm.gateway?.url,
    openclawToken: config.llm.gateway?.token,
    voiceId: config.tts.referenceId || null,
    model: config.llm.model,
    openclawSystemAddendum: config.llm.openclawSystemAddendum,
    sessionUser: `meet-${session.id}`,
  };

  function switchAgent(agentId) {
    if (!agentId || !agents[agentId]) return false;

    const oldId = currentAgentId;
    const agent = agents[agentId];

    agentState.openclawUrl = agent.gatewayUrl || config.llm.gateway?.url;
    agentState.openclawToken = agent.gatewayToken || config.llm.gateway?.token;
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

  if (isOpenclawProvider) console.log("🔗  OpenClaw Gateway モード ✨");

  // Current LLM/TTS abort controller (for interruption)
  let currentAbort = null;
  let isProcessing = false;
  let lastUserTranscript = "";
  let hasSentInitialWakeAck = false;
  let metricsTurnSeq = 0;
  const ttsPlaybackStartRecordedTurnIds = new Set();

  // Multi-participant meeting mode: Injection Gate (wake mode only)
  const transcriptBuffer = []; // Accumulates all utterances (with seq numbers)
  const pendingQueue = []; // Utterances that arrive while Gate is CLOSED
  let gateState = "OPEN"; // "OPEN" = accepting input, "CLOSED" = processing
  let utteranceSeq = 0; // Monotonic sequence counter for ordering
  const isWakeMode = session?.config?.wakeMode === "wake" || config?.wakeMode === "wake";
  const meetingContextOptions = {
    includeUnaddressed:
      ENABLE_MEETING_CONTEXT_INJECTION &&
      isWakeMode,
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
        await speakSentence(cancelMsg, null, { cacheable: true });
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

  function nextMetricsTurnId() {
    metricsTurnSeq += 1;
    return `${session?.id || "meeting"}-${metricsTurnSeq}`;
  }

  function recordMetric(type, fields = {}) {
    if (!fields.turn_id) return;
    recordEvent(type, {
      meeting_id: session?.id || null,
      session_id: session?.id || null,
      agent_id: currentAgentId || null,
      ...fields,
    });
  }

  function recordGatewayMetric(type, fields = {}) {
    recordEvent(type, {
      meeting_id: session?.id || null,
      session_id: session?.id || null,
      agent_id: currentAgentId || null,
      ...fields,
    });
  }

  function currentParentSessionKey() {
    return gatewayEventsClient.buildSessionKey(
      agentState.sessionUser,
      gatewayEventsConfig.agentId || "main"
    );
  }

  function currentDelegateSessionKey() {
    return gatewayEventsClient.buildSessionKey(
      `${agentState.sessionUser}-delegate`,
      gatewayEventsConfig.agentId || "main"
    );
  }

  async function compactParentSession(reason = "unspecified") {
    if (!gatewayEventsEnabled || stopped) return false;
    try {
      const maxLines = Number(gatewayEventsConfig.parentCompactMaxLines ?? 0);
      const result = await gatewayEventsClient.compactSession(
        agentState.sessionUser,
        maxLines > 0 ? { maxLines } : {}
      );
      const ok = result?.ok === true;
      recordGatewayMetric("parent_compact", {
        ok,
        compacted: result?.compacted === true,
        reason,
        ...(result?.reason ? { error: String(result.reason).slice(0, 120) } : {}),
      });
      if (!ok) {
        console.warn(`⚠️  parent compact failed (${reason}): ${result?.reason || "unknown"}`);
      }
      return ok;
    } catch (err) {
      console.warn(`⚠️  parent compact failed (${reason}):`, err.message || err);
      recordGatewayMetric("parent_compact", { ok: false, reason, error: String(err?.message || err).slice(0, 120) });
      return false;
    }
  }

  function scheduleParentCompact(reason = "unspecified", delayMs = null, attempt = 0) {
    if (!gatewayEventsEnabled || stopped) return;
    const delay = delayMs ?? Number(gatewayEventsConfig.parentCompactDelayMs ?? 5_000);
    const timer = setTimeout(() => {
      compactTimers.delete(timer);
      if (stopped) return;
      if (isProcessing && attempt < 3) {
        scheduleParentCompact(reason, delay, attempt + 1);
        return;
      }
      compactParentSession(reason).catch(() => {});
    }, Math.max(0, delay));
    timer.unref?.();
    compactTimers.add(timer);
  }

  function setCircuitBreakerOpen() {
    if (!gatewayEventsEnabled || circuitBreakerOpen) return;
    const threshold = Number(gatewayEventsConfig.circuitBreakerTimeouts ?? 2);
    if (!(threshold > 0) || consecutiveTimerATimeouts < threshold) return;
    circuitBreakerOpen = true;
    circuitBreakerNoticeQueued = false;
    recordGatewayMetric("circuit_breaker", {
      state: "open",
      consecutive_timeouts: consecutiveTimerATimeouts,
    });
    scheduleParentCompact("circuit_breaker", 0);
    if (!circuitBreakerNoticeQueued) {
      circuitBreakerNoticeQueued = true;
      enqueueReportVoiceLine(resolvedSpeech.circuitBreakerRecoveryNotice);
    }
  }

  function recordParentFirstTokenSuccess() {
    if (!gatewayEventsEnabled) return;
    const hadTimeouts = consecutiveTimerATimeouts > 0;
    consecutiveTimerATimeouts = 0;
    if (circuitBreakerOpen) {
      circuitBreakerOpen = false;
      circuitBreakerNoticeQueued = false;
      recordGatewayMetric("circuit_breaker", {
        state: "close",
        consecutive_timeouts: 0,
      });
    } else if (hadTimeouts) {
      circuitBreakerNoticeQueued = false;
    }
  }

  function pruneHandoffInflight(now = Date.now()) {
    for (const [key, item] of handoffInflight) {
      if (now - item.dispatchedAt >= HANDOFF_INFLIGHT_TTL_MS || item.completed === true) {
        handoffInflight.delete(key);
      }
    }
    syncGatewayDelegationState();
  }

  function activeHandoffInflightCount() {
    let count = 0;
    for (const item of handoffInflight.values()) {
      if (item.relayCompleted === true) continue;
      count += 1;
    }
    return count;
  }

  function canDispatchHandoff(now = Date.now()) {
    if (!gatewayEventsEnabled) return true;
    pruneHandoffInflight(now);
    const max = Number(gatewayEventsConfig.handoffInflightMax ?? 2);
    if (max >= 0 && activeHandoffInflightCount() >= max) return false;
    const cooldownMs = Number(gatewayEventsConfig.handoffCooldownMs ?? 20_000);
    return !(cooldownMs > 0 && lastHandoffDispatchAt > 0 && now - lastHandoffDispatchAt < cooldownMs);
  }

  function syncGatewayDelegationState() {
    session.gatewayDelegationState = {
      inFlightCount: activeHandoffInflightCount(),
      pendingQueueCount: pendingHandoffQueue.length,
    };
  }

  function clearReportDrainSleep() {
    if (reportDrainSleepTimer) {
      clearTimeout(reportDrainSleepTimer);
      reportDrainSleepTimer = null;
    }
    if (reportDrainSleepResolve) {
      const resolve = reportDrainSleepResolve;
      reportDrainSleepResolve = null;
      resolve();
    }
  }

  function waitForReportDrainGap(ms) {
    clearReportDrainSleep();
    return new Promise((resolve) => {
      reportDrainSleepResolve = resolve;
      reportDrainSleepTimer = setTimeout(() => {
        reportDrainSleepTimer = null;
        reportDrainSleepResolve = null;
        resolve();
      }, ms);
      reportDrainSleepTimer.unref?.();
    });
  }

  function markHandoffDispatched(label, source = "forced", now = Date.now(), options = {}) {
    if (!gatewayEventsEnabled) return null;
    lastHandoffDispatchAt = now;
    const key = `pending:${source}:${now}:${handoffInflight.size}`;
    handoffInflight.set(key, {
      label: label || resolvedDelegation.defaultLabel,
      source,
      dispatchedAt: now,
      utteranceExcerpt: previewForLog(options.utteranceExcerpt || label || "", 80),
      spawnAtMs: null,
      completed: false,
      spawnSeen: false,
      relayCompleted: false,
    });
    recordGatewayMetric("handoff_received", {
      source,
      pending_key: key,
      inflight_count: handoffInflight.size,
    });
    syncGatewayDelegationState();
    return key;
  }

  function prunePendingHandoffs(now = Date.now()) {
    for (let i = 0; i < pendingHandoffQueue.length;) {
      const item = pendingHandoffQueue[i];
      if (now - item.enqueuedAt >= PENDING_HANDOFF_TTL_MS) {
        pendingHandoffQueue.splice(i, 1);
        console.warn("⚠️  pending handoff dropped after TTL:", item.label);
        recordGatewayMetric("handoff_dropped", { reason: "ttl", label: item.label });
        continue;
      }
      i += 1;
    }
    syncGatewayDelegationState();
  }

  function schedulePendingHandoffDrain(delayMs = null) {
    if (!gatewayEventsEnabled || stopped) return;
    if (pendingHandoffDrainTimer) clearTimeout(pendingHandoffDrainTimer);
    const cooldownMs = Number(gatewayEventsConfig.handoffCooldownMs ?? 20_000);
    const now = Date.now();
    const nextCooldownAt = cooldownMs > 0 && lastHandoffDispatchAt > 0
      ? Math.max(0, lastHandoffDispatchAt + cooldownMs - now)
      : 0;
    const delay = delayMs ?? Math.min(
      PENDING_HANDOFF_TTL_MS,
      Math.max(100, nextCooldownAt || 100)
    );
    pendingHandoffDrainTimer = setTimeout(() => {
      pendingHandoffDrainTimer = null;
      drainPendingHandoffs().catch((err) => {
        console.warn("⚠️  pending handoff drain failed:", err.message || err);
      });
    }, delay);
    pendingHandoffDrainTimer.unref?.();
  }

  function enqueuePendingHandoff(transcript, label, dispatch) {
    prunePendingHandoffs();
    if (pendingHandoffQueue.length >= PENDING_HANDOFF_MAX) {
      recordGatewayMetric("handoff_dropped", { reason: "queue_full", label });
      return false;
    }
    pendingHandoffSeq += 1;
    pendingHandoffQueue.push({
      id: pendingHandoffSeq,
      transcript,
      label,
      dispatch,
      enqueuedAt: Date.now(),
      attempts: 0,
      dispatching: false,
    });
    syncGatewayDelegationState();
    schedulePendingHandoffDrain();
    return true;
  }

  async function drainPendingHandoffs() {
    if (!gatewayEventsEnabled || stopped) return;
    prunePendingHandoffs();
    while (!stopped && pendingHandoffQueue.length > 0 && canDispatchHandoff()) {
      const item = pendingHandoffQueue[0];
      if (item.dispatching) return;
      item.dispatching = true;
      let success = false;
      try {
        success = await item.dispatch();
      } catch (err) {
        console.warn("⚠️  pending handoff dispatch threw:", err.message || err);
      }
      item.attempts = (item.attempts || 0) + 1;
      if (success) {
        pendingHandoffQueue.shift();
      } else if (item.attempts >= 3) {
        pendingHandoffQueue.shift();
        console.warn("⚠️  pending handoff dropped after dispatch failures:", item.label);
        recordGatewayMetric("handoff_dropped", { reason: "dispatch_failed", label: item.label });
      } else {
        item.dispatching = false;
      }
      syncGatewayDelegationState();
      if (!success) {
        console.warn("⚠️  pending handoff dispatch failed:", item.label);
        break;
      }
      prunePendingHandoffs();
    }
    if (pendingHandoffQueue.length > 0) schedulePendingHandoffDrain();
  }

  async function dispatchOrEnqueueHandoff(transcript, label, dispatch, options = {}) {
    if (!gatewayEventsEnabled || canDispatchHandoff()) {
      return dispatch();
    }
    if (options.shortUtterance === true) {
      recordGatewayMetric("handoff_dropped", { reason: "short_utterance", label });
      return false;
    }
    console.warn("⏳  Timeout handoff queued (in-flight cap or cooldown)");
    return enqueuePendingHandoff(transcript, label, dispatch);
  }

  function handleGatewaySubagentSpawn(evt) {
    if (!gatewayEventsEnabled) return;
    pruneHandoffInflight();
    const childKey = evt?.childKey || "";
    if (!childKey) return;
    const now = Date.now();
    let source = evt.source || "self";
    let pendingKey = null;
    let relayedPendingKey = null;
    for (const [key, item] of handoffInflight) {
      if (!key.startsWith("pending:")) continue;
      if (item.relayCompleted === true) {
        if (!relayedPendingKey) relayedPendingKey = key;
        continue;
      }
      pendingKey = key;
      source = item.source || source;
      break;
    }
    if (!pendingKey && relayedPendingKey) {
      pendingKey = relayedPendingKey;
      const relayedItem = handoffInflight.get(relayedPendingKey);
      source = relayedItem?.source || source;
    }
    const pendingItem = pendingKey ? handoffInflight.get(pendingKey) : null;
    if (pendingKey) handoffInflight.delete(pendingKey);
    const spawnAtMs = Number.isFinite(evt.spawnAtMs) ? evt.spawnAtMs : now;
    handoffInflight.set(childKey, {
      label: evt.label || resolvedDelegation.defaultLabel,
      source,
      dispatchedAt: spawnAtMs,
      spawnAtMs,
      utteranceExcerpt: pendingItem?.utteranceExcerpt || "",
      spawnSeen: true,
      completed: false,
      // User-visible tie-break: whichever surface reaches the user first wins;
      // the later path stays metrics-only to avoid double-reporting.
      relayCompleted: pendingItem?.relayCompleted === true,
    });
    syncGatewayDelegationState();
  }

  function completeOneHandoff(result) {
    pruneHandoffInflight();
    const childKey = result?.childKey || "";
    const item = childKey ? handoffInflight.get(childKey) : null;
    let elapsedMs = null;
    const spawnAtMs = Number(result?.spawnAtMs || item?.spawnAtMs || 0);
    if (spawnAtMs > 0) {
      elapsedMs = Date.now() - spawnAtMs;
    }
    if (childKey && handoffInflight.has(childKey)) {
      handoffInflight.delete(childKey);
    }
    const suppressedReport = item?.relayCompleted === true;
    recordGatewayMetric("delegation_completed", {
      label: result?.label || resolvedDelegation.defaultLabel,
      ...(elapsedMs !== null ? { elapsed_ms: elapsedMs } : {}),
      ...(suppressedReport ? { suppressed_report: true } : {}),
    });
    syncGatewayDelegationState();
    drainPendingHandoffs().catch((err) => {
      console.warn("⚠️  pending handoff drain failed:", err.message || err);
    });
    return { suppressedReport };
  }

  function appendDelegationResult(result) {
    const item = {
      timestamp: new Date().toISOString(),
      label: result.label || resolvedDelegation.defaultLabel,
      status: result.status || "ok",
      resultText: String(result.resultText || "").trim(),
    };
    reportResults.push(item);
    session.delegationResults = reportResults;
  }

  function buildCompletionChatMessage(result) {
    const label = result.label || resolvedDelegation.defaultLabel;
    const body = String(result.resultText || "").trim() || resolvedDelegation.missingResult;
    const message = stripRareScriptCharacters(stripEmojis(`${resolvedDelegation.chatPrefix}: ${label}\n${body}`)).trim();
    return message || `${resolvedDelegation.chatPrefix}: ${resolvedDelegation.missingResult}`;
  }

  function buildCompletionVoiceLine(result, chatPosted = false) {
    if (!chatPosted) return resolvedSpeech.reportPostUnknown;
    const label = stripEmojis(String(result.label || resolvedDelegation.defaultLabel)).slice(0, 40) || resolvedDelegation.defaultLabel;
    return renderTemplate(resolvedSpeech.completionVoiceTemplate, { label });
  }

  function enqueueReportVoiceLine(line) {
    if (!gatewayEventsEnabled || gatewayEventsConfig.reportVoiceEnabled === false) return;
    if (stopped) return;
    if (reportQueue.length >= REPORT_QUEUE_MAX) {
      reportQueue.shift();
      console.warn("⚠️  report voice queue overflow; dropped oldest line");
    }
    reportQueue.push({
      line,
      enqueuedAt: Date.now(),
    });
    drainReportQueue().catch((err) => {
      console.warn("⚠️  report voice queue failed:", err.message || err);
    });
  }

  async function drainReportQueue() {
    if (stopped || reportQueueDraining) return;
    reportQueueDraining = true;
    try {
      while (!stopped && reportQueue.length > 0) {
        const item = reportQueue[0];
        const gapMs = Number(gatewayEventsConfig.reportVoiceGapMs ?? 4_000);
        while (!stopped) {
          const now = Date.now();
          if (now - item.enqueuedAt > REPORT_VOICE_DROP_MS) {
            reportQueue.shift();
            break;
          }
          // Interim STT is the live user-speaking signal here: any non-noise
          // interim transcript holds this gate briefly even before utterance_end.
          const liveUserSpeaking = now < liveUserSpeechUntil;
          const userGapOk = now - lastUserSpeechAt >= gapMs && !liveUserSpeaking;
          if (!turnState.isAgentSpeaking && userGapOk && !isProcessing) {
            reportQueue.shift();
            if (stopped) break;
            turnState.isAgentSpeaking = true;
            try {
              await speakSentence(item.line, null, { cacheable: false });
              if (stopped) break;
              appendConversationEntry("assistant", item.line, currentAgentId || null);
              recordGatewayMetric("report_posted", { channel: "voice" });
            } catch {
              // Chat already carries the report.
            } finally {
              turnState.isAgentSpeaking = false;
              turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);
            }
            break;
          }
          await waitForReportDrainGap(Math.min(500, Math.max(100, gapMs || 500)));
          if (stopped) break;
        }
      }
    } finally {
      reportQueueDraining = false;
    }
  }

  async function handleGatewaySubagentCompletion(result) {
    if (!gatewayEventsEnabled) return;
    try {
      appendDelegationResult(result);
      const { suppressedReport } = completeOneHandoff(result);
      if (suppressedReport) return true;
      const chatMessage = buildCompletionChatMessage(result);
      let chatPosted = false;
      if (gatewayEventsConfig.reportChatEnabled !== false && typeof onChatMessage === "function" && chatMessage) {
        chatPosted = await Promise.resolve(onChatMessage(chatMessage))
          .then((ok) => ok === true)
          .catch((err) => {
            console.warn("⚠️  delegation chat report failed:", err.message || err);
            return false;
          });
        if (chatPosted) {
          recordGatewayMetric("report_posted", { channel: "chat" });
        } else {
          console.warn("⚠️  delegation chat report not confirmed");
        }
      }
      enqueueReportVoiceLine(buildCompletionVoiceLine(result, chatPosted));
      return true;
    } catch (err) {
      console.warn("⚠️  gateway completion handling failed:", err.message || err);
      return false;
    }
  }

  function findPendingDelegateHandoff() {
    let bestKey = null;
    let bestItem = null;
    for (const [key, item] of handoffInflight) {
      if (!key.startsWith("pending:")) continue;
      if (item.completed || item.spawnSeen) continue;
      if (item.relayCompleted) continue;
      if (item.source !== "forced" && item.source !== "delegate") continue;
      if (!bestItem || item.dispatchedAt < bestItem.dispatchedAt) {
        bestKey = key;
        bestItem = item;
      }
    }
    return bestKey ? { key: bestKey, item: bestItem } : null;
  }

  function buildDelegateReplyChatMessage(text, stale = false) {
    const body = stripRareScriptCharacters(stripEmojis(String(text || "").trim())).trim();
    if (!body) return "";
    return stale ? `${resolvedSpeech.staleCompletionVoicePrefix}${body}` : body;
  }

  async function handleGatewaySessionReply(evt) {
    if (!gatewayEventsEnabled || stopped) return false;
    if (!evt || evt.sessionKey !== currentDelegateSessionKey()) return false;
    const runId = evt.runId || "unknown";
    if (relayedDelegateRunIds.has(runId)) return true;
    const pending = findPendingDelegateHandoff();
    if (!pending) return false;

    const now = Date.now();
    const ageMs = Math.max(0, now - Number(pending.item.dispatchedAt || now));
    const freshMs = Number(gatewayEventsConfig.delegateReplyFreshMs ?? 90_000);
    const dropMs = Math.max(0, freshMs * 3);
    const fresh = freshMs <= 0 || ageMs <= freshMs;
    if (dropMs > 0 && ageMs > dropMs) {
      rememberBounded(relayedDelegateRunIds, runId);
      handoffInflight.delete(pending.key);
      recordGatewayMetric("delegate_replied_no_spawn", {
        runId,
        fresh: false,
        relayed_chat: false,
        relayed_voice: false,
        age_ms: ageMs,
      });
      syncGatewayDelegationState();
      return true;
    }

    if (shouldSuppressReply(evt.resultText)) {
      rememberBounded(relayedDelegateRunIds, runId);
      handoffInflight.delete(pending.key);
      recordGatewayMetric("delegate_replied_no_spawn", {
        runId,
        fresh,
        suppressed: true,
        relayed_chat: false,
        relayed_voice: false,
        age_ms: ageMs,
      });
      syncGatewayDelegationState();
      drainPendingHandoffs().catch((err) => {
        console.warn("⚠️  pending handoff drain failed:", err.message || err);
      });
      return true;
    }

    const chatMessage = buildDelegateReplyChatMessage(evt.resultText, !fresh);
    let chatPosted = false;
    if (chatMessage && gatewayEventsConfig.reportChatEnabled !== false && typeof onChatMessage === "function") {
      chatPosted = await Promise.resolve(onChatMessage(chatMessage))
        .then((ok) => ok === true)
        .catch((err) => {
          console.warn("⚠️  delegate reply chat relay failed:", err.message || err);
          return false;
        });
      if (chatPosted) recordGatewayMetric("report_posted", { channel: "chat", source: "delegate_reply" });
    }
    const voiceRelayed = fresh && Boolean(chatMessage) && gatewayEventsConfig.reportVoiceEnabled !== false;
    if (voiceRelayed) enqueueReportVoiceLine(chatMessage);

    rememberBounded(relayedDelegateRunIds, runId);
    const relayedToUser = chatPosted || voiceRelayed;
    if (relayedToUser) {
      pending.item.relayCompleted = true;
      pending.item.relayRunId = runId;
      pending.item.relayCompletedAt = now;
      handoffInflight.set(pending.key, pending.item);
    } else {
      handoffInflight.delete(pending.key);
    }
    recordGatewayMetric("delegate_replied_no_spawn", {
      runId,
      fresh,
      relayed_chat: chatPosted,
      relayed_voice: voiceRelayed,
      age_ms: ageMs,
    });
    syncGatewayDelegationState();
    drainPendingHandoffs().catch((err) => {
      console.warn("⚠️  pending handoff drain failed:", err.message || err);
    });
    return true;
  }

  function handleGatewayAnnounceInjected(evt) {
    if (!gatewayEventsEnabled || stopped) return false;
    if (!evt || evt.sessionKey !== currentParentSessionKey()) return false;
    recordGatewayMetric("auto_announce_injected", {
      runId: evt.runId || "unknown",
      phase: evt.phase || "",
    });
    scheduleParentCompact("auto_announce", Number(gatewayEventsConfig.parentCompactDelayMs ?? 5_000));
    return true;
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
    const now = Date.now();
    if (interim && !isNoiseInterim(interim)) {
      lastUserSpeechAt = now;
      liveUserSpeechUntil = now + LIVE_USER_SPEECH_HOLD_MS;
    }

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
    const metricsTurnId = cleanedText ? nextMetricsTurnId() : null;
    if (metricsTurnId) {
      recordMetric("utterance_end", {
        turn_id: metricsTurnId,
        transcript_char_count: cleanedText.length,
      });
    }
    if (isProcessing && cleanedText && isWakeCancelText(cleanedText, agents, selectedAgentIds, resolvedRegex)) {
      handleWakeCancelAbort(cleanedText)
        .catch((err) => console.error("❌  wake+cancel handler error:", err.message || err));
      return;
    }

    utteranceChain = utteranceChain
      .then(() => handleUtteranceEnd(userText, metricsTurnId))
      .catch((err) => console.error("❌  utterance_end handler error:", err.message || err));
  });

  async function handleUtteranceEnd(userText, metricsTurnId = null) {
    const cleanedText = String(userText || "").trim();
    if (!cleanedText) return;
    lastUserSpeechAt = Date.now();
    liveUserSpeechUntil = Date.now() + LIVE_USER_SPEECH_HOLD_MS;

    // #8 Barge-in companion: small post-utterance buffer to reduce premature turn-taking.
    if (POST_UTTERANCE_BUFFER_MS > 0) {
      await sleep(POST_UTTERANCE_BUFFER_MS);
    }

    console.log(`💬  [user] ${cleanedText}`);

    // Exit command detection
    if (config.exitDetection !== false && isExitCommand(cleanedText, agents, selectedAgentIds, defaultAgentId, agentProfile, config.exit)) {
      console.log("🚪  Exit command detected!");
      appendConversationEntry("user", cleanedText, currentAgentId || null);

      // Speak farewell and emit exit event
      const farewellVoice = config.exitFarewell || resolvedSpeech.exitFarewell;
      // Strip leading emotion tag (S1 paren or S2 bracket) for clean console log
      const farewellLog = farewellVoice.replace(/^[\[(][^\])]*[\])]\s*/, "");
      turnState.isAgentSpeaking = true;
      try {
        await speakSentence(farewellVoice, null, { cacheable: true });
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
        metricsTurnId,
      };
      if (isWakeMode && metricsTurnId) {
        recordMetric("wake_decision", {
          turn_id: metricsTurnId,
          addressed: entry.addressed,
        });
      }

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
        if (isWakeCancelText(cleanedText, agents, selectedAgentIds, resolvedRegex)) {
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
      metricsTurnId,
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
      metricsTurnId = null,
    } = options;
    isProcessing = true;
    const abort = new AbortController();
    currentAbort = abort;
    const requestAgentId = currentAgentId;

    let progressTimer = null;
    let llmTimeoutTimer = null;
    let firstTokenDelegateTimer = null;
    let firstTokenDelegateStartedAt = 0;
    let progressPingIndex = 0;
    let mainResponseStarted = false;
    let spokenSentenceCount = 0;
    let firstChunkSeen = false;
    let llmFirstResponseTimedOut = false;
    let forcedDelegationFired = false;
    let llmTimeoutFallbackPlayed = false;
    let handoffAttempted = false;
    let ttsPlaybackStartRecorded = false;
    let scheduledGatewayFallbackRetry = false;
    const shortSkipReason = gatewayEventsEnabled && !circuitBreakerOpen
      ? getShortUtteranceSkipReason(ackSourceText, gatewayEventsConfig.shortUtteranceSkipChars ?? 24, resolvedRegex)
      : null;

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

    const stopFirstTokenDelegateTimer = () => {
      if (firstTokenDelegateTimer) {
        clearTimeout(firstTokenDelegateTimer);
        firstTokenDelegateTimer = null;
      }
    };

    const stopFirstResponseTimers = () => {
      stopFirstTokenDelegateTimer();
      stopLlmTimeoutTimer();
    };

    abort.signal.addEventListener("abort", stopFirstResponseTimers, { once: true });

    const appendAssistantLog = (text) => {
      appendConversationEntry("assistant", text, currentAgentId || null);
    };

    const recordTtsPlaybackStartOnce = (text, source) => {
      if (ttsPlaybackStartRecorded) return;
      if (metricsTurnId && ttsPlaybackStartRecordedTurnIds.has(metricsTurnId)) return;
      ttsPlaybackStartRecorded = true;
      if (metricsTurnId) ttsPlaybackStartRecordedTurnIds.add(metricsTurnId);
      recordMetric("tts_playback_start", {
        turn_id: metricsTurnId,
        source,
        text_char_count: String(text || "").length,
      });
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

      if (isOpenclawProvider && (!agentState.openclawUrl || !agentState.openclawToken)) {
        console.log("⏭️  Timeout handoff skipped (OpenClaw Gateway unavailable)");
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        let settled = false;
        let gatewayModeHandoff = false;
        let handoffLabel = previewForLog(trimmed, 60);
        let handoffMarked = false;
        const finish = (success) => {
          if (settled) return;
          settled = true;
          if (success && gatewayModeHandoff && !handoffMarked) {
            handoffMarked = true;
            markHandoffDispatched(handoffLabel, "forced", Date.now(), { utteranceExcerpt: trimmed });
          }
          resolve(success);
        };

        try {
          gatewayModeHandoff = gatewayEventsEnabled === true;
          const handoffPrompt = renderTemplate(
            gatewayModeHandoff ? resolvedPrompts.timeoutHandoffGateway : resolvedPrompts.timeoutHandoffSlack,
            { request: trimmed }
          );
          const handoffSessionUser = gatewayModeHandoff && gatewayEventsConfig.handoffDelegateSession !== false
            ? `${agentState.sessionUser}-delegate`
            : agentState.sessionUser;
          if (typeof llmProvider.timeoutHandoff !== "function") {
            finish(null);
            return;
          }

          llmProvider.timeoutHandoff({
            openclawUrl: agentState.openclawUrl,
            openclawToken: agentState.openclawToken,
            model: agentState.model || config.llm.model || "openclaw",
            systemPrompt: gatewayModeHandoff
              ? resolvedPrompts.timeoutHandoffGatewaySystem
              : resolvedPrompts.timeoutHandoffSlackSystem,
            userPrompt: handoffPrompt,
            sessionUser: handoffSessionUser,
            gatewayModeHandoff,
            onDispatched: () => {
              recordMetric("handoff_requested", {
                turn_id: metricsTurnId,
                transcript_char_count: trimmed.length,
                ...(gatewayModeHandoff ? { session_user: handoffSessionUser } : {}),
              });
            },
          }).then(finish, () => finish(false));

          console.log(`🔄  Timeout handoff spawned for: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}"`);
        } catch (err) {
          console.error("❌  Timeout handoff setup error:", err.message);
          finish(false);
        }
      });
    };

    const maybeSpeakLlmTimeoutFallback = async () => {
      if ((!llmFirstResponseTimedOut && !forcedDelegationFired) || llmTimeoutFallbackPlayed) return;
      llmTimeoutFallbackPlayed = true;

      stopProgressTimer();
      turnState.isAgentSpeaking = true;
      const timeoutMsg = forcedDelegationFired
        ? (gatewayEventsEnabled ? resolvedSpeech.forcedDelegationFallbackMeet : resolvedSpeech.forcedDelegationFallback)
        : (config.timeoutFallback || resolvedSpeech.timeoutFallback);
      try {
        await speakSentence(timeoutMsg, null, {
          cacheable: true,
          onPlaybackStart: () => {
            if (forcedDelegationFired) {
              recordTtsPlaybackStartOnce(timeoutMsg, "forced_delegation");
              return;
            }
            recordMetric("timeout_fallback_fired", {
              turn_id: metricsTurnId,
              text_char_count: timeoutMsg.length,
            });
          },
        });
      } catch { /* ignore TTS error during fallback */ }
      appendAssistantLog(timeoutMsg);

      // Release barge-in window so the user can cancel/redirect during the
      // up-to-5s handoff await. Without this, the agent appears deaf for ~8-9s
      // between "ちょっと時間がかかってるね" and the Slack confirmation.
      turnState.isAgentSpeaking = false;
      turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);

      if (!handoffAttempted) {
        const transcriptForHandoff = String(lastUserTranscript || "").trim();
        if (transcriptForHandoff) {
          handoffAttempted = true;
          const handoffLabel = previewForLog(transcriptForHandoff, 60);
          const queuedShortUtterance = gatewayEventsEnabled
            && !circuitBreakerOpen
            && Boolean(getShortUtteranceSkipReason(transcriptForHandoff, gatewayEventsConfig.shortUtteranceSkipChars ?? 24, resolvedRegex));
          const success = await dispatchOrEnqueueHandoff(
            transcriptForHandoff,
            handoffLabel,
            () => requestTimeoutHandoff(transcriptForHandoff),
            { shortUtterance: queuedShortUtterance }
          );
          if (success === null) return;
          // If user already barged-in or aborted during the handoff await,
          // skip the followup line — they have moved on.
          if (abort.signal.aborted && !forcedDelegationFired) return;
          turnState.isAgentSpeaking = true;
          const followup = success
            ? (gatewayEventsEnabled ? resolvedSpeech.handoffUnconfirmedMeet : resolvedSpeech.handoffSuccess)
            : (gatewayEventsEnabled && pendingHandoffQueue.length >= PENDING_HANDOFF_MAX ? resolvedSpeech.handoffBusyMeet : resolvedSpeech.handoffFailure);
          try {
            await speakSentence(followup, null, { cacheable: true });
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
        stopFirstResponseTimers();
        abort.abort();
      }, timeoutMs);
      llmTimeoutTimer.unref?.();
    };

    const startFirstTokenDelegateTimer = () => {
      if (!isOpenclawProvider) return;
      if (gatewayEventsEnabled && shortSkipReason) {
        recordGatewayMetric("forced_delegation_skipped", {
          turn_id: metricsTurnId,
          reason: shortSkipReason,
          chars: String(ackSourceText || "").trim().length,
        });
        return;
      }
      const thresholdMs = Number(config?.llm?.firstTokenDelegateMs || 0);
      if (!(thresholdMs > 0)) return;

      firstTokenDelegateStartedAt = Date.now();
      firstTokenDelegateTimer = setTimeout(() => {
        if (!shouldForceDelegate({
          thresholdMs,
          firstChunkSeen,
          abortSignal: abort.signal,
          isProcessing,
        })) {
          return;
        }

        forcedDelegationFired = true;
        if (gatewayEventsEnabled) {
          consecutiveTimerATimeouts += 1;
          setCircuitBreakerOpen();
        }
        const elapsedMs = Date.now() - firstTokenDelegateStartedAt;
        recordMetric("forced_delegation_fired", {
          turn_id: metricsTurnId,
          threshold_ms: thresholdMs,
          elapsed_ms: elapsedMs,
        });
        console.warn(`⏱️  LLM first-token delegate threshold (${thresholdMs}ms) — aborting for handoff`);
        if (gatewayEventsEnabled && gatewayEventsConfig.forcedDelegationAbort !== false) {
          // Best-effort only: the gateway API can abort the current parent run,
          // but it cannot rotate parent session keys if that run survives.
          Promise.resolve(gatewayEventsClient.abortSession(agentState.sessionUser)).then((result) => {
            const ok = result === true || result?.ok === true;
            const attempts = Number(result?.attempts || 1);
            recordGatewayMetric("abort_requested", { ok, attempts });
          }).catch((err) => {
            console.warn("⚠️  gateway abort fire-and-forget failed:", err.message || err);
            recordGatewayMetric("abort_requested", { ok: false, attempts: 1 });
          });
        }
        stopFirstResponseTimers();
        abort.abort();
      }, thresholdMs);
      firstTokenDelegateTimer.unref?.();
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
      await speakSentence(ping, abort.signal, { cacheable: true });
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
        const ack = pickImmediateAck(ackDecisionText, currentAgentConfig.ackVariants || config.ackVariants, resolvedRegex);
        turnState.isAgentSpeaking = true;
        console.log(`⚡  Immediate ack: "${ack}"`);
        await speakSentence(ack, abort.signal, {
          cacheable: true,
          onPlaybackStart: () => recordMetric("ack_playback_start", {
            turn_id: metricsTurnId,
            ack_text: ack,
            ack_source_char_count: ackDecisionText.length,
          }),
        });
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
        progressTimer.unref?.();
      }

      // ── LLM streaming ──
      let fullResponse = "";
      let sentenceBuffer = "";
      let chatHoldback = "";

      console.log(`🤔  ${requestAgentId || "agent"} thinking…`);

      // OpenClaw Gateway manages conversation history. Standalone providers
      // receive only complete user/assistant pairs from this session; aborted
      // and failed turns are deliberately discarded.
      const historyMaxTurns = Math.max(0, Math.floor(Number(config?.llm?.historyMaxTurns ?? 12) || 0));
      const previousTurns = isOpenclawProvider
        ? []
        : historyMaxTurns > 0
          ? (clientHistory.get(agentState.sessionUser) || []).slice(-historyMaxTurns)
          : [];
      const llmMessages = [
        ...(!isOpenclawProvider && config.llm.systemPrompt
          ? [{ role: "system", content: config.llm.systemPrompt }]
          : []),
        ...previousTurns.flatMap((turn) => [
          { role: "user", content: turn.user },
          { role: "assistant", content: turn.assistant },
        ]),
        { role: "user", content: userText },
      ];

      // ★ Diagnostic: dump what we're actually sending to Gateway
      console.log(`📤  [diag] Gateway payload — agent=${requestAgentId} user=${agentState.sessionUser}`);
      console.log(`📤  [diag] user.content (${userText.length} chars): "${userText.slice(0, 200)}${userText.length > 200 ? "…" : ""}"`);
      console.log(`📤  [diag] messages count=${llmMessages.length}, model=${agentState.model}`);

      startFirstTokenDelegateTimer();
      startLlmTimeoutTimer();

      const emitChatMessage = (text, source = "chat tag") => {
        const message = String(text || "").trim();
        if (!message) return;
        if (typeof onChatMessage !== "function") {
          console.log(`💬  chatタグを送信できないため破棄 (${source}): "${previewForLog(message)}"`);
          return;
        }
        try {
          Promise.resolve(onChatMessage(message)).catch((err) => {
            console.error(`❌  chatタグ送信コールバック失敗 (${source}):`, err.message || err);
          });
        } catch (err) {
          console.error(`❌  chatタグ送信コールバック失敗 (${source}):`, err.message || err);
        }
      };

      const emitChatMessages = (chats, source = "chat tag") => {
        for (const text of chats) emitChatMessage(text, source);
      };

      for await (const chunk of llmProvider.streamChat(
        llmMessages,
        {
          openclawUrl: agentState.openclawUrl,
          openclawToken: agentState.openclawToken,
          openclawSystemAddendum: agentState.openclawSystemAddendum,
          sessionUser: agentState.sessionUser,
          model: agentState.model,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          ...(!isOpenclawProvider ? {
            baseUrl: config.llm.openaiCompatible?.baseUrl,
            apiKey: config.llm.openaiCompatible?.apiKey,
          } : {}),
          signal: abort.signal,
        }
      )) {
        if (abort.signal.aborted) break;

        if (!firstChunkSeen) {
          firstChunkSeen = true;
          stopFirstResponseTimers();
          console.log(`📥  [diag] firstChunk transition: false→true, chunk="${chunk.slice(0, 40)}"`);
          recordParentFirstTokenSuccess();
          recordMetric("first_token", {
            turn_id: metricsTurnId,
            chunk_char_count: String(chunk || "").length,
          });
        }

        fullResponse += chunk;
        sentenceBuffer += chatHoldback + chunk;
        chatHoldback = "";
        const extractedChat = extractChatTags(sentenceBuffer);
        sentenceBuffer = extractedChat.speech;
        chatHoldback = extractedChat.holdback;
        emitChatMessages(extractedChat.chats);

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
          await speakSentence(firstChunk, abort.signal, {
            onPlaybackStart: () => recordTtsPlaybackStartOnce(firstChunk, "first_chunk"),
          });
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

            await speakSentence(sentence, abort.signal, {
              onPlaybackStart: () => recordTtsPlaybackStartOnce(sentence, splitLabel),
            });
            if (abort.signal.aborted) break;
            spokenSentenceCount += 1;
          }
        }
      }

      stopFirstResponseTimers();

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
      if (chatHoldback) {
        const unterminatedPrefix = "[[[chat:";
        const markerIndex = chatHoldback.toLowerCase().indexOf(unterminatedPrefix);
        if (markerIndex === -1) {
          console.warn(`💬  chatタグ未満の保留断片を破棄しました: "${previewForLog(chatHoldback)}"`);
        } else {
          const content = chatHoldback.slice(markerIndex + unterminatedPrefix.length).trim();
          console.warn(`⚠️  未終了のchatタグを音声から除外しました: "${previewForLog(chatHoldback)}"`);
          if (content) emitChatMessage(content, "unterminated chat tag");
        }
        chatHoldback = "";
      }

      if (sentenceBuffer.trim() && sentenceBuffer.trim().length >= 3) {
        if (!mainResponseStarted) {
          mainResponseStarted = true;
          stopProgressTimer();
        }
        if (!turnState.isAgentSpeaking) {
          turnState.isAgentSpeaking = true;
        }
        console.log(`🗣️  ${requestAgentId || "agent"} speaking (flush): "${sentenceBuffer.trim()}"`);
        await speakSentence(sentenceBuffer.trim(), abort.signal, {
          onPlaybackStart: () => recordTtsPlaybackStartOnce(sentenceBuffer.trim(), "flush"),
        });
      }

      // Log assistant response
      if (fullResponse.trim()) {
        console.log(`💬  [assistant] ${fullResponse.trim()}`);
        appendConversationEntry("assistant", fullResponse.trim(), requestAgentId || null);
        if (!abort.signal.aborted && !isOpenclawProvider && historyMaxTurns > 0) {
          const turns = clientHistory.get(agentState.sessionUser) || [];
          turns.push({ user: userText, assistant: fullResponse.trim() });
          clientHistory.set(agentState.sessionUser, turns.slice(-historyMaxTurns));
        }
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
        stopProgressTimer();
        stopFirstResponseTimers();
        scheduledGatewayFallbackRetry = true;
        await processUserInput(userText, {
          hasRetriedOnFallback: true,
          ackSourceText,
          contextEntries,
          currentEntry,
          metricsTurnId,
        });
        return;
      }
      console.error("❌  Pipeline error:", err.message || err.code || JSON.stringify(err));

      // Speak error message
      try {
        turnState.isAgentSpeaking = true;
        await speakSentence(resolvedSpeech.errorVoice, abort.signal);
      } catch {
        // give up
      }
    } finally {
      stopProgressTimer();
      stopFirstResponseTimers();
      turnState.isAgentSpeaking = false;
      turnState.inputCooldownUntil = Date.now() + (config.echoCooldownMs || 300);
      isProcessing = false;
      currentAbort = null;
      if (!scheduledGatewayFallbackRetry) {
        recordMetric("turn_end", {
          turn_id: metricsTurnId,
          first_token_seen: firstChunkSeen,
          llm_timeout_fallback_played: llmTimeoutFallbackPlayed,
          handoff_attempted: handoffAttempted,
        });
      }
      if (metricsTurnId) ttsPlaybackStartRecordedTurnIds.delete(metricsTurnId);

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
              metricsTurnId: entry.metricsTurnId || null,
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
  // utterances for natural breath; the first speak gets a TTS_LEAD_MS pad.
  async function withTtsLock(fn) {
    const prev = ttsLock;
    let release;
    ttsLock = new Promise((r) => { release = r; });
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      release();
    }
  }

  async function speakSentence(text, signal, opts = {}) {
    return withTtsLock(async () => {
      if (signal?.aborted) return;
      if (!ttsHasSpoken) {
        if (TTS_LEAD_MS > 0) {
          const lead = generateSilence(TTS_LEAD_MS, config.tts.sampleRate);
          onAudio(lead);
        }
      } else if (TTS_GAP_MS > 0) {
        const gap = generateSilence(TTS_GAP_MS, config.tts.sampleRate);
        onAudio(gap);
      }
      ttsHasSpoken = true;
      await _speakSentenceRaw(text, signal, opts);
    });
  }

  async function _speakSentenceRaw(text, signal, opts = {}) {
    const cleaned = stripEmojis(text);
    if (!cleaned.trim() && String(text || "").trim()) {
      console.log("🧹 emoji-only utterance skipped");
      return;
    }
    if (cleaned !== text) {
      console.log(`🧹 stripped emojis from utterance (${text.length - cleaned.length} chars removed)`);
    }

    try {
      const synthesizeFn = opts.cacheable === true && usePipelineTtsCache ? ttsCache.synthesize : synthesize;
      let playbackStarted = false;
      await synthesizeFn(cleaned, {
        apiKey: fishKey,
        referenceId: agentState.voiceId || config.tts.referenceId || null,
        sampleRate: config.tts.sampleRate,
        latency: config.tts.latency,
        speed: config.tts.speed,
        signal,
        onAudio: (chunk) => {
          if (signal?.aborted) return;
          if (!playbackStarted) {
            playbackStarted = true;
            try {
              opts.onPlaybackStart?.();
            } catch { /* metrics callbacks must not affect audio */ }
          }
          onAudio(chunk);
        },
      });
    } catch (err) {
      if (signal?.aborted) return;
      console.error("❌  TTS error:", err.message);
    }
  }

  function resolveGreetingText() {
    let greeting = config.greeting;
    if (hasSelectedAgents && defaultAgentId && agents[defaultAgentId]) {
      const defaultGreeting = agents[defaultAgentId].greeting || config.greeting;
      const others = selectedAgentIds
        .filter((id) => id !== defaultAgentId)
        .map((id) => agents[id]?.displayName || agents[id]?.name || id)
        .filter(Boolean);
      if (others.length > 0) {
        const trimmed = String(defaultGreeting || "").replace(/[。.!！?？\s]+$/u, "");
        greeting = renderTemplate(resolvedSpeech.groupGreetingTemplate, { agents: others.join("と") });
        if (!greeting.startsWith(trimmed)) greeting = `${trimmed}${greeting}`;
      } else {
        greeting = defaultGreeting;
      }
    }
    return greeting;
  }

  function startTtsCachePrewarm() {
    if (!usePipelineTtsCache) return;
    if (!isTtsCacheEnabled() || process.env.TTS_CACHE_PREWARM === "false") return;
    const phrases = [
      ...new Set(
        collectFixedTtsPhrases(config, resolveGreetingText())
          .map((text) => stripEmojis(text))
          .filter((text) => text.trim())
      ),
    ];
    if (phrases.length === 0) return;

    const baseOptions = {
      apiKey: fishKey,
      referenceId: agentState.voiceId || config.tts.referenceId || null,
      sampleRate: config.tts.sampleRate,
      latency: config.tts.latency,
      speed: config.tts.speed,
      signal: prewarmAbort.signal,
    };

    ttsCache.prewarm(phrases.map((text) => ({ text })), baseOptions).catch((err) => {
      console.warn("⚠️  TTS cache prewarm failed:", err.message || err);
    });
  }

  // ── Greeting ────────────────────────────────────────────────────
  async function sendGreeting() {
    if (stopped) return;
    if (hasSelectedAgents && defaultAgentId && currentAgentId !== defaultAgentId) {
      switchAgent(defaultAgentId);
    }

    let greeting = resolveGreetingText();
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
      await speakSentence(greeting, greetAbort.signal, { cacheable: true });
      if (purposeStatement && !greetAbort.signal.aborted) {
        // Small pause between greeting and purpose
        const silence = generateSilence(SENTENCE_PAUSE_MS || 500, config.tts.sampleRate);
        onAudio(silence);
        // purposeStatement is free text per meeting — caching it would grow
        // assets/tts-cache/ unboundedly for a phrase spoken once (#67 scope).
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
  greetingTimer = setTimeout(() => {
    greetingTimer = null;
    if (stopped) return;
    sendGreeting().finally(() => {
      if (stopped) return;
      startTtsCachePrewarm();
    });
  }, 2000);
  greetingTimer.unref?.();

  // ── Public API ──────────────────────────────────────────────────
  const api = {
    sendAudio(buffer) {
      stt.send(buffer);
    },
    close() {
      stopped = true;
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
      reportQueue.length = 0;
      pendingHandoffQueue.length = 0;
      clearReportDrainSleep();
      if (pendingHandoffDrainTimer) {
        clearTimeout(pendingHandoffDrainTimer);
        pendingHandoffDrainTimer = null;
      }
      if (greetingTimer) {
        clearTimeout(greetingTimer);
        greetingTimer = null;
      }
      for (const timer of compactTimers) clearTimeout(timer);
      compactTimers.clear();
      relayedDelegateRunIds.clear();
      reportQueueDraining = false;
      syncGatewayDelegationState();
      prewarmAbort.abort();
      stt.close();
    },
    handleGatewaySubagentSpawn,
    handleGatewaySubagentCompletion,
    handleGatewaySessionReply,
    handleGatewayAnnounceInjected,
    getDelegationResults() {
      return [...reportResults];
    },
    getSessionUsers() {
      return {
        parent: agentState.sessionUser,
        delegate: `${agentState.sessionUser}-delegate`,
      };
    },
    /** EventEmitter for exit_requested and other pipeline events. */
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  };
  if (options._testExposeInternals) {
    api._test = {
      handleUtteranceEnd,
      processUserInput,
      switchAgent,
      abortCurrent: () => currentAbort?.abort(),
      handleGatewaySubagentSpawn,
      handleGatewaySubagentCompletion,
      handleGatewaySessionReply,
      handleGatewayAnnounceInjected,
      getGateState: () => gateState,
      getPendingQueueLength: () => pendingQueue.length,
      getReportQueueLength: () => reportQueue.length,
      getReportQueueLines: () => reportQueue.map((item) => item.line),
      getPendingHandoffQueueLength: () => pendingHandoffQueue.length,
      getHandoffInflightCount: () => {
        pruneHandoffInflight();
        return activeHandoffInflightCount();
      },
      getGatewayDelegationState: () => ({ ...(session.gatewayDelegationState || {}) }),
      getDelegationResults: () => [...reportResults],
      canDispatchHandoff,
      markHandoffDispatched,
      drainPendingHandoffs,
      enqueuePendingHandoff,
      enqueueReportVoiceLine,
      buildCompletionChatMessage,
      buildCompletionVoiceLine,
      compactParentSession,
      scheduleParentCompact,
      getCircuitBreakerState: () => ({
        open: circuitBreakerOpen,
        consecutiveTimeouts: consecutiveTimerATimeouts,
      }),
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
    generateSilence,
    collectFixedTtsPhrases,
    getShortUtteranceSkipReason,
  },
};
