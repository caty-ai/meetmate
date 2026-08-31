"use strict";

const { stripCanonicalEmotionTags } = require("./messages");
const readiness = require("./settings/readiness");
const { readPcmBody, withRequestTimeout } = require("./tts-pcm-stream");

const PCM_SAMPLE_RATES = new Set([8_000, 16_000, 22_050, 24_000, 44_100]);

function requestText(text) {
  return stripCanonicalEmotionTags(text);
}

function outputFormat(sampleRate) {
  if (!PCM_SAMPLE_RATES.has(sampleRate)) {
    throw new Error(`ElevenLabs PCM does not support ${sampleRate} Hz`);
  }
  return `pcm_${sampleRate}`;
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
  });
  try {
    await withRequestTimeout(options, "ElevenLabs", async (controller) => {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat(sampleRate)}`;
      const response = await (options.fetchFn || globalThis.fetch)(url, {
        method: "POST",
        headers: { Accept: "audio/*", "Content-Type": "application/json", "xi-api-key": apiKey },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* best effort */ }
        const error = new Error(`ElevenLabs API error (${response.status})`);
        error.statusCode = response.status;
        throw error;
      }
      await readPcmBody(response, { ...options, sampleRate }, controller, "ElevenLabs");
    });
    if (!options.signal?.aborted) readiness.reportRuntimeSuccess("elevenlabs");
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 402) {
      readiness.reportRuntimeFailure("elevenlabs", readiness.classifyRuntimeFailure(error));
    }
    throw error;
  }
}

module.exports = { synthesize, _test: { outputFormat } };
