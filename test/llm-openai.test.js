const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const openai = require("../src/llm-openai");

function installMockServer(t, handle) {
  const originalRequest = http.request;
  http.request = (options, callback) => {
    const req = new EventEmitter();
    let body = "";
    let response;
    req.write = (chunk) => { body += String(chunk); };
    req.setTimeout = (ms, fn) => {
      req.timeoutMs = ms;
      req.timeoutHandler = fn;
      return req;
    };
    req.destroy = (err) => process.nextTick(() => {
      response?.destroy(err);
      req.emit("error", err);
    });
    req.end = () => process.nextTick(async () => {
      const reply = await handle({ options, body: JSON.parse(body), req });
      response = new PassThrough();
      response.statusCode = reply.statusCode ?? 200;
      callback(response);
      reply.onStarted?.();
      if (reply.pending) return;
      for (const chunk of reply.chunks || []) response.write(chunk);
      response.end();
    });
    return req;
  };
  t.after(() => { http.request = originalRequest; });
}

async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

test("openai-compatible provider exposes the OpenAI implementation directly", () => {
  const { createLlmProvider } = require("../src/llm-provider");
  const provider = createLlmProvider({ provider: "openai-compatible" });

  assert.equal(provider.name, "openai-compatible");
  assert.strictEqual(provider.streamChat, openai.streamChat);
  assert.strictEqual(provider.complete, openai.complete);
});

test("streamChat parses OpenAI SSE chunks and sends the configured request", async (t) => {
  let captured;
  installMockServer(t, async (request) => {
    captured = request;
    return {
      chunks: [
        'data: {"choices":[{"delta":{"content":"こん"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
    };
  });

  const chunks = await collect(openai.streamChat(
    [{ role: "user", content: "挨拶して" }],
    {
      baseUrl: "http://mock.test/compatible/",
      apiKey: "test-key",
      model: "local-model",
      temperature: 0.4,
      maxTokens: 123,
      sessionUser: "meet-1",
    },
  ));

  assert.deepEqual(chunks, ["こん", "にちは"]);
  assert.equal(captured.options.path, "/compatible/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.equal(captured.req.timeoutMs, 60_000);
  assert.deepEqual(captured.body, {
    model: "local-model",
    stream: true,
    temperature: 0.4,
    max_tokens: 123,
    messages: [{ role: "user", content: "挨拶して" }],
    user: "meet-1",
  });
});

test("complete returns status and text using a base-path-aware endpoint", async (t) => {
  let captured;
  installMockServer(t, async (request) => {
    captured = request;
    return {
      statusCode: 201,
      chunks: ['{"choices":[{"message":{"content":"done"}}]}'],
    };
  });

  const result = await openai.complete(
    [{ role: "system", content: "Be concise" }],
    {
      openaiCompatible: {
        baseUrl: "http://mock.test/compatible/",
        apiKey: "nested-key",
      },
      model: "model-a",
      temperature: 0.2,
      maxTokens: 50,
      user: "telemetry-user",
    },
  );

  assert.deepEqual(result, {
    statusCode: 201,
    text: '{"choices":[{"message":{"content":"done"}}]}',
  });
  assert.equal(captured.options.path, "/compatible/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer nested-key");
  assert.equal(captured.req.timeoutMs, 60_000);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.user, "telemetry-user");
});

test("streamChat retries once when the first SSE response is empty", async (t) => {
  let requests = 0;
  installMockServer(t, async () => {
    requests += 1;
    return requests === 1
      ? { chunks: ["data: [DONE]\n\n"] }
      : { chunks: ['data: {"choices":[{"delta":{"content":"retry ok"}}]}\n\ndata: [DONE]\n\n'] };
  });
  const originalWarn = console.warn;
  const originalLog = console.log;
  t.after(() => {
    console.warn = originalWarn;
    console.log = originalLog;
  });
  console.warn = () => {};
  console.log = () => {};

  const chunks = await collect(openai.streamChat([], {
    baseUrl: "http://mock.test",
    apiKey: "key",
    model: "model",
  }));

  assert.deepEqual(chunks, ["retry ok"]);
  assert.equal(requests, 2);
});

test("streamChat aborts an in-flight SSE request without retrying", async (t) => {
  let requests = 0;
  let responseStarted;
  const started = new Promise((resolve) => { responseStarted = resolve; });
  installMockServer(t, async () => {
    requests += 1;
    return { pending: true, onStarted: responseStarted };
  });
  const controller = new AbortController();
  const result = collect(openai.streamChat([], {
    baseUrl: "http://mock.test",
    apiKey: "key",
    model: "model",
    signal: controller.signal,
  }));

  await started;
  controller.abort();

  await assert.rejects(result, /LLM request aborted|aborted/i);
  assert.equal(requests, 1);
});
