"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLiveTrace } = require("../src/live-openai/live-trace");

test("trace persists all stages beyond the rolling conversation limit in order, privately", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-trace-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let ms = 10;
  const trace = createLiveTrace("../session", { directory, now: () => ms });
  for (let i = 0; i < 20; i++) {
    ms++;
    trace.record("input", { text: `質問${i}\n`, epoch: i });
    trace.record("live", { text: `返答${i}`, epoch: i });
    trace.record("backend", { text: `回答${i}`, delegationId: "d", epoch: i });
    trace.record("fish", { text: `音声用${i}`, epoch: i });
  }
  trace.record("audio_drop", { bytes: 24000, epoch: 19 });
  const closing = trace.close(); assert.equal(trace.close(), closing); await closing;
  trace.record("input", { text: "closed" });
  const rows = fs.readFileSync(trace.filePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 83);
  assert.deepEqual(rows.map(r => r.seq), Array.from({ length: 83 }, (_, i) => i + 1));
  assert.equal(rows[1].ms, 1); assert.equal(rows[1].text, "質問0\n");
  assert.equal(rows.at(-1).kind, "end");
  assert.equal(path.dirname(trace.filePath), directory);
  const txt = fs.readFileSync(trace.filePath.replace(/\.jsonl$/, ".txt"), "utf8");
  assert.match(txt, /実際の再生保証なし/); assert.match(txt, /質問0/); assert.match(txt, /音声用19/); assert.match(txt, /audio_drop/);
  for (const file of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
});

test("trace storage failures warn without breaking voice callers", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-trace-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "file"); fs.writeFileSync(file, "x");
  let warnings = 0;
  const trace = createLiveTrace("session", { directory: file, warn: () => warnings++ });
  assert.doesNotThrow(() => trace.record("input", { text: "test" }));
  await trace.close(); assert.equal(warnings, 1);
});

test("asynchronous open failure settles close and does not throw", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-trace-open-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let warnings = 0;
  t.mock.method(fs, "createWriteStream", () => {
    const stream = new (require("node:stream").PassThrough)();
    process.nextTick(() => stream.destroy(new Error("simulated asynchronous disk failure")));
    return stream;
  });
  const trace = createLiveTrace("session", { directory, warn: () => warnings++ });
  await trace.close(); assert.equal(warnings, 1);
});

test("stalled diagnostics are bounded and close after one warning", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-trace-stall-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(fs, "createWriteStream", () => new (require("node:stream").Writable)({ write() {} }));
  let warnings = 0;
  const trace = createLiveTrace("session", { directory, warn: () => warnings++ });
  trace.record("input", { text: "あ".repeat(200000) });
  trace.record("live", { text: "test" });
  trace.record("fish", { text: "ignored" });
  await trace.close(); assert.equal(warnings, 1);
});
