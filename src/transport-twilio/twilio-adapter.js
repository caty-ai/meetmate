// twilio-adapter.js — Twilio Media Streams audio adapter
// Converts between Twilio μ-law/8kHz and pipeline PCM16/16kHz

const BIAS = 0x84;
const CLIP = 32635;

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  MULAW_DECODE_TABLE[i] = decodeMulawSample(i);
}

function decodeMulawSample(byte) {
  // ITU-T G.711 μ-law decode
  const u = (~byte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

function encodeMulawSample(sample) {
  // ITU-T G.711 μ-law encode
  let pcm = sample;
  let sign = 0;

  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }

  if (pcm > CLIP) {
    pcm = CLIP;
  }

  pcm += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; exponent > 0 && (pcm & expMask) === 0; expMask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/**
 * μ-law/8kHz -> PCM16/16kHz
 * Step1: μ-law decode
 * Step2: linear interpolation upsample x2
 */
function mulawToLinear16(mulawBuffer) {
  if (!Buffer.isBuffer(mulawBuffer) || mulawBuffer.length === 0) {
    return Buffer.alloc(0);
  }

  const sampleCount8k = mulawBuffer.length;
  const out = Buffer.alloc(sampleCount8k * 4); // upsample x2, int16 => 2 bytes
  let offset = 0;

  for (let i = 0; i < sampleCount8k; i += 1) {
    const s0 = MULAW_DECODE_TABLE[mulawBuffer[i]];
    const s1 = i + 1 < sampleCount8k ? MULAW_DECODE_TABLE[mulawBuffer[i + 1]] : s0;
    const mid = (s0 + s1) >> 1;

    out.writeInt16LE(s0, offset);
    out.writeInt16LE(mid, offset + 2);
    offset += 4;
  }

  return out;
}

/**
 * PCM16/16kHz -> μ-law/8kHz
 * Step1: downsample x0.5 (pair average)
 * Step2: μ-law encode
 */
function linear16ToMulaw(pcmBuffer) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < 4) {
    return Buffer.alloc(0);
  }

  const sampleCount16k = Math.floor(pcmBuffer.length / 2);
  const sampleCount8k = Math.floor(sampleCount16k / 2);
  const out = Buffer.alloc(sampleCount8k);

  for (let i = 0; i < sampleCount8k; i += 1) {
    const srcOffset = i * 4;
    const s0 = pcmBuffer.readInt16LE(srcOffset);
    const s1 = pcmBuffer.readInt16LE(srcOffset + 2);
    const avg = (s0 + s1) >> 1;
    out[i] = encodeMulawSample(avg);
  }

  return out;
}

/**
 * Simple jitter buffer for inbound PCM16/16kHz chunks.
 * Keeps max N ms; if overrun, drops oldest frames.
 */
function createJitterBuffer(maxMs = 200, sampleRate = 16000, bytesPerSample = 2) {
  const maxBytes = Math.max(1, Math.floor((sampleRate * bytesPerSample * maxMs) / 1000));
  const chunks = [];
  let totalBytes = 0;

  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
      chunks.push(chunk);
      totalBytes += chunk.length;

      while (totalBytes > maxBytes && chunks.length > 0) {
        const dropped = chunks.shift();
        totalBytes -= dropped.length;
      }
    },

    flush() {
      if (chunks.length === 0) return Buffer.alloc(0);
      const out = Buffer.concat(chunks, totalBytes);
      chunks.length = 0;
      totalBytes = 0;
      return out;
    },

    size() {
      return totalBytes;
    },

    maxBytes,
  };
}

module.exports = {
  mulawToLinear16,
  linear16ToMulaw,
  createJitterBuffer,
};
