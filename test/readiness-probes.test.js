"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const resolver = require("../src/settings/resolver");
const probes = require("../src/settings/probes");

function initialize(parsed = {}) {
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed, revision: "a".repeat(64), fingerprint: "a".repeat(64) },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: "/tmp/meetmate-probes-test",
      configPath: "/tmp/meetmate-probes-test/config.json",
      connection: Object.freeze({
        openclawUrl: "https://gateway.example/prefix",
        openclawToken: "openclaw-token",
        openaiApiKey: "openai-key",
      }),
    }),
  });
}

test.afterEach(() => resolver.resetRuntimeForTest());

test("fetch probe classification covers 402, 404, 429, and 5xx without retaining bodies", async () => {
  initialize({ stt: { sonioxApiKey: "soniox-key" } });
  for (const [status, code] of [[402, "PAYMENT_REQUIRED"], [404, "PROVIDER_ERROR"], [429, "RATE_LIMITED"], [503, "PROVIDER_ERROR"]]) {
    const outcome = await probes.probeSystem("soniox", {
      fetchFn: async () => new Response('{"secret":"must-not-escape"}', { status }),
    });
    assert.deepEqual(outcome, { ok: false, code });
  }
});

test("403 is hard only for Attendee and remains a soft provider error elsewhere", async () => {
  initialize({
    stt: { sonioxApiKey: "soniox-key" },
    attendee: { apiKey: "attendee-key", baseUrl: "app.attendee.dev" },
  });
  const forbidden = async () => new Response("forbidden", { status: 403 });
  assert.equal((await probes.probeSystem("soniox", { fetchFn: forbidden })).code, "PROVIDER_ERROR");
  assert.equal((await probes.probeSystem("attendee", { fetchFn: forbidden })).code, "AUTH_FAILED");
});

test("probes use the published credential while restart-required is handled by readiness", async () => {
  initialize({ stt: { provider: "soniox", sonioxApiKey: "boot-key" } });
  resolver.publishState({
    exists: true,
    valid: true,
    parsed: { stt: { provider: "soniox", sonioxApiKey: "saved-key" } },
    revision: "b".repeat(64),
    fingerprint: "b".repeat(64),
  });
  let authorization = "";
  const outcome = await probes.probeSystem("soniox", {
    fetchFn: async (_url, options) => {
      authorization = options.headers.Authorization;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(outcome.code, "CONNECTED");
  assert.equal(authorization, "Bearer saved-key");
});

test("LLM requestFn uses the production model and fixed non-streaming ping body", async () => {
  initialize({ llm: { provider: "openclaw", model: "main-agent" } });
  let captured;
  const connected = await probes.probeSystem("llm", {
    requestFn: async (messages, options) => {
      captured = { messages, options };
      return { statusCode: 200, body: '{"choices":[]}' };
    },
  });
  assert.equal(connected.code, "CONNECTED");
  assert.deepEqual(captured.messages, [{ role: "user", content: "ping" }]);
  assert.equal(captured.options.model, "main-agent");
  assert.equal(captured.options.maxTokens, 1);
  assert.equal(captured.options.user, "meetmate-probe");
  assert.equal(captured.options.timeoutMs, 15_000);
  assert.equal(probes.DESCRIPTORS.llm.transport, "requestFn");

  const html = await probes.probeSystem("llm", {
    requestFn: async () => ({ statusCode: 200, body: "<html>challenge</html>" }),
  });
  assert.equal(html.code, "PROVIDER_ERROR");
  const disabled = await probes.probeSystem("llm", {
    requestFn: async () => ({ statusCode: 404, body: "not enabled" }),
  });
  assert.equal(disabled.code, "NOT_ENABLED");
});

test("OpenAI-compatible 404 is a configuration soft failure, never NOT_ENABLED", async () => {
  initialize({ llm: { provider: "openai-compatible", model: "gpt-compatible", openaiCompatible: { baseUrl: "https://llm.example/v1" } } });
  const outcome = await probes.probeSystem("llm", {
    requestFn: async () => ({ statusCode: 404, body: "missing" }),
  });
  assert.equal(outcome.code, "PROVIDER_ERROR");
  assert.match(outcome.message, /ベースURL\/モデル名/);
});

test("tunnel health mismatch is hard only for valid JSON with a different instanceId", async () => {
  initialize();
  const base = { resolvePublicOrigin: async () => ({ origin: "https://meetmate.example", candidateHosts: new Set(["meetmate.example"]) }), instanceId: "this-boot" };
  const mismatch = await probes.probeSystem("tunnel", {
    ...base,
    fetchFn: async () => new Response('{"instanceId":"other-boot"}', { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  assert.equal(mismatch.code, "MISMATCH");
  const missing = await probes.probeSystem("tunnel", {
    ...base,
    fetchFn: async () => new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  assert.equal(missing.code, "UNREACHABLE");
  const challenge = await probes.probeSystem("tunnel", {
    ...base,
    fetchFn: async () => new Response("<html>ngrok</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
  });
  assert.equal(challenge.code, "UNREACHABLE");
});

test("submitted wsUrl identity check has exact match, configured mismatch, and outside-config no-fetch branches", async () => {
  initialize();
  const resolved = async () => ({
    origin: "https://canonical.example",
    candidateHosts: new Set(["canonical.example", "candidate.example"]),
  });
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return new Response('{"instanceId":"other"}', { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const match = await probes.checkWsUrlIdentity("wss://canonical.example/realtime", {
    resolvePublicOrigin: resolved, instanceId: "this", fetchFn,
  });
  assert.equal(match.code, "CONNECTED");
  assert.equal(calls, 0);

  const mismatch = await probes.checkWsUrlIdentity("wss://candidate.example/realtime", {
    resolvePublicOrigin: resolved, instanceId: "this", fetchFn,
  });
  assert.equal(mismatch.code, "MISMATCH");
  assert.equal(calls, 1);

  const outside = await probes.checkWsUrlIdentity("wss://outside.example/realtime", {
    resolvePublicOrigin: resolved, instanceId: "this", fetchFn,
  });
  assert.equal(outside.code, "UNREACHABLE");
  assert.match(outside.message, /設定と一致しません/);
  assert.equal(calls, 1, "a non-config-derived host must never be fetched");
});
