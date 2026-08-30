// summarizer.js — LLM-based conversation summarizer

const crypto = require("node:crypto");
const { DEFAULT_MESSAGES } = require("./messages");

const SUMMARY_PROMPT = DEFAULT_MESSAGES.prompts.summary;

/**
 * Summarize a conversation log using LLM.
 *
 * @param {Array<{role: string, content: string, timestamp?: string}>} conversationLog
 * @param {object} options
 * @param {object} options.llm - Resolved LLM configuration (required)
 * @param {string} [options.model]
 * @returns {Promise<{summary: string[], decisions: string[], todos: string[]}>}
 */
// Safety: max utterances and characters for summary input
const MAX_SUMMARY_UTTERANCES = 100;
const MAX_SUMMARY_CHARS = 8000;

// Mask phone numbers (e.g. +81-xxx → +81-***-***-****)
const PHONE_RE = /(\+?\d{1,4}[-\s]?)\d[\d\-\s]{5,}\d/g;

function maskSensitive(text) {
  return text.replace(PHONE_RE, (match, prefix) => {
    return prefix + "***-***-****";
  });
}

function buildSummaryPrompt(summaryPrompt, taskExtractionEnabled) {
  if (taskExtractionEnabled) return summaryPrompt;
  return String(summaryPrompt)
    .split("\n")
    .filter((line) => !/\btodos?\b|TODO|タスク/i.test(line))
    .join("\n")
    .replace(/("decisions"\s*:\s*\[[^\n]*\]),(?=\s*\n\s*})/, "$1");
}

async function summarizeConversation(conversationLog, options = {}) {
  if (!conversationLog || conversationLog.length === 0) {
    return { summary: [], decisions: [], todos: [] };
  }

  // Clip to last N utterances, then limit by character count
  const clipped = conversationLog.slice(-MAX_SUMMARY_UTTERANCES);

  // Format and mask sensitive data
  let logText = clipped
    .map((e) => {
      const speaker = e.role === "assistant" || e.role === "agent" ? (options.displayName || "AI") : "参加者";
      return `${speaker}: ${maskSensitive(e.content || "")}`;
    })
    .join("\n");

  // Truncate if still too long
  if (logText.length > MAX_SUMMARY_CHARS) {
    logText = logText.slice(-MAX_SUMMARY_CHARS);
    logText = "...(前半省略)\n" + logText;
  }

  const taskExtractionEnabled = options.taskExtractionEnabled !== false;
  const summaryPrompt = buildSummaryPrompt(options.summaryPrompt || SUMMARY_PROMPT, taskExtractionEnabled);
  const prompt = summaryPrompt + logText;

  try {
    if (!isConfigured(options.llm)) {
      console.warn("⚠️  Summarizer: LLM provider not configured");
      return { summary: [], decisions: [], todos: [] };
    }

    const responseText = await callLlm(prompt, options);

    // Parse JSON from response (handle potential markdown wrapping)
    return parseJsonResponse(responseText, { taskExtractionEnabled });
  } catch (err) {
    console.error("⚠️  Summarizer error:", err.message);
    return { summary: [], decisions: [], todos: [] };
  }
}

function parseJsonResponse(text, { taskExtractionEnabled = true } = {}) {
  // Strip markdown code blocks if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary: Array.isArray(parsed.summary) ? parsed.summary : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      todos: taskExtractionEnabled && Array.isArray(parsed.todos) ? parsed.todos : [],
    };
  } catch {
    // Try to extract JSON from text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          summary: Array.isArray(parsed.summary) ? parsed.summary : [],
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
          todos: taskExtractionEnabled && Array.isArray(parsed.todos) ? parsed.todos : [],
        };
      } catch {
        // give up
      }
    }
    console.warn("⚠️  Summarizer: failed to parse JSON response");
    return { summary: [cleaned.slice(0, 200)], decisions: [], todos: [] };
  }
}

function isConfigured(llm) {
  if (llm?.provider === "openai-compatible") {
    return Boolean(llm.openaiCompatible?.baseUrl && llm.openaiCompatible?.apiKey && llm.model);
  }
  return Boolean(llm?.gateway?.url && llm?.gateway?.token);
}

function gatewayAuth(openclawUrl, openclawToken) {
  return { openclawUrl, openclawToken };
}

async function callLlm(prompt, options) {
  const llm = options.llm || {};
  const provider = require("./llm-provider").createLlmProvider({ provider: llm.provider });
  const { baseUrl, apiKey } = llm.openaiCompatible || {};
  const providerOptions = llm.provider === "openai-compatible"
    ? {
        baseUrl,
        apiKey,
        model: llm.model,
        trustedAgentTools: llm.openaiCompatible?.trustedAgentTools === true,
        // Stateful OpenAI-compatible gateways (e.g. the Claude Code bridge)
        // require `user` as a mandatory session-routing key. A fresh key per
        // summary keeps this turn out of any live meeting session.
        user: options.sessionUser || `meetmate-summary-${crypto.randomUUID()}`,
      }
    : {
        ...gatewayAuth(llm.gateway?.url, llm.gateway?.token),
        model: llm.model || "openclaw",
      };
  // Honor the resolved per-provider response timeout (LLM_RESPONSE_TIMEOUT_MS);
  // stateful gateway turns (e.g. Claude Code bridge) regularly exceed 30s.
  const configuredTimeoutMs = Number(llm.responseTimeoutMs);
  const { statusCode, text: response } = await provider.complete(
    [{ role: "user", content: prompt }],
    {
      ...providerOptions,
      temperature: 0.3,
      maxTokens: 500,
      timeoutMs: configuredTimeoutMs > 0 ? configuredTimeoutMs : 30_000,
      timeoutError: "Summarizer timeout",
    },
  );

  if (statusCode !== 200) {
    const providerLabel = llm.provider === "openai-compatible" ? "OpenAI-compatible" : "OpenClaw";
    throw new Error(`${providerLabel} summarizer error (${statusCode}): ${response.slice(0, 200)}`);
  }

  const parsed = JSON.parse(response);
  return parsed.choices?.[0]?.message?.content || "";
}

module.exports = { buildSummaryPrompt, summarizeConversation, SUMMARY_PROMPT };
