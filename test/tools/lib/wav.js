"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HEADER_BYTES = 44;

class WavWriter {
  constructor(filePath, { sampleRate = 16_000, channels = 1, bitsPerSample = 16 } = {}) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("sampleRate must be a positive integer");
    if (!Number.isInteger(channels) || channels <= 0) throw new Error("channels must be a positive integer");
    if (![8, 16, 24, 32].includes(bitsPerSample)) throw new Error("unsupported bitsPerSample");

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitsPerSample = bitsPerSample;
    this.dataBytes = 0;
    this.closed = false;
    this.fd = fs.openSync(filePath, "w+");
    fs.writeSync(this.fd, this._header(), 0, HEADER_BYTES, 0);
  }

  _header() {
    const blockAlign = this.channels * (this.bitsPerSample / 8);
    const header = Buffer.alloc(HEADER_BYTES);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + this.dataBytes, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(this.bitsPerSample, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(this.dataBytes, 40);
    return header;
  }

  _patchHeader() {
    const sizes = Buffer.alloc(4);
    sizes.writeUInt32LE(36 + this.dataBytes, 0);
    fs.writeSync(this.fd, sizes, 0, 4, 4);
    sizes.writeUInt32LE(this.dataBytes, 0);
    fs.writeSync(this.fd, sizes, 0, 4, 40);
  }

  append(pcmBuffer) {
    if (this.closed) throw new Error("cannot append to a closed WAV writer");
    const pcm = Buffer.from(pcmBuffer);
    if (pcm.length === 0) return;
    fs.writeSync(this.fd, pcm, 0, pcm.length, HEADER_BYTES + this.dataBytes);
    this.dataBytes += pcm.length;
    // Patch after every completed append so a crash leaves a playable prefix.
    this._patchHeader();
  }

  close() {
    if (this.closed) return;
    this._patchHeader();
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.closed = true;
    this.fd = null;
  }
}

module.exports = { WavWriter, HEADER_BYTES };
