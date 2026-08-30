"use strict";

const CANONICAL_TRANSPORTS = new Set(["meet", "zoom", "discord"]);

function isCanonicalTransport(transport) {
  return CANONICAL_TRANSPORTS.has(transport);
}

function sessionUserFor(transport, sessionId, agentId = null) {
  if (!isCanonicalTransport(transport)) {
    throw new Error(`Unsupported transport: ${transport}`);
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("sessionId is required");
  }
  const base = `${transport}-${sessionId}`;
  return agentId ? `${base}-${agentId}` : base;
}

module.exports = {
  sessionUserFor,
};
