"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { MASK, SETTINGS_REGISTRY } = require("./registry");
const { buildEnvelope, getBootstrapSeedFields, getRawConfig, getRuntime, meaningful, readPath } = require("./resolver");
const { readConfigState, saveFields, settingsError } = require("./store");
const { parseStrict, settingsMutationSchema, revisionOnlySchema } = require("./schemas");

const JSON_LIMIT = 256 * 1024;
const PROVIDERS = new Set(["soniox", "deepgram", "fish-audio", "attendee", "slack"]);
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const SETTINGS_ASSETS = new Map([
  ["/settings", { filename: "settings.html", contentType: "text/html; charset=utf-8" }],
  ["/settings-assets/settings.css", { filename: "settings.css", contentType: "text/css; charset=utf-8" }],
  ["/settings-assets/settings.js", { filename: "settings.js", contentType: "application/javascript; charset=utf-8" }],
]);

function writeJson(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(bytes);
}

function writeStaticAsset(res, asset) {
  const bytes = fs.readFileSync(path.join(PUBLIC_DIR, asset.filename));
  res.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  res.end(bytes);
}

function writeError(res, error, requestId) {
  const status = error.status || ({
    SETTINGS_MALFORMED_JSON: 400,
    SETTINGS_ORIGIN_REJECTED: 403,
    SETTINGS_REVISION_CONFLICT: 409,
    SETTINGS_BODY_TOO_LARGE: 413,
    SETTINGS_MEDIA_TYPE_UNSUPPORTED: 415,
    SETTINGS_VALIDATION_FAILED: 422,
    SETTINGS_MULTI_PROCESS_UNSUPPORTED: 503,
    TEST_NOT_IMPLEMENTED: 501,
  }[error.code] || 500);
  const code = typeof error.code === "string" && (error.code.startsWith("SETTINGS_") || error.code === "TEST_NOT_IMPLEMENTED")
    ? error.code
    : "SETTINGS_TRANSACTION_FAILED";
  const messages = {
    SETTINGS_MALFORMED_JSON: "Malformed JSON",
    SETTINGS_ORIGIN_REJECTED: "Request origin rejected",
    SETTINGS_REVISION_CONFLICT: "Settings revision changed",
    SETTINGS_BODY_TOO_LARGE: "Request body too large",
    SETTINGS_MEDIA_TYPE_UNSUPPORTED: "Content type not supported",
    SETTINGS_VALIDATION_FAILED: "Request validation failed",
    SETTINGS_MULTI_PROCESS_UNSUPPORTED: "Settings are busy",
    SETTINGS_SYMLINK_REJECTED: "Settings path is not allowed",
    TEST_NOT_IMPLEMENTED: "Settings feature is not implemented",
  };
  const body = { error: { code, message: messages[code] || "Settings request failed" } };
  if (Array.isArray(error.details)) body.error.details = error.details.map(({ path, code }) => ({ path, code }));
  body.error.requestId = requestId;
  writeJson(res, status, body, { Connection: "close" });
}

function actualPort(req, options) {
  return Number(typeof options.port === "function" ? options.port() : options.port) || Number(req.socket?.localPort) || 5005;
}

function isLoopback(address) {
  const normalized = String(address || "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function isLocalAdminRequest(req, options) {
  if (!isLoopback(req.socket?.localAddress)) return false;
  if (Object.prototype.hasOwnProperty.call(req.headers, "forwarded")
      || Object.keys(req.headers).some((name) => name.startsWith("x-forwarded-"))) return false;
  const port = actualPort(req, options);
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]).has(req.headers.host);
}

function requireSameOrigin(req, options) {
  const port = actualPort(req, options);
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
  if (!origins.has(req.headers.origin) || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
    throw settingsError("SETTINGS_ORIGIN_REJECTED", "Request origin rejected", 403);
  }
}

async function readJson(req, limit) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw settingsError("SETTINGS_MEDIA_TYPE_UNSUPPORTED", "Content type not supported", 415);
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw settingsError("SETTINGS_BODY_TOO_LARGE", "Request body too large", 413);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw settingsError("SETTINGS_MALFORMED_JSON", "Malformed JSON", 400);
  }
}

function prepareMutationFields(fields, revision) {
  const raw = getRawConfig();
  const prepared = revision === "bootstrap" ? getBootstrapSeedFields() : {};
  for (const [id, value] of Object.entries(fields)) {
    const entry = SETTINGS_REGISTRY.find((item) => item.id === id);
    if (entry?.credential === "class-1" && value === MASK) {
      const current = readPath(raw, entry.path);
      if (meaningful(current)) prepared[id] = current;
      continue;
    }
    prepared[id] = value;
  }
  return prepared;
}

async function migrateClass1(req, options) {
  const body = parseStrict(revisionOnlySchema, await readJson(req, JSON_LIMIT));
  const startup = getRuntime().startup;
  const raw = getRawConfig();
  const fields = {};
  const imported = [];
  const skipped = [];
  for (const entry of SETTINGS_REGISTRY.filter((item) => item.credential === "class-1")) {
    const current = readPath(raw, entry.path);
    const seed = typeof startup.dotenvSeeds[entry.envAlias] === "string" ? startup.dotenvSeeds[entry.envAlias].trim() : undefined;
    if (!meaningful(current) && meaningful(seed) && entry.schema.safeParse(seed).success) {
      fields[entry.id] = seed;
      imported.push(entry.id);
    } else {
      skipped.push(entry.id);
    }
  }
  const committed = saveFields({
    configPath: startup.configPath,
    revision: body.revision,
    fields: { ...(body.revision === "bootstrap" ? getBootstrapSeedFields() : {}), ...fields },
  });
  return { imported: imported.sort(), skipped: skipped.sort(), revision: committed.revision };
}

function createSettingsHandler(options = {}) {
  const settingsOptions = { port: options.port || 5005 };
  return async function handleSettings(req, res) {
    let url;
    try { url = new URL(req.url || "/", "http://localhost"); } catch { return false; }
    const isSettingsPath = url.pathname === "/settings"
      || url.pathname === "/api/settings"
      || url.pathname.startsWith("/api/settings/")
      || url.pathname.startsWith("/settings-assets/");
    if (!isSettingsPath) return false;
    const requestId = crypto.randomUUID();
    if (!isLocalAdminRequest(req, settingsOptions)) {
      req.resume?.();
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("Not Found");
      return true;
    }

    try {
      const staticAsset = SETTINGS_ASSETS.get(url.pathname);
      if (req.method === "GET" && staticAsset) {
        writeStaticAsset(res, staticAsset);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/settings") {
        writeJson(res, 200, buildEnvelope());
        return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/settings") {
        requireSameOrigin(req, settingsOptions);
        const mutation = parseStrict(settingsMutationSchema, await readJson(req, JSON_LIMIT));
        const startup = getRuntime().startup;
        const committed = saveFields({
          configPath: startup.configPath,
          revision: mutation.revision,
          fields: prepareMutationFields(mutation.fields, mutation.revision),
        });
        writeJson(res, 200, buildEnvelope());
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/settings/migrate-env-class1") {
        requireSameOrigin(req, settingsOptions);
        writeJson(res, 200, await migrateClass1(req, settingsOptions));
        return true;
      }

      const connectionMatch = url.pathname.match(/^\/api\/settings\/connections\/([^/]+)\/test$/);
      const childShell = (req.method === "GET" && url.pathname === "/api/settings/export")
        || (req.method === "POST" && ["/api/settings/import", "/api/settings/tts-preview", "/api/settings/audio"].includes(url.pathname))
        || (req.method === "DELETE" && url.pathname.startsWith("/api/settings/audio/"))
        || Boolean(connectionMatch);
      if (childShell) {
        if (req.method !== "GET") {
          requireSameOrigin(req, settingsOptions);
          if (connectionMatch && !PROVIDERS.has(connectionMatch[1])) {
            throw settingsError("SETTINGS_VALIDATION_FAILED", "Request validation failed", 422);
          }
        }
        throw settingsError("TEST_NOT_IMPLEMENTED", "Settings feature is not implemented", 501);
      }

      req.resume?.();
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("Not Found");
      return true;
    } catch (error) {
      req.resume?.();
      writeError(res, error, requestId);
      return true;
    }
  };
}

module.exports = { createSettingsHandler, isLocalAdminRequest, writeError, _test: { readJson, requireSameOrigin } };
