"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const https = require("node:https");

const readiness = require("../src/settings/readiness");
const resolver = require("../src/settings/resolver");
const { REGISTRY_BY_ID } = require("../src/settings/registry");

function initialize(tts = {}) {
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      parsed: { tts },
      revision: "a".repeat(64),
      fingerprint: "tts-providers",
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: "/tmp/meetmate-tts-providers",
      configPath: "/tmp/meetmate-tts-providers/config.json",
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
  });
}

function pcmResponse(bytes = [1, 2, 3, 4]) {
  return new Response(Buffer.from(bytes), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
}

test.afterEach(() => {
  readiness.reset();
  resolver.resetRuntimeForTest();
});

test("TTS provider schema accepts exactly the three supported providers", () => {
  const schema = REGISTRY_BY_ID.tts_provider.schema;
  for (const provider of ["fish-audio", "elevenlabs", "openai-compatible"]) {
    assert.equal(schema.safeParse(provider).success, true, provider);
  }
  assert.equal(schema.safeParse("unknown").success, false);
});

test("legacy facade dispatches Fish, ElevenLabs, and OpenAI-compatible from resolved settings", async (t) => {
  const originalRequest = https.request;
  const calls = [];
  https.request = (options, callback) => {
    calls.push(`https://${options.hostname}${options.path}`);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => error && req.emit("error", error);
    req.write = () => {};
    req.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from([1, 2]));
      response.emit("end");
    });
    return req;
  };
  t.after(() => { https.request = originalRequest; });
  const { synthesize } = require("../src/tts-fish");

  initialize({ provider: "fish-audio", apiKey: "fish", voiceId: "fish-voice" });
  await synthesize("fish", { onAudio: () => {} });

  initialize({
    provider: "elevenlabs",
    elevenlabs: { apiKey: "eleven", voiceId: "eleven-voice", model: "eleven-model" },
  });
  await synthesize("eleven", {
    onAudio: () => {},
    fetchFn: async (url) => { calls.push(String(url)); return pcmResponse(); },
  });

  initialize({
    provider: "openai-compatible",
    openaiCompatibleTts: { baseUrl: "http://127.0.0.1:7777", model: "local-model", voice: "local-voice" },
  });
  await synthesize("openai", {
    onAudio: () => {},
    fetchFn: async (url) => { calls.push(String(url)); return pcmResponse(); },
  });

  assert.deepEqual(calls, [
    "https://api.fish.audio/v1/tts",
    "https://api.elevenlabs.io/v1/text-to-speech/eleven-voice",
    "http://127.0.0.1:7777/v1/audio/speech",
  ]);
});

test("ElevenLabs adapter maps request fields, streams PCM, and never places its key in errors", async () => {
  initialize();
  const { synthesize } = require("../src/tts-elevenlabs");
  let captured;
  const audio = [];
  const returned = await synthesize("[soft voice] hello", {
    apiKey: "eleven-secret",
    voiceId: "voice/id",
    modelId: "eleven_multilingual_v2",
    sampleRate: 24_000,
    onAudio: (chunk) => audio.push(Buffer.from(chunk)),
    fetchFn: async (url, options) => { captured = { url: String(url), options }; return pcmResponse([1, 2, 3]); },
  });
  assert.equal(returned, undefined);
  assert.equal(captured.url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid");
  assert.deepEqual(captured.options.headers, { "Content-Type": "application/json", "xi-api-key": "eleven-secret" });
  assert.deepEqual(JSON.parse(captured.options.body), {
    text: "hello", model_id: "eleven_multilingual_v2", output_format: "pcm_24000",
  });
  assert.deepEqual(Buffer.concat(audio), Buffer.from([1, 2, 3, 0]));

  await assert.rejects(
    () => synthesize("hello", {
      apiKey: "eleven-secret", voiceId: "voice", modelId: "model", onAudio: () => {},
      fetchFn: async () => new Response("denied", { status: 401 }),
    }),
    (error) => error.statusCode === 401 && !error.message.includes("eleven-secret"),
  );
  assert.equal(readiness.inspect("elevenlabs").code, "AUTH_FAILED");
});

test("OpenAI-compatible adapter maps hosted auth, permits keyless local servers, and enforces 24 kHz PCM", async () => {
  initialize();
  const { synthesize } = require("../src/tts-openai-compat");
  const calls = [];
  await synthesize("[soft voice] hosted", {
    baseUrl: "https://api.openai.com/",
    apiKey: "openai-secret",
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    sampleRate: 24_000,
    onAudio: () => {},
    fetchFn: async (url, options) => { calls.push({ url: String(url), options }); return pcmResponse(); },
  });
  await synthesize("local", {
    baseUrl: "http://127.0.0.1:8080/tts",
    model: "irodori",
    voice: "local",
    sampleRate: 24_000,
    onAudio: () => {},
    fetchFn: async (url, options) => { calls.push({ url: String(url), options }); return pcmResponse(); },
  });
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[0].options.headers.Authorization, "Bearer openai-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gpt-4o-mini-tts", input: "hosted", voice: "alloy", response_format: "pcm",
  });
  assert.equal(calls[1].url, "http://127.0.0.1:8080/tts/v1/audio/speech");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].options.headers, "Authorization"), false);
  await assert.rejects(
    () => synthesize("no key", {
      baseUrl: "https://api.openai.com", model: "model", voice: "voice", onAudio: () => {},
    }),
    /API_KEY is required for api\.openai\.com/,
  );
  await assert.rejects(
    () => synthesize("bad rate", {
      baseUrl: "http://localhost:9000", model: "model", voice: "voice", sampleRate: 16_000, onAudio: () => {},
    }),
    /24000 Hz/,
  );
});

test("new adapters classify 402 with the same PAYMENT_REQUIRED readiness code as Fish", async () => {
  initialize();
  const eleven = require("../src/tts-elevenlabs");
  await assert.rejects(() => eleven.synthesize("pay", {
    apiKey: "key", voiceId: "voice", modelId: "model", onAudio: () => {},
    fetchFn: async () => new Response("payment", { status: 402 }),
  }), (error) => error.statusCode === 402);
  assert.equal(readiness.inspect("elevenlabs").code, "PAYMENT_REQUIRED");

  const openai = require("../src/tts-openai-compat");
  await assert.rejects(() => openai.synthesize("auth", {
    baseUrl: "https://api.openai.com", apiKey: "key", model: "model", voice: "voice", onAudio: () => {},
    fetchFn: async () => new Response("denied", { status: 401 }),
  }), (error) => error.statusCode === 401);
  assert.equal(readiness.inspect("openai-compatible").code, "AUTH_FAILED");
  await assert.rejects(() => openai.synthesize("pay", {
    baseUrl: "https://api.openai.com", apiKey: "key", model: "model", voice: "voice", onAudio: () => {},
    fetchFn: async () => new Response("payment", { status: 402 }),
  }), (error) => error.statusCode === 402);
  assert.equal(readiness.inspect("openai-compatible").code, "PAYMENT_REQUIRED");
});
