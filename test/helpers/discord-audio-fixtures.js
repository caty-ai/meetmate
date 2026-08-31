"use strict";

function clamp16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

function stereoTone48k(frequency, seconds, amplitude = 8000) {
  const sampleCount = Math.round(48000 * seconds);
  const buffer = Buffer.alloc(sampleCount * 4);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * index) / 48000));
    buffer.writeInt16LE(sample, index * 4);
    buffer.writeInt16LE(sample, index * 4 + 2);
  }
  return buffer;
}

function monoTone(rate, frequency, seconds, amplitude = 8000) {
  const sampleCount = Math.round(rate * seconds);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * index) / rate));
    buffer.writeInt16LE(sample, index * 2);
  }
  return buffer;
}

function toMono16kBuffer(stereo48k) {
  const sampleCount = Math.floor(stereo48k.length / 12);
  const output = Buffer.alloc(sampleCount * 2);
  let writeOffset = 0;
  for (let offset = 0; offset + 12 <= stereo48k.length; offset += 12) {
    const left0 = stereo48k.readInt16LE(offset);
    const right0 = stereo48k.readInt16LE(offset + 2);
    const left1 = stereo48k.readInt16LE(offset + 4);
    const right1 = stereo48k.readInt16LE(offset + 6);
    const left2 = stereo48k.readInt16LE(offset + 8);
    const right2 = stereo48k.readInt16LE(offset + 10);
    const average = Math.round(((left0 + right0) + (left1 + right1) + (left2 + right2)) / 6);
    output.writeInt16LE(clamp16(average), writeOffset);
    writeOffset += 2;
  }
  return output;
}

function naiveDecimate(stereo48k, factor) {
  const mono = Buffer.alloc(Math.floor(stereo48k.length / 4) * 2);
  for (let index = 0; index < mono.length / 2; index += 1) {
    const offset = index * 4;
    const sample = Math.round((stereo48k.readInt16LE(offset) + stereo48k.readInt16LE(offset + 2)) / 2);
    mono.writeInt16LE(clamp16(sample), index * 2);
  }

  const samples = [];
  for (let offset = 0; offset + 2 <= mono.length; offset += factor * 2) {
    samples.push(mono.readInt16LE(offset));
  }

  const output = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    output.writeInt16LE(samples[index], index * 2);
  }
  return output;
}

function goertzelDb(buffer, rate, frequency) {
  const sampleCount = Math.floor(buffer.length / 2);
  const k = Math.round((sampleCount * frequency) / rate);
  const omega = (2 * Math.PI * k) / sampleCount;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    s0 = buffer.readInt16LE(index * 2) + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
  return 10 * Math.log10(power / (sampleCount * sampleCount) + 1e-12);
}

function splitBufferRandomly(buffer, seed = 1) {
  let state = seed >>> 0;
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const size = Math.min(buffer.length - offset, 1 + (state % 4999));
    parts.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return parts;
}

module.exports = {
  goertzelDb,
  monoTone,
  naiveDecimate,
  splitBufferRandomly,
  stereoTone48k,
  toMono16kBuffer,
};
