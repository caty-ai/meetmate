const fs = require("fs");
const path = require("path");

const FRAME_FILENAMES = ["idle.png", "talk1.png", "talk2.png", "talk3.png", "blink.png", "talk_blink.png"];
const RECOMMENDED_FRAME_BYTES = 300 * 1024;
const WARN_FRAME_BYTES = 1024 * 1024;
const WARN_TOTAL_BYTES = 3 * 1024 * 1024;
const SKIPPABLE_STAT_ERRORS = new Set(["ENOENT", "ENOTDIR", "EACCES"]);

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatFrameWarning({ oversized, totalBytes }) {
  const sorted = [...oversized].sort((left, right) => right.bytes - left.bytes);
  const details = sorted.map(({ file, bytes }) => `${file} ${formatMegabytes(bytes)}`).join(", ");
  const detailClause = details ? ` (${details}; total ${formatMegabytes(totalBytes)})` : ` (total ${formatMegabytes(totalBytes)})`;
  return `⚠️  avatar-frames: ${sorted.length} frame(s) exceed the recommended size${detailClause}. Large frames download slowly over the public relay (measured ~429 KB/s) and can miss the meeting start — resize to ≤720–1080 px edge, target ≤300 KB/frame PNG (docs/setup-guide.md).`;
}

function pickWarnLogger(logger) {
  if (logger && typeof logger.warn === "function") return logger.warn.bind(logger);
  if (logger && typeof logger.log === "function") return logger.log.bind(logger);
  return null;
}

function isSkippableStatError(error) {
  return Boolean(error && SKIPPABLE_STAT_ERRORS.has(error.code));
}

async function readFrameSize(file, framesDir, statFile) {
  try {
    const stat = await statFile(path.join(framesDir, file));
    if (!stat || typeof stat.size !== "number" || Number.isNaN(stat.size)) {
      throw new TypeError(`invalid stat result for ${file}`);
    }
    return { file, bytes: stat.size };
  } catch (error) {
    if (isSkippableStatError(error)) return null;
    throw error;
  }
}

async function warnOversizedAvatarFrames(options) {
  try {
    const {
      framesDir: resolveFramesDir,
      logger = console,
      statFile = fs.promises.stat,
      warnFrameBytes = WARN_FRAME_BYTES,
      warnTotalBytes = WARN_TOTAL_BYTES,
    } = options || {};
    const framesDir = typeof resolveFramesDir === "function" ? resolveFramesDir() : resolveFramesDir;
    // Invalid path input is a fail-open diagnostic skip, just like resolution failures.
    if (typeof framesDir !== "string" || framesDir.length === 0) return null;

    const presentFrames = (await Promise.all(
      FRAME_FILENAMES.map((file) => readFrameSize(file, framesDir, statFile))
    )).filter(Boolean);
    const totalBytes = presentFrames.reduce((sum, frame) => sum + frame.bytes, 0);
    const oversized = presentFrames
      .filter((frame) => frame.bytes > RECOMMENDED_FRAME_BYTES)
      .sort((left, right) => right.bytes - left.bytes);
    const warned = presentFrames.some((frame) => frame.bytes > warnFrameBytes) || totalBytes > warnTotalBytes;

    if (warned) {
      const logWarning = pickWarnLogger(logger);
      if (logWarning) logWarning(formatFrameWarning({ oversized, totalBytes }));
    }

    return { warned, oversized, totalBytes };
  } catch {
    return null;
  }
}

module.exports = {
  warnOversizedAvatarFrames,
  FRAME_FILENAMES,
  RECOMMENDED_FRAME_BYTES,
  WARN_FRAME_BYTES,
  WARN_TOTAL_BYTES,
  formatFrameWarning,
};
