"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = module.parent ? require("node:test") : () => {};
const { Readable } = require("node:stream");

const { cacheKey, createTtsCache } = require("../src/tts-cache");
const { lookupManagedPcm, projectClipViews } = require("../src/settings/audio");
const { createSettingsHandler } = require("../src/settings/routes");

const HERMETIC_READINESS = Object.freeze({
  configure() {},
  async probeGateSystems() {},
});
const { initializeRuntime, resetRuntimeForTest } = require("../src/settings/resolver");
const { readConfigState, settingsError } = require("../src/settings/store");

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
const PCM = Buffer.from([10, 11, 12, 13, 14, 15, 16, 17]);
const ORIGIN_HEADERS = {
  host: "localhost:5005",
  origin: "http://localhost:5005",
  "sec-fetch-site": "same-origin",
};

function startup(directory) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: "token", openaiApiKey: "" }),
  });
}

function baseConfig(overrides = {}) {
  return {
    agent: {
      greeting: "こんにちは",
      ackVariants: ["了解です"],
      progressPings: ["処理中です"],
      exitFarewell: "失礼します",
      timeoutFallback: "時間がかかっています",
    },
    tts: { voiceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1, cache: { enabled: true } },
    audio: { clips: [] },
    ...overrides,
  };
}

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = "") { this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); },
  };
}

function request(method, url, body, headers = {}, chunkSize = 0) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  const chunks = [];
  if (chunkSize > 0) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) chunks.push(bytes.subarray(offset, offset + chunkSize));
  } else if (bytes.length) chunks.push(bytes);
  const req = Readable.from(chunks);
  Object.assign(req, {
    method,
    url,
    headers: { ...ORIGIN_HEADERS, ...headers },
    socket: { localAddress: "127.0.0.1", localPort: 5005 },
  });
  return req;
}

function jsonRequest(method, url, value) {
  return request(method, url, JSON.stringify(value), { "content-type": "application/json" });
}

function multipart({
  metadata, audio = MP3, filename = "clip.mp3", audioType = "audio/mpeg",
  metadataType = "application/json; charset=utf-8", extraParts = [],
}, boundary = "meetmate-audio-boundary") {
  const parts = [
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        ...(metadataType === null ? [] : [`Content-Type: ${metadataType}`]),
      ],
      body: Buffer.from(JSON.stringify(metadata)),
    },
    {
      headers: [
        `cOnTeNt-DiSpOsItIoN: form-data; name="audio"; filename="${filename}"`,
        `cOnTeNt-TyPe: ${audioType}`,
      ],
      body: audio,
    },
    ...extraParts,
  ];
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`));
    chunks.push(Buffer.from(part.body));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, bytes: Buffer.concat(chunks) };
}

function fakeSpawn({ pcm = PCM, error = null, stderr = null, capture = null } = {}) {
  return (executable, args, options) => {
    capture?.({ executable, args: [...args], options: { ...options } });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    process.nextTick(() => {
      if (error) {
        child.emit("error", error);
        return;
      }
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      fs.writeFileSync(args.at(-1), pcm);
      child.emit("close", 0, null);
    });
    return child;
  };
}

function fixture(t, document = baseConfig(), handlerOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-settings-audio-"));
  const runtimeStartup = startup(directory);
  fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  resetRuntimeForTest();
  initializeRuntime({ state: readConfigState(runtimeStartup.configPath), startup: runtimeStartup });
  t.after(() => {
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    runtimeStartup,
    handler: createSettingsHandler({
      port: 5005,
      readinessController: HERMETIC_READINESS,
      audio: { spawnFn: fakeSpawn(), ...handlerOptions },
    }),
    revision: readConfigState(runtimeStartup.configPath).revision,
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res);
  return res;
}

async function upload(handler, metadata, options = {}) {
  const body = multipart({ metadata, ...options });
  return invoke(handler, request("POST", "/api/settings/audio", body.bytes, {
    "content-type": `multipart/form-data; boundary=${body.boundary}`,
  }, options.chunkSize || 0));
}

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashDirectory(directory) {
  const hash = crypto.createHash("sha256");
  const visit = (current, relative = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const nextRelative = path.join(relative, entry.name);
      const target = path.join(current, entry.name);
      hash.update(`${entry.isDirectory() ? "d" : "f"}:${nextRelative}\0`);
      if (entry.isDirectory()) visit(target, nextRelative);
      else hash.update(fs.readFileSync(target));
    }
  };
  visit(directory);
  return hash.digest("hex");
}

function clipRecord({
  id = crypto.randomUUID(), role = "ack", text = "了解です", createdAt = "2026-08-27T00:00:00.000Z",
  pcm = PCM, source = MP3, identity = { referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1 },
} = {}) {
  return {
    id,
    role,
    text,
    sourceRelativePath: `assets/settings-audio/${id}.mp3`,
    pcmRelativePath: `assets/settings-audio/${id}.pcm`,
    sourceSha256: sha(source),
    pcmSha256: sha(pcm),
    cacheKey: cacheKey(text, identity),
    referenceId: identity.referenceId,
    model: identity.model,
    sampleRate: identity.sampleRate,
    speed: identity.speed,
    durationMs: Math.ceil((pcm.length * 1000) / (identity.sampleRate * 2)),
    sourceBytes: source.length,
    pcmBytes: pcm.length,
    createdAt,
  };
}

function installClip(directory, clip, source = MP3, pcm = PCM) {
  const managed = path.join(directory, "assets", "settings-audio");
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(directory, clip.sourceRelativePath), source, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, clip.pcmRelativePath), pcm, { mode: 0o600 });
}

function moduleEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

async function waitUntil(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for pipeline audio");
}

test("T12-09 upload streams multipart, converts with an argument array, projects views, stales, and deletes the owned pair", async (t) => {
  const calls = [];
  let conversionDirectoryMode;
  const setup = fixture(t, baseConfig(), { spawnFn: fakeSpawn({ capture: (call) => {
    calls.push(call);
    conversionDirectoryMode = fs.statSync(path.dirname(call.args.at(-1))).mode & 0o777;
  } }) });
  const uploaded = await upload(setup.handler, { role: "ack", text: " 了解です ", revision: setup.revision }, { chunkSize: 3 });
  assert.equal(uploaded.status, 200, uploaded.body);
  const result = JSON.parse(uploaded.body);
  assert.deepEqual(Object.keys(result).sort(), ["clip", "revision"]);
  assert.equal(result.clip.text, "了解です");
  assert.equal(result.clip.stale, false);
  assert.equal(result.clip.playable, true);
  assert.equal(JSON.stringify(result).includes(setup.directory), false);
  assert.deepEqual(calls[0].args.slice(0, 4), ["-nostdin", "-v", "error", "-i"]);
  assert.deepEqual(calls[0].args.slice(5, 11), ["-f", "s16le", "-ac", "1", "-ar", "24000"]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(conversionDirectoryMode, 0o700);

  const sourcePath = path.join(setup.directory, result.clip.sourceRelativePath);
  const pcmPath = path.join(setup.directory, result.clip.pcmRelativePath);
  assert.equal(fs.statSync(sourcePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(pcmPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(sourcePath), MP3);
  assert.deepEqual(fs.readFileSync(pcmPath), PCM);
  const stored = readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips[0];
  assert.equal(Object.hasOwn(stored, "stale"), false);
  assert.equal(Object.hasOwn(stored, "playable"), false);

  let envelope = JSON.parse((await invoke(setup.handler, request("GET", "/api/settings", "", { host: "localhost:5005" }))).body);
  assert.equal(envelope.fields.audio_clips[0].stale, false);
  const changed = await invoke(setup.handler, jsonRequest("PUT", "/api/settings", {
    schemaVersion: 1,
    revision: result.revision,
    fields: { fish_audio_speed: 1.1 },
  }));
  assert.equal(changed.status, 200, changed.body);
  envelope = JSON.parse(changed.body);
  assert.equal(envelope.fields.audio_clips[0].stale, false);

  const deleted = await invoke(setup.handler, jsonRequest("DELETE", `/api/settings/audio/${result.clip.id}`, { revision: envelope.revision }));
  assert.equal(deleted.status, 200, deleted.body);
  assert.deepEqual(Object.keys(JSON.parse(deleted.body)).sort(), ["deleted", "revision"]);
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.existsSync(pcmPath), false);
  assert.deepEqual(readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips, []);
});

test("T12-09 a real generated MP3 converts to mono S16LE at the effective sample rate when ffmpeg is available", async (t) => {
  const available = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("ffmpeg executable is unavailable; real conversion coverage was not run");
    return;
  }

  const setup = fixture(t, baseConfig(), { spawnFn: undefined });
  const generated = path.join(setup.directory, "generated-tone.mp3");
  const result = spawnSync("ffmpeg", [
    "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1",
    "-codec:a", "libmp3lame", "-q:a", "9", generated,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const res = await upload(setup.handler, { role: "ack", text: "了解です", revision: setup.revision }, {
    audio: fs.readFileSync(generated),
  });
  assert.equal(res.status, 200, res.body);
  const clip = JSON.parse(res.body).clip;
  assert.equal(clip.sampleRate, 24_000);
  assert.equal(clip.pcmBytes > 0, true);
  assert.equal(clip.pcmBytes % 2, 0);
  assert.equal(clip.durationMs > 0 && clip.durationMs < 1000, true);
});

test("T12-09 multipart rejects oversize streams, extra parts, filename attacks, wrong MIME, and invalid MP3 signatures without ffmpeg", async (t) => {
  let conversions = 0;
  const setup = fixture(t, baseConfig(), {
    spawnFn: fakeSpawn({ capture: () => { conversions += 1; } }),
  });
  const cases = [
    { expected: 422, options: { filename: "../clip.mp3" } },
    { expected: 422, options: { filename: "clip.mp3\0.mp3" } },
    { expected: 422, options: { filename: "clip.wav" } },
    { expected: 422, options: { filename: "clip.MP3" } },
    { expected: 415, options: { audioType: "audio/wav" } },
    { expected: 422, options: { audio: Buffer.from("not an mp3") } },
    {
      expected: 422,
      options: { extraParts: [{ headers: ['Content-Disposition: form-data; name="extra"'], body: Buffer.from("x") }] },
    },
  ];
  for (const entry of cases) {
    const res = await upload(setup.handler, { role: "ack", text: "了解です", revision: setup.revision }, entry.options);
    assert.equal(res.status, entry.expected, res.body);
  }

  const oversize = await upload(setup.handler, { role: "ack", text: "了解です", revision: setup.revision }, {
    audio: Buffer.concat([MP3, Buffer.alloc(10 * 1024 * 1024 + 1 - MP3.length)]),
    chunkSize: 64 * 1024,
  });
  assert.equal(oversize.status, 413, oversize.body);
  assert.equal(conversions, 0);
  const managed = path.join(setup.directory, "assets", "settings-audio");
  assert.deepEqual(fs.readdirSync(managed), []);
});

test("T12-09 metadata is strict, UTF-8, trimmed, SHA-only, and exactly one file plus one field", async (t) => {
  const setup = fixture(t);
  for (const metadata of [
    { role: "other", text: "了解です", revision: setup.revision },
    { role: "ack", text: " ", revision: setup.revision },
    { role: "ack", text: "了解です", revision: "bootstrap" },
    { role: "ack", text: "了解です", revision: setup.revision, model: "client-model" },
  ]) {
    const res = await upload(setup.handler, metadata);
    assert.equal(res.status, 422, res.body);
  }
  const duplicate = multipart({
    metadata: { role: "ack", text: "了解です", revision: setup.revision },
    extraParts: [{ headers: ['Content-Disposition: form-data; name="metadata"'], body: Buffer.from("{}") }],
  });
  const res = await invoke(setup.handler, request("POST", "/api/settings/audio", duplicate.bytes, {
    "content-type": `multipart/form-data; boundary=${duplicate.boundary}`,
  }));
  assert.equal(res.status, 422, res.body);

  for (const [metadataType, expected] of [
    [null, 200], ["application/json; charset=utf-8", 200], ['application/json; profile="settings"', 200], ["text/plain", 415],
  ]) {
    const currentRevision = readConfigState(setup.runtimeStartup.configPath).revision;
    const typed = await upload(setup.handler, { role: "ack", text: `形式-${expected}-${metadataType}`, revision: currentRevision }, { metadataType });
    assert.equal(typed.status, expected, `${metadataType}: ${typed.body}`);
  }
});

test("T12-09 accepts schema-maximum four-byte UTF-8 metadata text", async (t) => {
  const setup = fixture(t);
  const text = "😀".repeat(4096);
  const res = await upload(setup.handler, { role: "ack", text, revision: setup.revision });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).clip.text, text);
});

test("T12-09 ffmpeg missing, stderr, odd PCM, duration overflow, and commit failure clean all temporaries and installed files", async (t) => {
  const variants = [
    { name: "missing", spawnFn: fakeSpawn({ error: new Error("ENOENT") }), expected: 422 },
    { name: "stderr", spawnFn: fakeSpawn({ stderr: "conversion error" }), expected: 422 },
    { name: "odd", spawnFn: fakeSpawn({ pcm: Buffer.from([1]) }), expected: 422 },
    { name: "duration", spawnFn: fakeSpawn({ pcm: Buffer.alloc(24_000 * 2 * 30 + 2) }), expected: 413 },
    {
      name: "timeout",
      spawnFn: () => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        return child;
      },
      ffmpegTimeoutMs: 5,
      expected: 422,
    },
  ];
  for (const variant of variants) {
    const setup = fixture(t, baseConfig(), { spawnFn: variant.spawnFn, ffmpegTimeoutMs: variant.ffmpegTimeoutMs });
    const res = await upload(setup.handler, { role: "ack", text: "了解です", revision: setup.revision });
    assert.equal(res.status, variant.expected, `${variant.name}: ${res.body}`);
    assert.deepEqual(fs.readdirSync(path.join(setup.directory, "assets", "settings-audio")), []);
    assert.deepEqual(readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips, []);
  }

  const rollback = fixture(t, baseConfig(), {
    saveAudioClipsFn() { throw settingsError("SETTINGS_TRANSACTION_FAILED", "failed", 500); },
  });
  const failed = await upload(rollback.handler, { role: "ack", text: "了解です", revision: rollback.revision });
  assert.equal(failed.status, 500, failed.body);
  assert.deepEqual(fs.readdirSync(path.join(rollback.directory, "assets", "settings-audio")), []);
  assert.deepEqual(readConfigState(rollback.runtimeStartup.configPath).parsed.audio.clips, []);
});

test("T12-09 stale revisions fail upload and delete without changing config or files", async (t) => {
  const setup = fixture(t);
  const staleUpload = await upload(setup.handler, { role: "ack", text: "了解です", revision: "a".repeat(64) });
  assert.equal(staleUpload.status, 409, staleUpload.body);
  const good = await upload(setup.handler, { role: "ack", text: "了解です", revision: setup.revision });
  assert.equal(good.status, 200, good.body);
  const clip = JSON.parse(good.body).clip;
  const staleDelete = await invoke(setup.handler, jsonRequest("DELETE", `/api/settings/audio/${clip.id}`, { revision: setup.revision }));
  assert.equal(staleDelete.status, 409, staleDelete.body);
  assert.equal(fs.existsSync(path.join(setup.directory, clip.sourceRelativePath)), true);
  assert.equal(fs.existsSync(path.join(setup.directory, clip.pcmRelativePath)), true);
  assert.equal(readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips.length, 1);
});

test("T12-09 32-clip and 128-MiB caps reject before conversion", async (t) => {
  let conversions = 0;
  const full = Array.from({ length: 32 }, () => clipRecord());
  const clipCap = fixture(t, baseConfig({ audio: { clips: full } }), {
    spawnFn: fakeSpawn({ capture: () => { conversions += 1; } }),
  });
  let res = await upload(clipCap.handler, { role: "ack", text: "了解です", revision: clipCap.revision });
  assert.equal(res.status, 413, res.body);

  const huge = clipRecord();
  huge.sourceBytes = 100 * 1024 * 1024;
  huge.pcmBytes = 28 * 1024 * 1024;
  const byteCap = fixture(t, baseConfig({ audio: { clips: [huge] } }), {
    spawnFn: fakeSpawn({ capture: () => { conversions += 1; } }),
  });
  res = await upload(byteCap.handler, { role: "ack", text: "了解です", revision: byteCap.revision });
  assert.equal(res.status, 413, res.body);
  assert.equal(conversions, 0);
});

test("T12-09 resolved-home storage never mutates bundled assets and rejects a managed-directory symlink", async (t) => {
  const packageAssets = path.join(__dirname, "..", "assets");
  const before = hashDirectory(packageAssets);
  const setup = fixture(t);
  const uploaded = await upload(setup.handler, { role: "ack", text: "了解です", revision: setup.revision });
  assert.equal(uploaded.status, 200, uploaded.body);
  const clip = JSON.parse(uploaded.body).clip;
  assert.equal(path.resolve(setup.directory, clip.sourceRelativePath).startsWith(path.resolve(setup.directory) + path.sep), true);
  assert.equal(hashDirectory(packageAssets), before);

  const symlinkHome = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-audio-symlink-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-audio-external-"));
  t.after(() => {
    fs.rmSync(symlinkHome, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(symlinkHome, "assets"));
  fs.symlinkSync(external, path.join(symlinkHome, "assets", "settings-audio"));
  const symlinkSetup = startup(symlinkHome);
  fs.writeFileSync(symlinkSetup.configPath, `${JSON.stringify(baseConfig())}\n`, { mode: 0o600 });
  resetRuntimeForTest();
  initializeRuntime({ state: readConfigState(symlinkSetup.configPath), startup: symlinkSetup });
  const handler = createSettingsHandler({
    port: 5005,
    readinessController: HERMETIC_READINESS,
    audio: { spawnFn: fakeSpawn() },
  });
  const blocked = await upload(handler, { role: "ack", text: "了解です", revision: readConfigState(symlinkSetup.configPath).revision });
  assert.equal(blocked.status, 422, blocked.body);
  assert.deepEqual(fs.readdirSync(external), []);
});

test("T12-09 delete refuses symlink and out-of-root metadata without deleting unrelated files", async (t) => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-audio-owned-external-"));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const outside = path.join(external, "outside.pcm");
  fs.writeFileSync(outside, PCM);

  const clip = clipRecord();
  const setup = fixture(t, baseConfig({ audio: { clips: [clip] } }));
  installClip(setup.directory, clip);
  fs.unlinkSync(path.join(setup.directory, clip.pcmRelativePath));
  fs.symlinkSync(outside, path.join(setup.directory, clip.pcmRelativePath));
  let res = await invoke(setup.handler, jsonRequest("DELETE", `/api/settings/audio/${clip.id}`, { revision: setup.revision }));
  assert.equal(res.status, 422, res.body);
  assert.equal(fs.existsSync(outside), true);
  assert.equal(readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips.length, 1);

  const escaped = clipRecord();
  escaped.sourceRelativePath = path.relative(setup.directory, path.join(external, "outside.mp3"));
  fs.writeFileSync(path.join(external, "outside.mp3"), MP3);
  fs.writeFileSync(setup.runtimeStartup.configPath, `${JSON.stringify(baseConfig({ audio: { clips: [escaped] } }))}\n`, { mode: 0o600 });
  resetRuntimeForTest();
  initializeRuntime({ state: readConfigState(setup.runtimeStartup.configPath), startup: setup.runtimeStartup });
  res = await invoke(setup.handler, jsonRequest("DELETE", `/api/settings/audio/${escaped.id}`, {
    revision: readConfigState(setup.runtimeStartup.configPath).revision,
  }));
  assert.equal(res.status, 422, res.body);
  assert.equal(fs.existsSync(path.join(external, "outside.mp3")), true);
});

test("T12-09 delete commits when owned files are already missing", async (t) => {
  const clip = clipRecord();
  const setup = fixture(t, baseConfig({ audio: { clips: [clip] } }));
  installClip(setup.directory, clip);
  fs.unlinkSync(path.join(setup.directory, clip.sourceRelativePath));
  fs.unlinkSync(path.join(setup.directory, clip.pcmRelativePath));

  const res = await invoke(setup.handler, jsonRequest("DELETE", `/api/settings/audio/${clip.id}`, { revision: setup.revision }));
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips, []);
});

test("T12-09 delete cleanup failure is reported after commit and touches no unrelated file", async (t) => {
  const clip = clipRecord();
  const setup = fixture(t, baseConfig({ audio: { clips: [clip] } }));
  installClip(setup.directory, clip);
  const unrelated = path.join(setup.directory, "unrelated.txt");
  fs.writeFileSync(unrelated, "keep");
  const sourcePath = path.join(setup.directory, clip.sourceRelativePath);
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (path.resolve(target) === path.resolve(sourcePath)) {
      const error = new Error("synthetic cleanup failure");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    const res = await invoke(setup.handler, jsonRequest("DELETE", `/api/settings/audio/${clip.id}`, { revision: setup.revision }));
    assert.equal(res.status, 500, res.body);
    assert.equal(JSON.parse(res.body).error.code, "SETTINGS_AUDIO_CLEANUP_FAILED");
    assert.deepEqual(readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips, []);
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  } finally {
    fs.unlinkSync = originalUnlink;
  }
});

test("T12-09 invalid stored clips remain verbatim while valid-subset upload succeeds", async (t) => {
  const invalid = { id: "operator-invalid", nested: { keep: [1, "two"] } };
  const setup = fixture(t, baseConfig({ audio: { clips: [invalid] } }));
  const res = await upload(setup.handler, { role: "ack", text: "了解です", revision: setup.revision });
  assert.equal(res.status, 200, res.body);
  const stored = readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips;
  assert.deepEqual(stored[0], invalid);
  assert.equal(stored.length, 2);
  const envelope = JSON.parse((await invoke(setup.handler, request("GET", "/api/settings", "", { host: "localhost:5005" }))).body);
  assert.equal(envelope.fields.audio_clips.length, 1);
});

test("T12-09 runtime chooses newest then lexical id and works without any seeder artifact", async (t) => {
  const oldestId = "00000000-0000-4000-8000-000000000000";
  const lowId = "00000000-0000-4000-8000-000000000001";
  const highId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const firstPcm = Buffer.from([1, 2, 3, 4]);
  const secondPcm = Buffer.from([5, 6, 7, 8]);
  const first = clipRecord({ id: highId, pcm: firstPcm, createdAt: "2026-08-27T01:00:00.000Z" });
  const second = clipRecord({ id: lowId, pcm: secondPcm, createdAt: "2026-08-27T01:00:00.000Z" });
  const oldest = clipRecord({ id: oldestId, pcm: Buffer.from([20, 21, 22, 23]), createdAt: "2026-08-27T00:00:00.000Z" });
  const document = baseConfig({ audio: { clips: [oldest, first, second] } });
  document.agent.progressPings = ["了解です"];
  const setup = fixture(t, document);
  installClip(setup.directory, oldest, MP3, Buffer.from([20, 21, 22, 23]));
  installClip(setup.directory, first, MP3, firstPcm);
  installClip(setup.directory, second, MP3, secondPcm);

  const selected = lookupManagedPcm({
    role: "ack", text: "了解です", referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1,
  });
  assert.equal(selected.clip.id, lowId);
  assert.deepEqual(selected.pcm, secondPcm);
  assert.equal(lookupManagedPcm({
    role: "progress", text: "了解です", referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1,
  }), null);

  const cacheDir = path.join(setup.directory, "assets", "tts-cache-never-seeded");
  let syntheses = 0;
  const cache = createTtsCache({
    dir: cacheDir,
    synthesizeFn: async (_text, options) => { syntheses += 1; options.onAudio(Buffer.from([9, 10])); },
  });
  const emitted = [];
  await cache.synthesize("了解です", {
    role: "ack", referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1,
    onAudio: (chunk) => emitted.push(Buffer.from(chunk)),
  });
  assert.equal(syntheses, 0);
  assert.deepEqual(Buffer.concat(emitted), secondPcm);
  assert.equal(fs.existsSync(cacheDir), false);
});

test("T12-09 the real pipeline forwards all five fixed phrase roles to the cache boundary", async () => {
  const src = path.join(__dirname, "..", "src");
  const modulePaths = ["stt-provider.js", "stt.js", "llm-provider.js", "tts-fish.js", "tts-cache.js", "pipeline.js"]
    .map((name) => path.join(src, name));
  const previous = new Map(modulePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of modulePaths) delete require.cache[require.resolve(file)];
  const envNames = [
    "ENABLE_IMMEDIATE_ACK", "ENABLE_PROGRESS_GUARD", "POST_UTTERANCE_BUFFER_MS",
    "PROGRESS_PING_INTERVAL_MS", "PROGRESS_PING_MAX", "TTS_GAP_MS", "SENTENCE_PAUSE_MS",
  ];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    ENABLE_IMMEDIATE_ACK: "true",
    ENABLE_PROGRESS_GUARD: "true",
    POST_UTTERANCE_BUFFER_MS: "0",
    PROGRESS_PING_INTERVAL_MS: "5",
    PROGRESS_PING_MAX: "1",
    TTS_GAP_MS: "0",
    SENTENCE_PAUSE_MS: "0",
  });
  let stt;
  let pipeline;
  const roles = [];
  const sttMock = {
    createSTT() {
      stt = new EventEmitter();
      stt.send = () => {};
      stt.close = () => {};
      return stt;
    },
    buildKeyterms: () => [],
  };
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = moduleEntry(path.join(src, "stt-provider.js"), sttMock);
  require.cache[require.resolve(path.join(src, "stt.js"))] = moduleEntry(path.join(src, "stt.js"), sttMock);
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = moduleEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      streamChat: async function* (_messages, options) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 100);
          options.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      },
      VOICE_SYSTEM_ADDENDUM: "",
      buildVoiceAddendum: () => "",
    }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = moduleEntry(path.join(src, "tts-fish.js"), {
    synthesize: async () => { throw new Error("fixed ack must use the cache boundary"); },
  });
  require.cache[require.resolve(path.join(src, "tts-cache.js"))] = moduleEntry(path.join(src, "tts-cache.js"), {
    createTtsCache: () => ({
      synthesize: async (_text, options) => { roles.push(options.role); options.onAudio(Buffer.alloc(2)); },
      prewarm: async () => {},
    }),
  });
  try {
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    pipeline = createPipeline(
      { id: "audio-role-pipeline", conversationLog: [], config: { wakeMode: "wake" } },
      { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 },
      () => {},
      {
        dgKey: "x", fishKey: "x", openclawUrl: "http://localhost:9", openclawToken: "x",
        stt: { model: "test", language: "ja", sampleRate: 16_000 },
        llm: {
          model: "test", temperature: 0.5, maxTokens: 100, responseTimeoutMs: 30,
          firstTokenDelegateMs: 0, openclawSystemAddendum: "",
        },
        tts: { referenceId: null, sampleRate: 24_000, latency: "balanced", speed: 1 },
        ackVariants: ["了解です"], progressPings: ["処理中です"], timeoutFallback: "時間がかかっています",
        exitFarewell: "退出します", echoCooldownMs: 1, greeting: "こんにちは", exitDetection: true,
      },
      { agents: { caty: { wakeWords: ["ケイティ"] } }, selectedAgentIds: ["caty"], defaultAgentId: "caty" },
    );
    await waitUntil(() => roles.includes("greeting"), 3000);
    stt.emit("utterance_end", "ケイティ、確認して");
    await waitUntil(() => ["ack", "progress", "timeout"].every((role) => roles.includes(role)), 2000);
    stt.emit("utterance_end", "ケイティ、退出して");
    await waitUntil(() => roles.includes("farewell"), 2000);
    assert.deepEqual([...new Set(roles)], ["greeting", "ack", "progress", "timeout", "farewell"]);
  } finally {
    pipeline?.close();
    for (const file of modulePaths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      if (previous.get(resolved)) require.cache[resolved] = previous.get(resolved);
    }
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("T12-09 clip views become stale for text, reference, model, rate, and speed mismatches", (t) => {
  const clip = clipRecord();
  const setup = fixture(t, baseConfig({ audio: { clips: [clip] } }));
  installClip(setup.directory, clip);
  const identity = { referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1 };
  assert.equal(projectClipViews([clip], setup.directory, identity)[0].stale, false);
  for (const [label, record, nextIdentity] of [
    ["text", { ...clip, text: "別の文" }, identity],
    ["reference", clip, { ...identity, referenceId: "voice-b" }],
    ["model", clip, { ...identity, model: "s1" }],
    ["rate", clip, { ...identity, sampleRate: 16_000 }],
    ["speed", clip, { ...identity, speed: 1.1 }],
  ]) {
    assert.equal(projectClipViews([record], setup.directory, nextIdentity)[0].stale, true, label);
  }
});

test("T12-09 pending restart TTS edits keep running-format clips current until restart", async (t) => {
  const setup = fixture(t);
  const changed = await invoke(setup.handler, jsonRequest("PUT", "/api/settings", {
    schemaVersion: 1,
    revision: setup.revision,
    fields: { fish_audio_speed: 1.1 },
  }));
  assert.equal(changed.status, 200, changed.body);
  const changedEnvelope = JSON.parse(changed.body);
  const uploaded = await upload(setup.handler, { role: "ack", text: "了解です", revision: changedEnvelope.revision });
  assert.equal(uploaded.status, 200, uploaded.body);
  const clip = JSON.parse(uploaded.body).clip;
  assert.equal(clip.speed, 1);
  assert.equal(clip.stale, false);
  assert.equal(lookupManagedPcm({
    role: "ack", text: "了解です", referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1,
  }).clip.id, clip.id);

  const committed = readConfigState(setup.runtimeStartup.configPath);
  resetRuntimeForTest();
  initializeRuntime({ state: committed, startup: setup.runtimeStartup });
  const afterRestart = JSON.parse((await invoke(setup.handler, request("GET", "/api/settings", "", { host: "localhost:5005" }))).body);
  assert.equal(afterRestart.fields.audio_clips[0].stale, true);
  assert.equal(lookupManagedPcm({
    role: "ack", text: "了解です", referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1,
  }), null);
});

test("T12-09 stale, missing, hash-invalid, invalid PCM, and playback errors fall back without deleting records", async (t) => {
  const variants = [
    { name: "stale", mutate(clip) { clip.cacheKey = "a".repeat(64); } },
    { name: "missing", install: false },
    { name: "hash", pcm: Buffer.from([8, 8, 8, 8]) },
    { name: "odd", pcm: Buffer.from([1]) },
  ];
  for (const variant of variants) {
    const clip = clipRecord();
    variant.mutate?.(clip);
    const setup = fixture(t, baseConfig({ audio: { clips: [clip] } }));
    if (variant.install !== false) installClip(setup.directory, clip, MP3, variant.pcm || PCM);
    let syntheses = 0;
    const emitted = [];
    const cache = createTtsCache({
      dir: path.join(setup.directory, "cache"),
      synthesizeFn: async (_text, options) => { syntheses += 1; options.onAudio(Buffer.from([9, 10])); },
    });
    await cache.synthesize("了解です", {
      role: "ack", referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1,
      onAudio: (chunk) => emitted.push(Buffer.from(chunk)),
    });
    assert.equal(syntheses, 1, variant.name);
    assert.deepEqual(Buffer.concat(emitted), Buffer.from([9, 10]), variant.name);
    assert.equal(readConfigState(setup.runtimeStartup.configPath).parsed.audio.clips.length, 1, variant.name);
  }

  const clip = clipRecord();
  const playback = fixture(t, baseConfig({ audio: { clips: [clip] } }));
  installClip(playback.directory, clip);
  let syntheses = 0;
  let calls = 0;
  const cache = createTtsCache({
    dir: path.join(playback.directory, "cache"),
    synthesizeFn: async (_text, options) => { syntheses += 1; options.onAudio(Buffer.from([9, 10])); },
  });
  await cache.synthesize("了解です", {
    role: "ack", referenceId: "voice-a", model: "s2-pro", sampleRate: 24_000, speed: 1,
    onAudio: () => { calls += 1; if (calls === 1) throw new Error("playback failed"); },
  });
  assert.equal(syntheses, 1);
  assert.equal(calls, 2);
  assert.equal(readConfigState(playback.runtimeStartup.configPath).parsed.audio.clips.length, 1);
});

test("T12-09 UI helper identifies E29-03 phrase mismatch without paths", () => {
  const { clipMatchesCurrentText } = require("../public/settings.js");
  const fields = {
    agent_ack_variants: ["了解です"],
    agent_progress_pings: ["処理中です"],
    agent_greeting: "こんにちは",
    agent_exit_farewell: "失礼します",
    agent_timeout_fallback: "時間がかかっています",
  };
  assert.equal(clipMatchesCurrentText({ role: "ack", text: "了解です" }, fields), true);
  assert.equal(clipMatchesCurrentText({ role: "ack", text: "違う文" }, fields), false);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  const pipeline = fs.readFileSync(path.join(__dirname, "..", "src", "pipeline.js"), "utf8");
  assert.match(html, /id="audioRole"/);
  assert.match(html, /id="audioFile"/);
  assert.match(html, /id="audioClipList"/);
  assert.match(js, /警告: クリップの文言が現在の設定文と一致しない/);
  assert.match(js, /stale クリップ/);
  assert.doesNotMatch(`${html}\n${js}`, /sourceRelativePath|pcmRelativePath/);
  for (const role of ["ack", "progress", "greeting", "farewell", "timeout"]) {
    assert.match(pipeline, new RegExp(`role: "${role}"`));
  }
});
