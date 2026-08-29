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
        server: { ngrokDomain: "meetmate.example" },
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

test("real public route handlers never dispatch billing probes and rate-limited join judges cached blockers", { concurrency: false }, async (t) => {
  initialize();
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
  for (const system of ["soniox", "fish-audio", "attendee", "llm", "tunnel"]) readiness.reportRuntimeSuccess(system);
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

  readiness.reportRuntimeSuccess("tunnel");
  readiness.reportRuntimeFailure("fish-audio", "PAYMENT_REQUIRED");
  const outside = await invoke(routes, "POST", "/join-meeting", {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://outside.example/realtime",
    conversationMode: "group",
  }, "198.51.100.2");
  assert.equal(outside.status, 503);
  assert.equal(outside.body.error.blockers.some((blocker) => blocker.system === "tunnel" && blocker.code === "MISMATCH"), false);
  assert.deepEqual(fetched, ["https://candidate.example/health"], "outside.example must never become a fetch destination");
});
