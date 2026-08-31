"use strict";

const AUTH_VALIDATE_ALL = "validate-all";
const LEGACY_MEET_PATHS = new Set([
  "/",
  "/join-meeting",
  "/active-session",
  "/leave-meeting",
  "/agents",
  "/info",
]);

const entries = [];

function isCapabilitiesObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePrefixes(prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new Error("adapter prefixes are required");
  }
  return prefixes.map((prefix) => {
    if (typeof prefix !== "string" || prefix.length === 0) {
      throw new Error("adapter prefixes must be non-empty strings");
    }
    return prefix;
  });
}

function register(entry) {
  if (!isCapabilitiesObject(entry?.capabilities)) {
    throw new Error("adapter registration requires capabilities");
  }
  const prefixes = normalizePrefixes(entry.prefixes);
  const registered = {
    ...entry,
    prefixes,
  };
  entries.push(registered);
  return registered;
}

function match(pathname) {
  for (const entry of entries) {
    for (const prefix of entry.prefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        return entry;
      }
    }
  }
  return null;
}

function deriveTransportForAuth(pathname) {
  if (
    pathname === "/health"
    || pathname === "/settings"
    || pathname.startsWith("/settings/")
    || pathname === "/api/settings"
    || pathname.startsWith("/api/settings/")
    || pathname === "/settings-assets"
    || pathname.startsWith("/settings-assets/")
    || pathname === "/calibrate"
    || pathname.startsWith("/calibrate/")
  ) {
    return null;
  }

  const adapter = match(pathname);
  if (adapter?.transport) return adapter.transport;

  if (LEGACY_MEET_PATHS.has(pathname) || pathname.startsWith("/readiness")) {
    return "meet";
  }

  return AUTH_VALIDATE_ALL;
}

module.exports = {
  AUTH_VALIDATE_ALL,
  deriveTransportForAuth,
  match,
  register,
  _test: {
    reset() {
      entries.length = 0;
    },
    list() {
      return entries.slice();
    },
  },
};
