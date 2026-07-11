// llm-openai.js — Generic OpenAI-compatible LLM backend

const http = require("http");
const https = require("https");
const { filterSilentRepliesStream } = require("./speech-policy");

function resolveCompletionPath(baseUrl) {
  const basePath = baseUrl.pathname && baseUrl.pathname !== "/"
    ? baseUrl.pathname.replace(/\/$/, "")
    : "";
  return `${basePath}${basePath.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
}

function requestOptions(baseUrl, apiKey, body) {
  const isHttps = baseUrl.protocol === "https:";
  return {
    transport: isHttps ? https : http,
    options: {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (isHttps ? 443 : 80),
      path: resolveCompletionPath(baseUrl),
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
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

function complete(messages, options = {}) {
  if (options.signal?.aborted) throw new Error("LLM request aborted");
  const credentials = resolveCredentials(options);
  if (!credentials.baseUrl || !credentials.apiKey) {
    throw new Error("OpenAI-compatible base URL and API key are required.");
  }
  const baseUrl = new URL(credentials.baseUrl);
  const body = buildBody(messages, options, false);
  const request = requestOptions(baseUrl, credentials.apiKey, body);

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
  let chunkCount = 0;
  for await (const chunk of streamOpenAI(messages, options)) {
    chunkCount += 1;
    yield chunk;
  }

  if (chunkCount > 0 || options.signal?.aborted) return;

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
  const request = requestOptions(baseUrl, credentials.apiKey, body);
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
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !/^data:\s?/.test(trimmed)) continue;
      const data = trimmed.replace(/^data:\s?/, "");
      if (data === "[DONE]") return;
      try {
        const content = JSON.parse(data).choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // skip unparseable lines
      }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    const data = trimmed.replace(/^data:\s?/, "");
    if (/^data:\s?/.test(trimmed) && data !== "[DONE]") {
      try {
        const content = JSON.parse(data).choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // skip
      }
    }
  }
}

module.exports = { streamChat, complete };
