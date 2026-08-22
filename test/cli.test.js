const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cliPath = path.join(__dirname, "..", "bin", "ai-meet.js");
const configTemplatePath = path.join(__dirname, "..", "config.json.example");
const agentsTemplatePath = path.join(__dirname, "..", "src", "agents-template.md");

function isolatedEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.AI_MEET_HOME;
  delete env.NODE_OPTIONS;
  return Object.assign(env, overrides);
}

function runCli(args, cwd, input = "", options = {}) {
  return spawnSync(process.execPath, [...(options.nodeArgs || []), cliPath, ...args], {
    cwd,
    input,
    env: isolatedEnv(options.env),
    encoding: "utf8",
  });
}

function spawnCli(args, cwd, options = {}) {
  const child = spawn(process.execPath, [...(options.nodeArgs || []), cliPath, ...args], {
    cwd,
    env: isolatedEnv(options.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    output: () => `${stdout}${stderr}`,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function waitForOutput(running, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = running.output().match(pattern);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (running.child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`Process exited before ${pattern}:\n${running.output()}`));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${pattern}:\n${running.output()}`));
      }
    }, 10);
  });
}

function openclawInput(prefix = "test") {
  return [
    `${prefix}-soniox`,
    `${prefix}-fish`,
    `${prefix}-voice`,
    `${prefix}-attendee`,
    "openclaw",
    "http://localhost:18789",
    `${prefix}-gateway-token`,
  ].join("\n") + "\n";
}

function openaiInput(prefix = "test") {
  return [
    `${prefix}-soniox`,
    `${prefix}-fish`,
    `${prefix}-voice`,
    `${prefix}-attendee`,
    "openai-compatible",
    "http://localhost:4000/v1",
    `${prefix}-openai-key`,
    `${prefix}-model`,
  ].join("\n") + "\n";
}

function envValue(contents, key) {
  return contents.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];
}

test("init creates the openclaw write-set, protects files, and rotates tokens with --force", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const initial = runCli(["init"], directory, openclawInput("initial"));
  assert.equal(initial.status, 0, initial.stderr);

  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  const agentsPath = path.join(directory, "AGENTS.md");
  assert.deepEqual(fs.readFileSync(configPath), fs.readFileSync(configTemplatePath));
  assert.deepEqual(fs.readFileSync(agentsPath), fs.readFileSync(agentsTemplatePath));
  if (process.platform !== "win32") assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);

  const initialEnv = fs.readFileSync(envPath, "utf8");
  assert.equal(envValue(initialEnv, "SONIOX_API_KEY"), "initial-soniox");
  assert.equal(envValue(initialEnv, "FISH_AUDIO_API_KEY"), "initial-fish");
  assert.equal(envValue(initialEnv, "FISH_AUDIO_VOICE_ID"), "initial-voice");
  assert.equal(envValue(initialEnv, "ATTENDEE_API_KEY"), "initial-attendee");
  assert.equal(envValue(initialEnv, "LLM_PROVIDER"), "openclaw");
  assert.equal(envValue(initialEnv, "OPENCLAW_GATEWAY_URL"), "http://localhost:18789");
  assert.equal(envValue(initialEnv, "OPENCLAW_GATEWAY_TOKEN"), "initial-gateway-token");
  assert.match(envValue(initialEnv, "JOIN_SHARED_TOKEN"), /^[a-f0-9]{64}$/);
  assert.match(envValue(initialEnv, "WS_SHARED_TOKEN"), /^[a-f0-9]{64}$/);

  const originalConfig = fs.readFileSync(configPath);
  const originalEnv = fs.readFileSync(envPath);
  const originalAgents = fs.readFileSync(agentsPath);
  const protectedRun = runCli(["init"], directory);
  assert.equal(protectedRun.status, 0, protectedRun.stderr);
  assert.match(protectedRun.stdout, /Nothing to create/);
  assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  assert.deepEqual(fs.readFileSync(envPath), originalEnv);
  assert.deepEqual(fs.readFileSync(agentsPath), originalAgents);

  const forced = runCli(["init", "--force"], directory, openclawInput("forced"));
  assert.equal(forced.status, 0, forced.stderr);
  const forcedEnv = fs.readFileSync(envPath, "utf8");
  assert.equal(envValue(forcedEnv, "SONIOX_API_KEY"), "forced-soniox");
  assert.notEqual(envValue(forcedEnv, "JOIN_SHARED_TOKEN"), envValue(initialEnv, "JOIN_SHARED_TOKEN"));
  assert.notEqual(envValue(forcedEnv, "WS_SHARED_TOKEN"), envValue(initialEnv, "WS_SHARED_TOKEN"));
});

test("init writes the exact openai-compatible branch and keeps its apiKey out of .env", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = runCli(["init"], directory, openaiInput("branch"));
  assert.equal(result.status, 0, result.stderr);

  const envContents = fs.readFileSync(path.join(directory, ".env"), "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"));
  assert.equal(envValue(envContents, "LLM_PROVIDER"), "openai-compatible");
  assert.equal(config.llm.provider, "openai-compatible");
  assert.equal(config.llm.model, "branch-model");
  assert.equal(config.llm.openaiCompatible.baseUrl, "http://localhost:4000/v1");
  assert.equal(config.llm.openaiCompatible.apiKey, "branch-openai-key");
  assert.equal(envContents.includes("branch-openai-key"), false);
  assert.match(envValue(envContents, "JOIN_SHARED_TOKEN"), /^[a-f0-9]{64}$/);
  assert.match(envValue(envContents, "WS_SHARED_TOKEN"), /^[a-f0-9]{64}$/);

  const agents = fs.readFileSync(path.join(directory, "AGENTS.md"), "utf8");
  for (const sentinel of ["branch-soniox", "branch-fish", "branch-openai-key", "branch-model"]) {
    assert.equal(agents.includes(sentinel), false);
  }
  assert.doesNotMatch(agents, /^[A-Z][A-Z0-9_]*=/m);
});

test("init treats config.json and .env independently and prompts only for the missing write-set", (t) => {
  const configExists = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  const envExists = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  const configFromOpenclawEnv = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  const configFromOpenaiEnv = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(configExists, { recursive: true, force: true }));
  t.after(() => fs.rmSync(envExists, { recursive: true, force: true }));
  t.after(() => fs.rmSync(configFromOpenclawEnv, { recursive: true, force: true }));
  t.after(() => fs.rmSync(configFromOpenaiEnv, { recursive: true, force: true }));

  const configSentinel = "{\"preserveConfig\":true}\n";
  fs.writeFileSync(path.join(configExists, "config.json"), configSentinel);
  const completesEnv = runCli(["init"], configExists, openclawInput("missing-env"));
  assert.equal(completesEnv.status, 0, completesEnv.stderr);
  assert.equal(fs.readFileSync(path.join(configExists, "config.json"), "utf8"), configSentinel);
  assert.equal(envValue(fs.readFileSync(path.join(configExists, ".env"), "utf8"), "SONIOX_API_KEY"), "missing-env-soniox");

  const envSentinel = "PRESERVE_ENV=yes\n";
  fs.writeFileSync(path.join(envExists, ".env"), envSentinel, { mode: 0o600 });
  const completesConfig = runCli(
    ["init"],
    envExists,
    "openai-compatible\nhttp://localhost:4444/v1\nconfig-only-key\nconfig-only-model\n",
  );
  assert.equal(completesConfig.status, 0, completesConfig.stderr);
  assert.doesNotMatch(completesConfig.stdout, /SONIOX_API_KEY:/);
  assert.equal(fs.readFileSync(path.join(envExists, ".env"), "utf8"), envSentinel);
  const config = JSON.parse(fs.readFileSync(path.join(envExists, "config.json"), "utf8"));
  assert.equal(config.llm.provider, "openai-compatible");
  assert.equal(config.llm.model, "config-only-model");
  assert.equal(config.llm.openaiCompatible.apiKey, "config-only-key");

  fs.writeFileSync(path.join(configFromOpenclawEnv, ".env"), "LLM_PROVIDER=openclaw\n", { mode: 0o600 });
  const derivesOpenclawProvider = runCli(["init"], configFromOpenclawEnv);
  assert.equal(derivesOpenclawProvider.status, 0, derivesOpenclawProvider.stderr);
  assert.doesNotMatch(derivesOpenclawProvider.stdout, /LLM provider|baseUrl|apiKey|llm\.model/);
  const openclawConfig = JSON.parse(fs.readFileSync(path.join(configFromOpenclawEnv, "config.json"), "utf8"));
  assert.equal(openclawConfig.llm.provider, "openclaw");
  assert.equal(fs.existsSync(path.join(configFromOpenclawEnv, "AGENTS.md")), true);

  fs.writeFileSync(path.join(configFromOpenaiEnv, ".env"), "LLM_PROVIDER=openai-compatible\n", { mode: 0o600 });
  const derivesOpenaiProvider = runCli(
    ["init"],
    configFromOpenaiEnv,
    "http://localhost:4555/v1\nopenai-env-key\nopenai-env-model\n",
  );
  assert.equal(derivesOpenaiProvider.status, 0, derivesOpenaiProvider.stderr);
  assert.doesNotMatch(derivesOpenaiProvider.stdout, /LLM provider/);
  assert.match(derivesOpenaiProvider.stdout, /baseUrl:/);
  assert.match(derivesOpenaiProvider.stdout, /apiKey:/);
  assert.match(derivesOpenaiProvider.stdout, /llm\.model:/);
  const openaiConfig = JSON.parse(fs.readFileSync(path.join(configFromOpenaiEnv, "config.json"), "utf8"));
  assert.equal(openaiConfig.llm.provider, "openai-compatible");
  assert.equal(openaiConfig.llm.openaiCompatible.baseUrl, "http://localhost:4555/v1");
  assert.equal(openaiConfig.llm.openaiCompatible.apiKey, "openai-env-key");
  assert.equal(openaiConfig.llm.model, "openai-env-model");
});

test("AGENTS.md follows absent, generated-marker, foreign-file, and --force rules", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const agentsPath = path.join(directory, "AGENTS.md");

  assert.equal(runCli(["init"], directory, openclawInput("agents")).status, 0);
  assert.deepEqual(fs.readFileSync(agentsPath), fs.readFileSync(agentsTemplatePath));

  const generatedCustom = "<!-- meetmate-generated template=1 -->\ncustom generated content\n";
  fs.writeFileSync(agentsPath, generatedCustom);
  const keepsGenerated = runCli(["init"], directory);
  assert.equal(keepsGenerated.status, 0, keepsGenerated.stderr);
  assert.equal(fs.readFileSync(agentsPath, "utf8"), generatedCustom);

  const regenerates = runCli(["init", "--force"], directory, openclawInput("regenerate"));
  assert.equal(regenerates.status, 0, regenerates.stderr);
  assert.deepEqual(fs.readFileSync(agentsPath), fs.readFileSync(agentsTemplatePath));

  const foreign = "# Project-owned agent instructions\nNever replace this file.\n";
  fs.writeFileSync(agentsPath, foreign);
  const keepsForeign = runCli(["init"], directory);
  assert.equal(keepsForeign.status, 0, keepsForeign.stderr);
  assert.match(keepsForeign.stdout, /not meetmate-generated; leaving it unchanged/);
  assert.equal(fs.readFileSync(agentsPath, "utf8"), foreign);

  const forceKeepsForeign = runCli(["init", "--force"], directory, openclawInput("foreign-force"));
  assert.equal(forceKeepsForeign.status, 0, forceKeepsForeign.stderr);
  assert.match(forceKeepsForeign.stdout, /not meetmate-generated; leaving it unchanged/);
  assert.equal(fs.readFileSync(agentsPath, "utf8"), foreign);
});

test("upgrade path generates only AGENTS.md without starting the credential wizard", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(configTemplatePath, path.join(directory, "config.json"));
  fs.writeFileSync(path.join(directory, ".env"), "existing env\n", { mode: 0o600 });

  const result = runCli(["init"], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created: AGENTS\.md/);
  assert.doesNotMatch(result.stdout, /SONIOX_API_KEY:|LLM provider/);
  assert.deepEqual(fs.readFileSync(path.join(directory, "AGENTS.md")), fs.readFileSync(agentsTemplatePath));
});

test("interrupted init leaves no partial file and rerun completes only missing files", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preservedConfig = "{\"preserved\":true}\n";
  fs.writeFileSync(path.join(directory, "config.json"), preservedConfig);

  const running = spawnCli(["init"], directory);
  await waitForOutput(running, /SONIOX_API_KEY:/);
  running.child.stdin.write("interrupted-soniox\n");
  await waitForOutput(running, /FISH_AUDIO_API_KEY:/);
  running.child.kill("SIGTERM");
  await running.exited;

  assert.equal(fs.readFileSync(path.join(directory, "config.json"), "utf8"), preservedConfig);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  assert.equal(fs.existsSync(path.join(directory, "AGENTS.md")), false);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["config.json"]);

  const resumed = runCli(["init"], directory, openclawInput("resumed"));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(fs.readFileSync(path.join(directory, "config.json"), "utf8"), preservedConfig);
  assert.equal(envValue(fs.readFileSync(path.join(directory, ".env"), "utf8"), "SONIOX_API_KEY"), "resumed-soniox");
  assert.equal(fs.existsSync(path.join(directory, "AGENTS.md")), true);
});

test("init fails without writing files when input closes before requested values are complete", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = runCli(["init"], directory);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(directory, "config.json")), false);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  assert.equal(fs.existsSync(path.join(directory, "AGENTS.md")), false);
  assert.match(result.stderr, /Input closed before all requested values were provided/);
});

test("init writes special replacement characters in answers literally", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const tricky = "a$&b$`c$1d\\e";
  const input = [tricky, "fish", "voice", "attendee", "openclaw", "http://localhost:18789", "gateway"].join("\n") + "\n";
  const result = runCli(["init"], directory, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envValue(fs.readFileSync(path.join(directory, ".env"), "utf8"), "SONIOX_API_KEY"), tricky);
});

test("init fails cleanly when a destination is a directory", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.mkdirSync(path.join(directory, "config.json"));
  const result = runCli(["init", "--force"], directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot replace directory: config\.json/);
  assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|at .*ai-meet\.js/);
  assert.doesNotMatch(result.stdout, /SONIOX_API_KEY:/);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
});

test("init rejects partial input without writing files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = runCli(["init"], directory, "only-one-answer\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Input closed before all requested values were provided/);
  assert.equal(fs.existsSync(path.join(directory, "config.json")), false);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  assert.equal(fs.existsSync(path.join(directory, "AGENTS.md")), false);
});

test("init rejects non-exact provider tokens without writing files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = runCli(
    ["init"],
    directory,
    [
      "strict-soniox",
      "strict-fish",
      "strict-voice",
      "strict-attendee",
      " OpenClaw ",
    ].join("\n") + "\n",
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /LLM provider must be exactly "openclaw" or "openai-compatible"\./);
  assert.equal(fs.existsSync(path.join(directory, "config.json")), false);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  assert.equal(fs.existsSync(path.join(directory, "AGENTS.md")), false);
});

test("init and start reject old Node with one actionable line and no stack", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, "old-node.js");
  fs.writeFileSync(preload, 'Object.defineProperty(process, "version", { value: "v25.9.0" });\n');

  for (const command of ["init", "start"]) {
    const result = runCli([command], directory, "", { nodeArgs: ["--require", preload] });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const lines = result.stderr.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, result.stderr);
    assert.match(lines[0], /requires Node >=26\.0\.0; current version is v25\.9\.0\. Upgrade Node and retry\./);
    assert.doesNotMatch(lines[0], / at |Error:/);
  }
});

test("AI_MEET_HOME is shared by init and start, and the bound settings URL is printed once after listen", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-cwd-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-home-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const initialized = runCli(["init"], cwd, openclawInput("home"), { env: { AI_MEET_HOME: home } });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(fs.existsSync(path.join(cwd, "config.json")), false);
  assert.equal(fs.existsSync(path.join(home, "config.json")), true);

  const configPath = path.join(home, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.server.port = 0;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // The execution sandbox used by the test runner denies loopback listen with
  // EPERM. Patch only createServer so the real server bootstrap still proves
  // callback ordering and reads the port from server.address().
  const preload = path.join(cwd, "fake-listener.js");
  fs.writeFileSync(preload, `
    const Module = require("node:module");
    const EventEmitter = require("node:events");
    const realHttp = require("node:http");
    const fakeHttp = { ...realHttp };
    fakeHttp.createServer = () => {
      const server = new EventEmitter();
      server.address = () => ({ address: "0.0.0.0", family: "IPv4", port: 43123 });
      server.listen = (_port, callback) => {
        console.log("TEST_LISTEN_SUCCEEDED");
        setImmediate(callback);
      };
      return server;
    };
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "node:http" || request === "http") return fakeHttp;
      return originalLoad.call(this, request, parent, isMain);
    };
  `);
  const started = runCli(["start"], cwd, "", {
    env: { AI_MEET_HOME: home },
    nodeArgs: ["--require", preload],
  });
  assert.equal(started.status, 0, started.stderr);
  const listenIndex = started.stdout.indexOf("TEST_LISTEN_SUCCEEDED");
  const urlIndex = started.stdout.indexOf("Settings UI: http://localhost:43123/");
  assert.ok(listenIndex >= 0, started.stdout);
  assert.ok(urlIndex > listenIndex, started.stdout);
  assert.equal(started.stdout.split("http://localhost:43123/").length - 1, 1, started.stdout);
  assert.equal(started.stdout.includes("http://localhost:0/"), false);
});

test("usage documents scripted stdin, lists commands, and rejects unknown options and commands", () => {
  const help = runCli(["--help"], process.cwd());
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: meetmate <command> \[options\]/);
  assert.match(help.stdout, /init/);
  assert.match(help.stdout, /start/);
  assert.match(help.stdout, /pipe one line per displayed prompt/);

  const yes = runCli(["init", "--yes"], process.cwd());
  assert.equal(yes.status, 1);
  assert.match(yes.stderr, /Unknown init option: --yes/);

  const unknown = runCli(["unknown"], process.cwd());
  assert.equal(unknown.status, 1);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /Unknown command/);
});
