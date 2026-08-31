"use strict";

let currentLease = null;

function validateString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}

function tryAcquire(transport, sessionId) {
  validateString(transport, "transport");
  validateString(sessionId, "sessionId");

  if (!currentLease) {
    currentLease = Object.freeze({
      transport,
      sessionId,
    });
    return currentLease;
  }

  if (currentLease.transport === transport && currentLease.sessionId === sessionId) {
    return currentLease;
  }

  return null;
}

function release(lease) {
  if (lease && lease === currentLease) {
    currentLease = null;
  }
}

function active() {
  if (!currentLease) return null;
  return {
    transport: currentLease.transport,
    sessionId: currentLease.sessionId,
  };
}

module.exports = {
  tryAcquire,
  release,
  active,
  _test: {
    reset() {
      currentLease = null;
    },
  },
};
