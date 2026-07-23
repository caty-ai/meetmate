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
  assert.equal(captured.options.headers["X-Caty-Agent-Trust"], undefined);
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
  assert.equal(captured.options.headers["X-Caty-Agent-Trust"], undefined);
});

test("trustedAgentTools adds the trusted gateway header only when explicitly enabled", async (t) => {
  const captured = [];
  installMockServer(t, async (request) => {
    captured.push(request);
    return {
      chunks: ['{"choices":[{"message":{"content":"done"}}]}'],
    };
  });

  await openai.complete([], {
    baseUrl: "http://mock.test",
    apiKey: "key",
    model: "model",
    trustedAgentTools: true,
  });

  assert.equal(captured[0].options.headers["X-Caty-Agent-Trust"], "trusted");
});

test("completion paths add exactly one v1 segment", async (t) => {
  const paths = [];
  installMockServer(t, async ({ options }) => {
    paths.push(options.path);
    return { chunks: ["{}"] };
  });

  for (const baseUrl of [
    "http://mock.test",
    "http://mock.test/v1",
    "http://mock.test/openai/v1",
  ]) {
    await openai.complete([], { baseUrl, apiKey: "key", model: "model" });
  }

  assert.deepEqual(paths, [
    "/v1/chat/completions",
    "/v1/chat/completions",
    "/openai/v1/chat/completions",
  ]);
});

test("streamChat accepts SSE data fields without a trailing space", async (t) => {
  installMockServer(t, async () => ({
    chunks: [
      'data:{"choices":[{"delta":{"content":"first"}}]}\n\n',
      'data:{"choices":[{"delta":{"content":" trailing"}}]}',
    ],
  }));

  const chunks = await collect(openai.streamChat([], {
    baseUrl: "http://mock.test",
    apiKey: "key",
    model: "model",
  }));

  assert.deepEqual(chunks, ["first", " trailing"]);
});

test("complete requires OpenAI-compatible credentials", () => {
  assert.throws(
    () => openai.complete([], { model: "model" }),
    /base URL and API key are required/,
  );
});

test("pre-aborted signals short-circuit before any OpenAI-compatible request", async (t) => {
  const originalRequest = http.request;
  let requests = 0;
  http.request = () => {
    requests += 1;
    throw new Error("request should not be created");
  };
  t.after(() => { http.request = originalRequest; });
  const controller = new AbortController();
  controller.abort();
  const options = {
    baseUrl: "http://mock.test",
    apiKey: "key",
    model: "model",
    signal: controller.signal,
  };

  await assert.rejects(collect(openai.streamChat([], options)), /LLM request aborted/);
  assert.throws(() => openai.complete([], options), /LLM request aborted/);
  assert.equal(requests, 0);
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

test("streamChat can disable empty-response retry for stateful gateways", async (t) => {
  let requests = 0;
  installMockServer(t, async () => {
    requests += 1;
    return { chunks: ["data: [DONE]\n\n"] };
  });

  const chunks = await collect(openai.streamChat([], {
    baseUrl: "http://mock.test",
    apiKey: "key",
    model: "model",
    emptyResponseRetry: false,
  }));

  assert.deepEqual(chunks, []);
  assert.equal(requests, 1);
});

test("streamChat fails loudly on invalid SSE JSON without retrying", async (t) => {
  let requests = 0;
  installMockServer(t, async () => {
    requests += 1;
    return { chunks: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[oops]}\n\n'] };
  });

  await assert.rejects(
    collect(openai.streamChat([], {
      baseUrl: "http://mock.test",
      apiKey: "key",
      model: "model",
    })),
    /OpenAI-compatible SSE invalid JSON/
  );
  assert.equal(requests, 1);
});

test("streamChat fails loudly on SSE error events without retrying", async (t) => {
  let requests = 0;
  installMockServer(t, async () => {
    requests += 1;
    return { chunks: ['event: error\ndata: {"error":{"message":"gateway backend failed"}}\n\n'] };
  });

  await assert.rejects(
    collect(openai.streamChat([], {
      baseUrl: "http://mock.test",
      apiKey: "key",
      model: "model",
    })),
    /gateway backend failed/
  );
  assert.equal(requests, 1);
});

test("streamChat fails loudly on SSE error payloads without an event header", async (t) => {
  let requests = 0;
  installMockServer(t, async () => {
    requests += 1;
    return { chunks: ['data: {"error":{"message":"inline backend failed"}}\n\n'] };
  });

  await assert.rejects(
    collect(openai.streamChat([], {
      baseUrl: "http://mock.test",
      apiKey: "key",
      model: "model",
    })),
    /inline backend failed/
  );
  assert.equal(requests, 1);
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
