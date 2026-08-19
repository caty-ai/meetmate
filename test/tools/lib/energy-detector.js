"use strict";

function rms16le(buffer) {
  if (buffer.length === 0) return 0;
  let sum = 0;
  const samples = buffer.length / 2;
  for (let i = 0; i < buffer.length; i += 2) {
    const value = buffer.readInt16LE(i);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function createDetector(options = {}) {
  const sampleRate = options.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("sampleRate is required");

  const frameMs = options.frameMs ?? 20;
  const frameSamples = Math.round(sampleRate * frameMs / 1000);
  const frameBytes = frameSamples * 2;
  const onsetFrames = options.onsetFrames ?? 3;
  const offsetFrames = options.offsetFrames ?? 10;
  const calibrationMs = options.calibrationMs ?? 3000;
  const calibrationFrames = Math.max(1, Math.ceil(calibrationMs / frameMs));
  const thresholdFactor = options.thresholdFactor ?? 6;
  const minThreshold = options.minThreshold ?? 300;
  const maskTailMs = options.maskTailMs ?? 300;
  const hysteresisFactor = options.hysteresisFactor ?? 2;
  const restrictAfterCalibration = Boolean(options.restrictAfterCalibration);

  let pending = Buffer.alloc(0);
  let streamStartMs = null;
  let frameStartSample = 0;
  let calibrated = false;
  let floorRms = null;
  let onsetThreshold = null;
  let offsetThreshold = null;
  let loudFrames = 0;
  let quietFrames = 0;
  let loudRunStartMs = null;
  let quietRunStartMs = null;
  let speaking = false;
  let maskedWhileSpeakingAt = null;
  let restrictToWindows = Boolean(options.restrictedToWindows);
  const masks = [];
  const windows = [];
  const calibrationValues = [];
  let resample = null;

  function inIntervals(tMs, intervals) {
    return intervals.some(({ startMs, endMs }) => tMs >= startMs && tMs < endMs);
  }

  function eligible(tMs) {
    if (inIntervals(tMs, masks)) return false;
    if (restrictToWindows && !inIntervals(tMs, windows)) return false;
    return true;
  }

  function finishCalibration() {
    // The 75th percentile rejects occasional zero frames without letting a
    // brief calibration click dominate the fixed run threshold.
    floorRms = percentile(calibrationValues, 0.75);
    onsetThreshold = Math.max(floorRms * thresholdFactor, minThreshold);
    offsetThreshold = onsetThreshold / hysteresisFactor;
    calibrated = true;
    if (restrictAfterCalibration) restrictToWindows = true;
  }

  function feed(pcmBuffer, tMs) {
    const input = Buffer.from(pcmBuffer);
    if (input.length % 2 !== 0) throw new Error("PCM buffer must contain whole 16-bit samples");
    if (streamStartMs == null) streamStartMs = Number(tMs);
    pending = pending.length ? Buffer.concat([pending, input]) : input;
    const events = [];

    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      const frameTMs = streamStartMs + frameStartSample * 1000 / sampleRate;
      frameStartSample += frameSamples;
      const rms = rms16le(frame);
      const isEligible = eligible(frameTMs);

      if (resample && isEligible) resample.values.push(rms);

      if (!calibrated) {
        if (isEligible) calibrationValues.push(rms);
        if (calibrationValues.length >= calibrationFrames) finishCalibration();
        continue;
      }

      if (!isEligible) {
        if (speaking && inIntervals(frameTMs, masks) && maskedWhileSpeakingAt == null) {
          maskedWhileSpeakingAt = frameTMs;
        }
        continue;
      }

      if (!speaking) {
        if (rms >= onsetThreshold) {
          if (loudFrames === 0) loudRunStartMs = frameTMs;
          loudFrames += 1;
        } else {
          loudFrames = 0;
          loudRunStartMs = null;
        }
        if (loudFrames >= onsetFrames) {
          speaking = true;
          quietFrames = 0;
          loudFrames = 0;
          events.push({ type: "onset", tMs: loudRunStartMs, rms });
          loudRunStartMs = null;
        }
        continue;
      }

      if (rms >= offsetThreshold) maskedWhileSpeakingAt = null;
      if (rms < offsetThreshold) {
        if (quietFrames === 0) quietRunStartMs = frameTMs;
        quietFrames += 1;
      } else {
        quietFrames = 0;
        quietRunStartMs = null;
      }
      if (quietFrames >= offsetFrames) {
        const event = { type: "offset", tMs: quietRunStartMs, rms };
        if (maskedWhileSpeakingAt != null) {
          event.tMs = maskedWhileSpeakingAt;
          event.censored = true;
        }
        events.push(event);
        speaking = false;
        quietFrames = 0;
        quietRunStartMs = null;
        maskedWhileSpeakingAt = null;
      }
    }

    return events;
  }

  function mask(startMs, endMs) {
    if (!(endMs >= startMs)) throw new Error("mask end must not precede start");
    masks.push({ startMs: Number(startMs), endMs: Number(endMs) + maskTailMs });
  }

  function include(startMs, endMs) {
    if (!(endMs >= startMs)) throw new Error("window end must not precede start");
    windows.push({ startMs: Number(startMs), endMs: Number(endMs) });
  }

  function beginFloorResample(label = null) {
    if (resample) throw new Error("floor re-sample already active");
    resample = { label, values: [] };
  }

  function endFloorResample() {
    if (!resample) return null;
    const result = {
      label: resample.label,
      frames: resample.values.length,
      floorRms: percentile(resample.values, 0.75),
    };
    resample = null;
    return result;
  }

  function getStatus() {
    return {
      calibrated,
      floorRms,
      onsetThreshold,
      offsetThreshold,
      frameMs,
      onsetFrames,
      offsetFrames,
      calibrationMs,
      thresholdFactor,
      minThreshold,
      hysteresisFactor,
      maskTailMs,
      speaking,
      edgeConvention: "run-start",
      restrictedToWindows: restrictToWindows,
    };
  }

  return {
    feed,
    mask,
    include,
    beginFloorResample,
    endFloorResample,
    getStatus,
    restrictToWindows(value = true) { restrictToWindows = Boolean(value); },
  };
}

module.exports = { createDetector, rms16le };
