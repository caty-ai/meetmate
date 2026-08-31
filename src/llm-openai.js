// llm-openai.js — Generic OpenAI-compatible LLM backend

const http = require("http");
const https = require("https");
const { filterSilentRepliesStream } = require("./speech-policy");

// Re-check untrusted raw options here instead of relying only on config normalization.
const HTTP_HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const RESERVED_SESSION_HEADER_NAMES = Object.freeze([
  "authorization",
  "proxy-authorization",
  "content-length",
  "content-type",
  "host",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "keep-alive",
  "x-caty-agent-trust",
]);

function resolveCompletionPath(baseUrl) {
  const basePath = baseUrl.pathname && baseUrl.pathname !== "/"
    ? baseUrl.pathname.replace(/\/$/, "")
    : "";
  return `${basePath}${basePath.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
}

function requestOptions(baseUrl, apiKey, body) {
  const isHttps = baseUrl.protocol === "https:";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  return {
    transport: isHttps ? https : http,
    options: {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (isHttps ? 443 : 80),
      path: resolveCompletionPath(baseUrl),
      method: "POST",
      headers,
    },
  };
}

function applyTrustedAgentHeader(request, options = {}) {
  if (options.trustedAgentTools !== true) return request;
  return {
    ...request,
    options: {
      ...request.options,
      headers: {
        ...request.options.headers,
        "X-Caty-Agent-Trust": "trusted",
      },
    },
  };
}

function applySessionHeader(request, options = {}) {
  const sessionValue = options.user ?? options.sessionUser;
  if (typeof options.sessionHeader !== "string" || options.sessionHeader === ""
      || !HTTP_HEADER_TOKEN.test(options.sessionHeader)
      || RESERVED_SESSION_HEADER_NAMES.includes(options.sessionHeader.toLowerCase())
      || typeof sessionValue !== "string" || sessionValue === "") return request;
  return {
    ...request,
    options: {
      ...request.options,
      headers: {
        ...request.options.headers,
        [options.sessionHeader]: sessionValue,
      },
    },
  };
}

function buildRequest(baseUrl, apiKey, body, options = {}) {
  const request = requestOptions(baseUrl, apiKey, body);
  return {
    transport: request.transport,
    options: applySessionHeader(applyTrustedAgentHeader(request, options), options).options,
  };
}

function buildBody(messages, options, stream) {
  return JSON.stringify({
    model: options.model,
    stream,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    messages,
    ...(options.user !== undefined || options.sessionUser !== undefined
      ? { user: options.user ?? options.sessionUser }
      : {}),
  });
}

function resolveCredentials(options) {
  const nested = options.openaiCompatible || {};
  return {
    baseUrl: options.baseUrl || nested.baseUrl,
    apiKey: options.apiKey || nested.apiKey,
  };
}

function formatSsePayloadPreview(data) {
  return String(data || "").replace(/\s+/g, " ").slice(0, 200);
}

function formatSseErrorMessage(payload, fallback) {
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error.trim();
  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) return payload.error.message.trim();
  if (typeof payload?.message === "string" && payload.message.trim()) return payload.message.trim();
  return fallback;
}

function parseSseFrame(frame) {
  let eventName = "message";
  const dataLines = [];

  for (const rawLine of String(frame || "").split(/\r?\n/)) {
    if (!rawLine) continue;
    if (rawLine.startsWith(":")) continue;
    if (rawLine.startsWith("event:")) {
      eventName = rawLine.slice("event:".length).trim().toLowerCase() || "message";
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (eventName === "error" && dataLines.length === 0) {
    throw new Error("OpenAI-compatible SSE error event without payload");
  }
  if (dataLines.length === 0) return { done: false, content: null };

  const data = dataLines.join("\n");
  if (data === "[DONE]") return { done: true, content: null };

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error(`OpenAI-compatible SSE invalid JSON: ${formatSsePayloadPreview(data)}`);
  }

  if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "error")) {
    throw new Error(formatSseErrorMessage(payload, "OpenAI-compatible SSE error payload"));
  }

  if (eventName === "error") {
    throw new Error(formatSseErrorMessage(payload, "OpenAI-compatible SSE error event"));
  }

  const content = payload?.choices?.[0]?.delta?.content;
  return {
    done: false,
    content: typeof content === "string" && content ? content : null,
  };
}

function complete(messages, options = {}) {
  if (options.signal?.aborted) throw new Error("LLM request aborted");
  const credentials = resolveCredentials(options);
  if (!credentials.baseUrl || !credentials.apiKey) {
    throw new Error("OpenAI-compatible base URL and API key are required.");
  }
  const baseUrl = new URL(credentials.baseUrl);
  const body = buildBody(messages, options, false);
  const request = buildRequest(baseUrl, credentials.apiKey, body, options);

  return new Promise((resolve, reject) => {
    const req = request.transport.request(request.options, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, text }));
    });

    req.on("error", reject);
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(new Error("LLM request aborted"));
      }, { once: true });
    }
    req.setTimeout(options.timeoutMs ?? 60_000, () => {
      req.destroy(new Error(options.timeoutError || "OpenAI-compatible request timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function* streamChat(messages, options = {}) {
  if (options.signal?.aborted) throw new Error("LLM request aborted");
  if (options.streamingEquivalentEnabled === false) {
    const response = await complete(messages, options);
    if (response.statusCode !== 200) {
      throw new Error(`OpenAI-compatible error (${response.statusCode}): ${response.text.slice(0, 200)}`);
    }
    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new Error("OpenAI-compatible completion returned invalid JSON");
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return;
    yield* filterSilentRepliesStream((async function* completeChunk() { yield content; })());
    return;
  }
  let chunkCount = 0;
  for await (const chunk of streamOpenAI(messages, options)) {
    chunkCount += 1;
    yield chunk;
  }

  if (chunkCount > 0 || options.signal?.aborted || options.emptyResponseRetry === false) return;

  console.warn(`⚠️  [llm] Empty response on attempt 1 (session=${options.sessionUser}) — retrying...`);
  let retryChunks = 0;
  for await (const chunk of streamOpenAI(messages, options)) {
    retryChunks += 1;
    yield chunk;
  }
  if (retryChunks > 0) {
    console.log(`✅  [llm] Retry succeeded (${retryChunks} chunks)`);
  } else {
    console.warn("⚠️  [llm] Empty response on attempt 2 — giving up");
  }
}

async function* streamOpenAI(messages, options) {
  if (options.signal?.aborted) throw new Error("LLM request aborted");
  const credentials = resolveCredentials(options);
  if (!credentials.baseUrl || !credentials.apiKey) {
    throw new Error("OpenAI-compatible base URL and API key are required.");
  }

  const baseUrl = new URL(credentials.baseUrl);
  const body = buildBody(messages, options, true);
  const request = buildRequest(baseUrl, credentials.apiKey, body, options);
  const response = await new Promise((resolve, reject) => {
    const req = request.transport.request(request.options, resolve);
    req.on("error", reject);
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(new Error("LLM request aborted"));
      }, { once: true });
    }
    req.setTimeout(60_000, () => {
      req.destroy(new Error("OpenAI-compatible request timeout"));
    });
    req.write(body);
    req.end();
  });

  if (response.statusCode !== 200) {
    let errBody = "";
    for await (const chunk of response) errBody += chunk;
    throw new Error(`OpenAI-compatible error (${response.statusCode}): ${errBody.slice(0, 200)}`);
  }

  yield* filterSilentRepliesStream(parseSSE(response, options.signal));
}

async function* parseSSE(response, signal) {
  let buffer = "";
  for await (const chunk of response) {
    if (signal?.aborted) break;
    buffer += chunk.toString();
    while (true) {
      const boundary = buffer.match(/\r?\n\r?\n/);
      if (!boundary) break;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const parsed = parseSseFrame(frame);
      if (parsed.done) return;
      if (parsed.content) yield parsed.content;
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseFrame(buffer.trim());
    if (!parsed.done && parsed.content) yield parsed.content;
  }
}

module.exports = { streamChat, complete };
