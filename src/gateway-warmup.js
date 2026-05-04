// gateway-warmup.js — OpenClaw Gateway session warm-up
// When briefing is provided, also generates a purpose statement for immediate greeting.

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_WARMUP_TIMEOUT_MS = 8_000;

/**
 * Warm up a Gateway session and optionally generate a purpose statement.
 * @returns {Promise<{status: string, purposeStatement: string|null}>}
 */
function warmUpGatewaySession(sessionId, config, briefing = null) {
  // Allow per-agent timeout via config (gateway.warmupTimeoutMs) or env var
  const WARMUP_REQUEST_TIMEOUT_MS =
    Number(config?.warmupTimeoutMs) ||
    Number(process.env.GATEWAY_WARMUP_TIMEOUT_MS) ||
    DEFAULT_WARMUP_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (status, purposeStatement = null) => {
      if (settled) return;
      settled = true;
      resolve({ status, purposeStatement });
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
            content: [
              "音声通話の準備中です。以下のブリーフィングを読んで準備してください。",
              "",
              "【重要】応答は以下のJSON形式のみで返してください：",
              '{"purposeStatement": "挨拶の直後に話す、電話の目的を伝える1〜2文。自然な話し言葉で。感情タグ付き。"}',
              "",
              "例: {\"purposeStatement\": \"[empathetic, unhurried] 今日はレストランの予約の件でお電話させていただきました。来週の金曜日に4名で伺いたいのですが。\"}",
              "",
              "ルール:",
              "- 1〜2文で簡潔に。長くならないこと",
              "- 自然な敬語の話し言葉にする",
              "- ブリーフィングの内容を要約・整形する（そのまま読まない）",
              "- 必要な時だけ感情タグを使う（多用しない）。使えるタグ: [soft voice], [warm], [friendly, warm], [empathetic, unhurried], [thoughtful]",
              "- JSONのみ出力。説明やマークダウンは不要",
            ].join("\n"),
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
      // Do not hardcode a foundation model; let Gateway choose.
      model: config?.llm?.model || "openclaw",
      stream: false,
      temperature: config?.llm?.temperature ?? 0.3,
      max_tokens: 200,
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
          let responseBody = "";
          res.on("data", (chunk) => { responseBody += chunk; });
          res.on("end", () => {
            if ((res.statusCode || 0) >= 400) {
              console.error(`❌  Gateway warm-up failed: HTTP ${res.statusCode} (session=${sessionUser})`);
              done("http_error");
              return;
            }

            // Extract purpose statement from response
            let purposeStatement = null;
            if (briefingText) {
              try {
                const parsed = JSON.parse(responseBody);
                const content = parsed?.choices?.[0]?.message?.content || "";
                // Try JSON parse first
                try {
                  const jsonContent = JSON.parse(content);
                  purposeStatement = jsonContent.purposeStatement || null;
                } catch {
                  // If not valid JSON, try to extract from text
                  const match = content.match(/"purposeStatement"\s*:\s*"([^"]+)"/);
                  if (match) {
                    purposeStatement = match[1];
                  } else if (content.trim().length > 5 && content.trim().length < 200) {
                    // Use raw content as fallback
                    purposeStatement = content.trim();
                  }
                }
                if (purposeStatement) {
                  console.log(`✅  Purpose statement generated: "${purposeStatement}"`);
                }
              } catch (err) {
                console.error(`⚠️  Purpose statement parse error: ${err.message}`);
              }
            }

            console.log(`✅  Gateway warm-up complete (session=${sessionUser})`);
            done("ok", purposeStatement);
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
    if (!agent) return Promise.resolve({ status: "skipped_unknown", purposeStatement: null });

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
