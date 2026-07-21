#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { envPath, configPath, ttsCacheDir, bundledAssetPath } = require("../src/paths");

// Load .env exactly like src/server.js does: on the deploy host the voice id
// lives in .env (FISH_AUDIO_VOICE_ID), not config.json — without this the
// computed keys silently never match the running server's.
require("dotenv").config({ path: envPath() });

const { cacheKey } = require("../src/tts-cache");

const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_MODEL = "s2-pro";
const DEFAULT_PRESET_MANIFEST_PATH = bundledAssetPath("fillers", "manifest.json");
const DEFAULT_CONFIG_PATH = configPath();
const DEFAULT_CACHE_DIR = ttsCacheDir();

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function loadManifest(input) {
  const manifest = typeof input === "string" ? JSON.parse(input) : input;
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.entries)) {
    throw new Error("manifest must be a JSON object with an entries array");
  }

  return {
    provenance: String(manifest.provenance || ""),
    entries: manifest.entries.map((entry, index) => {
      if (!entry || typeof entry.file !== "string" || typeof entry.text !== "string") {
        throw new Error(`manifest entry ${index} must include string file and text fields`);
      }
      return { file: entry.file, text: entry.text };
    }),
  };
}

function resolveTtsParams({ cli = {}, env = process.env, config = null, configExists = false } = {}) {
  if (!configExists && !hasOwn(cli, "voiceId")) {
    throw new Error("config.json was not found; pass --voice-id explicitly so cache keys are not guessed");
  }

  const agentVoiceId = config?.agent?.voiceId || null;
  const cliSampleRate = hasOwn(cli, "sampleRate") ? parsePositiveInt(cli.sampleRate) : null;
  if (hasOwn(cli, "sampleRate") && !cliSampleRate) {
    throw new Error("--sample-rate must be a positive integer");
  }

  return {
    referenceId: hasOwn(cli, "voiceId") ? (cli.voiceId || null) : (agentVoiceId || env.FISH_AUDIO_VOICE_ID || null),
    sampleRate: cliSampleRate || parsePositiveInt(env.TTS_SAMPLE_RATE) || DEFAULT_SAMPLE_RATE,
    speed: hasOwn(cli, "speed") ? Number(cli.speed) : (hasOwn(env, "FISH_AUDIO_SPEED") ? Number(env.FISH_AUDIO_SPEED) : 1.0),
    model: hasOwn(cli, "model") ? (cli.model || DEFAULT_MODEL) : (env.FISH_AUDIO_MODEL || DEFAULT_MODEL),
  };
}

function withFishAudioModel(model, fn) {
  const hadModel = hasOwn(process.env, "FISH_AUDIO_MODEL");
  const previousModel = process.env.FISH_AUDIO_MODEL;
  process.env.FISH_AUDIO_MODEL = model || DEFAULT_MODEL;
  try {
    return fn();
  } finally {
    if (hadModel) {
      process.env.FISH_AUDIO_MODEL = previousModel;
    } else {
      delete process.env.FISH_AUDIO_MODEL;
    }
  }
}

function computeCacheKey(text, params, keyFn = cacheKey) {
  return withFishAudioModel(params.model, () => keyFn(text, {
    referenceId: params.referenceId,
    sampleRate: params.sampleRate,
    speed: params.speed,
  }));
}

function dedupByKey(entries, params, keyFn = computeCacheKey) {
  const seen = new Map();
  const items = [];
  const unique = [];
  const duplicates = [];

  for (const entry of entries) {
    const key = keyFn(entry.text, params);
    const existing = seen.get(key);
    if (existing) {
      const duplicate = { type: "duplicate", entry, key, winner: existing.entry };
      duplicates.push(duplicate);
      items.push(duplicate);
      continue;
    }

    const item = { type: "unique", entry, key };
    seen.set(key, item);
    unique.push(item);
    items.push(item);
  }

  return { items, unique, duplicates };
}

function parseArgv(argv) {
  const cli = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      cli.dryRun = true;
      continue;
    }

    const optionMap = {
      "--voice-id": "voiceId",
      "--sample-rate": "sampleRate",
      "--speed": "speed",
      "--model": "model",
      "--config": "configPath",
      "--manifest": "manifestPath",
    };
    const key = optionMap[arg];
    if (!key) {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    cli[key] = argv[i + 1];
    i += 1;
  }
  return cli;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return { exists: false, config: null };
  const raw = fs.readFileSync(configPath, "utf8");
  return { exists: true, config: JSON.parse(raw) };
}

function previewText(text) {
  const value = String(text || "");
  return `${value.slice(0, 32)}${value.length > 32 ? "…" : ""}`;
}

function seedEntry({ entry, key, paths, params, ffmpegBin }) {
  const source = path.join(paths.fillersDir, entry.file);
  const target = path.join(paths.cacheDir, `${key}.pcm`);
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;

  fs.mkdirSync(paths.cacheDir, { recursive: true });
  try {
    const result = spawnSync(ffmpegBin, [
      "-y",
      "-i", source,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ac", "1",
      "-ar", String(params.sampleRate),
      tmp,
    ], { encoding: "utf8" });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `ffmpeg exited with ${result.status}`).trim());
    }

    let stat = fs.statSync(tmp);
    if (stat.size % 2 !== 0) {
      fs.truncateSync(tmp, stat.size - 1);
      stat = fs.statSync(tmp);
    }
    if (stat.size <= 0 || stat.size % 2 !== 0) {
      throw new Error(`invalid PCM output size: ${stat.size}`);
    }

    fs.renameSync(tmp, target);
    return { target, bytes: stat.size };
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch { /* ignore cleanup failures */ }
    throw err;
  }
}

function main(argv = process.argv.slice(2)) {
  const cli = parseArgv(argv);
  const manifestPath = cli.manifestPath ? path.resolve(cli.manifestPath) : DEFAULT_PRESET_MANIFEST_PATH;
  const configPath = cli.configPath ? path.resolve(cli.configPath) : DEFAULT_CONFIG_PATH;
  const { exists: configExists, config } = readConfig(configPath);
  const params = resolveTtsParams({ cli, env: process.env, config, configExists });
  const manifest = loadManifest(fs.readFileSync(manifestPath, "utf8"));
  const deduped = dedupByKey(manifest.entries, params);
  const paths = {
    fillersDir: path.dirname(manifestPath),
    cacheDir: DEFAULT_CACHE_DIR,
  };
  const ffmpegBin = process.env.FFMPEG || "ffmpeg";

  console.log(`🎛️  TTS cache params: referenceId=${params.referenceId || "null"} sampleRate=${params.sampleRate} speed=${params.speed} model=${params.model}`);

  for (const item of deduped.items) {
    if (item.type === "duplicate") {
      console.log(`⏭️  SKIP duplicate take: ${item.winner.file} wins for key ${item.key}; skipping ${item.entry.file}`);
      continue;
    }

    const target = path.join(paths.cacheDir, `${item.key}.pcm`);
    if (cli.dryRun) {
      console.log(`⏭️  DRY RUN would seed "${previewText(item.entry.text)}" from ${item.entry.file} -> ${target}`);
      continue;
    }

    try {
      const result = seedEntry({ entry: item.entry, key: item.key, paths, params, ffmpegBin });
      console.log(`🎵 Seeded "${previewText(item.entry.text)}" from ${item.entry.file} -> ${result.target} (${result.bytes} bytes)`);
    } catch (err) {
      console.error(`❌ Failed to seed ${item.entry.file}: ${err.message || err}`);
      process.exitCode = 1;
      return;
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`❌ ${err.message || err}`);
    process.exitCode = 1;
  }
}

module.exports = {
  computeCacheKey,
  dedupByKey,
  loadManifest,
  parseArgv,
  resolveTtsParams,
  DEFAULT_PRESET_MANIFEST_PATH,
};
