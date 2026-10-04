"use strict";

// #274: Attendee host kind, "cloud" or "self-hosted".
// #260: a stored `bot_host` decides; with none stored, the pre-#260 URL rule holds. This is the only host-kind source.
//
// Rule 1: `bot_host` stored in the requested snapshot (its source is not "default" or
// "unset"): "attendee-self-hosted" is "self-hosted", "attendee-cloud" is "cloud";
// `attendee_base_url` is not looked at.
// Rule 2: no `bot_host` stored: the `attendee_base_url` value of the requested snapshot,
// trimmed and case-folded, compared with the Attendee cloud host. Equal, empty or absent
// is "cloud"; any other hostname is "self-hosted" (a custom cloud hostname therefore
// counts as self-hosted, an accepted edge).
// The kind never selects a key or a destination: the slot is `bot_host` alone.
// snapshot "effective" = the running server's value (settings UI, /info);
// snapshot "published" = the latest saved value, which may still await a restart.
// target = a resolved Attendee target, whose kind was recorded from its own snapshot at
// resolution (one decision per join).

const ATTENDEE_CLOUD_HOST = "app.attendee.dev";
const SNAPSHOTS = new Set(["effective", "published"]);
const BOT_HOST_KINDS = Object.freeze({ "attendee-cloud": "cloud", "attendee-self-hosted": "self-hosted" });
const KINDS = new Set(Object.values(BOT_HOST_KINDS));

function attendeeHostKind({ snapshot, target } = {}) {
  if (target !== undefined) {
    if (snapshot !== undefined) throw new TypeError("attendeeHostKind: give either snapshot or target, not both");
    if (!target || typeof target !== "object" || !KINDS.has(target.hostKind)) {
      throw new TypeError("attendeeHostKind: target must be a resolved Attendee target");
    }
    return target.hostKind;
  }
  if (!SNAPSHOTS.has(snapshot)) throw new TypeError("attendeeHostKind: snapshot must be \"effective\" or \"published\"");
  // Lazy: the settings resolver requires this module from buildEnvelope.
  const resolver = require("./settings/resolver");
  const published = snapshot === "published";
  const botHost = published ? resolver.getPublishedValue("bot_host") : resolver.getEffectiveValue("bot_host");
  if (typeof botHost === "string" && Object.hasOwn(BOT_HOST_KINDS, botHost)) {
    const source = published ? resolver.getPublishedSource("bot_host") : resolver.getEffectiveSource("bot_host");
    if (source !== "default" && source !== "unset") return BOT_HOST_KINDS[botHost];
  }
  const raw = published
    ? resolver.getPublishedValue("attendee_base_url")
    : resolver.getEffectiveValue("attendee_base_url");
  const host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return host === "" || host === ATTENDEE_CLOUD_HOST ? "cloud" : "self-hosted";
}

module.exports = { attendeeHostKind };
