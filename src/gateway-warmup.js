// gateway-warmup.js — fire-and-forget OpenClaw Gateway session warm-up

const http = require("http");
const https = require("https");
const { URL } = require("url");

const WARMUP_REQUEST_TIMEOUT_MS = 30_000;

function warmUpGatewaySession(sessionId, config, briefing = null) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };

    const sessionUser = String(sessionId || "").trim();
    if (!sessionUser) {
      console.log("⏭️  Gateway warm-up skipped (empty session id)");
      done("skipped_empty_session");
      return;
    }

    const openclawUrl = String(config?.openclawUrl || "").trim();
    const openclawToken = String(config?.openclawToken || "").trim();

    if (!openclawUrl || !openclawToken) {
      console.log(`⏭️  Gateway warm-up skipped (gateway unavailable, session=${sessionUser})`);
      done("skipped_gateway_unavailable");
      return;
    }

    let gatewayUrl;
    try {
      gatewayUrl = new URL(openclawUrl);
    } catch {
      console.log(`⏭️  Gateway warm-up skipped (invalid gateway url: ${openclawUrl})`);
      done("skipped_invalid_gateway_url");
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
          res.on("end", () => {
            if ((res.statusCode || 0) >= 400) {
              console.error(`❌  Gateway warm-up failed: HTTP ${res.statusCode} (session=${sessionUser})`);
              done("http_error");
              return;
            }
            done("ok");
          });
        }
      );

      req.on("error", (err) => {
        console.error(`❌  Gateway warm-up request error (session=${sessionUser}):`, err.message || err.code || err);
        done("request_error");
      });

      req.setTimeout(WARMUP_REQUEST_TIMEOUT_MS, () => {
        console.error(`❌  Gateway warm-up timeout (${WARMUP_REQUEST_TIMEOUT_MS}ms) (session=${sessionUser})`);
        done("timeout");
        req.destroy();
      });

      req.write(body);
      req.end();

      console.log(`🔥  Gateway warm-up started (session=${sessionUser}, briefing=${briefingText ? "yes" : "no"})`);
    } catch (err) {
      console.error(`❌  Gateway warm-up setup error (session=${sessionUser}):`, err.message);
      done("setup_error");
    }
  });
}

function warmUpMultipleAgents(sessionId, agents, selectedAgentIds, baseConfig, briefing = null) {
  const ids = Array.isArray(selectedAgentIds) ? selectedAgentIds : [];
  if (!sessionId || ids.length === 0) return;

  const promises = ids.map((agentId) => {
    const agent = agents?.[agentId];
    if (!agent) return Promise.resolve("skipped_unknown");

    const agentConfig = {
      ...baseConfig,
      openclawUrl: agent.gatewayUrl || baseConfig?.openclawUrl || null,
      openclawToken: agent.gatewayToken || baseConfig?.openclawToken || null,
      llm: {
        ...(baseConfig?.llm || {}),
        model: agent.model || baseConfig?.llm?.model,
      },
    };

    return warmUpGatewaySession(`meet-${sessionId}-${agentId}`, agentConfig, briefing);
  });

  Promise.all(promises).catch((err) => {
    console.error("⚠️  Multi-agent warm-up partial failure:", err.message);
  });
}

module.exports = { warmUpGatewaySession, warmUpMultipleAgents };
