"use strict";

// #283 stage 2 T1: deriveFaceStatus, one case per rule and the boundaries of the three constants.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FACE_PAGE_GRACE_MS, FACE_PAGE_LOST_MS, FACE_READY_GRACE_MS, deriveFaceStatus,
} = require("../src/transport-meet/face-status");

const BOT = 1_000_000; // botFirstConnectedAt
const PAGE = BOT + 1_300; // pageFirstSeenAt
const CONNECT = PAGE + 40_000; // connectedAt / firstConnectedAt

const base = { packageLoaded: true, botFirstConnectedAt: BOT, botConnectedNow: true };
const seen = { ...base, pageFirstSeenAt: PAGE };
const connected = { ...seen, firstConnectedAt: CONNECT, connectedAt: CONNECT };

test("T1 the constants are the design values", () => {
  assert.equal(FACE_PAGE_GRACE_MS, 30_000);
  assert.equal(FACE_PAGE_LOST_MS, 20_000);
  assert.equal(FACE_READY_GRACE_MS, 120_000);
});

test("T1 one case per rule, first match wins", () => {
  const cases = [
    // rule 1: the package did not load, whatever else is true
    ["1 package_load_failed", BOT + 999_999, { ...connected, packageLoaded: false }, "unavailable", "package_load_failed"],
    ["1 before the bot connects", 0, { packageLoaded: false, botFirstConnectedAt: null }, "unavailable", "package_load_failed"],
    // rule 2: no bot yet, even with an expired page session (rule 2 sits above rule 3)
    ["2 no bot", BOT + 999_999, { packageLoaded: true, botFirstConnectedAt: null }, "pending", null],
    ["2 above 3", BOT + 999_999, { ...seen, botFirstConnectedAt: null, closedReason: "expired" }, "pending", null],
    // rule 3: page seen, expired, never connected
    ["3 page_expired", PAGE + 400_000, { ...seen, closedReason: "expired" }, "missing", "page_expired"],
    ["3 needs the page", BOT + 400_000, { ...base, closedReason: "expired" }, "missing", "page_not_requested"],
    ["3 needs reason expired", PAGE + 400_000, { ...seen, closedReason: "session_end" }, "stalled", "not_ready"],
    ["3 not after a connect", CONNECT + 1_000, { ...connected, closedReason: "expired" }, "connected", null],
    // rule 4: lost, measured from lastPollAt ?? connectedAt, only while the bot is connected
    ["4 no poll since connect", CONNECT + FACE_PAGE_LOST_MS + 1, connected, "lost", "page_stopped"],
    ["4 old poll", CONNECT + 60_000, { ...connected, lastPollAt: CONNECT + 60_000 - FACE_PAGE_LOST_MS - 1 }, "lost", "page_stopped"],
    ["4 bot disconnected", CONNECT + 600_000, { ...connected, botConnectedNow: false }, "connected", null],
    // rule 5: connected
    ["5 fresh poll", CONNECT + 600_000, { ...connected, lastPollAt: CONNECT + 600_000 - 100 }, "connected", null],
    // rule 6: page seen, no connect past the ready grace
    ["6 stalled", PAGE + FACE_READY_GRACE_MS + 1, seen, "stalled", "not_ready"],
    // rule 7: loading
    ["7 loading", PAGE + 1, seen, "loading", null],
    // rule 8: no page past the page grace
    ["8 page_not_requested", BOT + FACE_PAGE_GRACE_MS + 1, base, "missing", "page_not_requested"],
    // rule 9: otherwise
    ["9 pending", BOT + 1, base, "pending", null],
  ];
  for (const [label, now, facts, state, reason] of cases) {
    assert.deepEqual(deriveFaceStatus(now, facts), { state, reason }, label);
  }
});

test("T1 constant boundaries: strictly greater than the window", () => {
  // FACE_PAGE_GRACE_MS (rule 8)
  assert.equal(deriveFaceStatus(BOT + FACE_PAGE_GRACE_MS, base).state, "pending");
  assert.equal(deriveFaceStatus(BOT + FACE_PAGE_GRACE_MS + 1, base).state, "missing");
  // FACE_READY_GRACE_MS (rule 6)
  assert.equal(deriveFaceStatus(PAGE + FACE_READY_GRACE_MS, seen).state, "loading");
  assert.equal(deriveFaceStatus(PAGE + FACE_READY_GRACE_MS + 1, seen).state, "stalled");
  // FACE_PAGE_LOST_MS (rule 4), from connectedAt and from lastPollAt
  assert.equal(deriveFaceStatus(CONNECT + FACE_PAGE_LOST_MS, connected).state, "connected");
  assert.equal(deriveFaceStatus(CONNECT + FACE_PAGE_LOST_MS + 1, connected).state, "lost");
  const polled = { ...connected, lastPollAt: CONNECT + 5_000 };
  assert.equal(deriveFaceStatus(CONNECT + 5_000 + FACE_PAGE_LOST_MS, polled).state, "connected");
  assert.equal(deriveFaceStatus(CONNECT + 5_000 + FACE_PAGE_LOST_MS + 1, polled).state, "lost");
});

test("T1 recovery needs no special code: a reconnect measures loss from the new connect", () => {
  const reconnect = CONNECT + 100_000;
  const facts = { ...connected, connectedAt: reconnect, lastPollAt: null };
  assert.equal(deriveFaceStatus(reconnect + FACE_PAGE_LOST_MS, facts).state, "connected");
  assert.equal(deriveFaceStatus(reconnect + FACE_PAGE_LOST_MS + 1, facts).state, "lost");
});

test("T1 the function is pure: the input is not changed and the result does not depend on call order", () => {
  const facts = Object.freeze({ ...connected, lastPollAt: CONNECT });
  const first = deriveFaceStatus(CONNECT + 30_000, facts);
  deriveFaceStatus(CONNECT, facts);
  assert.deepEqual(deriveFaceStatus(CONNECT + 30_000, facts), first);
});
