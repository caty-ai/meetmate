#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { bundledPath } = require("../src/paths");

const credentials = [
  "SONIOX_API_KEY",
  "FISH_AUDIO_API_KEY",
  "ATTENDEE_API_KEY",
];

function printUsage() {
  console.log("Usage: ai-meet <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  init [--force]  Create config.json and .env in the current directory.");
  console.log("  start           Start the AI Meet server.");
}

function askCredentials() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers = {};

  return new Promise((resolve, reject) => {
    let index = 0;
    let complete = false;

    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (!complete) {
        reject(new Error("Input closed before all credentials were provided."));
      }
    });

    function askNext() {
      const key = credentials[index];
      if (!key) {
        complete = true;
        rl.close();
        resolve(answers);
        return;
      }
      rl.question(`${key}: `, (answer) => {
        if (/[#\s"']/.test(answer)) {
          console.warn(`  warning: value contains characters (#, whitespace, quotes) that dotenv parsers may strip or truncate.`);
        }
        answers[key] = answer;
        index += 1;
        askNext();
      });
    }
    askNext();
  });
}

function withCredentials(envContents, answers) {
  return credentials.reduce((contents, key) => {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (!pattern.test(contents)) {
      throw new Error(`Template .env.example has no ${key}= line; refusing to drop the provided value.`);
    }
    return contents.replace(pattern, () => `${key}=${answers[key]}`);
  }, envContents);
}

function writeTemporaryFile(destination, contents, options) {
  const temporaryDestination = `${destination}.tmp-${process.pid}`;

  fs.writeFileSync(temporaryDestination, contents, { ...options, flag: "wx" });
  return temporaryDestination;
}

async function init(force) {
  const configDestination = path.join(process.cwd(), "config.json");
  const envDestination = path.join(process.cwd(), ".env");

  if (!force && (fs.existsSync(configDestination) || fs.existsSync(envDestination))) {
    console.error("Refusing to overwrite existing config.json or .env. Use --force to overwrite.");
    process.exitCode = 1;
    return;
  }

  for (const destination of [configDestination, envDestination]) {
    if (fs.existsSync(destination) && fs.lstatSync(destination).isDirectory()) {
      throw new Error(`Cannot replace directory: ${path.basename(destination)}`);
    }
  }

  let answers;
  try {
    answers = await askCredentials();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const configTemplate = fs.readFileSync(bundledPath("config.json.example"));
  const envTemplate = fs.readFileSync(bundledPath(".env.example"), "utf8");
  const envContents = withCredentials(envTemplate, answers);
  const temporaryFiles = [];

  try {
    temporaryFiles.push([configDestination, writeTemporaryFile(configDestination, configTemplate, {})]);
    temporaryFiles.push([envDestination, writeTemporaryFile(envDestination, envContents, { mode: 0o600 })]);
    for (const [destination, temporaryDestination] of temporaryFiles) {
      fs.renameSync(temporaryDestination, destination);
    }
  } catch (error) {
    for (const [, temporaryDestination] of temporaryFiles) {
      fs.rmSync(temporaryDestination, { force: true });
    }
    throw error;
  }
  console.log("Created config.json and .env.");
}

function start() {
  console.log(`Settings UI: http://localhost:${process.env.PORT || 5005}/`);
  require(path.join(__dirname, "..", "src", "server.js"));
}

const [command, ...options] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  printUsage();
} else if (command === "init") {
  init(options.includes("--force")).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else if (command === "start") {
  start();
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exitCode = 1;
}
