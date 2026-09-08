"use strict";

const MAX_AUDIO_DURATION_MS = 15_000;
const STALL_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

function durationCapError(options, serviceName, details) {
  if (typeof options.onDurationCapExceeded !== "function") return null;
  try {
    return options.onDurationCapExceeded(details) || new Error(`${serviceName} TTS duration limit exceeded`);
  } catch (error) {
    return error;
  }
}

async function readPcmBody(response, options, controller, serviceName, missingBodyMessage = `${serviceName} returned no audio stream`) {
  if (!response.body) throw new Error(missingBodyMessage);
  const sampleRate = options.sampleRate || 24_000;
  const maxBytes = Math.floor((sampleRate * MAX_AUDIO_DURATION_MS) / 1000) * 2;
  const reader = response.body.getReader();
  let leftover = null;
  let totalBytes = 0;
  try {
    for (;;) {
      let stallTimer;
      const stalled = new Promise((_, reject) => {
        stallTimer = setTimeout(() => {
          const error = new Error(`${serviceName} TTS stream stalled`);
          controller.abort(error);
          reject(error);
        }, STALL_TIMEOUT_MS);
        stallTimer.unref?.();
      });
      let result;
      try {
        result = await Promise.race([reader.read(), stalled]);
      } finally {
        clearTimeout(stallTimer);
      }
      if (result.done) break;
      if (options.signal?.aborted) return;
      let chunk = Buffer.from(result.value);
      if (leftover) {
        chunk = Buffer.concat([leftover, chunk]);
        leftover = null;
      }
      if (chunk.length % 2 !== 0) {
        leftover = chunk.subarray(chunk.length - 1);
        chunk = chunk.subarray(0, chunk.length - 1);
      }
      if (totalBytes + chunk.length > maxBytes) {
        const capError = durationCapError(options, serviceName, {
          maxBytes,
          maxDurationMs: MAX_AUDIO_DURATION_MS,
          totalBytesReceived: totalBytes,
          chunkBytes: chunk.length,
        });
        if (capError) {
          controller.abort(capError);
          await reader.cancel();
          throw capError;
        }
        const remaining = Math.max(0, maxBytes - totalBytes) & ~1;
        if (remaining > 0) options.onAudio(chunk.subarray(0, remaining));
        await reader.cancel();
        return;
      }
      if (chunk.length > 0) {
        totalBytes += chunk.length;
        options.onAudio(chunk);
      }
    }
    if (leftover && totalBytes < maxBytes) {
      const padded = Buffer.alloc(2);
      leftover.copy(padded);
      options.onAudio(padded);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
}

async function withRequestTimeout(options, serviceName, request) {
  const controller = new AbortController();
  const timeoutError = new Error(`${serviceName} TTS request timeout`);
  const onAbort = () => controller.abort(options.signal?.reason || new Error("TTS request aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await request(controller);
  } catch (error) {
    if (controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function createPcmResampler(sourceRate, targetRate) {
  if (!Number.isInteger(sourceRate) || sourceRate <= 0 || !Number.isInteger(targetRate) || targetRate <= 0) {
    throw new TypeError("PCM sample rates must be positive integers");
  }
  if (sourceRate === targetRate) {
    return { push: (chunk) => chunk, flush: () => Buffer.alloc(0) };
  }

  const step = sourceRate / targetRate;
  let pos = 0;
  let retained = Buffer.alloc(0);
  let oddByte = Buffer.alloc(0);

  return {
    push(chunk) {
      const bytes = Buffer.concat([retained, oddByte, chunk]);
      const evenLength = bytes.length & ~1;
      oddByte = Buffer.from(bytes.subarray(evenLength));
      const samples = evenLength / 2;
      if (!samples) return Buffer.alloc(0);
      const output = Buffer.alloc(Math.max(0, Math.ceil((samples - 1 - pos) / step) + 1) * 2);
      let written = 0;
      while (Math.floor(pos) + 1 < samples) {
        const i = Math.floor(pos);
        const frac = pos - i;
        const left = bytes.readInt16LE(i * 2);
        const right = bytes.readInt16LE((i + 1) * 2);
        output.writeInt16LE(Math.round(left + (right - left) * frac), written);
        written += 2;
        pos += step;
      }
      // Retain one sample for interpolation; pos also preserves any downsampling skip.
      retained = Buffer.from(bytes.subarray(evenLength - 2, evenLength));
      pos -= samples - 1;
      return output.subarray(0, written);
    },
    flush() {
      const output = [];
      if (retained.length) {
        while (pos < 1) {
          output.push(retained.readInt16LE(0));
          pos += step;
        }
      }
      const bytes = Buffer.alloc(output.length * 2);
      output.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2));
      pos = 0;
      retained = Buffer.alloc(0);
      oddByte = Buffer.alloc(0);
      return bytes;
    },
  };
}

module.exports = { readPcmBody, withRequestTimeout, createPcmResampler };
