"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const https = require("node:https");

const readiness = require("../src/settings/readiness");
const resolver = require("../src/settings/resolver");
const { REGISTRY_BY_ID } = require("../src/settings/registry");

function initialize(tts = {}, config = {}) {
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      parsed: { ...config, tts },
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
    "https://api.elevenlabs.io/v1/text-to-speech/eleven-voice?output_format=pcm_24000",
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
  assert.equal(captured.url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid?output_format=pcm_24000");
  assert.deepEqual(captured.options.headers, {
    Accept: "audio/*", "Content-Type": "application/json", "xi-api-key": "eleven-secret",
  });
  assert.deepEqual(JSON.parse(captured.options.body), {
    text: "hello", model_id: "eleven_multilingual_v2",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(captured.options.body), "output_format"), false);
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
  for (const baseUrl of ["https://api.openai.com.", "https://API.OPENAI.COM"]) {
    await assert.rejects(
      () => synthesize("no key", { baseUrl, model: "model", voice: "voice", onAudio: () => {} }),
      /API_KEY is required for api\.openai\.com/,
      baseUrl,
    );
  }
  await assert.rejects(
    () => synthesize("bad rate", {
      baseUrl: "http://localhost:9000", model: "model", voice: "voice", sampleRate: 16_000, onAudio: () => {},
    }),
    /24000 Hz/,
  );
});

test("dispatcher maps per-agent voice overrides onto ElevenLabs and OpenAI-compatible requests", async () => {
  const { synthesize } = require("../src/tts-fish");
  initialize({
    provider: "elevenlabs",
    elevenlabs: { apiKey: "eleven", voiceId: "global-eleven", model: "eleven-model" },
  });
  let elevenUrl;
  await synthesize("eleven override", {
    referenceId: "agent/eleven",
    onAudio: () => {},
    fetchFn: async (url) => { elevenUrl = String(url); return pcmResponse(); },
  });
  assert.equal(elevenUrl, "https://api.elevenlabs.io/v1/text-to-speech/agent%2Feleven?output_format=pcm_24000");

  initialize({
    provider: "openai-compatible",
    openaiCompatibleTts: { baseUrl: "http://127.0.0.1:7777", model: "local-model", voice: "global-openai" },
  });
  let openaiBody;
  await synthesize("openai override", {
    referenceId: "agent-openai",
    onAudio: () => {},
    fetchFn: async (_url, options) => { openaiBody = JSON.parse(options.body); return pcmResponse(); },
  });
  assert.equal(openaiBody.voice, "agent-openai");
});

test("pipeline voice resolution isolates provider defaults while preserving agent overrides and Fish cache identity", async (t) => {
  const configPath = require.resolve("../src/config");
  const profilePath = require.resolve("../src/agent-profile");
  const previousConfig = require.cache[configPath];
  const previousProfile = require.cache[profilePath];
  const { synthesize } = require("../src/tts-fish");
  const cache = require("../src/tts-cache")._test;
  const originalRequest = https.request;
  const originalError = console.error;
  let fishBody;

  t.after(() => {
    https.request = originalRequest;
    console.error = originalError;
    delete require.cache[configPath];
    delete require.cache[profilePath];
    if (previousConfig) require.cache[configPath] = previousConfig;
    if (previousProfile) require.cache[profilePath] = previousProfile;
  });

  console.error = () => {};

  https.request = (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => error && req.emit("error", error);
    req.write = (body) => { fishBody = JSON.parse(body); };
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

  function productionVoiceContext(tts) {
    const configJson = { agent: { id: "alpha" }, tts };
    initialize(tts, configJson);
    delete require.cache[profilePath];
    delete require.cache[configPath];
    const pipelineConfig = require("../src/config").getPipelineConfig({}, null, null, configJson);
    const profileModule = require("../src/agent-profile");
    profileModule.clearProfileCache();
    const profile = profileModule.resolveAgentProfile();
    return {
      pipelineConfig,
      profile,
      referenceId: profile.voiceId || pipelineConfig.tts.referenceId || null,
    };
  }

  const eleven = productionVoiceContext({
    provider: "elevenlabs",
    voiceId: "leftover-fish",
    elevenlabs: { apiKey: "eleven", voiceId: "eleven-default", model: "eleven-model" },
  });
  assert.equal(eleven.pipelineConfig.tts.referenceId, null);
  assert.equal(eleven.profile.voiceId, null);
  let elevenUrl;
  await synthesize("eleven default", {
    referenceId: eleven.referenceId,
    onAudio: () => {},
    fetchFn: async (url) => { elevenUrl = String(url); return pcmResponse(); },
  });
  assert.equal(elevenUrl, "https://api.elevenlabs.io/v1/text-to-speech/eleven-default?output_format=pcm_24000");
  assert.equal(cache.synthesisIdentity({ referenceId: eleven.referenceId }).voiceId, "eleven-default");
  const elevenDefaultKey = cache.cacheKey("same text", { referenceId: eleven.referenceId });
  let elevenOverrideUrl;
  await synthesize("eleven override", {
    referenceId: "agent-eleven",
    onAudio: () => {},
    fetchFn: async (url) => { elevenOverrideUrl = String(url); return pcmResponse(); },
  });
  assert.equal(elevenOverrideUrl, "https://api.elevenlabs.io/v1/text-to-speech/agent-eleven?output_format=pcm_24000");
  assert.equal(cache.synthesisIdentity({ referenceId: "agent-eleven" }).voiceId, "agent-eleven");
  assert.notEqual(cache.cacheKey("same text", { referenceId: "agent-eleven" }), elevenDefaultKey);

  const openai = productionVoiceContext({
    provider: "openai-compatible",
    voiceId: "leftover-fish",
    openaiCompatibleTts: { baseUrl: "http://127.0.0.1:7777", model: "local-model", voice: "openai-default" },
  });
  assert.equal(openai.pipelineConfig.tts.referenceId, null);
  assert.equal(openai.profile.voiceId, null);
  let openaiBody;
  await synthesize("openai default", {
    referenceId: openai.referenceId,
    onAudio: () => {},
    fetchFn: async (_url, options) => { openaiBody = JSON.parse(options.body); return pcmResponse(); },
  });
  assert.equal(openaiBody.voice, "openai-default");
  assert.equal(cache.synthesisIdentity({ referenceId: openai.referenceId }).voiceId, "openai-default");
  const openaiDefaultKey = cache.cacheKey("same text", { referenceId: openai.referenceId });
  await synthesize("openai override", {
    referenceId: "agent-openai",
    onAudio: () => {},
    fetchFn: async (_url, options) => { openaiBody = JSON.parse(options.body); return pcmResponse(); },
  });
  assert.equal(openaiBody.voice, "agent-openai");
  assert.equal(cache.synthesisIdentity({ referenceId: "agent-openai" }).voiceId, "agent-openai");
  assert.notEqual(cache.cacheKey("same text", { referenceId: "agent-openai" }), openaiDefaultKey);

  const fish = productionVoiceContext({ provider: "fish-audio", apiKey: "fish", voiceId: "legacy-voice", model: "s2-pro", speed: 1 });
  assert.equal(fish.pipelineConfig.tts.referenceId, "legacy-voice");
  assert.equal(fish.profile.voiceId, "legacy-voice");
  await synthesize("fish default", {
    referenceId: fish.referenceId,
    sampleRate: fish.pipelineConfig.tts.sampleRate,
    speed: fish.pipelineConfig.tts.speed,
    onAudio: () => {},
  });
  assert.equal(fishBody.reference_id, "legacy-voice");
  assert.equal(cache.synthesisIdentity({
    referenceId: fish.referenceId,
    sampleRate: fish.pipelineConfig.tts.sampleRate,
    speed: fish.pipelineConfig.tts.speed,
  }).referenceId, "legacy-voice");
  assert.equal(cache.cacheKey("upgrade-compatible fish", {
    referenceId: fish.referenceId,
    model: "s2-pro",
    sampleRate: fish.pipelineConfig.tts.sampleRate,
    speed: fish.pipelineConfig.tts.speed,
  }), "d0c7d1ce3f61be2ca68d3b5e288532b194157cbe676d2b3f110b82a3031e61b6");
});

test("pipeline config reports the selected TTS provider", () => {
  initialize({
    provider: "elevenlabs",
    elevenlabs: { apiKey: "eleven", voiceId: "voice", model: "model" },
  });
  const configPath = require.resolve("../src/config");
  const previous = require.cache[configPath];
  const originalError = console.error;
  delete require.cache[configPath];
  console.error = () => {};
  try {
    assert.equal(require("../src/config").getPipelineConfig().tts.provider, "elevenlabs");
  } finally {
    console.error = originalError;
    delete require.cache[configPath];
    if (previous) require.cache[configPath] = previous;
  }
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
