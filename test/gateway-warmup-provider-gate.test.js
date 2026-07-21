const test = require("node:test");
const assert = require("node:assert/strict");

test("gateway warm-up skips non-OpenClaw providers before making a request", async () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalLog = console.log;
  const originalError = console.error;
  const providerPath = require.resolve("../src/llm-provider");
  const originalProviderModule = require.cache[providerPath];
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args);

  try {
    process.env.LLM_PROVIDER = "openai-compatible";
    const { warmUpGatewaySession } = require("../src/gateway-warmup");

    const result = await warmUpGatewaySession("s1", {
      openclawUrl: "http://dummy",
      openclawToken: "x",
    });

    assert.equal(result.status, "skipped_provider_openai-compatible");
    assert.equal(
      logs.some(
        (line) =>
          line.includes("⏭️") && line.includes("provider=openai-compatible"),
      ),
      true,
    );
    assert.deepEqual(errors, []);

    process.env.LLM_PROVIDER = "OpenAI-Compatible";
    const mixedCaseResult = await warmUpGatewaySession("s1", {
      openclawUrl: "http://dummy",
      openclawToken: "x",
    });

    assert.equal(mixedCaseResult.status, "skipped_provider_openai-compatible");
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    console.log = originalLog;
    console.error = originalError;
    if (originalProviderModule === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProviderModule;
  }
});

test("gateway warm-up starts with the default OpenClaw provider", () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalLog = console.log;
  const originalError = console.error;
  const providerPath = require.resolve("../src/llm-provider");
  const originalProviderModule = require.cache[providerPath];
  const logs = [];
  let completeCalls = 0;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    delete process.env.LLM_PROVIDER;
    require.cache[providerPath] = {
      exports: {
        createLlmProvider: () => ({
          complete: () => {
            completeCalls += 1;
            return new Promise(() => {});
          },
        }),
      },
    };

    const { warmUpGatewaySession } = require("../src/gateway-warmup");
    warmUpGatewaySession("s1", {
      openclawUrl: "http://dummy",
      openclawToken: "x",
    });

    assert.equal(logs.some((line) => line.includes("🔥")), true);
    assert.equal(completeCalls, 1);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    console.log = originalLog;
    console.error = originalError;
    if (originalProviderModule === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProviderModule;
  }
});
