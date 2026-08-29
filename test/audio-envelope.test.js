"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createEnvelopeAccumulator,
  DEFAULT_WINDOW_MS,
  DEFAULT_FLOOR_DB,
  DEFAULT_CEILING_DB,
  LEVEL_ONE_THRESHOLD,
  LEVEL_TWO_THRESHOLD,
} = require("../src/audio-envelope");
const { _test: pipelineTest } = require("../src/pipeline");

const SAMPLE_RATE = 24_000;
const WINDOW_SAMPLES = 2_400;

test("envelope constants pin the 10 Hz dBFS mapping and frame thresholds", () => {
  assert.equal(DEFAULT_WINDOW_MS, 100);
  assert.equal(DEFAULT_FLOOR_DB, -50);
  assert.equal(DEFAULT_CEILING_DB, -10);
  assert.equal(LEVEL_ONE_THRESHOLD, 0.375);
  assert.equal(LEVEL_TWO_THRESHOLD, 0.75);
});

test("window RMS maps silence, full-scale, -35 dBFS, and -20 dBFS with three-decimal rounding", () => {
  const accumulator = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  const pcm = Buffer.concat([
    constantWindow(0),
    sineWindow(32767),
    sineWindow(32768 * (10 ** (-35 / 20)) * Math.SQRT2),
    sineWindow(32768 * (10 ** (-20 / 20)) * Math.SQRT2),
  ]);

  assert.deepEqual(accumulator.push(pcm), [{ s: 0, v: [0, 1, 0.375, 0.75] }]);
});

test("comfort-noise dither stays below the floor and the amplitude sweep documents its margin", () => {
  const originalRandom = Math.random;
  let polarity = false;
  Math.random = () => {
    polarity = !polarity;
    return polarity ? 0 : 0.999999;
  };
  try {
    const accumulator = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
    const noise = pipelineTest.generateSilence(100, SAMPLE_RATE);
    assert.deepEqual(accumulator.push(noise), [{ s: 0, v: [0] }]);
  } finally {
    Math.random = originalRandom;
  }

  const belowFloor = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  assert.equal(belowFloor.push(constantWindow(100))[0].v[0], 0);
  const aboveFloor = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  assert.ok(aboveFloor.push(constantWindow(200))[0].v[0] > 0);
});

test("global windows remain aligned across uneven and live-shaped chunks", () => {
  const samples = Buffer.concat([
    constantSamples(6_000, 100),
    constantSamples(2_400, 200),
  ]);
  const uneven = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  const segments = [
    ...uneven.push(samples.subarray(0, 6_000 * 2)),
    ...uneven.push(samples.subarray(6_000 * 2)),
  ];
  assert.deepEqual(segments.map((segment) => ({ s: segment.s, length: segment.v.length })), [
    { s: 0, length: 2 },
    { s: 4_800, length: 1 },
  ]);

  const onePush = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  const expected = onePush.push(samples);
  const tiny = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  const actual = [];
  for (let offset = 0; offset < samples.length; offset += 2_048) {
    actual.push(...tiny.push(samples.subarray(offset, Math.min(samples.length, offset + 2_048))));
  }
  assert.deepEqual(flattenSegments(actual), flattenSegments(expected));
  assert.deepEqual(flattenSegments(actual).map((window) => window.s), [0, 2_400, 4_800]);
});

test("reset discards a partial window and restarts the epoch grid", () => {
  const accumulator = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  assert.deepEqual(accumulator.push(constantSamples(1_200, 100)), []);
  accumulator.reset();
  assert.deepEqual(accumulator.push(constantWindow(200)), [{ s: 0, v: [expectedConstantEnvelope(200)] }]);
});

test("empty buffers are inert and odd-length PCM is rejected", () => {
  const accumulator = createEnvelopeAccumulator({ sampleRate: SAMPLE_RATE });
  assert.deepEqual(accumulator.push(Buffer.alloc(0)), []);
  assert.throws(() => accumulator.push(Buffer.alloc(3)), /even/);
  assert.deepEqual(accumulator.push(constantWindow(100)), [{ s: 0, v: [0] }]);
});

function constantWindow(amplitude) {
  return constantSamples(WINDOW_SAMPLES, amplitude);
}

function constantSamples(count, amplitude) {
  const buffer = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) buffer.writeInt16LE(Math.round(amplitude), index * 2);
  return buffer;
}

function sineWindow(peakAmplitude) {
  const buffer = Buffer.alloc(WINDOW_SAMPLES * 2);
  for (let index = 0; index < WINDOW_SAMPLES; index += 1) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(peakAmplitude * Math.sin(2 * Math.PI * index / 100))));
    buffer.writeInt16LE(sample, index * 2);
  }
  return buffer;
}

function expectedConstantEnvelope(amplitude) {
  const db = 20 * Math.log10(amplitude / 32768);
  return Math.round(Math.max(0, Math.min(1, (db + 50) / 40)) * 1000) / 1000;
}

function flattenSegments(segments) {
  return segments.flatMap((segment) => segment.v.map((value, index) => ({
    s: segment.s + index * WINDOW_SAMPLES,
    value,
  })));
}
