const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { stringify } = require("node:querystring");
const {
  createLocalAvatarSession,
  FRAMES_HTML_ROUTE,
} = require("../src/transport-meet/local-avatar-session");

const PUBLIC_DIR = path.join(__dirname, "..", "public", "local-avatar");
const HTML_FILE = path.join(PUBLIC_DIR, "frames.html");
const SCRIPT_FILE = path.join(PUBLIC_DIR, "frames.js");
const ROOT = path.join(__dirname, "..");
const GENERATOR = path.join(ROOT, "scripts", "build-local-avatar-rig.js");

function shippedFramesScript() {
  return fs.readFileSync(SCRIPT_FILE, "utf8");
}

function embeddedFramesBackground(script) {
  const match = script.match(/\/\* @frames-bg-begin \*\/([\s\S]*?)\/\* @frames-bg-end \*\//);
  assert.ok(match, "frames background embed markers must exist");
  const encoded = match[1].match(/const FRAMES_BACKGROUND_BASE64URL = "([A-Za-z0-9_-]*)";/);
  assert.ok(encoded, "frames background embed must use base64url bytes");
  return Buffer.from(encoded[1], "base64url");
}

function unavailableNgrokHttpGet() {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  queueMicrotask(() => request.emit("error", Object.assign(new Error("ngrok unavailable in test"), { code: "ECONNREFUSED" })));
  return request;
}

function liveNgrokHttpGet(_url, callback) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  queueMicrotask(() => {
    const response = new EventEmitter();
    callback(response);
    queueMicrotask(() => {
      response.emit("data", '{"tunnels":[{"proto":"https","public_url":"https://example.ngrok.app"}]}');
      response.emit("end");
    });
  });
  return request;
}

test("frame avatar page is an isolated dependency-free 1280x720 Canvas surface", () => {
  const html = fs.readFileSync(HTML_FILE, "utf8");
  const script = fs.readFileSync(SCRIPT_FILE, "utf8");
  const shipped = `${html}\n${script}`;

  assert.match(html, /<canvas\b[^>]*\bwidth="1280"[^>]*\bheight="720"/i);
  assert.match(html, /<script src="\/local-avatar\/frames\.js" defer><\/script>/i);
  assert.equal(/<script(?!\s+src=)[^>]*>\s*\S/i.test(html), false, "inline executable script is forbidden");
  assert.equal(/\b(?:https?:)?\/\//i.test(shipped), false, "third-party URL is forbidden");
  assert.equal(/\b(?:WebSocket|EventSource|sendBeacon)\b/.test(shipped), false);

  const forbidden = [
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
  ];
  for (const token of forbidden) {
    assert.equal(shipped.includes(token), false, `forbidden browser capability found: ${token}`);
  }

  assert.deepEqual(
    [...script.matchAll(/fetch\(([^,]+)/g)].map((match) => match[1].trim()),
    ["stateUrl(parameters)", "frameUrl(name)"],
  );
  assert.match(script, /const STATE_ROUTE = "\/local-avatar\/state"/);
  assert.match(script, /headers: \{ Authorization: `Bearer \$\{capability\}` \}/);
  assert.doesNotMatch(script, /(?:src|href)\s*=\s*["'](?!\/local-avatar\/)/i);
});

test("frames generator round-trips a slash-bearing PNG through a slash-free background embed", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-frames-bg-"));
  const generatedFrames = path.join(temporaryDirectory, "frames.js");
  const backgroundFile = path.join(ROOT, "assets", "avatar.png");
  const background = fs.readFileSync(backgroundFile);
  const shippedRig = fs.readFileSync(path.join(PUBLIC_DIR, "local-avatar.js"));
  assert.equal(background.toString("base64").includes("//"), true, "fixture must exercise the standard-base64 URL token hazard");
  try {
    execFileSync(process.execPath, [
      GENERATOR,
      "--background",
      backgroundFile,
      "--frames-out",
      generatedFrames,
    ], { cwd: ROOT });
    const generated = fs.readFileSync(generatedFrames, "utf8");
    assert.deepEqual(embeddedFramesBackground(generated), background);
    assert.equal(/\b(?:https?:)?\/\//i.test(generated), false);
    assert.ok(Buffer.byteLength(generated) < 2_500_000);
    assert.deepEqual(fs.readFileSync(path.join(PUBLIC_DIR, "local-avatar.js")), shippedRig);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("frames generator refuses a background that would exceed the frozen page cap", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-frames-bg-cap-"));
  const generatedFrames = path.join(temporaryDirectory, "frames.js");
  const backgroundFile = path.join(temporaryDirectory, "oversize.png");
  fs.writeFileSync(backgroundFile, Buffer.alloc(1_900_000, 0xff));
  try {
    const result = spawnSync(process.execPath, [
      GENERATOR,
      "--background",
      backgroundFile,
      "--frames-out",
      generatedFrames,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds the 2\.5 MB cap/);
    assert.equal(fs.existsSync(generatedFrames), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("frames backgrounds use rig-parity fallback, connect-only wiring, and chroma semantics", async () => {
  const marker = frameMarker({ sequence: 2, sampleIndex: 0 });
  for (const background of [
    undefined,
    { mode: "video", color: "#123456" },
    { mode: "solid", color: "green" },
    { mode: "solid" },
    { color: "#123456" },
  ]) {
    const page = await runFramesBackgroundPage(shippedFramesScript(), background);
    page.draws.length = 0;
    assert.equal(page.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000), true);
    assert.deepEqual(page.draws[0], ["fill", "#08111f", 0, 0, 1280, 720]);
  }

  const solid = await runFramesBackgroundPage(shippedFramesScript(), { mode: "solid", color: "#123456" });
  solid.draws.length = 0;
  assert.equal(solid.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000), true);
  assert.deepEqual(solid.draws[0], ["fill", "#123456", 0, 0, 1280, 720]);

  const chroma = await runFramesBackgroundPage(shippedFramesScript(), { mode: "chroma", color: "#123456" });
  chroma.draws.length = 0;
  assert.equal(chroma.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000), true);
  assert.deepEqual(chroma.draws[0], ["fill", "#00FF00", 0, 0, 1280, 720]);

  const imageWithoutEmbed = await runFramesBackgroundPage(shippedFramesScript(), { mode: "image", color: "#654321" });
  imageWithoutEmbed.draws.length = 0;
  assert.equal(imageWithoutEmbed.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000), true);
  assert.deepEqual(imageWithoutEmbed.draws[0], ["fill", "#654321", 0, 0, 1280, 720]);

  solid.draws.length = 0;
  assert.equal(solid.sandbox.__localAvatarFramesContract.acceptState({
    ...frameMarker({ sequence: 3, sampleIndex: 960, envelopes: [{ s: 0, v: [0.5] }] }),
    background: { mode: "chroma", color: "#000000" },
  }, 1_100), true);
  assert.deepEqual(solid.draws[0], ["fill", "#123456", 0, 0, 1280, 720]);
});

test("embedded image backgrounds decode through Blob and cover the frames letterbox", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-frames-bg-page-"));
  const generatedFrames = path.join(temporaryDirectory, "frames.js");
  const generatedRig = path.join(temporaryDirectory, "local-avatar.js");
  const backgroundFile = path.join(ROOT, "assets", "avatar.png");
  try {
    execFileSync(process.execPath, [
      GENERATOR,
      "--background",
      backgroundFile,
      "--out",
      generatedRig,
      "--frames-out",
      generatedFrames,
    ], { cwd: ROOT });
    const bitmap = { width: 640, height: 480 };
    let decodedBytes = null;
    const page = await runFramesBackgroundPage(
      fs.readFileSync(generatedFrames, "utf8"),
      { mode: "image", color: "#123456" },
      async (blob) => {
        decodedBytes = Buffer.from(await blob.arrayBuffer());
        return bitmap;
      },
    );
    assert.deepEqual(decodedBytes, fs.readFileSync(backgroundFile));
    page.draws.length = 0;
    assert.equal(page.sandbox.__localAvatarFramesContract.acceptState(frameMarker({ sequence: 2, sampleIndex: 0 }), 1_000), true);
    const backgroundDraw = page.draws.find((draw) => draw[0] === "image" && draw[1] === bitmap);
    assert.ok(backgroundDraw);
    assert.deepEqual(backgroundDraw.slice(-4), [0, 0, 1280, 720]);

    const failed = await runFramesBackgroundPage(
      fs.readFileSync(generatedFrames, "utf8"),
      { mode: "image", color: "#654321" },
      async () => { throw new Error("decode failed"); },
    );
    failed.draws.length = 0;
    assert.equal(failed.sandbox.__localAvatarFramesContract.acceptState(frameMarker({ sequence: 2, sampleIndex: 0 }), 1_000), true);
    assert.deepEqual(failed.draws[0], ["fill", "#654321", 0, 0, 1280, 720]);
    assert.equal(failed.errors.length, 1);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("frame renderer enters speaking only on fresh advancing markers and returns to idle", async () => {
  const page = await runFramesPage();
  const contract = page.sandbox.__localAvatarFramesContract;

  assert.deepEqual(page.sandbox.replaced, [null, "", "/local-avatar/frames.html?v=abcdefghijklmnop"]);
  assert.equal(contract.getState().generation, 1);
  assert.equal(contract.getState().currentFrame, "idle");
  assert.equal(contract.limits.markerFreshMs, 600);

  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
  };
  assert.equal(contract.acceptState(marker, 1_000), true);
  assert.equal(contract.getState().speaking, true);
  assert.match(contract.getState().currentFrame, /^talk/);

  contract.render(1_599);
  assert.equal(contract.getState().speaking, true);
  contract.render(1_600);
  assert.equal(contract.getState().speaking, false);
  assert.equal(contract.getState().currentFrame, "idle");

  assert.equal(contract.acceptState({ ...marker, sequence: 3, sampleIndex: 480 }, 2_000), true);
  const cancel = { ...marker, kind: "cancel", cancelEpoch: 1, sequence: 4, sampleIndex: null };
  assert.equal(contract.acceptState(cancel, 2_010), true);
  assert.equal(contract.getState().speaking, false);
  assert.equal(contract.getState().currentFrame, "idle");
  assert.equal(contract.acceptState({ ...marker, sequence: 5, sampleIndex: 960 }, 2_020), false);

  const reloaded = await runFramesPage();
  assert.equal(reloaded.sandbox.__localAvatarFramesContract.getState().speaking, false);
  assert.equal(reloaded.sandbox.__localAvatarFramesContract.getState().currentFrame, "idle");
});

test("envelope thresholds, quiet windows, and 300ms level-two cadence map deterministically", async () => {
  const page = await runFramesPage({ offset: 0, now: 0 });
  const contract = page.sandbox.__localAvatarFramesContract;
  assert.equal(contract.acceptState(frameMarker({
    envelopes: [{ s: 0, v: [0.374, 0.375, 0.75, 0.75, 0.75, 0.75] }],
  }), 0), true);

  contract.render(0);
  assert.equal(contract.getState().currentFrame, "idle");
  contract.render(100);
  assert.equal(contract.getState().currentFrame, "talk1");
  contract.render(200);
  assert.equal(contract.getState().currentFrame, "talk2");
  contract.render(299);
  assert.equal(contract.getState().currentFrame, "talk2");
  contract.render(300);
  assert.equal(contract.getState().currentFrame, "talk3");
});

test("envelope blink is independent during continuous speech and selects blink by level", async () => {
  const talking = await runFramesPage({ offset: 0, now: 0, random: () => 0 });
  const talkingContract = talking.sandbox.__localAvatarFramesContract;
  talkingContract.acceptState(frameMarker({ envelopes: [{ s: 0, v: new Array(60).fill(0.5) }] }), 0);
  talkingContract.render(2_499);
  assert.equal(talkingContract.getState().currentFrame, "talk1");
  talkingContract.render(2_500);
  assert.equal(talkingContract.getState().currentFrame, "talk_blink");
  talkingContract.render(2_649);
  assert.equal(talkingContract.getState().currentFrame, "talk_blink");
  talkingContract.render(2_650);
  assert.equal(talkingContract.getState().currentFrame, "talk1");

  const quiet = await runFramesPage({ offset: 0, now: 0, random: () => 0 });
  const quietContract = quiet.sandbox.__localAvatarFramesContract;
  quietContract.acceptState(frameMarker({ envelopes: [{ s: 0, v: new Array(60).fill(0) }] }), 0);
  quietContract.render(2_500);
  assert.equal(quietContract.getState().currentFrame, "blink");
});

test("envelope blink survives idle gaps, resets across epoch bumps, and clears stale holds", async () => {
  const page = await runFramesPage({ offset: 0, now: 0, random: () => 0 });
  const contract = page.sandbox.__localAvatarFramesContract;

  contract.acceptState(frameMarker({ envelopes: [{ s: 0, v: [1] }] }), 0);
  contract.render(100);
  contract.render(400);
  assert.equal(contract.getState().speaking, false);
  assert.equal(contract.getState().currentFrame, "idle");

  contract.acceptState(frameMarker({
    sequence: 3,
    sampleIndex: 57_600,
    envelopes: [{ s: 57_600, v: new Array(20).fill(0.5) }],
  }), 2_400);
  contract.render(2_499);
  assert.equal(contract.getState().currentFrame, "talk1");
  contract.render(2_500);
  assert.equal(contract.getState().currentFrame, "talk_blink", "same-epoch speech resumes keep the original blink deadline");

  contract.acceptState(frameMarker({
    sequence: 4,
    outputEpoch: 1,
    sampleIndex: 0,
    envelopes: [{ s: 0, v: new Array(40).fill(0) }],
  }), 2_550);
  assert.equal(contract.getState().envelope.epoch, 1);
  assert.equal(contract.getState().envelopeActive, true);
  assert.equal(contract.getState().envelope.mode, "anchored");
  assert.equal(contract.getState().currentFrame, "idle", "epoch bumps clear the stale blink hold and old voiced windows before the next utterance");
  contract.render(2_649);
  assert.equal(contract.getState().currentFrame, "idle");
  contract.render(5_050);
  assert.match(contract.getState().currentFrame, /blink$/, "the re-armed epoch still gets its own later blink");
});

test("anchor defers across empty or absent snapshots, rejects mid-stream starts, and retries on the next epoch", async () => {
  const page = await runFramesPage({ now: 0 });
  const contract = page.sandbox.__localAvatarFramesContract;
  assert.equal(contract.limits.offsetMs, 300);
  assert.equal(contract.acceptState(frameMarker({ envelopes: [] }), 0), true);
  assert.equal(contract.getState().envelope.mode, "pending");

  page.clock.value = 1_000;
  assert.equal(contract.acceptState(frameMarker({
    sequence: 3,
    sampleIndex: 2_400,
    envelopes: [{ s: 0, v: [0.5] }],
  }), 1_000), true);
  assert.equal(contract.getState().envelope.mode, "anchored");
  assert.equal(contract.getState().envelope.playbackStartWall, 1_300);

  const bare = await runFramesPage({ now: 0 });
  const bareContract = bare.sandbox.__localAvatarFramesContract;
  assert.equal(bareContract.acceptState(frameMarker(), 0), true);
  assert.equal(bareContract.getState().envelope.mode, "pending");
  bare.clock.value = 1_000;
  assert.equal(bareContract.acceptState(frameMarker({
    sequence: 3,
    sampleIndex: 2_400,
    envelopes: [{ s: 0, v: [0.5] }],
  }), 1_000), true);
  assert.equal(bareContract.getState().envelope.mode, "anchored");
  assert.equal(bareContract.getState().envelope.playbackStartWall, 1_300);

  const late = await runFramesPage({ offset: 0, now: 0 });
  const lateContract = late.sandbox.__localAvatarFramesContract;
  lateContract.acceptState(frameMarker({ envelopes: [{ s: 7_200, v: [0.5] }] }), 0);
  assert.equal(lateContract.getState().envelope.mode, "fallback");
  lateContract.acceptState(frameMarker({
    sequence: 3,
    sampleIndex: 2_400,
    envelopes: [{ s: 9_600, v: [0.5] }],
  }), 100);
  assert.equal(lateContract.getState().envelope.mode, "fallback");
  assert.equal(lateContract.getState().envelope.windowCount, 1, "unanchored state keeps only the latest snapshot");
  lateContract.acceptState(frameMarker({
    sequence: 4,
    outputEpoch: 1,
    sampleIndex: 0,
    envelopes: [{ s: 0, v: [0.5] }],
  }), 200);
  assert.equal(lateContract.getState().envelope.mode, "anchored");

  for (const invalid of ["NaN", "-1", "5001", ""]) {
    const invalidPage = await runFramesPage({ offset: invalid });
    assert.equal(invalidPage.sandbox.__localAvatarFramesContract.limits.offsetMs, 300);
  }
  const zeroOffset = await runFramesPage({ offset: "0" });
  assert.equal(zeroOffset.sandbox.__localAvatarFramesContract.limits.offsetMs, 0);
});

test("forward-only 16a keeps the no-fresh floor and its 500ms predicate edge", async () => {
  const page = await runFramesPage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarFramesContract;
  const snapshot = [{ s: 0, v: new Array(10).fill(1) }];
  contract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: snapshot }), 0);
  assert.equal(contract.getState().envelope.playbackStartWall, 300);

  page.clock.value = 1_799;
  contract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: snapshot }), 1_799);
  assert.equal(contract.getState().envelope.playbackStartWall, 300, "499ms behind does not fire");

  page.clock.value = 1_800;
  contract.acceptState(frameMarker({ sequence: 4, sampleIndex: 2_000, sampleRate: 1_000, envelopes: snapshot }), 1_800);
  assert.equal(contract.getState().envelope.playbackStartWall, 800, "500ms behind end-aligns forward");

  page.clock.value = 1_900;
  contract.acceptState(frameMarker({ sequence: 5, sampleIndex: 3_000, sampleRate: 1_000, envelopes: snapshot }), 1_900);
  assert.equal(contract.getState().envelope.playbackStartWall, 800, "the floor never moves backward");
});

test("forward-only 16b start-aligns fresh post-silence audio and drops the played tail", async () => {
  const page = await runFramesPage({ offset: 300, now: 0, random: () => 0.5 });
  const contract = page.sandbox.__localAvatarFramesContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  contract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: [prior] }), 0);

  page.clock.value = 3_000;
  contract.acceptState(frameMarker({
    sequence: 3,
    sampleIndex: 1_000,
    sampleRate: 1_000,
    envelopes: [prior, { s: 500, v: [1, 0.5] }],
  }), 3_000);
  const state = contract.getState();
  assert.equal(state.envelope.playbackStartWall, 2_800);
  assert.equal(state.envelope.windowCount, 2, "no window ending at or before freshStart survives");
  assert.equal(state.currentFrame, "idle", "arrival is the before-start phase, not fallback or past-end");
  contract.render(3_299);
  assert.equal(contract.getState().currentFrame, "idle");
  contract.render(3_301);
  assert.match(contract.getState().currentFrame, /^talk/, "fresh values render immediately after OFFSET");
});

test("forward-only 16b2 keeps the watermark sticky across superset snapshots", async () => {
  const page = await runFramesPage({ offset: 300, now: 0, random: () => 0.5 });
  const contract = page.sandbox.__localAvatarFramesContract;
  const snapshot = [{ s: 0, v: new Array(5).fill(1) }, { s: 500, v: [1, 0.5] }];
  contract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: [snapshot[0]] }), 0);
  page.clock.value = 3_000;
  contract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: snapshot }), 3_000);

  page.clock.value = 3_100;
  contract.acceptState(frameMarker({ sequence: 4, sampleIndex: 2_000, sampleRate: 1_000, envelopes: snapshot }), 3_100);
  const state = contract.getState();
  assert.equal(state.envelope.playbackStartWall, 2_800);
  assert.equal(state.envelope.windowCount, 2, "the next superset cannot restore the played tail");
  assert.equal(state.currentFrame, "idle", "the second accept remains in OFFSET pre-roll");
});

test("forward-only 16c does not re-shift when the accepted frontier is ahead", async () => {
  const page = await runFramesPage({ offset: 300, now: 0 });
  const contract = page.sandbox.__localAvatarFramesContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  contract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: [prior] }), 0);
  page.clock.value = 5_000;
  contract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1, 1] }] }), 5_000);
  const aligned = contract.getState().envelope.playbackStartWall;

  page.clock.value = 5_100;
  contract.acceptState(frameMarker({ sequence: 4, sampleIndex: 2_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: new Array(7).fill(1) }] }), 5_100);
  assert.equal(contract.getState().envelope.playbackStartWall, aligned);
});

test("forward-only 16d remains monotonic across no-fresh and consecutive fresh alignments", async () => {
  const floorPage = await runFramesPage({ offset: 300, now: 0 });
  const floorContract = floorPage.sandbox.__localAvatarFramesContract;
  const floorSnapshot = [{ s: 0, v: new Array(10).fill(1) }];
  floorContract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: floorSnapshot }), 0);
  const floorInitial = floorContract.getState().envelope.playbackStartWall;
  floorPage.clock.value = 1_800;
  floorContract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: floorSnapshot }), 1_800);
  assert.ok(floorContract.getState().envelope.playbackStartWall > floorInitial);

  const freshPage = await runFramesPage({ offset: 300, now: 0 });
  const freshContract = freshPage.sandbox.__localAvatarFramesContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  freshContract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: [prior] }), 0);
  const freshInitial = freshContract.getState().envelope.playbackStartWall;
  freshPage.clock.value = 5_000;
  freshContract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1, 1] }] }), 5_000);
  const firstFresh = freshContract.getState().envelope.playbackStartWall;
  freshPage.clock.value = 6_200;
  freshContract.acceptState(frameMarker({ sequence: 4, sampleIndex: 2_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1, 1, 1, 1] }] }), 6_200);
  const secondFresh = freshContract.getState().envelope.playbackStartWall;
  assert.ok(firstFresh > freshInitial);
  assert.ok(secondFresh > firstFresh);
  assert.equal(secondFresh, 5_800, "each accepted state applies the fresh formula once");
});

test("forward-only 16e start-aligns a resumed mid-utterance chunk", async () => {
  const page = await runFramesPage({ offset: 300, now: 0, random: () => 0.5 });
  const contract = page.sandbox.__localAvatarFramesContract;
  const prefix = { s: 0, v: new Array(5).fill(1) };
  contract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: [prefix] }), 0);

  page.clock.value = 1_500;
  contract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prefix, { s: 500, v: [1, 1] }] }), 1_500);
  assert.equal(contract.getState().envelope.playbackStartWall, 1_300, "the resumed chunk start, not its end, is aligned");
  contract.render(1_801);
  assert.match(contract.getState().currentFrame, /^talk/);
});

test("forward-only 16f preserves epoch, boundary, hole, and filtered-empty edges", async () => {
  const epochPage = await runFramesPage({ offset: 300, now: 5_000 });
  const epochContract = epochPage.sandbox.__localAvatarFramesContract;
  epochContract.acceptState(frameMarker({ outputEpoch: 1, sampleRate: 1_000, envelopes: [{ s: 0, v: [1] }] }), 5_000);
  assert.equal(epochContract.getState().envelope.playbackStartWall, 5_300, "an epoch change keeps the initial-anchor path");

  const page = await runFramesPage({ offset: 300, now: 0, random: () => 0.5 });
  const contract = page.sandbox.__localAvatarFramesContract;
  const prior = { s: 0, v: new Array(5).fill(1) };
  const withHole = [prior, { s: 500, v: [1] }, { s: 700, v: [1] }];
  contract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: [prior] }), 0);
  page.clock.value = 5_000;
  contract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: withHole }), 5_000);
  assert.equal(contract.getState().envelope.windowCount, 2, "ending exactly at freshStart drops and starting there stays");
  contract.render(5_401);
  assert.match(contract.getState().currentFrame, /^talk/, "an interior hole uses the flapper fallback");

  page.clock.value = 5_100;
  contract.acceptState(frameMarker({ sequence: 4, sampleIndex: 2_000, sampleRate: 1_000, envelopes: [prior] }), 5_100);
  const pending = contract.getState();
  assert.equal(pending.envelopeActive, false);
  assert.equal(pending.envelope.windowCount, 0);
  assert.equal(pending.envelope.playbackStartWall, 4_800, "filtered-empty keeps the existing anchor and derived-state semantics");

  page.clock.value = 6_500;
  contract.acceptState(frameMarker({ sequence: 5, sampleIndex: 3_000, sampleRate: 1_000, envelopes: [...withHole, { s: 800, v: [1] }] }), 6_500);
  assert.equal(contract.getState().envelope.playbackStartWall, 6_000, "filtered-empty does not null the previous newest end");
});

test("forward-only 16g clears the watermark through every public reset path", async () => {
  const cases = ["cancel epoch", "cancel", "idle", "output epoch"];
  for (const resetCase of cases) {
    const page = await runFramesPage({ offset: 300, now: 0 });
    const contract = page.sandbox.__localAvatarFramesContract;
    const prior = { s: 0, v: new Array(5).fill(1) };
    contract.acceptState(frameMarker({ sampleRate: 1_000, envelopes: [prior] }), 0);
    page.clock.value = 5_000;
    contract.acceptState(frameMarker({ sequence: 3, sampleIndex: 1_000, sampleRate: 1_000, envelopes: [prior, { s: 500, v: [1] }] }), 5_000);

    page.clock.value = 6_000;
    if (resetCase === "cancel epoch") {
      contract.acceptState(frameMarker({ cancelEpoch: 1, sequence: 4, sampleIndex: 0, sampleRate: 1_000, envelopes: [{ s: 0, v: new Array(4).fill(1) }] }), 6_000);
    } else if (resetCase === "output epoch") {
      contract.acceptState(frameMarker({ sequence: 4, outputEpoch: 1, sampleIndex: 0, sampleRate: 1_000, envelopes: [{ s: 0, v: new Array(4).fill(1) }] }), 6_000);
    } else {
      contract.acceptState(frameMarker({ kind: resetCase, sequence: 4, sampleIndex: null, sampleRate: null }), 6_000);
      contract.acceptState(frameMarker({ sequence: 5, sampleIndex: 0, sampleRate: 1_000, envelopes: [{ s: 0, v: new Array(4).fill(1) }] }), 6_000);
    }
    const state = contract.getState().envelope;
    assert.equal(state.windowCount, 4, `${resetCase} keeps new-epoch low samples`);
    assert.equal(state.playbackStartWall, 6_300, `${resetCase} re-runs the initial anchor path`);
  }
});

test("three-way lookup keeps pre-roll quiet, falls back only for interior holes, and idles after end grace", async () => {
  const preRoll = await runFramesPage({ offset: 300, now: 0, random: () => 0.5 });
  const preRollContract = preRoll.sandbox.__localAvatarFramesContract;
  preRollContract.acceptState(frameMarker({ envelopes: [{ s: 0, v: [1] }, { s: 4_800, v: [1] }] }), 0);
  preRollContract.render(0);
  assert.equal(preRollContract.getState().currentFrame, "idle", "OFFSET pre-roll never flaps");

  const page = await runFramesPage({ offset: 0, now: 0, random: () => 0.5 });
  const contract = page.sandbox.__localAvatarFramesContract;
  contract.acceptState(frameMarker({ envelopes: [{ s: 0, v: [1] }, { s: 4_800, v: [1] }] }), 0);
  contract.render(100);
  assert.match(contract.getState().currentFrame, /^talk/, "an interior missing grid window uses legacy fallback");
  contract.render(300);
  assert.equal(contract.getState().currentFrame, "idle");
  assert.equal(contract.getState().speaking, true);
  contract.render(599);
  assert.equal(contract.getState().speaking, true);
  contract.render(600);
  assert.equal(contract.getState().speaking, false);
  contract.render(3_000);
  assert.equal(contract.getState().currentFrame, "idle");
  contract.acceptState(frameMarker({
    sequence: 3,
    sampleIndex: 72_000,
    envelopes: [{ s: 72_000, v: [1] }],
  }), 3_000);
  assert.match(contract.getState().currentFrame, /^talk/, "fresh same-epoch windows still render from the anchored schedule after pruning");

  contract.acceptState(frameMarker({ sequence: 4, sampleIndex: 74_400 }), 3_010);
  assert.equal(contract.getState().envelopeActive, false, "a bare marker switches to byte-compatible legacy rendering");
  assert.match(contract.getState().currentFrame, /^talk/);
});

test("legacy no-envelope rendering still exercises the idle blink cadence", async () => {
  const page = await runFramesPage({ offset: 0, now: 0, random: () => 0 });
  const contract = page.sandbox.__localAvatarFramesContract;
  contract.acceptState(frameMarker(), 0);
  assert.equal(contract.getState().envelopeActive, false);
  contract.render(599);
  assert.equal(contract.getState().speaking, true);
  contract.render(600);
  assert.equal(contract.getState().speaking, false);
  contract.render(4_599);
  assert.equal(contract.getState().currentFrame, "idle");
  contract.render(4_600);
  assert.equal(contract.getState().currentFrame, "blink");
});

test("cancel signals, marker-borne cancel epochs, and reconnect storms clear the active envelope schedule", async () => {
  const page = await runFramesPage({
    offset: 0,
    now: 0,
    stateHandler: async ({ params, stateCallCount }) => {
      if (params.connect === "1" && stateCallCount === 1) {
        return jsonResponse(frameMarker({
          generation: 1,
          sequence: 1,
          envelopes: [{ s: 0, v: new Array(60).fill(0.5) }],
        }));
      }
      throw new Error("network dropped");
    },
  });
  const contract = page.sandbox.__localAvatarFramesContract;
  assert.equal(contract.getState().generation, 1);
  assert.equal(contract.getState().envelopeActive, true);

  contract.acceptState(frameMarker({
    kind: "cancel",
    cancelEpoch: 1,
    sequence: 3,
    sampleIndex: null,
    envelopes: undefined,
  }), 10);
  assert.equal(contract.getState().envelopeActive, false);
  assert.equal(contract.getState().envelope.windowCount, 0);

  contract.acceptState(frameMarker({
    cancelEpoch: 1,
    sequence: 4,
    outputEpoch: 1,
    sampleIndex: 0,
    envelopes: [{ s: 0, v: [0.5] }],
  }), 20);
  assert.equal(contract.getState().envelopeActive, true);
  assert.equal(contract.getState().envelope.epoch, 1);

  contract.acceptState(frameMarker({
    cancelEpoch: 2,
    sequence: 5,
    outputEpoch: 1,
    sampleIndex: 2_400,
    envelopes: [{ s: 2_400, v: [0] }],
  }), 100);
  assert.equal(contract.getState().cancelEpoch, 2);
  assert.equal(contract.getState().envelopeActive, true);
  assert.equal(contract.getState().currentFrame, "idle", "a marker-borne cancel epoch clears the old schedule before applying the new window");

  await fireTimer(page.timers, 100);
  assert.equal(contract.getState().generation, 0);
  assert.equal(contract.getState().envelopeActive, false);
  assert.equal(contract.getState().envelope.windowCount, 0);
  assert.equal(contract.getState().currentFrame, "idle");

  for (const backoff of [250, 500, 1000, 2000, 4000, 4000]) {
    await fireTimer(page.timers, backoff);
  }
  assert.equal(contract.getState().stopped, true);
  assert.equal(contract.getState().generation, 0);
  assert.equal(contract.getState().envelope.windowCount, 0);
  assert.equal(contract.getState().currentFrame, "idle");
});

test("missing or broken frames fail closed to idle and then the diagnostic canvas", async () => {
  const missingTalk = await runFramesPage({ frameFailures: new Set(["talk2"]) });
  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
  };
  assert.doesNotThrow(() => missingTalk.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000));
  assert.equal(missingTalk.sandbox.__localAvatarFramesContract.getState().currentFrame, "idle");

  const missingIdle = await runFramesPage({ frameFailures: new Set(["idle", "talk2"]) });
  assert.doesNotThrow(() => missingIdle.sandbox.__localAvatarFramesContract.acceptState(marker, 1_000));
  assert.equal(missingIdle.sandbox.__localAvatarFramesContract.getState().currentFrame, "diagnostic");
  assert.ok(missingIdle.drawCalls.some((call) => call[0] === "text" && call[1] === "IDLE"));
});

test("slow network: idle frame paints as soon as it arrives, before the talk frames finish", async () => {
  const gate = {};
  const held = new Set(["talk1", "talk2", "talk3", "blink", "talk_blink"]);
  const page = await runFramesPage({ holdFrames: held, gate });
  const contract = page.sandbox.__localAvatarFramesContract;

  assert.equal(contract.getState().currentFrame, "idle", "idle must render while talk frames are still loading");
  assert.ok(page.drawCalls.some((call) => call[0] === "image"), "idle bitmap must be drawn, not a placeholder");
  assert.equal(page.drawCalls.some((call) => call[0] === "text"), false, "no IDLE diagnostic flash while loading");

  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
  };
  assert.doesNotThrow(() => contract.acceptState(marker, 1_000));
  assert.equal(contract.getState().currentFrame, "idle", "talk falls back to idle until talk frames arrive");

  gate.release();
  await settleMicrotasks();
  assert.doesNotThrow(() => contract.acceptState({ ...marker, sequence: 3, sampleIndex: 960 }, 1_100));
  assert.match(contract.getState().currentFrame, /^talk/, "lip-sync upgrades once talk frames land");

  const idleDraw = page.drawCalls.find((call) => call[0] === "image");
  assert.deepEqual(idleDraw.slice(2), [280, 0, 720, 720], "contain-fit letterboxes a square frame on the 16:9 canvas");
  assert.ok(page.timers.some((timer) => timer.ms === 40), "the 40ms render loop is scheduled at startup");
});

test("frame preload serializes idle then blink before starting any talk request", async () => {
  const gate = {};
  const page = await runFramesPage({ holdFrames: new Set(["blink"]), gate });
  assert.deepEqual(page.frameRequests, ["idle", "blink"]);
  gate.release();
  await settleMicrotasks();
  assert.deepEqual(page.frameRequests, ["idle", "blink", "talk1", "talk2", "talk3", "talk_blink"]);
});

test("stalled idle fetch latches the diagnostic after the grace window and a late idle replaces it", async () => {
  const gate = {};
  const page = await runFramesPage({
    holdFrames: new Set(["idle", "talk1", "talk2", "talk3", "blink", "talk_blink"]),
    gate,
  });
  const contract = page.sandbox.__localAvatarFramesContract;
  assert.equal(contract.getState().currentFrame, "blank", "blank while inside the grace window");

  const grace = page.timers.find((timer) => timer.ms === 15_000);
  assert.ok(grace && !grace.cleared, "an idle grace timer is armed");
  grace.fn();
  assert.equal(contract.getState().currentFrame, "diagnostic", "grace window expiry paints the diagnostic");
  assert.ok(page.drawCalls.some((call) => call[0] === "text" && call[1] === "IDLE"));

  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 0,
    sampleRate: 24_000,
  };
  assert.doesNotThrow(() => contract.acceptState(marker, 1_000));
  assert.equal(contract.getState().currentFrame, "diagnostic", "markers cannot repaint the latched diagnostic to blank");

  gate.release();
  await settleMicrotasks();
  assert.equal(contract.getState().currentFrame, "idle", "a decoded idle replaces the diagnostic without any state event");
});

test("frame assets require the session capability and an exact allowlisted PNG route", { concurrency: false }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-avatar-frames-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const frameDir = path.join(home, "assets", "avatar-frames");
  fs.mkdirSync(frameDir, { recursive: true });
  fs.writeFileSync(path.join(frameDir, "idle.png"), Buffer.from("allowed-idle-frame"));
  fs.writeFileSync(path.join(frameDir, "talk4.png"), Buffer.from("must-remain-rejected"));

  await withFreshUiRoutes(home, async ({ serveLocalAvatar, localAvatarCsp }) => {
    const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
    try {
      const visualId = encodeURIComponent(issued.session.visualId);
      const validPath = `/local-avatar/frames/idle.png?v=${visualId}`;
      const valid = await requestRoute(serveLocalAvatar, "GET", validPath, authHeaders(issued.capability));
      assertFrameHeaders(valid, 200, localAvatarCsp);
      assert.equal(valid.body.toString("utf8"), "allowed-idle-frame");

      assertFrameHeaders(
        await requestRoute(serveLocalAvatar, "GET", validPath, authHeaders(tamperCapability(issued.capability))),
        404,
        localAvatarCsp,
      );
      assertFrameHeaders(await requestRoute(serveLocalAvatar, "GET", validPath), 404, localAvatarCsp);

      for (const requestPath of [
        `/local-avatar/frames/../evil.png?v=${visualId}`,
        `/local-avatar/frames/%2e%2e/evil.png?v=${visualId}`,
        `/local-avatar/frames/idle.svg?v=${visualId}`,
        `/local-avatar/frames/talk4.png?v=${visualId}`,
        `/local-avatar/frames/idle.png?v=${visualId}&extra=1`,
      ]) {
        assertFrameHeaders(
          await requestRoute(serveLocalAvatar, "GET", requestPath, authHeaders(issued.capability)),
          404,
          localAvatarCsp,
        );
      }

      const missing = await requestRoute(
        serveLocalAvatar,
        "GET",
        `/local-avatar/frames/blink.png?v=${visualId}`,
        authHeaders(issued.capability),
      );
      assertFrameHeaders(missing, 404, localAvatarCsp);
    } finally {
      issued.session.close();
    }
  });
});

test("frame launch selection is explicit and leaves the H0 default unchanged", () => {
  const legacy = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  const frames = createLocalAvatarSession({
    publicOrigin: "https://meetmate.example",
    htmlRoute: FRAMES_HTML_ROUTE,
  });
  try {
    assert.equal(new URL(legacy.launchUrl).pathname, "/local-avatar/index.html");
    assert.equal(new URL(frames.launchUrl).pathname, "/local-avatar/frames.html");
    assert.throws(
      () => createLocalAvatarSession({ publicOrigin: "https://meetmate.example", htmlRoute: "/local-avatar/evil.html" }),
      /invalid local avatar HTML route/,
    );

  } finally {
    legacy.session.close();
    frames.session.close();
  }
});

test("hybrid-local-frames joins only on Fish Audio with a public HTTPS origin", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: "hybrid-local-frames" });
    assert.equal(join.statusCode, 200);
    const payload = JSON.parse(harness.botRequests[0].body);
    const launch = new URL(payload.voice_agent_settings.url);
    assert.equal(launch.origin, "https://meetmate.example");
    assert.equal(launch.pathname, "/local-avatar/frames.html");
    assert.match(launch.searchParams.get("v"), /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(Buffer.from(new URLSearchParams(launch.hash.slice(1)).get("cap"), "base64url").length, 32);
    assert.equal((await harness.leave()).statusCode, 200);
  });

  const providerErrors = {};
  for (const experiment of ["hybrid-local-l0", "hybrid-local-frames"]) {
    await withMeetRoutes(async (harness) => {
      const join = await harness.join({ avatarExperiment: experiment });
      assert.equal(join.statusCode, 400);
      assert.equal(harness.botRequests.length, 0);
      providerErrors[experiment] = join.text;
    }, { ttsProvider: "other" });
  }
  assert.equal(providerErrors["hybrid-local-l0"], "hybrid-local-l0 は Fish Audio 構成でのみ利用できます。");
  assert.equal(
    providerErrors["hybrid-local-frames"].replace("hybrid-local-frames", "hybrid-local-l0"),
    providerErrors["hybrid-local-l0"],
  );

  const originErrors = {};
  for (const experiment of ["hybrid-local-l0", "hybrid-local-frames"]) {
    await withMeetRoutes(async (harness) => {
      const join = await harness.join({ avatarExperiment: experiment });
      assert.equal(join.statusCode, 400);
      assert.equal(harness.botRequests.length, 0);
      originErrors[experiment] = join.text;
      assert.equal(harness.hostHttpGetCalls(), 0);
      assert.equal(harness.probeHttpGetCalls(), 1);
    }, { ngrokDomain: "", hostHttpGet: liveNgrokHttpGet });
  }
  assert.equal(originErrors["hybrid-local-l0"], "hybrid-local-l0 には公開 HTTPS origin が必要です。");
  assert.equal(
    originErrors["hybrid-local-frames"].replace("hybrid-local-frames", "hybrid-local-l0"),
    originErrors["hybrid-local-l0"],
  );
});

test("settled soft readiness failures do not block an ordinary Join", { concurrency: false }, async () => {
  await withMeetRoutes(async ({ join, leave }) => {
    const readiness = require("../src/settings/readiness");
    readiness.setProbeObservation("soniox", { ok: false, code: "UNREACHABLE" });
    const joined = await join();
    assert.equal(joined.statusCode, 200, joined.text);
    await leave();
  });
});

test("unknown experiments stay rejected and hybrid-local-l0 payload bytes remain pinned", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: "unknown" });
    assert.equal(join.statusCode, 400);
    assert.equal(join.text, "avatarExperiment が不正です。");
    assert.equal(harness.botRequests.length, 0);
  });

  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: "hybrid-local-l0" });
    assert.equal(join.statusCode, 400);
    assert.equal(join.text, "hybrid-local-l0 には公開 HTTPS origin が必要です。");
    assert.equal(harness.hostHttpGetCalls(), 0);
    assert.equal(harness.probeHttpGetCalls(), 1);
  }, { ngrokDomain: "", hostHttpGet: liveNgrokHttpGet });

  let staticBody;
  await withMeetRoutes(async (harness) => {
    assert.equal((await harness.join()).statusCode, 200);
    staticBody = harness.botRequests[0].body;
    assert.equal((await harness.leave()).statusCode, 200);
  });

  await withMeetRoutes(async (harness) => {
    assert.equal((await harness.join({ avatarExperiment: "hybrid-local-l0" })).statusCode, 200);
    const livePayload = JSON.parse(harness.botRequests[0].body);
    assert.equal(new URL(livePayload.voice_agent_settings.url).pathname, "/local-avatar/index.html");
    delete livePayload.voice_agent_settings;
    assert.equal(JSON.stringify(livePayload), staticBody);
    assert.equal((await harness.leave()).statusCode, 200);
  });
});

async function withMeetRoutes(fn, { ttsProvider = "fish-audio", ngrokDomain = "meetmate.example", hostHttpGet = null } = {}) {
  const settingsResolver = require("../src/settings/resolver");
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const src = path.join(__dirname, "..", "src");
  const mockPaths = [
    "config.js",
    "pipeline.js",
    "gateway-warmup.js",
    "session-events.js",
    "slack-notifier.js",
    "summarizer.js",
    "agent-profile.js",
    "attendee-chat.js",
    "gateway-events.js",
    "metrics.js",
    "delegation-results.js",
    "gateway-session-tracker.js",
    "ui-routes.js",
    "paths.js",
  ].map((file) => path.join(src, file));
  const cachePaths = [routesPath, ...mockPaths];
  const previousCache = new Map(cachePaths.map((file) => [file, require.cache[file]]));
  for (const file of cachePaths) delete require.cache[file];

  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "test-key",
    FISH_AUDIO_API_KEY: "fish-test-key",
    SLACK_NOTIFY_ENABLED: "false",
    SUMMARY_ENABLED: "false",
    METRICS_DISABLED: "1",
    SESSION_GRACE_CLOSE_MS: "1",
  });
  settingsResolver.resetRuntimeForTest();
  settingsResolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      revision: "a".repeat(64),
      fingerprint: "local-avatar-frames",
      parsed: {
        agent: { id: "caty", displayName: "Caty", wakeWords: ["ケイティ"] },
        stt: { provider: "soniox", sonioxApiKey: "soniox-test-key" },
        tts: { provider: "fish-audio", apiKey: "fish-test-key", voiceId: "fish-test-voice" },
        attendee: { apiKey: "test-key" },
        server: { ngrokDomain },
        slack: { notifications: { enabled: false } },
        llm: { provider: "openclaw", model: "test" },
      },
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: "/tmp/meetmate-frames-home",
      configPath: "/tmp/meetmate-frames-home/config.json",
      connection: Object.freeze({
        provider: "openclaw",
        openclawUrl: "http://gateway.invalid",
        openclawToken: "test",
        openaiApiKey: "",
      }),
    }),
    serverPort: 5005,
  });

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: 24_000,
    TTS_PROVIDER: ttsProvider,
    loadConfig: () => ({
      attendee: { apiKey: "test-key" },
      server: { ngrokDomain },
      slack: { notifications: {} },
    }),
    validateSttProviderApiKey: () => true,
    resolveMessages: () => ({ delegation: {}, slack: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: () => ({
      stt: { provider: "soniox", sampleRate: 16_000 },
      llm: { provider: "openclaw", model: "test" },
      tts: { sampleRate: 24_000 },
      gatewayEvents: { enabled: false },
    }),
  });
  installMock(path.join(src, "pipeline.js"), { createPipeline: () => new EventEmitter() });
  installMock(path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: () => {},
    warmUpMultipleAgents: () => {},
  });
  installMock(path.join(src, "session-events.js"), { SessionLifecycle: FakeLifecycle });
  installMock(path.join(src, "slack-notifier.js"), { SlackNotifier: FakeSlackNotifier });
  installMock(path.join(src, "summarizer.js"), { summarizeConversation: async () => "" });
  installMock(path.join(src, "agent-profile.js"), {
    resolveAgentProfile: () => ({
      agentId: "caty",
      name: "Caty",
      displayName: "AI",
      attendeeApiKey: "test-key",
      wakeWords: ["ケイティ"],
    }),
    AgentNotFoundError: class AgentNotFoundError extends Error {},
  });
  installMock(path.join(src, "attendee-chat.js"), { sendAttendeeChatMessage: async () => true });
  installMock(path.join(src, "gateway-events.js"), {});
  installMock(path.join(src, "metrics.js"), { recordEvent: () => {} });
  installMock(path.join(src, "delegation-results.js"), { buildDelegationResultsSection: () => "" });
  installMock(path.join(src, "gateway-session-tracker.js"), {
    createGatewaySessionTracker: () => ({
      trackGatewaySession: () => {},
      untrackGatewaySession: () => false,
      findGatewayRoute: () => null,
    }),
  });
  installMock(path.join(src, "ui-routes.js"), {
    serveLocalAvatar: () => false,
    servePublicAsset: () => false,
    sendMetricsSummary: async () => false,
  });
  installMock(path.join(src, "paths.js"), {
    logsDir: () => "/tmp/meetmate-frames-logs",
    avatarCachePath: () => "/tmp/meetmate-frames-avatar.png",
    bundledAssetPath: (name) => `/tmp/${name}`,
    bundledPublicDir: () => "/tmp/meetmate-frames-public",
  });

  const botRequests = [];
  const readiness = require("../src/settings/readiness");
  readiness.reset();
  for (const system of readiness.gateSystems()) {
    readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  }
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalRandomUUID = crypto.randomUUID;
  const originalRandomBytes = crypto.randomBytes;
  crypto.randomUUID = () => "00000000-0000-4000-8000-000000000058";
  crypto.randomBytes = (size) => Buffer.alloc(size, 0x58);
  let hostHttpGetCallCount = 0;
  if (hostHttpGet) {
    http.get = (...args) => {
      hostHttpGetCallCount += 1;
      return hostHttpGet(...args);
    };
  }
  https.request = (options, callback) => {
    const record = { options, body: "" };
    if (options.path === "/api/v1/bots") botRequests.push(record);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = (chunk) => { record.body += String(chunk); };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = options.path === "/api/v1/bots" ? 201 : 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", options.path === "/api/v1/bots" ? '{"id":"bot-frames-58"}' : "{}");
        response.emit("end");
      });
    };
    return request;
  };

  try {
    const routes = require(routesPath);
    let probeHttpGetCallCount = 0;
    routes._test.configureReadinessForTest({
      fetchFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
      httpGet: (...args) => {
        probeHttpGetCallCount += 1;
        return unavailableNgrokHttpGet(...args);
      },
      requestFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
    });
    const harness = {
      botRequests,
      hostHttpGetCalls: () => hostHttpGetCallCount,
      probeHttpGetCalls: () => probeHttpGetCallCount,
      join: (overrides = {}) => requestMeetRoute(routes, "POST", "/join-meeting", {
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        wsUrl: "wss://meetmate.example/realtime?mode=frames",
        conversationMode: "one_to_one",
        ...overrides,
      }),
      leave: () => requestMeetRoute(routes, "POST", "/leave-meeting", {
        sessionId: "00000000-0000-4000-8000-000000000058",
      }),
    };
    await fn(harness);
  } finally {
    for (const session of [...require("../src/transport-meet/local-avatar-session")._test.sessions.values()]) {
      session.close("test_cleanup");
    }
    readiness.reset();
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    crypto.randomUUID = originalRandomUUID;
    crypto.randomBytes = originalRandomBytes;
    restoreEnv();
    settingsResolver.resetRuntimeForTest();
    for (const file of cachePaths) {
      delete require.cache[file];
      const previous = previousCache.get(file);
      if (previous) require.cache[file] = previous;
    }
  }
}

class FakeLifecycle extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.state = "created";
    this.isTerminal = false;
  }
  transition(state) {
    this.state = state;
    this.isTerminal = ["completed", "failed", "cancelled"].includes(state);
  }
  setConversationLog() {}
}

class FakeSlackNotifier {
  postStatus() { return Promise.resolve(); }
  startElapsedUpdates() {}
  stopElapsedUpdates() {}
  postSummary() { return Promise.resolve(); }
  postTranscript() { return Promise.resolve(); }
}

function installMock(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

async function requestMeetRoute(routes, method, url, formData) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.destroy = () => {};
  const result = { statusCode: null, headers: null, text: "" };
  const res = {
    writeHead(statusCode, headers) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(body = "") {
      result.text = String(body);
    },
  };
  const pending = routes.handleHttp(req, res);
  await Promise.resolve();
  req.emit("data", Buffer.from(stringify(formData)));
  req.emit("end");
  await pending;
  return result;
}

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function runFramesPage({
  frameFailures = new Set(),
  holdFrames = new Set(),
  gate = {},
  now = Date.now(),
  offset,
  random = () => 0.5,
  stateHandler = null,
} = {}) {
  let releaseHeldFrames;
  const heldGate = new Promise((resolve) => { releaseHeldFrames = resolve; });
  gate.release = releaseHeldFrames;
  const timers = [];
  const script = fs.readFileSync(SCRIPT_FILE, "utf8");
  const drawCalls = [];
  const frameRequests = [];
  const initial = {
    kind: "idle",
    generation: 1,
    cancelEpoch: 0,
    sequence: 1,
    outputEpoch: -1,
    sampleIndex: null,
    sampleRate: null,
  };
  const sandboxMath = Object.create(Math);
  sandboxMath.random = random;
  const clock = { value: now };
  const stateRequests = [];
  const sandbox = {
    URLSearchParams,
    Date: { now: () => clock.value },
    Math: sandboxMath,
    location: {
      pathname: "/local-avatar/frames.html",
      search: `?v=abcdefghijklmnop${offset === undefined ? "" : `&offset=${encodeURIComponent(offset)}`}`,
      hash: "#cap=secret",
    },
    history: { replaceState: (...args) => { sandbox.replaced = args; } },
    document: {
      getElementById: () => ({
        width: 1280,
        height: 720,
        getContext: () => ({
          fillRect: (...args) => drawCalls.push(["rect", ...args]),
          fillText: (...args) => drawCalls.push(["text", ...args]),
          drawImage: (...args) => drawCalls.push(["image", ...args]),
          set fillStyle(_value) {},
          set font(_value) {},
          set textAlign(_value) {},
        }),
      }),
    },
    fetch: async (url) => {
      if (url.startsWith("/local-avatar/state?")) {
        const params = Object.fromEntries(new URL(url, "https://meetmate.example").searchParams.entries());
        stateRequests.push(params);
        if (stateHandler) {
          return stateHandler({
            url,
            params,
            stateCallCount: stateRequests.length,
            clock,
            initial,
          });
        }
        return { ok: true, status: 200, json: async () => initial };
      }
      const name = /\/([^/?]+)\.png\?/.exec(url)?.[1] || "";
      frameRequests.push(name);
      if (holdFrames.has(name)) await heldGate;
      return {
        ok: !frameFailures.has(name),
        status: frameFailures.has(name) ? 404 : 200,
        blob: async () => ({ name }),
      };
    },
    createImageBitmap: async (blob) => ({ frame: blob.name, width: 640, height: 640 }),
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: SCRIPT_FILE });
  await settleMicrotasks();
  return { sandbox, drawCalls, timers, clock, frameRequests, stateRequests };
}

async function runFramesBackgroundPage(script, background, decodeBackground = async () => ({ width: 640, height: 480 })) {
  const draws = [];
  const errors = [];
  const timers = [];
  let fillStyle = null;
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
  const sandboxMath = Object.create(Math);
  sandboxMath.random = () => 0.5;
  const sandbox = {
    URLSearchParams,
    Blob,
    Math: sandboxMath,
    Date: { now: () => 0 },
    console: { error: (...args) => errors.push(args) },
    location: {
      pathname: "/local-avatar/frames.html",
      search: "?v=abcdefghijklmnop",
      hash: "#cap=secret",
    },
    history: { replaceState: () => {} },
    document: {
      getElementById: () => ({
        width: 1280,
        height: 720,
        getContext: () => ({
          fillRect: (...args) => draws.push(["fill", fillStyle, ...args]),
          fillText: (...args) => draws.push(["text", ...args]),
          drawImage: (...args) => draws.push(["image", ...args]),
          set fillStyle(value) { fillStyle = value; },
          set font(_value) {},
          set textAlign(_value) {},
        }),
      }),
    },
    fetch: async (url) => {
      if (url.startsWith("/local-avatar/state?")) return { ok: true, status: 200, json: async () => initial };
      const name = /\/([^/?]+)\.png\?/.exec(url)?.[1] || "";
      return { ok: true, status: 200, blob: async () => ({ name }) };
    },
    createImageBitmap: async (blob) => (blob && blob.name
      ? { frame: blob.name, width: 640, height: 640 }
      : decodeBackground(blob)),
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: SCRIPT_FILE });
  await settleMicrotasks();
  return { sandbox, draws, errors, timers };
}

async function settleMicrotasks() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function fireTimer(timers, ms) {
  const timer = timers.find((candidate) => candidate.ms === ms && !candidate.cleared && !candidate.fired);
  assert.ok(timer, `expected pending timer ${ms}`);
  timer.fired = true;
  timer.fn();
  await settleMicrotasks();
}

async function withFreshUiRoutes(home, fn) {
  const pathsModule = require.resolve("../src/paths");
  const uiModule = require.resolve("../src/ui-routes");
  const bootstrap = require("../src/settings/bootstrap");
  const previousHome = process.env.AI_MEET_HOME;
  process.env.AI_MEET_HOME = home;
  bootstrap.resetStartupForTest();
  delete require.cache[pathsModule];
  delete require.cache[uiModule];
  try {
    const uiRoutes = require(uiModule);
    await fn({
      serveLocalAvatar: uiRoutes.serveLocalAvatar,
      localAvatarCsp: uiRoutes._test.LOCAL_AVATAR_CSP,
    });
  } finally {
    delete require.cache[uiModule];
    delete require.cache[pathsModule];
    bootstrap.resetStartupForTest();
    if (previousHome === undefined) delete process.env.AI_MEET_HOME;
    else process.env.AI_MEET_HOME = previousHome;
  }
}

function requestRoute(serveLocalAvatar, method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url: requestPath, headers };
    const result = { statusCode: null, headers: null, body: Buffer.alloc(0) };
    const res = {
      writeHead(statusCode, responseHeaders) {
        result.statusCode = statusCode;
        result.headers = responseHeaders;
      },
      end(body = "") {
        result.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        resolve(result);
      },
    };
    try {
      const handled = serveLocalAvatar(req, res, new URL(requestPath, "http://localhost"));
      if (!handled) reject(new Error(`route was not handled: ${requestPath}`));
    } catch (error) {
      reject(error);
    }
  });
}

function authHeaders(capability) {
  return { authorization: `Bearer ${capability}`, origin: "https://meetmate.example" };
}

function tamperCapability(value) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function frameMarker({
  kind = "marker",
  generation = 1,
  cancelEpoch = 0,
  sequence = 2,
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

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function assertFrameHeaders(result, statusCode, localAvatarCsp) {
  assert.equal(result.statusCode, statusCode);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Content-Security-Policy"], localAvatarCsp);
  if (statusCode === 200) assert.equal(result.headers["Content-Type"], "image/png");
}
