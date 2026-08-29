"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { stringify } = require("node:querystring");
const test = require("node:test");

const resolver = require("../src/settings/resolver");
const readiness = require("../src/settings/readiness");

const routesPath = require.resolve("../src/transport-meet/meet-routes");

function unavailableNgrokHttpGet() {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  queueMicrotask(() => request.emit("error", Object.assign(new Error("ngrok unavailable in test"), { code: "ECONNREFUSED" })));
  return request;
}

async function unavailableFetch() {
  throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" });
}

async function unavailableRequest() {
  throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" });
}

function availableNgrokHttpGet(publicUrl) {
  return (_url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter();
      callback(response);
      response.emit("data", JSON.stringify({ tunnels: [{ proto: "https", public_url: publicUrl }] }));
      response.emit("end");
    });
    return request;
  };
}

function initialize(options = {}) {
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      revision: "a".repeat(64),
      fingerprint: "a".repeat(64),
      parsed: {
        agent: { id: "caty", name: "Caty", displayName: "Caty", wakeWords: ["ケイティ"] },
        llm: { provider: "openclaw", model: "main" },
        stt: { provider: "soniox", sonioxApiKey: "soniox-secret" },
        tts: { provider: "fish-audio", apiKey: "fish-secret", voiceId: "voice-id" },
        attendee: { apiKey: "attendee-secret", baseUrl: "app.attendee.dev" },
        server: options.ngrokDomain === null ? {} : { ngrokDomain: options.ngrokDomain || "meetmate.example" },
        slack: { notifications: { enabled: false } },
      },
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({ ...(options.preDotenvEnv || {}) }),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: "/tmp/meetmate-readiness-routes",
      configPath: "/tmp/meetmate-readiness-routes/config.json",
      connection: Object.freeze({
        openclawUrl: "https://gateway.example",
        openclawToken: "gateway-secret",
        openaiApiKey: "",
      }),
    }),
    serverPort: options.serverPort || 5005,
  });
}

function request(method, url, form = null, address = "203.0.113.8", headers = {}) {
  const body = form ? Buffer.from(stringify(form)) : Buffer.alloc(0);
  const req = Readable.from(body.length ? [body] : []);
  Object.assign(req, {
    method,
    url,
    headers: { host: "meetmate.example", "content-type": "application/x-www-form-urlencoded", ...headers },
    socket: { remoteAddress: address, localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

async function invoke(routes, method, url, form, address, headers) {
  const output = { status: 0, headers: {}, text: "" };
  const res = {
    writeHead(status, headers = {}) { output.status = status; output.headers = headers; },
    end(chunk = "") { output.text += String(chunk); },
  };
  await routes.handleHttp(request(method, url, form, address, headers), res);
  try { output.body = JSON.parse(output.text); } catch { output.body = null; }
  return output;
}

async function withCountingReadinessRoutes(options, run) {
  initialize();
  readiness.reset();
  let clock = 1_000_000;
  const fetchCalls = [];
  let requestCalls = 0;
  const fetchFn = async (url) => {
    const value = String(url);
    fetchCalls.push(value);
    const status = options.failSoniox && value.includes("api.soniox.com") ? 401 : 200;
    return new Response('{"instanceId":"this-boot"}', {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const requestFn = async () => {
    requestCalls += 1;
    return { statusCode: 200, body: '{"choices":[]}' };
  };
  readiness.configure({
    now: () => clock,
    probeOptions: { fetchFn, requestFn },
  });

  const billing = ["fish-audio", "llm"];
  const nonBilling = ["soniox", "attendee", "tunnel"];
  for (const system of [...billing, ...(options.allStale ? nonBilling : [])]) {
    readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  }
  if (options.billingStale || options.allStale) clock += readiness._test.SUCCESS_TTL_MS + 1;
  if (!options.allStale) {
    for (const system of nonBilling) readiness.setProbeObservation(system, { ok: false, code: "UNREACHABLE" });
  }

  const previousJoinToken = process.env.JOIN_SHARED_TOKEN;
  process.env.JOIN_SHARED_TOKEN = "join-ok";
  delete require.cache[routesPath];
  const routes = require(routesPath);
  await routes.init({
    detectNgrok: false,
    loadAvatar: false,
    instanceId: "this-boot",
    readinessProbeOptions: { fetchFn, requestFn, httpGet: unavailableNgrokHttpGet },
  });
  try {
    await run({ routes, fetchCalls, requestCalls: () => requestCalls });
  } finally {
    delete require.cache[routesPath];
    if (previousJoinToken === undefined) delete process.env.JOIN_SHARED_TOKEN;
    else process.env["JOIN_SHARED_TOKEN"] = previousJoinToken;
    readiness.reset();
    resolver.resetRuntimeForTest();
  }
}

function assertOnlyNonBillingProbes(fetchCalls, requestCalls) {
  assert.equal(fetchCalls.some((value) => value.includes("api.soniox.com")), true, "Soniox proves non-billing work ran");
  assert.equal(fetchCalls.some((value) => value.includes("app.attendee.dev")), true, "Attendee proves non-billing work ran");
  assert.equal(fetchCalls.some((value) => value.includes("meetmate.example/health")), true, "Tunnel proves non-billing work ran");
  assert.deepEqual({
    fishFetches: fetchCalls.filter((value) => value.includes("api.fish.audio")).length,
    llmRequests: requestCalls(),
  }, {
    fishFetches: 0,
    llmRequests: 0,
  }, "Fish fetchFn and LLM requestFn must remain unreachable");
}

test("public recheck cannot probe a healthy billing cache", { concurrency: false }, async () => {
  await withCountingReadinessRoutes({}, async ({ routes, fetchCalls, requestCalls }) => {
    const response = await invoke(routes, "POST", "/readiness/recheck", null, "198.51.100.21");
    assert.equal(response.status, 200);
    assertOnlyNonBillingProbes(fetchCalls, requestCalls);
  });
});

test("public recheck cannot probe a stale billing cache", { concurrency: false }, async () => {
  await withCountingReadinessRoutes({ billingStale: true }, async ({ routes, fetchCalls, requestCalls }) => {
    const response = await invoke(routes, "POST", "/readiness/recheck", null, "198.51.100.22");
    assert.equal(response.status, 200);
    assertOnlyNonBillingProbes(fetchCalls, requestCalls);
  });
});

test("join revalidation probes stale non-billing systems but never stale billing systems", { concurrency: false }, async () => {
  await withCountingReadinessRoutes({ allStale: true, failSoniox: true }, async ({ routes, fetchCalls, requestCalls }) => {
    const response = await invoke(routes, "POST", "/join-meeting", {
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      wsUrl: "wss://meetmate.example/realtime",
      conversationMode: "group",
      joinToken: "join-ok",
    }, "198.51.100.23", { "x-join-token": "join-ok" });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "MEETING_NOT_READY");
    assertOnlyNonBillingProbes(fetchCalls, requestCalls);
  });
});

test("real public route handlers never dispatch billing probes and rate-limited join judges cached blockers", { concurrency: false }, async (t) => {
  initialize({ serverPort: 6123 });
  readiness.reset();
  const fetchCalls = [];
  let requestCalls = 0;
  const fetchFn = async (url) => {
    fetchCalls.push(String(url));
    return new Response('{"instanceId":"this-boot"}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const requestFn = async () => {
    requestCalls += 1;
    return { statusCode: 200, body: '{"choices":[]}' };
  };
  readiness.configure({
    probeOptions: { fetchFn, requestFn },
  });
  readiness.reportRuntimeFailure("fish-audio", "PAYMENT_REQUIRED");
  readiness.reportRuntimeFailure("llm", "PAYMENT_REQUIRED");
  for (const system of ["soniox", "attendee", "tunnel"]) {
    readiness.setProbeObservation(system, { ok: false, code: "UNREACHABLE" });
  }

  const previousJoinToken = process.env.JOIN_SHARED_TOKEN;
  process.env.JOIN_SHARED_TOKEN = "join-secret";
  delete require.cache[routesPath];
  const routes = require(routesPath);
  await routes.init({
    detectNgrok: false,
    loadAvatar: false,
    instanceId: "this-boot",
    readinessProbeOptions: { fetchFn, requestFn, httpGet: unavailableNgrokHttpGet },
  });
  t.after(() => {
    delete require.cache[routesPath];
    if (previousJoinToken === undefined) delete process.env.JOIN_SHARED_TOKEN;
    else process.env["JOIN_SHARED_TOKEN"] = previousJoinToken;
    readiness.reset();
    resolver.resetRuntimeForTest();
  });

  const beforeGet = fetchCalls.length;
  const get = await invoke(routes, "GET", "/readiness");
  assert.equal(get.status, 200);
  assert.equal(get.body.settingsPort, 6123);
  assert.equal(fetchCalls.length, beforeGet, "GET /readiness must be a pure cache read");
  assert.equal(requestCalls, 0, "GET /readiness must not invoke the LLM request seam");
  assert.equal(get.headers["Cache-Control"], "no-store");
  for (const secret of ["soniox-secret", "fish-secret", "attendee-secret", "gateway-secret"]) {
    assert.equal(get.text.includes(secret), false);
  }

  const unauthorized = await invoke(routes, "POST", "/join-meeting", {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://meetmate.example/realtime",
  }, undefined, { "x-join-token": "wrong" });
  assert.equal(unauthorized.status, 401, "authorization must run before readiness blockers");
  const invalidUrl = await invoke(routes, "POST", "/join-meeting", {
    meetingUrl: "https://example.com/not-a-meeting",
    wsUrl: "wss://meetmate.example/realtime",
    joinToken: "join-secret",
  });
  assert.equal(invalidUrl.status, 400, "URL validation must run before readiness blockers");

  const joinRevalidation = await invoke(routes, "POST", "/join-meeting", {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://meetmate.example/realtime",
    conversationMode: "group",
    joinToken: "join-secret",
  }, "198.51.100.9");
  assert.equal(joinRevalidation.status, 503);
  assert.equal(joinRevalidation.body.error.code, "MEETING_NOT_READY");
  assert.equal(fetchCalls.some((value) => value.includes("api.soniox.com")), true);
  assert.equal(fetchCalls.some((value) => value.includes("app.attendee.dev")), true);
  assert.equal(fetchCalls.some((value) => value.includes("meetmate.example/health")), true);
  assert.equal(fetchCalls.some((value) => value.includes("api.fish.audio")), false);
  assert.equal(requestCalls, 0, "join revalidation must not invoke the LLM request seam");

  for (let index = 0; index < 3; index += 1) {
    const recheck = await invoke(routes, "POST", "/readiness/recheck");
    assert.equal(recheck.status, 200);
  }
  assert.equal(fetchCalls.some((value) => value.includes("api.fish.audio")), false);
  assert.equal(requestCalls, 0, "public recheck must not invoke the LLM request seam");

  const limited = await invoke(routes, "POST", "/readiness/recheck");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["Retry-After"]) >= 1);
  const fetchCallsBeforeJoin = fetchCalls.length;
  const requestCallsBeforeJoin = requestCalls;
  const join = await invoke(routes, "POST", "/join-meeting", {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://meetmate.example/realtime",
    conversationMode: "group",
    joinToken: "join-secret",
  });
  assert.equal(join.status, 503);
  assert.equal(join.body.error.code, "MEETING_NOT_READY");
  assert.equal(typeof join.body.error.message, "string");
  assert.ok(join.body.error.message.length > 0);
  assert.equal(join.body.error.blockers.some((blocker) => blocker.system === "fish-audio" && blocker.code === "PAYMENT_REQUIRED"), true);
  assert.equal(fetchCalls.length, fetchCallsBeforeJoin, "a rate-limited join must skip revalidation and use cache");
  assert.equal(requestCalls, requestCallsBeforeJoin);
});

test("join route enforces config-derived wsUrl identity and never fetches an outside host", { concurrency: false }, async (t) => {
  initialize({ preDotenvEnv: { PUBLIC_WSS_URL: "wss://candidate.example" } });
  readiness.reset();
  for (const system of ["soniox", "fish-audio", "attendee", "llm", "tunnel"]) {
    readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  }
  let fetched = [];
  delete require.cache[routesPath];
  const routes = require(routesPath);
  await routes.init({
    detectNgrok: false,
    loadAvatar: false,
    instanceId: "this-boot",
    readinessProbeOptions: {
      fetchFn: async (url) => {
        fetched.push(String(url));
        return new Response('{"instanceId":"other-boot"}', { status: 200, headers: { "Content-Type": "application/json" } });
      },
      requestFn: unavailableRequest,
      httpGet: () => {
        const request = new EventEmitter();
        queueMicrotask(() => request.emit("error", new Error("ngrok absent")));
        request.setTimeout = () => request;
        request.destroy = () => {};
        return request;
      },
    },
  });
  t.after(() => {
    delete require.cache[routesPath];
    readiness.reset();
    resolver.resetRuntimeForTest();
  });

  const mismatch = await invoke(routes, "POST", "/join-meeting", {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://candidate.example/realtime",
    conversationMode: "group",
  }, "198.51.100.1");
  assert.equal(mismatch.status, 503);
  assert.equal(mismatch.body.error.blockers.some((blocker) => blocker.code === "MISMATCH"), true);
  assert.deepEqual(fetched, ["https://candidate.example/health"]);
  assert.equal(readiness.inspect("tunnel").code, "CONNECTED", "request identity must not alter canonical readiness");

  readiness.setProbeObservation("tunnel", { ok: false, code: "MISMATCH" });
  const outside = await invoke(routes, "POST", "/join-meeting", {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://outside.example/realtime",
    conversationMode: "group",
  }, "198.51.100.2");
  assert.equal(outside.status, 503);
  assert.equal(outside.body.error.blockers.some((blocker) => blocker.system === "tunnel" && blocker.code === "MISMATCH"), true);
  assert.equal(readiness.inspect("tunnel").code, "MISMATCH", "outside input must not erase a canonical hard result");
  assert.equal(fetched.includes("https://outside.example/health"), false, "outside.example must never become a fetch destination");
  assert.deepEqual(fetched, ["https://candidate.example/health", "https://meetmate.example/health"]);
});

test("fresh readiness lookup cannot clear the boot-time ngrok latch used by /info", { concurrency: false }, async (t) => {
  initialize({ ngrokDomain: null });
  readiness.reset();
  delete require.cache[routesPath];
  const routes = require(routesPath);
  await routes.init({
    detectNgrok: false,
    loadAvatar: false,
    instanceId: "this-boot",
    readinessProbeOptions: {
      fetchFn: async () => new Response("{}", { status: 200 }),
      requestFn: unavailableRequest,
      httpGet: unavailableNgrokHttpGet,
    },
  });
  await routes._test.refreshNgrokDetection({
    httpGet: availableNgrokHttpGet("https://abc123.ngrok.app"),
  });
  t.after(() => {
    delete require.cache[routesPath];
    readiness.reset();
    resolver.resetRuntimeForTest();
  });

  const before = await invoke(routes, "GET", "/info");
  assert.equal(before.body.publicWsUrl, "wss://abc123.ngrok.app");
  const recheck = await invoke(routes, "POST", "/readiness/recheck", null, "198.51.100.31");
  assert.equal(recheck.status, 200);
  const after = await invoke(routes, "GET", "/info");
  assert.equal(after.body.publicWsUrl, "wss://abc123.ngrok.app");
});

test("join rejects PENDING but permits settled soft readiness failures", { concurrency: false }, async (t) => {
  initialize({ ngrokDomain: null });
  readiness.reset();
  delete require.cache[routesPath];
  const routes = require(routesPath);
  await routes.init({
    detectNgrok: false,
    loadAvatar: false,
    instanceId: "this-boot",
    readinessProbeOptions: {
      fetchFn: unavailableFetch,
      requestFn: unavailableRequest,
      httpGet: unavailableNgrokHttpGet,
    },
  });
  t.after(() => {
    delete require.cache[routesPath];
    readiness.reset();
    resolver.resetRuntimeForTest();
  });

  const form = {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://outside.example/realtime",
    conversationMode: "group",
  };
  const pending = await invoke(routes, "POST", "/join-meeting", form, "198.51.100.41");
  assert.equal(pending.status, 503);
  assert.equal(pending.body.error.code, "MEETING_NOT_READY");
  assert.equal(pending.body.error.message, "接続確認中です。数秒後に再試行してください");
  assert.deepEqual(pending.body.error.blockers, []);
  assert.deepEqual(pending.body.error.pending, ["soniox", "fish-audio", "attendee", "llm", "tunnel"]);

  for (const system of ["fish-audio", "attendee", "llm", "tunnel"]) {
    readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  }
  readiness.setProbeObservation("soniox", { ok: false, code: "UNREACHABLE" });
  const soft = await invoke(routes, "POST", "/join-meeting", {
    ...form,
    avatarExperiment: "hybrid-local-frames",
  }, "198.51.100.42");
  assert.equal(soft.status, 400);
  assert.match(soft.text, /公開 HTTPS origin/);
});
