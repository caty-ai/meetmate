#!/usr/bin/env node
// soniox-smoke.js — minimal end-to-end check for the Soniox STT wrapper.
//
// Streams a 16kHz mono PCM file through src/stt-soniox.js and prints
// interim/final transcripts plus utterance_end events. Use this to verify
// Step 1 (#50) without spinning up a full Meet session.
//
// Usage:
//   SONIOX_API_KEY=sk_... node scripts/soniox-smoke.js path/to/audio.{pcm,wav}
//
// Audio must be raw PCM s16le 16k mono, or a WAV with that format (the 44-byte
// header is skipped automatically). Convert with:
//   ffmpeg -i input.m4a -ar 16000 -ac 1 -f s16le out.pcm

const fs = require("fs");
const path = require("path");
const { configPath, envPath } = require("../src/paths");
require("dotenv").config({ path: envPath() });
const { createSonioxSTT } = require("../src/stt-soniox");
const { DEFAULT_MESSAGES } = require("../src/messages");

const audioPath = process.argv[2];
if (!audioPath) {
  console.error("Usage: node scripts/soniox-smoke.js <audio.pcm|audio.wav>");
  process.exit(1);
}
if (!process.env.SONIOX_API_KEY) {
  console.error("❌  SONIOX_API_KEY is not set (export it or put it in .env).");
  process.exit(1);
}

let buf = fs.readFileSync(audioPath);
// Strip a standard 44-byte WAV header if present.
if (path.extname(audioPath).toLowerCase() === ".wav" && buf.slice(0, 4).toString() === "RIFF") {
  buf = buf.slice(44);
}

const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // s16le mono
const smokeConfigPath = configPath();
let configDefaultKeyterms = "";
try {
  if (fs.existsSync(smokeConfigPath)) {
    configDefaultKeyterms = JSON.parse(fs.readFileSync(smokeConfigPath, "utf8"))?.soniox?.smokeDefaultKeyterms || "";
  }
} catch { /* ignore optional smoke config */ }

const stt = createSonioxSTT(process.env.SONIOX_API_KEY, {
  language: "ja",
  sampleRate: SAMPLE_RATE,
  keyterms: (process.env.WAKE_WORDS || configDefaultKeyterms || DEFAULT_MESSAGES.soniox.smokeDefaultKeyterms).split(",").map((s) => s.trim()).filter(Boolean),
});

stt.on("open", () => {
  console.log("✅  connected — streaming audio...");
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= buf.length) {
      clearInterval(timer);
      console.log("📭  audio sent, finishing...");
      setTimeout(() => stt.close(), 500);
      return;
    }
    stt.send(buf.slice(offset, offset + FRAME_BYTES));
    offset += FRAME_BYTES;
  }, FRAME_MS); // simulate real-time pacing
});

stt.on("transcript", (text, isFinal) => {
  console.log(isFinal ? `   final  | ${text}` : `   interim| ${text}`);
});
stt.on("utterance_end", (text) => {
  console.log(`🗣️  UTTERANCE_END | ${text}`);
});
stt.on("error", (err) => {
  console.error("❌  error:", err?.message || err);
});
stt.on("close", () => {
  console.log("🔴  closed.");
  process.exit(0);
});
