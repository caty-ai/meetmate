"use strict";

// #260: the custody boundary for Attendee credentials. This module is the only reader of
// the Attendee keys and the only place a request to Attendee is composed. No exported
// function returns a key: a target carries the endpoint, and its key stays in a
// module-private WeakMap keyed by the frozen target object. A copied, cloned or hand-built
// target has no entry and fails closed; there is no fallback to any global value. Outside
// the injected `fetchFn` dispatch seam of `attendeeRequest` (a test seam that production
// callers never set for Attendee), no exported function passes a key to its caller.
//
// `bot_host` selects the slot. Absent, unregistered or `attendee-cloud` is the cloud slot
// (the legacy `attendee_base_url` / `attendee_api_key` / `face_timeline_offset_ms` entries)
// over https:443; `attendee-self-hosted` is the self-hosted slot (`attendee_self_hosted_url`
// / `attendee_self_hosted_api_key` / `face_timeline_offset_ms_self_hosted`).

const crypto = require("node:crypto");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const { scrubLogMessage } = require("./log-scrub");

const REDACTED = "[REDACTED]";
const SNAPSHOTS = new Set(["effective", "published"]);
const CLOUD_HOST_ID = "attendee-cloud";
const SELF_HOSTED_HOST_ID = "attendee-self-hosted";
const DEFAULT_PORTS = Object.freeze({ https: 443, http: 80 });
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

function unbracket(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function ipv4Octets(address) {
  return net.isIPv4(address) ? address.split(".").map(Number) : null;
}

function privateIpv4(octets) {
  const [a, b] = octets;
  return a === 127
    || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

// Eight 16-bit groups of an IPv6 literal (an embedded dotted IPv4 tail becomes two groups).
function ipv6Groups(address) {
  let text = address;
  const tail = text.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const octets = ipv4Octets(tail[1]);
    if (!octets) return null;
    text = `${text.slice(0, -tail[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill(0), ...rest];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

// Private set P: 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10,
// fc00::/7. IPv4-mapped IPv6 is unwrapped first. Link-local, unspecified, multicast and every
// public address are outside P, as is anything that is not an IP literal.
function isPrivateAddress(value) {
  if (typeof value !== "string" || value.includes("%")) return false;
  const address = unbracket(value);
  const octets = ipv4Octets(address);
  if (octets) return privateIpv4(octets);
  if (!net.isIPv6(address)) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return privateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  return (groups[0] & 0xfe00) === 0xfc00;
}

// A stored self-hosted URL was already validated by the registry; anything unparsable here
// leaves the slot unconfigured.
function selfHostedEndpoint(value) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  const protocol = parsed.protocol.slice(0, -1);
  if (!Object.hasOwn(DEFAULT_PORTS, protocol) || !parsed.hostname) return null;
  return {
    protocol,
    hostname: unbracket(parsed.hostname),
    port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS[protocol],
    basePath: parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""),
  };
}

function resolveBotHostTarget({ snapshot } = {}) {
  if (!SNAPSHOTS.has(snapshot)) throw new TypeError("resolveBotHostTarget: snapshot must be \"effective\" or \"published\"");
  // Lazy and looked up per call: tests replace the resolver module in require.cache.
  const resolver = require("./settings/resolver");
  const read = (id) => (snapshot === "published" ? resolver.getPublishedValue(id) : resolver.getEffectiveValue(id));
  const hostId = read("bot_host") === SELF_HOSTED_HOST_ID ? SELF_HOSTED_HOST_ID : CLOUD_HOST_ID;
  let endpoint;
  let credential;
  let offsetMs;
  if (hostId === SELF_HOSTED_HOST_ID) {
    endpoint = selfHostedEndpoint(stringValue(read("attendee_self_hosted_url")));
    credential = stringValue(read("attendee_self_hosted_api_key"));
    offsetMs = read("face_timeline_offset_ms_self_hosted");
  } else {
    // The legacy hostname schema cannot carry a scheme or a port: always https:443.
    const hostname = stringValue(read("attendee_base_url"));
    endpoint = hostname ? { protocol: "https", hostname, port: 443, basePath: "" } : null;
    credential = stringValue(read("attendee_api_key"));
    offsetMs = read("face_timeline_offset_ms");
  }
  const { protocol, hostname, port, basePath } = endpoint || { protocol: "https", hostname: "", port: 443, basePath: "" };
  // Recorded once, from the same snapshot, by the only host-kind source (lazy: it requires the resolver).
  const hostKind = require("./attendee-host-kind").attendeeHostKind({ snapshot });
  const target = Object.freeze({
    hostId,
    configured: Boolean(endpoint) && credential !== "",
    protocol,
    hostname,
    port,
    basePath,
    offsetMs,
    hostKind,
    targetId: `${hostId}|${protocol}://${hostname.toLowerCase()}:${port}${basePath}|${fingerprint(credential)}`,
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

function urlHost(hostname) {
  return net.isIPv6(hostname) ? `[${hostname}]` : hostname;
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
  const requestPath = `${target.basePath}${path}`;
  const port = target.port === DEFAULT_PORTS[target.protocol] ? "" : `:${target.port}`;
  return {
    options: { hostname: target.hostname, port: target.port, path: requestPath, method, headers },
    url: `${target.protocol}://${urlHost(target.hostname)}${port}${requestPath}`,
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

// The first errno-style code on an error or its cause chain (fetch wraps socket errors).
function errnoCause(err) {
  let current = err;
  for (let depth = 0; current && depth < 6; depth += 1, current = current.cause) {
    if (typeof current.code === "string" && ERRNO_CODE.test(current.code)) return { code: current.code };
  }
  return undefined;
}

function destinationError(message) {
  return Object.assign(new Error(message), { code: "DESTINATION_REJECTED" });
}

// Connect-time guard for an `http:` name: every resolved address must be in P, and the
// socket connects to a verified address. Looked up on the dns module object at call time.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length || !list.every((entry) => isPrivateAddress(entry?.address))) {
      callback(destinationError("Attendee http endpoint does not resolve to a private address"));
      return;
    }
    if (options && options.all) callback(null, list.map(({ address, family }) => ({ address, family })));
    else callback(null, list[0].address, list[0].family);
  });
}

function nativeOptions(target, built) {
  if (target.protocol !== "http") return built.options;
  if (net.isIP(target.hostname)) {
    if (!isPrivateAddress(target.hostname)) throw destinationError("Attendee http endpoint is not a private address");
    return built.options;
  }
  // No pooled socket: every request opens its own connection, so every request is judged.
  return { ...built.options, agent: false, lookup: guardedLookup };
}

async function fetchDispatch(built, { fetchFn, timeoutMs, timeoutMessage, signal }, credential) {
  const controller = new AbortController();
  const message = timeoutMessage || `Attendee request timeout (${timeoutMs}ms)`;
  let timedOut = false;
  let timer = null;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(message));
    }, timeoutMs);
    timer.unref?.();
  }
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const response = await fetchFn(built.url, {
      method: built.options.method,
      headers: built.options.headers,
      body: built.body,
      redirect: "error",
      signal: controller.signal,
    });
    let text = "";
    try { text = String(await response.text()); } catch { /* an unreadable body is an empty one */ }
    return { ok: true, statusCode: response.status, text: removeCredential(text, credential) };
  } catch (err) {
    if (timedOut) return failure("TIMEOUT", message, credential);
    if (signal?.aborted) return failure("ABORTED", errorMessage(signal.reason), credential, signal.reason);
    return failure("NETWORK_ERROR", errorMessage(err), credential, errnoCause(err));
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

// Resolves (never rejects) to { ok: true, statusCode, text } or { ok: false, code, error }.
// `text` and `error.message` are already scrubbed of the target's key. Redirects are not followed.
// `fetchFn` replaces the dispatch only: it receives exactly what the builder built.
function attendeeRequest(target, { method, path, body, timeoutMs, timeoutMessage, signal, fetchFn } = {}) {
  const built = buildRequest(target, { method, path, body });
  if (!built) return Promise.resolve(failure("NOT_CONFIGURED", "Attendee target is not configured", null));
  const credential = credentialFor(target);
  if (typeof fetchFn === "function") return fetchDispatch(built, { fetchFn, timeoutMs, timeoutMessage, signal }, credential);
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
      const options = nativeOptions(target, built);
      // Looked up on the module object at call time so harnesses can replace it.
      const transport = target.protocol === "http" ? http : https;
      req = transport.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("error", (err) => settle(failure("NETWORK_ERROR", errorMessage(err), credential, err)));
        res.on("end", () => settle({ ok: true, statusCode: res.statusCode, text: removeCredential(data, credential) }));
      });
      req.on("error", (err) => settle(err?.code === "DESTINATION_REJECTED"
        ? failure("DESTINATION_REJECTED", errorMessage(err), credential)
        : failure("NETWORK_ERROR", errorMessage(err), credential, err)));
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
      settle(err?.code === "DESTINATION_REJECTED"
        ? failure("DESTINATION_REJECTED", errorMessage(err), credential)
        : failure("NETWORK_ERROR", errorMessage(err), credential, err));
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

module.exports = { resolveBotHostTarget, attendeeRequest, scrubForTarget, isPrivateAddress };
