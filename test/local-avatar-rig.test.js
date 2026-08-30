"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync, spawnSync } = require("node:child_process");
const agPsd = require("../scripts/vendor/anime25drig/ag-psd.min.js");
const Rigger = require("../scripts/vendor/anime25drig/rigger.js");

const ROOT = path.join(__dirname, "..");
const SCRIPT_FILE = path.join(ROOT, "public", "local-avatar", "local-avatar.js");
const HTML_FILE = path.join(ROOT, "public", "local-avatar", "index.html");
const GENERATOR = path.join(ROOT, "scripts", "build-local-avatar-rig.js");

function shippedScript() {
  return fs.readFileSync(SCRIPT_FILE, "utf8");
}

function embeddedModel(script) {
  const match = script.match(/\/\* @rig-model-begin \*\/([\s\S]*?)\/\* @rig-model-end \*\//);
  assert.ok(match, "model embed markers must exist");
  const base64 = match[1].match(/const RIG_MODEL_BASE64 = ([\s\S]*?);/);
  assert.ok(base64, "model embed must declare base64 bytes");
  const pieces = [...base64[1].matchAll(/"([A-Za-z0-9+/=]*)"/g)].map((item) => item[1]);
  assert.ok(pieces.length > 0, "model embed must contain base64 data");
  return Buffer.from(pieces.join(""), "base64");
}

function embeddedProvenance(script) {
  const match = script.match(/const RIG_MODEL_PROVENANCE = "(procedural|external)";/);
  assert.ok(match, "model embed must declare provenance");
  return match[1];
}

function embeddedBackground(script) {
  const match = script.match(/\/\* @rig-bg-begin \*\/([\s\S]*?)\/\* @rig-bg-end \*\//);
  assert.ok(match, "background embed markers must exist");
  const encoded = match[1].match(/const RIG_BACKGROUND_BASE64URL = "([A-Za-z0-9_-]*)";/);
  assert.ok(encoded, "background embed must use base64url bytes");
  return Buffer.from(encoded[1], "base64url");
}

function initializeImageData() {
  agPsd.initializeCanvas(
    () => { throw new Error("canvas output is not used by this test"); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  );
}

test("shipped rig embeds a procedural parts PSD with the required layers", () => {
  initializeImageData();
  assert.equal(embeddedProvenance(shippedScript()), "procedural");
  const psd = agPsd.readPsd(embeddedModel(shippedScript()), { useImageData: true, skipThumbnail: true });
  const names = new Set(psd.children.map((layer) => layer.name));

  assert.equal(psd.width, 1024);
  assert.equal(psd.height, 1024);
  for (const name of [
    "face",
    "eyewhite",
    "irides",
    "eyelash",
    "eye_close",
    "eyebrow",
    "mouth_open",
    "mouth_close",
    "front hair_1",
    "front hair_2",
    "back hair",
    "neck",
    "topwear",
  ]) {
    assert.equal(names.has(name), true, `missing procedural layer: ${name}`);
  }
});

test("vendored rigger detects face, eyes, mouth, hair strands, and drawable parts", () => {
  initializeImageData();
  const psd = agPsd.readPsd(embeddedModel(shippedScript()), { useImageData: true, skipThumbnail: true });
  Rigger.cleanPsdLayers(psd);
  const rig = Rigger.buildRig(psd, {});

  assert.ok(rig.anchors.face);
  assert.ok(rig.anchors.eyeL);
  assert.ok(rig.anchors.eyeR);
  assert.ok(rig.anchors.eyeL.icx < rig.anchors.eyeR.icx);
  assert.ok(rig.anchors.mouth);
  assert.ok(rig.layers.length >= 16);
  const hair = rig.layers.filter((layer) => layer.phys === "hair");
  assert.ok(hair.length >= 3);
  assert.ok(hair.some((layer) => Array.isArray(layer.strands) && layer.strands.length > 0));
  assert.ok(rig.layers.every((layer) => layer.img.data.length > 0));
});

test("shipped WebGL runtime builds non-empty mesh buffers and renders a frame", () => {
  const uploaded = [];
  let drawCount = 0;
  const gl = createWebGlStub(uploaded, () => { drawCount += 1; });
  const frames = [];
  const visibleDraws = [];
  const visibleContext = {
    fillRect: (...args) => visibleDraws.push(["fill", ...args]),
    fillText: (...args) => visibleDraws.push(["text", ...args]),
    drawImage: (...args) => visibleDraws.push(["image", ...args]),
    set fillStyle(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
  };
  const sandbox = {
    URLSearchParams,
    location: { pathname: "/local-avatar/index.html", search: "", hash: "" },
    history: { replaceState: () => {} },
    document: {
      getElementById: () => ({ width: 1280, height: 720, getContext: () => visibleContext }),
      createElement: () => ({ width: 0, height: 0, getContext: (kind) => kind === "webgl" ? gl : null }),
    },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    fetch: async () => { throw new Error("state request is not expected"); },
    setTimeout: () => 1,
    clearTimeout: () => {},
    performance: { now: () => 0 },
  };

  vm.createContext(sandbox);
  vm.runInContext(shippedScript(), sandbox, { filename: SCRIPT_FILE });
  assert.equal(frames.length, 1);
  frames.shift()(1000);

  assert.ok(uploaded.some((data) => data && data.constructor.name === "Float32Array" && data.length > 0));
  assert.ok(uploaded.some((data) => data && data.constructor.name === "Uint16Array" && data.length > 0));
  assert.ok(drawCount > 0);
  assert.ok(visibleDraws.some((call) => call[0] === "image"));
});

test("truthy non-WebGL contexts fail closed without changing state polling", async () => {
  const draws = [];
  const delays = [];
  let requests = 0;
  const context = {
    fillRect: (...args) => draws.push(["fill", ...args]),
    fillText: (...args) => draws.push(["text", ...args]),
    set fillStyle(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
  };
  const initial = {
    kind: "idle",
    generation: 1,
    cancelEpoch: 0,
    sequence: 1,
    outputEpoch: -1,
    sampleIndex: null,
    sampleRate: null,
  };
  const sandbox = {
    URLSearchParams,
    location: {
      pathname: "/local-avatar/index.html",
      search: "?v=abcdefghijklmnop",
      hash: "#cap=secret",
    },
    history: { replaceState: () => {} },
    document: {
      getElementById: () => ({ width: 1280, height: 720, getContext: () => context }),
      createElement: () => ({ width: 0, height: 0, getContext: () => context }),
    },
    requestAnimationFrame: () => 1,
    fetch: async () => { requests += 1; return { ok: true, status: 200, json: async () => initial }; },
    setTimeout: (_callback, delay) => { delays.push(delay); return 1; },
    clearTimeout: () => {},
  };

  vm.createContext(sandbox);
  vm.runInContext(shippedScript(), sandbox, { filename: SCRIPT_FILE });
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 1);
  assert.ok(delays.includes(100));
  assert.ok(draws.some((call) => call[0] === "text" && call[1] === "IDLE"));
  assert.equal(sandbox.__localAvatarContract.getState().generation, 1);
});

test("a WebGL frame exception permanently returns to the marker fallback", () => {
  const uploaded = [];
  const frames = [];
  const texts = [];
  const gl = createWebGlStub(uploaded, () => { throw new Error("frame failed"); });
  const context = {
    fillRect: () => {},
    fillText: (value) => texts.push(value),
    drawImage: () => {},
    set fillStyle(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
  };
  const sandbox = {
    URLSearchParams,
    location: { pathname: "/local-avatar/index.html", search: "", hash: "" },
    history: { replaceState: () => {} },
    document: {
      getElementById: () => ({ width: 1280, height: 720, getContext: () => context }),
      createElement: () => ({ width: 0, height: 0, getContext: () => gl }),
    },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    fetch: async () => { throw new Error("state request is not expected"); },
    setTimeout: () => 1,
    clearTimeout: () => {},
    performance: { now: () => 0 },
  };

  vm.createContext(sandbox);
  vm.runInContext(shippedScript(), sandbox, { filename: SCRIPT_FILE });
  const beforeFailure = texts.length;
  frames.shift()(1000);
  assert.equal(texts.length, beforeFailure + 1);
  assert.equal(texts.at(-1), "IDLE");
  assert.equal(frames.length, 0);
});

test("accepted markers animate the mouth and cancel closes it", () => {
  const opacities = [];
  const frames = [];
  const gl = createWebGlStub([], () => {}, (location, value) => {
    if (location === "o") opacities.push(value);
  });
  const context = {
    fillRect: () => {},
    fillText: () => {},
    drawImage: () => {},
    set fillStyle(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
  };
  const sandbox = {
    URLSearchParams,
    location: { pathname: "/local-avatar/index.html", search: "", hash: "" },
    history: { replaceState: () => {} },
    document: {
      getElementById: () => ({ width: 1280, height: 720, getContext: () => context }),
      createElement: () => ({ width: 0, height: 0, getContext: () => gl }),
    },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    fetch: async () => { throw new Error("state request is not expected"); },
    setTimeout: () => 1,
    clearTimeout: () => {},
    performance: { now: () => 0 },
  };

  vm.createContext(sandbox);
  vm.runInContext(shippedScript(), sandbox, { filename: SCRIPT_FILE });
  const contract = sandbox.__localAvatarContract;
  assert.equal(contract.acceptState({
    kind: "marker",
    generation: 0,
    cancelEpoch: 0,
    sequence: 0,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24000,
  }), true);
  frames.shift()(100);
  assert.ok(opacities.some((value) => value > 0 && value < 1));

  opacities.length = 0;
  assert.equal(contract.acceptState({
    kind: "cancel",
    generation: 0,
    cancelEpoch: 1,
    sequence: 1,
    outputEpoch: 0,
    sampleIndex: null,
    sampleRate: null,
  }), true);
  frames.shift()(200);
  assert.ok(opacities.every((value) => value === 0 || value === 1));
});

test("scheduled envelopes drive attack/decay smoothing with the existing 50ms delta clamp", () => {
  const page = runRigEnvelopePage();
  const contract = page.sandbox.__localAvatarContract;
  assert.equal(contract.acceptState(rigMarker({ envelopes: [{ s: 0, v: [1, 0] }] })), true);

  page.frames.shift()(50);
  const attacked = contract.getState().rigMouth;
  assert.ok(Math.abs(attacked - (1 - Math.exp(-25 * 0.05))) < 1e-12);

  page.frames.shift()(100);
  const decayed = contract.getState().rigMouth;
  assert.ok(Math.abs(decayed - attacked * Math.exp(-8 * 0.05)) < 1e-12);
  assert.ok(attacked > 1 - Math.exp(-8 * 0.05), "attack coefficient is faster than decay");

  const clamped = runRigEnvelopePage();
  clamped.sandbox.__localAvatarContract.acceptState(rigMarker({ envelopes: [{ s: 0, v: new Array(20).fill(1) }] }));
  clamped.frames.shift()(1_000);
  assert.ok(Math.abs(clamped.sandbox.__localAvatarContract.getState().rigMouth - attacked) < 1e-12);

  const quiet = runRigEnvelopePage();
  quiet.sandbox.__localAvatarContract.acceptState(rigMarker({ envelopes: [{ s: 0, v: [0] }] }));
  quiet.frames.shift()(50);
  assert.equal(quiet.sandbox.__localAvatarContract.getState().rigMouth, 0, "envelope quiet replaces the fresh-marker pseudo-sine");
});

test("rig envelope markers require a positive safe sample rate and stay in the performance clock domain", () => {
  const page = runRigEnvelopePage({ dateNow: 9_000_000_000_000 });
  const contract = page.sandbox.__localAvatarContract;
  for (const sampleRate of [undefined, 0, 24_000.5]) {
    assert.equal(contract.acceptState({
      ...rigMarker({
        sequence: contract.getState().sequence + 1,
        envelopes: [{ s: 0, v: [1] }],
      }),
      sampleRate,
    }), false);
  }

  assert.equal(contract.acceptState(rigMarker({ envelopes: [{ s: 0, v: [1] }] })), true);
  assert.equal(contract.getState().envelope.playbackStartWall, 0, "Date.now skew cannot affect the rig anchor");
  page.frames.shift()(50);
  assert.ok(contract.getState().rigMouth > 0);

  const fallback = runRigEnvelopePage();
  assert.equal(fallback.sandbox.__localAvatarContract.acceptState({ ...rigMarker(), sampleRate: undefined }), true);
  fallback.frames.shift()(100);
  assert.ok(Number.isFinite(fallback.sandbox.__localAvatarContract.getState().rigMouth));
});

test("forward-only 16a keeps the no-fresh floor and its 500ms predicate edge in the rig clock", () => {
  const page = runRigEnvelopePage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarContract;
  const snapshot = [{ s: 0, v: new Array(10).fill(1) }];
  contract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: snapshot }));
  assert.equal(contract.getState().envelope.playbackStartWall, 300);

  page.clock.value = 1_799;
  contract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: snapshot }));
  assert.equal(contract.getState().envelope.playbackStartWall, 300, "499ms behind does not fire");

  page.clock.value = 1_800;
  contract.acceptState(rigMarker({ sequence: 2, sampleIndex: 2_000, sampleRate: 1_000, envelopes: snapshot }));
  assert.equal(contract.getState().envelope.playbackStartWall, 800, "500ms behind end-aligns forward");

  page.clock.value = 1_900;
  contract.acceptState(rigMarker({ sequence: 3, sampleIndex: 3_000, sampleRate: 1_000, envelopes: snapshot }));
  assert.equal(contract.getState().envelope.playbackStartWall, 800, "the floor never moves backward");
});

test("forward-only 16b start-aligns fresh post-silence audio and drops the played tail in the rig", () => {
  const page = runRigEnvelopePage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  contract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: [prior] }));

  page.clock.value = 3_000;
  contract.acceptState(rigMarker({
    sequence: 1,
    sampleIndex: 1_000,
    sampleRate: 1_000,
    envelopes: [prior, { s: 500, v: [1, 0.5] }],
  }));
  const state = contract.getState();
  assert.equal(state.envelope.playbackStartWall, 2_800);
  assert.equal(state.envelope.windowCount, 2, "no window ending at or before freshStart survives");
  page.frames.shift()(3_000);
  assert.equal(contract.getState().rigMouth, 0, "arrival is the before-start phase, not fallback or past-end");
  page.frames.shift()(3_301);
  assert.ok(contract.getState().rigMouth > 0, "fresh values render immediately after OFFSET");
});

test("forward-only 16b2 keeps the watermark sticky across rig superset snapshots", () => {
  const page = runRigEnvelopePage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarContract;
  const snapshot = [{ s: 0, v: new Array(5).fill(1) }, { s: 500, v: [1, 0.5] }];
  contract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: [snapshot[0]] }));
  page.clock.value = 3_000;
  contract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: snapshot }));
  page.frames.shift()(3_000);

  page.clock.value = 3_100;
  contract.acceptState(rigMarker({ sequence: 2, sampleIndex: 2_000, sampleRate: 1_000, envelopes: snapshot }));
  const state = contract.getState();
  assert.equal(state.envelope.playbackStartWall, 2_800);
  assert.equal(state.envelope.windowCount, 2, "the next superset cannot restore the played tail");
  page.frames.shift()(3_100);
  assert.equal(contract.getState().rigMouth, 0, "the second accept remains in OFFSET pre-roll");
});

test("forward-only 16c does not re-shift the rig when the accepted frontier is ahead", () => {
  const page = runRigEnvelopePage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  contract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: [prior] }));
  page.clock.value = 5_000;
  contract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1, 1] }] }));
  const aligned = contract.getState().envelope.playbackStartWall;

  page.clock.value = 5_100;
  contract.acceptState(rigMarker({ sequence: 2, sampleIndex: 2_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: new Array(7).fill(1) }] }));
  assert.equal(contract.getState().envelope.playbackStartWall, aligned);
});

test("forward-only 16d remains monotonic across no-fresh and consecutive fresh rig alignments", () => {
  const floorPage = runRigEnvelopePage({ offset: 300, now: 0 });
  const floorContract = floorPage.sandbox.__localAvatarContract;
  const floorSnapshot = [{ s: 0, v: new Array(10).fill(1) }];
  floorContract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: floorSnapshot }));
  const floorInitial = floorContract.getState().envelope.playbackStartWall;
  floorPage.clock.value = 1_800;
  floorContract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: floorSnapshot }));
  assert.ok(floorContract.getState().envelope.playbackStartWall > floorInitial);

  const freshPage = runRigEnvelopePage({ offset: 300, now: 0 });
  const freshContract = freshPage.sandbox.__localAvatarContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  freshContract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: [prior] }));
  const freshInitial = freshContract.getState().envelope.playbackStartWall;
  freshPage.clock.value = 5_000;
  freshContract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1, 1] }] }));
  const firstFresh = freshContract.getState().envelope.playbackStartWall;
  freshPage.clock.value = 6_200;
  freshContract.acceptState(rigMarker({ sequence: 2, sampleIndex: 2_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1, 1, 1, 1] }] }));
  const secondFresh = freshContract.getState().envelope.playbackStartWall;
  assert.ok(firstFresh > freshInitial);
  assert.ok(secondFresh > firstFresh);
  assert.equal(secondFresh, 5_800, "each accepted state applies the fresh formula once");
});

test("forward-only 16e start-aligns a resumed mid-utterance rig chunk", () => {
  const page = runRigEnvelopePage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarContract;
  const prefix = { s: 0, v: new Array(5).fill(1) };
  contract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: [prefix] }));

  page.clock.value = 1_500;
  contract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prefix, { s: 500, v: [1, 1] }] }));
  assert.equal(contract.getState().envelope.playbackStartWall, 1_300, "the resumed chunk start, not its end, is aligned");
  page.frames.shift()(1_801);
  assert.ok(contract.getState().rigMouth > 0);
});

test("forward-only 16f preserves rig epoch, boundary, hole, and filtered-empty edges", () => {
  const epochPage = runRigEnvelopePage({ offset: 300, now: 5_000 });
  const epochContract = epochPage.sandbox.__localAvatarContract;
  epochContract.acceptState(rigMarker({ outputEpoch: 1, sampleRate: 1_000, envelopes: [{ s: 0, v: [1] }] }));
  assert.equal(epochContract.getState().envelope.playbackStartWall, 5_300, "an epoch change keeps the initial-anchor path");

  const page = runRigEnvelopePage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  const withHole = [prior, { s: 500, v: [1] }, { s: 700, v: [1] }];
  contract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: [prior] }));
  page.clock.value = 5_000;
  contract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: withHole }));
  assert.equal(contract.getState().envelope.windowCount, 2, "ending exactly at freshStart drops and starting there stays");
  page.frames.shift()(5_301);
  assert.ok(contract.getState().rigMouth > 0);
  page.frames.shift()(5_401);
  assert.equal(contract.getState().rigMouth, 0, "an interior hole uses the flapper fallback");

  page.clock.value = 5_100;
  contract.acceptState(rigMarker({ sequence: 2, sampleIndex: 2_000, sampleRate: 1_000, envelopes: [prior] }));
  const pending = contract.getState();
  assert.equal(pending.rigEnvelopeActive, false);
  assert.equal(pending.envelope.windowCount, 0);
  assert.equal(pending.envelope.playbackStartWall, 4_800, "filtered-empty keeps the existing anchor and derived-state semantics");

  page.clock.value = 6_500;
  contract.acceptState(rigMarker({ sequence: 3, sampleIndex: 3_000, sampleRate: 1_000, envelopes: [...withHole, { s: 800, v: [1] }] }));
  assert.equal(contract.getState().envelope.playbackStartWall, 6_000, "filtered-empty does not null the previous newest end");
});

test("forward-only 16g clears the rig watermark through every public reset path", () => {
  const cases = ["cancel epoch", "cancel", "idle", "output epoch"];
  for (const resetCase of cases) {
    const page = runRigEnvelopePage({ offset: 300, now: 0 });
    const contract = page.sandbox.__localAvatarContract;
    const prior = { s: 0, v: new Array(5).fill(1) };
    contract.acceptState(rigMarker({ sampleRate: 1_000, envelopes: [prior] }));
    page.clock.value = 5_000;
    contract.acceptState(rigMarker({ sequence: 1, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1] }] }));

    page.clock.value = 6_000;
    if (resetCase === "cancel epoch") {
      contract.acceptState(rigMarker({ cancelEpoch: 1, sequence: 2, sampleIndex: 0, sampleRate: 1_000, envelopes: [{ s: 0, v: new Array(4).fill(1) }] }));
    } else if (resetCase === "output epoch") {
      contract.acceptState(rigMarker({ sequence: 2, outputEpoch: 1, sampleIndex: 0, sampleRate: 1_000, envelopes: [{ s: 0, v: new Array(4).fill(1) }] }));
    } else {
      contract.acceptState(rigMarker({ kind: resetCase, sequence: 2, sampleIndex: null, sampleRate: null }));
      contract.acceptState(rigMarker({ sequence: 3, sampleIndex: 0, sampleRate: 1_000, envelopes: [{ s: 0, v: new Array(4).fill(1) }] }));
    }
    const state = contract.getState().envelope;
    assert.equal(state.windowCount, 4, `${resetCase} keeps new-epoch low samples`);
    assert.equal(state.playbackStartWall, 6_300, `${resetCase} re-runs the initial anchor path`);
  }
});

test("generated page retains the frozen capability and network surface", () => {
  const script = shippedScript();
  const shipped = `${fs.readFileSync(HTML_FILE, "utf8")}\n${script}`;
  assert.ok(Buffer.byteLength(script) < 2_500_000, "shipped rig script must stay below 2.5 MB");
  assert.match(script, /Generated from modified pinned Anime2\.5DRig and ag-psd sources/);
  assert.equal(/GenericParts|genericparts/.test(script), false, "unused GenericParts code must not ship");
  assert.equal(/\b(?:https?:)?\/\//i.test(shipped), false);
  for (const token of [
    "WebSocket",
    "EventSource",
    "sendBeacon",
    "AudioContext",
    "<audio",
    "<video",
    "mediaDevices",
    "getUserMedia",
    "captureStream",
    "MediaStream",
    "serviceWorker",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
  ]) {
    assert.equal(shipped.includes(token), false, `forbidden token present: ${token}`);
  }
  assert.deepEqual([...script.matchAll(/fetch\(([^,]+)/g)].map((match) => match[1].trim()), ["stateUrl(parameters)"]);
});

test("rig generator round-trips a slash-bearing PNG through a slash-free background embed", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-local-avatar-bg-"));
  const generatedFile = path.join(temporaryDirectory, "local-avatar.js");
  const backgroundFile = path.join(ROOT, "assets", "avatar.png");
  const background = fs.readFileSync(backgroundFile);
  assert.equal(background.toString("base64").includes("//"), true, "fixture must exercise the standard-base64 URL token hazard");
  try {
    execFileSync(process.execPath, [
      GENERATOR,
      "--background",
      backgroundFile,
      "--out",
      generatedFile,
    ], { cwd: ROOT });
    const generated = fs.readFileSync(generatedFile, "utf8");
    assert.deepEqual(embeddedBackground(generated), background);
    assert.equal(/\b(?:https?:)?\/\//i.test(generated), false);
    assert.ok(Buffer.byteLength(generated) < 2_500_000);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("rig generator refuses a background that would exceed the frozen page cap", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-local-avatar-bg-cap-"));
  const generatedFile = path.join(temporaryDirectory, "local-avatar.js");
  const backgroundFile = path.join(temporaryDirectory, "oversize.png");
  fs.writeFileSync(backgroundFile, Buffer.alloc(1_500_000, 0xff));
  try {
    const result = spawnSync(process.execPath, [
      GENERATOR,
      "--background",
      backgroundFile,
      "--out",
      generatedFile,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds the 2\.5 MB cap/);
    assert.equal(fs.existsSync(generatedFile), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("rig generator exactly reproduces the shipped script without mutating it", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-local-avatar-rig-"));
  const generatedFile = path.join(temporaryDirectory, "local-avatar.js");
  const shippedBefore = fs.readFileSync(SCRIPT_FILE);
  try {
    execFileSync(process.execPath, [GENERATOR, "--out", generatedFile], { cwd: ROOT });
    assert.deepEqual(fs.readFileSync(generatedFile), shippedBefore);
    assert.deepEqual(fs.readFileSync(SCRIPT_FILE), shippedBefore);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("active rig backgrounds apply connect-only solid and chroma values with image fallback", async () => {
  const defaultBackground = await runBackgroundPage(shippedScript(), undefined);
  defaultBackground.draws.length = 0;
  defaultBackground.frames.shift()(1000);
  assert.deepEqual(defaultBackground.draws[0], ["fill", "#08111f", 0, 0, 1280, 720]);

  const solid = await runBackgroundPage(shippedScript(), { mode: "solid", color: "#123456" });
  solid.draws.length = 0;
  solid.frames.shift()(1000);
  assert.deepEqual(solid.draws[0], ["fill", "#123456", 0, 0, 1280, 720]);

  const chroma = await runBackgroundPage(shippedScript(), { mode: "chroma", color: "#123456" });
  chroma.draws.length = 0;
  chroma.frames.shift()(1000);
  assert.deepEqual(chroma.draws[0], ["fill", "#00FF00", 0, 0, 1280, 720]);

  const imageWithoutEmbed = await runBackgroundPage(shippedScript(), { mode: "image", color: "#654321" });
  imageWithoutEmbed.draws.length = 0;
  imageWithoutEmbed.frames.shift()(1000);
  assert.deepEqual(imageWithoutEmbed.draws[0], ["fill", "#654321", 0, 0, 1280, 720]);

  const markerBackground = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
    background: { mode: "chroma", color: "#000000" },
  };
  assert.equal(solid.sandbox.__localAvatarContract.acceptState(markerBackground), true);
  solid.draws.length = 0;
  solid.frames.shift()(1100);
  assert.deepEqual(solid.draws[0], ["fill", "#123456", 0, 0, 1280, 720]);
});

test("embedded image backgrounds decode through Blob and cover the active rig letterbox", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-local-avatar-bg-page-"));
  const generatedFile = path.join(temporaryDirectory, "local-avatar.js");
  const backgroundFile = path.join(ROOT, "assets", "avatar.png");
  try {
    execFileSync(process.execPath, [GENERATOR, "--background", backgroundFile, "--out", generatedFile], { cwd: ROOT });
    const bitmap = { width: 640, height: 480 };
    let decodedBytes = null;
    const page = await runBackgroundPage(
      fs.readFileSync(generatedFile, "utf8"),
      { mode: "image", color: "#123456" },
      async (blob) => {
        decodedBytes = Buffer.from(await blob.arrayBuffer());
        return bitmap;
      },
    );
    assert.deepEqual(decodedBytes, fs.readFileSync(backgroundFile));
    page.draws.length = 0;
    page.frames.shift()(1000);
    const backgroundDraw = page.draws.find((draw) => draw[0] === "image" && draw[1] === bitmap);
    assert.ok(backgroundDraw);
    assert.deepEqual(backgroundDraw.slice(-4), [0, 0, 1280, 720]);

    const failed = await runBackgroundPage(
      fs.readFileSync(generatedFile, "utf8"),
      { mode: "image", color: "#654321" },
      async () => { throw new Error("decode failed"); },
    );
    failed.draws.length = 0;
    failed.frames.shift()(1000);
    assert.deepEqual(failed.draws[0], ["fill", "#654321", 0, 0, 1280, 720]);
    assert.equal(failed.errors.length, 1);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function rigMarker({
  kind = "marker",
  generation = 0,
  cancelEpoch = 0,
  sequence = 0,
  outputEpoch = 0,
  sampleIndex = 0,
  sampleRate = 24_000,
  envelopes,
} = {}) {
  return {
    kind,
    generation,
    cancelEpoch,
    sequence,
    outputEpoch,
    sampleIndex,
    sampleRate,
    ...(envelopes === undefined ? {} : { envelopes }),
  };
}

function runRigEnvelopePage({ dateNow = 0, now = 0, offset = 0 } = {}) {
  const frames = [];
  const clock = { value: now };
  const gl = createWebGlStub([], () => {});
  const context = {
    fillRect: () => {},
    fillText: () => {},
    drawImage: () => {},
    set fillStyle(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
  };
  const sandbox = {
    URLSearchParams,
    Date: { now: () => dateNow },
    location: { pathname: "/local-avatar/index.html", search: `?offset=${offset}`, hash: "" },
    history: { replaceState: () => {} },
    document: {
      getElementById: () => ({ width: 1280, height: 720, getContext: () => context }),
      createElement: () => ({ width: 0, height: 0, getContext: () => gl }),
    },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    fetch: async () => { throw new Error("state request is not expected"); },
    setTimeout: () => 1,
    clearTimeout: () => {},
    performance: { now: () => clock.value },
  };
  vm.createContext(sandbox);
  vm.runInContext(shippedScript(), sandbox, { filename: SCRIPT_FILE });
  return { sandbox, frames, clock };
}

async function runBackgroundPage(script, background, createBitmap = async () => ({ width: 640, height: 480 })) {
  const frames = [];
  const draws = [];
  const errors = [];
  const gl = createWebGlStub([], () => {});
  let fillStyle = null;
  const context = {
    fillRect: (...args) => draws.push(["fill", fillStyle, ...args]),
    fillText: (...args) => draws.push(["text", ...args]),
    drawImage: (...args) => draws.push(["image", ...args]),
    set fillStyle(value) { fillStyle = value; },
    set font(_value) {},
    set textAlign(_value) {},
  };
  const initial = {
    kind: "idle",
    generation: 1,
    cancelEpoch: 0,
    sequence: 1,
    outputEpoch: -1,
    sampleIndex: null,
    sampleRate: null,
    background,
  };
  const sandbox = {
    URLSearchParams,
    Blob,
    console: { error: (...args) => errors.push(args) },
    createImageBitmap: createBitmap,
    location: {
      pathname: "/local-avatar/index.html",
      search: "?v=abcdefghijklmnop",
      hash: "#cap=secret",
    },
    history: { replaceState: () => {} },
    document: {
      getElementById: () => ({ width: 1280, height: 720, getContext: () => context }),
      createElement: () => ({ width: 0, height: 0, getContext: () => gl }),
    },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    fetch: async () => ({ ok: true, status: 200, json: async () => initial }),
    setTimeout: () => 1,
    clearTimeout: () => {},
    performance: { now: () => 0 },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: SCRIPT_FILE });
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  return { sandbox, frames, draws, errors };
}

function createWebGlStub(uploaded, onDraw, onUniform = () => {}) {
  let value = 1;
  const constant = () => value++;
  const gl = {
    VERTEX_SHADER: constant(),
    FRAGMENT_SHADER: constant(),
    COMPILE_STATUS: constant(),
    LINK_STATUS: constant(),
    BLEND: constant(),
    ONE: constant(),
    ONE_MINUS_SRC_ALPHA: constant(),
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: constant(),
    TEXTURE_2D: constant(),
    TEXTURE_MIN_FILTER: constant(),
    TEXTURE_MAG_FILTER: constant(),
    LINEAR: constant(),
    TEXTURE_WRAP_S: constant(),
    TEXTURE_WRAP_T: constant(),
    CLAMP_TO_EDGE: constant(),
    RGBA: constant(),
    UNSIGNED_BYTE: constant(),
    ARRAY_BUFFER: constant(),
    ELEMENT_ARRAY_BUFFER: constant(),
    STATIC_DRAW: constant(),
    DYNAMIC_DRAW: constant(),
    STENCIL_TEST: constant(),
    ALWAYS: constant(),
    EQUAL: constant(),
    KEEP: constant(),
    REPLACE: constant(),
    TRIANGLES: constant(),
    UNSIGNED_SHORT: constant(),
    FLOAT: constant(),
    COLOR_BUFFER_BIT: 1,
    STENCIL_BUFFER_BIT: 2,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    useProgram: () => {},
    getAttribLocation: () => 0,
    getUniformLocation: (_program, name) => name,
    uniform2f: () => {},
    uniform1f: onUniform,
    enable: () => {},
    disable: () => {},
    blendFunc: () => {},
    pixelStorei: () => {},
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: (_target, data) => { uploaded.push(data); },
    viewport: () => {},
    clearColor: () => {},
    clearStencil: () => {},
    clear: () => {},
    stencilMask: () => {},
    stencilFunc: () => {},
    stencilOp: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    drawElements: onDraw,
  };
  return gl;
}
