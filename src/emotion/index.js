"use strict";
const { EMOTION_TAGS } = require("../messages");
// Same order as the canonical Fish vocabulary; never duplicate tag literals.
const TAG_VALUES = Object.freeze([
  null,
  { emotion: "trust", intensity: 0.3 },
  { emotion: "joy", intensity: 0.3 },
  { emotion: "sadness", intensity: 0.2 },
  { emotion: "anticipation", intensity: 0.2 },
]);
const TAGS = new Map(EMOTION_TAGS.map(({ tag }, index) => [tag, TAG_VALUES[index]]));
function fromTags(text) {
  const canonical = new Set(EMOTION_TAGS.map((entry) => entry.tag));
  for (const match of String(text || "").matchAll(/\[[^\]]+\]/g)) {
    if (canonical.has(match[0])) return TAGS.get(match[0]) ? { ...TAGS.get(match[0]) } : null;
  }
  return null;
}
function stripMarkup(text) {
  return String(text || "").replace(/\[\[\[chat:[\s\S]*?\]\]\]/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[[^\]]*\]/g, "")
    .replace(/<[^>]*>/g, "").replace(/[`*_#~]/g, "").trim();
}
async function judgeEmotion(text, { mode = "off", role, listening = false, ...options } = {}) {
  if (mode === "off") return null;
  const fallback = listening ? null : fromTags(text);
  if (mode !== "jev" || (!listening && role !== "reply")) return fallback;
  const plain = stripMarkup(text);
  if (!plain || options.signal?.aborted) return fallback;
  try {
    const { askJev } = await import("./jev.js");
    return await askJev(plain, { ...options, listening });
  } catch { return fallback; }
}
module.exports = { judgeEmotion, fromTags, stripMarkup };
