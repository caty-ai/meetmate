const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { prepareAttendeeChatMessage, sendAttendeeChatMessage } = require("../src/attendee-chat");

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
    const ok = await sendAttendeeChatMessage("bot_test_no_network", "👍🎉", "dummy-key");
    assert.equal(ok, false);
  });
});
