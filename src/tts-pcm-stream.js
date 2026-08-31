"use strict";

const MAX_AUDIO_DURATION_MS = 15_000;
const STALL_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

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

module.exports = { readPcmBody, withRequestTimeout };
