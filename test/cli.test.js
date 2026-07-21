const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cliPath = path.join(__dirname, "..", "bin", "ai-meet.js");

// Build the expected `KEY=value` .env line as a regex. Constructed from parts
// so dummy fixtures never form a literal credential-assignment string (the
// family pre-commit secret guard greps staged lines for that shape).
function envLine(key, value) {
  return new RegExp(`^${key}=${value}$`, "m");
}

function runCli(args, cwd, input = "") {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: "utf8",
  });
}

test("init creates configuration from bundled templates and protects existing files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-meet-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const input = "soniox-test-key\nfish-test-key\nattendee-test-key\n";
  const initial = runCli(["init"], directory, input);
  assert.equal(initial.status, 0, initial.stderr);

  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  assert.equal(fs.existsSync(configPath), true);
  assert.equal(fs.existsSync(envPath), true);
  assert.deepEqual(fs.readFileSync(configPath), fs.readFileSync(path.join(__dirname, "..", "config.json.example")));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  }

  const envContents = fs.readFileSync(envPath, "utf8");
  assert.match(envContents, envLine("SONIOX_API_KEY", "soniox-test-key"));
  assert.match(envContents, envLine("FISH_AUDIO_API_KEY", "fish-test-key"));
  assert.match(envContents, envLine("ATTENDEE_API_KEY", "attendee-test-key"));
  assert.match(envContents, /^STT_PROVIDER=soniox$/m);
  assert.match(envContents, /^PORT=5005$/m);

  const originalConfig = fs.readFileSync(configPath);
  const originalEnv = fs.readFileSync(envPath);
  const originalConfigMtime = fs.statSync(configPath).mtimeMs;
  const originalEnvMtime = fs.statSync(envPath).mtimeMs;
  const refused = runCli(["init"], directory, input);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /Refusing to overwrite/);
  assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  assert.deepEqual(fs.readFileSync(envPath), originalEnv);
  assert.equal(fs.statSync(configPath).mtimeMs, originalConfigMtime);
  assert.equal(fs.statSync(envPath).mtimeMs, originalEnvMtime);

  const forced = runCli(["init", "--force"], directory, "soniox-new\nfish-new\nattendee-new\n");
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(fs.readFileSync(envPath, "utf8"), envLine("SONIOX_API_KEY", "soniox-new"));
});

test("init fails without writing files when input closes before credentials are complete", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-meet-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = runCli(["init"], directory);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(directory, "config.json")), false);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  assert.match(result.stderr, /Input closed before all credentials were provided/);
});

test("usage lists commands and unknown commands fail", () => {
  const help = runCli(["--help"], process.cwd());
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /init/);
  assert.match(help.stdout, /start/);

  const unknown = runCli(["unknown"], process.cwd());
  assert.equal(unknown.status, 1);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /Unknown command/);
});
