"use strict";

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const STARTUP_KEY = Symbol.for("meetmate.settings.startup.v1");

function freezeRecord(value) {
  return Object.freeze({ ...value });
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
      provider: preDotenvEnv.LLM_PROVIDER || dotenvSeeds.LLM_PROVIDER || "openclaw",
      openclawUrl: preDotenvEnv.OPENCLAW_GATEWAY_URL || dotenvSeeds.OPENCLAW_GATEWAY_URL || "",
      openclawToken: preDotenvEnv.OPENCLAW_GATEWAY_TOKEN || dotenvSeeds.OPENCLAW_GATEWAY_TOKEN || "",
      openaiApiKey: preDotenvEnv.OPENAI_COMPATIBLE_API_KEY || dotenvSeeds.OPENAI_COMPATIBLE_API_KEY || "",
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
