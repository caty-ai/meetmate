const test = require("node:test");
const assert = require("node:assert/strict");

test("gateway events warn and stay disabled for non-OpenClaw providers", () => {
  const gatewayEvents = require("../src/gateway-events");
  const warnings = [];
  let constructed = 0;
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const result = gatewayEvents.start({
      enabled: true,
      name: "openai-compatible",
      openclawUrl: "http://gateway.test",
      openclawToken: "token",
      WebSocketImpl: class {
        constructor() { constructed += 1; }
      },
    });

    assert.equal(result, false);
    assert.equal(constructed, 0);
    assert.deepEqual(warnings, [
      "⚠️  gateway-events disabled: LLM provider=openai-compatible is not openclaw",
    ]);
  } finally {
    console.warn = originalWarn;
    gatewayEvents.stop();
  }
});
