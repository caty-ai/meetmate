#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SCRIPT = path.join(__dirname, "script-config.example.json");
const DEFAULT_OUT = path.join(__dirname, "script-assets");

function usage() {
  return `Usage: node test/tools/render-script-assets.js [options]

Options:
  --script <path>       Script JSON (default: test/tools/script-config.example.json)
  --out <dir>           Output directory (default: test/tools/script-assets)
  --wake-word <word>    Replacement for {{WAKE}} (default: ミートメイト)
  --reference-id <id>  Fish Audio reference voice ID
  --speed <number>      Fish speech speed, 0.5-2.0 (default: 1)
  --help                Show this help
`;
}

function parseArgs(argv) {
  const args = {
    script: DEFAULT_SCRIPT,
    out: DEFAULT_OUT,
    wakeWord: "ミートメイト",
    referenceId: null,
    speed: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { ...args, help: true };
    if (!["--script", "--out", "--wake-word", "--reference-id", "--speed"].includes(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
    const value = argv[++i];
    if (value == null) throw new Error(`${flag} requires a value`);
    if (flag === "--script") args.script = path.resolve(value);
    else if (flag === "--out") args.out = path.resolve(value);
    else if (flag === "--wake-word") args.wakeWord = value;
    else if (flag === "--reference-id") args.referenceId = value;
    else if (flag === "--speed") args.speed = Number(value);
  }
  if (!Number.isFinite(args.speed) || args.speed < 0.5 || args.speed > 2) {
    throw new Error("--speed must be between 0.5 and 2.0");
  }
  return args;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function loadExistingManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { assets: {} };
  }
}

async function render(args) {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY is required");
  const script = JSON.parse(fs.readFileSync(args.script, "utf8"));
  if (!script.assets || typeof script.assets !== "object") throw new Error("script.assets is required");

  fs.mkdirSync(args.out, { recursive: true });
  const manifestFile = path.join(args.out, "manifest.json");
  const existing = loadExistingManifest(manifestFile);
  const sampleRate = 24_000;
  const params = {
    sampleRate,
    referenceId: args.referenceId,
    speed: args.speed,
    model: process.env.FISH_AUDIO_MODEL || "s2-pro",
    wakeWord: args.wakeWord,
  };
  const manifest = { version: 1, sampleRate, params, assets: {} };
  const renderedByKey = new Map();
  const { synthesize } = require("../../src/tts-fish.js");

  for (const [assetId, definition] of Object.entries(script.assets)) {
    if (!definition || typeof definition.text !== "string") throw new Error(`asset ${assetId} requires text`);
    const text = definition.text.replaceAll("{{WAKE}}", args.wakeWord);
    if (definition.speed !== undefined && !Number.isFinite(definition.speed)) {
      throw new Error(`asset ${assetId} speed must be a finite number`);
    }
    const speed = definition.speed === undefined
      ? args.speed
      : Math.min(2.0, Math.max(0.5, definition.speed));
    const assetParams = { ...params, speed };
    const contentKey = sha256(JSON.stringify({ text, params: assetParams }));
    const fileName = `${contentKey.slice(0, 20)}.pcm`;
    const file = path.join(args.out, fileName);
    const previous = existing.assets?.[assetId];
    let pcm;

    if (previous?.contentKey === contentKey && previous.file === fileName && fs.existsSync(file)) {
      pcm = fs.readFileSync(file);
      if (pcm.length !== previous.bytes || sha256(pcm) !== previous.sha256) pcm = null;
    }
    if (!pcm && renderedByKey.has(contentKey)) pcm = renderedByKey.get(contentKey);
    if (!pcm) {
      const chunks = [];
      await synthesize(text, {
        apiKey,
        referenceId: args.referenceId,
        sampleRate,
        speed,
        onAudio(chunk) { chunks.push(Buffer.from(chunk)); },
      });
      pcm = Buffer.concat(chunks);
      if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error(`Fish returned invalid PCM for ${assetId}`);
      fs.writeFileSync(file, pcm);
      console.log(`rendered ${assetId} -> ${fileName} (${pcm.length} bytes)`);
    } else {
      console.log(`cached ${assetId} -> ${fileName}`);
    }
    renderedByKey.set(contentKey, pcm);
    manifest.assets[assetId] = {
      text,
      file: fileName,
      contentKey,
      sha256: sha256(pcm),
      bytes: pcm.length,
      sampleRate,
      params: assetParams,
    };
  }

  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest ${manifestFile} (${Object.keys(manifest.assets).length} assets)`);
}

async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(usage());
      return 0;
    }
    await render(args);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module && process.env.NODE_TEST_CONTEXT === undefined) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main, parseArgs, render, sha256 };
