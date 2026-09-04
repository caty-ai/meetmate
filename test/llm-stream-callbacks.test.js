"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const API_TOKEN = ["se", "cret"].join("");

function createRequestStub(chunks, statusCode = 200) {
  return (_options, callback) => {
    const req = new EventEmitter();
    let response;
    req.write = () => {};
    req.setTimeout = () => req;
    req.destroy = (err) => process.nextTick(() => {
      response?.destroy(err);
      req.emit("error", err);
    });
    req.end = () => process.nextTick(() => {
      response = new PassThrough();
      response.statusCode = statusCode;
      callback(response);
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    return req;
  };
}

function loadWithRequestStub(modulePath, requestImpl) {
  const resolved = require.resolve(modulePath);
  const originalLoad = Module._load;
  const http = require("node:http");
  const https = require("node:https");
  const stubbedHttp = { ...http, request: requestImpl };
  const stubbedHttps = { ...https, request: requestImpl };

  delete require.cache[resolved];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "http" || request === "node:http") return stubbedHttp;
    if (request === "https" || request === "node:https") return stubbedHttps;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

async function collectWithOrder(source, order) {
  const chunks = [];
  for await (const chunk of source) {
    order.push(`chunk:${chunk}`);
    chunks.push(chunk);
  }
  return chunks;
}

test("streaming providers fire response-start and first-event callbacks once before the first yielded chunk", async (t) => {
  const sseChunks = [
    'data: {"choices":[{"delta":{}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"こんにちは"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const providers = [
    {
      name: "OpenClaw",
      modulePath: "../src/llm-openclaw",
      stream(module, callbacks = {}) {
        return module.streamChat(
          [{ role: "user", content: "挨拶して" }],
          {
            openclawUrl: "http://gateway.test",
            openclawToken: API_TOKEN,
            model: "agent",
            openclawSystemAddendum: "",
            ...callbacks,
          },
        );
      },
    },
    {
      name: "OpenAI-compatible",
      modulePath: "../src/llm-openai",
      stream(module, callbacks = {}) {
        return module.streamChat(
          [{ role: "user", content: "挨拶して" }],
            {
              baseUrl: "http://gateway.test",
            apiKey: API_TOKEN,
            model: "agent",
            ...callbacks,
          },
        );
      },
    },
  ];

  for (const provider of providers) {
    await t.test(`${provider.name} callbacks fire before content`, async () => {
      const module = loadWithRequestStub(provider.modulePath, createRequestStub(sseChunks));
      const order = [];
      const responseStarts = [];
      let firstEventCalls = 0;
      const chunks = await collectWithOrder(provider.stream(module, {
        onResponseStart(payload) {
          responseStarts.push(payload);
          order.push(`response:${payload.statusCode}`);
        },
        onFirstEvent() {
          firstEventCalls += 1;
          order.push("firstEvent");
        },
      }), order);

      assert.deepEqual(responseStarts, [{ statusCode: 200 }]);
      assert.equal(firstEventCalls, 1);
      assert.deepEqual(chunks, ["こんにちは"]);
      assert.deepEqual(order, ["response:200", "firstEvent", "chunk:こんにちは"]);
    });

    await t.test(`${provider.name} callbacks stay optional`, async () => {
      const module = loadWithRequestStub(provider.modulePath, createRequestStub(sseChunks));
      const chunks = [];
      for await (const chunk of provider.stream(module)) chunks.push(chunk);
      assert.deepEqual(chunks, ["こんにちは"]);
    });

    await t.test(`${provider.name} ignores callback exceptions`, async () => {
      const module = loadWithRequestStub(provider.modulePath, createRequestStub(sseChunks));
      const chunks = [];
      for await (const chunk of provider.stream(module, {
        onResponseStart() { throw new Error("response callback failure"); },
        onFirstEvent() { throw new Error("event callback failure"); },
      })) {
        chunks.push(chunk);
      }
      assert.deepEqual(chunks, ["こんにちは"]);
    });
  }
});

test("OpenAI-compatible non-streaming wrapper fires the same callbacks at response start and first body event", async () => {
  const openai = loadWithRequestStub(
    "../src/llm-openai",
    createRequestStub(['{"choices":[{"message":{"content":"complete reply"}}]}']),
  );
  const order = [];
  const responseStarts = [];
  let firstEventCalls = 0;
  const chunks = await collectWithOrder(openai.streamChat(
    [{ role: "user", content: "hello" }],
    {
      baseUrl: "http://gateway.test",
      apiKey: API_TOKEN,
      model: "agent",
      streamingEquivalentEnabled: false,
      onResponseStart(payload) {
        responseStarts.push(payload);
        order.push(`response:${payload.statusCode}`);
      },
      onFirstEvent() {
        firstEventCalls += 1;
        order.push("firstEvent");
      },
    },
  ), order);

  assert.deepEqual(responseStarts, [{ statusCode: 200 }]);
  assert.equal(firstEventCalls, 1);
  assert.deepEqual(chunks, ["complete reply"]);
  assert.deepEqual(order, ["response:200", "firstEvent", "chunk:complete reply"]);
});
