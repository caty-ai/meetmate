const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");

const { timeoutHandoff } = require("../src/llm-openclaw");

test("timeout handoff logs scrub the OpenClaw token and preserve benign messages", async (t) => {
  const openclawToken = ["oc", "184", "key"].join("");
  const originalRequest = http.request;
  const originalError = console.error;
  const logs = [];

  console.error = (...args) => logs.push(args);

  try {
    for (const message of [`gateway rejected ${openclawToken}`, "gateway network unavailable"]) {
      http.request = () => createErrorRequest(new Error(message));
      assert.equal(await timeoutHandoff({
        openclawUrl: "http://gateway.test",
        openclawToken,
        model: "agent",
        systemPrompt: "system",
        userPrompt: "user",
        sessionUser: "session-184",
        gatewayModeHandoff: false,
      }), false);
    }

    await t.test("secret row", () => assert.deepEqual(
      logs[0],
      ["❌  Timeout handoff request error:", "gateway rejected [REDACTED]"],
    ));
    await t.test("benign row", () => assert.deepEqual(
      logs[1],
      ["❌  Timeout handoff request error:", "gateway network unavailable"],
    ));
  } finally {
    http.request = originalRequest;
    console.error = originalError;
  }
});

function createErrorRequest(error) {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = () => {};
  req.end = () => process.nextTick(() => req.emit("error", error));
  req.destroy = () => {};
  return req;
}
