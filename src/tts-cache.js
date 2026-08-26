// tts-cache.js — pre-generated PCM cache for fixed TTS phrases
//
// Cache hits are replayed at realtime pace. The meeting echo gate relies on
// speakSentence resolving when audio has actually been emitted over time; an
// instant cache dump would reopen STT while the attendee is still playing TTS.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ttsCacheDir } = require("./paths");
const { getEffectiveValue } = require("./settings/resolver");

const DEFAULT_SAMPLE_RATE = 24_000;
const CHUNK_MS = 100;

function defaultCacheDir() {
  return ttsCacheDir();
}

function normalizeSpeed(speed) {
  const n = Number(speed);
  return Number.isFinite(n) ? n : null;
}

function cacheKey(text, options = {}) {
  // latency is intentionally excluded: Fish treats it as a streaming/delivery
  // hint, not audio content. If that changes, add latency to this key.
  const payload = {
    text: String(text || ""),
    referenceId: options.referenceId || null,
    model: options.model || getEffectiveValue("fish_audio_model"),
    sampleRate: options.sampleRate || DEFAULT_SAMPLE_RATE,
    speed: normalizeSpeed(options.speed),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isCacheEnabled() {
  return getEffectiveValue("tts_cache_enabled");
}

function isValidPcmFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 && stat.size % 2 === 0;
  } catch {
    return false;
  }
}

function unlinkBestEffort(file) {
  try {
    fs.unlinkSync(file);
  } catch { /* ignore */ }
}

function previewText(text) {
  const s = String(text || "");
  return `${s.slice(0, 24)}${s.length > 24 ? "…" : ""}`;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { cleanup(); resolve(true); }, ms);
    function onAbort() {
      cleanup();
      resolve(false);
    }
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function emitPacedPcm(buffer, options = {}) {
  const onAudio = options.onAudio;
  if (!onAudio) throw new Error("onAudio callback is required");

  const sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
  const chunkBytes = Math.max(2, Math.floor((sampleRate * 2 * CHUNK_MS) / 1000)) & ~1;

  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    if (options.signal?.aborted) return;
    const end = Math.min(offset + chunkBytes, buffer.length);
    onAudio(buffer.subarray(offset, end));
    const ok = await abortableDelay(CHUNK_MS, options.signal);
    if (!ok) return;
  }
}

function createTtsCache({ dir = defaultCacheDir(), synthesizeFn } = {}) {
  const delegate = synthesizeFn || require("./tts-fish").synthesize;

  function fileFor(text, options = {}) {
    return path.join(dir, `${cacheKey(text, options)}.pcm`);
  }

  async function synthesizeCached(text, options = {}) {
    if (!options.onAudio) throw new Error("onAudio callback is required");

    const identity = {
      referenceId: options.referenceId || null,
      model: options.model || getEffectiveValue("fish_audio_model"),
      sampleRate: options.sampleRate || DEFAULT_SAMPLE_RATE,
      speed: normalizeSpeed(options.speed),
    };
    const managed = require("./settings/audio").lookupManagedPcm({
      role: options.role,
      text,
      ...identity,
    });
    if (managed) {
      try {
        console.log(`🎵 Managed TTS clip hit (${managed.clip.role}, ${managed.pcm.length} bytes)`);
        await emitPacedPcm(managed.pcm, { ...options, sampleRate: identity.sampleRate });
        return;
      } catch {
        // A playback callback failure must preserve the record and fall back
        // through the existing synthesis path.
      }
    }

    if (!isCacheEnabled()) {
      return delegate(text, options);
    }

    const file = fileFor(text, options);
    if (fs.existsSync(file)) {
      try {
        const stat = fs.statSync(file);
        if (stat.size > 0 && stat.size % 2 === 0) {
          const pcm = fs.readFileSync(file);
          console.log(`🎵 TTS cache hit (${previewText(text)}, ${pcm.length} bytes)`);
          await emitPacedPcm(pcm, options);
          return;
        }
        unlinkBestEffort(file);
      } catch {
        // File may have vanished or changed between exists/stat/read; fall
        // through to synthesize so the caller still gets audio.
      }
    }

    const chunks = [];
    let totalBytes = 0;
    try {
      await delegate(text, {
        ...options,
        onAudio: (chunk) => {
          if (options.signal?.aborted) return;
          if (chunk && chunk.length > 0) {
            const copy = Buffer.from(chunk);
            chunks.push(copy);
            totalBytes += copy.length;
          }
          options.onAudio?.(chunk);
        },
      });
    } catch (err) {
      throw err;
    }

    if (options.signal?.aborted || totalBytes <= 0) return;

    fs.mkdirSync(dir, { recursive: true });
    const pcm = Buffer.concat(chunks, totalBytes);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, pcm);
      fs.renameSync(tmp, file);
      console.log(`🎵 TTS cache store (${previewText(text)}, ${pcm.length} bytes)`);
    } catch (err) {
      unlinkBestEffort(tmp);
      throw err;
    }
  }

  async function prewarm(phrases, baseOptions = {}) {
    if (!isCacheEnabled()) return;

    for (const phrase of phrases || []) {
      if (baseOptions.signal?.aborted) return;
      const item = typeof phrase === "string" ? { text: phrase } : phrase;
      const text = String(item?.text || "").trim();
      if (!text) continue;

      const options = {
        ...baseOptions,
        referenceId: item.referenceId !== undefined ? item.referenceId : baseOptions.referenceId,
        onAudio: () => {},
      };
      const file = fileFor(text, options);
      if (isValidPcmFile(file)) continue;
      if (fs.existsSync(file)) unlinkBestEffort(file);

      try {
        await synthesizeCached(text, options);
      } catch (err) {
        console.warn(`⚠️  TTS cache prewarm failed (${previewText(text)}): ${err.message || err}`);
      }
    }
  }

  return {
    synthesize: synthesizeCached,
    prewarm,
    fileFor,
  };
}

module.exports = {
  cacheKey,
  createTtsCache,
  _test: {
    cacheKey,
    defaultCacheDir,
    emitPacedPcm,
    normalizeSpeed,
  },
};
