"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canon, deriveRoomCode, TRACKING_PARAMS } = require("../src/room-code");

const CANON_VECTORS = [
  ["https://meet.google.com/abc-defg-hij?authuser=0&hs=122", "gmeet:abc-defg-hij"],
  ["https://meet.google.com/abc-defg-hij/#participant-1", "gmeet:abc-defg-hij"],
  ["https://us02web.zoom.us/j/1234567890?pwd=abc", "zoom:1234567890"],
  ["https://discord.com/channels/a/b", "discord:a/b"],
  ["https://discord.gg/invite", "discord:invite"],
  ["https://Example.com/join?b=2&utm_source=x&a=1", "url:https://example.com/join?a=1&b=2"],
  ["https://example.com/join?z=9&a=2&a=1&gclid=x", "url:https://example.com/join?a=1&a=2&z=9"],
  ["  not a url  ", "raw:not a url"],
  ["https://EXAMPLE.com/path/#frag", "url:https://example.com/path?"],
  ["https://zoom.us/j/1234567890?pwd=abc", "zoom:1234567890"],
  ["https://us02web.zoom.us/my/sho?pwd=abc", "zoom:my/us02web.zoom.us/sho"],
  ["https://Acme.zoom.us/my/Helpdesk", "zoom:my/acme.zoom.us/helpdesk"],
];

test("canon implements all twelve frozen room-code vectors", () => {
  for (const [input, expected] of CANON_VECTORS) assert.equal(canon(input), expected, input);
});

test("canon unifies Zoom joins and scopes personal rooms by lowercase vanity host", () => {
  assert.equal(canon("https://zoom.us/j/123?pwd=x"), "zoom:123");
  assert.equal(canon("https://us02web.zoom.us/j/123"), "zoom:123");
  assert.equal(canon("https://zoom.us/my/Sho?pwd=x"), "zoom:my/zoom.us/sho");

  const acme = canon("https://acme.zoom.us/my/helpdesk");
  const globex = canon("https://globex.zoom.us/my/helpdesk");
  assert.notEqual(acme, globex);
});

test("tracking parameter removal is limited to the frozen twelve names", () => {
  assert.equal(TRACKING_PARAMS.length, 12);
  assert.equal(
    canon("https://example.com/join?utm_source=x&UTM_SOURCE=y&ref=z&reference=kept"),
    "url:https://example.com/join?UTM_SOURCE=y&reference=kept",
  );
});

test("deriveRoomCode is deterministic, versioned, salted, and 128-bit base32", () => {
  const url = "https://meet.google.com/abc-defg-hij";
  const first = deriveRoomCode(url, { roomSalt: "s1", roomSaltVersion: "r1" });
  assert.match(first, /^r1-[A-Z2-7]{26}$/u);
  assert.equal(deriveRoomCode(url, { roomSalt: "s1", roomSaltVersion: "r1" }), first);
  assert.notEqual(deriveRoomCode(url, { roomSalt: "s2", roomSaltVersion: "r1" }), first);
  assert.equal(
    deriveRoomCode(url, { roomSalt: "s1", roomSaltVersion: "r2" }),
    first.replace(/^r1-/u, "r2-"),
  );
});

test("deriveRoomCode rejects missing salt material", () => {
  assert.throws(() => deriveRoomCode("https://example.com", { roomSaltVersion: "r1" }), /roomSalt/u);
  assert.throws(() => deriveRoomCode("https://example.com", { roomSalt: "s1" }), /roomSaltVersion/u);
});
