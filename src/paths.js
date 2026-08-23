const path = require("node:path");

// Pin the writable home before dotenv can mutate process.env. Every user-data
// path joins against this launch-time value, while explicit cache/log overrides
// remain lazy so dotenv can continue to supply them.
const launchHome = path.resolve(process.env.AI_MEET_HOME || process.cwd());

function resolveHome() {
  return launchHome;
}

function configPath() {
  return path.join(resolveHome(), "config.json");
}

function envPath() {
  return path.join(resolveHome(), ".env");
}

function logsDir() {
  return path.join(resolveHome(), "logs");
}

function metricsLogDir() {
  return process.env.METRICS_LOG_DIR
    ? path.resolve(process.env.METRICS_LOG_DIR)
    : logsDir();
}

function ttsCacheDir() {
  return process.env.TTS_CACHE_DIR
    ? path.resolve(process.env.TTS_CACHE_DIR)
    : path.join(resolveHome(), "assets", "tts-cache");
}

function avatarCachePath() {
  return path.join(resolveHome(), "assets", "avatar.png");
}

function bundledPath(...parts) {
  return path.join(__dirname, "..", ...parts);
}

function bundledPublicDir() {
  return bundledPath("public");
}

function bundledAssetPath(...parts) {
  return bundledPath("assets", ...parts);
}

module.exports = {
  resolveHome,
  configPath,
  envPath,
  logsDir,
  metricsLogDir,
  ttsCacheDir,
  avatarCachePath,
  bundledPath,
  bundledPublicDir,
  bundledAssetPath,
};
