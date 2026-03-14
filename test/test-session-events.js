#!/usr/bin/env node
// Quick self-test for session-events.js

const { SessionLifecycle, VALID_TRANSITIONS } = require("../src/session-events");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

console.log("=== SessionLifecycle Tests ===\n");

// Test 1: Basic state transitions
console.log("1. Basic state transitions");
{
  const lc = new SessionLifecycle("test-1", "meet", { meetingUrl: "https://meet.google.com/test" });
  assert(lc.state === "idle", "initial state is idle");
  assert(lc.transport === "meet", "transport is meet");
  assert(lc.sessionId === "test-1", "sessionId is correct");

  assert(lc.transition("initiating"), "idle → initiating succeeds");
  assert(lc.state === "initiating", "state is initiating");

  assert(lc.transition("ringing"), "initiating → ringing succeeds");
  assert(lc.state === "ringing", "state is ringing");

  assert(lc.transition("in-progress"), "ringing → in-progress succeeds");
  assert(lc.state === "in-progress", "state is in-progress");
  assert(lc.startedAt !== null, "startedAt is set");

  assert(lc.transition("completed"), "in-progress → completed succeeds");
  assert(lc.state === "completed", "state is completed");
  assert(lc.isTerminal, "completed is terminal");
}

// Test 2: Invalid transitions
console.log("\n2. Invalid transitions");
{
  const lc = new SessionLifecycle("test-2", "meet");
  assert(!lc.transition("completed"), "idle → completed is invalid");
  assert(lc.state === "idle", "state unchanged after invalid transition");
  lc.transition("initiating");
  assert(!lc.transition("ending"), "initiating → ending is invalid");
}

// Test 3: Events emitted
console.log("\n3. Events emitted");
{
  const lc = new SessionLifecycle("test-3", "meet");
  const events = [];
  lc.on("state_change", (e) => events.push(e));
  lc.on("session_start", (e) => events.push({ ...e, type: "start" }));
  lc.on("session_end", (e) => events.push({ ...e, type: "end" }));

  lc.transition("initiating");
  lc.transition("in-progress");
  lc.transition("completed");

  assert(events.length >= 3, `emitted ${events.length} state_change events`);
  assert(events.some((e) => e.type === "start"), "session_start emitted");
  assert(events.some((e) => e.type === "end"), "session_end emitted");
}

// Test 4: Duration tracking
console.log("\n4. Duration tracking");
{
  const lc = new SessionLifecycle("test-4", "meet");
  assert(lc.duration === 0, "duration is 0 before start");
  lc.transition("initiating");
  lc.transition("in-progress");
  // Fake a start time 120 seconds ago
  lc._startedAt = Date.now() - 120_000;
  assert(Math.abs(lc.duration - 120) < 2, `duration ~120s (got ${lc.duration})`);
  assert(lc.durationFormatted === "2:00", `formatted duration is 2:00 (got ${lc.durationFormatted})`);
}

// Test 5: toJSON
console.log("\n5. toJSON serialization");
{
  const lc = new SessionLifecycle("test-5", "meet", { meetingUrl: "https://meet.google.com/xxx" });
  lc.transition("initiating");
  const json = lc.toJSON();
  assert(json.sessionId === "test-5", "JSON has sessionId");
  assert(json.transport === "meet", "JSON has transport");
  assert(json.state === "initiating", "JSON has state");
  assert(json.meta.meetingUrl === "https://meet.google.com/xxx", "JSON has meta");
  assert(Array.isArray(json.history), "JSON has history");
}

// Test 6: Failed state
console.log("\n6. Failed state");
{
  const lc = new SessionLifecycle("test-6", "meet");
  lc.transition("initiating");
  assert(lc.transition("failed"), "initiating → failed succeeds");
  assert(lc.isTerminal, "failed is terminal");
  assert(!lc.transition("completed"), "failed → completed is invalid");
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
