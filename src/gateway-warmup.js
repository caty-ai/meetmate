// gateway-warmup.js — OpenClaw Gateway session warm-up
// When briefing is provided, also generates a purpose statement for immediate greeting.

const { URL } = require("url");
const { DEFAULT_MESSAGES } = require("./messages");
const { getEffectiveValue } = require("./settings/resolver");

const DEFAULT_WARMUP_TIMEOUT_MS = 8_000;

/**
 * Warm up a Gateway session and optionally generate a purpose statement.
 * @returns {Promise<{status: string, purposeStatement: string|null}>}
 */
function warmUpGatewaySession(sessionId, config, briefing = null) {
  const configuredTimeout = getEffectiveValue("gateway_warmup_timeout_ms");
  const WARMUP_REQUEST_TIMEOUT_MS = configuredTimeout === undefined
    ? DEFAULT_WARMUP_TIMEOUT_MS
    : Number(configuredTimeout);
  return new Promise((resolve) => {
    let settled = false;
    const done = (status, purposeStatement = null) => {
      if (settled) return;
      settled = true;
      resolve({ status, purposeStatement });
    };

    const sessionUser = String(sessionId || "").trim();
    const configuredProvider = String(config?.llm?.provider || getEffectiveValue("llm_provider") || "openclaw").toLowerCase();
    const provider = configuredProvider === "openai-compatible" ? configuredProvider : "openclaw";
    if (provider !== "openclaw") {
      console.log(`⏭️  Gateway warm-up skipped (provider=${provider}, session=${sessionUser})`);
      done(`skipped_provider_${provider}`);
      return;
    }

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
      if (!["http:", "https:"].includes(gatewayUrl.protocol)
          || gatewayUrl.username || gatewayUrl.password || gatewayUrl.hash
          || openclawUrl !== openclawUrl.trim()) throw new Error("invalid");
    } catch {
      console.log("⏭️  Gateway warm-up skipped (invalid gateway url)");
      done("skipped_invalid_gateway_url");
      return;
    }

    const briefingText = typeof briefing === "string" ? briefing.trim() : "";
    const briefingPrompt = config?.gatewayBriefingPrompt || DEFAULT_MESSAGES.prompts.gatewayBriefingSystem;
    const warmupUserPrompt = config?.gatewayWarmupUserPrompt || DEFAULT_MESSAGES.prompts.gatewayWarmupUser;
    const messages = briefingText
      ? [
          {
            role: "system",
            content: briefingPrompt,
          },
          { role: "user", content: briefingText },
        ]
      : [
          {
            role: "user",
            content: warmupUserPrompt,
          },
        ];

    try {
      const provider = require("./llm-provider").createLlmProvider({ provider: "openclaw" });
      provider.complete(messages, {
        openclawUrl,
        openclawToken,
        model: config?.llm?.model || "openclaw",
        temperature: config?.llm?.temperature ?? 0.3,
        maxTokens: 200,
        user: sessionUser,
        timeoutMs: WARMUP_REQUEST_TIMEOUT_MS,
        timeoutError: "Gateway warm-up timeout",
      }).then(({ statusCode, text: responseBody }) => {
        if ((statusCode || 0) >= 400) {
          console.error(`❌  Gateway warm-up failed: HTTP ${statusCode} (session=${sessionUser})`);
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
          } catch {
            console.error("⚠️  Purpose statement parse error");
          }
        }

        console.log(`✅  Gateway warm-up complete (session=${sessionUser})`);
        done("ok", purposeStatement);
      }).catch((err) => {
        if (err.message === "Gateway warm-up timeout") {
          console.error(`❌  Gateway warm-up timeout (${WARMUP_REQUEST_TIMEOUT_MS}ms) (session=${sessionUser})`);
          done("timeout");
          return;
        }
        console.error(`❌  Gateway warm-up request error (session=${sessionUser})`);
        done("request_error");
      });

      console.log(`🔥  Gateway warm-up started (session=${sessionUser}, briefing=${briefingText ? "yes" : "no"})`);
    } catch {
      console.error(`❌  Gateway warm-up setup error (session=${sessionUser})`);
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
      openclawUrl: baseConfig?.openclawUrl || null,
      openclawToken: baseConfig?.openclawToken || null,
      llm: {
        ...(baseConfig?.llm || {}),
        model: agent.model || baseConfig?.llm?.model,
      },
    };
    return warmUpGatewaySession(`meet-${sessionId}-${agentId}`, agentConfig, briefing);
  });

  Promise.all(promises).catch(() => {
    console.error("⚠️  Multi-agent warm-up partial failure");
  });
}

module.exports = { warmUpGatewaySession, warmUpMultipleAgents };
