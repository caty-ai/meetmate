const test = require("node:test");
const assert = require("node:assert/strict");

const configModulePath = require.resolve("../src/config");

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function freshConfig() {
  delete require.cache[configModulePath];
  return require(configModulePath);
}

const CLEAN_LLM_ENV = {
  LLM_PROVIDER: undefined,
  OPENAI_COMPATIBLE_BASE_URL: undefined,
  OPENAI_COMPATIBLE_API_KEY: undefined,
  AGENT_TEMPERATURE: undefined,
  AGENT_MAX_TOKENS: undefined,
  OPENCLAW_GATEWAY_URL: undefined,
  OPENCLAW_GATEWAY_TOKEN: undefined,
};

test("LLM config precedence is agent, environment, config.json, then defaults", () => {
  const restore = setEnv(CLEAN_LLM_ENV);
  const originalError = console.error;
  console.error = () => {};
  try {
    let config = freshConfig().getPipelineConfig();
    assert.equal(config.llm.provider, "openclaw");
    assert.equal(config.llm.model, "openclaw");
    assert.equal(config.llm.temperature, 0.5);
    assert.equal(config.llm.maxTokens, 300);
    assert.equal(config.llm.historyMaxTurns, 12);

    const configJson = {
      llm: {
        provider: "openai-compatible",
        model: "json-model",
        temperature: 0.2,
        maxTokens: 222,
        historyMaxTurns: 7,
        openaiCompatible: { baseUrl: "https://json.test/v1", apiKey: "json-key" },
      },
    };
    config = freshConfig().getPipelineConfig({}, null, null, configJson);
    assert.deepEqual(
      {
        provider: config.llm.provider,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.maxTokens,
        historyMaxTurns: config.llm.historyMaxTurns,
        openaiCompatible: config.llm.openaiCompatible,
      },
      {
        provider: "openai-compatible",
        model: "json-model",
        temperature: 0.2,
        maxTokens: 222,
        historyMaxTurns: 7,
        openaiCompatible: { baseUrl: "https://json.test/v1", apiKey: "json-key" },
      }
    );

    process.env.LLM_PROVIDER = "OPENAI-COMPATIBLE";
    process.env.OPENAI_COMPATIBLE_BASE_URL = "https://env.test/v1";
    process.env.OPENAI_COMPATIBLE_API_KEY = "env-key";
    process.env.AGENT_TEMPERATURE = "0.3";
    process.env.AGENT_MAX_TOKENS = "333";
    config = freshConfig().getPipelineConfig({}, null, null, configJson);
    assert.equal(config.llm.provider, "openai-compatible");
    assert.equal(config.llm.temperature, 0.3);
    assert.equal(config.llm.maxTokens, 333);
    assert.deepEqual(config.llm.openaiCompatible, {
      baseUrl: "https://env.test/v1",
      apiKey: "env-key",
    });
    assert.equal(config.llm.model, "json-model");
    assert.equal(config.llm.historyMaxTurns, 7);

    config = freshConfig().getPipelineConfig({}, null, null, {
      ...configJson,
      agent: {
        provider: "openclaw",
        model: "agent-model",
        temperature: 0.4,
        maxTokens: 444,
        historyMaxTurns: 4,
        openaiCompatible: { baseUrl: "https://agent.test/v1", apiKey: "agent-key" },
      },
    });
    assert.equal(config.llm.provider, "openclaw");
    assert.equal(config.llm.model, "agent-model");
    assert.equal(config.llm.temperature, 0.4);
    assert.equal(config.llm.maxTokens, 444);
    assert.equal(config.llm.historyMaxTurns, 4);
    assert.deepEqual(config.llm.openaiCompatible, {
      baseUrl: "https://agent.test/v1",
      apiKey: "agent-key",
    });
  } finally {
    console.error = originalError;
    restore();
    delete require.cache[configModulePath];
  }
});

test("standalone system prompt precedence appends only neutral voice rules", () => {
  const restore = setEnv({ ...CLEAN_LLM_ENV, LLM_PROVIDER: "openai-compatible" });
  try {
    const { getPipelineConfig } = freshConfig();
    let config = getPipelineConfig({}, null, { systemPrompt: "profile persona" }, {
      agent: { systemPrompt: "agent persona" },
      llm: { systemPrompt: "llm persona" },
    });
    assert.match(config.llm.systemPrompt, /^llm persona\n\n/);
    assert.doesNotMatch(config.llm.systemPrompt, /agent persona|profile persona|Slack|sessions_spawn|ツール実行ルール|サブエージェント結果/);
    assert.match(config.llm.systemPrompt, /【応答ルール】/);
    assert.match(config.llm.systemPrompt, /【絶対禁止事項】/);

    config = getPipelineConfig({}, null, { systemPrompt: "profile persona" }, {});
    assert.match(config.llm.systemPrompt, /^profile persona\n\n/);

    config = getPipelineConfig({}, null, null, {});
    assert.match(config.llm.systemPrompt, /^あなたは日本語で会話する音声アシスタントです。/);
  } finally {
    restore();
    delete require.cache[configModulePath];
  }
});

test("Gateway credentials are normalized under llm and required only by OpenClaw", () => {
  const restore = setEnv(CLEAN_LLM_ENV);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const { getPipelineConfig } = freshConfig();
    const standalone = getPipelineConfig({}, null, null, {
      llm: { provider: "openai-compatible" },
      gateway: { url: "https://gateway.test/prefix", token: "token" },
    });
    assert.deepEqual(standalone.llm.gateway, {
      url: "https://gateway.test/prefix",
      token: "token",
    });
    assert.equal(errors.length, 0);

    getPipelineConfig({}, null, null, { llm: { provider: "openclaw" } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /OpenClaw Gateway is required/);
  } finally {
    console.error = originalError;
    restore();
    delete require.cache[configModulePath];
  }
});

test("runtime-shaped configJson.agent preserves OpenClaw addendum overrides", () => {
  const restore = setEnv({
    ...CLEAN_LLM_ENV,
    OPENCLAW_GATEWAY_URL: "https://gateway.test",
    OPENCLAW_GATEWAY_TOKEN: "token",
  });
  try {
    const { getPipelineConfig } = freshConfig();
    assert.equal(
      getPipelineConfig({}, null, null, {
        agent: { openclawSystemAddendum: "agent addendum" },
      }).llm.openclawSystemAddendum,
      "agent addendum"
    );
    assert.equal(
      getPipelineConfig({}, null, null, {
        agent: { openclawSystemAddendum: "" },
      }).llm.openclawSystemAddendum,
      ""
    );
  } finally {
    restore();
    delete require.cache[configModulePath];
  }
});

test("config placeholder resolution applies recursively to llm credentials", () => {
  const { resolveConfigEnv } = freshConfig()._test;
  const { resolved, unresolved } = resolveConfigEnv(
    {
      llm: {
        openaiCompatible: {
          baseUrl: "${TEST_LLM_BASE_URL}",
          apiKey: "${TEST_LLM_API_KEY}",
        },
      },
    },
    {
      TEST_LLM_BASE_URL: "https://placeholder.test/v1",
      TEST_LLM_API_KEY: "placeholder-key",
    }
  );
  assert.deepEqual(unresolved, []);
  assert.deepEqual(resolved.llm.openaiCompatible, {
    baseUrl: "https://placeholder.test/v1",
    apiKey: "placeholder-key",
  });
});
