"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  FloorClient,
  STATES,
  extractWakeHits,
} = require("../src/floor-client");

class FakeTimers {
  constructor() {
    this.nowMs = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(fn, delay = 0) {
    const id = this.nextId++;
    const handle = { id, unref() {} };
    this.tasks.set(id, { at: this.nowMs + Number(delay), fn, handle });
    return handle;
  }

  clearTimeout(handle) {
    this.tasks.delete(handle?.id ?? handle);
  }

  advance(ms) {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.tasks.values()]
        .filter((task) => task.at <= target)
        .sort((left, right) => left.at - right.at || left.handle.id - right.handle.id)[0];
      if (!next) break;
      this.tasks.delete(next.handle.id);
      this.nowMs = next.at;
      next.fn();
    }
    this.nowMs = target;
  }
}

function makeWire() {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closeCalls = [];
      sockets.push(this);
    }

    open() {
      this.readyState = 1;
      this.emit("open");
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }

    receive(message) {
      this.emit("message", Buffer.from(JSON.stringify(message)));
    }

    close(code, reason) {
      this.closeCalls.push({ code, reason });
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", code, reason);
    }

    drop() {
      this.readyState = 3;
      this.emit("close", 1006, "lost");
    }
  }
  FakeSocket.OPEN = 1;
  return { FakeSocket, sockets };
}

function createHarness(overrides = {}) {
  const timers = new FakeTimers();
  const wire = makeWire();
  const aborts = [];
  const ready = [];
  const fallbackCancelled = [];
  const client = new FloorClient({
    url: "ws://hub.test/floor",
    roomCode: "room-79",
    authToken: "secret",
    agentId: "caty",
    displayName: "Caty",
    wakeWords: ["ケイティ", "caty"],
    clientInstanceId: "instance-caty",
    WebSocketImpl: wire.FakeSocket,
    timers,
    now: () => timers.nowMs,
    random: () => 0.5,
    onAbortPlayback: (event) => aborts.push(event),
    onReady: (event) => ready.push(event),
    onFallbackCancel: (event) => fallbackCancelled.push(event),
    ...overrides,
  });
  return { client, timers, wire, aborts, ready, fallbackCancelled };
}

function welcome(socket, overrides = {}) {
  socket.receive({
    type: "welcome",
    proto: 1,
    memberId: "m1",
    connectionEpoch: 1,
    members: [
      { memberId: "m1", displayName: "Caty", wakeWords: ["ケイティ", "caty"] },
      { memberId: "m2", displayName: "Ciel", wakeWords: ["シエル", "ciel"] },
    ],
    floorState: { holder: null, queue: [] },
    ...overrides,
  });
}

function connectReady(harness, overrides = {}) {
  harness.client.connect();
  const socket = harness.wire.sockets.at(-1);
  socket.open();
  welcome(socket, overrides);
  return socket;
}

function sent(socket, type) {
  return socket.sent.filter((message) => message.type === type);
}

test("extractWakeHits ranks every member by first normalized occurrence", () => {
  const members = [
    { memberId: "caty", wakeWords: ["Caty", "ケイティ"], sttWakeVariants: ["きゃてぃ"] },
    { memberId: "ciel", wakeWords: ["ＣＩＥＬ", "シエル"] },
    { memberId: "other", wakeWords: ["Other"] },
  ];
  assert.deepEqual(extractWakeHits("  ＣＩＥＬ と CATY、お願い ", members), ["ciel", "caty"]);
  assert.deepEqual(extractWakeHits("誰も呼んでいない", members), []);
  assert.deepEqual(extractWakeHits("ケーティ、お願い", members), ["caty"]);
  assert.deepEqual(extractWakeHits("きゃてぃ、お願い", members), ["caty"]);
});

test("waitForReady resolves false immediately when the real client is already DEGRADED", async () => {
  const harness = createHarness();
  harness.client.transition(STATES.DEGRADED, { cause: "probe" });
  const result = await Promise.race([
    harness.client.waitForReady(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("waitForReady hung")), 50)),
  ]);
  assert.equal(result, false);
});

test("connect sends the exact proto 1 hello and welcome becomes READY", () => {
  const harness = createHarness();
  harness.client.connect();
  const socket = harness.wire.sockets[0];
  assert.equal(harness.client.state, STATES.CONNECTING);
  socket.open();
  assert.deepEqual(socket.sent, [{
    type: "hello",
    proto: 1,
    roomCode: "room-79",
    authToken: "secret",
    agentId: "caty",
    displayName: "Caty",
    wakeWords: ["ケイティ", "caty"],
    clientInstanceId: "instance-caty",
  }]);
  welcome(socket);
  assert.equal(harness.client.state, STATES.READY);
  assert.equal(harness.client.connectionEpoch, 1);
  assert.equal(harness.ready.length, 1);
  socket.receive({ type: "ping" });
  assert.deepEqual(sent(socket, "pong"), [{ type: "pong" }]);
});

test("reportText started while CONNECTING recomputes named hits after welcome", async () => {
  const harness = createHarness();
  harness.client.connect();
  const socket = harness.wire.sockets[0];
  const verdict = harness.client.reportText("ケーティ、お願い");
  socket.open();
  welcome(socket);
  await Promise.resolve();
  const report = sent(socket, "wake_report").at(-1);
  assert.deepEqual(report.hits, ["m1"]);
  socket.receive({
    type: "turn_assign",
    roundId: "r1",
    memberId: "m1",
    consumedReportIds: [report.reportId],
  });
  assert.equal((await verdict).kind, "assigned");
});

test("verdict timeout falls back, but a late other assignment cancels it", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const verdict = harness.client.reportWake(["m1", "m2"]);
  const report = sent(socket, "wake_report")[0];
  assert.deepEqual(report, {
    type: "wake_report",
    reportId: "instance-caty:report:1",
    seq: 1,
    hits: ["m1", "m2"],
  });
  harness.timers.advance(1_500);
  assert.deepEqual(await verdict, { kind: "verdict_timeout", reportId: report.reportId, seq: 1 });
  assert.equal(harness.client.reports.size, 0);
  socket.receive({
    type: "turn_assign",
    roundId: "r1",
    memberId: "m2",
    chainDepth: 0,
    consumedReportIds: [report.reportId],
  });
  assert.equal(harness.fallbackCancelled.length, 1);
  assert.equal(harness.fallbackCancelled[0].memberId, "m2");
});

test("reportText sends an empty ballot and settles immediately without retaining a report", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const verdict = await harness.client.reportText("誰も呼んでいない");
  assert.equal(verdict.kind, "empty");
  assert.deepEqual(sent(socket, "wake_report").at(-1).hits, []);
  assert.equal(harness.client.reports.size, 0);
  assert.equal(harness.timers.tasks.size, 0);
});

test("memberId null is an authoritative verdict and never triggers timeout fallback", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const verdict = harness.client.reportWake([]);
  const report = sent(socket, "wake_report")[0];
  socket.receive({
    type: "turn_assign",
    roundId: "r1",
    memberId: null,
    cause: "no_candidates",
    chainDepth: 0,
    consumedReportIds: [report.reportId],
  });
  assert.equal((await verdict).kind, "not_assigned");
  harness.timers.advance(10_000);
  assert.equal(harness.fallbackCancelled.length, 0);
});

test("an unreferenced arbitration rejection settles the wake report, not a queued acquire", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const acquire = harness.client.acquire("r1");
  const request = sent(socket, "request_floor")[0];
  socket.receive({ type: "queued", reqId: request.reqId, position: 1 });

  const verdict = harness.client.reportWake(["m2"]);
  const report = sent(socket, "wake_report").at(-1);
  socket.receive({ type: "rejected", cause: "non_eligible_member" });

  assert.deepEqual(await verdict, {
    kind: "rejected",
    reportId: report.reportId,
    response: { type: "rejected", cause: "non_eligible_member" },
  });
  assert.equal(harness.client.state, STATES.QUEUED);
  assert.equal(harness.client.pendingAcquire.reqId, request.reqId);

  socket.receive({ type: "granted", reqId: request.reqId, grantId: "g1", leaseMs: 15_000 });
  assert.equal((await acquire).grantId, "g1");
});

test("ordered anonymous arbitration rejections settle overlapping reports FIFO", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const first = harness.client.reportWake(["m1"]);
  const second = harness.client.reportWake(["m2"]);
  const reports = sent(socket, "wake_report");

  socket.receive({ type: "rejected", cause: "non_eligible_member" });
  socket.receive({ type: "rejected", cause: "non_eligible_member" });

  assert.equal((await first).reportId, reports[0].reportId);
  assert.equal((await second).reportId, reports[1].reportId);
});

test("decline emits the exact assign_declined wire shape", () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  assert.equal(harness.client.declineAssignment("r7", "missing_utterance"), true);
  assert.deepEqual(sent(socket, "assign_declined"), [{
    type: "assign_declined",
    roundId: "r7",
    cause: "missing_utterance",
  }]);
});

test("an assignment without a local utterance is claimable for 2s, then declined", () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  socket.receive({
    type: "turn_assign",
    roundId: "r1",
    memberId: "m1",
    chainDepth: 0,
    consumedReportIds: ["other-client-report"],
  });
  harness.timers.advance(1_999);
  assert.equal(sent(socket, "assign_declined").length, 0);
  assert.equal(harness.client.claimAssignment().roundId, "r1");

  socket.receive({
    type: "turn_assign",
    roundId: "r2",
    memberId: "m1",
    chainDepth: 0,
    consumedReportIds: ["other-client-report-2"],
  });
  harness.timers.advance(2_000);
  assert.deepEqual(sent(socket, "assign_declined").at(-1), {
    type: "assign_declined", roundId: "r2", cause: "missing_utterance",
  });
});

test("acquire timeout covers only the first response and QUEUED survives past 8s", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const acquire = harness.client.acquire("r1");
  const request = sent(socket, "request_floor")[0];
  socket.receive({ type: "queued", reqId: request.reqId, position: 1 });
  assert.equal(harness.client.state, STATES.QUEUED);
  harness.timers.advance(30_000);
  let settled = false;
  acquire.finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  socket.receive({ type: "granted", reqId: request.reqId, grantId: "g1", leaseMs: 15_000 });
  assert.equal((await acquire).grantId, "g1");
  assert.equal(harness.client.state, STATES.HELD);
  harness.timers.advance(5_000);
  assert.deepEqual(sent(socket, "extend").at(-1), { type: "extend", grantId: "g1" });

  harness.client.release("completed");
  const timedOut = harness.client.acquire("r2");
  const request2 = sent(socket, "request_floor").at(-1);
  harness.timers.advance(8_000);
  await assert.rejects(timedOut, { code: "acquire_timeout" });
  assert.deepEqual(sent(socket, "cancel").at(-1), { type: "cancel", reqId: request2.reqId });
  socket.receive({ type: "granted", reqId: request2.reqId, grantId: "late-g", leaseMs: 15_000 });
  assert.deepEqual(sent(socket, "release").at(-1), {
    type: "release", grantId: "late-g", cause: "stale_grant",
  });
});

test("newer assignment cancels an older queued request before it can start", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const acquire = harness.client.acquire("r1");
  const request = sent(socket, "request_floor")[0];
  socket.receive({ type: "queued", reqId: request.reqId, position: 1 });
  socket.receive({
    type: "turn_assign",
    roundId: "r2",
    memberId: "m2",
    chainDepth: 0,
    consumedReportIds: [],
  });
  await assert.rejects(acquire, { code: "superseded" });
  assert.deepEqual(sent(socket, "cancel").at(-1), { type: "cancel", reqId: request.reqId });
  assert.equal(harness.client.state, STATES.READY);
});

test("newer assignment fences an already-resolved but unstarted older turn", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const verdict = harness.client.reportWake(["m1"]);
  const report = sent(socket, "wake_report")[0];
  socket.receive({
    type: "turn_assign",
    roundId: "r1",
    memberId: "m1",
    chainDepth: 0,
    consumedReportIds: [report.reportId],
  });
  assert.equal((await verdict).kind, "assigned");

  socket.receive({
    type: "turn_assign",
    roundId: "r2",
    memberId: "m2",
    chainDepth: 0,
    consumedReportIds: [],
  });
  assert.equal(harness.client.isAssignmentCurrent({ roundId: "r1" }), false);
  await assert.rejects(harness.client.acquire("r1"), { code: "superseded" });
  assert.equal(sent(socket, "request_floor").length, 0);
});

test("reconnect accepts reset round sequences without weakening same-connection supersede", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  socket.receive({
    type: "turn_assign",
    roundId: "r9",
    memberId: "m2",
    chainDepth: 0,
    consumedReportIds: [],
  });
  assert.equal(harness.client.latestRoundSequence, 9);

  socket.drop();
  assert.equal(harness.client.latestRoundSequence, null);
  harness.timers.advance(250);
  const replacement = harness.wire.sockets.at(-1);
  replacement.open();
  welcome(replacement, { connectionEpoch: 2 });

  const verdict = harness.client.reportWake(["m1"]);
  const report = sent(replacement, "wake_report").at(-1);
  replacement.receive({
    type: "turn_assign",
    roundId: "r1",
    memberId: "m1",
    chainDepth: 0,
    consumedReportIds: [report.reportId],
  });
  const result = await verdict;
  assert.equal(result.kind, "assigned");
  const assignment = result.assignment;
  assert.equal(harness.client.isAssignmentCurrent(assignment), true);

  const acquire = harness.client.acquire(assignment.roundId);
  const request = sent(replacement, "request_floor").at(-1);
  assert.deepEqual(request, {
    type: "request_floor",
    reqId: "instance-caty:req:2",
    roundId: "r1",
  });
  replacement.receive({ type: "granted", reqId: request.reqId, grantId: "g1", leaseMs: 15_000 });
  await acquire;
  harness.client.release("completed");

  replacement.receive({
    type: "turn_assign",
    roundId: "r2",
    memberId: "m2",
    chainDepth: 0,
    consumedReportIds: [],
  });
  assert.equal(harness.client.isAssignmentCurrent({ roundId: "r1" }), false);
  await assert.rejects(harness.client.acquire("r1"), { code: "superseded" });
  assert.equal(sent(replacement, "request_floor").length, 1);
});

test("grant and connection epoch form a real fence across revoke and reconnect", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const acquire = harness.client.acquire("r1");
  const request = sent(socket, "request_floor")[0];
  socket.receive({ type: "granted", reqId: request.reqId, grantId: "g1", leaseMs: 15_000 });
  await acquire;
  const fence = harness.client.fence();
  assert.equal(harness.client.isFenceCurrent(fence), true);
  assert.equal(harness.client.speech("started", 420), true);
  assert.deepEqual(sent(socket, "speech").at(-1), {
    type: "speech", grantId: "g1", phase: "started", tailMs: 420,
  });
  socket.receive({ type: "revoked", grantId: "g1", cause: "lease_expired" });
  assert.equal(harness.client.isFenceCurrent(fence), false);
  assert.deepEqual(harness.aborts, [{ cause: "lease_expired", grantId: "g1" }]);

  socket.drop();
  harness.timers.advance(250);
  const replacement = harness.wire.sockets.at(-1);
  replacement.open();
  welcome(replacement, { connectionEpoch: 2 });
  assert.equal(harness.client.connectionEpoch, 2);
  assert.equal(harness.client.isFenceCurrent(fence), false);
});

test("acquire rejects a current grant from another round without releasing it", async () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const first = harness.client.acquire("r1");
  const request = sent(socket, "request_floor")[0];
  socket.receive({ type: "granted", reqId: request.reqId, grantId: "g1", leaseMs: 15_000 });
  await first;

  await assert.rejects(harness.client.acquire("r2"), { code: "grant_mismatch" });
  assert.equal(harness.client.grant.roundId, "r1");
  assert.equal(sent(socket, "release").length, 0);
});

test("peer speech broadcasts track the bounded synthetic-ballot deferral state", () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  socket.receive({ type: "speech", memberId: "m2", phase: "started", tailMs: 100 });
  assert.equal(harness.client.hasActivePeerSpeech(), true);
  socket.receive({ type: "speech", memberId: "m1", phase: "started", tailMs: 100 });
  assert.equal(harness.client.hasActivePeerSpeech(), true);
  socket.receive({ type: "speech", memberId: "m2", phase: "ended", tailMs: 100 });
  assert.equal(harness.client.hasActivePeerSpeech(), false);
});

test("per-speech diagnostics are silent unless floor debug is enabled", () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  const debugHarness = createHarness({ debug: true });
  const debugSocket = connectReady(debugHarness);
  const debugs = [];
  const originalDebug = console.debug;
  console.debug = (...args) => debugs.push(args.join(" "));
  try {
    socket.receive({ type: "speech", memberId: "m2", phase: "started", tailMs: 100 });
    socket.receive({ type: "speech", memberId: "m2", phase: "ended", tailMs: 100 });
    assert.deepEqual(debugs, []);
    debugSocket.receive({ type: "speech", memberId: "m2", phase: "started", tailMs: 100 });
    debugSocket.receive({ type: "speech", memberId: "m2", phase: "ended", tailMs: 100 });
  } finally {
    console.debug = originalDebug;
  }
  assert.equal(debugs.some((line) => line.includes("speech started")), true);
  assert.equal(debugs.some((line) => line.includes("speech ended")), true);
});

test("A16 diagnostics include null-assignment cause and received speech phases", () => {
  const harness = createHarness({ debug: true });
  const socket = connectReady(harness);
  const logs = [];
  const debugs = [];
  const originalLog = console.log;
  const originalDebug = console.debug;
  console.log = (...args) => logs.push(args.join(" "));
  console.debug = (...args) => debugs.push(args.join(" "));
  try {
    socket.receive({
      type: "turn_assign",
      roundId: "r1",
      memberId: null,
      cause: "no_candidates",
      consumedReportIds: [],
    });
    socket.receive({ type: "speech", memberId: "m2", phase: "started", tailMs: 100 });
    socket.receive({ type: "speech", memberId: "m2", phase: "ended", tailMs: 100 });
  } finally {
    console.log = originalLog;
    console.debug = originalDebug;
  }
  assert.equal(logs.some((line) => line.includes("no_candidates")), true);
  assert.equal(debugs.some((line) => line.includes("speech started")), true);
  assert.equal(debugs.some((line) => line.includes("speech ended")), true);
});

test("reconnect discards unclaimed assignments from the previous epoch", () => {
  const harness = createHarness();
  const socket = connectReady(harness);
  socket.receive({
    type: "turn_assign",
    roundId: "r1",
    memberId: "m1",
    chainDepth: 0,
    consumedReportIds: ["other-client-report"],
  });

  socket.drop();
  harness.timers.advance(250);
  const replacement = harness.wire.sockets.at(-1);
  replacement.open();
  welcome(replacement, { connectionEpoch: 2 });

  assert.equal(harness.client.claimAssignment(), null);
  harness.timers.advance(2_000);
  assert.equal(sent(replacement, "assign_declined").length, 0);
});

test("hub loss degrades pending reports with backoff, then arbitration resumes after reconnect", async () => {
  const harness = createHarness({ random: () => 0.5 });
  const socket = connectReady(harness);
  const interruptedVerdict = harness.client.reportWake(["m1"]);
  socket.drop();

  assert.deepEqual(await interruptedVerdict, { kind: "degraded", delayMs: 500 });
  assert.equal(harness.client.state, STATES.DEGRADED);

  harness.timers.advance(250);
  const replacement = harness.wire.sockets.at(-1);
  replacement.open();
  welcome(replacement, { connectionEpoch: 2 });
  const resumedVerdict = harness.client.reportWake(["m1"]);
  const report = sent(replacement, "wake_report").at(-1);
  replacement.receive({
    type: "turn_assign",
    roundId: "r2",
    memberId: "m1",
    chainDepth: 0,
    consumedReportIds: [report.reportId],
  });
  assert.equal((await resumedVerdict).kind, "assigned");

  const resumedAcquire = harness.client.acquire("r2");
  const request = sent(replacement, "request_floor").at(-1);
  replacement.receive({ type: "granted", reqId: request.reqId, grantId: "g2", leaseMs: 15_000 });
  assert.equal((await resumedAcquire).connectionEpoch, 2);
});

test("initial failures retry with exponential jitter and enter DEGRADED only after grace", () => {
  const harness = createHarness({ random: () => 0.5 });
  const scheduled = [];
  harness.client.on("reconnect_scheduled", (event) => scheduled.push(event));
  harness.client.connect();
  const first = harness.wire.sockets[0];
  first.drop();
  assert.equal(harness.client.state, STATES.CONNECTING);
  assert.deepEqual(scheduled[0], { attempt: 1, delayMs: 250 });
  harness.timers.advance(250);
  const second = harness.wire.sockets[1];
  second.drop();
  assert.deepEqual(scheduled[1], { attempt: 2, delayMs: 500 });
  harness.timers.advance(14_750);
  assert.equal(harness.client.state, STATES.DEGRADED);
  assert.equal(harness.client.fallbackDelayMs(), 500);
});

test("holder disconnect is fail-closed while non-holder loss degrades with bounded fallback", async () => {
  const holder = createHarness();
  const holderSocket = connectReady(holder);
  const acquire = holder.client.acquire("r1");
  const request = sent(holderSocket, "request_floor")[0];
  holderSocket.receive({ type: "granted", reqId: request.reqId, grantId: "g1", leaseMs: 15_000 });
  await acquire;
  holderSocket.drop();
  assert.equal(holder.client.state, STATES.DEGRADED);
  assert.deepEqual(holder.aborts, [{ cause: "disconnect", grantId: "g1" }]);

  const listener = createHarness({ random: () => 0 });
  const socket = connectReady(listener);
  const degraded = [];
  listener.client.on("degraded", (event) => degraded.push(event));
  socket.drop();
  assert.equal(listener.client.state, STATES.DEGRADED);
  assert.equal(degraded[0].delayMs, 200);
  assert.equal(degraded[0].holder, false);
});

test("both hub fields absent disables all wire behavior", async () => {
  const wire = makeWire();
  const client = new FloorClient({ WebSocketImpl: wire.FakeSocket });
  assert.equal(client.state, STATES.DISABLED);
  assert.equal(await client.connect(), false);
  const report = await client.reportWake(["m1"]);
  assert.equal(report.kind, "degraded");
  assert.equal(report.delayMs >= 200 && report.delayMs <= 800, true);
  assert.equal(wire.sockets.length, 0);
});
