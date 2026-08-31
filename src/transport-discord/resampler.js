"use strict";

function makeLowpass(taps, cutoffNorm) {
  const coefficients = new Float64Array(taps);
  const max = taps - 1;
  let sum = 0;
  for (let index = 0; index <= max; index += 1) {
    const centered = index - max / 2;
    const sinc = centered === 0
      ? 2 * cutoffNorm
      : Math.sin(2 * Math.PI * cutoffNorm * centered) / (Math.PI * centered);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / max);
    coefficients[index] = sinc * window;
    sum += coefficients[index];
  }
  for (let index = 0; index <= max; index += 1) {
    coefficients[index] /= sum;
  }
  return coefficients;
}

class FirDecimator {
  constructor(factor, taps, cutoffNorm) {
    this.factor = factor;
    this.h = makeLowpass(taps, cutoffNorm);
    this.buf = new Float64Array(0);
    this.idx = taps - 1;
  }

  process(samples) {
    const taps = this.h.length;
    const buffer = new Float64Array(this.buf.length + samples.length);
    buffer.set(this.buf);
    buffer.set(samples, this.buf.length);

    const output = [];
    let index = this.idx;
    while (index < buffer.length) {
      let acc = 0;
      const start = index - taps + 1;
      for (let tap = 0; tap < taps; tap += 1) {
        acc += this.h[tap] * buffer[start + tap];
      }
      output.push(acc);
      index += this.factor;
    }

    const keepFrom = index - taps + 1;
    this.buf = new Float64Array(buffer.subarray(keepFrom));
    this.idx = index - keepFrom;
    return Float64Array.from(output);
  }
}

class FirInterpolator2 {
  constructor(taps, cutoffNorm) {
    this.decimator = new FirDecimator(1, taps, cutoffNorm);
    this.gain = 2;
  }

  process(samples) {
    const stuffed = new Float64Array(samples.length * 2);
    for (let index = 0; index < samples.length; index += 1) {
      stuffed[index * 2] = samples[index];
    }
    const output = this.decimator.process(stuffed);
    for (let index = 0; index < output.length; index += 1) {
      output[index] *= this.gain;
    }
    return output;
  }
}

function clamp16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

module.exports = {
  FirDecimator,
  FirInterpolator2,
  clamp16,
  makeLowpass,
};
