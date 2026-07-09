const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { cacheKey } = require("../src/tts-cache");
const { computeCacheKey, dedupByKey, loadManifest } = require("../scripts/seed-tts-cache-from-fillers");

const manifestPath = path.join(__dirname, "..", "assets", "fillers", "manifest.json");

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

test("filler manifest parses and contains preset entries", () => {
  const manifest = readManifest();

  assert.ok(manifest.entries.length > 0);
  for (const entry of manifest.entries) {
    assert.equal(typeof entry.file, "string");
    assert.equal(typeof entry.text, "string");
    assert.ok(entry.file.length > 0);
    assert.ok(entry.text.length > 0);
    assert.ok(fs.existsSync(path.join(path.dirname(manifestPath), entry.file)));
  }
});

test("every manifest entry maps to one dedup decision and cache entries match unique keys", () => {
  const manifest = readManifest();
  const params = { referenceId: "test-voice", sampleRate: 24_000, speed: 1.0, model: "s2-pro" };

  const result = withUnsetFishModel(() => dedupByKey(manifest.entries, params));
  const keys = result.items.map((item) => item.key);

  assert.equal(result.items.length, manifest.entries.length);
  assert.equal(result.unique.length + result.duplicates.length, manifest.entries.length);
  assert.equal(result.unique.length, new Set(keys).size);
  assert.equal(result.unique.length, new Set(manifest.entries.map((entry) => computeCacheKey(entry.text, params))).size);
});

test("dedupByKey keeps first manifest entry for duplicate cache keys", () => {
  const manifest = readManifest();
  const params = { referenceId: "test-voice", sampleRate: 24_000, speed: 1.0, model: "s2-pro" };

  const result = withUnsetFishModel(() => dedupByKey(manifest.entries, params));

  for (const duplicate of result.duplicates) {
    const winnerIndex = manifest.entries.indexOf(duplicate.winner);
    const skippedIndex = manifest.entries.indexOf(duplicate.entry);
    assert.ok(winnerIndex >= 0);
    assert.ok(skippedIndex > winnerIndex);
    assert.equal(computeCacheKey(duplicate.winner.text, params), duplicate.key);
    assert.equal(computeCacheKey(duplicate.entry.text, params), duplicate.key);
  }
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
