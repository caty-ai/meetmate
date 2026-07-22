const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const openclaw = require("../src/llm-openclaw");

const expectedBodies = {
  warmup: '{"model":"agent","stream":false,"temperature":0.3,"max_tokens":200,"messages":[{"role":"system","content":"Briefing system"},{"role":"user","content":"Project briefing"}],"user":"meet-session-caty"}',
  handoff: '{"model":"agent","stream":false,"temperature":0.2,"max_tokens":700,"messages":[{"role":"system","content":"Delegate the request"},{"role":"user","content":"Investigate the outage"}],"user":"meet-session-caty-delegate"}',
  slackHandoff: '{"model":"agent","stream":false,"temperature":0.2,"max_tokens":700,"messages":[{"role":"system","content":"Delegate to Slack"},{"role":"user","content":"Investigate the outage"}],"user":"meet-session-caty"}',
  summarizer: '{"model":"agent","stream":false,"temperature":0.3,"max_tokens":500,"messages":[{"role":"user","content":"Summarize this conversation"}]}',
  indexLcm: '{"model":"openclaw","stream":false,"temperature":0.3,"max_tokens":1,"messages":[{"role":"user","content":"Question"},{"role":"assistant","content":"Answer"},{"role":"user","content":"[[[lcm:ingest]]] セッション終了。この会話を長期記憶に保存してください。"}],"user":"meet-index-session-caty"}',
  meetLcm: '{"model":"openclaw","stream":false,"temperature":0.3,"max_tokens":1,"messages":[{"role":"user","content":"Question"},{"role":"assistant","content":"Answer"},{"role":"user","content":"[[[lcm:ingest]]] セッション終了。この会話を長期記憶に保存してください。"}],"user":"meet-route-session-caty"}',
};

test("non-stream OpenClaw calls preserve all six request bodies and base paths", async (t) => {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      captured.push({ path: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    });
  });
  let openclawUrl;
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    openclawUrl = `http://127.0.0.1:${server.address().port}/gateway/`;
  } catch (err) {
    if (err.code !== "EPERM") throw err;
    const originalRequest = http.request;
    http.request = createWireCaptureRequest(captured);
    t.after(() => { http.request = originalRequest; });
    openclawUrl = "http://gateway.test/gateway/";
  }

  const common = {
    openclawUrl,
    openclawToken: "secret",
  };

  await openclaw.complete(
    [
      { role: "system", content: "Briefing system" },
      { role: "user", content: "Project briefing" },
    ],
    { ...common, model: "agent", temperature: 0.3, maxTokens: 200, user: "meet-session-caty", timeoutMs: 8_000 },
  );

  await openclaw.timeoutHandoff({
    ...common,
    model: "agent",
    systemPrompt: "Delegate the request",
    userPrompt: "Investigate the outage",
    sessionUser: "meet-session-caty-delegate",
    gatewayModeHandoff: true,
  });

  await openclaw.timeoutHandoff({
    ...common,
    model: "agent",
    systemPrompt: "Delegate to Slack",
    userPrompt: "Investigate the outage",
    sessionUser: "meet-session-caty",
    gatewayModeHandoff: false,
  });

  await openclaw.complete(
    [{ role: "user", content: "Summarize this conversation" }],
    { ...common, model: "agent", temperature: 0.3, maxTokens: 500, timeoutMs: 30_000, timeoutError: "Summarizer timeout" },
  );

  const ingestMessages = [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "[[[lcm:ingest]]] セッション終了。この会話を長期記憶に保存してください。" },
  ];
  await openclaw.complete(ingestMessages, {
    ...common,
    model: "openclaw",
    temperature: 0.3,
    maxTokens: 1,
    user: "meet-index-session-caty",
  });
  await openclaw.complete(ingestMessages, {
    ...common,
    model: "openclaw",
    temperature: 0.3,
    maxTokens: 1,
    user: "meet-route-session-caty",
  });

  assert.deepEqual(captured.map(({ path }) => path), Array(6).fill("/gateway/v1/chat/completions"));
  assert.deepEqual(captured.map(({ body }) => body), Object.values(expectedBodies));
  for (const [index, expected] of Object.values(expectedBodies).entries()) {
    assert.deepEqual(JSON.parse(captured[index].body), JSON.parse(expected));
  }
  assert.equal(Object.hasOwn(JSON.parse(captured[3].body), "user"), false);
});

test("timeout handoff preserves gateway and non-gateway failure outcomes", async () => {
  const originalRequest = http.request;
  const warnings = [];
  const errors = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => warnings.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  try {
    http.request = createFakeRequest("client-timeout");
    assert.equal(await openclaw.timeoutHandoff({
      openclawUrl: "http://gateway.test",
      openclawToken: "secret",
      model: "agent",
      systemPrompt: "system",
      userPrompt: "user",
      sessionUser: "session",
      gatewayModeHandoff: false,
    }), false);
    assert.equal(warnings.some((line) => line.includes("treating as dispatched (unconfirmed)")), false);
    assert.equal(errors.some((line) => line.includes("Timeout handoff request error: Timeout handoff request timeout")), true);

    http.request = createFakeRequest("client-timeout");
    let dispatchedSynchronously = false;
    const gatewayPromise = openclaw.timeoutHandoff({
      openclawUrl: "http://gateway.test",
      openclawToken: "secret",
      model: "agent",
      systemPrompt: "system",
      userPrompt: "user",
      sessionUser: "session-delegate",
      gatewayModeHandoff: true,
      onDispatched: () => { dispatchedSynchronously = true; },
    });
    assert.equal(dispatchedSynchronously, true);
    assert.equal(await gatewayPromise, true);
    assert.equal(warnings.some((line) => line.includes("client timeout")), true);

    http.request = createFakeRequest("network-error");
    assert.equal(await openclaw.timeoutHandoff({
      openclawUrl: "http://gateway.test",
      openclawToken: "secret",
      model: "agent",
      systemPrompt: "system",
      userPrompt: "user",
      sessionUser: "session",
      gatewayModeHandoff: false,
    }), false);
    assert.equal(errors.some((line) => line.includes("Timeout handoff request error: network down")), true);
  } finally {
    http.request = originalRequest;
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test("timeout handoff setup failures throw synchronously to the caller", () => {
  let reachedSpawnedLog = false;

  assert.throws(() => {
    openclaw.timeoutHandoff({ openclawUrl: "not a valid url ://" });
    reachedSpawnedLog = true;
  }, /Invalid URL/);
  assert.equal(reachedSpawnedLog, false);
});

test("complete preserves the summarizer timeout message and omits LCM socket timeouts", async () => {
  const originalRequest = http.request;

  try {
    let timeoutCalls = 0;
    http.request = (_options, _callback) => {
      const req = new EventEmitter();
      let timeoutCallback;
      req.write = () => {};
      req.end = () => process.nextTick(() => timeoutCallback());
      req.setTimeout = (_ms, cb) => {
        timeoutCalls += 1;
        timeoutCallback = cb;
        return req;
      };
      req.destroy = (err) => process.nextTick(() => req.emit("error", err));
      return req;
    };

    await assert.rejects(openclaw.complete([], {
      openclawUrl: "http://gateway.test",
      openclawToken: "secret",
      model: "agent",
      temperature: 0.3,
      maxTokens: 500,
      timeoutMs: 30_000,
      timeoutError: "Summarizer timeout",
    }), { message: "Summarizer timeout" });
    assert.equal(timeoutCalls, 1);

    http.request = createFakeRequest("success");
    const lcm = await openclaw.complete([], {
      openclawUrl: "http://gateway.test",
      openclawToken: "secret",
      model: "openclaw",
      temperature: 0.3,
      maxTokens: 1,
      user: "meet-session-caty",
    });
    assert.equal(lcm.statusCode, 200);
  } finally {
    http.request = originalRequest;
  }
});

test("streaming OpenClaw calls preserve a gateway path prefix", async () => {
  const originalRequest = http.request;
  let requestPath;
  try {
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = () => req;
      req.destroy = (err) => process.nextTick(() => req.emit("error", err));
      req.end = () => process.nextTick(() => {
        requestPath = options.path;
        const res = new PassThrough();
        res.statusCode = 200;
        callback(res);
        res.end("data: [DONE]\n\n");
      });
      return req;
    };
    const streamAuth = (openclawUrl, openclawToken) => ({ openclawUrl, openclawToken });
    for await (const _chunk of openclaw.streamChat([], streamAuth("http://gateway.test/gw", "secret"))) { /* consume stream */ }
    assert.equal(requestPath, "/gw/v1/chat/completions");

    for await (const _chunk of openclaw.streamChat([], streamAuth("http://gateway.test", "secret"))) { /* consume stream */ }
    assert.equal(requestPath, "/v1/chat/completions");
  } finally {
    http.request = originalRequest;
  }
});

function createFakeRequest(mode) {
  return (_options, callback) => {
    const req = new EventEmitter();
    let timeoutCallback;
    req.write = () => {};
    req.setTimeout = (_ms, cb) => {
      timeoutCallback = cb;
      return req;
    };
    req.destroy = (err) => {
      if (err) process.nextTick(() => req.emit("error", err));
    };
    req.end = () => {
      if (mode === "client-timeout") {
        process.nextTick(() => timeoutCallback());
        return;
      }
      if (mode === "network-error") {
        process.nextTick(() => req.emit("error", new Error("network down")));
        return;
      }
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        callback(res);
        res.emit("end");
      });
    };
    return req;
  };
}

function createWireCaptureRequest(captured) {
  return (options, callback) => {
    const req = new EventEmitter();
    let body = "";
    req.write = (chunk) => { body += String(chunk); };
    req.setTimeout = () => req;
    req.end = () => {
      captured.push({ path: options.path, body });
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        callback(res);
        res.emit("data", Buffer.from('{"choices":[{"message":{"content":"ok"}}]}'));
        res.emit("end");
      });
    };
    return req;
  };
}
