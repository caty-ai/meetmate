#!/usr/bin/env node
// test-emotion-tags.js — Generate audio samples for each emotion tag
// Usage: node test/test-emotion-tags.js [voiceId]
// Output: test/emotion-samples/*.wav

const path = require("path");
const fs = require("fs");
const { synthesize } = require("../src/tts-fish");

const API_KEY = process.env.FISH_AUDIO_API_KEY || "";
const VOICE_ID = process.argv[2] || process.env.FISH_AUDIO_VOICE_ID || "";
const SAMPLE_RATE = 16000;
const OUT_DIR = path.join(__dirname, "emotion-samples");

// All emotion tags to test
const TAGS = [
  "calm",
  "happy",
  "curious",
  "soft tone",
  "excited",
  "nervous",
  "grateful",
  "laughing",
  "confident",
  "empathetic",
  "embarrassed",
  "surprised",
  "determined",
  "whispering",
  "sighing",
];

// Same test sentence for all tags
const TEST_SENTENCE = "ユーザー、確認できました。こちらの件、問題なさそうです。";

// No-tag baseline
const BASELINE = { tag: "no-tag", text: TEST_SENTENCE };

function writeWav(pcmBuffer, filePath) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);
  header.writeUInt32LE(dataSize + headerSize - 8, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

async function generateSample(tag, text) {
  const chunks = [];
  const fullText = tag === "no-tag" ? text : `(${tag}) ${text}`;

  await synthesize(fullText, {
    apiKey: API_KEY,
    referenceId: VOICE_ID || undefined,
    sampleRate: SAMPLE_RATE,
    latency: "normal", // best quality for comparison
    onAudio(buf) {
      chunks.push(buf);
    },
  });

  return Buffer.concat(chunks);
}

async function main() {
  if (!API_KEY) {
    console.error("Error: FISH_AUDIO_API_KEY not set");
    process.exit(1);
  }

  console.log(`Voice ID: ${VOICE_ID || "(default)"}`);
  console.log(`Test sentence: ${TEST_SENTENCE}`);
  console.log(`Tags to test: ${TAGS.length + 1} (including baseline)\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Generate baseline (no tag)
  const allTests = [BASELINE, ...TAGS.map((t) => ({ tag: t, text: TEST_SENTENCE }))];
  const results = [];

  for (const { tag, text } of allTests) {
    const label = tag.replace(/\s+/g, "-");
    const outPath = path.join(OUT_DIR, `${label}.wav`);
    process.stdout.write(`  Generating: (${tag})... `);
    try {
      const pcm = await generateSample(tag, text);
      writeWav(pcm, outPath);
      const durationSec = (pcm.length / (SAMPLE_RATE * 2)).toFixed(2);
      const sizeKb = (pcm.length / 1024).toFixed(1);
      console.log(`✅ ${durationSec}s (${sizeKb}KB)`);
      results.push({ tag, duration: parseFloat(durationSec), size: pcm.length, path: outPath });
    } catch (err) {
      console.log(`❌ ${err.message}`);
      results.push({ tag, error: err.message });
    }
    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  // Summary
  console.log("\n━━━ Summary ━━━");
  const baseline = results.find((r) => r.tag === "no-tag");
  for (const r of results) {
    if (r.error) {
      console.log(`  (${r.tag}): ERROR - ${r.error}`);
      continue;
    }
    const diff = baseline && !baseline.error
      ? ((r.duration - baseline.duration) / baseline.duration * 100).toFixed(1)
      : "N/A";
    const marker = r.tag === "no-tag" ? " [BASELINE]" : "";
    console.log(`  (${r.tag}): ${r.duration}s  (${diff}% vs baseline)${marker}`);
  }

  console.log(`\nAudio files saved to: ${OUT_DIR}/`);
  console.log("Listen and compare to check which tags actually change the voice!\n");
  console.log("Tip: Tags that produce similar duration AND sound to baseline likely have no effect.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
