"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");
const { validators } = require("./registry");
const { audioMetadataSchema, parseStrict } = require("./schemas");
const { readConfigState, saveAudioClips, settingsError } = require("./store");

const SOURCE_LIMIT = 10 * 1024 * 1024;
const TOTAL_LIMIT = 128 * 1024 * 1024;
const CLIP_LIMIT = 32;
const DURATION_LIMIT_MS = 30_000;
const HEADER_LIMIT = 16 * 1024;
const METADATA_LIMIT = 24 * 1024;
const FFMPEG_TIMEOUT_MS = 35_000;
const ROLES = ["ack", "progress", "greeting", "farewell", "timeout"];

function audioError(code, status = 422) {
  return settingsError(code, "Audio request failed", status);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function lstatNotSymlink(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw settingsError("SETTINGS_SYMLINK_REJECTED", "Settings path is not allowed", 422);
  return stat;
}

function ensureDirectory(directory, mode = 0o700) {
  try {
    const stat = lstatNotSymlink(directory);
    if (!stat.isDirectory()) throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { mode });
  }
  fs.chmodSync(directory, mode);
}

function managedDirectory(resolvedHome, create = false) {
  const home = path.resolve(resolvedHome);
  if (create) {
    try {
      const stat = lstatNotSymlink(home);
      if (!stat.isDirectory()) throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      lstatNotSymlink(home);
    }
  } else {
    const stat = lstatNotSymlink(home);
    if (!stat.isDirectory()) throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
  }
  const assets = path.join(home, "assets");
  const directory = path.join(assets, "settings-audio");
  if (create) {
    ensureDirectory(assets);
    ensureDirectory(directory);
  } else {
    if (!lstatNotSymlink(assets).isDirectory() || !lstatNotSymlink(directory).isDirectory()) {
      throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
    }
  }
  const realHome = fs.realpathSync(home);
  const realAssets = fs.realpathSync(assets);
  const realDirectory = fs.realpathSync(directory);
  if (!isWithin(realHome, realAssets) || !isWithin(realHome, realDirectory) || !isWithin(realAssets, realDirectory)) {
    throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
  }
  return { home, directory, realHome, realDirectory };
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function expectedRelativePath(id, extension) {
  return `assets/settings-audio/${id}.${extension}`;
}

function resolveOwnedFile(record, kind, resolvedHome, { allowMissing = false } = {}) {
  const extension = kind === "source" ? "mp3" : "pcm";
  const field = kind === "source" ? "sourceRelativePath" : "pcmRelativePath";
  const expected = expectedRelativePath(record.id, extension);
  if (record[field] !== expected || record[field].includes("\0") || path.isAbsolute(record[field])) {
    throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
  }
  const managed = managedDirectory(resolvedHome, false);
  const target = path.resolve(managed.home, ...record[field].split("/"));
  if (path.dirname(target) !== managed.directory || !isWithin(managed.directory, target)) {
    throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
  }
  let stat;
  try {
    stat = lstatNotSymlink(target);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return { path: target, stat: null, missing: true };
    throw error;
  }
  if (!stat.isFile()) throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
  const realTarget = fs.realpathSync(target);
  if (!isWithin(managed.realDirectory, realTarget)) throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
  return { path: target, stat };
}

function readOwnedFile(record, kind, resolvedHome) {
  const owned = resolveOwnedFile(record, kind, resolvedHome);
  const descriptor = fs.openSync(owned.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
    return { bytes: fs.readFileSync(descriptor), path: owned.path, stat };
  } finally {
    fs.closeSync(descriptor);
  }
}

function randomTemp(directory, label) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const target = path.join(directory, `.${label}-${process.pid}-${crypto.randomBytes(16).toString("hex")}`);
    try {
      const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      return { path: target, descriptor };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw audioError("SETTINGS_AUDIO_TEMP_FAILED", 500);
}

function unlinkBestEffort(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

function parseContentDisposition(value) {
  if (typeof value !== "string" || !/^form-data(?:\s*;|$)/i.test(value) || value.includes("\0")) {
    throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
  }
  const parameters = new Map();
  const pattern = /;\s*([^=;\s]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/g;
  for (const match of value.matchAll(pattern)) {
    const key = match[1].toLowerCase();
    if (parameters.has(key)) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
    const raw = match[2] === undefined ? match[3].trim() : match[2].replace(/\\([\\"])/g, "$1");
    parameters.set(key, raw);
  }
  if (!parameters.has("name")) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
  return { name: parameters.get("name"), filename: parameters.get("filename") };
}

function parseHeaders(bytes) {
  if (bytes.includes(0)) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
  const headers = new Map();
  for (const line of bytes.toString("latin1").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || headers.has(name)) {
      throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
    }
    headers.set(name, value);
  }
  return headers;
}

function validateFilename(filename) {
  if (typeof filename !== "string" || filename === "" || filename.includes("\0")
      || filename.includes("/") || filename.includes("\\") || filename.includes("..")
      || /%(?:00|2e|2f|5c)/i.test(filename) || !filename.endsWith(".mp3")) {
    throw audioError("SETTINGS_AUDIO_FILENAME_REJECTED");
  }
}

function multipartBoundary(contentType) {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/i.exec(String(contentType || ""));
  const value = match?.[1] || match?.[2] || "";
  if (!value || value.length > 70 || /[\x00-\x20\x7f]/.test(value)) {
    throw settingsError("SETTINGS_MEDIA_TYPE_UNSUPPORTED", "Content type not supported", 415);
  }
  return value;
}

async function parseMultipart(req, directory) {
  const boundary = multipartBoundary(req.headers["content-type"]);
  const opening = Buffer.from(`--${boundary}\r\n`, "ascii");
  const marker = Buffer.from(`\r\n--${boundary}`, "ascii");
  let buffer = Buffer.alloc(0);
  let phase = "opening";
  let current = null;
  let source = null;
  let metadataBytes = Buffer.alloc(0);
  let metadataSeen = false;
  let audioSeen = false;

  function closeSource() {
    if (!source || source.closed) return;
    fs.fsyncSync(source.descriptor);
    fs.closeSync(source.descriptor);
    source.closed = true;
  }

  function startPart(headerBytes) {
    const headers = parseHeaders(headerBytes);
    const disposition = parseContentDisposition(headers.get("content-disposition"));
    if (disposition.name === "audio") {
      if (audioSeen || disposition.filename === undefined) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
      validateFilename(disposition.filename);
      if (String(headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() !== "audio/mpeg") {
        throw settingsError("SETTINGS_MEDIA_TYPE_UNSUPPORTED", "Content type not supported", 415);
      }
      source = { ...randomTemp(directory, "audio-upload"), bytes: 0, hash: crypto.createHash("sha256"), closed: false };
      audioSeen = true;
      current = "audio";
      return;
    }
    if (disposition.name === "metadata") {
      if (metadataSeen || disposition.filename !== undefined) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
      const rawType = String(headers.get("content-type") || "").toLowerCase();
      if (rawType) {
        const [mediaType, ...parameters] = rawType.split(";").map((item) => item.trim());
        if (mediaType !== "application/json"
            || parameters.some((item) => !/^[^=;\s]+=(?:"[^"]*"|[^;\s]+)$/.test(item))) {
          throw settingsError("SETTINGS_MEDIA_TYPE_UNSUPPORTED", "Content type not supported", 415);
        }
      }
      metadataSeen = true;
      current = "metadata";
      return;
    }
    throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
  }

  function consume(bytes) {
    if (bytes.length === 0) return;
    if (current === "audio") {
      source.bytes += bytes.length;
      if (source.bytes > SOURCE_LIMIT) throw audioError("SETTINGS_AUDIO_SOURCE_TOO_LARGE", 413);
      fs.writeSync(source.descriptor, bytes);
      source.hash.update(bytes);
      return;
    }
    if (current === "metadata") {
      if (metadataBytes.length + bytes.length > METADATA_LIMIT) throw audioError("SETTINGS_AUDIO_METADATA_TOO_LARGE", 413);
      metadataBytes = Buffer.concat([metadataBytes, bytes]);
      return;
    }
    throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
  }

  function finishPart() {
    if (current === "audio") closeSource();
    current = null;
  }

  try {
    for await (const chunk of req) {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (phase === "opening") {
          if (buffer.length < opening.length) break;
          if (!buffer.subarray(0, opening.length).equals(opening)) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
          buffer = buffer.subarray(opening.length);
          phase = "headers";
          continue;
        }
        if (phase === "headers") {
          const index = buffer.indexOf("\r\n\r\n");
          if (index < 0) {
            if (buffer.length > HEADER_LIMIT) throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
            break;
          }
          startPart(buffer.subarray(0, index));
          buffer = buffer.subarray(index + 4);
          phase = "body";
          continue;
        }
        if (phase === "body") {
          const index = buffer.indexOf(marker);
          if (index < 0) {
            const safeLength = Math.max(0, buffer.length - marker.length + 1);
            consume(buffer.subarray(0, safeLength));
            buffer = buffer.subarray(safeLength);
            break;
          }
          consume(buffer.subarray(0, index));
          finishPart();
          buffer = buffer.subarray(index + marker.length);
          phase = "suffix";
          continue;
        }
        if (phase === "suffix") {
          if (buffer.length < 2) break;
          const suffix = buffer.subarray(0, 2).toString("ascii");
          if (suffix === "\r\n") {
            buffer = buffer.subarray(2);
            phase = "headers";
            continue;
          }
          if (suffix === "--") {
            buffer = buffer.subarray(2);
            phase = "closed";
            continue;
          }
          throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
        }
        if (phase === "closed") {
          if (buffer.length === 0) break;
          if (buffer.length === 1 && buffer[0] === 13) break;
          if (buffer.equals(Buffer.from("\r\n"))) {
            buffer = Buffer.alloc(0);
            break;
          }
          throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
        }
      }
    }
    if (phase !== "closed" || buffer.length !== 0 || !audioSeen || !metadataSeen || !source) {
      throw audioError("SETTINGS_AUDIO_MULTIPART_INVALID");
    }
    closeSource();
    let metadataText;
    try { metadataText = new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes); } catch {
      throw audioError("SETTINGS_AUDIO_METADATA_INVALID");
    }
    let metadata;
    try { metadata = JSON.parse(metadataText); } catch { throw audioError("SETTINGS_AUDIO_METADATA_INVALID"); }
    return {
      metadata: parseStrict(audioMetadataSchema, metadata),
      sourcePath: source.path,
      sourceBytes: source.bytes,
      sourceSha256: source.hash.digest("hex"),
    };
  } catch (error) {
    try { closeSource(); } catch { /* cleanup below */ }
    unlinkBestEffort(source?.path);
    throw error;
  }
}

function validMp3Signature(filePath) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const bytes = Buffer.alloc(4);
  let length;
  try { length = fs.readSync(descriptor, bytes, 0, bytes.length, 0); } finally { fs.closeSync(descriptor); }
  if (length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  return length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
    && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0;
}

function runFfmpeg({ executable, sourcePath, pcmPath, sampleRate, spawnFn = spawn, timeoutMs = FFMPEG_TIMEOUT_MS }) {
  const args = [
    "-nostdin", "-v", "error", "-i", sourcePath,
    "-f", "s16le", "-ac", "1", "-ar", String(sampleRate), pcmPath,
  ];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(executable, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      reject(audioError("SETTINGS_AUDIO_CONVERSION_FAILED"));
      return;
    }
    let settled = false;
    let stderrBytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(args);
    };
    child.stderr?.on("data", (chunk) => { stderrBytes += chunk.length; });
    child.once("error", () => finish(audioError("SETTINGS_AUDIO_CONVERSION_FAILED")));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal || stderrBytes > 0) finish(audioError("SETTINGS_AUDIO_CONVERSION_FAILED"));
      else finish();
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      finish(audioError("SETTINGS_AUDIO_CONVERSION_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
  });
}

function currentTtsIdentity() {
  const { getEffectiveValue } = require("./resolver");
  const reference = getEffectiveValue("fish_audio_voice_id");
  return {
    referenceId: typeof reference === "string" && reference.trim() ? reference.trim() : null,
    model: getEffectiveValue("fish_audio_model"),
    sampleRate: getEffectiveValue("tts_sample_rate"),
    speed: getEffectiveValue("fish_audio_speed"),
  };
}

function configuredTtsIdentity() {
  return currentTtsIdentity();
}

function canonicalKey(text, identity) {
  return require("../tts-cache").cacheKey(text, identity);
}

function inspectClip(record, resolvedHome, identity) {
  let playable = false;
  try {
    const source = resolveOwnedFile(record, "source", resolvedHome);
    const pcm = resolveOwnedFile(record, "pcm", resolvedHome);
    playable = source.stat.size === record.sourceBytes
      && pcm.stat.size === record.pcmBytes
      && pcm.stat.size > 0
      && pcm.stat.size % 2 === 0
      && Math.ceil((pcm.stat.size * 1000) / (record.sampleRate * 2)) <= DURATION_LIMIT_MS
      && sha256File(source.path) === record.sourceSha256
      && sha256File(pcm.path) === record.pcmSha256;
  } catch {
    playable = false;
  }
  return {
    ...structuredClone(record),
    stale: record.cacheKey !== canonicalKey(record.text, identity),
    playable,
  };
}

function projectClipViews(records, resolvedHome, identity = currentTtsIdentity()) {
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    const parsed = validators.clipRecord.safeParse(record);
    return parsed.success ? [inspectClip(parsed.data, resolvedHome, identity)] : [];
  });
}

function lookupManagedPcm({ role, text, referenceId, model, sampleRate, speed }) {
  try {
    const { getRuntime } = require("./resolver");
    if (!ROLES.includes(role)) return null;
    const identity = { referenceId: referenceId || null, model, sampleRate, speed };
    const configuredIdentity = configuredTtsIdentity();
    const wantedKey = canonicalKey(text, identity);
    const clips = storedClips().valid.map(({ record }) => record);
    const candidates = clips
      .filter((clip) => clip.role === role && clip.cacheKey === wantedKey
        && clip.cacheKey === canonicalKey(clip.text, configuredIdentity))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    for (const clip of candidates) {
      try {
        const view = inspectClip(clip, getRuntime().startup.resolvedHome, identity);
        if (view.stale || !view.playable) continue;
        const owned = readOwnedFile(clip, "pcm", getRuntime().startup.resolvedHome);
        if (owned.bytes.length === 0 || owned.bytes.length % 2 !== 0 || sha256Bytes(owned.bytes) !== clip.pcmSha256) continue;
        return { clip: structuredClone(clip), pcm: owned.bytes };
      } catch {
        // A broken managed clip is metadata only; synthesis remains the fallback.
      }
    }
  } catch {
    // Runtime setup or file inspection failures must not break speech.
  }
  return null;
}

function assertCommittedRevision(configPath, revision) {
  const state = readConfigState(configPath);
  if (!state.valid || state.revision !== revision) {
    throw settingsError("SETTINGS_REVISION_CONFLICT", "Settings revision changed", 409);
  }
}

function storedClips() {
  const raw = require("./resolver").getRawConfig();
  const value = raw?.audio?.clips;
  const items = Array.isArray(value) ? structuredClone(value) : [];
  const valid = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsed = validators.clipRecord.safeParse(items[index]);
    if (parsed.success) valid.push({ index, record: parsed.data });
  }
  return { items, valid };
}

function existingManagedBytes(directory) {
  let total = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^[0-9a-f-]{36}\.(?:mp3|pcm)$/.test(name)) continue;
    try {
      const stat = lstatNotSymlink(path.join(directory, name));
      if (stat.isFile()) total += stat.size;
    } catch {
      // Unsafe or racing entries are never followed and cannot lower the cap.
      return TOTAL_LIMIT;
    }
  }
  return total;
}

function ffmpegExecutable(options, startup) {
  if (typeof options.ffmpegBin === "string" && options.ffmpegBin.trim()) return options.ffmpegBin.trim();
  const launch = typeof startup.preDotenvEnv.FFMPEG === "string" ? startup.preDotenvEnv.FFMPEG.trim() : "";
  const seed = typeof startup.dotenvSeeds.FFMPEG === "string" ? startup.dotenvSeeds.FFMPEG.trim() : "";
  return launch || seed || "ffmpeg";
}

async function uploadAudio(req, options = {}) {
  const { getRuntime } = require("./resolver");
  const startup = getRuntime().startup;
  const managed = managedDirectory(startup.resolvedHome, true);
  const workDirectory = fs.mkdtempSync(path.join(managed.directory, ".audio-work-"));
  fs.chmodSync(workDirectory, 0o700);
  if ((fs.statSync(workDirectory).mode & 0o777) !== 0o700) throw audioError("SETTINGS_AUDIO_TEMP_FAILED", 500);
  let sourcePath = null;
  let pcmPath = null;
  const installed = [];
  try {
    const multipart = await parseMultipart(req, workDirectory);
    sourcePath = multipart.sourcePath;
    assertCommittedRevision(startup.configPath, multipart.metadata.revision);
    if (!validMp3Signature(sourcePath)) throw audioError("SETTINGS_AUDIO_SIGNATURE_INVALID");
    const stored = storedClips();
    const clips = stored.valid.map(({ record }) => record);
    if (clips.length >= CLIP_LIMIT) throw audioError("SETTINGS_AUDIO_CLIP_LIMIT", 413);
    const recordedBytes = clips.reduce((total, clip) => total + clip.sourceBytes + clip.pcmBytes, 0);
    const existingBytes = Math.max(recordedBytes, existingManagedBytes(managed.directory));
    if (existingBytes + multipart.sourceBytes > TOTAL_LIMIT) throw audioError("SETTINGS_AUDIO_TOTAL_LIMIT", 413);

    const identity = currentTtsIdentity();
    const pcmTemp = randomTemp(workDirectory, "audio-convert");
    fs.closeSync(pcmTemp.descriptor);
    fs.unlinkSync(pcmTemp.path);
    pcmPath = pcmTemp.path;
    await runFfmpeg({
      executable: ffmpegExecutable(options, startup),
      sourcePath,
      pcmPath,
      sampleRate: identity.sampleRate,
      spawnFn: options.spawnFn,
      timeoutMs: options.ffmpegTimeoutMs,
    });
    const pcmStat = lstatNotSymlink(pcmPath);
    if (!pcmStat.isFile() || pcmStat.size <= 0 || pcmStat.size % 2 !== 0) {
      throw audioError("SETTINGS_AUDIO_PCM_INVALID");
    }
    fs.chmodSync(pcmPath, 0o600);
    const durationMs = Math.ceil((pcmStat.size * 1000) / (identity.sampleRate * 2));
    if (durationMs > DURATION_LIMIT_MS) throw audioError("SETTINGS_AUDIO_DURATION_LIMIT", 413);
    if (existingBytes + multipart.sourceBytes + pcmStat.size > TOTAL_LIMIT) {
      throw audioError("SETTINGS_AUDIO_TOTAL_LIMIT", 413);
    }

    const id = typeof options.randomUUID === "function" ? options.randomUUID() : crypto.randomUUID();
    if (!validators.clipRecord.shape.id.safeParse(id).success || clips.some((clip) => clip.id === id)) {
      throw audioError("SETTINGS_AUDIO_ID_FAILED", 500);
    }
    const sourceRelativePath = expectedRelativePath(id, "mp3");
    const pcmRelativePath = expectedRelativePath(id, "pcm");
    const promotionTarget = managedDirectory(startup.resolvedHome, true);
    if (promotionTarget.realDirectory !== managed.realDirectory) throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
    const finalSource = path.join(promotionTarget.directory, `${id}.mp3`);
    const finalPcm = path.join(promotionTarget.directory, `${id}.pcm`);
    for (const target of [finalSource, finalPcm]) {
      try { fs.lstatSync(target); throw audioError("SETTINGS_AUDIO_ID_FAILED", 500); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    fs.renameSync(sourcePath, finalSource);
    sourcePath = null;
    installed.push(finalSource);
    fs.chmodSync(finalSource, 0o600);
    fs.renameSync(pcmPath, finalPcm);
    pcmPath = null;
    installed.push(finalPcm);
    fs.chmodSync(finalPcm, 0o600);
    for (const target of [finalSource, finalPcm]) {
      const stat = lstatNotSymlink(target);
      if (!stat.isFile() || !isWithin(promotionTarget.realDirectory, fs.realpathSync(target))) {
        throw audioError("SETTINGS_AUDIO_PATH_REJECTED");
      }
    }
    fsyncDirectory(promotionTarget.directory);

    const record = validators.clipRecord.parse({
      id,
      role: multipart.metadata.role,
      text: multipart.metadata.text,
      sourceRelativePath,
      pcmRelativePath,
      sourceSha256: multipart.sourceSha256,
      pcmSha256: sha256File(finalPcm),
      cacheKey: canonicalKey(multipart.metadata.text, identity),
      referenceId: identity.referenceId,
      model: identity.model,
      sampleRate: identity.sampleRate,
      speed: identity.speed,
      durationMs,
      sourceBytes: multipart.sourceBytes,
      pcmBytes: pcmStat.size,
      createdAt: (typeof options.now === "function" ? options.now() : new Date()).toISOString(),
    });
    const commit = options.saveAudioClipsFn || saveAudioClips;
    const committed = commit({
      configPath: startup.configPath,
      revision: multipart.metadata.revision,
      clips: [...stored.items, record],
      preserveInvalid: true,
    });
    installed.length = 0;
    return { clip: inspectClip(record, startup.resolvedHome, configuredTtsIdentity()), revision: committed.revision };
  } catch (error) {
    for (const target of installed) unlinkBestEffort(target);
    if (installed.length > 0) {
      try { fsyncDirectory(managed.directory); } catch { /* original error wins */ }
    }
    throw error;
  } finally {
    unlinkBestEffort(sourcePath);
    unlinkBestEffort(pcmPath);
    try { fs.rmdirSync(workDirectory); } catch { /* best effort after owned-file cleanup */ }
  }
}

async function deleteAudio(id, revision, options = {}) {
  if (!validators.clipRecord.shape.id.safeParse(id).success) throw audioError("SETTINGS_AUDIO_NOT_FOUND", 404);
  const { getRuntime } = require("./resolver");
  const startup = getRuntime().startup;
  assertCommittedRevision(startup.configPath, revision);
  const stored = storedClips();
  const selected = stored.valid.find(({ record }) => record.id === id);
  if (!selected) throw audioError("SETTINGS_AUDIO_NOT_FOUND", 404);
  const clip = selected.record;
  const source = resolveOwnedFile(clip, "source", startup.resolvedHome, { allowMissing: true });
  const pcm = resolveOwnedFile(clip, "pcm", startup.resolvedHome, { allowMissing: true });
  const commit = options.saveAudioClipsFn || saveAudioClips;
  const committed = commit({
    configPath: startup.configPath,
    revision,
    clips: stored.items.filter((_item, index) => index !== selected.index),
    preserveInvalid: true,
  });
  try {
    for (const owned of [source, pcm]) {
      try { fs.unlinkSync(owned.path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    fsyncDirectory(path.dirname(source.path));
  } catch {
    throw audioError("SETTINGS_AUDIO_CLEANUP_FAILED", 500);
  }
  return { deleted: true, revision: committed.revision };
}

module.exports = {
  deleteAudio,
  lookupManagedPcm,
  projectClipViews,
  uploadAudio,
  _test: {
    configuredTtsIdentity,
    currentTtsIdentity,
    inspectClip,
    managedDirectory,
    parseMultipart,
    resolveOwnedFile,
    runFfmpeg,
    validMp3Signature,
  },
};
