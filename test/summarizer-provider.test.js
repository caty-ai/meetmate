const test = require("node:test");
const assert = require("node:assert/strict");

const providerPath = require.resolve("../src/llm-provider");
const summarizerPath = require.resolve("../src/summarizer");

test("summarizer sends resolved OpenAI-compatible credentials and model to its provider", async () => {
  const originalProvider = require.cache[providerPath];
  const originalSummarizer = require.cache[summarizerPath];
  let factoryOptions;
  let completeOptions;
  try {
    require.cache[providerPath] = { exports: {
      createLlmProvider: (options) => {
        factoryOptions = options;
        return { complete: async (_messages, options) => {
          completeOptions = options;
          return { statusCode: 200, text: '{"choices":[{"message":{"content":"{\\"summary\\":[\\"ok\\"],\\"decisions\\":[],\\"todos\\":[]}"}}]}' };
        } };
      },
    } };
    delete require.cache[summarizerPath];
    const { summarizeConversation } = require("../src/summarizer");
    const oaiCfg = (baseUrl, apiKey) => ({ baseUrl, apiKey });
    const summary = await summarizeConversation([{ role: "user", content: "hello" }], {
      llm: {
        provider: "openai-compatible",
        model: "local-model",
        openaiCompatible: { ...oaiCfg("https://llm.test/v1", "key"), trustedAgentTools: true },
      },
    });
    assert.deepEqual(summary, { summary: ["ok"], decisions: [], todos: [] });
    assert.deepEqual(factoryOptions, { provider: "openai-compatible" });
    assert.equal(completeOptions.baseUrl, "https://llm.test/v1");
    assert.equal(completeOptions.apiKey, "key");
    assert.equal(completeOptions.model, "local-model");
    assert.equal(completeOptions.trustedAgentTools, true);
    assert.match(completeOptions.user, /^meetmate-summary-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const firstUser = completeOptions.user;
    await summarizeConversation([{ role: "user", content: "hello again" }], {
      llm: {
        provider: "openai-compatible",
        model: "local-model",
        openaiCompatible: { ...oaiCfg("https://llm.test/v1", "key"), trustedAgentTools: true },
      },
    });
    assert.notEqual(completeOptions.user, firstUser);

    await summarizeConversation([{ role: "user", content: "hello" }], {
      sessionUser: "meet-abc-alpha",
      llm: {
        provider: "openai-compatible",
        model: "local-model",
        openaiCompatible: { ...oaiCfg("https://llm.test/v1", "key"), trustedAgentTools: true },
      },
    });
    assert.equal(completeOptions.user, "meet-abc-alpha");

    assert.equal(completeOptions.timeoutMs, 30_000);
    await summarizeConversation([{ role: "user", content: "hello" }], {
      llm: {
        provider: "openai-compatible",
        model: "local-model",
        responseTimeoutMs: 60_000,
        openaiCompatible: { ...oaiCfg("https://llm.test/v1", "key"), trustedAgentTools: true },
      },
    });
    assert.equal(completeOptions.timeoutMs, 60_000);
  } finally {
    delete require.cache[summarizerPath];
    if (originalSummarizer) require.cache[summarizerPath] = originalSummarizer;
    if (originalProvider === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProvider;
  }
});

test("summarizer retains OpenClaw gateway options from resolved config", async () => {
  const originalProvider = require.cache[providerPath];
  const originalSummarizer = require.cache[summarizerPath];
  let completeOptions;
  try {
    require.cache[providerPath] = { exports: {
      createLlmProvider: () => ({ complete: async (_messages, options) => {
        completeOptions = options;
        return { statusCode: 200, text: '{"choices":[{"message":{"content":"{\\"summary\\":[],\\"decisions\\":[],\\"todos\\":[]}"}}]}' };
      } }),
    } };
    delete require.cache[summarizerPath];
    const { summarizeConversation } = require("../src/summarizer");
    const gatewayCfg = (url, token) => ({ url, token });
    await summarizeConversation([{ role: "user", content: "hello" }], {
      llm: { provider: "openclaw", model: "agent", gateway: gatewayCfg("https://gateway.test/gw", "token") },
    });
    assert.equal(completeOptions.openclawUrl, "https://gateway.test/gw");
    assert.equal(completeOptions.openclawToken, "token");
    assert.equal(completeOptions.model, "agent");
  } finally {
    delete require.cache[summarizerPath];
    if (originalSummarizer) require.cache[summarizerPath] = originalSummarizer;
    if (originalProvider === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProvider;
  }
});

test("summarizer omits task instructions and forces todos empty when task extraction is disabled", async () => {
  const originalProvider = require.cache[providerPath];
  const originalSummarizer = require.cache[summarizerPath];
  let sentPrompt;
  try {
    require.cache[providerPath] = { exports: {
      createLlmProvider: () => ({ complete: async (messages) => {
        sentPrompt = messages[0].content;
        return { statusCode: 200, text: '{"choices":[{"message":{"content":"{\\"summary\\":[\\"ok\\"],\\"decisions\\":[\\"decided\\"],\\"todos\\":[\\"must be ignored\\"]}"}}]}' };
      } }),
    } };
    delete require.cache[summarizerPath];
    const { summarizeConversation } = require("../src/summarizer");
    const result = await summarizeConversation([{ role: "user", content: "hello" }], {
      taskExtractionEnabled: false,
      llm: {
        provider: "openai-compatible",
        model: "local-model",
        openaiCompatible: { baseUrl: "https://llm.test/v1", apiKey: "key" },
      },
    });

    assert.deepEqual(result, { summary: ["ok"], decisions: ["decided"], todos: [] });
    assert.doesNotMatch(sentPrompt, /todos?|TODO|タスク/i);
    assert.match(sentPrompt, /summary/);
    assert.match(sentPrompt, /decisions/);
  } finally {
    delete require.cache[summarizerPath];
    if (originalSummarizer) require.cache[summarizerPath] = originalSummarizer;
    if (originalProvider === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProvider;
  }
});

test("summarizer returns an empty result when its selected provider lacks credentials", async () => {
  const { summarizeConversation } = require("../src/summarizer");
  const result = await summarizeConversation([{ role: "user", content: "hello" }], {
    llm: { provider: "openai-compatible", model: "local-model", openaiCompatible: {} },
  });
  assert.deepEqual(result, { summary: [], decisions: [], todos: [] });
});

test("summarizer uses a provider-neutral error label", async () => {
  const originalProvider = require.cache[providerPath];
  const originalSummarizer = require.cache[summarizerPath];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    require.cache[providerPath] = { exports: {
      createLlmProvider: () => ({ complete: async () => ({
        statusCode: 403,
        text: '{"error":"trusted_meeting_required"}',
      }) }),
    } };
    delete require.cache[summarizerPath];
    const { summarizeConversation } = require("../src/summarizer");
    const result = await summarizeConversation([{ role: "user", content: "hello" }], {
      llm: {
        provider: "openai-compatible",
        model: "local-model",
        openaiCompatible: { baseUrl: "https://llm.test/v1", apiKey: "key" },
      },
    });
    assert.deepEqual(result, { summary: [], decisions: [], todos: [] });
    assert.equal(errors.some((line) => line.includes("OpenAI-compatible summarizer error (403):")), true);
  } finally {
    console.error = originalError;
    delete require.cache[summarizerPath];
    if (originalSummarizer) require.cache[summarizerPath] = originalSummarizer;
    if (originalProvider === undefined) delete require.cache[providerPath];
    else require.cache[providerPath] = originalProvider;
  }
});

test("meeting-end task extraction reads the restart-required boot value", () => {
  const resolver = require("../src/settings/resolver");
  const startup = Object.freeze({
    preDotenvEnv: Object.freeze({}),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: "/tmp/meetmate-summary-feature-test",
    configPath: "/tmp/meetmate-summary-feature-test/config.json",
    connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
  });
  const state = (enabled, revision) => ({
    exists: true,
    valid: true,
    parsed: { features: { taskExtractionEnabled: enabled } },
    revision,
    fingerprint: `summary-feature-${revision}`,
  });
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({ state: state(true, "a".repeat(64)), startup });
  const { _test } = require("../src/transport-meet/meet-routes");
  assert.equal(_test.taskExtractionEnabledAtBoot(), true);

  resolver.publishState(state(false, "b".repeat(64)));
  assert.equal(_test.taskExtractionEnabledAtBoot(), true);

  resolver.initializeRuntime({ state: state(false, "b".repeat(64)), startup });
  assert.equal(_test.taskExtractionEnabledAtBoot(), false);
  resolver.resetRuntimeForTest();
});
