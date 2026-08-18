"use strict";

const OUTPUT_CHUNK_MS = 100;
const DEFAULT_LEAD_MS = 150;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(signal.reason == null ? "aborted" : String(signal.reason));
}

async function waitWithAbort(wait, ms, signal) {
  if (!signal) {
    await wait(ms);
    return;
  }
  throwIfAborted(signal);
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => wait(ms)), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function sendPacedPcm({ pcm, sampleRate = 24_000, send, leadMs = DEFAULT_LEAD_MS, nowNs, sleep, signal }) {
  const clock = nowNs || (() => process.hrtime.bigint());
  const wait = sleep || delay;
  const data = Buffer.from(pcm);
  const chunkBytes = Math.max(2, Math.floor(sampleRate * 2 * OUTPUT_CHUNK_MS / 1000)) & ~1;
  const startedNs = clock();
  let sentBytes = 0;
  let sendCount = 0;
  let maxAheadMs = 0;

  while (sentBytes < data.length) {
    throwIfAborted(signal);
    const end = Math.min(data.length, sentBytes + chunkBytes);
    const afterDurationMs = end * 1000 / (sampleRate * 2);
    while (true) {
      throwIfAborted(signal);
      const elapsedMs = Number(clock() - startedNs) / 1e6;
      const waitMs = afterDurationMs - leadMs - elapsedMs;
      if (waitMs <= 0) break;
      await waitWithAbort(wait, waitMs, signal);
    }
    throwIfAborted(signal);
    await send(data.subarray(sentBytes, end));
    sentBytes = end;
    sendCount += 1;
    const elapsedMs = Number(clock() - startedNs) / 1e6;
    maxAheadMs = Math.max(maxAheadMs, sentBytes * 1000 / (sampleRate * 2) - elapsedMs);
  }

  throwIfAborted(signal);
  const durationMs = data.length * 1000 / (sampleRate * 2);
  const elapsedMs = Number(clock() - startedNs) / 1e6;
  if (elapsedMs < durationMs) await waitWithAbort(wait, durationMs - elapsedMs, signal);
  throwIfAborted(signal);
  return { sendCount, durationMs, maxAheadMs };
}

module.exports = { DEFAULT_LEAD_MS, OUTPUT_CHUNK_MS, sendPacedPcm };
