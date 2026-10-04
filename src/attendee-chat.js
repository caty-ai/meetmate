const { attendeeRequest, scrubForTarget } = require("./attendee-endpoint");
const { stripEmojis } = require("./speech-policy");

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

// `target` is the session's join-time Attendee target (src/attendee-endpoint.js).
async function sendAttendeeChatMessage(botId, message, target) {
  try {
    const prepared = prepareAttendeeChatMessage(message);
    if (prepared.skip) {
      console.warn(`💬  Attendee chat skipped (empty after emoji strip): ${botId} original=${JSON.stringify(String(message || "").slice(0, 100))}`);
      return false;
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
    const result = await attendeeRequest(target, {
      method: "POST",
      path: `/api/v1/bots/${botId}/send_chat_message`,
      body,
      timeoutMs: 10_000,
      timeoutMessage: "Attendee chat request timeout",
    });
    if (!result.ok) {
      console.error(`💬  Attendee chat error: ${scrubForTarget(target, result.error.message, { generic: true })}`);
      return false;
    }
    const { redactLogValue } = require("./transport-meet/local-avatar-session");
    const redactedData = redactLogValue(scrubForTarget(target, result.text, { generic: true })).slice(0, 200);
    if (result.statusCode >= 400) {
      console.warn(`💬  Attendee chat message lost: ${botId} → ${result.statusCode} ${redactedData}`);
      return false;
    }
    console.log(`💬  Attendee chat enqueue request: ${botId} → ${result.statusCode} ${redactedData} (HTTP 200 means enqueued, not delivered)`);
    return true;
  } catch (err) {
    console.error(`💬  Attendee chat error: ${scrubForTarget(target, err && err.message ? err.message : err, { generic: true })}`);
    return false;
  }
}

module.exports = { sendAttendeeChatMessage, prepareAttendeeChatMessage };
