"use strict";

const { stripCanonicalEmotionTags } = require("./messages");
const readiness = require("./settings/readiness");

const MAX_AUDIO_DURATION_MS = 15_000;
const STALL_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PCM_SAMPLE_RATES = new Set([16_000, 22_050, 24_000, 44_100]);

function requestText(text) {
  return stripCanonicalEmotionTags(text);
}

function outputFormat(sampleRate) {
  if (!PCM_SAMPLE_RATES.has(sampleRate)) {
    throw new Error(`ElevenLabs PCM does not support ${sampleRate} Hz`);
  }
  return `pcm_${sampleRate}`;
}

async function readPcmBody(response, options, controller) {
  if (!response.body) throw new Error("ElevenLabs returned no audio stream");
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
          const error = new Error("ElevenLabs TTS stream stalled");
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

async function synthesize(text, options = {}) {
  const apiKey = options.apiKey;
  const voiceId = options.voiceId;
  const modelId = options.modelId;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required for TTS");
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID is required for TTS");
  if (!modelId) throw new Error("ELEVENLABS_MODEL is required for TTS");
  if (!options.onAudio) throw new Error("onAudio callback is required");
  const input = requestText(text);
  if (!input) return;

  const sampleRate = options.sampleRate || 24_000;
  const body = JSON.stringify({
    text: input,
    model_id: modelId,
    output_format: outputFormat(sampleRate),
  });
  const controller = new AbortController();
  const timeoutError = new Error("ElevenLabs TTS request timeout");
  const onAbort = () => controller.abort(options.signal?.reason || new Error("TTS request aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchFn || globalThis.fetch)(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
        body,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      const error = new Error(`ElevenLabs API error (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }
    await readPcmBody(response, { ...options, sampleRate }, controller);
    if (!options.signal?.aborted) readiness.reportRuntimeSuccess("elevenlabs");
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 402) {
      readiness.reportRuntimeFailure("elevenlabs", readiness.classifyRuntimeFailure(error));
    }
    if (controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

module.exports = { synthesize, _test: { outputFormat } };
