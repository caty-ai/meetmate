const https = require("node:https");

const ATTENDEE_API_BASE_URL = process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev";

function sendAttendeeChatMessage(botId, message, attendeeKey) {
  return new Promise((resolve) => {
    try {
      const apiKey = attendeeKey || process.env.ATTENDEE_API_KEY || "";
      let chatMessage = String(message || "");
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
          if (res.statusCode >= 400) {
            console.warn(`💬  Attendee chat message lost: ${botId} → ${res.statusCode} ${data.slice(0, 200)}`);
            resolve(false);
          } else {
            console.log(`💬  Attendee chat enqueue request: ${botId} → ${res.statusCode} ${data.slice(0, 200)} (HTTP 200 means enqueued, not delivered)`);
            resolve(true);
          }
        });
      });
      req.on("error", (err) => {
        console.error(`💬  Attendee chat error: ${err.message}`);
        resolve(false);
      });
      req.setTimeout(10_000, () => req.destroy(new Error("Attendee chat request timeout")));
      req.write(body);
      req.end();
    } catch (err) {
      console.error(`💬  Attendee chat error: ${err.message || err}`);
      resolve(false);
    }
  });
}

module.exports = { sendAttendeeChatMessage };
