"use strict";

const { stripCanonicalEmotionTags } = require("./messages");
const readiness = require("./settings/readiness");
const { readPcmBody, withRequestTimeout } = require("./tts-pcm-stream");
const { isOpenAiHostedBaseUrl } = require("./url-utils");

const DEFAULT_BASE_URL = "https://api.openai.com";

function requestText(text) {
  return stripCanonicalEmotionTags(text);
}

function isOpenAiHosted(baseUrl) {
  return isOpenAiHostedBaseUrl(baseUrl);
}

function speechUrl(baseUrl) {
  return `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/audio/speech`;
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
  try {
    await withRequestTimeout(options, "OpenAI-compatible", async (controller) => {
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
      await readPcmBody(
        response,
        { ...options, sampleRate },
        controller,
        "OpenAI-compatible",
        "OpenAI-compatible TTS returned no audio stream",
      );
    });
    if (!options.signal?.aborted) readiness.reportRuntimeSuccess("openai-compatible");
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 402) {
      readiness.reportRuntimeFailure("openai-compatible", readiness.classifyRuntimeFailure(error));
    }
    throw error;
  }
}

module.exports = { synthesize, _test: { isOpenAiHosted, speechUrl } };
