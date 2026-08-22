const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const pathsModule = require.resolve("../src/paths");

function withFreshPaths(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[pathsModule];
  try {
    return fn(require(pathsModule));
  } finally {
    delete require.cache[pathsModule];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("writable paths prefer explicit cache and metrics overrides over AI_MEET_HOME", () => {
  withFreshPaths({
    AI_MEET_HOME: "/tmp/meetmate-home",
    TTS_CACHE_DIR: "/tmp/explicit-tts-cache",
    METRICS_LOG_DIR: "/tmp/explicit-metrics-log",
  }, (paths) => {
    assert.equal(paths.ttsCacheDir(), "/tmp/explicit-tts-cache");
    assert.equal(paths.metricsLogDir(), "/tmp/explicit-metrics-log");
    assert.equal(paths.logsDir(), "/tmp/meetmate-home/logs");
    assert.equal(paths.configPath(), "/tmp/meetmate-home/config.json");
    assert.equal(paths.envPath(), "/tmp/meetmate-home/.env");
  });
});

test("writable paths use launch-time AI_MEET_HOME before cwd", () => {
  withFreshPaths({
    AI_MEET_HOME: "/tmp/meetmate-home",
    TTS_CACHE_DIR: undefined,
    METRICS_LOG_DIR: undefined,
  }, (paths) => {
    assert.equal(paths.resolveHome(), "/tmp/meetmate-home");
    assert.equal(paths.ttsCacheDir(), "/tmp/meetmate-home/assets/tts-cache");
    assert.equal(paths.logsDir(), "/tmp/meetmate-home/logs");
    assert.equal(paths.metricsLogDir(), "/tmp/meetmate-home/logs");
    assert.equal(paths.avatarCachePath(), "/tmp/meetmate-home/assets/avatar.png");

    process.env.AI_MEET_HOME = "/tmp/late-home";
    assert.equal(paths.resolveHome(), "/tmp/meetmate-home");
    assert.equal(paths.configPath(), "/tmp/meetmate-home/config.json");
  });
});

test("writable paths pin cwd when AI_MEET_HOME is absent at launch", () => {
  withFreshPaths({ AI_MEET_HOME: undefined, TTS_CACHE_DIR: undefined, METRICS_LOG_DIR: undefined }, (paths) => {
    const launchCwd = process.cwd();
    assert.equal(paths.resolveHome(), launchCwd);
    assert.equal(paths.ttsCacheDir(), path.join(launchCwd, "assets", "tts-cache"));
    assert.equal(paths.logsDir(), path.join(launchCwd, "logs"));
  });
});

test("AI_MEET_HOME loaded from .env cannot redirect any resolved user path", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-paths-"));
  const poison = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-poison-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(poison, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, ".env"), `AI_MEET_HOME=${poison}\n`);

  const dotenvModule = require.resolve("dotenv");
  const script = `
    const paths = require(${JSON.stringify(pathsModule)});
    require(${JSON.stringify(dotenvModule)}).config({ path: paths.envPath(), quiet: true });
    process.stdout.write(JSON.stringify({
      dotenvHome: process.env.AI_MEET_HOME,
      home: paths.resolveHome(),
      config: paths.configPath(),
      env: paths.envPath(),
      logs: paths.logsDir(),
      metrics: paths.metricsLogDir(),
      tts: paths.ttsCacheDir(),
      avatar: paths.avatarCachePath()
    }));
  `;
  const env = { ...process.env };
  delete env.AI_MEET_HOME;
  delete env.TTS_CACHE_DIR;
  delete env.METRICS_LOG_DIR;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: directory,
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const resolved = JSON.parse(child.stdout);
  const canonicalDirectory = fs.realpathSync(directory);
  assert.equal(resolved.dotenvHome, poison);
  assert.deepEqual(resolved, {
    dotenvHome: poison,
    home: canonicalDirectory,
    config: path.join(canonicalDirectory, "config.json"),
    env: path.join(canonicalDirectory, ".env"),
    logs: path.join(canonicalDirectory, "logs"),
    metrics: path.join(canonicalDirectory, "logs"),
    tts: path.join(canonicalDirectory, "assets", "tts-cache"),
    avatar: path.join(canonicalDirectory, "assets", "avatar.png"),
  });
});

test("config loading resolves configPath lazily against the pinned home", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "config.json"), '{"agent":{"id":"lazy-path"}}\n');

  const configModule = require.resolve("../src/config");
  const script = `
    const config = require(${JSON.stringify(configModule)});
    process.stdout.write(JSON.stringify(config.loadConfig()));
  `;
  const env = { ...process.env, AI_MEET_HOME: directory };
  const child = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { agent: { id: "lazy-path" } });
});

test("bundled assets remain package-relative regardless of AI_MEET_HOME", () => {
  withFreshPaths({ AI_MEET_HOME: "/tmp/meetmate-home" }, (paths) => {
    assert.equal(paths.bundledPublicDir(), path.join(__dirname, "..", "public"));
    assert.equal(paths.bundledAssetPath("avatar.png"), path.join(__dirname, "..", "assets", "avatar.png"));
    assert.notEqual(paths.bundledAssetPath("avatar.png"), "/tmp/meetmate-home/assets/avatar.png");
  });
});
