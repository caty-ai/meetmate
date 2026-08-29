"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = module.parent ? require("node:test") : () => {};
const { Readable } = require("node:stream");

const { parseMultipart } = require("../src/settings/multipart");
const { createSettingsHandler } = require("../src/settings/routes");
const { buildEnvelope, getEffectiveValue, initializeRuntime, resetRuntimeForTest } = require("../src/settings/resolver");
const { readConfigState } = require("../src/settings/store");

const ORIGIN_HEADERS = {
  host: "localhost:5005",
  origin: "http://localhost:5005",
  "sec-fetch-site": "same-origin",
};

const HERMETIC_READINESS = Object.freeze({ configure() {}, async probeGateSystems() {} });

function png(width = 256, height = 256, dataBytes = 0) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const chunks = [signature, ihdr];
  if (dataBytes > 0) {
    const idat = Buffer.alloc(12 + dataBytes);
    idat.writeUInt32BE(dataBytes, 0);
    idat.write("IDAT", 4, "ascii");
    chunks.push(idat);
  }
  chunks.push(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  return Buffer.concat(chunks);
}

function multipart(parts, boundary = "meetmate-avatar-boundary", trailing = Buffer.alloc(0)) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`));
    chunks.push(Buffer.from(part.body));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`), trailing);
  return { boundary, bytes: Buffer.concat(chunks) };
}

function imageMultipart(bytes = png(), options = {}) {
  return multipart([{
    headers: [
      `Content-Disposition: form-data; name="${options.partName || "image"}"; filename="${options.filename || "avatar.png"}"`,
      `Content-Type: ${options.contentType || "image/png"}`,
      ...(options.extraHeaders || []),
    ],
    body: bytes,
  }, ...(options.extraParts || [])], options.boundary, options.trailing);
}

function request(method, url, body = Buffer.alloc(0), headers = {}, chunkSize = 0) {
  const bytes = Buffer.from(body);
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

function response() {
  return {
    status: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = Buffer.alloc(0)) { this.body = Buffer.concat([this.body, Buffer.from(chunk)]); },
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res);
  return res;
}

function startup(directory) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: directory,
    configPath: path.join(directory, "config.json"),
    connection: Object.freeze({ openclawUrl: "https://gateway.example", openclawToken: "token", openaiApiKey: "" }),
  });
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-settings-avatar-"));
  const runtimeStartup = startup(directory);
  fs.writeFileSync(runtimeStartup.configPath, `${JSON.stringify({
    agent: { avatarUrl: options.avatarUrl || "" },
    avatar: { experiment: options.avatarExperiment || "" },
  })}\n`, { mode: 0o600 });
  resetRuntimeForTest();
  initializeRuntime({ state: readConfigState(runtimeStartup.configPath), startup: runtimeStartup, serverPort: 5005 });
  let clock = 10_000;
  const handler = createSettingsHandler({
    port: 5005,
    readinessController: HERMETIC_READINESS,
    avatar: { now: () => clock, minIntervalMs: 1_000 },
  });
  t.after(() => {
    resetRuntimeForTest();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, handler, advance(ms = 1_000) { clock += ms; } };
}

async function upload(handler, url, bytes = png(), options = {}) {
  const body = imageMultipart(bytes, options);
  return invoke(handler, request("POST", url, body.bytes, {
    "content-type": `multipart/form-data; boundary=${body.boundary}`,
    ...(options.headers || {}),
  }, options.chunkSize || 0));
}

function parserOptions(overrides = {}) {
  return {
    filePartName: "image",
    metadataPartName: null,
    contentTypes: ["image/png"],
    extensions: [".png"],
    encodedRejectPattern: /%[0-9a-f]{2}/i,
    maxFileBytes: 64,
    maxMetadataBytes: 0,
    errorFactory(reason, status) {
      const error = new Error(reason);
      error.reason = reason;
      error.status = status;
      return error;
    },
    ...overrides,
  };
}

async function directParse(directory, body, options = parserOptions(), chunkSize = 0) {
  return parseMultipart(request("POST", "/direct", body.bytes, {
    "content-type": `multipart/form-data; boundary=${body.boundary}`,
  }, chunkSize), directory, options);
}

test("avatar multipart requires its complete explicit option tuple", async () => {
  await assert.rejects(() => parseMultipart({ headers: {} }, "/tmp", {}), TypeError);
  const missingPattern = parserOptions();
  delete missingPattern.encodedRejectPattern;
  await assert.rejects(() => parseMultipart({ headers: {} }, "/tmp", missingPattern), TypeError);
});

test("avatar multipart direct parser locks boundary, header, filename, part, MIME, cap, and trailing-byte rejections", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-avatar-multipart-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parsed = await directParse(directory, imageMultipart(Buffer.from([1, 2, 3]), { contentType: "ImAgE/PnG" }));
  assert.equal(parsed.fileBytes, 3);
  fs.unlinkSync(parsed.filePath);

  for (const boundary of ["", "x".repeat(71), "bad boundary"]) {
    const body = imageMultipart(Buffer.from([1]), { boundary: boundary || undefined });
    const req = request("POST", "/direct", body.bytes, {
      "content-type": boundary === "" ? "multipart/form-data" : `multipart/form-data; boundary=${boundary}`,
    });
    await assert.rejects(() => parseMultipart(req, directory, parserOptions()), (error) => error.status === 415);
  }

  const longHeader = imageMultipart(Buffer.from([1]), { extraHeaders: [`X-Fill: ${"x".repeat(16 * 1024)}`] });
  await assert.rejects(() => directParse(directory, longHeader), (error) => error.status === 422);
  for (const filename of ["bad\0.png", "../bad.png", "bad/name.png", "bad\\name.png", "bad%2ename.png", "bad%41name.png", "bad%252ename.png"]) {
    await assert.rejects(() => directParse(directory, imageMultipart(Buffer.from([1]), { filename })), (error) => error.status === 422);
  }
  const audioEncoded = multipart([
    { headers: ['Content-Disposition: form-data; name="metadata"', "Content-Type: application/json"], body: Buffer.from("{}") },
    { headers: ['Content-Disposition: form-data; name="audio"; filename="my%20clip.mp3"', "Content-Type: audio/mpeg"], body: Buffer.from([1, 2]) },
  ]);
  const audioParsed = await directParse(directory, audioEncoded, parserOptions({
    filePartName: "audio",
    metadataPartName: "metadata",
    contentTypes: ["audio/mpeg"],
    extensions: [".mp3"],
    encodedRejectPattern: /%(?:00|2e|2f|5c)/i,
    maxMetadataBytes: 16,
  }));
  assert.equal(audioParsed.fileBytes, 2);
  fs.unlinkSync(audioParsed.filePath);
  await assert.rejects(() => directParse(directory, imageMultipart(Buffer.from([1]), { partName: "file" })), (error) => error.status === 422);
  await assert.rejects(() => directParse(directory, imageMultipart(Buffer.from([1]), {
    extraParts: [{ headers: ['Content-Disposition: form-data; name="image"; filename="two.png"', "Content-Type: image/png"], body: Buffer.from([2]) }],
  })), (error) => error.status === 422);
  await assert.rejects(() => directParse(directory, multipart([])), (error) => error.status === 422);
  await assert.rejects(() => directParse(directory, imageMultipart(Buffer.from([1]), { contentType: "image/jpeg" })), (error) => error.status === 415);
  await assert.rejects(() => directParse(directory, imageMultipart(Buffer.alloc(65)), parserOptions(), 7), (error) => error.status === 413);
  await assert.rejects(() => directParse(directory, imageMultipart(Buffer.from([1]), { trailing: Buffer.from("x") })), (error) => error.status === 422);

  const metadataOptions = parserOptions({ metadataPartName: "metadata", maxMetadataBytes: 2 });
  const withMetadata = multipart([
    { headers: ['Content-Disposition: form-data; name="metadata"', "Content-Type: application/json"], body: Buffer.from("{}x") },
    { headers: ['Content-Disposition: form-data; name="image"; filename="ok.png"', "Content-Type: image/png"], body: Buffer.from([1]) },
  ]);
  await assert.rejects(() => directParse(directory, withMetadata, metadataOptions), (error) => error.reason === "METADATA_TOO_LARGE");
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("avatar routes upload fixed destinations, expose offline provenance, harden previews, and delete", async (t) => {
  const setup = fixture(t, { avatarUrl: "https://example.invalid/avatar.png" });
  const bytes = png(320, 240);
  const uploaded = await upload(setup.handler, "/api/settings/avatar/static", bytes, { filename: "discard-me.png", chunkSize: 3 });
  assert.equal(uploaded.status, 200, uploaded.body.toString());
  const result = JSON.parse(uploaded.body);
  assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.static.sha256, result.sha256);
  assert.deepEqual(fs.readFileSync(path.join(setup.directory, "assets", "avatar.png")), bytes);
  assert.equal(fs.existsSync(path.join(setup.directory, "assets", "discard-me.png")), false);
  assert.equal(fs.readFileSync(path.join(setup.directory, "assets", ".avatar-source"), "utf8"), "uploaded\n");
  assert.equal(fs.statSync(path.join(setup.directory, "assets", "avatar.png")).mode & 0o777, 0o600);

  const inspected = await invoke(setup.handler, request("GET", "/api/settings/avatar", Buffer.alloc(0), { origin: undefined }));
  assert.equal(inspected.status, 200);
  assert.equal(JSON.parse(inspected.body).static.source, "uploaded");
  assert.equal(JSON.parse(inspected.body).rig.scriptBytes > 0, true);

  const preview = await invoke(setup.handler, request("GET", "/api/settings/avatar/static/preview"));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["Content-Type"], "image/png");
  assert.equal(preview.headers["Cache-Control"], "no-store");
  assert.equal(preview.headers["X-Content-Type-Options"], "nosniff");
  assert.deepEqual(preview.body, bytes);

  const deleted = await invoke(setup.handler, request("DELETE", "/api/settings/avatar/static"));
  assert.equal(deleted.status, 200, deleted.body.toString());
  assert.equal(fs.existsSync(path.join(setup.directory, "assets", "avatar.png")), false);
  assert.equal(fs.existsSync(path.join(setup.directory, "assets", ".avatar-source")), false);
  assert.equal(JSON.parse((await invoke(setup.handler, request("GET", "/api/settings/avatar"))).body).static.source, "bundled");
});

test("invalid stored avatar experiment reports VALUE_INVALID and resolves to the static default", (t) => {
  fixture(t, { avatarExperiment: "hand-edited-invalid-mode" });
  assert.equal(getEffectiveValue("avatar_experiment"), "");
  assert.deepEqual(
    buildEnvelope().issues.find((issue) => issue.fieldId === "avatar_experiment"),
    { fieldId: "avatar_experiment", code: "VALUE_INVALID" },
  );
});

test("avatar frame routes use the six-name allowlist and conceal traversal and unsafe previews", async (t) => {
  const setup = fixture(t);
  const frame = png(720, 720);
  const uploaded = await upload(setup.handler, "/api/settings/avatar/frames/idle", frame, { filename: "client-name.png" });
  assert.equal(uploaded.status, 200, uploaded.body.toString());
  assert.deepEqual(fs.readFileSync(path.join(setup.directory, "assets", "avatar-frames", "idle.png")), frame);
  setup.advance();
  for (const invalid of ["talk4", "../idle", "%2e%2e", "%252e%252e"]) {
    const res = await upload(setup.handler, `/api/settings/avatar/frames/${invalid}`, frame);
    assert.equal(res.status, 404, `${invalid}: ${res.body}`);
  }
  const preview = await invoke(setup.handler, request("GET", "/api/settings/avatar/frames/idle/preview"));
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, frame);

  const external = path.join(setup.directory, "external.png");
  fs.writeFileSync(external, frame);
  fs.unlinkSync(path.join(setup.directory, "assets", "avatar-frames", "idle.png"));
  fs.symlinkSync(external, path.join(setup.directory, "assets", "avatar-frames", "idle.png"));
  const concealed = await invoke(setup.handler, request("GET", "/api/settings/avatar/frames/idle/preview"));
  assert.equal(concealed.status, 404);
  assert.equal(JSON.parse(concealed.body).error.code, "SETTINGS_AVATAR_NOT_FOUND");

  fs.unlinkSync(path.join(setup.directory, "assets", "avatar-frames", "idle.png"));
  fs.writeFileSync(path.join(setup.directory, "assets", "avatar-frames", "idle.png"), Buffer.from("not a png"));
  const rejectedBytes = await invoke(setup.handler, request("GET", "/api/settings/avatar/frames/idle/preview"));
  assert.equal(rejectedBytes.status, 404);
  assert.equal(JSON.parse(rejectedBytes.body).error.code, "SETTINGS_AVATAR_NOT_FOUND");
});

test("avatar mutation chokepoint, loopback concealment, PNG gates, total cap, and independent limiter fail closed", async (t) => {
  const setup = fixture(t);
  let body = imageMultipart(png());
  let req = request("POST", "/api/settings/avatar/static", body.bytes, {
    "content-type": `multipart/form-data; boundary=${body.boundary}`,
    origin: undefined,
  });
  let res = await invoke(setup.handler, req);
  assert.equal(res.status, 403);

  req = request("POST", "/api/settings/avatar/static", body.bytes, {
    "content-type": `multipart/form-data; boundary=${body.boundary}`,
    "x-forwarded-for": "127.0.0.1",
  });
  res = await invoke(setup.handler, req);
  assert.equal(res.status, 404);

  req = request("POST", "/api/settings/avatar/static", body.bytes, {
    "content-type": `multipart/form-data; boundary=${body.boundary}`,
  });
  req.socket.localAddress = "192.0.2.10";
  res = await invoke(setup.handler, req);
  assert.equal(res.status, 404);

  res = await upload(setup.handler, "/api/settings/avatar/static", png(), { contentType: "image/jpeg" });
  assert.equal(res.status, 415, res.body.toString());
  setup.advance();
  res = await upload(setup.handler, "/api/settings/avatar/static", Buffer.from("not png"));
  assert.equal(res.status, 422, res.body.toString());
  setup.advance();
  const corruptIhdr = png();
  corruptIhdr.write("IDAT", 12, "ascii");
  res = await upload(setup.handler, "/api/settings/avatar/static", corruptIhdr);
  assert.equal(res.status, 422, res.body.toString());
  setup.advance();
  res = await upload(setup.handler, "/api/settings/avatar/static", Buffer.alloc(5 * 1024 * 1024 + 1), { chunkSize: 64 * 1024 });
  assert.equal(res.status, 413, res.body.toString());

  setup.advance();
  res = await upload(setup.handler, "/api/settings/avatar/static", png());
  assert.equal(res.status, 200, res.body.toString());
  const limited = await upload(setup.handler, "/api/settings/avatar/frames/idle", png());
  assert.equal(limited.status, 429, limited.body.toString());

  setup.advance();
  fs.unlinkSync(path.join(setup.directory, "assets", "avatar.png"));
  fs.unlinkSync(path.join(setup.directory, "assets", ".avatar-source"));
  const frames = path.join(setup.directory, "assets", "avatar-frames");
  for (const name of ["idle", "talk1", "talk2", "talk3", "blink", "talk_blink"]) {
    const target = path.join(frames, `${name}.png`);
    fs.writeFileSync(target, Buffer.alloc(1));
    fs.truncateSync(target, 10 * 1024 * 1024);
  }
  res = await upload(setup.handler, "/api/settings/avatar/static", png(256, 256, 5 * 1024 * 1024 - 60));
  assert.equal(res.status, 413, res.body.toString());
});

module.exports = { imageMultipart, multipart, png };
