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

test("ElevenLabs and OpenAI-compatible TTS probes use provider-specific auth and base URLs", async () => {
  initialize({
    tts: {
      elevenlabs: { apiKey: "eleven-key" },
      openaiCompatibleTts: { baseUrl: "http://127.0.0.1:8080" },
    },
  });
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return new Response("{}", { status: 200 });
  };
  assert.equal((await probes.probeSystem("elevenlabs", { fetchFn })).code, "CONNECTED");
  assert.equal((await probes.probeSystem("openai-compatible", { fetchFn })).code, "CONNECTED");
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/user/subscription");
  assert.equal(calls[0].headers["xi-api-key"], "eleven-key");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].headers, "Authorization"), false);
  assert.equal(calls[1].url, "http://127.0.0.1:8080/v1/models");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].headers, "Authorization"), false);

  for (const baseUrl of ["https://api.openai.com.", "https://API.OPENAI.COM"]) {
    initialize({ tts: { openaiCompatibleTts: { baseUrl } } });
    let fetched = false;
    const hosted = await probes.probeSystem("openai-compatible", {
      fetchFn: async () => { fetched = true; return new Response("{}", { status: 200 }); },
    });
    assert.equal(hosted.code, "NOT_CONFIGURED", baseUrl);
    assert.equal(fetched, false, baseUrl);
  }
});

test("OpenAI-compatible TTS model-probe 404 and 405 are inconclusive successes", async () => {
  initialize({ tts: { openaiCompatibleTts: { baseUrl: "http://127.0.0.1:8080" } } });
  for (const status of [404, 405]) {
    const outcome = await probes.probeSystem("openai-compatible", {
      fetchFn: async () => new Response("missing optional endpoint", { status }),
    });
    assert.equal(outcome.ok, true, String(status));
    assert.equal(outcome.code, "CONNECTED", String(status));
    assert.match(outcome.message, /optional \/v1\/models/);
  }
  const unauthorized = await probes.probeSystem("openai-compatible", {
    fetchFn: async () => new Response("denied", { status: 401 }),
  });
  assert.deepEqual(unauthorized, { ok: false, code: "AUTH_FAILED" });
  const refused = new Error("connection refused");
  refused.code = "ECONNREFUSED";
  const unreachable = await probes.probeSystem("openai-compatible", {
    fetchFn: async () => { throw refused; },
  });
  assert.deepEqual(unreachable, { ok: false, code: "UNREACHABLE" });
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

test("discord probe uses Bot auth, short-circuits without a token, and keeps the token out of results", async () => {
  initialize({ discord: { guildAllowlist: ["11111111111111111"] } });
  let calls = 0;
  const notConfigured = await probes.probeSystem("discord", {
    fetchFn: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  assert.deepEqual(notConfigured, { ok: false, code: "NOT_CONFIGURED" });
  assert.equal(calls, 0);

  initialize({ discord: { botToken: "discord.fixture.value", guildAllowlist: [] } });
  const requests = [];
  const connected = await probes.probeSystem("discord", {
    fetchFn: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response("{}", { status: 200 });
    },
  });
  assert.deepEqual(connected, { ok: true, code: "CONNECTED" });
  assert.deepEqual(requests, [{
    url: "https://discord.com/api/v10/users/@me",
    authorization: "Bot discord.fixture.value",
  }]);
  assert.equal(JSON.stringify(connected).includes("discord.fixture.value"), false);
});

test("discord probe enforces the allowlist tier, returns value-free success, and fails when no allowlisted guild is present", async () => {
  const guildId = "11111111111111111";
  initialize({ discord: { botToken: "discord.fixture.value", guildAllowlist: [guildId, "22222222222222222"] } });
  const calls = [];
  const matched = await probes.probeSystem("discord", {
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return String(url).includes("/guilds")
        ? new Response(JSON.stringify([{ id: guildId }, { id: "99999999999999999" }]), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response("{}", { status: 200 });
    },
  });
  assert.deepEqual(matched, { ok: true, code: "CONNECTED" });
  assert.deepEqual(calls.map((entry) => entry.url), [
    "https://discord.com/api/v10/users/@me",
    "https://discord.com/api/v10/users/@me/guilds?limit=200",
  ]);
  assert.equal(calls.every((entry) => entry.authorization === "Bot discord.fixture.value"), true);

  const missing = await probes.probeSystem("discord", {
    fetchFn: async (url) => (String(url).includes("/guilds")
      ? new Response(JSON.stringify([{ id: "99999999999999999" }]), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response("{}", { status: 200 })),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "ALLOWLIST_MISMATCH");
  assert.match(missing.message, /許可済み/);
  assert.equal(JSON.stringify(missing).includes("discord.fixture.value"), false);
});

test("discord probe paginates guild lookup to a second page under the shared budget", async () => {
  initialize({ discord: { botToken: "discord.fixture.value", guildAllowlist: ["11111111111111111"] } });
  const calls = [];
  const outcome = await probes.probeSystem("discord", {
    endpoints: {
      discord: "https://probe.example/users/@me",
      discordGuilds: "https://probe.example/users/@me/guilds",
    },
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      if (!String(url).includes("/guilds")) return new Response("{}", { status: 200 });
      if (!String(url).includes("after=")) {
        return new Response(JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ id: String(20000000000000000n + BigInt(index)) }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([{ id: "11111111111111111" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual(outcome, { ok: true, code: "CONNECTED" });
  assert.deepEqual(calls, [
    { url: "https://probe.example/users/@me", authorization: "Bot discord.fixture.value" },
    { url: "https://probe.example/users/@me/guilds?limit=200", authorization: "Bot discord.fixture.value" },
    { url: "https://probe.example/users/@me/guilds?limit=200&after=20000000000000199", authorization: "Bot discord.fixture.value" },
  ]);
});

test("discord probe maps auth failures and abort-driven deadlines without leaking credentials", async () => {
  initialize({ discord: { botToken: "discord.fixture.value", guildAllowlist: ["11111111111111111"] } });
  for (const status of [401, 403]) {
    const denied = await probes.probeSystem("discord", {
      fetchFn: async () => new Response("denied", { status }),
    });
    assert.deepEqual(denied, { ok: false, code: "AUTH_FAILED" });
  }

  const timedOut = await probes.probeSystem("discord", {
    timeoutMs: 5,
    fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assert.deepEqual(timedOut, { ok: false, code: "TIMEOUT" });
  assert.equal(JSON.stringify(timedOut).includes("discord.fixture.value"), false);
});

test("discord probe stops after a short first guild page with an allowlist mismatch", async () => {
  initialize({ discord: { botToken: "discord.fixture.value", guildAllowlist: ["11111111111111111"] } });
  const calls = [];
  const missing = await probes.probeSystem("discord", {
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return String(url).includes("/guilds")
        ? new Response(JSON.stringify([{ id: "99999999999999999" }]), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response("{}", { status: 200 });
    },
  });
  assert.equal(missing.code, "ALLOWLIST_MISMATCH");
  assert.deepEqual(calls.map((entry) => entry.url), [
    "https://discord.com/api/v10/users/@me",
    "https://discord.com/api/v10/users/@me/guilds?limit=200",
  ]);
});

test("discord probe shares one wall-clock timeout budget across auth and guild pagination", async (t) => {
  initialize({ discord: { botToken: "discord.fixture.value", guildAllowlist: ["11111111111111111"] } });
  const startedAt = Date.now();
  const outcome = await probes.probeSystem("discord", {
    timeoutMs: 80,
    fetchFn: async (url, options) => {
      if (!String(url).includes("/guilds")) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response("{}", { status: 200 });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const elapsed = Date.now() - startedAt;
  t.diagnostic(`shared-budget elapsedMs=${elapsed}`);
  assert.deepEqual(outcome, { ok: false, code: "TIMEOUT" });
  assert.ok(elapsed >= 50 && elapsed < 120, `elapsed=${elapsed}`);
});

test("discord probe times out mid-pagination when the shared budget is exhausted", async () => {
  initialize({ discord: { botToken: "discord.fixture.value", guildAllowlist: ["11111111111111111"] } });
  let fakeNow = 0;
  let guildCalls = 0;
  const outcome = await probes.probeSystem("discord", {
    timeoutMs: 60,
    now: () => fakeNow,
    fetchFn: async (url, options) => {
      if (!String(url).includes("/guilds")) {
        fakeNow = 10;
        return new Response("{}", { status: 200 });
      }
      guildCalls += 1;
      if (guildCalls === 1) {
        fakeNow = 45;
        return new Response(JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ id: String(30000000000000000n + BigInt(index)) }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  assert.deepEqual(outcome, { ok: false, code: "TIMEOUT" });
  assert.equal(guildCalls, 2);
});
