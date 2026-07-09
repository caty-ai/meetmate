const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

test("default soniox provider passes when SONIOX_API_KEY is set", () => {
  withEnv(
    {
      STT_PROVIDER: undefined,
      SONIOX_API_KEY: "soniox-key",
      DEEPGRAM_API_KEY: undefined,
    },
    () => {
      assert.doesNotThrow(() => {
        freshConfig().validateSttProviderApiKey();
      });
    },
  );
});

test("soniox provider fails when SONIOX_API_KEY is missing", () => {
  withEnv(
    {
      STT_PROVIDER: "soniox",
      SONIOX_API_KEY: undefined,
      DEEPGRAM_API_KEY: "deepgram-key",
    },
    () => {
      assert.throws(
        () => freshConfig().validateSttProviderApiKey(),
        /SONIOX_API_KEY.*soniox/,
      );
    },
  );
});

test("deepgram provider passes when DEEPGRAM_API_KEY is set", () => {
  withEnv(
    {
      STT_PROVIDER: "deepgram",
      SONIOX_API_KEY: undefined,
      DEEPGRAM_API_KEY: "deepgram-key",
    },
    () => {
      assert.doesNotThrow(() => {
        freshConfig().validateSttProviderApiKey();
      });
    },
  );
});

test("deepgram provider fails when DEEPGRAM_API_KEY is missing", () => {
  withEnv(
    {
      STT_PROVIDER: "deepgram",
      SONIOX_API_KEY: "soniox-key",
      DEEPGRAM_API_KEY: undefined,
    },
    () => {
      assert.throws(
        () => freshConfig().validateSttProviderApiKey(),
        /DEEPGRAM_API_KEY.*deepgram/,
      );
    },
  );
});

function freshConfig() {
  const configPath = path.join(__dirname, "..", "src", "config.js");
  delete require.cache[require.resolve(configPath)];
  return require(configPath);
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const configPath = path.join(__dirname, "..", "src", "config.js");
    delete require.cache[require.resolve(configPath)];
  }
}
