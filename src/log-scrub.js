"use strict";

const REDACTED = "[REDACTED]";
const PRIVATE_KEY_MARKER = "(?:[A-Z0-9]+ )*PRIVATE KEY-----";
const PEM_PRIVATE_KEY_RE = new RegExp(
  ["-----BEGIN", PRIVATE_KEY_MARKER].join(" ")
    + "[\\s\\S]*?"
    + ["-----END", PRIVATE_KEY_MARKER].join(" "),
  "gi"
);

function scrubDigestParameters(text) {
  return text.replace(/\bdigest\s+[^\r\n]*/gi, (header) => header.replace(
    /(\b(?:response|nonce|cnonce)\s*=\s*["']?)(?!\[REDACTED\])[^"',\s]+/gi,
    `$1${REDACTED}`
  ));
}

function scrubLogMessage(message, secret) {
  let text = String(message ?? "");
  // Discord accepts any non-empty string as a token, so even short configured values must be scrubbed.
  if (typeof secret === "string" && secret.length > 0) text = text.split(secret).join(REDACTED);

  text = text.replace(PEM_PRIVATE_KEY_RE, REDACTED);
  text = scrubDigestParameters(text);

  return text
    .replace(/(\b(?:https:\/\/)?(?:discord(?:app)?\.com|(?:ptb|canary)\.discord\.com)\/api\/webhooks\/\d+\/)[A-Za-z0-9._-]+/gi, `$1${REDACTED}`)
    .replace(/(\b(?:set-cookie|cookie)\s*:\s*)(?!\[REDACTED\])[^\r\n]*/gi, `$1${REDACTED}`)
    // JSON and single-quoted credential pairs, including scheme-prefixed authorization values.
    .replace(/(["'](?:[a-z_-]*(?:token|secret|password|authorization|credential|private_key)|api(?:\s+|[_-]?)key|private-?key|pass(?:wd)?|session[_-]?id|sid)["']\s*:\s*["'])(?!\[REDACTED\])[^"']*/gi, `$1${REDACTED}`)
    // Authorization headers retain a useful scheme label. Digest parameters were handled above.
    .replace(/(\b[a-z_-]*authorization\b\s*[:=]\s*(?:bot|bearer|basic)\s+["']?)(?!\[REDACTED\])[^\s,})"']+/gi, `$1${REDACTED}`)
    .replace(/(\b[a-z_-]*authorization\b\s*[:=]\s*)(?!(?:digest|bot|bearer|basic)\b)(["']?)(?!\[REDACTED\])[^\s,})"']+/gi, `$1$2${REDACTED}`)
    // Legacy compound labels keep their broad prefix matching; only new short labels are bounded.
    .replace(/(\b(?:[a-z_-]*(?:token|secret|password|credential|private_key)|api(?:\s+|[_-]?)key|private-?key|pass(?:wd)?|session[_-]?id|sid)\b\s*[:=]\s*(?:(?:bot|bearer|basic)\s+)?["']?)(?!\[REDACTED\])[^\s,})"']+/gi, `$1${REDACTED}`)
    .replace(/\b((?:bot|bearer|basic)\s+)(?!\[REDACTED\])[^\s,})"']+/gi, `$1${REDACTED}`);
}

const scrubDiscordLogMessage = scrubLogMessage;

module.exports = { scrubLogMessage, scrubDiscordLogMessage };
