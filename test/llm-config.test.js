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

function freshConfig(configJson) {
  require("../src/settings/bootstrap").resetStartupForTest();
  require("../src/settings/resolver").resetRuntimeForTest();
  if (configJson !== undefined) {
    const startup = require("../src/settings/bootstrap").captureStartup();
    require("../src/settings/resolver").initializeRuntime({
      state: { exists: true, valid: true, parsed: configJson, revision: "a".repeat(64), fingerprint: `bytes:${"a".repeat(64)}` },
      startup,
    });
  }
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

test("LLM config uses the boot resolver snapshot and ignores raw-agent bypasses", () => {
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
    assert.equal(config.llm.openaiCompatible.emptyResponseRetry, true);
    assert.equal(config.llm.openaiCompatible.trustedAgentTools, false);

    const configJson = {
      llm: {
        provider: "openai-compatible",
        model: "json-model",
        temperature: 0.2,
        maxTokens: 222,
        historyMaxTurns: 7,
        openaiCompatible: {
          baseUrl: "https://json.test/v1",
          apiKey: "legacy-json-key-must-be-ignored",
          emptyResponseRetry: false,
          trustedAgentTools: true,
        },
      },
    };
    config = freshConfig(configJson).getPipelineConfig({}, null, null, configJson);
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
        openaiCompatible: {
          baseUrl: "https://json.test/v1",
          apiKey: null,
          emptyResponseRetry: false,
          trustedAgentTools: true,
        },
      }
    );

    process.env.LLM_PROVIDER = "OPENAI-COMPATIBLE";
    process.env.OPENAI_COMPATIBLE_BASE_URL = "https://env.test/v1";
    process.env.OPENAI_COMPATIBLE_API_KEY = "env-key";
    process.env.AGENT_TEMPERATURE = "0.3";
    process.env.AGENT_MAX_TOKENS = "333";
    config = freshConfig(configJson).getPipelineConfig({}, null, null, configJson);
    assert.equal(config.llm.provider, "openai-compatible");
    assert.equal(config.llm.temperature, 0.3);
    assert.equal(config.llm.maxTokens, 333);
    assert.deepEqual(config.llm.openaiCompatible, {
      baseUrl: "https://env.test/v1",
      apiKey: "env-key",
      emptyResponseRetry: false,
      trustedAgentTools: true,
    });
    assert.equal(config.llm.model, "json-model");
    assert.equal(config.llm.historyMaxTurns, 7);

    const rawAgent = {
      provider: "openclaw",
      model: "agent-model",
      temperature: 0.4,
      maxTokens: 444,
      historyMaxTurns: 4,
      openaiCompatible: {
        baseUrl: "https://agent.test/v1",
        apiKey: "agent-key",
        emptyResponseRetry: true,
        trustedAgentTools: false,
      },
    };
    config = freshConfig(configJson).getPipelineConfig({}, rawAgent, null, configJson);
    assert.equal(config.llm.provider, "openai-compatible");
    assert.equal(config.llm.model, "json-model");
    assert.equal(config.llm.temperature, 0.3);
    assert.equal(config.llm.maxTokens, 333);
    assert.equal(config.llm.historyMaxTurns, 7);
    assert.deepEqual(config.llm.openaiCompatible, {
      baseUrl: "https://env.test/v1",
      apiKey: "env-key",
      emptyResponseRetry: false,
      trustedAgentTools: true,
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
    const configJson = {
      agent: { systemPrompt: "agent persona" },
      llm: { provider: "openai-compatible", model: "standalone-model", systemPrompt: "llm persona" },
    };
    let { getPipelineConfig } = freshConfig(configJson);
    let config = getPipelineConfig({}, null, { systemPrompt: "profile persona" }, {
      ...configJson,
    });
    assert.match(config.llm.systemPrompt, /^llm persona\n\n/);
    assert.doesNotMatch(config.llm.systemPrompt, /agent persona|profile persona|Slack|sessions_spawn|ツール実行ルール|サブエージェント結果/);
    assert.match(config.llm.systemPrompt, /【応答ルール】/);
    assert.match(config.llm.systemPrompt, /【絶対禁止事項】/);

    ({ getPipelineConfig } = freshConfig({ llm: { provider: "openai-compatible", model: "standalone-model" } }));
    config = getPipelineConfig({}, null, { systemPrompt: "profile persona" }, { llm: { model: "standalone-model" } });
    assert.match(config.llm.systemPrompt, /^あなたは日本語で会話する音声アシスタントです。/);
    assert.doesNotMatch(config.llm.systemPrompt, /profile persona/);

    config = getPipelineConfig({}, null, null, { llm: { model: "standalone-model" } });
    assert.match(config.llm.systemPrompt, /^あなたは日本語で会話する音声アシスタントです。/);
  } finally {
    restore();
    delete require.cache[configModulePath];
  }
});

test("Gateway credentials are normalized under llm and required only by OpenClaw", () => {
  const restore = setEnv({
    ...CLEAN_LLM_ENV,
    OPENCLAW_GATEWAY_URL: "https://gateway.test/prefix",
    OPENCLAW_GATEWAY_TOKEN: "token",
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const configJson = {
      llm: { provider: "openai-compatible", model: "standalone-model" },
      gateway: { url: "https://gateway.test/prefix", token: "token" },
    };
    const standalone = freshConfig(configJson).getPipelineConfig({}, null, null, configJson);
    assert.deepEqual(standalone.llm.gateway, {
      url: "https://gateway.test/prefix",
      token: "token",
    });
    assert.equal(errors.length, 0);

    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    const openclawJson = { llm: { provider: "openclaw" } };
    freshConfig(openclawJson).getPipelineConfig({}, null, null, openclawJson);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /selected LLM connection is not configured/);
  } finally {
    console.error = originalError;
    restore();
    delete require.cache[configModulePath];
  }
});

test("OpenAI-compatible provider requires an explicit model without changing the OpenClaw default", () => {
  const restore = setEnv(CLEAN_LLM_ENV);
  try {
    assert.throws(
      () => freshConfig({ llm: { provider: "openai-compatible" } }).getPipelineConfig(),
      /OpenAI-compatible model is required/,
    );
    assert.equal(freshConfig({}).getPipelineConfig().llm.model, "openclaw");
  } finally {
    restore();
    delete require.cache[configModulePath];
  }
});

test("runtime-shaped configJson.agent does not change OpenClaw LLM resolution", () => {
  const restore = setEnv({
    ...CLEAN_LLM_ENV,
    OPENCLAW_GATEWAY_URL: "https://gateway.test",
    OPENCLAW_GATEWAY_TOKEN: "token",
  });
  try {
    const { getPipelineConfig } = freshConfig();
    const config = getPipelineConfig({}, null, null, {
      agent: {
        provider: "openai-compatible",
        model: "configured-agent-model",
        temperature: 0.1,
        maxTokens: 10,
        emotionTags: false,
        openclawSystemAddendum: "configured agent addendum",
      },
    });
    assert.equal(config.llm.provider, "openclaw");
    assert.equal(config.llm.model, "openclaw");
    assert.equal(config.llm.temperature, 0.5);
    assert.equal(config.llm.maxTokens, 300);
    assert.equal(config.emotionTags, true);
    assert.match(config.llm.openclawSystemAddendum, /すべての発話の先頭に必ず感情タグ/);
    assert.doesNotMatch(config.llm.openclawSystemAddendum, /configured agent addendum/);
  } finally {
    restore();
    delete require.cache[configModulePath];
  }
});

test("unknown stored LLM providers become setup VALUE_INVALID and fall back safely", () => {
  const restore = setEnv({
    ...CLEAN_LLM_ENV,
    OPENCLAW_GATEWAY_URL: "https://gateway.test",
    OPENCLAW_GATEWAY_TOKEN: "token",
  });
  try {
    const configJson = {
      llm: { provider: "typo-provider" },
      gateway: { url: "https://gateway.test", token: "token" },
    };
    const config = freshConfig(configJson).getPipelineConfig({}, null, null, configJson);
    assert.equal(config.llm.provider, "openclaw");
    assert.deepEqual(require("../src/settings/resolver").buildEnvelope().issues.find((issue) => issue.fieldId === "llm_provider"), {
      fieldId: "llm_provider", code: "VALUE_INVALID",
    });
  } finally {
    restore();
    delete require.cache[configModulePath];
  }
});

test("standalone custom voice templates warn when openclawRules is missing", () => {
  const restore = setEnv(CLEAN_LLM_ENV);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const first = {
      llm: { provider: "openai-compatible", model: "standalone-model" },
      prompts: { voiceSystemAddendumTemplate: "custom {emotionLine}" },
    };
    freshConfig(first).getPipelineConfig({}, null, null, first);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /voiceSystemAddendumTemplate.*\{openclawRules\}/);

    const second = {
      llm: { provider: "openai-compatible", model: "standalone-model" },
      prompts: { voiceSystemAddendumTemplate: "custom {openclawRules}" },
    };
    freshConfig(second).getPipelineConfig({}, null, null, second);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
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
