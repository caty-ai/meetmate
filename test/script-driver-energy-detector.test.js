"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createDetector } = require("./tools/lib/energy-detector");

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000;

function constantFrames(count, value) {
  const pcm = Buffer.alloc(count * FRAME_SAMPLES * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return pcm;
}

function sineFrames(count, amplitude = 4000, frequency = 1000) {
  const pcm = Buffer.alloc(count * FRAME_SAMPLES * 2);
  for (let i = 0; i < pcm.length / 2; i += 1) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE)), i * 2);
  }
  return pcm;
}

function detector(overrides = {}) {
  return createDetector({
    sampleRate: SAMPLE_RATE,
    frameMs: FRAME_MS,
    calibrationMs: 80,
    onsetFrames: 3,
    offsetFrames: 2,
    thresholdFactor: 6,
    minThreshold: 100,
    hysteresisFactor: 2,
    maskTailMs: 0,
    ...overrides,
  });
}

test("detects sustained sine onset and offset at stream-derived frame times", () => {
  const pcm = Buffer.concat([constantFrames(4, 20), sineFrames(4), constantFrames(3, 0)]);
  const events = detector().feed(pcm, 1000);
  assert.deepEqual(events.map(({ type, tMs }) => ({ type, tMs })), [
    { type: "onset", tMs: 1080 },
    { type: "offset", tMs: 1160 },
  ]);
});

test("onset timestamp is the first loud frame rather than the sustain-completion frame", () => {
  const instance = detector();
  instance.feed(constantFrames(4, 20), 400);
  const events = instance.feed(sineFrames(3), 480);
  assert.deepEqual(events[0], { type: "onset", tMs: 480, rms: events[0].rms });
  assert.equal(instance.getStatus().edgeConvention, "run-start");
});

test("a half-open playback mask excludes a burst from speech logic", () => {
  const instance = detector();
  instance.mask(80, 160);
  const pcm = Buffer.concat([constantFrames(4, 20), sineFrames(4), constantFrames(3, 0)]);
  assert.deepEqual(instance.feed(pcm, 0), []);
});

test("calibration keeps threshold above comfort-noise dither", () => {
  const instance = detector({ calibrationMs: 200, minThreshold: 1 });
  instance.feed(constantFrames(10, 30), 0);
  const status = instance.getStatus();
  assert.equal(status.calibrated, true);
  assert.equal(status.floorRms, 30);
  assert.equal(status.onsetThreshold, 180);
  assert.ok(status.offsetThreshold > 30);
});

test("event timestamps are invariant to arbitrary even-byte chunk splits", () => {
  const pcm = Buffer.concat([constantFrames(4, 20), sineFrames(5), constantFrames(4, 0)]);
  const whole = detector().feed(pcm, 5000).map(({ type, tMs }) => ({ type, tMs }));
  const splitDetector = detector();
  const splitSizes = [14, 802, 66, 1240, 318, 2000, pcm.length];
  const split = [];
  let offset = 0;
  for (const size of splitSizes) {
    if (offset >= pcm.length) break;
    const end = Math.min(pcm.length, offset + (size & ~1));
    split.push(...splitDetector.feed(pcm.subarray(offset, end), 5000 + offset / 32));
    offset = end;
  }
  if (offset < pcm.length) split.push(...splitDetector.feed(pcm.subarray(offset), 9999));
  assert.deepEqual(split.map(({ type, tMs }) => ({ type, tMs })), whole);
});

test("offset after masked uncertainty is emitted at the mask entry as censored", () => {
  const instance = detector();
  instance.mask(160, 200);
  const pcm = Buffer.concat([constantFrames(4, 20), sineFrames(4), constantFrames(5, 0)]);
  const events = instance.feed(pcm, 0);
  assert.equal(events[0].type, "onset");
  assert.deepEqual(events[1], { type: "offset", tMs: 160, rms: 0, censored: true });
});

test("floor re-sampling records drift without changing active thresholds", () => {
  const instance = detector();
  instance.feed(constantFrames(4, 20), 0);
  const before = instance.getStatus().onsetThreshold;
  instance.beginFloorResample("B4");
  instance.feed(constantFrames(5, 45), 80);
  const sample = instance.endFloorResample();
  assert.deepEqual(sample, { label: "B4", frames: 5, floorRms: 45 });
  assert.equal(instance.getStatus().onsetThreshold, before);
});

test("restricted echo pass only detects bursts inside included windows", () => {
  const instance = detector();
  instance.feed(constantFrames(4, 20), 0);
  instance.restrictToWindows(true);
  instance.include(200, 320);
  const outside = instance.feed(Buffer.concat([sineFrames(4), constantFrames(2, 0)]), 80);
  const inside = instance.feed(Buffer.concat([sineFrames(4), constantFrames(3, 0)]), 200);
  assert.deepEqual(outside, []);
  assert.deepEqual(inside.map((event) => event.type), ["onset", "offset"]);
});

test("echo restriction engages inside the feed call that completes calibration", () => {
  const instance = detector({ restrictAfterCalibration: true });
  const sameBatch = Buffer.concat([constantFrames(4, 20), sineFrames(4), constantFrames(3, 0)]);
  assert.deepEqual(instance.feed(sameBatch, 0), []);
  assert.equal(instance.getStatus().restrictedToWindows, true);
});
