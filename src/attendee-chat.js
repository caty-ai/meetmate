const https = require("node:https");

const { scrubLogMessage } = require("./log-scrub");
const { stripEmojis } = require("./speech-policy");
const { getEffectiveValue } = require("./settings/resolver");

const ATTENDEE_API_BASE_URL = getEffectiveValue("attendee_base_url");

// Attendee rejects messages containing emojis with a 400 and the whole message
// is lost (issue #81). Strip them before sending so the text part still lands.
// Callers that already stripped (delegation-result path in pipeline.js) pass
// through unchanged, so no double-strip log noise.
function prepareAttendeeChatMessage(message) {
  const original = String(message || "");
  const cleaned = stripEmojis(original);
  const stripped = cleaned !== original;
  return { message: cleaned, stripped, skip: cleaned.trim() === "" };
}

function sendAttendeeChatMessage(botId, message, attendeeKey) {
  return new Promise((resolve) => {
    let apiKey = "";
    try {
      apiKey = attendeeKey || getEffectiveValue("attendee_api_key") || "";
      const prepared = prepareAttendeeChatMessage(message);
      if (prepared.skip) {
        console.warn(`💬  Attendee chat skipped (empty after emoji strip): ${botId} original=${JSON.stringify(String(message || "").slice(0, 100))}`);
        resolve(false);
        return;
      }
      if (prepared.stripped) {
        console.warn(`💬  🧹 chat emojis stripped before send: ${botId} ${String(message || "").length} → ${prepared.message.length} chars`);
      }
      let chatMessage = prepared.message;
      if (chatMessage.length > 10_000) {
        const truncated = Array.from(chatMessage).slice(0, 10_000).join("");
        console.warn(`💬  Attendee chat message truncated: ${chatMessage.length} → ${truncated.length} chars`);
        chatMessage = truncated;
      }

      const body = JSON.stringify({ to: "everyone", message: chatMessage });
      const options = {
        hostname: ATTENDEE_API_BASE_URL,
        port: 443,
        path: `/api/v1/bots/${botId}/send_chat_message`,
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          const { redactLogValue } = require("./transport-meet/local-avatar-session");
          const redactedData = redactLogValue(data).slice(0, 200);
          if (res.statusCode >= 400) {
            console.warn(`💬  Attendee chat message lost: ${botId} → ${res.statusCode} ${redactedData}`);
            resolve(false);
          } else {
            console.log(`💬  Attendee chat enqueue request: ${botId} → ${res.statusCode} ${redactedData} (HTTP 200 means enqueued, not delivered)`);
            resolve(true);
          }
        });
      });
      req.on("error", (err) => {
        console.error(`💬  Attendee chat error: ${scrubErrorMessage(err, apiKey)}`);
        resolve(false);
      });
      req.setTimeout(10_000, () => req.destroy(new Error("Attendee chat request timeout")));
      req.write(body);
      req.end();
    } catch (err) {
      console.error(`💬  Attendee chat error: ${scrubErrorMessage(err, apiKey)}`);
      resolve(false);
    }
  });
}

function scrubErrorMessage(err, secret) {
  return scrubLogMessage(err && err.message ? err.message : err, secret);
}

module.exports = { sendAttendeeChatMessage, prepareAttendeeChatMessage };
