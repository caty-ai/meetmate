"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { runLiveBackend, backendUnavailable, conversationInstructions } = require("../src/live-openai/live-backend");
const { EMOTION_TAGS } = require("../src/messages");

test("configured Hermes route receives model, session and trust; first sentence precedes completion", { timeout: 5000 }, async t => {
  let finish, requestBody, requestHeaders, requestPath;
  const server = http.createServer((req, res) => {
    requestHeaders = req.headers; requestPath = req.url;
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = text => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      send("最初の"); send("答えをお伝えします。");
      finish = () => { send("続きです。"); res.end("data: [DONE]\n\n"); };
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { llm: { provider: "openai-compatible", model: "hermes-caty-test", openaiCompatible: {
    baseUrl: `http://127.0.0.1:${server.address().port}/hermes/v1`, apiKey: "test-key",
    trustedAgentTools: true, sessionHeader: "X-Hermes-Session", streamingEquivalentEnabled: true,
  } } };
  const results = [];
  const controller = new AbortController(); t.after(() => controller.abort());
  await runLiveBackend(config, [{ role: "user", content: "覚えている？" }], "isolated-test-session", controller.signal, text => {
    results.push(text);
    if (results.length === 1) {
      assert.equal(text, "最初の答えをお伝えします。");
      assert.ok(finish); finish();
    }
  });
  assert.deepEqual(results, ["最初の答えをお伝えします。", "続きです。"]);
  assert.equal(requestPath, "/hermes/v1/chat/completions");
  assert.equal(requestHeaders.authorization, "Bearer test-key");
  assert.equal(requestHeaders["x-hermes-session"], "isolated-test-session");
  assert.equal(requestHeaders["x-caty-agent-trust"], "trusted");
  assert.equal(requestBody.model, "hermes-caty-test");
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.user, "isolated-test-session");
  assert.deepEqual(requestBody.messages.slice(1), [{ role: "user", content: "覚えている？" }]);
});

test("empty results fail visibly and cancellation suppresses speech", async () => {
  const cfg = { llm: { provider: "openclaw" } };
  const c = new AbortController(), results = [];
  await assert.rejects(runLiveBackend(cfg, [], "test", c.signal, t => results.push(t), async function* () {}), /no speech/);
  await runLiveBackend(cfg, [], "test", c.signal, t => results.push(t), async function* () {
    yield "未完"; c.abort(); yield "送らない。";
  });
  assert.deepEqual(results, []);
});

test("backend prerequisites distinguish configured routes", () => {
  assert.match(backendUnavailable({ llm: { provider: "openai-compatible" } }), /OpenAI-compatible/);
  assert.equal(backendUnavailable({ llm: { provider: "openai-compatible", openaiCompatible: { baseUrl: "http://test", apiKey: "key" } } }), null);
  assert.match(backendUnavailable({ llm: { provider: "openclaw" } }), /OpenClaw/);
});

test("Live prompt removes pipeline control-tag instructions and defines backend ownership", () => {
  const instructions = conversationInstructions({ llm: { systemPrompt: `あなたはキャティ。\n必ず感情タグ ${EMOTION_TAGS[0].tag} を付ける\n相手の話をしっかり聞いてから応答する` } });
  assert.match(instructions, /あなたはキャティ/);
  assert.match(instructions, /Delegate to the backend when/);
  assert.doesNotMatch(instructions, /必ず感情タグ|相手の話をしっかり/);
  for (const { tag } of EMOTION_TAGS) assert.ok(!instructions.includes(tag));
});
