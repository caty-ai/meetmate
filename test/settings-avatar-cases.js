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
    avatar: {
      experiment: options.avatarExperiment || "",
      ...(options.rigBackgroundMode === undefined ? {} : { rigBackgroundMode: options.rigBackgroundMode }),
      ...(options.rigBackgroundColor === undefined ? {} : { rigBackgroundColor: options.rigBackgroundColor }),
    },
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

test("rig background settings use pinned defaults and reject invalid stored values", (t) => {
  fixture(t, { rigBackgroundMode: "video", rigBackgroundColor: "green" });
  assert.equal(getEffectiveValue("avatar_rig_background_mode"), "solid");
  assert.equal(getEffectiveValue("avatar_rig_background_color"), "#08111f");
  assert.deepEqual(
    buildEnvelope().issues.filter((issue) => issue.fieldId.startsWith("avatar_rig_background_")),
    [
      { fieldId: "avatar_rig_background_mode", code: "VALUE_INVALID" },
      { fieldId: "avatar_rig_background_color", code: "VALUE_INVALID" },
    ],
  );
});

test("shared avatar background labels and help copy mention both avatar tiles", () => {
  const settingsSource = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  assert.match(settingsSource, /avatar_rig_background_mode: "アバター背景"/);
  assert.match(settingsSource, /avatar_rig_background_color: "アバター背景色"/);
  assert.match(settingsSource, /2\.5Dリグとフレームセットの両方に適用され、次回の会議参加から反映されます/);
  assert.match(settingsSource, /2\.5Dリグとフレームセットの両方で、単色または画像の読み込み失敗時に使う #rrggbb 形式の色です/);
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

// ---- #294 operator-uploaded background picture --------------------------------------------------

function jpegSegment(marker, payload) {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpeg({ width = 320, height = 240, sof = 0xc0, before = [], after = [], sofLength = null } = {}) {
  const frame = Buffer.alloc(9);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 1;
  frame[6] = 1;
  frame[7] = 0x11;
  const sofSegment = jpegSegment(sof, frame);
  if (sofLength !== null) sofSegment.writeUInt16BE(sofLength, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...before,
    sofSegment,
    ...after,
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function errorCode(res) {
  return JSON.parse(res.body).error.code;
}

const BACKGROUND_URL = "/api/settings/avatar/background";

test("#294 JPEG validator walks segments only and pins the D1 accept / reject cases", () => {
  const { validateJpegBytes } = require("../src/settings/avatar-assets");
  assert.deepEqual(validateJpegBytes(jpeg()), { width: 320, height: 240 });
  assert.deepEqual(validateJpegBytes(jpeg({ sof: 0xc1 })), { width: 320, height: 240 });
  assert.deepEqual(validateJpegBytes(jpeg({ sof: 0xc2, width: 4096, height: 4096 })), { width: 4096, height: 4096 });
  // Fill bytes before a marker are skipped.
  const filled = jpeg();
  const withFill = Buffer.concat([filled.subarray(0, 2), Buffer.from([0xff, 0xff]), filled.subarray(2)]);
  assert.deepEqual(validateJpegBytes(withFill), { width: 320, height: 240 });
  // An APP1 thumbnail carrying its own SOI / SOF is skipped by length, never parsed.
  const thumbnail = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), jpeg({ width: 9999, height: 9999 })]);
  assert.deepEqual(validateJpegBytes(jpeg({ before: [jpegSegment(0xe1, thumbnail)] })), { width: 320, height: 240 });

  const reject = (bytes, label) => assert.throws(() => validateJpegBytes(bytes),
    (error) => error.code === "SETTINGS_AVATAR_JPEG_INVALID" && error.status === 422, label);
  const good = jpeg();
  reject(Buffer.concat([Buffer.from([0x00]), good.subarray(1)]), "no SOI");
  reject(good.subarray(0, good.length - 1), "no EOI");
  reject(Buffer.concat([good, Buffer.from([0x00])]), "bytes after EOI");
  for (const marker of [0x01, 0xd0, 0xd7, 0xd8, 0xd9]) {
    reject(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, marker]), good.subarray(2)]), `standalone ${marker.toString(16)} before SOF`);
  }
  reject(Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), good.subarray(2)]), "SOS before SOF");
  for (const sof of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) reject(jpeg({ sof }), `SOF ${sof.toString(16)}`);
  for (const [width, height] of [[0, 240], [320, 0], [4097, 240], [320, 4097]]) reject(jpeg({ width, height }), `${width}x${height}`);
  reject(jpeg({ sofLength: 1 }), "segment length < 2");
  reject(jpeg({ sofLength: 5 }), "SOF payload too short");
  reject(jpeg({ sofLength: 60000 }), "segment past the end");
  reject(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "no SOF");
  reject(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("garbage!"), Buffer.from([0xff, 0xd9])]), "not a marker");
});

test("#294 background upload accepts PNG and JPEG into one server-chosen file with previews and delete", async (t) => {
  const setup = fixture(t);
  const target = path.join(setup.directory, "assets", "avatar-background");
  const pngBytes = png(800, 600);
  let res = await upload(setup.handler, BACKGROUND_URL, pngBytes, { filename: "client-chosen.png", chunkSize: 5 });
  assert.equal(res.status, 200, res.body.toString());
  const stored = JSON.parse(res.body).background;
  assert.deepEqual(stored, {
    name: "background", type: "image/png", bytes: pngBytes.length,
    sha256: crypto.createHash("sha256").update(pngBytes).digest("hex"), width: 800, height: 600,
  });
  assert.deepEqual(fs.readFileSync(target), pngBytes);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(setup.directory, "assets", "client-chosen.png")), false);
  assert.equal(fs.existsSync(path.join(setup.directory, "assets", ".avatar-source")), false, "no source marker");

  let preview = await invoke(setup.handler, request("GET", `${BACKGROUND_URL}/preview`));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["Content-Type"], "image/png");
  assert.equal(preview.headers["Content-Length"], pngBytes.length);
  assert.equal(preview.headers["Cache-Control"], "no-store");
  assert.equal(preview.headers["X-Content-Type-Options"], "nosniff");
  assert.deepEqual(preview.body, pngBytes);

  for (const filename of ["photo.jpg", "photo.jpeg"]) {
    setup.advance();
    const jpegBytes = jpeg({ width: 1920, height: 1080 });
    res = await upload(setup.handler, BACKGROUND_URL, jpegBytes, { filename, contentType: "image/jpeg" });
    assert.equal(res.status, 200, res.body.toString());
    assert.equal(JSON.parse(res.body).background.type, "image/jpeg");
    assert.deepEqual(fs.readFileSync(target), jpegBytes);
  }
  // Exactly one managed picture file; no extension variants or backups are left behind.
  assert.deepEqual(fs.readdirSync(path.join(setup.directory, "assets")).filter((name) => name.includes("background")), ["avatar-background"]);
  preview = await invoke(setup.handler, request("GET", `${BACKGROUND_URL}/preview`));
  assert.equal(preview.headers["Content-Type"], "image/jpeg");

  const inspected = JSON.parse((await invoke(setup.handler, request("GET", "/api/settings/avatar"))).body);
  assert.deepEqual(inspected.background, {
    present: true, type: "image/jpeg", bytes: fs.statSync(target).size, width: 1920, height: 1080,
    previewUrl: "/api/settings/avatar/background/preview",
  });
  assert.equal(inspected.limits.backgroundBytes, 8 * 1024 * 1024);

  // A file that no longer sniffs / validates reads as absent everywhere.
  const kept = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.from("GIF89a not supported"));
  assert.equal(JSON.parse((await invoke(setup.handler, request("GET", "/api/settings/avatar"))).body).background.present, false);
  preview = await invoke(setup.handler, request("GET", `${BACKGROUND_URL}/preview`));
  assert.equal(preview.status, 404);
  assert.equal(errorCode(preview), "SETTINGS_AVATAR_NOT_FOUND");
  fs.writeFileSync(target, kept);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deleted = await invoke(setup.handler, request("DELETE", BACKGROUND_URL));
    assert.equal(deleted.status, 200, deleted.body.toString());
    assert.deepEqual(JSON.parse(deleted.body), { deleted: true });
  }
  assert.equal(fs.existsSync(target), false);
  assert.equal((await invoke(setup.handler, request("GET", `${BACKGROUND_URL}/preview`))).status, 404);
  assert.deepEqual(JSON.parse((await invoke(setup.handler, request("GET", "/api/settings/avatar"))).body).background,
    { present: false, type: null, bytes: 0, width: null, height: null, previewUrl: "/api/settings/avatar/background/preview" });
});

test("#294 background upload rejects type, magic mismatch, malformed, oversize and total, keeping the previous picture", async (t) => {
  const setup = fixture(t);
  const target = path.join(setup.directory, "assets", "avatar-background");
  const original = jpeg();
  let res = await upload(setup.handler, BACKGROUND_URL, original, { filename: "a.jpg", contentType: "image/jpeg" });
  assert.equal(res.status, 200, res.body.toString());

  const cases = [
    ["webp declared", png(), { filename: "a.png", contentType: "image/webp" }, 415, "SETTINGS_MEDIA_TYPE_UNSUPPORTED"],
    ["gif extension", png(), { filename: "a.gif", contentType: "image/png" }, 422, "SETTINGS_AVATAR_FILENAME_REJECTED"],
    ["png bytes as jpeg", png(), { filename: "a.jpg", contentType: "image/jpeg" }, 415, "SETTINGS_AVATAR_TYPE_MISMATCH"],
    ["png bytes with .jpg name", png(), { filename: "a.jpg", contentType: "image/png" }, 415, "SETTINGS_AVATAR_TYPE_MISMATCH"],
    ["jpeg bytes as png", jpeg(), { filename: "a.png", contentType: "image/png" }, 415, "SETTINGS_AVATAR_TYPE_MISMATCH"],
    ["jpeg bytes with .png name", jpeg(), { filename: "a.png", contentType: "image/jpeg" }, 415, "SETTINGS_AVATAR_TYPE_MISMATCH"],
    ["malformed jpeg", jpeg({ sof: 0xc3 }), { filename: "a.jpg", contentType: "image/jpeg" }, 422, "SETTINGS_AVATAR_JPEG_INVALID"],
    ["oversized jpeg", jpeg({ width: 5000 }), { filename: "a.jpg", contentType: "image/jpeg" }, 422, "SETTINGS_AVATAR_JPEG_INVALID"],
    ["garbage as jpeg", Buffer.from("not an image"), { filename: "a.jpg", contentType: "image/jpeg" }, 422, "SETTINGS_AVATAR_JPEG_INVALID"],
    ["malformed png", Buffer.concat([png().subarray(0, 12), Buffer.from("IDAT"), png().subarray(16)]), { filename: "a.png" }, 422, "SETTINGS_AVATAR_PNG_INVALID"],
    ["garbage as png", Buffer.from("not an image"), { filename: "a.png" }, 422, "SETTINGS_AVATAR_PNG_INVALID"],
    ["over 8 MiB", Buffer.alloc(8 * 1024 * 1024 + 1), { filename: "a.png", chunkSize: 256 * 1024 }, 413, "SETTINGS_AVATAR_FILE_TOO_LARGE"],
  ];
  for (const [label, bytes, options, status, code] of cases) {
    setup.advance();
    res = await upload(setup.handler, BACKGROUND_URL, bytes, options);
    assert.equal(res.status, status, `${label}: ${res.body}`);
    assert.equal(errorCode(res), code, label);
    assert.deepEqual(fs.readFileSync(target), original, `${label} keeps the previous picture`);
  }
  assert.deepEqual(fs.readdirSync(path.join(setup.directory, "assets")).filter((name) => name.startsWith(".avatar-work-")), []);

  // Same rate-limit bucket as the static avatar.
  setup.advance();
  res = await upload(setup.handler, BACKGROUND_URL, png());
  assert.equal(res.status, 200, res.body.toString());
  res = await upload(setup.handler, "/api/settings/avatar/static", png());
  assert.equal(res.status, 429);

  // Same mutation gate: cross-origin writes are refused.
  for (const method of ["POST", "DELETE"]) {
    const body = imageMultipart(png());
    const refused = await invoke(setup.handler, request(method, BACKGROUND_URL, body.bytes, {
      "content-type": `multipart/form-data; boundary=${body.boundary}`, origin: "https://evil.example",
    }));
    assert.equal(refused.status, 403, method);
  }

  // The picture counts toward the 64 MiB total, and the total caps it.
  const frames = path.join(setup.directory, "assets", "avatar-frames");
  for (const name of ["idle", "talk1", "talk2", "talk3", "blink", "talk_blink"]) {
    const frame = path.join(frames, `${name}.png`);
    fs.writeFileSync(frame, Buffer.alloc(1));
    fs.truncateSync(frame, 10 * 1024 * 1024);
  }
  setup.advance();
  res = await upload(setup.handler, BACKGROUND_URL, png(256, 256, 4 * 1024 * 1024));
  assert.equal(res.status, 413, res.body.toString());
  assert.equal(errorCode(res), "SETTINGS_AVATAR_TOTAL_LIMIT");
  fs.truncateSync(target, 3 * 1024 * 1024);
  setup.advance();
  res = await upload(setup.handler, "/api/settings/avatar/static", png(256, 256, 2 * 1024 * 1024));
  assert.equal(res.status, 413, res.body.toString());
  assert.equal(errorCode(res), "SETTINGS_AVATAR_TOTAL_LIMIT");
});

test("#294 join snapshot: present, missing, unreadable; the picture is never exported", async (t) => {
  const { readBackgroundSnapshot } = require("../src/settings/avatar-assets");
  const setup = fixture(t, { rigBackgroundMode: "image", rigBackgroundColor: "#123456" });
  assert.equal(readBackgroundSnapshot(setup.directory), null, "no assets directory yet");
  const bytes = jpeg();
  const res = await upload(setup.handler, BACKGROUND_URL, bytes, { filename: "a.jpg", contentType: "image/jpeg" });
  assert.equal(res.status, 200, res.body.toString());
  const snapshot = readBackgroundSnapshot(setup.directory);
  assert.deepEqual(snapshot, {
    bytes, type: "image/jpeg", version: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  });
  assert.match(snapshot.version, /^[0-9a-f]{16}$/);

  const target = path.join(setup.directory, "assets", "avatar-background");
  fs.writeFileSync(target, Buffer.from([0xff, 0xd8, 0x00]));
  assert.throws(() => readBackgroundSnapshot(setup.directory), (error) => error.code === "SETTINGS_AVATAR_JPEG_INVALID");
  fs.rmSync(target);
  fs.symlinkSync(path.join(setup.directory, "config.json"), target);
  assert.throws(() => readBackgroundSnapshot(setup.directory), (error) => error.code === "SETTINGS_AVATAR_PATH_REJECTED");
  fs.rmSync(target);
  assert.equal(readBackgroundSnapshot(setup.directory), null);
  fs.writeFileSync(target, bytes);

  const exported = await invoke(setup.handler, request("GET", "/api/settings/export"));
  assert.equal(exported.status, 200);
  const document = JSON.parse(exported.body);
  assert.equal(document.settings.avatar_rig_background_mode, "image");
  assert.equal(document.settings.avatar_rig_background_color, "#123456");
  assert.deepEqual(Object.keys(document.settings).filter((key) => /background/.test(key)).sort(),
    ["avatar_rig_background_color", "avatar_rig_background_mode"]);
  assert.equal(exported.body.includes(bytes.toString("base64")), false);
  assert.equal(exported.body.includes("avatar-background"), false);
});

module.exports = { imageMultipart, jpeg, multipart, png };
