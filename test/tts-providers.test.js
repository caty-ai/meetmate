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

test("OpenAI-compatible adapter maps hosted auth, permits keyless local servers, and enforces 24 kHz output", async () => {
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

function unevenPcmResponse(pcm) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(pcm.subarray(0, 4002));
      controller.enqueue(pcm.subarray(4002, 4008));
      // The 5001 split exercises readPcmBody's odd-byte carry; createPcmResampler's oddByte path needs its direct unit test.
      controller.enqueue(pcm.subarray(4008, 5001));
      controller.enqueue(pcm.subarray(5001, 6006));
      controller.enqueue(pcm.subarray(6006));
      controller.close();
    },
  }));
}

const localPcmOptions = { baseUrl: "http://localhost:9000", model: "irodori", voice: "local", sampleRate: 24_000 };

test("OpenAI-compatible source sample rate registry validates the declared contract", () => {
  const entry = REGISTRY_BY_ID.openai_compatible_tts_source_sample_rate;
  assert.equal(entry.defaultValue, 24000);
  assert.equal(entry.envAlias, "OPENAI_COMPATIBLE_TTS_SOURCE_SAMPLE_RATE");
  assert.deepEqual(entry.visibleWhen, { id: "tts_provider", value: "openai-compatible" });
  for (const rate of [8000, 24000, 48000, 96000]) assert.equal(entry.schema.safeParse(rate).success, true);
  for (const rate of [7999, 96001, 44100.5, "48000"]) assert.equal(entry.schema.safeParse(rate).success, false);
});

test("OpenAI-compatible resamples a 3.36 s 48 kHz fixture with preserved duration and pitch", async (t) => {
  initialize();
  const pcm = Buffer.alloc(322_560);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(20000 * Math.sin(2 * Math.PI * 440 * i / 48000)), i * 2);
  const audio = [];
  let body;
  await require("../src/tts-openai-compat").synthesize("fixture", {
    ...localPcmOptions, sourceSampleRate: 48_000,
    onAudio: (chunk) => { assert.equal(chunk.length % 2, 0); audio.push(chunk); },
    fetchFn: async (_url, options) => { body = JSON.parse(options.body); return unevenPcmResponse(pcm); },
  });
  const delivered = Buffer.concat(audio);
  assert.ok(delivered.length >= 159667 && delivered.length <= 162893);
  const decimated = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < decimated.length / 2; i++) decimated.writeInt16LE(pcm.readInt16LE(i * 4), i * 2);
  assert.equal(delivered.length, decimated.length, "delivered byte count must match 2:1 decimation before comparing content");
  assert.deepEqual(delivered, decimated, "every output sample must match 2:1 decimation, including chunk boundaries");
  assert.deepEqual(body, { model: "irodori", input: "fixture", voice: "local", response_format: "pcm" });
  t.diagnostic(`48 kHz fixture: source=${pcm.length} delivered=${delivered.length} bytes; decimation matches=${decimated.length / 2} samples, mismatches=0`);
});

test("#234 OpenAI-compatible 32 kHz chunks match an unchunked reference linear interpolator sample-exactly", async () => {
  initialize();
  const sourceRate = 32_000;
  const targetRate = 24_000;
  const pcm = Buffer.alloc(sourceRate * 2);
  for (let i = 0; i < sourceRate; i++) pcm.writeInt16LE(Math.round(20000 * Math.sin(2 * Math.PI * 440 * i / sourceRate)), i * 2);
  // Size the reference from the buffer, not the rate, so the test stays valid if the fixture length changes.
  const pcmSamples = pcm.length / 2;
  const expected = Buffer.alloc(Math.ceil(pcmSamples * targetRate / sourceRate) * 2);
  for (let n = 0; n < expected.length / 2; n++) {
    const numerator = n * sourceRate;
    const leftIndex = Math.floor(numerator / targetRate);
    const fraction = (numerator % targetRate) / targetRate;
    const left = pcm.readInt16LE(leftIndex * 2);
    const right = pcm.readInt16LE(Math.min(leftIndex + 1, pcmSamples - 1) * 2);
    expected.writeInt16LE(Math.round(left + (right - left) * fraction), n * 2);
  }
  const audio = [];
  await require("../src/tts-openai-compat").synthesize("non-integer fixture", {
    ...localPcmOptions, sourceSampleRate: sourceRate,
    onAudio: (chunk) => audio.push(chunk),
    fetchFn: async () => unevenPcmResponse(pcm),
  });
  assert.deepEqual(Buffer.concat(audio), expected);
});

test("OpenAI-compatible explicit and default 24 kHz source pass through byte-identically", async () => {
  initialize();
  const pcm = Buffer.alloc(5000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 256;
  for (const rateOptions of [{ sourceSampleRate: 24_000 }, {}]) {
    const audio = [];
    await require("../src/tts-openai-compat").synthesize("passthrough", {
      ...localPcmOptions, ...rateOptions, onAudio: (chunk) => audio.push(chunk),
      fetchFn: async () => unevenPcmResponse(pcm),
    });
    assert.deepEqual(Buffer.concat(audio), pcm);
  }
});

test("OpenAI-compatible 15 s cap is measured in source bytes at 48 kHz", async () => {
  initialize();
  const caps = [];
  const audio = [];
  await assert.rejects(() => require("../src/tts-openai-compat").synthesize("cap", {
    ...localPcmOptions, sourceSampleRate: 48_000, onAudio: (chunk) => audio.push(chunk),
    fetchFn: async () => unevenPcmResponse(Buffer.alloc(1_536_000)),
    onDurationCapExceeded: (details) => { caps.push(details); return new Error("source cap"); },
  }), /source cap/);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].maxBytes, 1_440_000);
  assert.equal(caps[0].totalBytesReceived, 6006);
  assert.equal(Buffer.concat(audio).length, 3002);
});

test("OpenAI-compatible rejects invalid source rates", async () => {
  for (const sourceSampleRate of [0, 4000, 48000.5, 96001, "48000"]) {
    await assert.rejects(() => require("../src/tts-openai-compat").synthesize("invalid", {
      ...localPcmOptions, sourceSampleRate, onAudio: () => {},
    }), /8000 and 96000/);
  }
});

test("dispatcher resolves the source sample rate and permits an explicit override", async () => {
  initialize({ provider: "openai-compatible", openaiCompatibleTts: {
    baseUrl: localPcmOptions.baseUrl, model: "irodori", voice: "local", sourceSampleRate: 48000,
  } });
  for (const [rateOptions, expectedBytes] of [[{}, 2400], [{ sourceSampleRate: 24000 }, 4800]]) {
    const audio = [];
    await require("../src/tts-fish").synthesize("dispatcher", {
      ...rateOptions, sampleRate: 24000, onAudio: (chunk) => audio.push(chunk),
      fetchFn: async () => pcmResponse(Buffer.alloc(4800)),
    });
    assert.equal(Buffer.concat(audio).length, expectedBytes);
  }
});

test("#237 dispatcher rejects an explicit zero source sample rate before HTTP", async () => {
  initialize({ provider: "openai-compatible", openaiCompatibleTts: {
    baseUrl: localPcmOptions.baseUrl, model: "irodori", voice: "local", sourceSampleRate: 48000,
  } });
  let fetchCalls = 0;
  await assert.rejects(() => require("../src/tts-fish").synthesize("dispatcher-zero", {
    sourceSampleRate: 0, sampleRate: 24000, onAudio: () => {},
    fetchFn: async () => { fetchCalls++; return pcmResponse(); },
  }), /8000 and 96000/);
  assert.equal(fetchCalls, 0);
});

test("PCM resampler interpolates across chunks, carries odd bytes, passes equal rates through, and resets", () => {
  const { createPcmResampler } = require("../src/tts-pcm-stream");
  for (const rates of [[0, 24000], [8000, -1], [8000.5, 24000], [8000, NaN]]) {
    assert.throws(() => createPcmResampler(...rates), TypeError);
  }
  const ramp = Buffer.alloc(4);
  ramp.writeInt16LE(3000, 2);
  const same = createPcmResampler(24000, 24000);
  assert.equal(same.push(ramp), ramp);
  assert.equal(same.flush().length, 0);
  const resampler = createPcmResampler(8000, 24000);
  const parts = [resampler.push(ramp.subarray(0, 1)), resampler.push(ramp.subarray(1, 3)), resampler.push(ramp.subarray(3)), resampler.flush()];
  const values = [];
  const result = Buffer.concat(parts);
  for (let i = 0; i < result.length; i += 2) values.push(result.readInt16LE(i));
  assert.ok(values.length >= 5 && values.length <= 7);
  assert.deepEqual(values.slice(0, 3), [0, 1000, 2000]);
  assert.ok(values.every((v, i) => i === 0 || v >= values[i - 1]));
  assert.equal(values.at(-1), 3000);
  assert.equal(resampler.flush().length, 0);
  assert.deepEqual(Buffer.concat([resampler.push(ramp), resampler.flush()]), result);
});

test("#234 PCM resampler emits exact counts for 8000→24000 and 44100→24000", (t) => {
  const { createPcmResampler } = require("../src/tts-pcm-stream");
  for (const [sourceRate, inputSamples, expectedSamples] of [[8000, 100_000, 300_000], [44100, 44_100, 24_000]]) {
    const resampler = createPcmResampler(sourceRate, 24000);
    const output = Buffer.concat([resampler.push(Buffer.alloc(inputSamples * 2)), resampler.flush()]);
    // Positions k * sourceRate / targetRate < N yield exactly ceil(N * targetRate / sourceRate) samples.
    assert.equal(output.length / 2, expectedSamples, `${sourceRate}→24000 output count`);
    t.diagnostic(`${sourceRate}→24000: input=${inputSamples}, output=${output.length / 2} samples`);
  }
});

test("OpenAI-compatible does not flush audio after cancellation", async () => {
  initialize();
  const controller = new AbortController();
  let callbacks = 0;
  await require("../src/tts-openai-compat").synthesize("abort", {
    ...localPcmOptions, sourceSampleRate: 8000, signal: controller.signal,
    onAudio: () => { assert.equal(controller.signal.aborted, false); callbacks++; controller.abort(); },
    fetchFn: async () => pcmResponse([0, 0, 1, 0]),
  });
  assert.equal(callbacks, 1);
});
