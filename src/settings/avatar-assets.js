"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseMultipart } = require("./multipart");
const { settingsError } = require("./store");

const AVATAR_FILE_LIMIT = 5 * 1024 * 1024;
const FRAME_FILE_LIMIT = 10 * 1024 * 1024;
const BACKGROUND_FILE_LIMIT = 8 * 1024 * 1024;
const AVATAR_TOTAL_LIMIT = 64 * 1024 * 1024;
const FRAME_NAMES = Object.freeze(["idle", "talk1", "talk2", "talk3", "blink", "talk_blink"]);
const FRAME_NAME_SET = new Set(FRAME_NAMES);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const BACKGROUND_CONTENT_TYPES = Object.freeze(["image/png", "image/jpeg"]);
const BACKGROUND_EXTENSIONS = Object.freeze({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" });
// #294 D1: SOF markers. Baseline / extended / progressive Huffman are accepted; lossless,
// hierarchical and arithmetic-coded frames are rejected.
const JPEG_SOF_ACCEPTED = new Set([0xc0, 0xc1, 0xc2]);
const JPEG_SOF_REJECTED = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const BUNDLED_ASSETS = path.join(__dirname, "..", "..", "assets");
const RIG_SCRIPT = path.join(__dirname, "..", "..", "public", "local-avatar", "local-avatar.js");
let urlCacheInstallVetoed = false;

function avatarError(code, status = 422) {
  return settingsError(code, "Avatar request failed", status);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function lstatNotSymlink(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
  return stat;
}

function ensureDirectory(directory) {
  try {
    if (!lstatNotSymlink(directory).isDirectory()) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}

function managedDirectories(resolvedHome, create = false) {
  const home = path.resolve(resolvedHome);
  if (create) {
    try {
      if (!lstatNotSymlink(home).isDirectory()) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      lstatNotSymlink(home);
    }
  } else if (!lstatNotSymlink(home).isDirectory()) {
    throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
  }
  const assets = path.join(home, "assets");
  const frames = path.join(assets, "avatar-frames");
  if (create) {
    ensureDirectory(assets);
    ensureDirectory(frames);
  } else {
    if (!lstatNotSymlink(assets).isDirectory()) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    try {
      if (!lstatNotSymlink(frames).isDirectory()) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const realHome = fs.realpathSync(home);
  const realAssets = fs.realpathSync(assets);
  const realFrames = fs.existsSync(frames) ? fs.realpathSync(frames) : null;
  if (!isWithin(realHome, realAssets) || (realFrames && (!isWithin(realHome, realFrames) || !isWithin(realAssets, realFrames)))) {
    throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
  }
  if (create) {
    try {
      if (fs.realpathSync(BUNDLED_ASSETS) === realAssets) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return {
    home,
    assets,
    frames,
    avatar: path.join(assets, "avatar.png"),
    background: path.join(assets, "avatar-background"),
    source: path.join(assets, ".avatar-source"),
    realAssets,
    realFrames,
  };
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

function unlinkBestEffort(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

function readOwnedFile(filePath, realDirectory, maxBytes) {
  const stat = lstatNotSymlink(filePath);
  if (!stat.isFile() || stat.size > maxBytes || !isWithin(realDirectory, fs.realpathSync(filePath))) {
    throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readManagedAvatar(resolvedHome) {
  const managed = managedDirectories(resolvedHome, false);
  const bytes = readOwnedFile(managed.avatar, managed.realAssets, AVATAR_FILE_LIMIT);
  validatePngBytes(bytes);
  return bytes;
}

function readFrame(resolvedHome, name) {
  if (!FRAME_NAME_SET.has(name)) throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  const managed = managedDirectories(resolvedHome, false);
  if (!managed.realFrames) throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  const bytes = readOwnedFile(path.join(managed.frames, `${name}.png`), managed.realFrames, FRAME_FILE_LIMIT);
  validatePngBytes(bytes);
  return bytes;
}

function readBundledAvatar() {
  const target = path.join(BUNDLED_ASSETS, "avatar.png");
  const stat = lstatNotSymlink(target);
  if (!stat.isFile() || stat.size > AVATAR_FILE_LIMIT || !isWithin(fs.realpathSync(BUNDLED_ASSETS), fs.realpathSync(target))) {
    throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  }
  const bytes = fs.readFileSync(target);
  validatePngBytes(bytes);
  return bytes;
}

function validatePngBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw avatarError("SETTINGS_AVATAR_PNG_INVALID");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 4096 || height > 4096 || width * height > 16_777_216) {
    throw avatarError("SETTINGS_AVATAR_PNG_INVALID");
  }
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw avatarError("SETTINGS_AVATAR_PNG_INVALID");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw avatarError("SETTINGS_AVATAR_PNG_INVALID");
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !bytes.subarray(offset, end).equals(PNG_IEND)) {
        throw avatarError("SETTINGS_AVATAR_PNG_INVALID");
      }
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended) throw avatarError("SETTINGS_AVATAR_PNG_INVALID");
  return { width, height };
}

// #294 D1: a segment walk, not a decode. Entropy-coded data and APP1 thumbnails are never parsed.
function validateJpegBytes(bytes) {
  const invalid = () => avatarError("SETTINGS_AVATAR_JPEG_INVALID");
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw invalid();
  }
  let offset = 2;
  for (;;) {
    if (offset >= bytes.length || bytes[offset] !== 0xff) throw invalid();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw invalid();
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) throw invalid();
    if (marker === 0xda || JPEG_SOF_REJECTED.has(marker)) throw invalid();
    if (offset + 2 > bytes.length) throw invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid();
    if (JPEG_SOF_ACCEPTED.has(marker)) {
      if (length < 7) throw invalid();
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width === 0 || height === 0 || width > 4096 || height > 4096 || width * height > 16_777_216) {
        throw invalid();
      }
      return { width, height };
    }
    offset += length;
  }
}

function sniffImageType(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return null;
}

function validateImageBytes(bytes, type) {
  return type === "image/jpeg" ? validateJpegBytes(bytes) : validatePngBytes(bytes);
}

function readStagedFile(filePath) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return fs.readFileSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function validatePngFile(filePath) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return validatePngBytes(fs.readFileSync(descriptor)); } finally { fs.closeSync(descriptor); }
}

function existingManagedBytes(managed) {
  let total = 0;
  for (const target of [managed.avatar, managed.background]) {
    try {
      const stat = lstatNotSymlink(target);
      if (!stat.isFile()) return AVATAR_TOTAL_LIMIT;
      total += stat.size;
    } catch (error) {
      if (error.code !== "ENOENT") return AVATAR_TOTAL_LIMIT;
    }
  }
  if (!managed.realFrames) return total;
  for (const name of FRAME_NAMES) {
    try {
      const target = path.join(managed.frames, `${name}.png`);
      const stat = lstatNotSymlink(target);
      if (!stat.isFile() || !isWithin(managed.realFrames, fs.realpathSync(target))) return AVATAR_TOTAL_LIMIT;
      total += stat.size;
    } catch (error) {
      if (error.code !== "ENOENT") return AVATAR_TOTAL_LIMIT;
    }
  }
  return total;
}

function existingTargetBytes(target, realDirectory) {
  try {
    const stat = lstatNotSymlink(target);
    if (!stat.isFile() || !isWithin(realDirectory, fs.realpathSync(target))) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    return stat.size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function writeSourceMarker(managed, source) {
  if (source !== "uploaded" && source !== "url-cache") throw avatarError("SETTINGS_AVATAR_SOURCE_INVALID", 500);
  const temp = path.join(managed.assets, `.avatar-source-${process.pid}-${crypto.randomBytes(12).toString("hex")}`);
  const backup = path.join(managed.assets, `.avatar-source-backup-${process.pid}-${crypto.randomBytes(12).toString("hex")}`);
  let backedUp = false;
  let installed = false;
  try {
    fs.writeFileSync(temp, `${source}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temp, 0o600);
    try {
      const stat = lstatNotSymlink(managed.source);
      if (!stat.isFile() || !isWithin(managed.realAssets, fs.realpathSync(managed.source))) {
        throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
      }
      fs.renameSync(managed.source, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.renameSync(temp, managed.source);
    installed = true;
    fs.chmodSync(managed.source, 0o600);
    if (!lstatNotSymlink(managed.source).isFile() || !isWithin(managed.realAssets, fs.realpathSync(managed.source))) {
      throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    }
    unlinkBestEffort(backup);
    fsyncDirectory(managed.assets);
  } catch (error) {
    if (installed) unlinkBestEffort(managed.source);
    if (backedUp) {
      try { fs.renameSync(backup, managed.source); } catch { /* original error wins */ }
    }
    throw error;
  } finally {
    unlinkBestEffort(temp);
  }
}

function readSourceMarker(managed) {
  try {
    const bytes = readOwnedFile(managed.source, managed.realAssets, 32).toString("utf8").trim();
    return bytes === "uploaded" || bytes === "url-cache" ? bytes : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function promoteFile(stagedPath, target, realDirectory, marker) {
  const backup = `${target}.backup-${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  let backedUp = false;
  let installed = false;
  try {
    try {
      lstatNotSymlink(target);
      fs.renameSync(target, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.renameSync(stagedPath, target);
    installed = true;
    fs.chmodSync(target, 0o600);
    if (!lstatNotSymlink(target).isFile() || !isWithin(realDirectory, fs.realpathSync(target))) {
      throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    }
    marker?.();
    unlinkBestEffort(backup);
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if (installed) unlinkBestEffort(target);
    if (backedUp) {
      try { fs.renameSync(backup, target); } catch { /* original error wins */ }
    }
    throw error;
  }
}

function multipartErrorFactory(reason, status) {
  if (reason === "MEDIA_TYPE_UNSUPPORTED") {
    return settingsError("SETTINGS_MEDIA_TYPE_UNSUPPORTED", "Content type not supported", 415);
  }
  const codes = {
    MULTIPART_INVALID: "SETTINGS_AVATAR_MULTIPART_INVALID",
    FILENAME_REJECTED: "SETTINGS_AVATAR_FILENAME_REJECTED",
    FILE_TOO_LARGE: "SETTINGS_AVATAR_FILE_TOO_LARGE",
  };
  return avatarError(codes[reason] || "SETTINGS_AVATAR_MULTIPART_INVALID", status);
}

async function uploadAsset(req, { resolvedHome, name = null }) {
  const isFrame = name !== null;
  if (isFrame && !FRAME_NAME_SET.has(name)) throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  const managed = managedDirectories(resolvedHome, true);
  const workParent = isFrame ? managed.frames : managed.assets;
  const workDirectory = fs.mkdtempSync(path.join(workParent, ".avatar-work-"));
  fs.chmodSync(workDirectory, 0o700);
  let stagedPath = null;
  try {
    const multipart = await parseMultipart(req, workDirectory, {
      filePartName: "image",
      metadataPartName: null,
      contentTypes: ["image/png"],
      extensions: [".png"],
      encodedRejectPattern: /%[0-9a-f]{2}/i,
      maxFileBytes: isFrame ? FRAME_FILE_LIMIT : AVATAR_FILE_LIMIT,
      maxMetadataBytes: 0,
      errorFactory: multipartErrorFactory,
    });
    stagedPath = multipart.filePath;
    const dimensions = validatePngFile(stagedPath);
    const promotion = managedDirectories(resolvedHome, true);
    const target = isFrame ? path.join(promotion.frames, `${name}.png`) : promotion.avatar;
    const realDirectory = isFrame ? promotion.realFrames : promotion.realAssets;
    const total = existingManagedBytes(promotion);
    const replacedBytes = existingTargetBytes(target, realDirectory);
    if (total - replacedBytes + multipart.fileBytes > AVATAR_TOTAL_LIMIT) {
      throw avatarError("SETTINGS_AVATAR_TOTAL_LIMIT", 413);
    }
    promoteFile(stagedPath, target, realDirectory, isFrame ? null : () => writeSourceMarker(promotion, "uploaded"));
    stagedPath = null;
    return {
      name: isFrame ? name : "static",
      bytes: multipart.fileBytes,
      sha256: multipart.fileSha256,
      ...dimensions,
    };
  } finally {
    unlinkBestEffort(stagedPath);
    try { fs.rmdirSync(workDirectory); } catch { /* best effort */ }
  }
}

// #294 D1/D2: PNG or JPEG; the magic bytes decide the type, and the declared content type and
// extension must agree with them. One extension-less, server-chosen file.
async function uploadBackground(req, { resolvedHome }) {
  const managed = managedDirectories(resolvedHome, true);
  const workDirectory = fs.mkdtempSync(path.join(managed.assets, ".avatar-work-"));
  fs.chmodSync(workDirectory, 0o700);
  let stagedPath = null;
  try {
    const multipart = await parseMultipart(req, workDirectory, {
      filePartName: "image",
      metadataPartName: null,
      contentTypes: [...BACKGROUND_CONTENT_TYPES],
      extensions: Object.keys(BACKGROUND_EXTENSIONS),
      encodedRejectPattern: /%[0-9a-f]{2}/i,
      maxFileBytes: BACKGROUND_FILE_LIMIT,
      maxMetadataBytes: 0,
      errorFactory: multipartErrorFactory,
    });
    stagedPath = multipart.filePath;
    const declaredType = multipart.fileContentType;
    const extension = Object.keys(BACKGROUND_EXTENSIONS).find((item) => multipart.fileName.endsWith(item));
    const bytes = readStagedFile(stagedPath);
    const sniffed = sniffImageType(bytes);
    if (sniffed && (sniffed !== declaredType || BACKGROUND_EXTENSIONS[extension] !== sniffed)) {
      throw avatarError("SETTINGS_AVATAR_TYPE_MISMATCH", 415);
    }
    const type = sniffed || declaredType;
    const dimensions = validateImageBytes(bytes, type);
    const promotion = managedDirectories(resolvedHome, true);
    const total = existingManagedBytes(promotion);
    const replacedBytes = existingTargetBytes(promotion.background, promotion.realAssets);
    if (total - replacedBytes + multipart.fileBytes > AVATAR_TOTAL_LIMIT) {
      throw avatarError("SETTINGS_AVATAR_TOTAL_LIMIT", 413);
    }
    promoteFile(stagedPath, promotion.background, promotion.realAssets, null);
    stagedPath = null;
    return {
      name: "background",
      type,
      bytes: multipart.fileBytes,
      sha256: multipart.fileSha256,
      ...dimensions,
    };
  } finally {
    unlinkBestEffort(stagedPath);
    try { fs.rmdirSync(workDirectory); } catch { /* best effort */ }
  }
}

// #294 D2: re-sniffed and fully validated on every read; anything else is "no image".
function readBackground(resolvedHome) {
  const managed = managedDirectories(resolvedHome, false);
  const bytes = readOwnedFile(managed.background, managed.realAssets, BACKGROUND_FILE_LIMIT);
  const type = sniffImageType(bytes);
  if (!type) throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  return { bytes, type, ...validateImageBytes(bytes, type) };
}

function backgroundPresent(resolvedHome) {
  try { readBackground(resolvedHome); return true; } catch { return false; }
}

// #294 D5: the join-time snapshot. `null` when no file exists; any other failure throws so the
// caller can log its code and fall back.
function readBackgroundSnapshot(resolvedHome) {
  let background;
  try { background = readBackground(resolvedHome); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return {
    bytes: background.bytes,
    type: background.type,
    version: crypto.createHash("sha256").update(background.bytes).digest("hex").slice(0, 16),
  };
}

function deleteBackground(resolvedHome) {
  let managed;
  try { managed = managedDirectories(resolvedHome, false); } catch (error) {
    if (error.code === "ENOENT") return { deleted: true };
    throw error;
  }
  try {
    const stat = lstatNotSymlink(managed.background);
    if (!stat.isFile() || !isWithin(managed.realAssets, fs.realpathSync(managed.background))) {
      throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    }
    unlinkBestEffort(managed.background);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fsyncDirectory(managed.assets);
  return { deleted: true };
}

function deleteStatic(resolvedHome) {
  urlCacheInstallVetoed = true;
  let managed;
  try { managed = managedDirectories(resolvedHome, false); } catch (error) {
    if (error.code === "ENOENT") return { deleted: true };
    throw error;
  }
  for (const target of [managed.avatar, managed.source]) {
    try {
      const stat = lstatNotSymlink(target);
      if (!stat.isFile() || !isWithin(managed.realAssets, fs.realpathSync(target))) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
      fs.unlinkSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  fsyncDirectory(managed.assets);
  return { deleted: true };
}

function deleteFrame(resolvedHome, name) {
  if (!FRAME_NAME_SET.has(name)) throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  let managed;
  try { managed = managedDirectories(resolvedHome, false); } catch (error) {
    if (error.code === "ENOENT") return { deleted: true, name };
    throw error;
  }
  if (!managed.realFrames) return { deleted: true, name };
  const target = path.join(managed.frames, `${name}.png`);
  try {
    const stat = lstatNotSymlink(target);
    if (!stat.isFile() || !isWithin(managed.realFrames, fs.realpathSync(target))) throw avatarError("SETTINGS_AVATAR_PATH_REJECTED");
    fs.unlinkSync(target);
    fsyncDirectory(managed.frames);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { deleted: true, name };
}

function deleteFrames(resolvedHome) {
  for (const name of FRAME_NAMES) deleteFrame(resolvedHome, name);
  return { deleted: true, names: [...FRAME_NAMES] };
}

function parseFrameName(pathname) {
  const rawPath = String(pathname || "");
  const match = /^\/api\/settings\/avatar\/frames\/([^/]+?)(?:\/preview)?$/.exec(rawPath);
  const raw = match?.[1] || "";
  if (!raw || raw.includes("%") || raw.includes("\0") || raw.includes("/") || raw.includes("\\")) {
    throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  }
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404); }
  if (!FRAME_NAME_SET.has(decoded)) throw avatarError("SETTINGS_AVATAR_NOT_FOUND", 404);
  return decoded;
}

function staticSource(resolvedHome, avatarUrlConfigured) {
  try {
    const managed = managedDirectories(resolvedHome, false);
    readManagedAvatar(resolvedHome);
    return readSourceMarker(managed) || (avatarUrlConfigured ? "url-cache" : "uploaded");
  } catch {
    return "bundled";
  }
}

function inspectRig() {
  try {
    const script = fs.readFileSync(RIG_SCRIPT, "utf8");
    const match = script.match(/const RIG_MODEL_PROVENANCE = "(procedural|external)";/);
    return { provenance: match?.[1] || "unknown", scriptBytes: Buffer.byteLength(script) };
  } catch {
    return { provenance: "unknown", scriptBytes: 0 };
  }
}

function inspectBackground(resolvedHome) {
  const previewUrl = "/api/settings/avatar/background/preview";
  try {
    const background = readBackground(resolvedHome);
    return {
      present: true,
      type: background.type,
      bytes: background.bytes.length,
      width: background.width,
      height: background.height,
      previewUrl,
    };
  } catch {
    return { present: false, type: null, bytes: 0, width: null, height: null, previewUrl };
  }
}

function inspectAssets(resolvedHome, avatarUrlConfigured = false) {
  const source = staticSource(resolvedHome, avatarUrlConfigured);
  let staticBytes;
  try { staticBytes = source === "bundled" ? readBundledAvatar() : readManagedAvatar(resolvedHome); } catch { staticBytes = Buffer.alloc(0); }
  const frames = FRAME_NAMES.map((name) => {
    try {
      const bytes = readFrame(resolvedHome, name);
      const dimensions = validatePngBytes(bytes);
      return {
        name, present: true, bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        previewUrl: `/api/settings/avatar/frames/${name}/preview`,
        ...dimensions,
      };
    } catch {
      return { name, present: false };
    }
  });
  return {
    static: {
      source,
      bytes: staticBytes.length,
      sha256: staticBytes.length ? crypto.createHash("sha256").update(staticBytes).digest("hex") : null,
      previewUrl: "/api/settings/avatar/static/preview",
    },
    frames,
    background: inspectBackground(resolvedHome),
    rig: inspectRig(),
    limits: {
      staticBytes: AVATAR_FILE_LIMIT,
      frameBytes: FRAME_FILE_LIMIT,
      backgroundBytes: BACKGROUND_FILE_LIMIT,
      totalBytes: AVATAR_TOTAL_LIMIT,
    },
  };
}

function readStaticPreview(resolvedHome) {
  try { return readManagedAvatar(resolvedHome); } catch { return readBundledAvatar(); }
}

function installUrlCacheAvatar(bytes, resolvedHome) {
  if (urlCacheInstallVetoed) return false;
  if (!Buffer.isBuffer(bytes) || bytes.length > AVATAR_FILE_LIMIT) return false;
  try { validatePngBytes(bytes); } catch { return false; }
  const managed = managedDirectories(resolvedHome, true);
  try { lstatNotSymlink(managed.avatar); return false; } catch (error) { if (error.code !== "ENOENT") return false; }
  try { if (readSourceMarker(managed) === "uploaded") return false; } catch { return false; }
  const workDirectory = fs.mkdtempSync(path.join(managed.assets, ".avatar-url-work-"));
  fs.chmodSync(workDirectory, 0o700);
  const staged = path.join(workDirectory, "avatar.png");
  try {
    fs.writeFileSync(staged, bytes, { mode: 0o600, flag: "wx" });
    if (urlCacheInstallVetoed) return false;
    try { lstatNotSymlink(managed.avatar); return false; } catch (error) { if (error.code !== "ENOENT") return false; }
    try { if (readSourceMarker(managed) === "uploaded") return false; } catch { return false; }
    const total = existingManagedBytes(managed);
    const replacedBytes = existingTargetBytes(managed.avatar, managed.realAssets);
    if (total - replacedBytes + bytes.length > AVATAR_TOTAL_LIMIT) return false;
    promoteFile(staged, managed.avatar, managed.realAssets, () => writeSourceMarker(managed, "url-cache"));
    return true;
  } finally {
    unlinkBestEffort(staged);
    try { fs.rmdirSync(workDirectory); } catch { /* best effort */ }
  }
}

module.exports = {
  AVATAR_FILE_LIMIT,
  AVATAR_TOTAL_LIMIT,
  BACKGROUND_FILE_LIMIT,
  FRAME_FILE_LIMIT,
  FRAME_NAMES,
  backgroundPresent,
  deleteBackground,
  deleteFrame,
  deleteFrames,
  deleteStatic,
  inspectAssets,
  installUrlCacheAvatar,
  parseFrameName,
  readFrame,
  readBackground,
  readBackgroundSnapshot,
  readBundledAvatar,
  readManagedAvatar,
  readStaticPreview,
  uploadAsset,
  uploadBackground,
  validateJpegBytes,
  validatePngBytes,
  _test: { existingManagedBytes, managedDirectories, readSourceMarker, writeSourceMarker },
};
