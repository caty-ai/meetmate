"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function installMock(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

function restoreCache(entries) {
  for (const [resolved, previous] of entries) {
    delete require.cache[resolved];
    if (previous) require.cache[resolved] = previous;
  }
}

test("sessionUserFor and warmUpGatewaySession use matching Meet and Discord keys", async () => {
  const warmupPath = require.resolve("../src/gateway-warmup");
  const llmProviderPath = require.resolve("../src/llm-provider");
  const cacheEntries = new Map([
    [warmupPath, require.cache[warmupPath]],
    [llmProviderPath, require.cache[llmProviderPath]],
  ]);
  delete require.cache[warmupPath];
  delete require.cache[llmProviderPath];

  const users = [];
  installMock(llmProviderPath, {
    createLlmProvider: () => ({
      complete(_messages, options) {
        users.push(options.user);
        return Promise.resolve({
          statusCode: 200,
          text: JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        });
      },
    }),
  });

  try {
    const { warmUpGatewaySession } = require(warmupPath);
    const { sessionUserFor } = require("../src/session-user");
    const baseConfig = {
      llm: { provider: "openclaw", model: "test-model", temperature: 0.3 },
      openclawUrl: "https://gateway.example",
      openclawToken: "gateway-secret",
    };

    await warmUpGatewaySession(sessionUserFor("meet", "sid-1", "caty"), baseConfig);
    await warmUpGatewaySession(sessionUserFor("discord", "sid-2", "caty"), baseConfig);

    assert.equal(users.includes("meet-sid-1-caty"), true);
    assert.equal(users.includes("discord-sid-2-caty"), true);
  } finally {
    restoreCache(cacheEntries);
  }
});

test("gateway session tracker defaults to meet keys and accepts explicit discord transport keys", async () => {
  const { createGatewaySessionTracker } = require("../src/gateway-session-tracker");

  function createGatewayEvents() {
    return {
      start() {},
      stop() {},
      buildSessionKey(user, agentId) {
        return `${user}|${agentId}`;
      },
      verifySessionKey() {
        return Promise.resolve();
      },
      onSubagentSpawn() {},
      onSubagentCompletion() {},
      onSessionReply() {},
      onAnnounceInjected() {},
    };
  }

  const tracker = createGatewaySessionTracker({
    gatewayEvents: createGatewayEvents(),
    recordEvent() {},
    sessions: new Map(),
    activeConnections: new Map(),
    getGatewayConfigForProfile() {
      return { enabled: true, agentId: "main" };
    },
    getDefaultAgentId() {
      return "caty";
    },
    appendLateResult() {
      return true;
    },
  });

  tracker.trackGatewaySession({ id: "sid-1", config: { defaultAgentId: "caty" } }, { agentId: "caty" });
  tracker.trackGatewaySession({ id: "sid-2", config: { defaultAgentId: "caty" } }, { agentId: "caty" }, "discord");

  const first = tracker._test.routes.get("sid-1");
  const second = tracker._test.routes.get("sid-2");
  assert.equal(first.parentKey, "meet-sid-1-caty|main");
  assert.equal(second.parentKey, "discord-sid-2-caty|main");
  tracker.close();
});
