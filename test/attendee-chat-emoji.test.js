const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const { prepareAttendeeChatMessage, sendAttendeeChatMessage } = require("../src/attendee-chat");
const { resolveBotHostTarget } = require("../src/attendee-endpoint");
const resolver = require("../src/settings/resolver");

// A real target (src/attendee-endpoint.js) carrying the given sentinel credential.
function chatTarget(credential) {
  const home = path.join(os.tmpdir(), "meetmate-attendee-chat-emoji");
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: { attendee: { apiKey: credential, baseUrl: "attendee.test" } }, revision: "c".repeat(64), fingerprint: "chat-emoji" },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: home,
      configPath: path.join(home, "config.json"),
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
  });
  try {
    return resolveBotHostTarget({ snapshot: "effective" });
  } finally {
    resolver.resetRuntimeForTest();
  }
}

describe("prepareAttendeeChatMessage()", () => {
  it("passes through plain text unchanged", () => {
    const r = prepareAttendeeChatMessage("資料はこちら https://example.com/doc です");
    assert.equal(r.message, "資料はこちら https://example.com/doc です");
    assert.equal(r.stripped, false);
    assert.equal(r.skip, false);
  });

  it("strips emojis but keeps the text part (URL survives)", () => {
    const r = prepareAttendeeChatMessage("https://example.com/doc 👍");
    assert.equal(r.message, "https://example.com/doc");
    assert.equal(r.stripped, true);
    assert.equal(r.skip, false);
  });

  it("strips emoji sequences mixed into Japanese text", () => {
    const r = prepareAttendeeChatMessage("完了しました🎉🎉 次は👨‍👩‍👧‍👦の件です");
    assert.equal(r.message.includes("🎉"), false);
    assert.equal(r.message.includes("完了しました"), true);
    assert.equal(r.message.includes("の件です"), true);
    assert.equal(r.stripped, true);
    assert.equal(r.skip, false);
  });

  it("marks all-emoji messages as skip", () => {
    const r = prepareAttendeeChatMessage("👍🎉✨");
    assert.equal(r.skip, true);
    assert.equal(r.stripped, true);
  });

  it("marks empty/null input as skip without strip", () => {
    assert.deepEqual(prepareAttendeeChatMessage(""), { message: "", stripped: false, skip: true });
    assert.deepEqual(prepareAttendeeChatMessage(null), { message: "", stripped: false, skip: true });
  });

  it("is a no-op on input already stripped upstream (no double-strip log trigger)", () => {
    const upstream = prepareAttendeeChatMessage("委譲タスク結果: 調査🎯\n本文です").message;
    const r = prepareAttendeeChatMessage(upstream);
    assert.equal(r.message, upstream);
    assert.equal(r.stripped, false);
  });
});

describe("sendAttendeeChatMessage() emoji fallback", () => {
  it("resolves false for all-emoji messages without hitting the network", async () => {
    const ok = await sendAttendeeChatMessage("bot_test_no_network", "👍🎉", chatTarget("dummy-key"));
    assert.equal(ok, false);
  });

  it("redacts token-shaped Attendee response bodies from success and failure logs", async () => {
    const sentinel = "CHAT-BODY-SENTINEL-4b2e";
    const responses = [
      { statusCode: 200, body: `token=${sentinel}` },
      { statusCode: 500, body: `token=${sentinel}` },
    ];
    const captured = [];
    const target = chatTarget("dummy-key");
    const originalRequest = https.request;
    const originalLog = console.log;
    const originalWarn = console.warn;

    https.request = (_options, onResponse) => {
      const { statusCode, body } = responses.shift();
      const response = new EventEmitter();
      response.statusCode = statusCode;
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.write = () => true;
      request.end = () => {
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", body);
          response.emit("end");
        });
      };
      return request;
    };
    console.log = (...args) => captured.push(args.join(" "));
    console.warn = (...args) => captured.push(args.join(" "));

    try {
      assert.equal(await sendAttendeeChatMessage("bot_success", "hello", target), true);
      assert.ok(captured.some((line) => line.includes("Attendee chat enqueue request")));
      assert.equal(captured.some((line) => line.includes(sentinel)), false);

      assert.equal(await sendAttendeeChatMessage("bot_failure", "hello", target), false);
      assert.ok(captured.some((line) => line.includes("Attendee chat message lost")));
      assert.equal(captured.some((line) => line.includes(sentinel)), false);
    } finally {
      https.request = originalRequest;
      console.log = originalLog;
      console.warn = originalWarn;
    }
  });

  it("scrubs the configured key from request error logs", async () => {
    const apiKey = "key" + "_" + "abc12";
    const captured = [];
    const originalRequest = https.request;
    const originalError = console.error;

    https.request = () => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.write = () => true;
      request.end = () => queueMicrotask(() => request.emit("error", new Error(`request failed ${apiKey}`)));
      return request;
    };
    console.error = (...args) => captured.push(args.join(" "));

    try {
      assert.equal(await sendAttendeeChatMessage("bot_error", "hello", chatTarget(apiKey)), false);
    } finally {
      https.request = originalRequest;
      console.error = originalError;
    }

    assert.equal(captured.length, 1);
    assert.match(captured[0], /^💬  Attendee chat error:/);
    assert.match(captured[0], /\[REDACTED\]/);
    assert.equal(captured[0].includes(apiKey), false);
  });

  it("preserves benign request error logs with a configured key", async () => {
    const apiKey = "key" + "_" + "abc12";
    const captured = [];
    const originalRequest = https.request;
    const originalError = console.error;

    https.request = () => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.write = () => true;
      request.end = () => queueMicrotask(() => request.emit("error", new Error("socket hung up")));
      return request;
    };
    console.error = (...args) => captured.push(args.join(" "));

    try {
      assert.equal(await sendAttendeeChatMessage("bot_error", "hello", chatTarget(apiKey)), false);
    } finally {
      https.request = originalRequest;
      console.error = originalError;
    }

    assert.equal(captured.length, 1);
    assert.equal(captured[0], "💬  Attendee chat error: socket hung up");
    assert.equal(captured[0].includes("[REDACTED]"), false);
  });
});
