// call-manager.js — Twilio outbound call management (no twilio npm dependency)

const https = require("https");
const querystring = require("querystring");

const activeCalls = new Map();

function twilioApiRequest({ accountSid, authToken, path, method = "GET", form = null }) {
  return new Promise((resolve, reject) => {
    const body = form ? querystring.stringify(form) : "";

    const req = https.request(
      {
        hostname: "api.twilio.com",
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          ...(form
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          const isJson = String(res.headers["content-type"] || "").includes("application/json");
          const parsed = isJson ? safeJsonParse(responseBody) : null;

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed || { raw: responseBody });
            return;
          }

          const err = new Error(
            `Twilio API error (${res.statusCode}): ${
              parsed?.message || responseBody.slice(0, 300) || "Unknown error"
            }`
          );
          err.statusCode = res.statusCode;
          err.body = parsed || responseBody;
          reject(err);
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("Twilio API request timeout")));

    if (body) req.write(body);
    req.end();
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isCallTerminal(status) {
  return ["completed", "busy", "failed", "no-answer", "canceled"].includes(String(status || "").toLowerCase());
}

function canPlaceCall(maxConcurrent = 1) {
  let inProgress = 0;
  for (const call of activeCalls.values()) {
    if (!isCallTerminal(call.status)) inProgress += 1;
  }
  return inProgress < maxConcurrent;
}

async function initiateCall(to, options = {}) {
  const {
    accountSid,
    authToken,
    from,
    twimlUrl,
    statusCallback,
    maxConcurrent = 1,
    timeoutSeconds = 30,
  } = options;

  if (!accountSid || !authToken || !from || !twimlUrl) {
    throw new Error("Missing Twilio credentials or call parameters");
  }

  if (!canPlaceCall(maxConcurrent)) {
    const err = new Error("Concurrent call limit reached");
    err.code = "MAX_CONCURRENT_CALLS";
    throw err;
  }

  const form = {
    To: to,
    From: from,
    Url: twimlUrl,
    Method: "POST",
    Timeout: String(timeoutSeconds),
    MachineDetection: "Disable",
    StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  };

  if (statusCallback) {
    form.StatusCallback = statusCallback;
    form.StatusCallbackMethod = "POST";
  }

  const response = await twilioApiRequest({
    accountSid,
    authToken,
    path: `/2010-04-01/Accounts/${accountSid}/Calls.json`,
    method: "POST",
    form,
  });

  if (response?.sid) {
    activeCalls.set(response.sid, {
      sid: response.sid,
      to,
      from,
      status: response.status || "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      raw: response,
    });
  }

  return response;
}

async function getCallStatus(callSid, options = {}) {
  const { accountSid, authToken } = options;
  if (!accountSid || !authToken) throw new Error("Missing Twilio credentials");

  const response = await twilioApiRequest({
    accountSid,
    authToken,
    path: `/2010-04-01/Accounts/${accountSid}/Calls/${encodeURIComponent(callSid)}.json`,
    method: "GET",
  });

  if (response?.sid) {
    updateCallStatus(response.sid, response.status, response);
  }

  return response;
}

function updateCallStatus(callSid, status, raw = null) {
  if (!callSid) return null;

  const existing = activeCalls.get(callSid) || {
    sid: callSid,
    createdAt: Date.now(),
    to: null,
    from: null,
  };

  const next = {
    ...existing,
    status: status || existing.status || "unknown",
    updatedAt: Date.now(),
    raw: raw || existing.raw || null,
  };

  if (isCallTerminal(next.status)) {
    activeCalls.delete(callSid);
    return next;
  }

  activeCalls.set(callSid, next);
  return next;
}

function getActiveCalls() {
  return Array.from(activeCalls.values());
}

module.exports = {
  initiateCall,
  getCallStatus,
  updateCallStatus,
  canPlaceCall,
  getActiveCalls,
};
