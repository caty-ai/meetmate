"use strict";

// #274: Attendee host kind, "cloud" or "self-hosted".
// #260 replaces this body with the `bot_host` setting; callers do not change. This is the only host-kind source.
//
// Rule today: the `attendee_base_url` value of the requested snapshot, trimmed and
// case-folded, compared with the Attendee cloud host. Equal, empty or absent is
// "cloud"; any other hostname is "self-hosted" (a custom cloud hostname therefore
// counts as self-hosted, an accepted edge).
// snapshot "effective" = the running server's value (joins, settings UI, /info);
// snapshot "published" = the latest saved value, which may still await a restart.

const ATTENDEE_CLOUD_HOST = "app.attendee.dev";
const SNAPSHOTS = new Set(["effective", "published"]);

function attendeeHostKind({ snapshot } = {}) {
  if (!SNAPSHOTS.has(snapshot)) throw new TypeError("attendeeHostKind: snapshot must be \"effective\" or \"published\"");
  // Lazy: the settings resolver requires this module from buildEnvelope.
  const resolver = require("./settings/resolver");
  const raw = snapshot === "published"
    ? resolver.getPublishedValue("attendee_base_url")
    : resolver.getEffectiveValue("attendee_base_url");
  const host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return host === "" || host === ATTENDEE_CLOUD_HOST ? "cloud" : "self-hosted";
}

module.exports = { attendeeHostKind };
