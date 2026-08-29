const test = require("node:test");
const assert = require("node:assert/strict");

const { createLlmProvider } = require("../src/llm-provider");
const openclaw = require("../src/llm-openclaw");

function resetSettings() {
  require("../src/settings/bootstrap").resetStartupForTest();
  require("../src/settings/resolver").resetRuntimeForTest();
}

test.beforeEach(resetSettings);
test.afterEach(resetSettings);

test("default provider is openclaw", () => {
  const previous = process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER;

  try {
    const provider = createLlmProvider();
    assert.equal(provider.name, "openclaw");
    assert.strictEqual(provider.streamChat, openclaw.streamChat);
    assert.strictEqual(provider.complete, openclaw.complete);
    assert.strictEqual(provider.timeoutHandoff, openclaw.timeoutHandoff);
    assert.equal(provider.warmup, undefined);
  } finally {
    if (previous === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previous;
  }
});

test("explicit openclaw provider returns the OpenClaw stream", () => {
  const provider = createLlmProvider({ provider: "openclaw" });
  assert.equal(provider.name, "openclaw");
  assert.strictEqual(provider.streamChat, openclaw.streamChat);
});

test("unknown provider falls back to openclaw", () => {
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);

  try {
    let provider;
    assert.doesNotThrow(() => {
      provider = createLlmProvider({ provider: "some-unknown-provider" });
    });
    assert.equal(provider.name, "openclaw");
    assert.strictEqual(provider.streamChat, openclaw.streamChat);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].join(" ").includes("some-unknown-provider"));
  } finally {
    console.error = originalError;
  }
});

test("LLM_PROVIDER selects a provider and options.provider takes precedence", () => {
  const previous = process.env.LLM_PROVIDER;
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);

  try {
    process.env.LLM_PROVIDER = "openclaw";
    const configured = createLlmProvider();
    assert.equal(configured.name, "openclaw");
    assert.strictEqual(configured.streamChat, openclaw.streamChat);
    assert.equal(calls.length, 0);

    process.env.LLM_PROVIDER = "bogus";
    resetSettings();
    const fallback = createLlmProvider();
    assert.equal(fallback.name, "openclaw");
    assert.strictEqual(fallback.streamChat, openclaw.streamChat);
    assert.equal(calls.length, 0);

    const overridden = createLlmProvider({ provider: "openclaw" });
    assert.equal(overridden.name, "openclaw");
    assert.strictEqual(overridden.streamChat, openclaw.streamChat);
    assert.equal(calls.length, 0);
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previous;
  }
});

test("provider names are case-insensitive", () => {
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);

  try {
    const provider = createLlmProvider({ provider: "OpenClaw" });
    assert.equal(provider.name, "openclaw");
    assert.strictEqual(provider.streamChat, openclaw.streamChat);
    assert.equal(calls.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("llm compatibility shim preserves export identity and keys", () => {
  const shim = require("../src/llm");
  assert.strictEqual(shim, openclaw);
  assert.deepEqual(Object.keys(shim).sort(), [
    "VOICE_SYSTEM_ADDENDUM",
    "buildVoiceAddendum",
    "complete",
    "streamChat",
    "timeoutHandoff",
  ]);
});

test("llm compatibility shim can still be replaced through require.cache", () => {
  const llmPath = require.resolve("../src/llm");
  const previous = require.cache[llmPath];
  const mock = { streamChat: async function* () {} };

  try {
    delete require.cache[llmPath];
    require.cache[llmPath] = {
      id: llmPath,
      filename: llmPath,
      loaded: true,
      exports: mock,
    };
    assert.strictEqual(require("../src/llm"), mock);
  } finally {
    delete require.cache[llmPath];
    if (previous) require.cache[llmPath] = previous;
  }
});
