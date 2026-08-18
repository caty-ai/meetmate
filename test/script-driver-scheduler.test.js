"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { sendPacedPcm } = require("./tools/lib/pace");
const { ScriptScheduler } = require("./tools/lib/script-scheduler");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("waitForSubjectSpeech observes an already-active turn and offset timeout remains bounded", async () => {
  let now = 0;
  const events = [];
  const played = [];
  const scheduler = new ScriptScheduler({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    onEvent: (event) => events.push(event),
    playAsset: async (id) => played.push(id),
  });
  scheduler.handleDetectorEvent({ type: "onset", tMs: 0, rms: 1 });
  await scheduler.run({ blocks: [{ id: "B1", steps: [
    { type: "waitForSubjectSpeech", timeoutMs: 50 },
    { type: "waitForSubjectOffset", timeoutMs: 50 },
    { type: "play", assetId: "after" },
  ] }] });
  assert.equal(events.find((event) => event.type === "wait_speech_observed").already_speaking, true);
  assert.ok(events.some((event) => event.type === "wait_offset_timeout"));
  assert.deepEqual(played, ["after"]);
});

test("long subject speech blocks the next play until a real offset", async () => {
  let now = 10;
  let resolveTimeout;
  const events = [];
  const played = [];
  const scheduler = new ScriptScheduler({
    now: () => now,
    sleep: (ms) => new Promise((resolve) => {
      resolveTimeout = () => { now += ms; resolve(); };
    }),
    onEvent: (event) => events.push(event),
    playAsset: async (id) => played.push(id),
  });
  scheduler.handleDetectorEvent({ type: "onset", tMs: 10, rms: 2000 });
  const running = scheduler.run({ blocks: [{ id: "B1", steps: [
    { type: "waitForSubjectSpeech", timeoutMs: 100 },
    { type: "waitForSubjectOffset", timeoutMs: 20 },
    { type: "play", assetId: "next-question" },
  ] }] });
  await nextTurn();
  assert.deepEqual(played, []);
  assert.equal(typeof resolveTimeout, "function");
  scheduler.handleDetectorEvent({ type: "offset", tMs: 15, rms: 0, censored: true });
  await nextTurn();
  assert.equal(scheduler.subjectSpeaking, true);
  assert.deepEqual(played, []);
  scheduler.handleDetectorEvent({ type: "offset", tMs: 9000, rms: 0 });
  await running;
  assert.deepEqual(played, ["next-question"]);
  assert.ok(events.some((event) => event.type === "wait_offset_observed"));
});

test("waitForSubjectOffset resolves immediately when the subject is already quiet", async () => {
  let sleepCalls = 0;
  const events = [];
  const scheduler = new ScriptScheduler({
    sleep: async () => { sleepCalls += 1; },
    onEvent: (event) => events.push(event),
  });
  await scheduler.run({ blocks: [{ id: "B1", steps: [{ type: "waitForSubjectOffset", timeoutMs: 50 }] }] });
  assert.equal(sleepCalls, 0);
  assert.equal(events.find((event) => event.type === "wait_offset_observed").already_quiet, true);
});

async function runBarge(position, options = {}) {
  let now = 0;
  let waitCall = 0;
  const onsetMs = options.onsetMs ?? 100;
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
      if (options.offsetBeforeFire && position === "late") {
        now = onsetMs + Math.floor(ms / 2);
        scheduler.handleDetectorEvent({ type: "offset", tMs: now, rms: 0 });
      }
      now = onsetMs + ms;
      return Promise.resolve();
    },
    onEvent: (event) => events.push(event),
    playAsset: async (id) => played.push({ id, now }),
  });
  await scheduler.run({ blocks: [{ id: "B2", steps: [
    { type: "bargeIn", position, assetId: "interrupt", timeoutMs: 10_000, ...options.step },
  ] }] });
  return { events, played };
}

test("bargeIn start and mid use exact onset-relative offsets", async () => {
  const start = await runBarge("start");
  const startEvent = start.events.find((event) => event.type === "barge_in_attempt");
  assert.equal(startEvent.targetPlayMs, 400);
  assert.equal(startEvent.actualPlayMs, 400);
  assert.deepEqual(start.played, [{ id: "interrupt", now: 400 }]);

  const mid = await runBarge("mid", { onsetMs: 200 });
  const midEvent = mid.events.find((event) => event.type === "barge_in_attempt");
  assert.equal(midEvent.targetPlayMs, 2700);
  assert.equal(midEvent.actualPlayMs, 2700);
});

test("late barge-in fires at onset plus lateAfterMs while speech is active", async () => {
  const late = await runBarge("late", { step: { lateAfterMs: 6000 } });
  const event = late.events.find((entry) => entry.type === "barge_in_attempt");
  assert.equal(event.targetPlayMs, 6100);
  assert.equal(event.actualPlayMs, 6100);
  assert.deepEqual(late.played, [{ id: "interrupt", now: 6100 }]);
});

test("late barge-in skips playback when a real offset precedes fire time", async () => {
  const late = await runBarge("late", { offsetBeforeFire: true, step: { lateAfterMs: 6000 } });
  assert.deepEqual(late.played, []);
  assert.equal(late.events.some((event) => event.type === "barge_in_attempt"), false);
  assert.equal(late.events.find((event) => event.type === "barge_in_skipped").reason, "subject_finished_before_late_fire");
});

test("expectSubjectExit ignores censored offsets and starts silence at real-offset observation time", async () => {
  let now = 1000;
  let sleeps = 0;
  let observedAt = null;
  let scheduler;
  scheduler = new ScriptScheduler({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      sleeps += 1;
      if (sleeps === 1) scheduler.handleDetectorEvent({ type: "offset", tMs: 10, rms: 0 });
    },
    onEvent(event) {
      if (event.type === "voice_exit_observed") observedAt = now;
    },
  });
  scheduler.handleDetectorEvent({ type: "onset", tMs: 0, rms: 2000 });
  scheduler.handleDetectorEvent({ type: "offset", tMs: 5, rms: 0, censored: true });
  await scheduler.run({ blocks: [{ id: "B6", steps: [
    { type: "expectSubjectExit", timeoutMs: 500, silenceMs: 100 },
  ] }] });
  assert.equal(observedAt, 1200);
});

test("chat marker emits success only when the sender succeeds", async () => {
  const failed = [];
  const failureScheduler = new ScriptScheduler({
    sendChat: async () => false,
    onEvent: (event) => failed.push(event),
  });
  await failureScheduler.run({ blocks: [{ id: "B0", steps: [{ type: "chatMarker", text: "T0" }] }] });
  assert.equal(failed.some((event) => event.type === "chat_marker"), false);
  assert.equal(failed.find((event) => event.type === "chat_marker_error").reason, "sender_returned_false");

  const succeeded = [];
  const successScheduler = new ScriptScheduler({
    sendChat: async () => true,
    onEvent: (event) => succeeded.push(event),
  });
  await successScheduler.run({ blocks: [{ id: "B0", steps: [{ type: "chatMarker", text: "T0" }] }] });
  assert.equal(succeeded.filter((event) => event.type === "chat_marker").length, 1);
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
    sendChat: async () => true,
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

test("paced sender stops within one chunk after abort", async () => {
  const controller = new AbortController();
  let sends = 0;
  await assert.rejects(sendPacedPcm({
    pcm: Buffer.alloc(24_000 * 2),
    leadMs: 1000,
    signal: controller.signal,
    send: async () => {
      sends += 1;
      controller.abort(new Error("stop playback"));
    },
  }), /stop playback/);
  assert.equal(sends, 1);
});

test("paced sender wakes immediately when aborted during a pacing wait", async () => {
  const controller = new AbortController();
  let sends = 0;
  await assert.rejects(sendPacedPcm({
    pcm: Buffer.alloc(24_000 * 2),
    leadMs: 0,
    signal: controller.signal,
    sleep: () => {
      controller.abort(new Error("signal during wait"));
      return new Promise(() => {});
    },
    send: async () => { sends += 1; },
  }), /signal during wait/);
  assert.equal(sends, 0);
});

test("scheduler abort propagates an aborted signal to active playback", async () => {
  let scheduler;
  let playbackSignal;
  scheduler = new ScriptScheduler({
    playAsset: async (id, metadata, signal) => {
      playbackSignal = signal;
      scheduler.abort("SIGTERM");
      if (signal.aborted) throw signal.reason;
    },
  });
  await assert.rejects(scheduler.run({ blocks: [{ id: "B0", steps: [{ type: "play", assetId: "long" }] }] }), /SIGTERM/);
  assert.equal(playbackSignal.aborted, true);
});

test("example script preserves the B0-B7 measurement playbook and bounded turn waits", () => {
  const script = require("./tools/script-config.example.json");
  assert.deepEqual(script.blocks.map((block) => block.id), ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7"]);
  const block = (id) => script.blocks.find((entry) => entry.id === id);
  assert.equal(block("B1").steps.filter((step) => step.type === "waitForSubjectSpeech").length, 5);
  assert.deepEqual(block("B1").steps.filter((step) => step.type === "waitForSubjectOffset").map((step) => step.timeoutMs), [5000, 8000, 5000, 18000, 20000]);
  assert.deepEqual(block("B2").steps.filter((step) => step.type === "bargeIn").map((step) => step.position), ["start", "start", "mid", "mid", "late"]);
  assert.equal(block("B2").steps.filter((step) => step.type === "waitForSubjectOffset").length, 5);
  for (const step of block("B2").steps.filter((entry) => entry.type === "bargeIn")) {
    assert.match(script.assets[step.assetId].text, /^いまの途中だけど/);
  }
  assert.deepEqual(block("B4").steps.map((step) => [step.type, step.ms]), [["waitMs", 90_000], ["waitMs", 90_000]]);
  assert.equal(block("B5").steps.filter((step) => step.type === "play").length, 8);
  assert.equal(block("B5").steps.some((step) => step.type === "waitForSubjectSpeech"), false);
  assert.deepEqual(block("B6").steps.slice(0, 4).map((step) => step.type), ["play", "expectSubjectExit", "waitForSignal", "play"]);
  assert.equal(block("B6").steps.some((step) => step.type === "waitForSubjectOffset"), true);
  for (const [assetId, asset] of Object.entries(script.assets)) {
    if (!assetId.includes("cancel")) assert.doesNotMatch(asset.text, /キャンセル/);
  }
});
