"use strict";

const { stripCanonicalEmotionTags } = require("./messages");
const readiness = require("./settings/readiness");

const DEFAULT_BASE_URL = "https://api.openai.com";
const MAX_AUDIO_DURATION_MS = 15_000;
const STALL_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

function requestText(text) {
  return stripCanonicalEmotionTags(text);
}

function isOpenAiHosted(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com"; } catch { return false; }
}

function speechUrl(baseUrl) {
  return `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/audio/speech`;
}

async function readPcmBody(response, options, controller) {
  if (!response.body) throw new Error("OpenAI-compatible TTS returned no audio stream");
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
          const error = new Error("OpenAI-compatible TTS stream stalled");
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
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const apiKey = options.apiKey;
  const model = options.model;
  const voice = options.voice;
  if (isOpenAiHosted(baseUrl) && !apiKey) {
    throw new Error("OPENAI_COMPATIBLE_TTS_API_KEY is required for api.openai.com");
  }
  if (!model) throw new Error("OPENAI_COMPATIBLE_TTS_MODEL is required for TTS");
  if (!voice) throw new Error("OPENAI_COMPATIBLE_TTS_VOICE is required for TTS");
  if (!options.onAudio) throw new Error("onAudio callback is required");
  const sampleRate = options.sampleRate || 24_000;
  if (sampleRate !== 24_000) throw new Error("OpenAI-compatible PCM output requires a 24000 Hz TTS sample rate");
  const input = requestText(text);
  if (!input) return;

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = JSON.stringify({ model, input, voice, response_format: "pcm" });
  const controller = new AbortController();
  const timeoutError = new Error("OpenAI-compatible TTS request timeout");
  const onAbort = () => controller.abort(options.signal?.reason || new Error("TTS request aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchFn || globalThis.fetch)(speechUrl(baseUrl), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      const error = new Error(`OpenAI-compatible TTS API error (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }
    await readPcmBody(response, { ...options, sampleRate }, controller);
    if (!options.signal?.aborted) readiness.reportRuntimeSuccess("openai-compatible");
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 402) {
      readiness.reportRuntimeFailure("openai-compatible", readiness.classifyRuntimeFailure(error));
    }
    if (controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

module.exports = { synthesize, _test: { isOpenAiHosted, speechUrl } };
