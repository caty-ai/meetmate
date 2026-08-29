"use strict";

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const STARTUP_KEY = Symbol.for("meetmate.settings.startup.v1");
const PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;
const SENTINELS = new Set([
  "your_gateway_token_here", "your_deepgram_key", "your_soniox_key", "your_attendee_key",
  "your_fish_audio_key", "your_voice_id", "your_slack_bot_token", "your-model-id",
  "your_openai_compatible_key", "your-agent-id", "YourAgent", "your-agent", "エージェント名",
]);

function freezeRecord(value) {
  return Object.freeze({ ...value });
}

function meaningfulString(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && !PLACEHOLDER.test(normalized) && !SENTINELS.has(normalized) ? normalized : "";
}

function connectionUrl(value) {
  const normalized = meaningfulString(value);
  if (!normalized || normalized !== value) return "";
  try {
    const parsed = new URL(normalized);
    return ["http:", "https:"].includes(parsed.protocol)
      && !parsed.username && !parsed.password && !parsed.hash ? normalized : "";
  } catch {
    return "";
  }
}

function connectionValue(preDotenvEnv, dotenvSeeds, name, parser = meaningfulString) {
  return parser(preDotenvEnv[name]) || parser(dotenvSeeds[name]) || "";
}

function captureStartup() {
  if (globalThis[STARTUP_KEY]) return globalThis[STARTUP_KEY];

  const preDotenvEnv = freezeRecord(process.env);
  const launchHome = typeof preDotenvEnv.AI_MEET_HOME === "string" && preDotenvEnv.AI_MEET_HOME.trim()
    ? preDotenvEnv.AI_MEET_HOME.trim()
    : process.cwd();
  const resolvedHome = path.resolve(launchHome);
  const dotenvFile = path.join(resolvedHome, ".env");
  let dotenvSeeds = {};
  try {
    const stat = fs.lstatSync(dotenvFile);
    if (!stat.isSymbolicLink() && stat.isFile()) dotenvSeeds = dotenv.parse(fs.readFileSync(dotenvFile));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Legacy .env seed could not be loaded; continuing in setup mode.");
  }

  // Keep the legacy env-exclusive reads equivalent to launch -> .env -> default.
  // AI_MEET_HOME is intentionally excluded because home was already pinned.
  for (const [name, value] of Object.entries(dotenvSeeds)) {
    if (name !== "AI_MEET_HOME" && process.env[name] === undefined) process.env[name] = value;
  }

  const startup = Object.freeze({
    preDotenvEnv,
    dotenvSeeds: freezeRecord(dotenvSeeds),
    resolvedHome,
    configPath: path.join(resolvedHome, "config.json"),
    connection: Object.freeze({
      openclawUrl: connectionValue(preDotenvEnv, dotenvSeeds, "OPENCLAW_GATEWAY_URL", connectionUrl),
      openclawToken: connectionValue(preDotenvEnv, dotenvSeeds, "OPENCLAW_GATEWAY_TOKEN"),
      openaiApiKey: connectionValue(preDotenvEnv, dotenvSeeds, "OPENAI_COMPATIBLE_API_KEY"),
    }),
  });
  globalThis[STARTUP_KEY] = startup;
  return startup;
}

function getStartup() {
  return globalThis[STARTUP_KEY] || captureStartup();
}

function resetStartupForTest() {
  delete globalThis[STARTUP_KEY];
}

module.exports = { captureStartup, getStartup, resetStartupForTest };
