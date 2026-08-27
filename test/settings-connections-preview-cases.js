"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const { initializeRuntime, resetRuntimeForTest } = require("../src/settings/resolver");
const { createSettingsHandler, _test } = require("../src/settings/routes");
const { readConfigState } = require("../src/settings/store");

const SENTINEL = "meetmate-33-sentinel-4d01f7885f424647aab79f5304dc8eed";

function startup(directory) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({}), dotenvSeeds: Object.freeze({}), resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: "token", openaiApiKey: "" }),
  });
}

function request(method, url, body, { raw = false, headers = {} } = {}) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(raw ? body : JSON.stringify(body));
  const req = Readable.from(bytes.length ? [bytes] : []);
  Object.assign(req, {
    method, url,
    headers: {
      host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin",
      "content-type": "application/json", ...headers,
    },
    socket: { localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

function response() {
  return {
    status: null, headers: null, chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = Buffer.alloc(0)) { if (chunk.length) this.chunks.push(Buffer.from(chunk)); },
    get bytes() { return Buffer.concat(this.chunks); },
    get json() { return JSON.parse(this.bytes.toString("utf8")); },
  };
}

function fixture(t, document, handlerOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-33-"));
  const runtimeStartup = startup(directory);
  fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  const state = readConfigState(runtimeStartup.configPath);
  resetRuntimeForTest();
  initializeRuntime({ state, startup: runtimeStartup });
  t.after(() => {
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, state, handler: createSettingsHandler({ port: 5005, ...handlerOptions }) };
}

async function invoke(handler, method, url, body, options) {
  const res = response();
  await handler(request(method, url, body, options), res);
  return res;
}

async function localVendor(t, listener, fallbackFetch) {
  const server = http.createServer(listener);
  const error = await new Promise((resolve) => {
    server.once("error", resolve);
    server.listen(0, "127.0.0.1", () => resolve(null));
  });
  if (error) {
    if (error.code !== "EPERM") throw error;
    return { baseUrl: "http://mock.vendor", fetchFn: fallbackFetch };
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, fetchFn: globalThis.fetch };
}

test("Soniox and Fish tests use effective credentials and return exact value-free success shapes", async (t) => {
  const calls = [];
  const fallbackFetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ vendor: SENTINEL }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const vendor = await localVendor(t, (req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ vendor: SENTINEL }));
  }, fallbackFetch);
  const { handler, state } = fixture(t, {
    stt: { sonioxApiKey: SENTINEL }, tts: { apiKey: SENTINEL, voiceId: "voice" },
  }, {
    connections: {
      minIntervalMs: 0,
      fetchFn: vendor.fetchFn,
      endpoints: { soniox: `${vendor.baseUrl}/v1/models`, "fish-audio": `${vendor.baseUrl}/model?page_size=1` },
    },
  });

  for (const provider of ["soniox", "fish-audio"]) {
    const res = await invoke(handler, "POST", `/api/settings/connections/${provider}/test`, { revision: state.revision });
    assert.equal(res.status, 200, res.bytes.toString());
    assert.deepEqual(Object.keys(res.json), ["ok", "provider", "code", "message", "durationMs"]);
    assert.deepEqual({ ...res.json, durationMs: 0 }, {
      ok: true, provider, code: "CONNECTED", message: "Connection succeeded", durationMs: 0,
    });
    assert.equal(Number.isInteger(res.json.durationMs), true);
    assert.equal(res.bytes.includes(Buffer.from(SENTINEL)), false);
  }
  assert.deepEqual(calls.map((call) => call.authorization), [`Bearer ${SENTINEL}`, `Bearer ${SENTINEL}`]);

  const rejected = await invoke(handler, "POST", "/api/settings/connections/soniox/test", {
    revision: state.revision, apiKey: "client-bypass",
  });
  assert.equal(rejected.status, 422);
  assert.equal(calls.length, 2);
});

test("connection failure matrix is finite and vendor bodies and credentials stay value-free", async (t) => {
  const { state } = fixture(t, { stt: { sonioxApiKey: SENTINEL }, tts: { apiKey: SENTINEL } });
  for (const [pathName, expected] of [["401", "AUTH_FAILED"], ["429", "RATE_LIMITED"], ["503", "PROVIDER_ERROR"]]) {
    const handler = createSettingsHandler({
      port: 5005,
      connections: {
        minIntervalMs: 0,
        endpoints: { soniox: `http://mock.vendor/${pathName}` },
        fetchFn: async () => new Response(JSON.stringify({ secret: SENTINEL }), { status: Number(pathName) }),
      },
    });
    const res = await invoke(handler, "POST", "/api/settings/connections/soniox/test", { revision: state.revision });
    assert.equal(res.status, 200);
    assert.equal(res.json.code, expected);
    assert.equal(res.json.ok, false);
    assert.equal(res.bytes.includes(Buffer.from(SENTINEL)), false);
  }

  const unreachable = createSettingsHandler({
    port: 5005,
    connections: {
      minIntervalMs: 0,
      fetchFn: async () => { const error = new TypeError("fetch failed"); error.cause = { code: "ECONNREFUSED" }; throw error; },
    },
  });
  const refused = await invoke(unreachable, "POST", "/api/settings/connections/soniox/test", { revision: state.revision });
  assert.equal(refused.json.code, "UNREACHABLE");
});

test("unset keys avoid vendor calls and optional providers remain exact 501", async (t) => {
  let calls = 0;
  const { handler, state } = fixture(t, {}, {
    connections: { fetchFn: async () => { calls += 1; throw new Error("must not call"); }, minIntervalMs: 0 },
  });
  for (const provider of ["soniox", "fish-audio"]) {
    const res = await invoke(handler, "POST", `/api/settings/connections/${provider}/test`, { revision: state.revision });
    assert.deepEqual(res.json, {
      ok: false, provider, code: "NOT_CONFIGURED", message: "Connection is not configured", durationMs: 0,
    });
  }
  assert.equal(calls, 0);
  for (const provider of ["deepgram", "attendee", "slack"]) {
    const res = await invoke(handler, "POST", `/api/settings/connections/${provider}/test`, { revision: state.revision });
    assert.equal(res.status, 501);
    assert.equal(res.json.error.code, "TEST_NOT_IMPLEMENTED");
    assert.equal(res.json.error.message, "Settings feature is not implemented");
  }
});

test("connection timeout is five seconds and maps to TIMEOUT", { timeout: 7_000 }, async (t) => {
  const { state } = fixture(t, { stt: { sonioxApiKey: SENTINEL } });
  const startedAt = Date.now();
  const result = await _test.testConnection("soniox", {
    fetchFn: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(_test.CONNECTION_TIMEOUT_MS, 5_000);
  assert.equal(result.code, "TIMEOUT");
  assert.ok(elapsed >= 4_900 && elapsed < 6_500, `elapsed=${elapsed}`);
  assert.match(state.revision, /^[a-f0-9]{64}$/);
});

test("connection limiter is per-provider and the 4 KiB body limit remains enforced", async (t) => {
  const { handler, state } = fixture(t, {
    stt: { sonioxApiKey: SENTINEL }, tts: { apiKey: SENTINEL },
  }, { connections: { fetchFn: async () => new Response("{}", { status: 200 }), minIntervalMs: 1_000 } });
  const soniox = await invoke(handler, "POST", "/api/settings/connections/soniox/test", { revision: state.revision });
  const fish = await invoke(handler, "POST", "/api/settings/connections/fish-audio/test", { revision: state.revision });
  const limited = await invoke(handler, "POST", "/api/settings/connections/soniox/test", { revision: state.revision });
  assert.equal(soniox.status, 200);
  assert.equal(fish.status, 200);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "SETTINGS_CONNECTION_RATE_LIMITED");

  const tooLarge = await invoke(handler, "POST", "/api/settings/connections/soniox/test", "x".repeat(4 * 1024 + 1), { raw: true });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.error.code, "SETTINGS_BODY_TOO_LARGE");
});

test("TTS preview buffers Fish PCM, strips disabled emotion tags, and returns a valid WAV without mutation", async (t) => {
  const vendorCalls = [];
  const pcm = Buffer.from([0, 0, 1, 0, 255, 255, 2, 0]);
  const fallbackFetch = async (_url, options) => {
    vendorCalls.push({ headers: options.headers, body: JSON.parse(options.body) });
    return new Response(pcm, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  };
  const vendor = await localVendor(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    vendorCalls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(pcm);
  }, fallbackFetch);
  const logs = [];
  const { handler, state, directory } = fixture(t, {
    agent: { emotionTags: false },
    tts: { apiKey: SENTINEL, voiceId: "voice-33", model: "s2-pro", sampleRate: 8_000, speed: 1.25, latency: "low" },
  }, { preview: { url: `${vendor.baseUrl}/v1/tts`, fetchFn: vendor.fetchFn }, logger: { info: (line) => logs.push(line) } });
  const before = fs.readFileSync(path.join(directory, "config.json"));
  const res = await invoke(handler, "POST", "/api/settings/tts-preview", {
    revision: state.revision, text: "[soft voice] 接続確認",
  });

  assert.equal(res.status, 200, res.bytes.toString());
  assert.equal(res.headers["Content-Type"], "audio/wav");
  assert.equal(res.headers["Content-Length"], 44 + pcm.length);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(res.bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(res.bytes.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(res.bytes.readUInt16LE(20), 1);
  assert.equal(res.bytes.readUInt16LE(22), 1);
  assert.equal(res.bytes.readUInt32LE(24), 8_000);
  assert.equal(res.bytes.readUInt16LE(34), 16);
  assert.equal(res.bytes.subarray(36, 40).toString("ascii"), "data");
  assert.deepEqual(res.bytes.subarray(44), pcm);
  assert.equal(vendorCalls[0].headers.Authorization || vendorCalls[0].headers.authorization, `Bearer ${SENTINEL}`);
  assert.equal(vendorCalls[0].headers.model, "s2-pro");
  assert.deepEqual(vendorCalls[0].body, {
    text: "接続確認", format: "pcm", sample_rate: 8_000, latency: "low", normalize: true,
    reference_id: "voice-33", speed: 1.25,
  });
  assert.deepEqual(fs.readFileSync(path.join(directory, "config.json")), before);
  assert.equal(readConfigState(path.join(directory, "config.json")).revision, state.revision);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(), ["byteCount", "durationMs", "outcomeCode", "requestId"]);
  assert.equal(logs.join("\n").includes(SENTINEL), false);
  assert.equal(logs.join("\n").includes("接続確認"), false);
});

test("preview enforces strict schema, committed revision, and the 15-second byte cap without partial WAV", async (t) => {
  const overLimit = Buffer.alloc(8_000 * 2 * 15 + 2);
  const { handler, state } = fixture(t, {
    tts: { apiKey: SENTINEL, sampleRate: 8_000 },
  }, { preview: { fetchFn: async () => new Response(overLimit, { status: 200 }) }, logger: { info() {} } });

  const longText = await invoke(handler, "POST", "/api/settings/tts-preview", {
    revision: state.revision, text: "あ".repeat(501),
  });
  assert.equal(longText.status, 422);
  assert.equal(longText.json.error.code, "SETTINGS_VALIDATION_FAILED");

  const badRevision = await invoke(handler, "POST", "/api/settings/tts-preview", { revision: "A".repeat(64), text: "test" });
  assert.equal(badRevision.status, 422);
  const staleRevision = await invoke(handler, "POST", "/api/settings/tts-preview", { revision: "a".repeat(64), text: "test" });
  assert.equal(staleRevision.status, 409);

  const capped = await invoke(handler, "POST", "/api/settings/tts-preview", { revision: state.revision, text: "test" });
  assert.equal(capped.status, 422);
  assert.equal(capped.json.error.code, "SETTINGS_PREVIEW_DURATION_LIMIT");
  assert.equal(capped.bytes.subarray(0, 4).toString("ascii") === "RIFF", false);
});

test("one preview AbortSignal spans retries and timeout returns a value-free 504 with no partial audio", async (t) => {
  let calls = 0;
  const signals = [];
  const logs = [];
  const fetchFn = (_url, options) => {
    calls += 1;
    signals.push(options.signal);
    if (calls < 3) return Promise.resolve(new Response(JSON.stringify({ secret: SENTINEL }), { status: 503 }));
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const { handler, state } = fixture(t, { tts: { apiKey: SENTINEL, sampleRate: 8_000 } }, {
    preview: { url: "http://mock.vendor/v1/tts", fetchFn, timeoutMs: 80, retryBaseMs: 0, retryMax: 2 },
    logger: { info: (line) => logs.push(line) },
  });
  const res = await invoke(handler, "POST", "/api/settings/tts-preview", { revision: state.revision, text: "timeout text" });
  assert.equal(res.status, 504, res.bytes.toString());
  assert.equal(res.json.error.code, "SETTINGS_PREVIEW_TIMEOUT");
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(new Set(signals).size, 1);
  assert.equal(calls, 3);
  assert.equal(logs.join("\n").includes(SENTINEL), false);
  assert.equal(logs.join("\n").includes("timeout text"), false);
  assert.equal(JSON.parse(logs[0]).outcomeCode, "SETTINGS_PREVIEW_TIMEOUT");
});

test("settings UI contains connection explanations and the normative Fish billing notice without secret values", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  assert.match(html, /オペレーター自身の Fish Audio キー／アカウント/);
  assert.match(html, /利用量・料金が発生/);
  assert.match(html, /id="ttsPreviewText"[^>]*maxlength="500"/);
  assert.match(html, /id="ttsPreviewPlayer"/);
  for (const code of ["NOT_CONFIGURED", "AUTH_FAILED", "UNREACHABLE", "TIMEOUT", "RATE_LIMITED", "PROVIDER_ERROR"]) {
    assert.match(js, new RegExp(code));
  }
  assert.doesNotMatch(`${html}\n${js}`, new RegExp(SENTINEL));
});
