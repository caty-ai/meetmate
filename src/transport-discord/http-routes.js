"use strict";

const { getDiagnosticValue } = require("../settings/resolver");
const { scrubDiscordLogMessage } = require("./log-scrub");

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const FORWARDED_HEADER_RE = /^(forwarded$|x-forwarded-)/i;

function defaultWritePlainResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function writeJsonResponse(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(bytes);
}

function isLoopbackRemote(req) {
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress || "");
}

function hasForwardedHeaders(req) {
  return Object.keys(req.headers || {}).some((name) => FORWARDED_HEADER_RE.test(name));
}

function isLocalDiscordRequest(req) {
  return isLoopbackRemote(req) && !hasForwardedHeaders(req);
}

// Request parsing and the session command are caught separately: a parse failure is the caller's own
// body (400 DISCORD_BAD_REQUEST with the parser's text), but an exception escaping joinSession /
// leaveSession may carry dependency or vendor text, so it never reaches the client — the response is
// the fixed per-code message and the diagnostic goes to the operator log after credential scrubbing.
async function handleSessionCommand(req, res, options, command, verb) {
  let body;
  try {
    body = await parseJsonRequestBody(req, options.bodyLimitBytes);
  } catch (error) {
    writeJsonResponse(res, 400, { ok: false, code: "DISCORD_BAD_REQUEST", message: error.message });
    return;
  }
  try {
    const result = await command(body);
    writeJsonResponse(res, result.status || 200, result.body || { ok: true }, result.headers);
  } catch (error) {
    const { JOIN_FAILURE_MESSAGES } = require("./discord-session");
    console.error(`Discord ${verb} handler failed: ${scrubDiscordLogMessage(error?.message || String(error))}`);
    writeJsonResponse(res, 500, { ok: false, code: "DISCORD_JOIN_FAILED", message: JOIN_FAILURE_MESSAGES.DISCORD_JOIN_FAILED });
  }
}

function parseJsonRequestBody(req, bodyLimitBytes = getDiagnosticValue("body_limit_bytes")) {
  return new Promise((resolve, reject) => {
    let body = "";
    let received = 0;

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > bodyLimitBytes) {
        reject(new Error(`Request body too large (>${bodyLimitBytes} bytes)`));
        req.destroy?.();
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Discord request body must be a JSON object");
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function createHttpRoutes(options = {}) {
  const writePlainResponse = options.writePlainResponse || defaultWritePlainResponse;
  const joinSession = options.joinSession || (async () => ({
    status: 503,
    body: {
      ok: false,
      code: "DISCORD_SETUP_REQUIRED",
      message: "Discord adapter is not configured",
    },
  }));
  const leaveSession = options.leaveSession || (async () => ({
    status: 404,
    body: {
      ok: false,
      code: "DISCORD_SESSION_NOT_FOUND",
      message: "No active Discord session",
    },
  }));
  const getSessionStatus = options.getSessionStatus || (() => ({
    ok: true,
    transport: "discord",
    configured: false,
    session: null,
  }));

  return async function handleHttp(req, res, url) {
    const parsedUrl = url || new URL(req.url || "/", "http://localhost");
    if (!isLocalDiscordRequest(req)) {
      req.resume?.();
      writePlainResponse(res, 404, "Not Found");
      return true;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/discord/join") {
      await handleSessionCommand(req, res, options, joinSession, "join");
      return true;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/discord/leave") {
      await handleSessionCommand(req, res, options, leaveSession, "leave");
      return true;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/discord/status") {
      try {
        writeJsonResponse(res, 200, getSessionStatus());
      } catch (error) {
        console.error(`Discord status handler failed: ${scrubDiscordLogMessage(error?.message || String(error))}`);
        writeJsonResponse(res, 500, { ok: false, code: "DISCORD_INTERNAL_ERROR" });
      }
      return true;
    }

    if (
      parsedUrl.pathname === "/api/discord"
      || parsedUrl.pathname === "/api/discord/join"
      || parsedUrl.pathname === "/api/discord/leave"
      || parsedUrl.pathname === "/api/discord/status"
    ) {
      writeJsonResponse(res, 405, {
        ok: false,
        code: "METHOD_NOT_ALLOWED",
        message: "Method Not Allowed",
      }, { Allow: parsedUrl.pathname === "/api/discord/status" ? "GET" : "POST" });
      return true;
    }

    writePlainResponse(res, 404, "Not Found");
    return true;
  };
}

module.exports = {
  createHttpRoutes,
  _test: {
    defaultWritePlainResponse,
    hasForwardedHeaders,
    isLocalDiscordRequest,
    writeJsonResponse,
  },
};
