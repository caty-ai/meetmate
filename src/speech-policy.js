// speech-policy.js — Centralized NO_REPLY suppression and reply sanitization
// Phase 1: Added as ADDITIONAL layer alongside existing isSilentReply/filterSilentReplies in llm.js

// NOTE: Gateway may stream-close mid-token; we sometimes receive a truncated prefix like "NO".
// Suppress these to avoid speaking "NO".
const NO_REPLY_RE = /^\s*NO[_\s]?REPLY\s*[。.！!？?]*\s*$/i;
// Case-sensitive on purpose: we only want to suppress the exact uppercase prefix, not a legitimate "No." reply.
const TRUNCATED_NO_RE = /^\s*NO[_\s]*[。.！!？?]*\s*$/;
const GATEWAY_ERROR_RE = /^\s*((error|internal error|upstream error)\s*[:：]|service unavailable|\{"error")/i;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const KEYCAP_RE = /[0-9#*][\uFE0E\uFE0F]?\u20E3/gu;

/**
 * Check if a reply text should be suppressed (NO_REPLY pattern, empty, null, whitespace).
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function shouldSuppressReply(text) {
  if (text == null) return true;
  const trimmed = String(text).trim();
  if (!trimmed) return true;
  if (NO_REPLY_RE.test(trimmed)) return true;
  if (TRUNCATED_NO_RE.test(trimmed)) return true;
  return false;
}

function isGatewayErrorText(text) {
  const head = String(text || "").trim().slice(0, 80);
  return GATEWAY_ERROR_RE.test(head);
}

/**
 * Sanitize a reply: returns null if suppressed, trimmed string otherwise.
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
function sanitizeReply(text) {
  if (shouldSuppressReply(text)) return null;
  return String(text).trim();
}

function stripEmojis(text) {
  const input = String(text ?? "");
  if (!input) return input;

  let stripped = false;
  let output = input.replace(KEYCAP_RE, () => {
    stripped = true;
    return "";
  });

  let cleaned = "";
  for (const char of output) {
    const codePoint = char.codePointAt(0);
    if (shouldStripEmojiCodePoint(char, codePoint)) {
      stripped = true;
      continue;
    }
    cleaned += char;
  }

  if (!stripped) return input;
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

function shouldStripEmojiCodePoint(char, codePoint) {
  if (codePoint === 0x200D || codePoint === 0x20E3 || codePoint === 0xFE0E || codePoint === 0xFE0F) return true;
  // Dingbats/Misc Symbols (U+2600-U+27BF) include arrow-like glyphs (e.g. U+27A1)
  // plus star/music/decorative glyphs (★ ☆ ♪ ♬ ♨) that TTS reads as noise, so
  // they are intentionally stripped; the separate Arrows block U+2190-U+21FF
  // (↑↓←→) is NOT in this range and always survives.
  if (codePoint >= 0x2600 && codePoint <= 0x27BF) return true;
  if (codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF) return true;
  if (codePoint >= 0x1F3FB && codePoint <= 0x1F3FF) return true;
  if (codePoint >= 0xE0000 && codePoint <= 0xE007F) return true;
  return codePoint >= 0x1F000 && EXTENDED_PICTOGRAPHIC_RE.test(char);
}

/**
 * Wrap an async generator to filter out silent/empty replies.
 * Phase 1: Additional layer on top of existing filterSilentReplies in llm.js.
 * @param {AsyncGenerator<string>} source
 * @returns {AsyncGenerator<string>}
 */
async function* filterSilentRepliesStream(source) {
  let accumulated = "";
  const held = [];

  for await (const chunk of source) {
    accumulated += chunk;
    held.push(chunk);

    // Once we have enough text to determine it's not a NO_REPLY pattern, release
    const trimmed = accumulated.trim();
    if (isGatewayErrorText(trimmed)) {
      for await (const rest of source) {
        accumulated += rest;
      }
      console.log(`🧯 gateway_error_suppressed: "${accumulated.trim()}"`);
      return;
    }
    if (trimmed.length > 10 && !NO_REPLY_RE.test(trimmed)) {
      // Definitely not NO_REPLY — release all held chunks
      for (const h of held) yield h;
      held.length = 0;
      // Pass through remaining chunks directly
      for await (const rest of source) {
        accumulated += rest;
        yield rest;
      }
      return;
    }
  }

  // End of stream: check if everything held is a suppressed reply
  if (shouldSuppressReply(accumulated)) {
    // Drop — don't yield anything
    return;
  }
  if (isGatewayErrorText(accumulated)) {
    console.log(`🧯 gateway_error_suppressed: "${accumulated.trim()}"`);
    return;
  }

  // Not suppressed — release all held chunks
  for (const h of held) yield h;
}

module.exports = {
  shouldSuppressReply,
  sanitizeReply,
  stripEmojis,
  isGatewayErrorText,
  filterSilentRepliesStream,
};
