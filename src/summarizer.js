// summarizer.js — LLM-based conversation summarizer (OpenClaw Gateway only)

const http = require("http");
const https = require("https");

const SUMMARY_PROMPT = `以下の音声通話/会議の会話ログから、簡潔なサマリーをJSON形式で生成してください。

出力フォーマット（必ずこのJSONのみ出力すること）:
{
  "summary": ["要約1", "要約2", "要約3"],
  "decisions": ["決定事項1"],
  "todos": ["TODO1"]
}

ルール:
- summaryは最大3項目の箇条書き
- decisionsは決定事項があれば記載（なければ空配列）
- todosはTODOがあれば記載（なければ空配列）
- JSONのみ出力。説明やマークダウンは不要

会話ログ:
`;

/**
 * Summarize a conversation log using LLM.
 *
 * @param {Array<{role: string, content: string, timestamp?: string}>} conversationLog
 * @param {object} options
 * @param {string} options.openclawUrl - OpenClaw Gateway URL (required)
 * @param {string} options.openclawToken - OpenClaw Gateway token (required)
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

  const prompt = SUMMARY_PROMPT + logText;

  try {
    if (!options.openclawUrl || !options.openclawToken) {
      console.warn("⚠️  Summarizer: OpenClaw Gateway not configured");
      return { summary: [], decisions: [], todos: [] };
    }

    const responseText = await callOpenClaw(prompt, options);

    // Parse JSON from response (handle potential markdown wrapping)
    return parseJsonResponse(responseText);
  } catch (err) {
    console.error("⚠️  Summarizer error:", err.message);
    return { summary: [], decisions: [], todos: [] };
  }
}

function parseJsonResponse(text) {
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
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
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
          todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        };
      } catch {
        // give up
      }
    }
    console.warn("⚠️  Summarizer: failed to parse JSON response");
    return { summary: [cleaned.slice(0, 200)], decisions: [], todos: [] };
  }
}

async function callOpenClaw(prompt, options) {
  const gatewayUrl = new URL(options.openclawUrl);
  const isHttps = gatewayUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const body = JSON.stringify({
    // Do not hardcode a foundation model; let Gateway choose.
    model: options.model || "openclaw",
    stream: false,
    temperature: 0.3,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const response = await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: gatewayUrl.hostname,
        port: gatewayUrl.port || (isHttps ? 443 : 80),
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.openclawToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`OpenClaw summarizer error (${res.statusCode}): ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Summarizer timeout")));
    req.write(body);
    req.end();
  });

  const parsed = JSON.parse(response);
  return parsed.choices?.[0]?.message?.content || "";
}

module.exports = { summarizeConversation };
