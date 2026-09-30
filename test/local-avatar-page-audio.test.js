"use strict";

// #266 page audio: /local-avatar/audio and heartbeat routes, the page player, and the face host in the mode.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { Writable } = require("node:stream");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { loadPackage } = require("../src/transport-meet/face-package");
const { createLocalAvatarSession, _test: sessionTest } = require("../src/transport-meet/local-avatar-session");
const { serveLocalAvatar, _test: uiTest } = require("../src/ui-routes");
const { createTimeline, createPlayer } = require("../public/local-avatar/face-host");

const origin = "https://meetmate.example";
const HOST_SOURCE = fs.readFileSync(path.join(__dirname, "..", "public/local-avatar/face-host.js"), "utf8");
const encode = sessionTest.encodeAudioFrame;
const plain = (value) => JSON.parse(JSON.stringify(value)); // VM-realm objects to this realm
const RATE = 24_000;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-audio-pkg-"));
  fs.writeFileSync(path.join(root, "face.json"), JSON.stringify({ spec: "face-package/1", entry: "index.html", supports: ["speak", "level"] }));
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><script src="app.js"></script>');
  fs.writeFileSync(path.join(root, "app.js"), 'parent.postMessage({type:"face-ready"},"*");');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function issue(t, pageAudio = true) {
  const issued = createLocalAvatarSession({ publicOrigin: origin, mode: "face-package", facePackage: loadPackage(fixture(t)),
    htmlRoute: "/local-avatar/face-host.html", ...(pageAudio ? { pageAudio: true } : {}) });
  t.after(() => issued.session.close());
  return issued;
}
const auth = (issued, other = {}) => ({ authorization: `Bearer ${issued.capability}`, origin, ...other });

// Buffered route: resolves when the response finishes.
function route(raw, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.writeHead = (status, values) => { res.status = status; res.headers = values; };
    res.on("error", reject);
    res.on("finish", () => resolve({ status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    const req = new EventEmitter();
    Object.assign(req, { url: raw, method, headers });
    assert.equal(serveLocalAvatar(req, res, new URL(raw, origin)), true);
    if (body !== undefined) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
}

// Streamed /local-avatar/audio response.
function openAudio(raw, { method = "POST", headers = {} } = {}) {
  const res = new EventEmitter();
  Object.assign(res, { frames: [], ended: false, writableNeedDrain: false, timeouts: [],
    writeHead(status, values) { res.status = status; res.headers = values; },
    flushHeaders() { res.flushed = true; },
    setTimeout(ms) { res.timeouts.push(ms); },
    write(chunk) { res.frames.push(Buffer.from(chunk)); return true; },
    end(body) { if (body) res.frames.push(Buffer.from(body)); res.ended = true; } });
  const req = new EventEmitter();
  Object.assign(req, { url: raw, method, headers, timeouts: [], resumed: false,
    setTimeout(ms) { req.timeouts.push(ms); }, resume() { req.resumed = true; } });
  assert.equal(serveLocalAvatar(req, res, new URL(raw, origin)), true);
  return { req, res };
}

test("audio route: exactly the state checks, only in the mode, with no-store / no-buffering and the unchanged CSP", async (t) => {
  const issued = issue(t);
  const connected = issued.session.connect({ capability: issued.capability, origin });
  const good = `/local-avatar/audio?generation=${connected.generation}&v=${issued.session.visualId}`;
  const off = issue(t, false);
  const offConnected = off.session.connect({ capability: off.capability, origin });
  const rig = createLocalAvatarSession({ publicOrigin: origin });
  t.after(() => rig.session.close());
  for (const [raw, options] of [
    [good, { method: "GET", headers: auth(issued) }],
    [good, { headers: { origin } }],
    [good, { headers: auth(issued, { authorization: "Bearer wrong" }) }],
    [good, { headers: auth(issued, { origin: "https://evil.example" }) }],
    [`/local-avatar/audio?generation=${connected.generation + 1}&v=${issued.session.visualId}`, { headers: auth(issued) }],
    [`${good}&extra=1`, { headers: auth(issued) }],
    [`/local-avatar/audio?v=${issued.session.visualId}`, { headers: auth(issued) }],
    [`/local-avatar/audio?generation=${offConnected.generation}&v=${off.session.visualId}`, { headers: auth(off) }],
    [`/local-avatar/audio?generation=1&v=${rig.session.visualId}`, { headers: auth(rig) }],
  ]) {
    const { res } = openAudio(raw, options);
    assert.equal(res.status, 404, `${raw} ${JSON.stringify(options.headers)}`);
    assert.equal(res.headers["Content-Security-Policy"], uiTest.LOCAL_AVATAR_CSP);
  }
  const { req, res } = openAudio(good, { headers: auth(issued) });
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Security-Policy"], uiTest.LOCAL_AVATAR_CSP);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["X-Accel-Buffering"], "no");
  assert.equal(res.headers["Content-Type"], "application/octet-stream");
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  assert.deepEqual(req.timeouts, [0]);
  assert.deepEqual(res.timeouts, [0]);
  assert.equal(req.resumed, true);
  // A second stream supersedes the first one server-side.
  const second = openAudio(good, { headers: auth(issued) });
  assert.equal(second.res.status, 200);
  assert.equal(res.ended, true);
  // A new generation closes the stream too.
  issued.session.connect({ capability: issued.capability, origin });
  assert.equal(second.res.ended, true);
});

test("heartbeat rides every authenticated poll, including polls answered 204; only in the mode", async (t) => {
  const issued = issue(t);
  const connectRaw = `/local-avatar/state?connect=1&v=${issued.session.visualId}`;
  const initial = JSON.parse((await route(connectRaw, { headers: auth(issued) })).body);
  assert.equal(initial.kind, "idle");
  const poll = `/local-avatar/state?after=${initial.sequence}&generation=${initial.generation}&v=${issued.session.visualId}`;
  const body = (fields) => JSON.stringify({ audio: { state: "running", playedEpoch: 3, playedSample: 10, receivedSample: 20, ...fields } });
  const empty = await route(poll, { headers: auth(issued), body: body({}) });
  assert.equal(empty.status, 204);
  assert.deepEqual({ ...issued.session.audioHeartbeat(), at: 0 }, { state: "running", playedEpoch: 3, playedSample: 10, receivedSample: 20, at: 0 });
  issued.session.publishMarker({ outputEpoch: 0, firstSampleIndex: 0, sampleRate: RATE });
  const withState = await route(poll, { headers: auth(issued), body: body({ playedSample: 15 }) });
  assert.equal(withState.status, 200);
  assert.equal(issued.session.audioHeartbeat().playedSample, 15);
  const next = poll.replace(`after=${initial.sequence}`, `after=${JSON.parse(withState.body).sequence}`);
  // Rejected polls never store a heartbeat; oversized bodies are rejected.
  assert.equal((await route(next, { headers: auth(issued, { authorization: "Bearer wrong" }), body: body({ playedSample: 1 }) })).status, 404);
  assert.equal((await route(next, { headers: auth(issued), body: body({ playedSample: 30 }) })).status, 204);
  assert.equal(issued.session.audioHeartbeat().playedSample, 15, "playedSample > receivedSample is invalid");
  assert.equal((await route(next, { headers: auth(issued), body: "x".repeat(1025) })).status, 404);
  assert.equal(issued.session.audioHeartbeat().playedSample, 15);
  // Descriptor flag only in the mode.
  const descriptor = JSON.parse((await route(`/local-avatar/face-descriptor?v=${issued.session.visualId}`, { headers: auth(issued) })).body);
  assert.equal(descriptor.pageAudio, true);

  const off = issue(t, false);
  const offDescriptor = JSON.parse((await route(`/local-avatar/face-descriptor?v=${off.session.visualId}`, { headers: auth(off) })).body);
  assert.equal(Object.hasOwn(offDescriptor, "pageAudio"), false);
  const offInitial = off.session.connect({ capability: off.capability, origin });
  // Mode off: the body is never read (a plain request object without stream events still gets 204).
  const offPoll = `/local-avatar/state?after=${offInitial.sequence}&generation=${offInitial.generation}&v=${off.session.visualId}`;
  const offStatus = await new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end() { resolve(this.status); } };
    serveLocalAvatar({ url: offPoll, method: "POST", headers: auth(off) }, res, new URL(offPoll, origin));
  });
  assert.equal(offStatus, 204);
  assert.equal(off.session.audioHeartbeat(), null);
});

test("DW7: package iframe sandbox, package CSP and host CSP are unchanged in page-audio mode", async (t) => {
  const issued = issue(t);
  assert.equal(uiTest.LOCAL_AVATAR_CSP, "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'none'; style-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const host = await route(`/local-avatar/face-host.html?v=${issued.session.visualId}`, { method: "GET" });
  assert.equal(host.headers["Content-Security-Policy"], `${uiTest.LOCAL_AVATAR_CSP}; frame-src 'self'`);
  const entry = await route(`/local-avatar/pkg/${issued.session.mountId}/index.html`, { method: "GET" });
  assert.equal(entry.status, 200);
  assert.match(entry.headers["Content-Security-Policy"], /^sandbox allow-scripts;/);
  assert.match(entry.headers["Content-Security-Policy"], /media-src 'none'/);
  assert.equal(entry.headers["Content-Security-Policy"].includes("allow-same-origin"), false);
  const harness = hostHarness(t);
  await harness.start();
  assert.equal(harness.frame.sandbox, "allow-scripts");
  assert.equal(harness.frame.allow, "");
});

// ---- page player (mocked AudioContext) ----------------------------------

class FakeAudioContext {
  constructor() {
    this.currentTime = 0; this.state = "running"; this.destination = {}; this.sources = []; this.resumed = 0; this.closed = false;
  }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    const context = this;
    const node = { connected: false, startedAt: null, stoppedAt: null, buffer: null,
      connect() { node.connected = true; }, disconnect() {},
      start(when) { node.startedAt = when; }, stop() { if (node.stoppedAt === null) node.stoppedAt = context.currentTime; } };
    this.sources.push(node);
    return node;
  }
  resume() { this.resumed += 1; return Promise.resolve(); }
  close() { this.closed = true; }
}
const audible = (context) => context.sources.filter((node) => node.stoppedAt === null || node.stoppedAt > node.startedAt);
function pcm(samples, value = 1000) { const buffer = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) buffer.writeInt16LE(value, i * 2); return buffer; }
function pcmFrame(outputEpoch, firstSampleIndex, samples, extra = {}) {
  return encode({ t: "pcm", generation: 1, outputEpoch, cancelEpoch: 0, firstSampleIndex, sampleRate: RATE, utteranceId: 1, ...extra }, pcm(samples));
}
function player(context = new FakeAudioContext()) {
  const stops = [];
  const instance = createPlayer({ context, onStop: () => stops.push(context.currentTime) });
  instance.begin(1);
  return { context, instance, stops };
}

test("player: first chunk at currentTime+lead, later at max(cursor, currentTime+guard); epochs chain without overlap", () => {
  const { context, instance } = player();
  context.currentTime = 1;
  instance.feed(pcmFrame(0, 0, 2400));
  assert.equal(context.sources[0].startedAt, 1.15);
  assert.equal(context.sources[0].buffer.length, 2400);
  context.currentTime = 1.5; // the page lagged past the cursor (1.25)
  instance.feed(pcmFrame(0, 2400, 2400));
  assert.equal(context.sources[1].startedAt, 1.52);
  context.currentTime = 1.4;
  instance.feed(pcmFrame(1, 0, 2400)); // next epoch while the previous one still plays (cursor 1.62)
  assert.equal(context.sources[2].startedAt, 1.62, "chained at the cursor, not overlapping");
  // Split and coalesced frames decode identically; samples are s16le.
  const both = Buffer.concat([pcmFrame(1, 2400, 10, { utteranceId: null }), pcmFrame(1, 2410, 10)]);
  instance.feed(both.subarray(0, 7));
  assert.equal(context.sources.length, 3);
  instance.feed(both.subarray(7));
  assert.equal(context.sources.length, 5);
  assert.equal(context.sources[3].buffer.getChannelData(0)[0], 1000 / 32768);
});

test("player: stale generation, cancelEpoch, epoch and sample-cursor frames are dropped", () => {
  const { context, instance } = player();
  instance.feed(pcmFrame(2, 0, 100));
  for (const frame of [pcmFrame(2, 0, 100, { generation: 2 }), pcmFrame(1, 100, 100), pcmFrame(2, 50, 100)]) instance.feed(frame);
  assert.equal(context.sources.length, 1);
  instance.frame({ t: "cancel", generation: 1, cancelEpoch: 1, outputEpoch: 2 });
  instance.feed(pcmFrame(3, 0, 100)); // old cancelEpoch 0
  instance.feed(pcmFrame(2, 200, 100, { cancelEpoch: 1 })); // cancelled epoch
  assert.equal(context.sources.length, 1);
  instance.feed(pcmFrame(3, 0, 100, { cancelEpoch: 1 }));
  assert.equal(context.sources.length, 2);
  assert.throws(() => instance.feed(Buffer.from([0, 0, 0, 1, 0, 0])), /frame/);
});

test("DW4 / barge-in before leadMs: the scheduler is silent within one tick of the cancel", () => {
  const { context, instance, stops } = player();
  context.currentTime = 2;
  instance.feed(pcmFrame(0, 0, 2400));
  instance.feed(pcmFrame(0, 2400, 2400));
  context.currentTime = 2.05; // before the first chunk's 150 ms lead elapsed
  instance.feed(encode({ t: "cancel", generation: 1, cancelEpoch: 1, outputEpoch: 0 }));
  assert.equal(instance.scheduled(), 0);
  assert.equal(context.sources.every((node) => node.stoppedAt !== null && node.stoppedAt <= 2.05 + 0.033), true);
  assert.equal(audible(context).length, 0, "nothing of the cancelled epoch is ever heard");
  assert.deepEqual(stops, [2.05]);
});

test("epoch stop rewinds the cursor and deletes the cancelled epoch's rows; a stream stop stops every node", () => {
  const { context, instance, stops } = player();
  instance.feed(pcmFrame(0, 0, 5 * RATE)); // cursor at 5.15
  context.currentTime = 1;
  assert.equal(instance.position(0).sample, (1 - 0.15) * RATE);
  instance.feed(encode({ t: "cancel", generation: 1, cancelEpoch: 1, outputEpoch: 0 }));
  assert.equal(instance.cursor(), 1);
  assert.equal(instance.position(0), null);
  assert.equal(stops.length, 1);
  context.currentTime = 1.2;
  instance.feed(pcmFrame(1, 0, 2400, { cancelEpoch: 1 }));
  assert.ok(Math.abs(context.sources[1].startedAt - 1.35) < 1e-9, "currentTime + leadMs, not the cancelled epoch's old end");
  assert.equal(instance.position(1), null, "the mouth has nothing until the chunk starts");
  // A state poll with a newer cancelEpoch is an epoch stop too.
  instance.observe({ generation: 1, cancelEpoch: 2 });
  assert.equal(instance.scheduled(), 0);
  instance.feed(pcmFrame(2, 0, 2400, { cancelEpoch: 2 }));
  instance.stop();
  assert.equal(instance.scheduled(), 0);
  assert.equal(context.sources.every((node) => node.stoppedAt !== null), true);
  assert.equal(stops.length, 3);
});

test("player heartbeat counts samples of the current epoch only", () => {
  const { context, instance } = player();
  assert.deepEqual(instance.heartbeat(), { state: "running", playedEpoch: -1, playedSample: 0, receivedSample: 0 });
  instance.feed(pcmFrame(4, 0, 2400));
  instance.feed(pcmFrame(4, 2400, 2400));
  context.currentTime = 0.2;
  assert.deepEqual(instance.heartbeat(), { state: "running", playedEpoch: 4, playedSample: 1200, receivedSample: 4800 });
  instance.feed(pcmFrame(5, 0, 2400));
  assert.deepEqual(instance.heartbeat(), { state: "running", playedEpoch: 5, playedSample: 0, receivedSample: 2400 });
  context.state = "suspended";
  assert.equal(instance.heartbeat().state, "suspended");
});

test("timeline: a page-owned epoch ignores the wall clock and follows the scheduled chunks", () => {
  let wall = 0; const messages = []; let position = null;
  const timeline = createTimeline({ send: (v) => messages.push(v), now: () => wall, offset: 0, supports: [], pageSample: () => position });
  timeline.connect(1);
  timeline.accept({ generation: 1, sequence: 1, cancelEpoch: 0, outputEpoch: 0, kind: "marker", sampleRate: 1000, audio: "page",
    envelopes: [{ s: 0, v: [0.5, 0.7] }],
    utterances: [{ utteranceId: 1, utteranceStartSample: 0, lastSample: 200, endSample: 200, emotionRevision: 0, emotion: null, intensity: 0 }] });
  wall = 5000; timeline.tick();
  assert.equal(messages.length, 0, "the wall clock never starts a page-owned epoch");
  position = { sample: 150, gap: false }; timeline.tick();
  assert.deepEqual(messages.map((v) => v.type), ["speak-start", "level"]);
  assert.equal(messages[1].v, 0.7);
  position = { sample: 180, gap: true }; timeline.tick();
  assert.equal(messages.at(-1).v, 0, "gaps are silence");
  timeline.idle();
  assert.deepEqual(messages.slice(-2), [{ type: "speak-end", id: 1, reason: "interrupt" }, { type: "level", id: 1, v: 0 }]);
  const count = messages.length;
  position = { sample: 190, gap: false }; timeline.tick();
  assert.equal(messages.length, count, "an interrupted segment never resumes");
  // Normal end on the played-through sample.
  timeline.accept({ generation: 1, sequence: 2, cancelEpoch: 0, outputEpoch: 1, kind: "marker", sampleRate: 1000, audio: "page", envelopes: [],
    utterances: [{ utteranceId: 2, utteranceStartSample: 0, lastSample: 100, endSample: 100, emotionRevision: 0, emotion: null, intensity: 0 }] });
  position = { sample: 10, gap: false }; timeline.tick();
  position = { sample: 100, gap: true }; timeline.tick();
  assert.deepEqual(messages.at(-1), { type: "speak-end", id: 2, reason: "end" });
  // WebSocket-fallback epochs keep the wall-clock timeline, and idle() leaves them alone.
  timeline.accept({ generation: 1, sequence: 3, cancelEpoch: 0, outputEpoch: 2, kind: "marker", sampleRate: 1000, envelopes: [],
    utterances: [{ utteranceId: 3, utteranceStartSample: 0, lastSample: 5000, endSample: null, emotionRevision: 0, emotion: null, intensity: 0 }] });
  wall = 5001; timeline.tick();
  assert.deepEqual(messages.at(-2), { type: "speak-start", id: 3, emotion: null, intensity: 0 });
  const beforeIdle = messages.length;
  timeline.idle();
  assert.equal(messages.length, beforeIdle, "a page stop never interrupts a WebSocket-routed epoch's mouth");
});

// ---- face host in the mode (VM) ------------------------------------------

function controlledStream() {
  const queue = []; let waiting = null; let done = false;
  return {
    push(bytes) { if (waiting) { const resolve = waiting; waiting = null; resolve({ done: false, value: bytes }); } else queue.push(bytes); },
    end() { done = true; if (waiting) { const resolve = waiting; waiting = null; resolve({ done: true }); } },
    reader: { read: () => queue.length ? Promise.resolve({ done: false, value: queue.shift() })
      : done ? Promise.resolve({ done: true }) : new Promise((resolve) => { waiting = resolve; }) },
  };
}

function hostHarness(t, { pageAudio = true } = {}) {
  const listeners = new Map(), pending = new Map(), posted = [], requests = [], contexts = [], streams = [], polls = [];
  const clock = { now: 1_000_000 };
  let serial = 0, ticker = null;
  const frame = { style: {}, setAttribute(key, value) { this[key] = value; }, contentWindow: { postMessage: (data) => posted.push(data) } };
  const descriptor = { spec: "face-package/1", entry: "index.html", supports: ["speak", "level"], mountId: "mount",
    ...(pageAudio ? { pageAudio: true } : {}) };
  const json = (value) => ({ ok: true, status: 200, json: async () => value });
  class Context extends FakeAudioContext { constructor(options) { super(); this.options = options; contexts.push(this); } }
  const sandbox = {
    URLSearchParams, TextDecoder, AbortController, Date: { now: () => clock.now },
    location: { pathname: "/local-avatar/face-host.html", search: "?v=v", hash: "#cap=synthetic-capability" }, history: { replaceState() {} },
    document: { documentElement: { style: {} }, body: { style: {}, append() {} }, createElement: () => frame },
    addEventListener: (name, fn) => listeners.set(name, fn),
    setInterval: (fn) => { ticker = fn; return 1; }, clearInterval() {},
    setTimeout: (fn, ms) => { pending.set(++serial, { fn, ms }); return serial; }, clearTimeout: (id) => pending.delete(id),
    ...(pageAudio ? { AudioContext: Context } : {}),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("face-descriptor")) return json(descriptor);
      if (url.includes("connect=1")) return json({ kind: "idle", generation: 1, cancelEpoch: 0, outputEpoch: -1, sequence: 1 });
      if (url.startsWith("/local-avatar/audio")) {
        const stream = controlledStream();
        stream.signal = options.signal;
        streams.push(stream);
        return { ok: true, status: 200, body: { getReader: () => stream.reader } };
      }
      const next = polls.shift();
      if (next?.status) return { ok: false, status: next.status };
      return next ? json(next) : { ok: true, status: 204 };
    },
  };
  vm.runInNewContext(HOST_SOURCE, sandbox);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const harness = {
    frame, posted, requests, contexts, streams, polls, clock, flush,
    get context() { return contexts[0]; },
    async start() {
      await flush();
      listeners.get("message")({ source: frame.contentWindow, data: { type: "face-ready" } });
      await flush();
    },
    async poll() {
      const [id, job] = [...pending.entries()].find(([, value]) => value.ms === 100);
      pending.delete(id);
      await job.fn();
      await flush();
    },
    tick() { ticker(); },
    stateRequests: () => requests.filter((request) => request.url.includes("after=")),
  };
  t.after(() => listeners.get("pagehide")?.());
  return harness;
}

test("host mode off: no AudioContext, no audio stream and no heartbeat body", async (t) => {
  const harness = hostHarness(t, { pageAudio: false });
  await harness.start();
  await harness.poll();
  assert.equal(harness.contexts.length, 0);
  assert.equal(harness.requests.some((request) => request.url.startsWith("/local-avatar/audio")), false);
  assert.equal(harness.stateRequests().length, 1);
  assert.equal(Object.hasOwn(harness.stateRequests()[0].options, "body"), false);
});

test("host in the mode: heartbeat on 204 polls, cancel keeps the stream, mouth idles and rewinds, stream end stops every node", async (t) => {
  const harness = hostHarness(t);
  await harness.start();
  const context = harness.context;
  assert.equal(harness.streams.length, 1, "the stream opens once the state poll connected");
  const audioRequest = harness.requests.find((request) => request.url.startsWith("/local-avatar/audio"));
  assert.equal(audioRequest.url, "/local-avatar/audio?v=v&generation=1");
  assert.equal(audioRequest.options.method, "POST");
  assert.equal(Object.hasOwn(audioRequest.options, "body"), false, "a complete (empty) body, no duplex upload");
  assert.equal(Object.hasOwn(audioRequest.options, "duplex"), false);
  const [stream] = harness.streams;

  stream.push(pcmFrame(0, 0, 5 * RATE));
  await harness.flush();
  assert.equal(context.sources[0].startedAt, 0.15);
  context.currentTime = 0.2;
  await harness.poll(); // answered 204
  const heartbeat = JSON.parse(harness.stateRequests().at(-1).options.body);
  assert.deepEqual(heartbeat, { audio: { state: "running", playedEpoch: 0, playedSample: 1200, receivedSample: 5 * RATE } });

  harness.polls.push({ kind: "marker", generation: 1, sequence: 2, cancelEpoch: 0, outputEpoch: 0, sampleRate: RATE, audio: "page",
    envelopes: [{ s: 0, v: [0.5] }],
    utterances: [{ utteranceId: 1, utteranceStartSample: 0, lastSample: 5 * RATE, endSample: null, emotionRevision: 0, emotion: null, intensity: 0 }] });
  await harness.poll();
  harness.clock.now += 10_000;
  context.currentTime = 0.1; harness.tick();
  assert.equal(harness.posted.some((v) => v.type === "speak-start"), false, "not before the first chunk plays; wall clock ignored");
  context.currentTime = 0.25; harness.tick();
  assert.equal(harness.posted.filter((v) => v.type === "speak-start").length, 1);

  context.currentTime = 0.3;
  stream.push(encode({ t: "cancel", generation: 1, cancelEpoch: 1, outputEpoch: 0 }));
  await harness.flush();
  assert.equal(context.sources[0].stoppedAt, 0.3);
  assert.equal(stream.signal.aborted, false, "an epoch stop keeps the stream open");
  assert.deepEqual(plain(harness.posted.slice(-2)), [{ type: "speak-end", id: 1, reason: "interrupt" }, { type: "level", id: 1, v: 0 }]);

  harness.polls.push({ kind: "marker", generation: 1, sequence: 3, cancelEpoch: 1, outputEpoch: 1, sampleRate: RATE, audio: "page",
    envelopes: [], utterances: [{ utteranceId: 2, utteranceStartSample: 0, lastSample: RATE, endSample: null, emotionRevision: 0, emotion: null, intensity: 0 }] });
  await harness.poll();
  context.currentTime = 0.4;
  stream.push(pcmFrame(1, 0, RATE, { cancelEpoch: 1, utteranceId: 2 }));
  await harness.flush();
  assert.equal(context.sources[1].startedAt, 0.55, "the next page epoch starts at currentTime + leadMs");
  context.currentTime = 0.54; harness.tick();
  assert.equal(harness.posted.some((v) => v.type === "speak-start" && v.id === 2), false, "idle until the next chunk plays");
  context.currentTime = 0.56; harness.tick();
  assert.equal(harness.posted.some((v) => v.type === "speak-start" && v.id === 2), true);

  context.currentTime = 0.6;
  stream.end(); // stream death mid-epoch
  await harness.flush();
  assert.equal(stream.signal.aborted, true);
  assert.equal(context.sources[1].stoppedAt, 0.6, "no scheduled node outlives its stream");
  assert.deepEqual(plain(harness.posted.slice(-2)), [{ type: "speak-end", id: 2, reason: "interrupt" }, { type: "level", id: 2, v: 0 }]);
  await harness.poll();
  assert.equal(harness.streams.length, 1, "not reopened within 500 ms");
  harness.clock.now += 500;
  await harness.poll();
  assert.equal(harness.streams.length, 2, "reopened after a healthy poll");

  // The package only ever receives protocol messages, never PCM.
  const types = new Set(["host-init", "background", "speak-start", "speak-emotion", "level", "speak-end", "listen-start", "listen-end", "cue"]);
  assert.equal(harness.posted.every((message) => types.has(message.type)
    && Object.values(message).every((value) => !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer))), true);
});

test("host in the mode: a suspended context is reported and resumed; a poll 404 stops the stream", async (t) => {
  const harness = hostHarness(t);
  await harness.start();
  harness.context.state = "suspended";
  await harness.poll();
  assert.equal(JSON.parse(harness.stateRequests().at(-1).options.body).audio.state, "suspended");
  assert.equal(harness.context.resumed, 1);
  const [stream] = harness.streams;
  stream.push(pcmFrame(0, 0, 2400));
  await harness.flush();
  assert.equal(harness.context.sources.length, 1);
  harness.context.currentTime = 0.05;
  harness.polls.push({ status: 404 }); // session closed or leave
  await harness.poll();
  assert.equal(stream.signal.aborted, true);
  assert.equal(harness.context.sources[0].stoppedAt, 0.05);
  assert.equal(harness.streams.length, 1, "a stopped host never reopens");
});

test("join form sends faceAudio=page only with an explicit face-package selection; MCP join is unchanged", () => {
  const app = require("../public/app");
  const html = fs.readFileSync(path.join(__dirname, "..", "public/index.html"), "utf8");
  assert.match(html, /<label class="field-label" id="faceAudioOption" hidden>\s*<input type="checkbox" id="faceAudioPage" value="page">/);
  for (const selection of ["follow-settings", "", "hybrid-local-l0", "hybrid-local-frames"]) {
    assert.equal(app.faceAudioAvailable(selection), false);
    const body = app.buildMeetJoinFormData({ meetingUrl: "https://meet.google.com/abc-defg-hij", availableAgents: [],
      wsUrl: "wss://meetmate.example/realtime", avatarExperiment: selection, faceAudioPage: true });
    assert.equal(body.has("faceAudio"), false, selection);
  }
  const base = { meetingUrl: "https://meet.google.com/abc-defg-hij", availableAgents: [], wsUrl: "wss://meetmate.example/realtime", avatarExperiment: "face-package" };
  assert.equal(app.buildMeetJoinFormData({ ...base, faceAudioPage: true }).get("faceAudio"), "page");
  assert.equal(app.buildMeetJoinFormData(base).has("faceAudio"), false);
  assert.equal(fs.readFileSync(path.join(__dirname, "..", "src/mcp/server.js"), "utf8").includes("faceAudio"), false);
});

test("the av-sync-probe flash face is a valid audio-free package", () => {
  const root = path.join(__dirname, "..", "tools/av-sync-probe/flash-face");
  const loaded = loadPackage(root);
  assert.ok(loaded);
  assert.deepEqual(loaded.descriptor.supports, ["speak", "level"]);
  const script = fs.readFileSync(path.join(root, "flash.js"), "utf8");
  for (const token of ["AudioContext", "<audio", "fetch(", "getUserMedia"]) assert.equal(script.includes(token), false, token);
  assert.match(script, /event\.source !== parent/);
});

test("av-sync-probe analyzer self-test recovers a known offset and drift", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "tools/av-sync-probe/analyze.js"), "--selftest"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /selftest: ok/);
});
