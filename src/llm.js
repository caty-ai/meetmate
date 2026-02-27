// llm.js — Claude LLM streaming wrapper (via OpenRouter)
// Uses fetch to call OpenRouter's OpenAI-compatible API

const https = require("https");

/**
 * Stream a chat completion from Claude via OpenRouter.
 * @param {string} systemPrompt - System prompt text
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {object} options
 * @param {string} options.apiKey - OpenRouter API key
 * @param {string} options.model - Model ID (default: "anthropic/claude-sonnet-4-5")
 * @param {number} options.temperature - Temperature (default: 0.5)
 * @param {number} options.maxTokens - Max tokens (default: 300)
 * @param {AbortSignal} options.signal - AbortSignal for cancellation
 * @returns {AsyncGenerator<string>} Yields text chunks
 */
async function* streamChat(systemPrompt, messages, options = {}) {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for LLM");

  const model = options.model || "anthropic/claude-sonnet-4-5";
  const temperature = options.temperature ?? 0.5;
  const maxTokens = options.maxTokens || 300;

  const body = JSON.stringify({
    model,
    stream: true,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  });

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "openrouter.ai",
        port: 443,
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "HTTP-Referer": "https://github.com/caty-ai/meetmate",
          "X-Title": "AI Meet Participant",
        },
      },
      (res) => resolve(res)
    );

    req.on("error", reject);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(new Error("LLM request aborted"));
      });
    }

    req.setTimeout(30_000, () => {
      req.destroy(new Error("LLM request timeout"));
    });

    req.write(body);
    req.end();
  });

  if (response.statusCode !== 200) {
    let errBody = "";
    for await (const chunk of response) errBody += chunk;
    throw new Error(`OpenRouter API error (${response.statusCode}): ${errBody.slice(0, 200)}`);
  }

  // Parse SSE stream
  let buffer = "";
  for await (const chunk of response) {
    if (options.signal?.aborted) break;

    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // skip unparseable lines
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
      try {
        const parsed = JSON.parse(trimmed.slice(6));
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // skip
      }
    }
  }
}

module.exports = { streamChat };
