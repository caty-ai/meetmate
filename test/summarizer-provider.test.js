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
      llm: { provider: "openai-compatible", model: "local-model", openaiCompatible: oaiCfg("https://llm.test/v1", "key") },
    });
    assert.deepEqual(summary, { summary: ["ok"], decisions: [], todos: [] });
    assert.deepEqual(factoryOptions, { provider: "openai-compatible" });
    assert.equal(completeOptions.baseUrl, "https://llm.test/v1");
    assert.equal(completeOptions.apiKey, "key");
    assert.equal(completeOptions.model, "local-model");
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

test("summarizer returns an empty result when its selected provider lacks credentials", async () => {
  const { summarizeConversation } = require("../src/summarizer");
  const result = await summarizeConversation([{ role: "user", content: "hello" }], {
    llm: { provider: "openai-compatible", model: "local-model", openaiCompatible: {} },
  });
  assert.deepEqual(result, { summary: [], decisions: [], todos: [] });
});
