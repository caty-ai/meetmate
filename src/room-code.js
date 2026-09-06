"use strict";

const { createHmac } = require("node:crypto");

const TRACKING_PARAMS = Object.freeze([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_eid",
  "_hsenc",
  "ref",
  "si",
]);
const TRACKING_PARAM_SET = new Set(TRACKING_PARAMS);
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function canon(value) {
  const raw = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return `raw:${raw}`;
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  const segments = pathname.split("/").filter(Boolean);

  if (hostname === "meet.google.com" && segments.length >= 1) {
    return `gmeet:${segments[0]}`;
  }
  const isZoomHost = hostname === "zoom.us" || hostname.endsWith(".zoom.us");
  if (isZoomHost && segments[0] === "j" && segments[1]) {
    return `zoom:${segments[1]}`;
  }
  if (isZoomHost && segments[0] === "my" && segments[1]) {
    return `zoom:my/${hostname}/${segments[1].toLowerCase()}`;
  }
  if (hostname === "discord.com" && segments[0] === "channels" && segments[1] && segments[2]) {
    return `discord:${segments[1]}/${segments[2]}`;
  }
  if (hostname === "discord.gg" && segments[0]) {
    return `discord:${segments[0]}`;
  }

  const query = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM_SET.has(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    });

  return `url:${parsed.origin.toLowerCase()}${pathname}?${new URLSearchParams(query).toString()}`;
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return encoded;
}

function deriveRoomCode(url, options = {}) {
  const roomSalt = String(options.roomSalt || "");
  const roomSaltVersion = String(options.roomSaltVersion || "");
  if (!roomSalt || !roomSaltVersion) {
    throw new Error("roomSalt and roomSaltVersion are required to derive a room code");
  }
  const digest = createHmac("sha256", roomSalt).update(canon(url)).digest().subarray(0, 16);
  return `${roomSaltVersion}-${base32(digest)}`;
}

module.exports = { TRACKING_PARAMS, canon, deriveRoomCode };
