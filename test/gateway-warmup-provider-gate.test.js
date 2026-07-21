const test = require("node:test");
const assert = require("node:assert/strict");

test("gateway warm-up skips non-OpenClaw providers before making a request", async () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalLog = console.log;
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);

  try {
    process.env.LLM_PROVIDER = "openai-compatible";
    const { warmUpGatewaySession } = require("../src/gateway-warmup");

    const result = await warmUpGatewaySession("s1", {
      openclawUrl: "http://dummy",
      openclawToken: "x",
    });

    assert.equal(result.status, "skipped_provider_openai-compatible");
    assert.deepEqual(errors, []);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    console.log = originalLog;
    console.error = originalError;
  }
});

test("gateway warm-up starts with the default OpenClaw provider", () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalLog = console.log;
  const originalError = console.error;
  const providerPath = require.resolve("../src/llm-provider");
  const originalProviderModule = require.cache[providerPath];
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));

  try {
    delete process.env.LLM_PROVIDER;
    require.cache[providerPath] = {
      exports: {
        createLlmProvider: () => ({
          complete: () => new Promise(() => {}),
        }),
      },
    };

    const { warmUpGatewaySession } = require("../src/gateway-warmup");
    warmUpGatewaySession("s1", {
      openclawUrl: "http://dummy",
      openclawToken: "x",
    });

    assert.equal(logs.some((line) => line.includes("🔥")), true);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    console.log = originalLog;
    console.error = originalError;
    if (originalProviderModule === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProviderModule;
  }
});
