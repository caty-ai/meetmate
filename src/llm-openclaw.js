// llm-openclaw.js — OpenClaw LLM backend implementation, moved from llm.js
// Gateway provides full agent experience: SOUL/memory/tools/skills

const http = require("http");
const https = require("https");
const { filterSilentRepliesStream } = require("./speech-policy");
const { buildVoiceAddendumFromMessages, resolveMessages } = require("./messages");

function resolveCompletionPath(gatewayUrl) {
  // Design #114 explicitly permits base URLs with path prefixes.
  const basePath = gatewayUrl.pathname && gatewayUrl.pathname !== "/"
    ? gatewayUrl.pathname.replace(/\/$/, "")
    : "";
  return `${basePath}/v1/chat/completions`;
}

function buildCompleteBody(messages, options) {
  return JSON.stringify({
    model: options.model,
    stream: false,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    messages,
    ...(options.user !== undefined ? { user: options.user } : {}),
  });
}

/**
 * Perform a one-shot, non-streaming OpenClaw completion.
 * Callers retain status handling, response parsing, and logging policy.
 */
function complete(messages, options = {}) {
  const gatewayUrl = new URL(options.openclawUrl);
  const isHttps = gatewayUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const body = buildCompleteBody(messages, options);
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  const req = transport.request(
    {
      hostname: gatewayUrl.hostname,
      port: gatewayUrl.port || (isHttps ? 443 : 80),
      path: resolveCompletionPath(gatewayUrl),
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.openclawToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolveResponse({ statusCode: res.statusCode, text }));
    },
  );

  req.on("error", rejectResponse);

  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      req.destroy(new Error("LLM request aborted"));
    }, { once: true });
  }

  if (options.timeoutMs !== undefined) {
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(options.timeoutError || "OpenClaw request timeout"));
    });
  }

  req.write(body);
  req.end();
  return response;
}

/**
 * Dispatch a timeout handoff while preserving Gateway's special timeout rules.
 * @returns {Promise<boolean>} Whether the handoff is treated as dispatched.
 */
function timeoutHandoff(params) {
  const gatewayModeHandoff = params.gatewayModeHandoff === true;
  const gatewayUrl = new URL(params.openclawUrl);
  const isHttps = gatewayUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const body = buildCompleteBody(
    [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userPrompt },
    ],
    {
      model: params.model,
      temperature: 0.2,
      maxTokens: 700,
      user: params.sessionUser,
    },
  );
  let resolveHandoff;
  const result = new Promise((resolve) => {
    resolveHandoff = resolve;
  });

  const req = transport.request(
    {
      hostname: gatewayUrl.hostname,
      port: gatewayUrl.port || (isHttps ? 443 : 80),
      path: resolveCompletionPath(gatewayUrl),
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.openclawToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume();
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      if (!ok) console.error(`❌  Timeout handoff failed: HTTP ${res.statusCode}`);
      resolveHandoff(ok);
    },
  );

  req.on("error", (err) => {
    if (gatewayModeHandoff && /Timeout handoff request timeout/i.test(String(err?.message || ""))) {
      console.warn("⚠️  Timeout handoff request timed out after dispatch; treating as dispatched (unconfirmed)");
      resolveHandoff(true);
      return;
    }
    console.error("❌  Timeout handoff request error:", err.message);
    resolveHandoff(false);
  });

  req.setTimeout(gatewayModeHandoff ? 15_000 : 5_000, () => {
    if (gatewayModeHandoff) {
      console.warn("⚠️  Timeout handoff client timeout; request may still be queued by Gateway");
      resolveHandoff(true);
    }
    req.destroy(new Error("Timeout handoff request timeout"));
  });

  req.write(body);
  req.end();
  params.onDispatched?.();
  return result;
}

// Voice-specific system prompt builder (appended to OpenClaw's SOUL.md)
// emotionTags: boolean — include emotion tag instructions (default true)
//
// Tag syntax: Fish Audio S2-Pro uses [bracket] + natural language tags. Without
// any tag the model's prosody is unstable (live testing showed sudden volume
// jumps and voice-quality drift), so we *always* anchor every utterance with
// at least one tag. [soft voice] is the default to keep the agent calm and gentle;
// other tags are reserved for moments that call for them.
function buildVoiceAddendum({ emotionTags = true } = {}) {
  return buildVoiceAddendumFromMessages(resolveMessages(), { emotionTags });
}

// Default addendum (backward compat)
const VOICE_SYSTEM_ADDENDUM = buildVoiceAddendum({ emotionTags: true });

/**
 * Stream a chat completion via OpenClaw Gateway.
 *
 * @param {Array<{role: string, content: string}>} messages - Conversation messages
 * @param {object} options
 * @param {string} options.openclawUrl - OpenClaw Gateway URL (required)
 * @param {string} options.openclawToken - OpenClaw Gateway token (required)
 * @param {string} [options.sessionUser] - User/session ID for OpenClaw session isolation
 * @param {string} [options.openclawSystemAddendum] - System addendum override for OpenClaw voice mode
 * @param {string} [options.model] - Model ID
 * @param {number} [options.temperature] - Temperature (default: 0.5)
 * @param {number} [options.maxTokens] - Max tokens (default: 300)
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @returns {AsyncGenerator<string>} Yields text chunks
 */
async function* streamChat(messages, options = {}) {
  if (!options.openclawUrl || !options.openclawToken) {
    throw new Error('OpenClaw Gateway is required. Set OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN.');
  }

  // First attempt: stream chunks directly to caller for real-time TTS.
  // Previously this was buffered via collectChunks(), which delayed first audio
  // by the full Gateway/tool round-trip. Yielding directly restores the
  // sentence-level streaming the rest of the pipeline expects.
  let chunkCount = 0;
  for await (const chunk of streamOpenClaw(messages, options)) {
    chunkCount += 1;
    yield chunk;
  }

  if (chunkCount > 0 || options.signal?.aborted) return;

  // Empty response auto-retry (max 1 retry) — only triggers when attempt 1
  // produced zero chunks. We cannot retry mid-stream because partial chunks
  // have already been yielded to the caller.
  console.warn(`⚠️  [llm] Empty response on attempt 1 (session=${options.sessionUser}) — retrying...`);
  let retryChunks = 0;
  for await (const chunk of streamOpenClaw(messages, options)) {
    retryChunks += 1;
    yield chunk;
  }
  if (retryChunks > 0) {
    console.log(`✅  [llm] Retry succeeded (${retryChunks} chunks)`);
  } else {
    console.warn(`⚠️  [llm] Empty response on attempt 2 — giving up`);
  }
}

// ── OpenClaw Gateway backend ────────────────────────────────────────

async function* streamOpenClaw(messages, options) {
  const gatewayUrl = new URL(options.openclawUrl);
  const token = options.openclawToken;
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens || 500; // Higher for tool use responses

  // Build messages: voice addendum as system + user messages only
  // (OpenClaw injects SOUL.md/AGENTS.md/memory automatically)
  const systemAddendum =
    typeof options.openclawSystemAddendum === "string"
      ? options.openclawSystemAddendum
      : VOICE_SYSTEM_ADDENDUM;

  const apiMessages = [
    { role: "system", content: systemAddendum },
    ...messages,
  ];

  const body = JSON.stringify({
    // OpenClaw Gateway /v1/chat/completions: `model` selects the OpenClaw agent
    // (or is ignored depending on routing). Do not hardcode a foundation model here.
    model: options.model || "openclaw", 
    stream: true,
    temperature,
    max_tokens: maxTokens,
    messages: apiMessages,
    ...(options.sessionUser ? { user: options.sessionUser } : {}),
  });

  const isHttps = gatewayUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const response = await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: gatewayUrl.hostname,
        port: gatewayUrl.port || (isHttps ? 443 : 80),
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => resolve(res)
    );

    req.on("error", reject);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(new Error("LLM request aborted"));
      }, { once: true });
    }

    req.setTimeout(60_000, () => {
      req.destroy(new Error("OpenClaw Gateway request timeout"));
    });

    req.write(body);
    req.end();
  });

  if (response.statusCode !== 200) {
    let errBody = "";
    for await (const chunk of response) errBody += chunk;
    throw new Error(`OpenClaw Gateway error (${response.statusCode}): ${errBody.slice(0, 200)}`);
  }

  yield* filterSilentRepliesStream(parseSSE(response, options.signal));
}

// ── SSE parser ──────────────────────────────────────────────────────

async function* parseSSE(response, signal) {
  let buffer = "";
  for await (const chunk of response) {
    if (signal?.aborted) break;

    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

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

  // Flush remaining
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

module.exports = {
  streamChat,
  complete,
  timeoutHandoff,
  VOICE_SYSTEM_ADDENDUM,
  buildVoiceAddendum,
};
