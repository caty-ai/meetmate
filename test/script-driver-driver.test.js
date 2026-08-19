"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  installTerminationHandlers,
  loadInputs,
  maskTailWarningFor,
  parseArgs,
  reportCalibrationPlausibility,
  stats,
  usage,
  writeRunHeader,
} = require("./tools/meet-script-driver");
const { parseArgs: parseRendererArgs, render } = require("./tools/render-script-assets");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("calibration plausibility emits a warning and supports strict abort", () => {
  const events = [];
  const warnings = [];
  const statuses = [
    { name: "subject", status: { floorRms: 240 } },
    { name: "echo", status: { floorRms: 20 } },
  ];
  const result = reportCalibrationPlausibility(statuses, {
    maxFloorRms: 200,
    strict: false,
    emit: (type, fields) => events.push({ type, ...fields }),
    warn: (message) => warnings.push(message),
  });
  assert.equal(result.detectors[0].name, "subject");
  assert.equal(events[0].type, "calibration_contaminated");
  assert.match(warnings[0], /subject=240/);

  assert.throws(() => reportCalibrationPlausibility(statuses, {
    maxFloorRms: 200,
    strict: true,
    emit: () => {},
    warn: () => {},
  }), (error) => {
    assert.match(error.message, /calibration contaminated/);
    assert.equal(error.details.strict, true);
    return true;
  });
});

test("calibration flags parse with safe defaults and validation", () => {
  const defaults = parseArgs(["--self-test"]);
  assert.equal(defaults.calibrationMaxFloor, 200);
  assert.equal(defaults.strictCalibration, false);
  const configured = parseArgs(["--self-test", "--calibration-max-floor", "175", "--strict-calibration"]);
  assert.equal(configured.calibrationMaxFloor, 175);
  assert.equal(configured.strictCalibration, true);
  assert.throws(() => parseArgs(["--self-test", "--calibration-max-floor", "-1"]), /must be non-negative/);
});

test("loadInputs rejects barge-in assets longer than two seconds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-inputs-"));
  const assetsDir = path.join(root, "assets");
  fs.mkdirSync(assetsDir);
  const pcm = Buffer.alloc(24_000 * 2 * 2 + 2);
  fs.writeFileSync(path.join(assetsDir, "interjection.pcm"), pcm);
  const script = {
    blocks: [{ id: "B2", steps: [{ type: "bargeIn", position: "mid", assetId: "interrupt", timeoutMs: 1000 }] }],
  };
  const scriptFile = path.join(root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  fs.writeFileSync(path.join(assetsDir, "manifest.json"), JSON.stringify({
    sampleRate: 24_000,
    assets: { interrupt: { file: "interjection.pcm", bytes: pcm.length, sha256: sha256(pcm) } },
  }));
  assert.throws(() => loadInputs({ script: scriptFile, assetsDir }), /bargeIn asset interrupt exceeds 2\.0 seconds/);
});

test("loadInputs accepts a barge-in asset exactly two seconds long", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-inputs-boundary-"));
  const assetsDir = path.join(root, "assets");
  fs.mkdirSync(assetsDir);
  const pcm = Buffer.alloc(24_000 * 2 * 2);
  fs.writeFileSync(path.join(assetsDir, "interjection.pcm"), pcm);
  const scriptFile = path.join(root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify({
    blocks: [{ id: "B2", steps: [{ type: "bargeIn", position: "mid", assetId: "interrupt", timeoutMs: 1000 }] }],
  }));
  fs.writeFileSync(path.join(assetsDir, "manifest.json"), JSON.stringify({
    sampleRate: 24_000,
    assets: { interrupt: { file: "interjection.pcm", bytes: pcm.length, sha256: sha256(pcm) } },
  }));
  assert.equal(loadInputs({ script: scriptFile, assetsDir }).assets.get("interrupt").pcm.length, pcm.length);
});

test("mask-tail warning is raised only when echo p95 exceeds the configured tail", () => {
  assert.equal(maskTailWarningFor([100, 200, 300], 300), null);
  assert.deepEqual(maskTailWarningFor([350, 400, 450], 300), {
    play_start_to_echo_ms_p95: 400,
    mask_tail_ms: 300,
  });
});

test("stats handles 300k samples without argument-spread overflow", () => {
  const values = Array.from({ length: 300_000 }, (_, index) => 299_999 - index);
  assert.deepEqual(stats(values), {
    count: 300_000,
    min: 0,
    p50: 149_999,
    p95: 284_999,
    max: 299_999,
  });
});

test("run header is still written when stats computation fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-header-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const headerPath = path.join(root, "run-header.json");

  writeRunHeader(headerPath, { version: 2, completed: true }, {
    echoDelays: [10],
    gaps: [20],
  }, () => {
    throw new Error("synthetic stats failure");
  });

  const header = JSON.parse(fs.readFileSync(headerPath, "utf8"));
  assert.equal(header.version, 2);
  assert.equal(header.completed, true);
  assert.equal(header.stats_error, "synthetic stats failure");
});

test("SIGINT and SIGTERM use the same registered graceful handler", () => {
  const signalSource = new EventEmitter();
  const observed = [];
  const remove = installTerminationHandlers((signal) => observed.push(signal), signalSource);
  signalSource.emit("SIGINT");
  signalSource.emit("SIGTERM");
  assert.deepEqual(observed, ["SIGINT", "SIGTERM"]);
  remove();
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("usage documents edge, late-barge, and dual-clock conventions", () => {
  const text = usage();
  assert.match(text, /run-start/);
  assert.match(text, /late=onset\+lateAfterMs/);
  assert.match(text, /audio_monotonic_ms is stream-derived/);
  assert.match(text, /play_start_to_echo_ms/);
});

test("renderer reports an unknown option before attempting to consume a value", () => {
  assert.throws(() => parseRendererArgs(["--bogus"]), /unknown option: --bogus/);
});

test("renderer applies per-asset speed to synthesis and cache hash", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-asset-renderer-"));
  const scriptFile = path.join(root, "script.json");
  const out = path.join(root, "assets");
  const ttsModule = require.resolve("../src/tts-fish.js");
  const originalTts = require.cache[ttsModule];
  const originalApiKey = process.env.FISH_AUDIO_API_KEY;
  const syntheses = [];
  process.env.FISH_AUDIO_API_KEY = "test-api-key";
  require.cache[ttsModule] = {
    id: ttsModule,
    filename: ttsModule,
    loaded: true,
    exports: {
      async synthesize(text, options) {
        syntheses.push({ text, speed: options.speed });
        options.onAudio(Buffer.from([1, 2]));
      },
    },
  };
  t.after(() => {
    if (originalTts) require.cache[ttsModule] = originalTts;
    else delete require.cache[ttsModule];
    if (originalApiKey === undefined) delete process.env.FISH_AUDIO_API_KEY;
    else process.env.FISH_AUDIO_API_KEY = originalApiKey;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeScript = (speed) => fs.writeFileSync(scriptFile, JSON.stringify({
    assets: {
      interrupt: { text: "いまの途中だけど。", speed },
      ordinary: { text: "通常です。" },
    },
  }));
  const args = {
    script: scriptFile,
    out,
    wakeWord: "ミートメイト",
    referenceId: null,
    speed: 1,
  };

  writeScript(1.25);
  await render(args);
  const firstManifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(syntheses, [
    { text: "いまの途中だけど。", speed: 1.25 },
    { text: "通常です。", speed: 1 },
  ]);
  assert.equal(firstManifest.assets.interrupt.params.speed, 1.25);
  assert.equal(
    firstManifest.assets.interrupt.contentKey,
    sha256(JSON.stringify({
      text: "いまの途中だけど。",
      params: firstManifest.assets.interrupt.params,
    })),
  );
  assert.notEqual(
    firstManifest.assets.interrupt.contentKey,
    sha256(JSON.stringify({ text: "いまの途中だけど。", params: firstManifest.assets.ordinary.params })),
  );

  syntheses.length = 0;
  writeScript(3);
  await render(args);
  const secondManifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(syntheses, [{ text: "いまの途中だけど。", speed: 2 }]);
  assert.equal(secondManifest.assets.interrupt.params.speed, 2);
  assert.notEqual(secondManifest.assets.interrupt.contentKey, firstManifest.assets.interrupt.contentKey);
  assert.equal(secondManifest.assets.ordinary.contentKey, firstManifest.assets.ordinary.contentKey);
});
