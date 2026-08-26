"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { EMOTION_TAGS } = require("../messages");
const { MASK, SETTINGS_REGISTRY } = require("./registry");
const { buildEnvelope, getBootstrapSeedFields, getRawConfig, getRuntime, meaningful, readPath } = require("./resolver");
const { saveFields, settingsError } = require("./store");
const {
  exportDocumentSchema,
  importRequestSchema,
  parseStrict,
  revisionOnlySchema,
  settingsMutationSchema,
  sha256RevisionOnlySchema,
} = require("./schemas");

const JSON_LIMIT = 256 * 1024;
const CONNECTION_JSON_LIMIT = 4 * 1024;
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

function safeEmbeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function unwrapSchema(schema) {
  let current = schema;
  while (["nullable", "optional", "default"].includes(current?._def?.type) && current._def.innerType) {
    current = current._def.innerType;
  }
  return current;
}

function clientControl(entry) {
  if (entry.credential === "class-1") return { control: "credential" };
  const schema = unwrapSchema(entry.schema);
  const type = schema?._def?.type;
  if (type === "boolean") return { control: "boolean" };
  if (type === "number") return { control: "number" };
  if (type === "array") return { control: "array" };
  if (type === "enum") return { control: "select", options: [...schema.options] };
  if (type === "literal") return { control: "select", options: [...schema._def.values] };
  return { control: "text" };
}

function buildSettingsUiManifest() {
  return {
    fields: SETTINGS_REGISTRY.map((entry) => ({
      id: entry.id,
      ux: entry.ux,
      credential: entry.credential,
      apply: entry.apply,
      envAlias: entry.envAlias,
      writeSurface: entry.writeSurface,
      ...(Object.prototype.hasOwnProperty.call(entry, "defaultValue")
        ? { defaultValue: structuredClone(entry.defaultValue) }
        : {}),
      ...clientControl(entry),
    })),
  };
}

function renderSettingsHtml(source) {
  if (!Array.isArray(EMOTION_TAGS)) {
    throw settingsError("SETTINGS_TRANSACTION_FAILED", "Settings UI metadata is unavailable", 500);
  }
  return source
    .replaceAll("__SETTINGS_UI_MANIFEST__", safeEmbeddedJson(buildSettingsUiManifest()))
    .replaceAll("__MEETMATE_EMOTION_TAGS__", safeEmbeddedJson(EMOTION_TAGS));
}

function writeStaticAsset(res, asset) {
  let bytes = fs.readFileSync(path.join(PUBLIC_DIR, asset.filename));
  if (asset.filename === "settings.html") bytes = Buffer.from(renderSettingsHtml(bytes.toString("utf8")));
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
    SETTINGS_IMPORT_VERSION_UNSUPPORTED: 409,
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
    SETTINGS_IMPORT_VERSION_UNSUPPORTED: "Settings import version is not supported",
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

function importableEntries() {
  return SETTINGS_REGISTRY.filter((entry) => entry.writeSurface === "settings" && entry.credential === "none");
}

function buildExportDocument(now = new Date()) {
  const raw = getRawConfig();
  const settings = {};
  for (const entry of importableEntries()) {
    const rawValue = readPath(raw, entry.path);
    if (!meaningful(rawValue)) continue;
    const parsed = entry.schema.safeParse(rawValue);
    if (parsed.success) settings[entry.id] = parsed.data;
  }
  return parseStrict(exportDocumentSchema, {
    format: "meetmate-settings",
    version: 1,
    exportedAt: now.toISOString(),
    settings,
  });
}

function parseImportRequest(value) {
  const document = value && typeof value === "object" && !Array.isArray(value) ? value.document : null;
  if (document && typeof document === "object" && !Array.isArray(document)) {
    const hasFormat = Object.prototype.hasOwnProperty.call(document, "format");
    const hasVersion = Object.prototype.hasOwnProperty.call(document, "version");
    if ((hasFormat && document.format !== "meetmate-settings") || (hasVersion && document.version !== 1)) {
      throw settingsError("SETTINGS_IMPORT_VERSION_UNSUPPORTED", "Settings import version is not supported", 409);
    }
  }
  return parseStrict(importRequestSchema, value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function importSettings(value) {
  const request = parseImportRequest(value);
  const raw = getRawConfig();
  const fields = {};
  const imported = [];
  const skipped = [];
  for (const entry of importableEntries()) {
    if (!Object.prototype.hasOwnProperty.call(request.document.settings, entry.id)) continue;
    const next = request.document.settings[entry.id];
    const current = entry.schema.safeParse(readPath(raw, entry.path));
    if (current.success && sameValue(current.data, next)) {
      skipped.push(entry.id);
    } else {
      fields[entry.id] = next;
      imported.push(entry.id);
    }
  }
  const startup = getRuntime().startup;
  saveFields({ configPath: startup.configPath, revision: request.revision, fields });
  return {
    ...buildEnvelope(),
    import: { imported: imported.sort(), skipped: skipped.sort() },
  };
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

      if (req.method === "GET" && url.pathname === "/api/settings/export") {
        const now = typeof options.now === "function" ? options.now() : new Date();
        writeJson(res, 200, buildExportDocument(now), {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="meetmate-settings.json"',
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/settings/import") {
        requireSameOrigin(req, settingsOptions);
        writeJson(res, 200, importSettings(await readJson(req, JSON_LIMIT)));
        return true;
      }

      const connectionMatch = url.pathname.match(/^\/api\/settings\/connections\/([^/]+)\/test$/);
      if (req.method === "POST" && connectionMatch) {
        requireSameOrigin(req, settingsOptions);
        if (!PROVIDERS.has(connectionMatch[1])) {
          throw settingsError("SETTINGS_VALIDATION_FAILED", "Request validation failed", 422);
        }
        parseStrict(sha256RevisionOnlySchema, await readJson(req, CONNECTION_JSON_LIMIT));
        throw settingsError("TEST_NOT_IMPLEMENTED", "Settings feature is not implemented", 501);
      }

      const childShell = (req.method === "POST" && ["/api/settings/tts-preview", "/api/settings/audio"].includes(url.pathname))
        || (req.method === "DELETE" && url.pathname.startsWith("/api/settings/audio/"));
      if (childShell) {
        if (req.method !== "GET") {
          requireSameOrigin(req, settingsOptions);
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

module.exports = {
  createSettingsHandler,
  isLocalAdminRequest,
  writeError,
  _test: {
    buildExportDocument,
    buildSettingsUiManifest,
    importSettings,
    parseImportRequest,
    readJson,
    renderSettingsHtml,
    requireSameOrigin,
    safeEmbeddedJson,
  },
};
