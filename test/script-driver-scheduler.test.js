"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ScriptScheduler } = require("./tools/lib/script-scheduler");
const { sendPacedPcm } = require("./tools/meet-script-driver");

test("timeout steps emit events and continue to the next step", async () => {
  let now = 0;
  const events = [];
  const played = [];
  const scheduler = new ScriptScheduler({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    onEvent: (event) => events.push(event),
    playAsset: async (id) => played.push(id),
    exitSilenceMs: 100,
  });
  scheduler.handleDetectorEvent({ type: "onset", tMs: 0, rms: 1 });
  await scheduler.run({ blocks: [{ id: "B6", steps: [
    { type: "waitForSubjectSpeech", timeoutMs: 50 },
    { type: "expectSubjectExit", timeoutMs: 200, silenceMs: 100 },
    { type: "play", assetId: "after" },
  ] }] });
  assert.ok(events.some((event) => event.type === "wait_speech_timeout"));
  assert.ok(events.some((event) => event.type === "voice_exit_timeout"));
  assert.deepEqual(played, ["after"]);
});

async function runBarge(position, onsetMs, offsetMs) {
  let now = 0;
  let waitCall = 0;
  const events = [];
  const played = [];
  let scheduler;
  scheduler = new ScriptScheduler({
    now: () => now,
    sleep(ms) {
      waitCall += 1;
      if (waitCall === 1) {
        now = onsetMs;
        queueMicrotask(() => scheduler.handleDetectorEvent({ type: "onset", tMs: onsetMs, rms: 2000 }));
        return new Promise(() => {});
      }
      if (position === "late" && waitCall === 2) {
        now = offsetMs;
        queueMicrotask(() => scheduler.handleDetectorEvent({ type: "offset", tMs: offsetMs, rms: 0 }));
        return new Promise(() => {});
      }
      now += ms;
      return Promise.resolve();
    },
    onEvent: (event) => events.push(event),
    playAsset: async (id) => played.push({ id, now }),
  });
  await scheduler.run({ blocks: [{ id: "B2", steps: [
    { type: "bargeIn", position, assetId: "interrupt", timeoutMs: 10_000 },
  ] }] });
  return { event: events.find((entry) => entry.type === "barge_in_attempt"), played };
}

test("bargeIn start and mid use exact onset-relative offsets", async () => {
  const start = await runBarge("start", 100, null);
  assert.equal(start.event.targetPlayMs, 400);
  assert.equal(start.event.actualPlayMs, 400);
  assert.deepEqual(start.played, [{ id: "interrupt", now: 400 }]);

  const mid = await runBarge("mid", 200, null);
  assert.equal(mid.event.targetPlayMs, 2700);
  assert.equal(mid.event.actualPlayMs, 2700);
});

test("bargeIn late anchors to offset minus 500 ms and records observation lateness", async () => {
  const late = await runBarge("late", 100, 4100);
  assert.equal(late.event.targetPlayMs, 3600);
  assert.equal(late.event.actualPlayMs, 4100);
  assert.equal(late.event.latenessMs, 500);
});

test("waitForSignal polls a file at bounded intervals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-signal-"));
  let now = 0;
  let polls = 0;
  const events = [];
  const scheduler = new ScriptScheduler({
    now: () => now,
    waitSignalDir: dir,
    signalPollMs: 250,
    sleep: async (ms) => {
      now += ms;
      polls += 1;
      if (polls === 2) fs.writeFileSync(path.join(dir, "reinvited"), "ok");
    },
    onEvent: (event) => events.push(event),
  });
  await scheduler.run({ blocks: [{ id: "B6", steps: [
    { type: "waitForSignal", name: "reinvited", timeoutMs: 2000 },
  ] }] });
  assert.equal(events.find((event) => event.type === "signal_received").name, "reinvited");
  assert.ok(now <= 1000);
});

test("all step events remain block-scoped and ordered", async () => {
  let now = 0;
  const events = [];
  const scheduler = new ScriptScheduler({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    onEvent: (event) => events.push(event),
    playAsset: async () => {},
    playTone: async () => {},
    sendChat: async () => {},
  });
  await scheduler.run({ blocks: [{ id: "B0", steps: [
    { type: "play", assetId: "start" },
    { type: "waitMs", ms: 10 },
    { type: "chatMarker", text: "T0" },
    { type: "anchorTone" },
  ] }] });
  assert.equal(events[0].type, "block_start");
  assert.equal(events.at(-1).type, "block_end");
  assert.ok(events.every((event) => event.blockId === "B0"));
  assert.deepEqual(events.filter((event) => event.type === "step_start").map((event) => event.stepIndex), [0, 1, 2, 3]);
  assert.deepEqual(events.filter((event) => event.type === "step_end").map((event) => event.stepIndex), [0, 1, 2, 3]);
});

test("paced sender never advances beyond the configured lead", async () => {
  let nowNs = 0n;
  let bytesSent = 0;
  const pcm = Buffer.alloc(24_000 * 2);
  const result = await sendPacedPcm({
    pcm,
    leadMs: 150,
    nowNs: () => nowNs,
    sleep: async (ms) => { nowNs += BigInt(Math.ceil(ms * 1e6)); },
    send: async (chunk) => { bytesSent += chunk.length; },
  });
  assert.equal(bytesSent, pcm.length);
  assert.equal(result.sendCount, 10);
  assert.ok(result.maxAheadMs <= 150);
  assert.ok(Number(nowNs) / 1e6 >= 1000);
});

test("example script preserves the B0-B7 measurement playbook", () => {
  const script = require("./tools/script-config.example.json");
  assert.deepEqual(script.blocks.map((block) => block.id), ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7"]);
  const block = (id) => script.blocks.find((entry) => entry.id === id);
  assert.equal(block("B1").steps.filter((step) => step.type === "waitForSubjectSpeech").length, 5);
  assert.deepEqual(block("B2").steps.filter((step) => step.type === "bargeIn").map((step) => step.position), ["start", "start", "mid", "mid", "late"]);
  for (const step of block("B2").steps.filter((entry) => entry.type === "bargeIn")) {
    assert.match(script.assets[step.assetId].text, /^いまの途中だけど/);
  }
  assert.deepEqual(block("B4").steps.map((step) => [step.type, step.ms]), [["waitMs", 90_000], ["waitMs", 90_000]]);
  assert.equal(block("B5").steps.filter((step) => step.type === "play").length, 8);
  assert.equal(block("B5").steps.some((step) => step.type === "waitForSubjectSpeech"), false);
  assert.deepEqual(block("B6").steps.slice(0, 4).map((step) => step.type), ["play", "expectSubjectExit", "waitForSignal", "play"]);
  for (const [assetId, asset] of Object.entries(script.assets)) {
    if (!assetId.includes("cancel")) assert.doesNotMatch(asset.text, /キャンセル/);
  }
});
