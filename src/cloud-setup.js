"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");

const AUTHORIZE_TTL_MS = 600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONFIG_REFRESH_AFTER_S = 86_400;
const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_ERRORS = new Set(["access_denied", "state_invalid", "token_invalid", "server_error"]);

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function tokenId(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function cloudError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeCloudUrl(value) {
  const raw = String(value || "").trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw cloudError("SETTINGS_CLOUD_URL_INVALID", "Cloud URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw cloudError("SETTINGS_CLOUD_URL_INVALID", "Cloud URL is invalid");
  }
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function cloudEndpoint(cloudUrl, pathname) {
  return new URL(pathname.replace(/^\/+/, ""), `${normalizeCloudUrl(cloudUrl)}/`).toString();
}

function validHubUrl(value) {
  try {
    const parsed = new URL(value);
    return ["ws:", "wss:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

function defaultOpenUrl(url) {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", `"${url.replaceAll('"', "%22")}"`] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The authorize URL is always returned so the caller can present a manual link.
  }
}

async function problemFrom(response) {
  try {
    const body = await response.json();
    return typeof body?.type === "string" ? body.type : null;
  } catch {
    return null;
  }
}

function createCloudSetup(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const now = options.now || Date.now;
  const openUrl = options.openUrl || defaultOpenUrl;
  const authorizeTtlMs = options.authorizeTtlMs ?? AUTHORIZE_TTL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const setTimer = options.setTimeoutFn || setTimeout;
  const clearTimer = options.clearTimeoutFn || clearTimeout;
  const createServer = options.createServer || http.createServer;
  const logger = options.logger;

  function beginConnect({ cloudUrl }) {
    const baseUrl = normalizeCloudUrl(cloudUrl);
    const codeVerifier = toBase64Url(crypto.randomBytes(32));
    const codeChallenge = toBase64Url(crypto.createHash("sha256").update(codeVerifier).digest());
    const state = toBase64Url(crypto.randomBytes(24));
    const startedAt = Number(now());
    const expiresAt = new Date(startedAt + authorizeTtlMs).toISOString();
    let settled = false;
    let timer;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      server.close();
      resolveCompletion(result);
    };

    const server = createServer((req, res) => {
      let callback;
      try { callback = new URL(req.url || "/", `http://${LOOPBACK_HOST}`); } catch { callback = null; }
      if (req.method !== "GET" || callback?.pathname !== "/hub/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("Not Found");
        return;
      }
      if (settled) {
        res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("Setup callback already received");
        return;
      }
      if (callback.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end("<!doctype html><title>Invalid setup callback</title><p>The setup state did not match. Return to Meetmate and try again.</p>");
        return;
      }
      const setupCode = callback.searchParams.get("setup_code");
      const providerError = callback.searchParams.get("error");
      if ((!setupCode && !providerError) || (setupCode && providerError)) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end("<!doctype html><title>Invalid setup callback</title><p>The setup callback was incomplete. Return to Meetmate and try again.</p>");
        return;
      }
      const mappedError = providerError
        ? (CALLBACK_ERRORS.has(providerError) ? providerError : "server_error")
        : null;
      const result = mappedError
        ? { ok: false, error: mappedError, code: "SETTINGS_CLOUD_CONNECT_FAILED" }
        : { ok: true, setupCode, codeVerifier };
      const html = mappedError
        ? `<!doctype html><title>Meetmate connection failed</title><p>Cloud setup failed: ${mappedError}.</p><p>Return to Meetmate and retry the connection.</p>`
        : "<!doctype html><title>Meetmate connected</title><p>You can close this window.</p>";
      res.writeHead(mappedError ? 400 : 200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      try {
        res.end(html);
      } finally {
        // Completion and listener cleanup must not depend on the browser receiving
        // the response; it may close the tab while the response is being written.
        finish(result);
      }
    });

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => {
        server.removeListener("error", reject);
        const port = server.address().port;
        const redirectUri = `http://${LOOPBACK_HOST}:${port}/hub/callback`;
        const authorize = new URL(cloudEndpoint(baseUrl, "v1/auth/google/start"));
        authorize.searchParams.set("redirect_uri", redirectUri);
        authorize.searchParams.set("code_challenge", codeChallenge);
        authorize.searchParams.set("code_challenge_method", "S256");
        authorize.searchParams.set("state", state);
        const authorizeUrl = authorize.toString();
        timer = setTimer(() => finish({ ok: false, error: "timeout", code: "SETTINGS_CLOUD_CONNECT_TIMEOUT" }), authorizeTtlMs);
        timer.unref?.();
        try { Promise.resolve(openUrl(authorizeUrl)).catch(() => {}); } catch { /* manual URL remains available */ }
        resolve({
          authorizeUrl,
          port,
          expiresAt,
          completion,
          cancel() { finish({ ok: false, error: "cancelled", code: "SETTINGS_CLOUD_CONNECT_CANCELLED" }); },
        });
      });
    });
  }

  async function completeConnect({ cloudUrl, setupCode, codeVerifier }) {
    const baseUrl = normalizeCloudUrl(cloudUrl);
    let response;
    try {
      response = await fetchFn(cloudEndpoint(baseUrl, "v1/hub/installations"), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ setup_code: setupCode, code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return { ok: false, status: 0, type: null };
    }
    if (response.status !== 200) return { ok: false, status: response.status, type: await problemFrom(response) };
    let body;
    try { body = await response.json(); } catch { return { ok: false, status: 502, type: null }; }
    const hubToken = body?.hub_token;
    const fields = ["installation_id", "hub_token", "hub_url", "plan_id", "room_salt", "room_salt_version", "expires_at"];
    if (fields.some((field) => typeof body?.[field] !== "string" || !body[field])
        || body.installation_id.length > 256
        || !hubToken.startsWith("cati_hub_") || hubToken.length > 4096
        || !validHubUrl(body.hub_url)
        || body.plan_id.length > 128
        || body.room_salt.length > 4096
        || body.room_salt_version.length > 128
        || Number.isNaN(Date.parse(body.expires_at))) {
      return { ok: false, status: 502, type: null };
    }
    logger?.info?.({ event: "cloud_installation_connected", token_id: tokenId(hubToken) });
    return Object.fromEntries(fields.map((field) => [field, body[field]]));
  }

  async function refreshConfig({ cloudUrl, hubToken }) {
    const baseUrl = normalizeCloudUrl(cloudUrl);
    let response;
    try {
      response = await fetchFn(cloudEndpoint(baseUrl, "v1/hub/config"), {
        headers: { Accept: "application/json", Authorization: `Bearer ${hubToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return { ok: false, status: 0, type: null };
    }
    if (response.status !== 200) return { ok: false, status: response.status, type: await problemFrom(response) };
    let body;
    try { body = await response.json(); } catch { return { ok: false, status: 502, type: null }; }
    if (typeof body?.hub_url !== "string" || !validHubUrl(body.hub_url)
        || typeof body?.room_salt !== "string" || !body.room_salt
        || body.room_salt.length > 4096
        || typeof body?.room_salt_version !== "string" || !body.room_salt_version
        || body.room_salt_version.length > 128
        || (body?.refresh_after_s !== undefined
          && (!Number.isFinite(body.refresh_after_s) || body.refresh_after_s <= 0))) {
      return { ok: false, status: 502, type: null };
    }
    return {
      hub_url: body.hub_url,
      room_salt: body.room_salt,
      room_salt_version: body.room_salt_version,
      refresh_after_s: body.refresh_after_s ?? DEFAULT_CONFIG_REFRESH_AFTER_S,
    };
  }

  async function disconnect({ cloudUrl, hubToken, installationId }) {
    const baseUrl = normalizeCloudUrl(cloudUrl);
    let response;
    try {
      response = await fetchFn(cloudEndpoint(baseUrl, `v1/hub/installations/${encodeURIComponent(installationId)}`), {
        method: "DELETE",
        headers: { Accept: "application/json", Authorization: `Bearer ${hubToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return { ok: false, status: 0 };
    }
    if (response.status === 204 || response.status === 404) return { ok: true };
    return { ok: false, status: response.status, type: await problemFrom(response) };
  }

  return { beginConnect, completeConnect, disconnect, refreshConfig };
}

async function refreshHubConfigIfStale(options = {}) {
  const now = options.now || Date.now;
  const nowMs = Number(now());
  const refreshedAtMs = Date.parse(options.configRefreshedAt || "");
  const refreshAfterSeconds = Number.isFinite(options.refreshAfterSeconds) && options.refreshAfterSeconds > 0
    ? options.refreshAfterSeconds
    : DEFAULT_CONFIG_REFRESH_AFTER_S;
  const stale = !Number.isFinite(refreshedAtMs)
    || nowMs - refreshedAtMs >= refreshAfterSeconds * 1000;
  if (!options.cloudUrl || !options.hubToken || !stale) {
    return { ok: true, refreshed: false, stale };
  }

  const refresh = options.refreshFn || createCloudSetup({
    fetchFn: options.fetchFn,
    now,
    requestTimeoutMs: options.requestTimeoutMs,
  }).refreshConfig;
  let result;
  try {
    result = await refresh({ cloudUrl: options.cloudUrl, hubToken: options.hubToken });
  } catch {
    result = { ok: false, status: 0, type: null };
  }
  if (result.ok === false) {
    return {
      ok: false,
      refreshed: false,
      stale: true,
      lastError: result.type || `HTTP_${result.status || 0}`,
    };
  }
  return {
    ok: true,
    refreshed: true,
    stale: true,
    config: result,
    configRefreshedAt: new Date(nowMs).toISOString(),
    refreshAfterSeconds: result.refresh_after_s ?? DEFAULT_CONFIG_REFRESH_AFTER_S,
  };
}

module.exports = {
  AUTHORIZE_TTL_MS,
  DEFAULT_CONFIG_REFRESH_AFTER_S,
  REQUEST_TIMEOUT_MS,
  createCloudSetup,
  refreshHubConfigIfStale,
  _test: { cloudEndpoint, normalizeCloudUrl, toBase64Url, tokenId },
};
