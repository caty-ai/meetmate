const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const paths = require("../src/paths");

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("writable paths prefer explicit cache and metrics overrides over AI_MEET_HOME", () => {
  withEnv({
    AI_MEET_HOME: "/tmp/ai-meet-home",
    TTS_CACHE_DIR: "/tmp/explicit-tts-cache",
    METRICS_LOG_DIR: "/tmp/explicit-metrics-log",
  }, () => {
    assert.equal(paths.ttsCacheDir(), "/tmp/explicit-tts-cache");
    assert.equal(paths.logsDir(), "/tmp/explicit-metrics-log");
    assert.equal(paths.configPath(), "/tmp/ai-meet-home/config.json");
    assert.equal(paths.envPath(), "/tmp/ai-meet-home/.env");
  });
});

test("writable paths use AI_MEET_HOME before cwd", () => {
  withEnv({
    AI_MEET_HOME: "/tmp/ai-meet-home",
    TTS_CACHE_DIR: undefined,
    METRICS_LOG_DIR: undefined,
  }, () => {
    assert.equal(paths.ttsCacheDir(), "/tmp/ai-meet-home/assets/tts-cache");
    assert.equal(paths.logsDir(), "/tmp/ai-meet-home/logs");
    assert.equal(paths.avatarCachePath(), "/tmp/ai-meet-home/assets/avatar.png");
  });
});

test("writable paths fall back to cwd", () => {
  withEnv({ AI_MEET_HOME: undefined, TTS_CACHE_DIR: undefined, METRICS_LOG_DIR: undefined }, () => {
    assert.equal(paths.resolveHome(), process.cwd());
    assert.equal(paths.ttsCacheDir(), path.join(process.cwd(), "assets", "tts-cache"));
    assert.equal(paths.logsDir(), path.join(process.cwd(), "logs"));
  });
});

test("bundled assets remain package-relative regardless of AI_MEET_HOME", () => {
  withEnv({ AI_MEET_HOME: "/tmp/ai-meet-home" }, () => {
    assert.equal(paths.bundledPublicDir(), path.join(__dirname, "..", "public"));
    assert.equal(paths.bundledAssetPath("avatar.png"), path.join(__dirname, "..", "assets", "avatar.png"));
    assert.notEqual(paths.bundledAssetPath("avatar.png"), "/tmp/ai-meet-home/assets/avatar.png");
  });
});
