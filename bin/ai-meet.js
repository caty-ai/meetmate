#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const packageJson = require("../package.json");

function bundledPath(...parts) {
  return path.join(__dirname, "..", ...parts);
}

function resolveInitHome() {
  const launchHome = typeof process.env.AI_MEET_HOME === "string" && process.env.AI_MEET_HOME.trim()
    ? process.env.AI_MEET_HOME.trim()
    : process.cwd();
  return path.resolve(launchHome);
}

const CLASS1_CONFIG_KEYS = [
  "SONIOX_API_KEY",
  "FISH_AUDIO_API_KEY",
  "FISH_AUDIO_VOICE_ID",
  "ATTENDEE_API_KEY",
];

const PROMPTS = {
  SONIOX_API_KEY: {
    label: "SONIOX_API_KEY",
    hint: "Where to get it: create an API key in the Soniox console (https://console.soniox.com/). Typical format: a long token (~150 chars) starting with snx — an sk-... key belongs to Fish Audio, not here.",
  },
  FISH_AUDIO_API_KEY: {
    label: "FISH_AUDIO_API_KEY",
    hint: "Where to get it: create an API key in the Fish Audio dashboard (https://fish.audio/). Typical format: ~50 chars starting with sk-.",
  },
  FISH_AUDIO_VOICE_ID: {
    label: "FISH_AUDIO_VOICE_ID",
    hint: "Where to get it: copy the voice ID from your Fish Audio voice page (https://fish.audio/) — it is a separate value from the API key. Typical format: 32 hex chars, visible in the voice page URL.",
  },
  ATTENDEE_API_KEY: {
    label: "ATTENDEE_API_KEY",
    hint: "Where to get it: create an API key in the Attendee dashboard (https://attendee.dev/). Typical format: a 32-char alphanumeric token (no sk-/snx prefix).",
  },
  provider: {
    label: "LLM provider (openclaw|openai-compatible)",
    hint: "Where to get it: choose the provider used by your existing agent or compatible LLM endpoint.",
  },
  OPENCLAW_GATEWAY_URL: {
    label: "OPENCLAW_GATEWAY_URL",
    hint: "Where to get it: use the URL shown by your OpenClaw Gateway (https://openclaw.ai/; usually http://localhost:18789). Note: the Gateway config must have gateway.http.endpoints.chatCompletions.enabled: true, or Meetmate's chat requests will 404.",
  },
  OPENCLAW_GATEWAY_TOKEN: {
    label: "OPENCLAW_GATEWAY_TOKEN",
    hint: "Where to get it: copy the authentication token from your OpenClaw Gateway configuration.",
  },
  baseUrl: {
    label: "baseUrl",
    hint: "Where to get it: copy the base URL from your OpenAI-compatible provider or proxy.",
  },
  apiKey: {
    label: "apiKey",
    hint: "Where to get it: create an API key with your OpenAI-compatible provider or proxy.",
  },
  model: {
    label: "llm.model",
    hint: "Where to get it: copy a model ID supported by your OpenAI-compatible endpoint.",
  },
};

function isExactProvider(value) {
  return value === "openclaw" || value === "openai-compatible";
}

function parseExistingProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return isExactProvider(normalized) ? normalized : null;
}

function printUsage() {
  console.log("Usage: meetmate <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  init [--force]  Create or complete config.json, .env, and AGENTS.md in the resolved home.");
  console.log("  start           Start the Meetmate server.");
  console.log("  mcp             Start the MCP (Model Context Protocol) stdio server.");
  console.log("");
  console.log("Scripted init input: pipe one line per displayed prompt, in display order; generated shared tokens consume no lines.");
}

function parseVersion(version) {
  const match = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function meetsEngine(version, range) {
  const current = parseVersion(version);
  const minimumMatch = String(range).match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
  if (!current) return false;
  if (!minimumMatch) return null;
  const minimum = minimumMatch.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index];
  }
  return true;
}

function preflightNode() {
  const required = packageJson.engines?.node;
  const engineCheck = required ? meetsEngine(process.version, required) : true;
  if (engineCheck === null) {
    console.error(`Warning: cannot verify Node requirement ${required}; continuing with current version ${process.version}.`);
    return true;
  }
  if (!engineCheck) {
    console.error(`Meetmate requires Node ${required}; current version is ${process.version}. Upgrade Node and retry.`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function createLineReader() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queuedLines = [];
  const waiters = [];
  let closed = false;

  function rejectWaiters() {
    while (waiters.length > 0) {
      waiters.shift().reject(new Error("Input closed before all requested values were provided."));
    }
  }

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else queuedLines.push(line);
  });
  rl.on("SIGINT", () => rl.close());
  rl.on("close", () => {
    closed = true;
    rejectWaiters();
  });

  return {
    async ask(prompt) {
      console.log(prompt.hint);
      console.log(`${prompt.label}:`);
      let answer;
      if (queuedLines.length > 0) {
        answer = queuedLines.shift();
      } else if (closed) {
        throw new Error("Input closed before all requested values were provided.");
      } else {
        answer = await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      }
      if (/[#\s"']/.test(answer)) {
        console.warn("Warning: the value contains characters (#, whitespace, or quotes) that dotenv parsers may alter.");
      }
      return answer;
    },
    close() {
      rl.close();
    },
  };
}

function readProviderFromEnvFile(envDestination) {
  if (!envDestination || !fs.existsSync(envDestination)) return null;
  const match = fs.readFileSync(envDestination, "utf8").match(/^LLM_PROVIDER=(.*)$/m);
  return parseExistingProvider(match?.[1]);
}

function printChecklist({ writeConfig, writeEnv, existingProvider }) {
  console.log("Before you start, have these ready:");
  if (writeConfig) {
    console.log("- Soniox API key (speech-to-text)");
    console.log("- Fish Audio API key (text-to-speech)");
    console.log("- Fish Audio Voice ID — a separate value from the Fish Audio API key");
    console.log("- Attendee API key (meeting bot)");
  }
  const providerKnown = !writeEnv && Boolean(existingProvider);
  if (!providerKnown) {
    console.log("- Your LLM provider choice (openclaw or openai-compatible) and its connection values (URL/token, or base URL/API key/model)");
  } else if (existingProvider === "openai-compatible" && writeConfig) {
    console.log("- Your OpenAI-compatible endpoint's base URL and model ID (provider is already set in .env)");
  }
  console.log("- Later, after init: an ngrok fixed domain + authtoken (or Tailscale) for the tunnel");
  console.log("");
}

async function askWizard({ writeConfig, writeEnv, existingProvider }) {
  const reader = createLineReader();
  const answers = {};
  printChecklist({ writeConfig, writeEnv, existingProvider });

  try {
    if (writeConfig) {
      for (const key of CLASS1_CONFIG_KEYS) {
        answers[key] = await reader.ask(PROMPTS[key]);
      }
    }

    if (writeEnv) {
      answers.provider = await reader.ask(PROMPTS.provider);
    } else if (writeConfig) {
      answers.provider = existingProvider;
      if (!answers.provider) {
        answers.provider = await reader.ask(PROMPTS.provider);
      }
    }

    if (!isExactProvider(answers.provider)) {
      throw new Error('LLM provider must be exactly "openclaw" or "openai-compatible".');
    }

    if (answers.provider === "openclaw" && writeEnv) {
      answers.OPENCLAW_GATEWAY_URL = await reader.ask(PROMPTS.OPENCLAW_GATEWAY_URL);
      answers.OPENCLAW_GATEWAY_TOKEN = await reader.ask(PROMPTS.OPENCLAW_GATEWAY_TOKEN);
    }

    if (answers.provider === "openai-compatible") {
      if (writeConfig) answers.baseUrl = await reader.ask(PROMPTS.baseUrl);
      if (writeEnv) answers.apiKey = await reader.ask(PROMPTS.apiKey);
      if (writeConfig) answers.model = await reader.ask(PROMPTS.model);
    }

    return answers;
  } finally {
    reader.close();
  }
}

function replaceEnvLine(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (!pattern.test(contents)) {
    throw new Error(`Template .env.example has no ${key}= line; refusing to drop the provided value.`);
  }
  return contents.replace(pattern, () => `${key}=${value}`);
}

function buildEnvContents(template, answers) {
  const values = {
    LLM_PROVIDER: answers.provider,
    OPENCLAW_GATEWAY_URL: "",
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENAI_COMPATIBLE_API_KEY: "",
    JOIN_SHARED_TOKEN: crypto.randomBytes(32).toString("hex"),
    WS_SHARED_TOKEN: crypto.randomBytes(32).toString("hex"),
  };

  if (answers.provider === "openclaw") {
    values.OPENCLAW_GATEWAY_URL = answers.OPENCLAW_GATEWAY_URL;
    values.OPENCLAW_GATEWAY_TOKEN = answers.OPENCLAW_GATEWAY_TOKEN;
  }
  if (answers.provider === "openai-compatible") values.OPENAI_COMPATIBLE_API_KEY = answers.apiKey;

  return Object.entries(values).reduce(
    (contents, [key, value]) => replaceEnvLine(contents, key, value),
    template,
  );
}

function buildConfigContents(template, answers) {
  const config = JSON.parse(template);
  config.stt.sonioxApiKey = answers.SONIOX_API_KEY;
  config.tts.apiKey = answers.FISH_AUDIO_API_KEY;
  config.tts.voiceId = answers.FISH_AUDIO_VOICE_ID;
  config.attendee.apiKey = answers.ATTENDEE_API_KEY;
  config.llm.provider = answers.provider;
  if (answers.provider === "openai-compatible") {
    config.llm.model = answers.model;
    config.llm.openaiCompatible.baseUrl = answers.baseUrl;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function atomicWrite(destination, contents, options = {}) {
  const temporaryDestination = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryDestination, "wx", options.mode || 0o600);
    fs.writeFileSync(descriptor, contents);
    if (options.mode) fs.fchmodSync(descriptor, options.mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryDestination, destination);
    let directoryDescriptor = null;
    try {
      directoryDescriptor = fs.openSync(path.dirname(destination), "r");
      fs.fsyncSync(directoryDescriptor);
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
    } finally {
      if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporaryDestination, { force: true });
    throw error;
  }
}

function hasMeetmateMarker(destination) {
  const firstLine = fs.readFileSync(destination, "utf8").split(/\r?\n/, 1)[0];
  const match = firstLine.match(/^<!-- meetmate-generated template=([1-9]\d*) -->$/);
  if (!match) return false;
  try {
    BigInt(match[1]);
    return true;
  } catch {
    return false;
  }
}

function assertExistingOpenAICompatibleConfig(destination) {
  const requiredFields = [
    "llm.provider",
    "llm.model",
    "llm.openaiCompatible.baseUrl",
  ];
  let config;
  try {
    config = JSON.parse(fs.readFileSync(destination, "utf8"));
  } catch {
    throw new Error(`Existing config.json is invalid JSON; required openai-compatible fields are ${requiredFields.join(", ")}. Re-run with --force or fill them manually.`);
  }

  const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
  const missingFields = [];
  if (config?.llm?.provider !== "openai-compatible") missingFields.push(requiredFields[0]);
  if (!isNonEmptyString(config?.llm?.model)) missingFields.push(requiredFields[1]);
  if (!isNonEmptyString(config?.llm?.openaiCompatible?.baseUrl)) missingFields.push(requiredFields[2]);

  if (missingFields.length > 0) {
    throw new Error(`Existing config.json is missing required openai-compatible fields: ${missingFields.join(", ")}. Re-run with --force or fill them manually.`);
  }
}

function assertFileDestinations(destinations) {
  for (const destination of destinations) {
    if (fs.existsSync(destination) && fs.lstatSync(destination).isDirectory()) {
      throw new Error(`Cannot replace directory: ${path.basename(destination)}`);
    }
  }
}

async function init(force) {
  const home = resolveInitHome();
  fs.mkdirSync(home, { recursive: true });

  const configDestination = path.join(home, "config.json");
  const envDestination = path.join(home, ".env");
  const agentsDestination = path.join(home, "AGENTS.md");
  assertFileDestinations([configDestination, envDestination, agentsDestination]);

  const writeConfig = force || !fs.existsSync(configDestination);
  const writeEnv = force || !fs.existsSync(envDestination);
  let writeAgents = !fs.existsSync(agentsDestination);

  if (!writeAgents && hasMeetmateMarker(agentsDestination)) {
    writeAgents = force;
  } else if (!writeAgents) {
    console.log("Notice: existing AGENTS.md is not meetmate-generated; leaving it unchanged.");
  }

  const existingProvider = writeEnv ? null : readProviderFromEnvFile(envDestination);
  let answers = null;
  if (writeConfig || writeEnv) {
    answers = await askWizard({ writeConfig, writeEnv, existingProvider });
  }

  if (writeEnv && !writeConfig && answers.provider === "openai-compatible") {
    assertExistingOpenAICompatibleConfig(configDestination);
  }

  const created = [];
  if (writeConfig) {
    const template = fs.readFileSync(bundledPath("config.json.example"), "utf8");
    atomicWrite(configDestination, buildConfigContents(template, answers), { mode: 0o600 });
    created.push("config.json");
  }

  if (writeEnv) {
    const template = fs.readFileSync(bundledPath(".env.example"), "utf8");
    atomicWrite(envDestination, buildEnvContents(template, answers), { mode: 0o600 });
    created.push(".env");
  }

  if (writeAgents) {
    const template = fs.readFileSync(bundledPath("src", "agents-template.md"), "utf8");
    atomicWrite(agentsDestination, template);
    created.push("AGENTS.md");
  }

  if (created.length > 0) console.log(`Created: ${created.join(", ")}.`);
  else console.log("Nothing to create; existing files were left unchanged.");
  console.log("Remaining manual steps: configure ngrok (https://ngrok.com/) or Tailscale (https://tailscale.com/), then admit Meetmate to Google Meet.");
  console.log("ngrok tip: a fixed domain plus your authtoken is all you need — the dashboard's Start Endpoint button is not required (the endpoint goes live when you run ngrok locally).");
}

function start() {
  require(path.join(__dirname, "..", "src", "server.js"));
}

function mcp() {
  require(path.join(__dirname, "..", "src", "settings", "bootstrap.js")).captureStartup();
  return require(path.join(__dirname, "..", "src", "mcp", "server.js")).start();
}

const [command, ...options] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  printUsage();
} else if (command === "init") {
  const unknownOptions = options.filter((option) => option !== "--force");
  if (unknownOptions.length > 0) {
    console.error(`Unknown init option: ${unknownOptions[0]}`);
    process.exitCode = 1;
  } else if (preflightNode()) {
    init(options.includes("--force")).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
} else if (command === "start") {
  if (preflightNode()) start();
} else if (command === "mcp") {
  mcp().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exitCode = 1;
}
