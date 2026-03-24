// test/empty-stream-guard.test.js — Test filterSilentRepliesStream from speech-policy.js
const { filterSilentRepliesStream } = require("../src/speech-policy");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Helper: create async generator from array of chunks
async function* fromChunks(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Helper: collect async generator into array
async function collect(gen) {
  const result = [];
  for await (const chunk of gen) {
    result.push(chunk);
  }
  return result;
}

describe("filterSilentRepliesStream (empty stream guard)", () => {
  it("yields nothing for empty stream", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks([])));
    assert.deepEqual(result, []);
  });

  it("yields nothing for 'NO_REPLY' in single chunk", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["NO_REPLY"])));
    assert.deepEqual(result, []);
  });

  it("yields nothing for 'NO_REPLY' split across chunks", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["NO_", "REPLY"])));
    assert.deepEqual(result, []);
  });

  it("yields nothing for whitespace-only stream", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["   ", "\n", "  "])));
    assert.deepEqual(result, []);
  });

  it("yields nothing for 'NO REPLY' with space", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["NO REPLY"])));
    assert.deepEqual(result, []);
  });

  it("yields nothing for 'NO_REPLY。' with punctuation", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["NO_REPLY。"])));
    assert.deepEqual(result, []);
  });

  it("passes through normal text in single chunk", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["こんにちは、Catyです。"])));
    assert.deepEqual(result, ["こんにちは、Catyです。"]);
  });

  it("passes through normal text split across chunks", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["こんにちは、", "Catyです。"])));
    assert.deepEqual(result, ["こんにちは、", "Catyです。"]);
  });

  it("passes through long text that starts similar to NO_REPLY", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["NO_REPLY is not what I meant. ", "Here is the real answer."])));
    assert.deepEqual(result, ["NO_REPLY is not what I meant. ", "Here is the real answer."]);
  });

  it("passes through short text that's not NO_REPLY", async () => {
    const result = await collect(filterSilentRepliesStream(fromChunks(["OK"])));
    assert.deepEqual(result, ["OK"]);
  });
});