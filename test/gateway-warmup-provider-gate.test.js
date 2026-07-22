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
  let completeCalls = 0;
  console.log = (...args) => logs.push(args.join(" "));
  // The real provider factory may warn for unsupported values; this mock does not.
  console.error = (...args) => errors.push(args);

  try {
    process.env.LLM_PROVIDER = "openai-compatible";
    require.cache[providerPath] = {
      exports: {
        createLlmProvider: () => ({
          complete: () => {
            completeCalls += 1;
            return Promise.resolve({ statusCode: 200, text: "" });
          },
        }),
      },
    };
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
    assert.equal(completeCalls, 0);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    console.log = originalLog;
    console.error = originalError;
    if (originalProviderModule === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProviderModule;
  }
});

test("gateway warm-up uses resolved config provider before env and pins its backend", async () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const providerPath = require.resolve("../src/llm-provider");
  const originalProviderModule = require.cache[providerPath];
  const factoryOptions = [];
  let completeCalls = 0;
  try {
    process.env.LLM_PROVIDER = "openai-compatible";
    require.cache[providerPath] = {
      exports: {
        createLlmProvider: (options) => {
          factoryOptions.push(options);
          return { complete: () => { completeCalls += 1; return new Promise(() => {}); } };
        },
      },
    };
    const { warmUpGatewaySession } = require("../src/gateway-warmup");
    const dummyAuth = (openclawUrl, openclawToken) => ({ openclawUrl, openclawToken });
    const skipped = await warmUpGatewaySession("s1", {
      llm: { provider: "openai-compatible" }, ...dummyAuth("http://dummy", "x"),
    });
    assert.equal(skipped.status, "skipped_provider_openai-compatible");
    assert.equal(completeCalls, 0);

    warmUpGatewaySession("s2", {
      llm: { provider: "openclaw", model: "openclaw" }, ...dummyAuth("http://dummy", "x"),
    });
    assert.deepEqual(factoryOptions, [{ provider: "openclaw" }]);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
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
  const errors = [];
  let completeCalls = 0;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args);

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

    process.env.LLM_PROVIDER = "bogus";
    warmUpGatewaySession("s1", {
      openclawUrl: "http://dummy",
      openclawToken: "x",
    });

    assert.equal(completeCalls, 2);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    console.log = originalLog;
    console.error = originalError;
    if (originalProviderModule === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProviderModule;
  }
});
