const test = module.parent ? require("node:test") : () => {};
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { loadPackage, LIMITS } = require("../src/transport-meet/face-package");
const { createLocalAvatarSession } = require("../src/transport-meet/local-avatar-session");
const { serveLocalAvatar } = require("../src/ui-routes");
const { createTimeline } = require("../public/local-avatar/face-host");
const origin = "https://meetmate.example";
const defaultManifest = { spec: "face-package/1", entry: "index.html", supports: ["speak", "level", "emotion", "background", "listen", "cue"] };
function fixture(t, manifest = defaultManifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "face-contract-"));
  fs.writeFileSync(path.join(root, "face.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><script src="app.js"></script>');
  fs.writeFileSync(path.join(root, "app.js"), 'parent.postMessage({type:"face-ready"},"*");');
  fs.writeFileSync(path.join(root, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function issue(t, root, options = {}) {
  const facePackage = loadPackage(root);
  assert.ok(facePackage);
  const issued = createLocalAvatarSession({ publicOrigin: origin, mode: "face-package", facePackage,
    htmlRoute: "/local-avatar/face-host.html", ...options });
  t.after(() => issued.session.close());
  return issued;
}
function route(raw, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.writeHead = (status, values) => { response.status = status; response.headers = values; };
    response.on("error", reject);
    response.on("finish", () => resolve({ status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    const handled = serveLocalAvatar({ url: raw, method, headers }, response, new URL(raw, origin));
    assert.equal(handled, true);
  });
}
const auth = (issued, other = {}) => ({ method: "POST", headers: { authorization: `Bearer ${issued.capability}`, origin, ...other } });
const pkg = (issued, rel) => `/local-avatar/pkg/${issued.session.mountId}/${rel}`;

test("face routes are unknown with no face session, including module and key isolation", async () => {
  for (const raw of ["/local-avatar/face-host.html?v=absent", "/local-avatar/face-host.js?v=absent", "/local-avatar/face-descriptor?v=absent", "/local-avatar/pkg/absent/index.html"]) {
    assert.equal((await route(raw)).status, 404);
  }
  const probe = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const {serveLocalAvatar} = require('./src/ui-routes');
    process.env = new Proxy(process.env, { get(target, key) { if (key === 'TYPESAFE_API_KEY') throw Error('key read'); return target[key]; } });
    for (const url of ['/local-avatar/face-host.html?v=x','/local-avatar/face-descriptor?v=x','/local-avatar/pkg/x/index.html']) {
      serveLocalAvatar({url, method:'GET'}, {writeHead(n) {assert.equal(n,404)},end() {}});
    }
    assert.equal(Object.keys(require.cache).some(p => /face-package\\.js|[/]emotion[/]/.test(p)),false);
  `], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
});

test("descriptor capability, Origin, per-session mode, launch URL, and host CSP", async (t) => {
  const issued = issue(t, fixture(t));
  const rig = createLocalAvatarSession({ publicOrigin: origin });
  t.after(() => rig.session.close());
  const descriptor = `/local-avatar/face-descriptor?v=${issued.session.visualId}`;
  assert.equal(Buffer.from(issued.session.mountId, "base64url").length, 32);
  assert.equal(issued.launchUrl.includes(issued.session.mountId), false);
  assert.notEqual(issued.session.mountId, issued.session.visualId);
  for (const options of [{}, auth(issued, { origin: "null" }), auth(issued, { authorization: "Bearer wrong" })]) {
    assert.equal((await route(descriptor, options)).status, 404);
  }
  const response = await route(descriptor, auth(issued));
  assert.equal(response.status, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(JSON.parse(response.body).mountId, issued.session.mountId);
  for (const name of ["face-host.html", "face-host.js", "face-descriptor"]) {
    assert.equal((await route(`/local-avatar/${name}?v=${rig.session.visualId}`, auth(rig))).status, 404);
  }
  assert.equal((await route(`/local-avatar/pkg/${rig.visualId}/index.html`)).status, 404);
  const host = await route(`/local-avatar/face-host.html?v=${issued.session.visualId}`);
  assert.equal(host.status, 200);
  assert.match(host.headers["Content-Security-Policy"], /frame-src 'self'/);
  assert.match(host.body, new RegExp(`face-host.js\\?v=${issued.session.visualId}`));
  assert.equal(host.body.includes(issued.capability), false);
});

test("frozen index path matrix, extension allowlist and fixed headers", async (t) => {
  const root = fixture(t);
  for (const ext of ["mjs", "css", "json", "jpg", "jpeg", "webp", "psd", "woff2", "svg", "wasm", "html", ""]) {
    fs.writeFileSync(path.join(root, ext ? `file.${ext}` : "bare"), "synthetic");
  }
  fs.writeFileSync(path.join(root, ".hidden.js"), "hidden");
  fs.mkdirSync(path.join(root, ".private"));
  fs.writeFileSync(path.join(root, ".private", "app.js"), "hidden");
  const outside = fixture(t);
  fs.symlinkSync(path.join(outside, "app.js"), path.join(root, "outside.js"));
  fs.symlinkSync(path.join(root, "app.js"), path.join(root, "inside.js"));
  const issued = issue(t, root);
  const prefix = pkg(issued, "");
  for (const rel of ["../app.js", "%2e%2e/app.js", "%2fapp.js", "a%2fb.js", "a\\b.js", "%5capp.js", "/app.js", "%00app.js", ".hidden.js", ".private/app.js", "outside.js", "inside.js", "file.svg", "file.wasm", "file.html", "bare", "", "missing.js", "a/./app.js", "./app.js", "app.js#fragment", "app.js\u0000"]) {
    assert.equal((await route(prefix + rel)).status, 404, rel);
  }
  for (const rel of ["index.html", "app.js", "pixel.png", "file.mjs", "file.css", "file.json", "file.jpg", "file.jpeg", "file.webp", "file.psd", "file.woff2"]) {
    const r = await route(prefix + rel);
    assert.equal(r.status, 200, rel);
    assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(r.headers["Cache-Control"], "no-store");
    assert.equal(r.headers["Referrer-Policy"], "no-referrer");
    assert.equal(r.headers["Access-Control-Allow-Origin"], "*");
    assert.match(r.headers["Content-Security-Policy"], /^sandbox allow-scripts;/);
    assert.match(r.headers["Content-Security-Policy"], /script-src 'self'/);
    assert.equal(r.headers["Content-Security-Policy"].includes("allow-same-origin"), false);
    assert.match(r.headers["Content-Security-Policy"], /media-src 'none'/);
  }
  fs.writeFileSync(path.join(root, "added.js"), "later");
  assert.equal((await route(prefix + "added.js")).status, 404);
  fs.unlinkSync(path.join(root, "app.js"));
  fs.symlinkSync(path.join(outside, "app.js"), path.join(root, "app.js"));
  assert.equal((await route(prefix + "app.js")).status, 404);
  assert.equal((await route(prefix + "index.html", { method: "HEAD" })).status, 404);
});

test("package rechecks file identity and directory ancestors", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "mod.js"), "before");
  const issued = issue(t, root);
  fs.writeFileSync(path.join(root, "pixel.png"), "changed");
  assert.equal((await route(pkg(issued, "pixel.png"))).status, 404);
  fs.renameSync(path.join(root, "lib"), path.join(root, "moved"));
  fs.symlinkSync(path.join(root, "moved"), path.join(root, "lib"));
  assert.equal((await route(pkg(issued, "lib/mod.js"))).status, 404);
});

test("one query grammar governs both manifests and assets without resolving queries as paths", async (t) => {
  const root = fixture(t, { ...defaultManifest, query: "quality=low&variant=a.b-1" });
  const issued = issue(t, root);
  for (const query of ["", "?quality=low", "?a=&b=c&d=e&f=g"]) assert.equal((await route(pkg(issued, "app.js") + query)).status, 200);
  for (const query of ["?a", "?=a", "?a=b&", "?a=%2f", "?a=b=c", "?a=b&c=d&e=f&g=h&i=j", "?a=hello+world", `?a=${"x".repeat(41)}`]) {
    assert.equal((await route(pkg(issued, "app.js") + query)).status, 404, query);
    fs.writeFileSync(path.join(root, "face.json"), JSON.stringify({ ...defaultManifest, query: query.slice(1) }));
    assert.equal(loadPackage(root, { warn() {} }), null, query);
  }
});

test("expiry and close revoke assets and host immediately without asset TTL renewal", async (t) => {
  let now = 0;
  const issued = issue(t, fixture(t), { now: () => now, ttlMs: 100 });
  const url = pkg(issued, "app.js");
  now = 90;
  assert.equal((await route(url)).status, 200);
  assert.equal(issued.session.snapshot().expiresAt, 100);
  now = 100;
  assert.equal((await route(url)).status, 404);
  assert.equal(issued.session.mountId, null);
  assert.equal((await route(`/local-avatar/face-host.html?v=${issued.session.visualId}`)).status, 404);
  const other = issue(t, fixture(t));
  const otherUrl = pkg(other, "app.js");
  other.session.close();
  assert.equal((await route(otherUrl)).status, 404);
});

const futureSupports = ["speak", "level", "emotion", "listen", "react", "face", "pose", "gesture", "framing", "background", "cue"];
const invalidSupports = ["speak", null, ["speak", "level", 1], ["speak", "level", "React"],
  ["speak", "level", ""], ["speak", "level", "bad_name"], ["speak", "level", "1future"],
  ["speak", "level", "future\n"], ["speak", "level", "x".repeat(33)],
  ["speak", "level", ...Array(31).fill("future")], ["speak"], ["level"], []];

test("supports ignores bounded future capabilities and exposes only known values", async (t) => {
  for (const supports of [futureSupports, ["speak", "level", ...Array(30).fill("x".repeat(32))]]) {
    const root = fixture(t, { ...defaultManifest, supports, query: "quality=low" });
    const expected = supports.filter((v) => defaultManifest.supports.includes(v));
    const loaded = loadPackage(root);
    assert.deepEqual(loaded.descriptor.supports, expected);
    assert.equal(loaded.descriptor.query, "quality=low");
    const issued = issue(t, root);
    const response = await route(`/local-avatar/face-descriptor?v=${issued.session.visualId}`, auth(issued));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).supports, expected);
  }
});

test("supports rejects malformed, oversized and missing required capabilities", (t) => {
  for (const supports of invalidSupports) {
    const root = fixture(t, { ...defaultManifest, supports });
    assert.equal(loadPackage(root, { warn() {} }), null, JSON.stringify(supports));
  }
});

test("manifest types, traversal, sizes, count, depth and path caps fail with a path-free diagnostic", (t) => {
  const root = fixture(t);
  const diagnostics = [];
  const invalid = () => assert.equal(loadPackage(root, { warn: (line) => diagnostics.push(line) }), null);
  for (const changed of [{ spec: "wrong" }, { entry: "../index.html" }, { entry: "index.html?x=y" }, { entry: "/index.html" },
    { entry: "app.js" }, { entry: "missing.html" }, { supports: "speak" },
    { viewport: { width: -1, height: 10 } }, { quality: {} }, { query: "" }, { query: "a=b\n" }]) {
    fs.writeFileSync(path.join(root, "face.json"), JSON.stringify({ ...defaultManifest, ...changed })); invalid();
  }
  fs.writeFileSync(path.join(root, "face.json"), JSON.stringify(defaultManifest));
  const large = path.join(root, "large.psd");
  let fd = fs.openSync(large, "w"); fs.ftruncateSync(fd, LIMITS.file + 1); fs.closeSync(fd); invalid(); fs.unlinkSync(large);
  for (let i = 0; i < 4; i++) {
    fd = fs.openSync(path.join(root, `${i}.psd`), "w"); fs.ftruncateSync(fd, LIMITS.file); fs.closeSync(fd);
  }
  invalid();
  for (let i = 0; i < 4; i++) fs.unlinkSync(path.join(root, `${i}.psd`));
  for (let i = 0; i < LIMITS.files; i++) fs.writeFileSync(path.join(root, `${i}.js`), "");
  invalid();
  for (let i = 0; i < LIMITS.files; i++) fs.unlinkSync(path.join(root, `${i}.js`));
  const deep = path.join(root, ...Array(9).fill("deep")); fs.mkdirSync(deep, { recursive: true }); invalid();
  fs.rmSync(path.join(root, "deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "a".repeat(198) + ".js"), ""); invalid();
  assert.equal(diagnostics.every((line) => line.startsWith("MM-MMT-003:") && !line.includes(root)), true);
  assert.equal(loadPackage("relative", { warn() {} }), null);
});

function marker(utteranceId, sample = 0, extra = {}) {
  return { outputEpoch: 0, firstSampleIndex: sample, sampleRate: 1000, sampleCount: 100,
    utteranceId, emotion: null, intensity: 0, emotionRevision: 0, envelopeSegments: [{ s: sample, v: [0.6] }], ...extra };
}
test("latest snapshot retains multiple starts and ends, revisions and sample boundaries", (t) => {
  const issued = issue(t, fixture(t));
  const credentials = { capability: issued.capability, origin };
  const initial = issued.session.connect(credentials);
  for (let i = 1; i <= 12; i++) {
    issued.session.publishMarker(marker(i, (i - 1) * 100));
    issued.session.endUtterance({ utteranceId: i, outputEpoch: 0 });
  }
  const state = issued.session.readState({ ...credentials, generation: initial.generation, afterSequence: initial.sequence });
  assert.equal(state.utterances.length, 12);
  assert.equal(state.utteranceId, 12);
  assert.equal(state.utteranceStartSample, 1100);
  assert.equal(state.emotion, null);
  assert.equal(state.intensity, 0);
  assert.equal(state.emotionRevision, 0);
  assert.equal(state.utterances[0].endSample, 100);
  assert.equal(issued.session.publishEmotion({ utteranceId: 12, outputEpoch: 0, emotion: "joy", intensity: 1 }), false);
  let now = 0; const messages = [];
  const timeline = createTimeline({ send: (v) => messages.push(v), now: () => now, offset: 0, supports: ["emotion"] });
  timeline.connect(initial.generation); timeline.accept(state); now = 1300; timeline.tick();
  assert.deepEqual(messages.filter((v) => v.type === "speak-start").map((v) => v.id), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(messages.filter((v) => v.type === "speak-end").length, 12);
  timeline.tick(); assert.equal(messages.length, 24);
});

test("timeline cancels stale levels, survives silent gaps, applies active late emotion, and resets generations", (t) => {
  const issued = issue(t, fixture(t));
  const credentials = { capability: issued.capability, origin };
  const initial = issued.session.connect(credentials);
  const read = () => issued.session.readState({ ...credentials, generation: initial.generation, afterSequence: -1 });
  let now = 0; const messages = [];
  const timeline = createTimeline({ send: (v) => messages.push(v), now: () => now, offset: 0, supports: ["emotion"] });
  timeline.connect(initial.generation);
  issued.session.publishMarker(marker(1)); timeline.accept(read()); timeline.tick();
  now = 2000; timeline.tick();
  assert.equal(messages.some((v) => v.type === "speak-end"), false);
  issued.session.publishMarker(marker(1, 100)); timeline.accept(read()); timeline.tick();
  assert.equal(messages.at(-1).v, 0.6);
  issued.session.publishEmotion({ utteranceId: 1, outputEpoch: 0, emotion: "joy", intensity: 0.7 });
  timeline.accept(read()); timeline.tick();
  assert.equal(messages.filter((v) => v.type === "speak-emotion").length, 1);
  issued.session.cancelPlayback({ outputEpoch: 0 });
  issued.session.publishMarker(marker(2, 0, { outputEpoch: 1 }));
  const fresh = read(); timeline.accept(fresh); timeline.tick();
  assert.ok(messages.some((v) => v.type === "speak-end" && v.id === 1 && v.reason === "interrupt"));
  assert.equal(timeline.accept({ ...fresh, sequence: fresh.sequence - 1 }), false);
  assert.equal(issued.session.publishEmotion({ utteranceId: 1, outputEpoch: 0, emotion: "anger", intensity: 1 }), false);
  timeline.connect(initial.generation + 1);
  const count = messages.length; timeline.tick(); assert.equal(messages.length, count);
  assert.equal(timeline.accept(fresh), false);
});

test("emotion off never loads Jev or reads its credential; canonical table is strict", async () => {
  const { judgeEmotion, fromTags, stripMarkup } = require("../src/emotion");
  const probe = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const {judgeEmotion} = require('./src/emotion');
    process.env = new Proxy(process.env, {get(target,key) {if (key === 'TYPESAFE_API_KEY') throw Error('credential read'); return target[key]}});
    (async () => {
      assert.equal(await judgeEmotion('reply',{mode:'off',role:'reply',fetch() {throw Error('network')}}),null);
      assert.equal(Object.keys(require.cache).some(p => p.endsWith('/emotion/jev.js')),false);
    })().catch(() => process.exitCode = 1);
  `], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(fromTags("[unknown][warm][thoughtful] Hi"), { emotion: "trust", intensity: 0.3 });
  assert.equal(fromTags("[soft voice][warm] Hi"), null);
  assert.equal(fromTags("[WARM] Hi"), null);
  assert.equal(fromTags("plain"), null);
  assert.equal(stripMarkup("[warm] **Hello** <b>there</b> [[[chat: private]]]"), "Hello there");
  assert.equal(await judgeEmotion("plain", { mode: "tags" }), null);
});

test("Jev request shape, role filtering, timeout fallback, neutral and scrubbed credential", async () => {
  const { judgeEmotion } = require("../src/emotion");
  const { scrubLogMessage } = require("../src/log-scrub");
  const previous = process.env.TYPESAFE_API_KEY;
  const secret = "synthetic-judge-credential";
  process.env.TYPESAFE_API_KEY = secret;
  try {
    const calls = [];
    const fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ answers: { emotion: { choice: "joy" }, strong: { noul: 2 } } }) };
    };
    for (const role of [undefined, "ack", "progress", "greeting", "timeout", "farewell"]) {
      assert.deepEqual(await judgeEmotion("[warm] Hello", { mode: "jev", role, fetch }), { emotion: "trust", intensity: 0.3 });
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await judgeEmotion("[warm] **Hello**", { mode: "jev", role: "reply", fetch }), { emotion: "joy", intensity: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(JSON.parse(calls[0].options.body).model, "jev-latest");
    assert.equal(JSON.parse(calls[0].options.body).state.line, "Hello");
    let aborted = false;
    const blocked = (_url, { signal }) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); };
    assert.deepEqual(await judgeEmotion("[warm] Hello", { mode: "jev", role: "reply", fetch: blocked, timeoutMs: 10 }), { emotion: "trust", intensity: 0.3 });
    assert.equal(aborted, true);
    assert.equal(await judgeEmotion("Hello", { mode: "jev", role: "reply", fetch: blocked, timeoutMs: 10 }), null);
    assert.equal(await judgeEmotion("Hello", { mode: "jev", role: "reply", fetch: async () => ({ ok: true, json: async () => ({ answers: { emotion: { choice: "neutral" }, strong: { noul: 0 } } }) }) }), null);
    assert.equal(scrubLogMessage(`TYPESAFE_API_KEY=${secret}`).includes(secret), false);
    assert.equal(scrubLogMessage(JSON.stringify({ TYPESAFE_API_KEY: secret })).includes(secret), false);
    assert.equal(scrubLogMessage(JSON.stringify({ mountId: secret, visualId: secret })).includes(secret), false);
    assert.equal(scrubLogMessage(`/local-avatar/pkg/${secret}/app.js?v=${secret}#cap=${secret}`).includes(secret), false);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("host handshake validates source, preserves background, forwards query and quality without secrets", async () => {
  for (const supports of [futureSupports, ["speak", "level", ...Array(30).fill("x".repeat(32))], ...invalidSupports]) {
    const vm = require("node:vm");
    const listeners = new Map();
    const posted = [];
    const requests = [];
    const frame = { style: {}, setAttribute(key, value) { this[key] = value; }, contentWindow: { postMessage(data, target) { posted.push({ data, target }); } } };
    const descriptor = { mountId: "mount", entry: "index.html", query: "quality=low", quality: "low", viewport: { width: 640, height: 360 },
      supports, background: { mode: "solid", color: "#123456" } };
    const sandbox = {
      URLSearchParams, location: { pathname: "/local-avatar/face-host.html", search: "?v=visual", hash: "#cap=synthetic-capability" },
      history: { replaceState(_a, _b, url) { assert.equal(url.includes("cap"), false); } },
      document: { documentElement: { style: {} }, body: { style: {}, append() {} }, createElement: () => frame },
      addEventListener: (type, listener) => listeners.set(type, listener), setInterval: () => 1, clearInterval() {},
      setTimeout: () => 1, clearTimeout() {},
      fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => url.includes("descriptor") ? descriptor
        : { kind: "idle", generation: 1, cancelEpoch: 0, outputEpoch: -1, sequence: 1, background: descriptor.background } }; },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public/local-avatar/face-host.js"), "utf8"), sandbox);
    await new Promise((resolve) => setImmediate(resolve));
    if (invalidSupports.includes(supports)) {
      assert.equal(frame.src, undefined);
      listeners.get("message")({ source: frame.contentWindow, data: { type: "face-hello" } });
      listeners.get("message")({ source: frame.contentWindow, data: { type: "face-ready" } });
      assert.equal(requests.length, 1);
      assert.equal(posted.length, 0);
      listeners.get("pagehide")();
      continue;
    }
    assert.equal(frame.sandbox, "allow-scripts"); assert.equal(frame.allow, "");
    assert.equal(frame.src, "/local-avatar/pkg/mount/index.html?quality=low");
    assert.equal(sandbox.document.documentElement.style.background, "#123456");
    const message = listeners.get("message");
    message({ source: {}, data: { type: "face-ready" } });
    assert.equal(requests.length, 1);
    message({ source: frame.contentWindow, data: { type: "unknown" } });
    message({ source: frame.contentWindow, data: { type: "face-ready", spec: "wrong" } });
    assert.equal(requests.length, 1);
    message({ source: frame.contentWindow, data: { type: "face-hello" } });
    assert.equal(posted[0].data.quality, "low");
    assert.deepEqual(Array.from(posted[0].data.supports), supports.filter((v) => defaultManifest.supports.includes(v)));
    assert.equal(requests.length, 1);
    message({ source: frame.contentWindow, data: { type: "face-ready" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(frame.style.visibility, "visible");
    assert.equal(requests.length, 2);
    assert.equal(posted.every((item) => item.target === "*" && !JSON.stringify(item.data).includes("synthetic-capability")), true);
    assert.equal(requests[0].options.headers.Authorization, "Bearer synthetic-capability");
    assert.equal(posted.every(({ data }) => ["host-init", "background"].includes(data.type)), true);
    listeners.get("pagehide")();
  }
});

test("listening and optional emotion protocol messages require declared supports and the experiment", () => {
  for (const [supports, listen, expected] of [[["react", "face", "pose", "gesture", "framing"], true, []], [[], true, []], [["listen", "cue"], false, []], [["listen", "cue"], true, ["listen-start", "cue"]]]) {
    const messages = [];
    const timeline = createTimeline({ send: (v) => messages.push(v), supports, listen });
    timeline.connect(1);
    timeline.accept({ generation: 1, sequence: 1, cancelEpoch: 0, outputEpoch: 0, kind: "marker", utterances: [], sampleRate: 1000,
      listening: { id: 1, active: true }, cue: { id: 1, emotion: "joy", intensity: 0.2 } });
    assert.deepEqual(messages.map((v) => v.type), expected);
  }
});

test("deployment path never enters settings GET, mutation or transfer DTOs", () => {
  const { initializeRuntime, resetRuntimeForTest, buildEnvelope, getEffectiveValue } = require("../src/settings/resolver");
  const { settingsMutationSchema, isImportableSetting } = require("../src/settings/schemas");
  const { REGISTRY_BY_ID } = require("../src/settings/registry");
  const startup = { resolvedHome: "/tmp/face-settings", preDotenvEnv: {}, dotenvSeeds: {}, connection: {} };
  try {
    initializeRuntime({ startup, state: { exists: true, valid: true, parsed: { avatar: { facePackageDir: "/srv/synthetic-face" } } } });
    assert.equal(getEffectiveValue("face_package_dir"), "/srv/synthetic-face");
    assert.equal(JSON.stringify(buildEnvelope()).includes("/srv/synthetic-face"), false);
    assert.equal(settingsMutationSchema.safeParse({ schemaVersion: 1, revision: "bootstrap", fields: { face_package_dir: "/srv/other" } }).success, false);
    assert.equal(isImportableSetting(REGISTRY_BY_ID.face_package_dir), false);
    assert.equal(REGISTRY_BY_ID.face_package_dir.transferable, false);
    initializeRuntime({ startup, state: { exists: true, valid: true, parsed: { avatar: { facePackageDir: "relative" } } } });
    assert.equal(getEffectiveValue("face_package_dir"), undefined);
  } finally { resetRuntimeForTest(); }
});

test("inconsistent face session construction cannot issue an unvalidated mount", () => {
  assert.throws(() => createLocalAvatarSession({ publicOrigin: origin, mode: "face-package" }));
  assert.throws(() => createLocalAvatarSession({ publicOrigin: origin, htmlRoute: "/local-avatar/face-host.html" }));
});

test("the opened descriptor is rechecked after a concurrent regular-file replacement", async (t) => {
  const root = fixture(t);
  const issued = issue(t, root);
  const filename = fs.realpathSync(path.join(root, "app.js"));
  const replacement = path.join(root, "replacement.js");
  fs.writeFileSync(replacement, "different inode");
  const original = fs.openSync;
  fs.openSync = function (file, ...args) {
    if (file === filename) fs.renameSync(replacement, filename);
    return original.call(this, file, ...args);
  };
  try { assert.equal((await route(pkg(issued, "app.js"))).status, 404); }
  finally { fs.openSync = original; }
});
