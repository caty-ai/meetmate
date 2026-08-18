const crypto = require("crypto");

const HTML_ROUTE = "/local-avatar/index.html";
const SCRIPT_ROUTE = "/local-avatar/local-avatar.js";
const STATE_ROUTE = "/local-avatar/state";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const DEFAULT_QUEUE_LIMIT = 8;
const MAX_QUEUE_LIMIT = 64;
const DEFAULT_RETRY_LIMIT = 3;
const MAX_RETRY_LIMIT = 8;

const sessions = new Map();

function createLocalAvatarSession(options = {}) {
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const visualId = toBase64Url(randomBytes(16));
  const capability = toBase64Url(randomBytes(32));
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const session = new LocalAvatarSession({
    visualId,
    capability,
    publicOrigin,
    now: options.now,
    ttlMs: options.ttlMs,
    queueLimit: options.queueLimit,
    retryLimit: options.retryLimit,
    logger: options.logger,
  });

  if (sessions.has(visualId)) throw new Error("local avatar visual id collision");
  sessions.set(visualId, session);

  return {
    session,
    capability,
    launchUrl: `${publicOrigin}${HTML_ROUTE}?v=${encodeURIComponent(visualId)}#cap=${encodeURIComponent(capability)}`,
  };
}

class LocalAvatarSession {
  constructor({ visualId, capability, publicOrigin, now, ttlMs, queueLimit, retryLimit, logger }) {
    this.visualId = visualId;
    this.publicOrigin = publicOrigin;
    this._now = typeof now === "function" ? now : Date.now;
    this._logger = logger || null;
    this._capabilityHash = hashCapability(capability);
    this._expiresAt = this._now() + clampInteger(ttlMs, DEFAULT_TTL_MS, 1, MAX_TTL_MS);
    this._queueLimit = clampInteger(queueLimit, DEFAULT_QUEUE_LIMIT, 1, MAX_QUEUE_LIMIT);
    this._retryLimit = clampInteger(retryLimit, DEFAULT_RETRY_LIMIT, 0, MAX_RETRY_LIMIT);
    this._queue = [];
    this._lastDelivery = null;
    this._closed = false;
    this._generation = 0;
    this._sourceGeneration = 0;
    this._sequence = 0;
    this._cancelEpoch = 0;
    this._outputEpoch = -1;
    this._lastSampleIndex = -1;
    this._lastCancelledOutputEpoch = -1;
    this._dropped = 0;
  }

  verifyCapability(candidate) {
    const candidateHash = hashCapability(typeof candidate === "string" ? candidate : "");
    const equal = crypto.timingSafeEqual(this._capabilityHash, candidateHash);
    if (!equal || this._closed || this._now() >= this._expiresAt) {
      if (!this._closed && this._now() >= this._expiresAt) this.close("expired");
      return false;
    }
    return true;
  }

  connect({ capability, origin }) {
    if (origin !== this.publicOrigin || !this.verifyCapability(capability)) return null;

    this._generation += 1;
    this._queue.length = 0;
    this._lastDelivery = null;
    this._lastSampleIndex = -1;
    const state = this._state("idle", {
      outputEpoch: this._outputEpoch,
      sampleIndex: null,
      sampleRate: null,
    });
    return state;
  }

  publishMarker(metadata, sourceGeneration = this._sourceGeneration) {
    if (this._closed || this._generation === 0 || this._now() >= this._expiresAt) return false;
    if (sourceGeneration !== this._sourceGeneration) return false;

    const outputEpoch = toNonNegativeInteger(metadata?.outputEpoch);
    const sampleIndex = toNonNegativeInteger(metadata?.firstSampleIndex);
    const sampleRate = toPositiveInteger(metadata?.sampleRate);
    if (outputEpoch === null || sampleIndex === null || sampleRate === null) return false;
    if (outputEpoch <= this._lastCancelledOutputEpoch || outputEpoch < this._outputEpoch) return false;

    if (outputEpoch > this._outputEpoch) {
      this._outputEpoch = outputEpoch;
      this._lastSampleIndex = -1;
      this._queue.length = 0;
      this._lastDelivery = null;
    }
    if (sampleIndex <= this._lastSampleIndex) return false;

    this._lastSampleIndex = sampleIndex;
    return this._enqueue(this._state("marker", { outputEpoch, sampleIndex, sampleRate }));
  }

  cancelPlayback(event, sourceGeneration = this._sourceGeneration) {
    if (this._closed || this._generation === 0 || this._now() >= this._expiresAt) return false;
    if (sourceGeneration !== this._sourceGeneration) return false;
    const outputEpoch = toNonNegativeInteger(event?.outputEpoch);
    if (outputEpoch === null || outputEpoch <= this._lastCancelledOutputEpoch || outputEpoch < this._outputEpoch) {
      return false;
    }

    this._lastCancelledOutputEpoch = outputEpoch;
    this._outputEpoch = Math.max(this._outputEpoch, outputEpoch);
    this._lastSampleIndex = -1;
    this._cancelEpoch += 1;
    this._queue.length = 0;
    this._lastDelivery = null;
    return this._enqueue(this._state("cancel", {
      outputEpoch,
      sampleIndex: null,
      sampleRate: null,
    }));
  }

  beginSource() {
    if (this._closed || this._now() >= this._expiresAt) return null;
    this._sourceGeneration += 1;
    this._outputEpoch = -1;
    this._lastSampleIndex = -1;
    this._lastCancelledOutputEpoch = -1;
    this._cancelEpoch += 1;
    this._queue.length = 0;
    this._lastDelivery = null;
    if (this._generation > 0) {
      this._enqueue(this._state("idle", {
        outputEpoch: this._outputEpoch,
        sampleIndex: null,
        sampleRate: null,
      }));
    }
    return this._sourceGeneration;
  }

  readState({ capability, origin, generation, afterSequence }) {
    if (origin !== this.publicOrigin || !this.verifyCapability(capability)) return null;
    if (toPositiveInteger(generation) !== this._generation) return null;

    const after = toInteger(afterSequence);
    if (after === null) return null;
    if (this._lastDelivery && after >= this._lastDelivery.state.sequence) this._lastDelivery = null;

    if (this._queue.length > 0) {
      const state = this._queue.at(-1);
      this._queue.length = 0;
      this._lastDelivery = { state, attempts: 1 };
      return state.sequence > after ? state : undefined;
    }

    if (
      this._lastDelivery
      && this._lastDelivery.state.sequence > after
      && this._lastDelivery.attempts <= this._retryLimit
    ) {
      this._lastDelivery.attempts += 1;
      return this._lastDelivery.state;
    }

    this._lastDelivery = null;
    return undefined;
  }

  close(reason = "session_end") {
    if (this._closed) return false;
    this._closed = true;
    this._queue.length = 0;
    this._lastDelivery = null;
    this._capabilityHash.fill(0);
    sessions.delete(this.visualId);
    this._safeLog("local avatar session closed", { visualId: this.visualId, reason });
    return true;
  }

  snapshot() {
    return {
      visualId: this.visualId,
      closed: this._closed,
      expiresAt: this._expiresAt,
      generation: this._generation,
      sourceGeneration: this._sourceGeneration,
      sequence: this._sequence,
      cancelEpoch: this._cancelEpoch,
      outputEpoch: this._outputEpoch,
      lastSampleIndex: this._lastSampleIndex,
      queueSize: this._queue.length,
      queueLimit: this._queueLimit,
      retryLimit: this._retryLimit,
      dropped: this._dropped,
    };
  }

  _state(kind, values) {
    this._sequence += 1;
    return {
      kind,
      generation: this._generation,
      cancelEpoch: this._cancelEpoch,
      sequence: this._sequence,
      outputEpoch: values.outputEpoch,
      sampleIndex: values.sampleIndex,
      sampleRate: values.sampleRate,
    };
  }

  _enqueue(state) {
    if (this._queue.length >= this._queueLimit) {
      this._dropped += 1;
      return false;
    }
    this._queue.push(state);
    return true;
  }

  _safeLog(message, fields) {
    try {
      this._logger?.info?.(redactLogValue(message), redactLogValue(fields));
    } catch {
      // Visual diagnostics must not affect the meeting lifecycle.
    }
  }
}

function getLocalAvatarSession(visualId) {
  return sessions.get(String(visualId || "")) || null;
}

function hasLocalAvatarSessions() {
  return sessions.size > 0;
}

function redactLogValue(value) {
  if (typeof value === "string") {
    return value
      .replace(/(#cap=)[^\s&#]+/gi, "$1[REDACTED]")
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1[REDACTED]")
      .replace(/((?:capability|token)\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = /capability|authorization|token/i.test(key) ? "[REDACTED]" : redactLogValue(item);
    }
    return redacted;
  }
  return value;
}

function hashCapability(capability) {
  return crypto.createHash("sha256").update(String(capability), "utf8").digest();
}

function normalizePublicOrigin(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("local avatar requires a public HTTPS origin");
  }
  return parsed.origin;
}

function toBase64Url(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("randomBytes must return a Buffer");
  return value.toString("base64url");
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toNonNegativeInteger(value) {
  const parsed = toInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function toPositiveInteger(value) {
  const parsed = toInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

module.exports = {
  HTML_ROUTE,
  SCRIPT_ROUTE,
  STATE_ROUTE,
  createLocalAvatarSession,
  getLocalAvatarSession,
  hasLocalAvatarSessions,
  redactLogValue,
  _test: {
    DEFAULT_QUEUE_LIMIT,
    DEFAULT_RETRY_LIMIT,
    MAX_TTL_MS,
    sessions,
  },
};
