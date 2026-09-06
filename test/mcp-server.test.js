const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildJoinBody, callApi, createToolHandlers, deriveWsUrl, formatStartupError } = require("../src/mcp/server");
const { resetStartupForTest } = require("../src/settings/bootstrap");

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

test("formatStartupError scrubs the message, keeps the code, and omits the stack", () => {
  const secret = "key" + "_" + "abc12";
  const error = new Error(`api_key=${secret}`);
  error.code = "E_START";
  error.stack = `STACK_ONLY ${secret}`;

  const output = formatStartupError(error);

  assert.equal(output, "api_key=[REDACTED] (E_START)");
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("STACK_ONLY"), false);
});

test("buildJoinBody uses the REST form field names", () => {
  const body = new URLSearchParams(buildJoinBody({ meetingUrl: "https://meet.example/a", wsUrl: "ws://example.test", briefing: "", auth: "" }));
  assert.equal(body.get("meetingUrl"), "https://meet.example/a");
  assert.equal(body.get("wsUrl"), "ws://example.test");
  assert.equal(body.get("conversationMode"), "one_to_one");
  assert.equal(body.has("briefing"), false);
  assert.equal(body.has("joinToken"), false);
  const full = new URLSearchParams(buildJoinBody({ meetingUrl: "m", wsUrl: "w", briefing: "brief", conversationMode: "group", auth: "shared-join" }));
  assert.equal(full.get("conversationMode"), "group");
  assert.equal(full.get("briefing"), "brief");
  assert.equal(full.get("joinToken"), "shared-join");
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

    const unsecured = createToolHandlers({ base, auth: "" }); // hermetic: ignore any ambient JOIN_SHARED_TOKEN (#215 r2)
    const unsecuredResponse = JSON.parse((await unsecured.joinMeeting({ meetingUrl: "https://meet.example/b" })).content[0].text);
    assert.equal(unsecuredResponse.header, undefined);
    assert.equal(new URLSearchParams(unsecuredResponse.body).has("joinToken"), false);
  });
});

for (const { title, launchToken, sharedToken, seed, expected } of [
  { title: "uses the launch shared token by default", sharedToken: "shared-join", expected: "shared-join" },
  { title: "prefers the explicit MCP environment token", launchToken: "mcp-join-value", sharedToken: "shared-join", expected: "mcp-join-value" },
  { title: "omits credentials when neither token is set" },
  { title: "uses the resolved-home shared token seed", seed: "JOIN_SHARED_TOKEN=seed-join-value\n", expected: "seed-join-value" },
]) {
  test(`#215 ${title}`, async (t) => {
    const names = ["AI_MEET_HOME", "AI_MEET_JOIN_TOKEN", "JOIN_SHARED_TOKEN"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-mcp-215-"));
    resetStartupForTest();
    try {
      for (const name of names) delete process.env[name];
      process.env.AI_MEET_HOME = home;
      if (launchToken !== undefined) process.env.AI_MEET_JOIN_TOKEN = launchToken;
      if (sharedToken !== undefined) process.env.JOIN_SHARED_TOKEN = sharedToken;
      if (seed) fs.writeFileSync(path.join(home, ".env"), seed);

      const requests = [];
      t.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({ url, ...options });
        return new Response("{}", { status: 200 });
      });
      const base = "http://127.0.0.1:5005";
      const handlers = createToolHandlers({ base });
      const result = await handlers.joinMeeting({ meetingUrl: "https://meet.example/a" });
      assert.equal(result.isError, undefined);
      assert.equal(requests.length, 2);
      const request = requests[1];
      assert.equal(request.url, `${base}/join-meeting`);
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-join-token"], expected);
      const body = new URLSearchParams(request.body);
      assert.equal(body.has("joinToken"), expected !== undefined);
      if (expected !== undefined) assert.equal(body.get("joinToken"), expected);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      resetStartupForTest();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

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

test("callApi aborts with a timeout error when the server never responds", async () => {
  await withServer((_request, _response) => { /* never respond */ }, async (base) => {
    await assert.rejects(
      callApi({ method: "GET", path: "/slow", base, timeoutMs: 100 }),
      /timed out after 100ms/,
    );
  });
});

test("handlers surface unreachable servers as isError results with the base URL", async () => {
  const handlers = createToolHandlers({ base: "http://127.0.0.1:9" });
  const result = await handlers.health();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cannot reach Meetmate at http:\/\/127\.0\.0\.1:9/);
});

test("leaveMeeting sends the sessionId only when provided", async () => {
  const seen = [];
  await withServer(async (request, response) => {
    seen.push(await readBody(request));
    response.end("ok");
  }, async (base) => {
    const handlers = createToolHandlers({ base, auth: "" });
    await handlers.leaveMeeting({ sessionId: "session-abc" });
    await handlers.leaveMeeting();
    assert.deepEqual(seen, ["sessionId=session-abc", ""]);
  });
});


test("#230 leaveMeeting forwards the join credential header", async () => {
  const seen = [];
  const credential = "test-leave-value";
  await withServer(async (request, response) => {
    seen.push({ token: request.headers["x-join-token"], body: await readBody(request) });
    response.end("ok");
  }, async (base) => {
    for (const auth of [credential, ""]) {
      const result = await createToolHandlers({ base, auth }).leaveMeeting({ sessionId: "session-abc" });
      assert.equal(result.isError, undefined);
    }
    assert.deepEqual(seen, [
      { token: credential, body: "sessionId=session-abc" },
      { token: undefined, body: "sessionId=session-abc" },
    ]);
  });
});
