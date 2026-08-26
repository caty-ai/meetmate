"use strict";

const DIRECT_DENY = Object.freeze([
  ["gateway.url", "OPENCLAW_GATEWAY_URL"],
  ["gateway.token", "OPENCLAW_GATEWAY_TOKEN"],
  ["llm.openaiCompatible.apiKey", "OPENAI_COMPATIBLE_API_KEY"],
  ["agent.gatewayUrl", "OPENCLAW_GATEWAY_URL"],
  ["agent.gatewayToken", "OPENCLAW_GATEWAY_TOKEN"],
  ["agent.openaiCompatible.apiKey", "OPENAI_COMPATIBLE_API_KEY"],
]);

const AGENT_DENY = Object.freeze([
  ["gatewayUrl", "OPENCLAW_GATEWAY_URL"],
  ["gatewayToken", "OPENCLAW_GATEWAY_TOKEN"],
]);

const PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;
const SENTINELS = new Set([
  "your_gateway_token_here", "your_deepgram_key", "your_soniox_key", "your_attendee_key",
  "your_fish_audio_key", "your_voice_id", "your_slack_bot_token", "your-model-id",
  "your_openai_compatible_key", "your-agent-id", "YourAgent", "your-agent", "エージェント名",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => isObject(current) ? current[key] : undefined, value);
}

function deletePath(value, dottedPath) {
  const parts = dottedPath.split(".");
  const key = parts.pop();
  const parent = parts.reduce((current, part) => isObject(current) ? current[part] : undefined, value);
  if (isObject(parent) && Object.prototype.hasOwnProperty.call(parent, key)) delete parent[key];
}

function meaningfulLegacy(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized !== "" && !PLACEHOLDER.test(normalized) && !SENTINELS.has(normalized);
  }
  return typeof value === "number" || typeof value === "boolean";
}

function scanLegacyClass2(config) {
  if (!isObject(config)) return [];
  const found = [];
  for (const [path, environment] of DIRECT_DENY) {
    if (meaningfulLegacy(readPath(config, path))) found.push({ path, environment });
  }

  function walk(node, path = [], context = "normal") {
    if (!isObject(node) && !Array.isArray(node)) return;
    if (Array.isArray(node)) {
      node.forEach((value, index) => walk(value, [...path, String(index)], context));
      return;
    }
    const nextContext = path.at(-1) === "agents" || context === "agent" ? "agent" :
      path.at(-1) === "overrides" || context === "overrides" ? "overrides" : "normal";
    if (nextContext === "agent" || nextContext === "overrides") {
      for (const [key, environment] of AGENT_DENY) {
        if (meaningfulLegacy(node[key])) found.push({ path: [...path, key].join("."), environment });
      }
      if (meaningfulLegacy(node.openaiCompatible?.apiKey)) {
        found.push({ path: [...path, "openaiCompatible.apiKey"].join("."), environment: "OPENAI_COMPATIBLE_API_KEY" });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      const childContext = key === "agents" ? "agent" : key === "overrides" ? "overrides" : nextContext;
      walk(value, [...path, key], childContext);
    }
  }
  walk(config);
  return [...new Map(found.map((entry) => [entry.path, entry])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
}

function stripLegacyClass2(config) {
  if (!isObject(config)) return config;
  for (const [path] of DIRECT_DENY) deletePath(config, path);

  function walk(node, context = "normal") {
    if (Array.isArray(node)) {
      node.forEach((value) => walk(value, context));
      return;
    }
    if (!isObject(node)) return;
    if (context === "agent" || context === "overrides") {
      delete node.gatewayUrl;
      delete node.gatewayToken;
      if (isObject(node.openaiCompatible)) delete node.openaiCompatible.apiKey;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, key === "agents" ? "agent" : key === "overrides" ? "overrides" : context);
    }
  }
  walk(config);
  return config;
}

function warnLegacyClass2(config, logger = console) {
  const entries = scanLegacyClass2(config);
  if (entries.length === 0) return entries;
  const guidance = entries.map(({ path, environment }) => `${path} -> ${environment}`).join(", ");
  logger.warn(`Legacy connection settings were ignored and must be supplied through the environment: ${guidance}`);
  return entries;
}

module.exports = {
  scanLegacyClass2,
  stripLegacyClass2,
  warnLegacyClass2,
};
