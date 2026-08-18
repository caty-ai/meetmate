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
  usage,
} = require("./tools/meet-script-driver");
const { parseArgs: parseRendererArgs } = require("./tools/render-script-assets");

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
