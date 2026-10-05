"use strict";

// #283 stage 2: whether the face of a self-hosted face-package session arrived. A pure function
// of recorded facts; no I/O, no timers. Rules are first-match-wins (design v3.1 §2.3).

const FACE_PAGE_GRACE_MS = 30_000;
const FACE_PAGE_LOST_MS = 20_000;
// Provisional: frozen after live check L0 measures page-seen → connect on self-hosted.
const FACE_READY_GRACE_MS = 120_000;

function deriveFaceStatus(now, facts = {}) {
  const {
    packageLoaded, botFirstConnectedAt = null, botConnectedNow = false, pageFirstSeenAt = null,
    firstConnectedAt = null, connectedAt = null, lastPollAt = null, closedReason = null,
  } = facts;
  if (packageLoaded === false) return { state: "unavailable", reason: "package_load_failed" };
  if (botFirstConnectedAt === null) return { state: "pending", reason: null };
  if (pageFirstSeenAt !== null && closedReason === "expired" && firstConnectedAt === null) {
    return { state: "missing", reason: "page_expired" };
  }
  if (connectedAt !== null && botConnectedNow === true && now - (lastPollAt ?? connectedAt) > FACE_PAGE_LOST_MS) {
    return { state: "lost", reason: "page_stopped" };
  }
  if (connectedAt !== null) return { state: "connected", reason: null };
  if (pageFirstSeenAt !== null && now - pageFirstSeenAt > FACE_READY_GRACE_MS) return { state: "stalled", reason: "not_ready" };
  if (pageFirstSeenAt !== null) return { state: "loading", reason: null };
  if (now - botFirstConnectedAt > FACE_PAGE_GRACE_MS) return { state: "missing", reason: "page_not_requested" };
  return { state: "pending", reason: null };
}

module.exports = { FACE_PAGE_GRACE_MS, FACE_PAGE_LOST_MS, FACE_READY_GRACE_MS, deriveFaceStatus };
