"use strict";

const DEFAULT_WINDOW_MS = 100;
const DEFAULT_FLOOR_DB = -50;
const DEFAULT_CEILING_DB = -10;
const DBFS_REFERENCE = 32768;
const LEVEL_ONE_THRESHOLD = 0.375;
const LEVEL_TWO_THRESHOLD = 0.75;

function createEnvelopeAccumulator({
  sampleRate,
  windowMs = DEFAULT_WINDOW_MS,
  floorDb = DEFAULT_FLOOR_DB,
  ceilingDb = DEFAULT_CEILING_DB,
} = {}) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new TypeError("sampleRate must be a positive safe integer");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError("windowMs must be a positive finite number");
  }
  if (!Number.isFinite(floorDb) || !Number.isFinite(ceilingDb) || ceilingDb <= floorDb) {
    throw new TypeError("ceilingDb must be greater than floorDb");
  }

  const windowSamples = Math.round(sampleRate * windowMs / 1000);
  if (!Number.isSafeInteger(windowSamples) || windowSamples <= 0) {
    throw new RangeError("window size must contain at least one sample");
  }

  const windowBytes = windowSamples * 2;
  let remainder = Buffer.alloc(0);
  let nextWindowStart = 0;

  function push(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError("buffer must be a Buffer");
    if (buffer.length % 2 !== 0) throw new RangeError("PCM buffer length must be even");
    if (buffer.length === 0) return [];

    const pcm = remainder.length === 0 ? buffer : Buffer.concat([remainder, buffer]);
    const completeWindows = Math.floor(pcm.length / windowBytes);
    if (completeWindows === 0) {
      remainder = Buffer.from(pcm);
      return [];
    }

    const values = new Array(completeWindows);
    for (let window = 0; window < completeWindows; window += 1) {
      let sumSquares = 0;
      const byteStart = window * windowBytes;
      for (let offset = byteStart; offset < byteStart + windowBytes; offset += 2) {
        const sample = pcm.readInt16LE(offset);
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / windowSamples);
      const db = rms === 0 ? -Infinity : 20 * Math.log10(rms / DBFS_REFERENCE);
      const normalized = Number.isFinite(db)
        ? Math.max(0, Math.min(1, (db - floorDb) / (ceilingDb - floorDb)))
        : 0;
      values[window] = Math.round(normalized * 1000) / 1000;
    }

    const segment = { s: nextWindowStart, v: values };
    nextWindowStart += completeWindows * windowSamples;
    const consumedBytes = completeWindows * windowBytes;
    remainder = consumedBytes === pcm.length ? Buffer.alloc(0) : Buffer.from(pcm.subarray(consumedBytes));
    return [segment];
  }

  function reset() {
    remainder = Buffer.alloc(0);
    nextWindowStart = 0;
  }

  return Object.freeze({
    push,
    reset,
    sampleRate,
    windowSamples,
  });
}

module.exports = {
  createEnvelopeAccumulator,
  DEFAULT_WINDOW_MS,
  DEFAULT_FLOOR_DB,
  DEFAULT_CEILING_DB,
  DBFS_REFERENCE,
  LEVEL_ONE_THRESHOLD,
  LEVEL_TWO_THRESHOLD,
};
