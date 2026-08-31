"use strict";

const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,20}$/;

function normalizeAllowlist(entries) {
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries.filter((entry) => typeof entry === "string" && DISCORD_SNOWFLAKE_RE.test(entry)))];
}

function parseAllowlist(entries) {
  if (!Array.isArray(entries)) {
    return { ok: false, code: "not_array", entries: [] };
  }
  if (entries.length > 64) {
    return { ok: false, code: "too_many", entries: [] };
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !DISCORD_SNOWFLAKE_RE.test(entry)) {
      return { ok: false, code: "invalid_entry", entries: [] };
    }
    if (seen.has(entry)) {
      return { ok: false, code: "duplicate_entry", entries: [] };
    }
    seen.add(entry);
    normalized.push(entry);
  }
  return { ok: true, entries: normalized };
}

function isValidSnowflake(value) {
  return typeof value === "string" && DISCORD_SNOWFLAKE_RE.test(value);
}

function isGuildAllowed(entries, guildId) {
  return normalizeAllowlist(entries).includes(guildId);
}

module.exports = {
  DISCORD_SNOWFLAKE_RE,
  isGuildAllowed,
  isValidSnowflake,
  normalizeAllowlist,
  parseAllowlist,
};
