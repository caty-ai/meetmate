"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { SETTINGS_REGISTRY } = require("./registry");
const { stripLegacyClass2 } = require("./class2-migration");

let localWriteActive = false;

function settingsError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function rejectSymlink(filePath) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw settingsError("SETTINGS_SYMLINK_REJECTED", "Settings path is not allowed", 422);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function readNoFollow(filePath) {
  rejectSymlink(filePath);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ELOOP") throw settingsError("SETTINGS_SYMLINK_REJECTED", "Settings path is not allowed", 422);
    throw error;
  }
  try {
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readConfigState(configPath) {
  let bytes;
  try {
    bytes = readNoFollow(configPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, valid: false, bytes: null, parsed: null, revision: "bootstrap", fingerprint: "missing" };
    }
    throw error;
  }
  const fingerprint = `bytes:${sha256(bytes)}`;
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root_not_object");
    return { exists: true, valid: true, bytes, parsed, revision: sha256(bytes), fingerprint };
  } catch {
    return { exists: true, valid: false, bytes, parsed: null, revision: "bootstrap", fingerprint };
  }
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

function writeTemp(directory, prefix, bytes) {
  const destination = path.join(directory, `.${prefix}-${process.pid}-${crypto.randomBytes(12).toString("hex")}`);
  const descriptor = fs.openSync(destination, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return destination;
}

function pidIsLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function acquireLock(configPath) {
  if (localWriteActive) throw settingsError("SETTINGS_MULTI_PROCESS_UNSUPPORTED", "Settings are busy", 503);
  localWriteActive = true;
  const lockPath = path.join(path.dirname(configPath), ".meetmate-settings.lock");
  try {
    rejectSymlink(lockPath);
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(readNoFollow(lockPath).toString("utf8")); } catch { /* unverifiable means live */ }
      if (owner && !pidIsLive(owner.pid)) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
      } else {
        throw settingsError("SETTINGS_MULTI_PROCESS_UNSUPPORTED", "Another process owns settings", 503);
      }
    }
  } catch (error) {
    localWriteActive = false;
    throw error;
  }
  return () => {
    try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== "ENOENT") console.warn("Settings lock cleanup failed"); }
    localWriteActive = false;
  };
}

function assertRevision(state, revision) {
  if (revision === "bootstrap") {
    if (state.valid) throw settingsError("SETTINGS_REVISION_CONFLICT", "Settings revision changed", 409);
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(revision) || !state.valid || state.revision !== revision) {
    throw settingsError("SETTINGS_REVISION_CONFLICT", "Settings revision changed", 409);
  }
}

function applyPath(document, dottedPath, value) {
  const parts = dottedPath.split(".");
  const leaf = parts.pop();
  let current = document;
  for (const part of parts) {
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  if (value === undefined) delete current[leaf];
  else current[leaf] = structuredClone(value);
}

function commitWholeConfig({ configPath, revision, mutate }) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  rejectSymlink(configPath);
  const release = acquireLock(configPath);
  let temporary = null;
  let backup = null;
  let replaced = false;
  let before;
  try {
    before = readConfigState(configPath);
    assertRevision(before, revision);
    const document = before.valid ? structuredClone(before.parsed) : {};
    stripLegacyClass2(document);
    mutate(document);
    stripLegacyClass2(document);
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    const directory = path.dirname(configPath);
    if (before.exists) backup = writeTemp(directory, "settings-backup", before.bytes);
    temporary = writeTemp(directory, "settings-write", bytes);

    const precommit = readConfigState(configPath);
    assertRevision(precommit, revision);
    if (revision === "bootstrap" && precommit.fingerprint !== before.fingerprint) {
      throw settingsError("SETTINGS_REVISION_CONFLICT", "Settings revision changed", 409);
    }

    fs.renameSync(temporary, configPath);
    temporary = null;
    replaced = true;
    fs.chmodSync(configPath, 0o600);
    fsyncDirectory(directory);
    const committed = readConfigState(configPath);
    if (!committed.valid) throw settingsError("SETTINGS_TRANSACTION_FAILED", "Settings transaction failed", 500);
    if (backup) { fs.unlinkSync(backup); backup = null; }
    return committed;
  } catch (error) {
    if (replaced) {
      try {
        if (backup) {
          fs.renameSync(backup, configPath);
          backup = null;
        } else {
          fs.unlinkSync(configPath);
        }
        fsyncDirectory(path.dirname(configPath));
      } catch {
        throw settingsError("SETTINGS_ROLLBACK_FAILED", "Settings transaction rollback failed", 500);
      }
    }
    throw String(error.code || "").startsWith("SETTINGS_")
      ? error
      : settingsError("SETTINGS_TRANSACTION_FAILED", "Settings transaction failed", 500);
  } finally {
    for (const artifact of [temporary, backup]) {
      if (!artifact) continue;
      try { fs.unlinkSync(artifact); } catch { /* best effort */ }
    }
    release();
  }
}

function saveFields({ configPath, revision, fields }) {
  const byId = new Map(SETTINGS_REGISTRY.map((entry) => [entry.id, entry]));
  return commitWholeConfig({
    configPath,
    revision,
    mutate(document) {
      for (const [id, value] of Object.entries(fields)) {
        const entry = byId.get(id);
        if (!entry || entry.writeSurface !== "settings") continue;
        applyPath(document, entry.path, value === null ? undefined : value);
      }
    },
  });
}

module.exports = {
  commitWholeConfig,
  readConfigState,
  rejectSymlink,
  saveFields,
  settingsError,
  _test: { acquireLock, assertRevision, fsyncDirectory, sha256, writeTemp },
};
