"use strict";

// #260: the custody boundary for Attendee credentials. This module is the only reader of
// the Attendee key and the only place a request to Attendee is composed. No exported
// function returns a key: a target carries the endpoint, and its key stays in a
// module-private WeakMap keyed by the frozen target object. A copied, cloned or hand-built
// target has no entry and fails closed; there is no fallback to any global value.
//
// `bot_host` is not registered yet, so every target is the cloud slot (the legacy
// `attendee_base_url` / `attendee_api_key` / `face_timeline_offset_ms` entries) over https:443.

const crypto = require("node:crypto");
const https = require("node:https");

const { scrubLogMessage } = require("./log-scrub");

const REDACTED = "[REDACTED]";
const SNAPSHOTS = new Set(["effective", "published"]);
const CLOUD_HOST_ID = "attendee-cloud";
// Only an ordinary errno-style code is copied onto a returned error (never one carrying the key).
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const credentials = new WeakMap();
// Per-process salt for the targetId fingerprint; never logged or persisted.
const fingerprintSalt = crypto.randomBytes(32);

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function fingerprint(credential) {
  if (!credential) return "none";
  return crypto.createHmac("sha256", fingerprintSalt).update(credential).digest("hex").slice(0, 32);
}

function resolveBotHostTarget({ snapshot } = {}) {
  if (!SNAPSHOTS.has(snapshot)) throw new TypeError("resolveBotHostTarget: snapshot must be \"effective\" or \"published\"");
  // Lazy and looked up per call: tests replace the resolver module in require.cache.
  const resolver = require("./settings/resolver");
  const read = (id) => (snapshot === "published" ? resolver.getPublishedValue(id) : resolver.getEffectiveValue(id));
  const hostname = stringValue(read("attendee_base_url"));
  const credential = stringValue(read("attendee_api_key"));
  const protocol = "https";
  const port = 443;
  const basePath = "";
  const target = Object.freeze({
    hostId: CLOUD_HOST_ID,
    configured: hostname !== "" && credential !== "",
    protocol,
    hostname,
    port,
    basePath,
    offsetMs: read("face_timeline_offset_ms"),
    targetId: `${CLOUD_HOST_ID}|${protocol}://${hostname.toLowerCase()}:${port}${basePath}|${fingerprint(credential)}`,
  });
  if (credential) credentials.set(target, credential);
  return target;
}

function credentialFor(target) {
  // WeakMap.get returns undefined for primitives and for objects without an entry.
  const credential = credentials.get(target);
  return typeof credential === "string" && credential !== "" ? credential : null;
}

function removeCredential(text, credential) {
  return credential ? text.split(credential).join(REDACTED) : text;
}

// The only place a request to Attendee is composed: destination, Authorization and body.
function buildRequest(target, { method, path, body }) {
  const credential = credentialFor(target);
  if (!credential || target.configured !== true) return null;
  const headers = { Authorization: `Token ${credential}` };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  return {
    options: { hostname: target.hostname, port: target.port, path: `${target.basePath}${path}`, method, headers },
    body,
  };
}

function failure(code, message, credential, cause) {
  const error = new Error(removeCredential(String(message), credential));
  const causeCode = cause ? cause.code : undefined;
  if (typeof causeCode === "string" && ERRNO_CODE.test(causeCode) && !(credential && causeCode.includes(credential))) {
    error.code = causeCode;
  }
  return { ok: false, code, error };
}

function errorMessage(err) {
  return err && err.message ? err.message : err;
}

// Resolves (never rejects) to { ok: true, statusCode, text } or { ok: false, code, error }.
// `text` and `error.message` are already scrubbed of the target's key. Redirects are not followed.
function attendeeRequest(target, { method, path, body, timeoutMs, timeoutMessage, signal } = {}) {
  const built = buildRequest(target, { method, path, body });
  if (!built) return Promise.resolve(failure("NOT_CONFIGURED", "Attendee target is not configured", null));
  const credential = credentialFor(target);
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const onAbort = () => {
      settle(failure("ABORTED", errorMessage(signal.reason), credential, signal.reason));
      req?.destroy?.(signal.reason);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    if (signal?.aborted) {
      settle(failure("ABORTED", errorMessage(signal.reason), credential, signal.reason));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      // Looked up on the module object at call time so harnesses can replace it.
      req = https.request(built.options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("error", (err) => settle(failure("NETWORK_ERROR", errorMessage(err), credential, err)));
        res.on("end", () => settle({ ok: true, statusCode: res.statusCode, text: removeCredential(data, credential) }));
      });
      req.on("error", (err) => settle(failure("NETWORK_ERROR", errorMessage(err), credential, err)));
      if (timeoutMs !== undefined) {
        const message = timeoutMessage || `Attendee request timeout (${timeoutMs}ms)`;
        req.setTimeout(timeoutMs, () => {
          // Already settled (aborted, failed or answered): the request was handled; destroy at most once.
          if (settled) return;
          settle(failure("TIMEOUT", message, credential));
          req.destroy?.(new Error(message));
        });
      }
      if (built.body !== undefined) req.write(built.body);
      req.end();
    } catch (err) {
      settle(failure("NETWORK_ERROR", errorMessage(err), credential, err));
    }
  });
}

// generic: true  — log lines: literal key removal, then the generic scrubLogMessage patterns.
// generic: false — client-facing bodies: literal key removal only; text without the key is unchanged.
function scrubForTarget(target, text, { generic } = {}) {
  if (typeof generic !== "boolean") throw new TypeError("scrubForTarget: generic must be a boolean");
  const scrubbed = removeCredential(typeof text === "string" ? text : String(text), credentialFor(target));
  return generic ? scrubLogMessage(scrubbed) : scrubbed;
}

module.exports = { resolveBotHostTarget, attendeeRequest, scrubForTarget };
