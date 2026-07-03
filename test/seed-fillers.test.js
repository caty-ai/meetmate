const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { cacheKey } = require("../src/tts-cache");
const { computeCacheKey, dedupByKey, loadManifest } = require("../scripts/seed-tts-cache-from-fillers");

const manifestPath = path.join(__dirname, "..", "assets", "fillers", "manifest.json");
const expectedTexts = new Set([
  "はい！今確認するね！",
  "うんうん！ちょっと考えてみるね！",
  "OKだよ！ちょっとだけ待ってね！",
  "うんうん、ちょっと整理してみるね！",
  "了解したよ！少し待ってね！",
  "うんうん、それについて考えてみるね！",
  "うんうん、ちゃんと聞こえてるよ。少し考えるね。",
  // #75: ping / farewell / greeting / timeout recorded takes
  "いま処理中だよ、もう少し待ってね。",
  "進めてるよ、あと少しで返せそう。",
  "ごめん、もう少しだけ待ってね。",
  "お疲れさまでした！また何かあったら呼んでくださいね。",
  "こんにちは！ケイティです。よろしくお願いします！",
  "ちょっと時間がかかってるから、詳細はあとでSlackで共有するね。",
]);

function readManifest() {
  return loadManifest(fs.readFileSync(manifestPath, "utf8"));
}

function withUnsetFishModel(fn) {
  const hadModel = Object.prototype.hasOwnProperty.call(process.env, "FISH_AUDIO_MODEL");
  const previousModel = process.env.FISH_AUDIO_MODEL;
  delete process.env.FISH_AUDIO_MODEL;
  try {
    return fn();
  } finally {
    if (hadModel) {
      process.env.FISH_AUDIO_MODEL = previousModel;
    }
  }
}

test("filler manifest parses and contains exactly 15 entries", () => {
  const manifest = readManifest();

  assert.equal(manifest.entries.length, 15);
});

test("filler manifest texts match the 13 unique Caty fixed phrases", () => {
  const manifest = readManifest();

  assert.deepEqual(new Set(manifest.entries.map((entry) => entry.text)), expectedTexts);
});

test("dedupByKey keeps filler0 and skips later duplicate takes for the shared phrase", () => {
  const manifest = readManifest();
  const params = { referenceId: "test-voice", sampleRate: 24_000, speed: 1.0, model: "s2-pro" };

  const result = withUnsetFishModel(() => dedupByKey(manifest.entries, params));

  assert.equal(result.unique.length, 13);
  assert.equal(result.unique[0].entry.file, "filler0.mp3");
  assert.deepEqual(
    result.duplicates.map((duplicate) => ({
      winner: duplicate.winner.file,
      skipped: duplicate.entry.file,
    })),
    [
      { winner: "filler0.mp3", skipped: "filler1.mp3" },
      { winner: "filler0.mp3", skipped: "filler2.mp3" },
    ],
  );
});

test("script key computation uses the exported TTS cache key logic", () => {
  const text = "うんうん！ちょっと考えてみるね！";
  const params = { referenceId: "test-voice", sampleRate: 24_000, speed: 1.0, model: "s2-pro" };

  withUnsetFishModel(() => {
    assert.equal(
      computeCacheKey(text, params),
      cacheKey(text, {
        referenceId: params.referenceId,
        sampleRate: params.sampleRate,
        speed: params.speed,
      }),
    );
  });
});
