"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WavWriter } = require("./tools/lib/wav");

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-wav-")), name);
}

function assertHeader(file, dataBytes) {
  const wav = fs.readFileSync(file);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + dataBytes);
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(28), 32_000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt32LE(40), dataBytes);
  assert.equal(wav.length, 44 + dataBytes);
}

test("WavWriter produces correct PCM header and sizes", () => {
  const file = tempFile("known.wav");
  const writer = new WavWriter(file);
  writer.append(Buffer.from([1, 2, 3, 4]));
  writer.append(Buffer.from([5, 6]));
  writer.close();
  assertHeader(file, 6);
  assert.deepEqual(fs.readFileSync(file).subarray(44), Buffer.from([1, 2, 3, 4, 5, 6]));
});

test("close on an abort path leaves a valid WAV and is idempotent", () => {
  const file = tempFile("abort.wav");
  const writer = new WavWriter(file);
  try {
    writer.append(Buffer.alloc(640, 7));
    throw new Error("synthetic abort");
  } catch {
    writer.close();
  }
  writer.close();
  assertHeader(file, 640);
});
