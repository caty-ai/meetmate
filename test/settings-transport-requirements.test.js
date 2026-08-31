"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable } = require("node:stream");

const adapterRegistry = require("../src/adapter-registry");
const readiness = require("../src/settings/readiness");
const resolver = require("../src/settings/resolver");

function startup(overrides = {}) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({ ...(overrides.preDotenvEnv || {}) }),
    dotenvSeeds: Object.freeze({ ...(overrides.dotenvSeeds || {}) }),
    resolvedHome: "/tmp/meetmate-settings-transport",
    configPath: "/tmp/meetmate-settings-transport/config.json",
    connection: Object.freeze({
      openclawUrl: "https://gateway.example",
      openclawToken: "configured.token",
      openaiApiKey: "",
      ...(overrides.connection || {}),
    }),
  });
}

function completeConfig(overrides = {}) {
  return {
    agent: {
      id: "alpha",
      displayName: "Alpha",
      wakeWords: ["alpha"],
      ...(overrides.agent || {}),
    },
    stt: {
      provider: "soniox",
      sonioxApiKey: "soniox-key",
      ...(overrides.stt || {}),
    },
    tts: {
      provider: "fish-audio",
      apiKey: "fish-key",
      voiceId: "fish-voice",
      sampleRate: 24000,
      ...(overrides.tts || {}),
    },
    attendee: {
      apiKey: "attendee-key",
      ...(overrides.attendee || {}),
    },
    ...(overrides.server ? { server: overrides.server } : {}),
    ...(overrides.slack ? { slack: overrides.slack } : {}),
    ...(overrides.discord ? { discord: overrides.discord } : {}),
  };
}

function initialize(config, startupOverrides = {}) {
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: config, revision: "a".repeat(64), fingerprint: "bytes:test" },
    startup: startup(startupOverrides),
  });
}

function issueIds(status) {
  return status.issues.filter((issue) => issue.code === "VALUE_REQUIRED").map((issue) => issue.fieldId).sort();
}

function request(body = "") {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, {
    method: "POST",
    url: "/join-meeting",
    headers: {},
    socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
  });
  return req;
}

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = "") { this.body += String(chunk); },
  };
}

test("T12-07 Attendee-plane status and the real join 503 stay byte-identical to base 099c775", { concurrency: false }, async (t) => {
  const missingAttendee = completeConfig({ attendee: { apiKey: undefined } });
  initialize(missingAttendee);
  t.after(() => resolver.resetRuntimeForTest());

  const legacyContextFree = resolver.getStatus();
  const meet = resolver.getStatus({ transport: "meet" });
  const zoom = resolver.getStatus({ transport: "zoom" });
  assert.deepEqual(meet, legacyContextFree);
  assert.deepEqual(zoom, legacyContextFree);
  assert.deepEqual(meet.issues, [{ fieldId: "attendee_api_key", code: "VALUE_REQUIRED" }]);
  assert.equal(adapterRegistry.deriveTransportForAuth("/join-meeting"), "meet");

  const res = response();
  await require("../src/transport-meet/meet-routes").handleHttp(request(), res);
  assert.equal(res.status, 503);
  assert.deepEqual(res.headers, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  assert.equal(
    res.body,
    '{"error":{"code":"MEETING_SETUP_REQUIRED","message":"Meeting setup is incomplete","issues":[{"fieldId":"attendee_api_key","code":"VALUE_REQUIRED"}]}}',
  );
});

test("T12-07 the real join setup gate passes the derived Meet transport to readiness revalidation", { concurrency: false }, async (t) => {
  initialize(completeConfig({ server: { ngrokDomain: "meetmate.example" } }));
  readiness.reset();
  for (const system of readiness.gateSystems()) readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  readiness.setProbeObservation("fish-audio", { ok: false, code: "AUTH_FAILED" });
  const observed = [];
  const originalRevalidateForJoin = readiness.revalidateForJoin;
  readiness.revalidateForJoin = async (options) => { observed.push(options); return originalRevalidateForJoin(options); };
  t.after(() => {
    readiness.revalidateForJoin = originalRevalidateForJoin;
    readiness.reset();
    resolver.resetRuntimeForTest();
  });
  assert.equal(resolver.getStatus({ transport: "meet" }).meetingReady, true);

  const body = new URLSearchParams({
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    wsUrl: "wss://meetmate.example/realtime",
    conversationMode: "group",
  }).toString();
  const res = response();
  await require("../src/transport-meet/meet-routes").handleHttp(request(body), res);
  assert.deepEqual(observed, [{ transport: "meet" }]);
  assert.equal(JSON.parse(res.body).error.code, "MEETING_NOT_READY");
});

test("T12-07 selected STT/TTS predicates preserve provider-only operators and resolver escapes", { concurrency: false }, (t) => {
  t.after(() => resolver.resetRuntimeForTest());

  initialize(completeConfig({
    tts: {
      provider: "elevenlabs",
      apiKey: undefined,
      voiceId: undefined,
      elevenlabs: { apiKey: "eleven-key", voiceId: "eleven-voice" },
      sampleRate: 24000,
    },
  }));
  assert.equal(resolver.getStatus({ transport: "meet" }).meetingReady, true);
  assert.equal(issueIds(resolver.getStatus({ transport: "meet" })).some((id) => id.startsWith("fish_audio_")), false);

  initialize(completeConfig({
    stt: { provider: "deepgram", sonioxApiKey: undefined, apiKey: "deepgram-key" },
  }));
  assert.equal(resolver.getStatus({ transport: "meet" }).meetingReady, true);
  assert.equal(issueIds(resolver.getStatus({ transport: "meet" })).includes("soniox_api_key"), false);

  initialize(completeConfig());
  assert.equal(issueIds(resolver.getStatus({ transport: "meet" })).includes("slack_bot_token"), false);

  initialize(completeConfig({ slack: { notifications: { enabled: true } } }), {
    preDotenvEnv: { ALPHA_SLACK_BOT_TOKEN: "dynamic.slack.token" },
  });
  assert.equal(issueIds(resolver.getStatus({ transport: "meet" })).includes("slack_bot_token"), false);

  initialize(completeConfig({
    tts: {
      provider: "openai-compatible",
      apiKey: undefined,
      voiceId: undefined,
      openaiCompatibleTts: {
        baseUrl: "http://localhost:8080",
        model: "local-tts",
        voice: "alloy",
      },
      sampleRate: 24000,
    },
  }));
  assert.equal(issueIds(resolver.getStatus({ transport: "meet" })).includes("openai_compatible_tts_api_key"), false);
  assert.equal(resolver.getStatus({ transport: "meet" }).meetingReady, true);
});

test("T12-07 absent and unknown transports over-require while context-free health stays compatible", { concurrency: false }, (t) => {
  t.after(() => resolver.resetRuntimeForTest());
  const missingTransportCredentials = completeConfig({
    attendee: { apiKey: undefined },
  });
  initialize(missingTransportCredentials);

  assert.deepEqual(issueIds(resolver.getStatus()), ["attendee_api_key"]);
  assert.deepEqual(issueIds(resolver.getStatus({ transport: "meet" })), ["attendee_api_key"]);
  assert.deepEqual(issueIds(resolver.getStatus({ transport: "discord" })), ["discord_bot_token"]);
  assert.deepEqual(issueIds(resolver.getStatus({})), ["attendee_api_key", "discord_bot_token"]);
  assert.deepEqual(issueIds(resolver.getStatus({ transport: undefined })), ["attendee_api_key", "discord_bot_token"]);
  assert.deepEqual(issueIds(resolver.getStatus({ transport: adapterRegistry.AUTH_VALIDATE_ALL })), ["attendee_api_key", "discord_bot_token"]);
  assert.deepEqual(issueIds(resolver.getStatus({ transport: "unknown" })), ["attendee_api_key", "discord_bot_token"]);

  initialize(completeConfig({ discord: { guildAllowlist: ["12345678901234567"] } }));
  assert.deepEqual(issueIds(resolver.getStatus()), ["discord_bot_token"]);
  assert.equal(readiness.getReadiness().setupRequired, true);
  assert.equal(readiness.getReadiness({ transport: "meet" }).setupRequired, false);

  initialize(completeConfig({ discord: { botToken: "discord-token", guildAllowlist: [] } }));
  assert.equal(resolver.getStatus().meetingReady, true);
  assert.equal(resolver.getStatus({ transport: "discord" }).meetingReady, true);
});
