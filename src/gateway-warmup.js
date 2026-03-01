// gateway-warmup.js — fire-and-forget OpenClaw Gateway session warm-up

const http = require("http");
const https = require("https");
const { URL } = require("url");

const WARMUP_REQUEST_TIMEOUT_MS = 30_000;

function warmUpGatewaySession(sessionId, config, briefing = null) {
  const sessionUser = String(sessionId || "").trim();
  if (!sessionUser) {
    console.log("⏭️  Gateway warm-up skipped (empty session id)");
    return;
  }

  const openclawUrl = String(config?.openclawUrl || "").trim();
  const openclawToken = String(config?.openclawToken || "").trim();

  if (!openclawUrl || !openclawToken) {
    console.log(`⏭️  Gateway warm-up skipped (gateway unavailable, session=${sessionUser})`);
    return;
  }

  let gatewayUrl;
  try {
    gatewayUrl = new URL(openclawUrl);
  } catch {
    console.log(`⏭️  Gateway warm-up skipped (invalid gateway url: ${openclawUrl})`);
    return;
  }

  const briefingText = typeof briefing === "string" ? briefing.trim() : "";
  const messages = briefingText
    ? [
        {
          role: "system",
          content: "音声通話の準備中です。以下の情報を確認して備えてください。",
        },
        { role: "user", content: briefingText },
      ]
    : [
        {
          role: "user",
          content: "セッション準備中。次のメッセージから音声通話が始まります。",
        },
      ];

  const body = JSON.stringify({
    model: config?.llm?.model || "anthropic/claude-sonnet-4-6",
    stream: false,
    temperature: config?.llm?.temperature ?? 0.2,
    messages,
    user: sessionUser,
  });

  const isHttps = gatewayUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const basePath = gatewayUrl.pathname && gatewayUrl.pathname !== "/"
    ? gatewayUrl.pathname.replace(/\/$/, "")
    : "";
  const requestPath = `${basePath}/v1/chat/completions`;

  try {
    const req = transport.request(
      {
        hostname: gatewayUrl.hostname,
        port: gatewayUrl.port || (isHttps ? 443 : 80),
        path: requestPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${openclawToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if ((res.statusCode || 0) >= 400) {
          console.error(`❌  Gateway warm-up failed: HTTP ${res.statusCode} (session=${sessionUser})`);
        }
      }
    );

    req.on("error", (err) => {
      console.error(`❌  Gateway warm-up request error (session=${sessionUser}):`, err.message);
    });

    req.setTimeout(WARMUP_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Gateway warm-up timeout (${WARMUP_REQUEST_TIMEOUT_MS}ms)`));
    });

    req.write(body);
    req.end();

    console.log(`🔥  Gateway warm-up started (session=${sessionUser}, briefing=${briefingText ? "yes" : "no"})`);
  } catch (err) {
    console.error(`❌  Gateway warm-up setup error (session=${sessionUser}):`, err.message);
  }
}

module.exports = { warmUpGatewaySession };
