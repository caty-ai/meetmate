const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { buildJoinBody, callApi, createToolHandlers, deriveWsUrl } = require("../src/mcp/server");

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
  });
}

test("deriveWsUrl prefers publicWsUrl and otherwise derives the base host", () => {
  assert.equal(deriveWsUrl("http://example.test:5005/", { publicWsUrl: "wss://public.example/ws" }), "wss://public.example/ws");
  assert.equal(deriveWsUrl("http://example.test:5005/", {}), "ws://example.test:5005");
  assert.equal(deriveWsUrl("https://example.test:8443/api", null), "wss://example.test:8443");
});

test("buildJoinBody uses the REST form field names", () => {
  const body = new URLSearchParams(buildJoinBody({ meetingUrl: "https://meet.example/a", wsUrl: "ws://example.test", briefing: "", auth: "" }));
  assert.equal(body.get("meetingUrl"), "https://meet.example/a");
  assert.equal(body.get("wsUrl"), "ws://example.test");
  assert.equal(body.get("conversationMode"), "one_to_one");
  assert.equal(body.has("briefing"), false);
  assert.equal(body.has("joinToken"), false);
  const full = new URLSearchParams(buildJoinBody({ meetingUrl: "m", wsUrl: "w", briefing: "brief", conversationMode: "group", auth: "shared-join-value" }));
  assert.equal(full.get("conversationMode"), "group");
  assert.equal(full.get("briefing"), "brief");
  assert.equal(full.get("joinToken"), "shared-join-value");
  assert.deepEqual([...full.keys()], ["meetingUrl", "wsUrl", "conversationMode", "briefing", "joinToken"]);
});

test("join handler forwards configured tokens in header and form body only", async () => {
  await withServer(async (request, response) => {
    if (request.url === "/info") return response.end(JSON.stringify({ publicWsUrl: "" }));
    const body = await readBody(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ header: request.headers["x-join-token"], body }));
  }, async (base) => {
    const secured = createToolHandlers({ base, auth: "test-join-value-123" });
    const securedResponse = JSON.parse((await secured.joinMeeting({ meetingUrl: "https://meet.example/a" })).content[0].text);
    assert.equal(securedResponse.header, "test-join-value-123");
    assert.equal(new URLSearchParams(securedResponse.body).get("joinToken"), "test-join-value-123");

    const unsecured = createToolHandlers({ base });
    const unsecuredResponse = JSON.parse((await unsecured.joinMeeting({ meetingUrl: "https://meet.example/b" })).content[0].text);
    assert.equal(unsecuredResponse.header, undefined);
    assert.equal(new URLSearchParams(unsecuredResponse.body).has("joinToken"), false);
  });
});

test("handlers expose API failures and pass through active session and health responses", async () => {
  await withServer((request, response) => {
    if (request.url === "/join-meeting") {
      response.statusCode = 422;
      return response.end("meeting rejected");
    }
    if (request.url === "/info") return response.end("{}");
    if (request.url === "/active-session") return response.end('{"active":true,"sessions":["a"]}');
    response.end("healthy");
  }, async (base) => {
    const handlers = createToolHandlers({ base });
    const join = await handlers.joinMeeting({ meetingUrl: "https://meet.example/a" });
    assert.equal(join.isError, true);
    assert.match(join.content[0].text, /422.*meeting rejected/);
    assert.equal((await handlers.getActiveSession()).content[0].text, '{"active":true,"sessions":["a"]}');
    assert.equal((await handlers.health()).content[0].text, "Status 200: healthy");
  });
});

test("callApi returns HTTP status and response text", async () => {
  await withServer((_request, response) => response.end("ok"), async (base) => {
    assert.deepEqual(await callApi({ method: "GET", path: "/anything", base }), { ok: true, status: 200, text: "ok" });
  });
});
