"use strict";

function canonicalHostname(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  } catch {
    return null;
  }
}

function canonicalBaseUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    const parsed = new URL(value);
    parsed.hostname = canonicalHostname(value);
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return String(value).replace(/\/+$/, "");
  }
}

function isOpenAiHostedBaseUrl(value) {
  return canonicalHostname(value) === "api.openai.com";
}

module.exports = { canonicalBaseUrl, canonicalHostname, isOpenAiHostedBaseUrl };
