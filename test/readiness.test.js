"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const resolver = require("../src/settings/resolver");
const readiness = require("../src/settings/readiness");
const { createConnectionLimiter } = require("../src/settings/routes")._test;

function startup(overrides = {}) {
  return Object.freeze({
    preDotenvEnv: Object.freeze({ ...(overrides.preDotenvEnv || {}) }),
    dotenvSeeds: Object.freeze({}),
    resolvedHome: "/tmp/meetmate-readiness-test",
    configPath: "/tmp/meetmate-readiness-test/config.json",
    connection: Object.freeze({
      openclawUrl: "https://gateway.example",
      openclawToken: "gateway-token",
      openaiApiKey: "openai-key",
      ...(overrides.connection || {}),
    }),
  });
}

function document(overrides = {}) {
  return {
    agent: { id: "caty", displayName: "Caty", wakeWords: ["ケイティ"], name: "Caty" },
    llm: { provider: "openclaw", model: "main" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-key" },
    tts: { provider: "fish-audio", apiKey: "fish-key", voiceId: "voice-id" },
    attendee: { apiKey: "attendee-key", baseUrl: "app.attendee.dev" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
    ...overrides,
  };
}

function initialize(parsed = document(), revision = "a".repeat(64)) {
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed, revision, fingerprint: revision },
    startup: startup(),
  });
}

test.afterEach(() => {
  readiness.reset();
  resolver.resetRuntimeForTest();
});

test("PENDING is unsettled and non-blocking while the selected STT boundary excludes Slack", () => {
  initialize();
  const controller = readiness.createReadinessController();
  assert.deepEqual(controller.gateSystems(), ["soniox", "fish-audio", "attendee", "llm", "tunnel"]);
  const pending = controller.getReadiness();
  assert.equal(pending.ready, false);
  assert.equal(pending.systems.every((system) => system.code === "PENDING"), true);
  assert.deepEqual(pending.blockers, []);

  resolver.publishState({
    exists: true,
    valid: true,
    parsed: document({ stt: { provider: "deepgram", apiKey: "deepgram-key", sonioxApiKey: "soniox-key" } }),
    revision: "b".repeat(64),
    fingerprint: "b".repeat(64),
  });
  assert.deepEqual(controller.gateSystems(), ["deepgram", "fish-audio", "attendee", "llm", "tunnel"]);
  assert.equal(controller.gateSystems().includes("slack"), false);
});

test("the readiness gate follows the selected TTS provider", () => {
  const parsed = document();
  parsed.tts = {
    provider: "elevenlabs",
    elevenlabs: { apiKey: "eleven", voiceId: "voice" },
  };
  initialize(parsed);
  const controller = readiness.createReadinessController();
  assert.deepEqual(controller.gateSystems(), ["soniox", "elevenlabs", "attendee", "llm", "tunnel"]);
});

test("probe settlement, single-flight, CAS, and runtime stickiness preserve the strongest observation", async () => {
  initialize();
  let calls = 0;
  let settle;
  const controller = readiness.createReadinessController({
    probeFn: async () => {
      calls += 1;
      return new Promise((resolve) => { settle = resolve; });
    },
  });
  const first = controller.probeSystem("soniox", { force: true });
  const second = controller.probeSystem("soniox", { force: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  controller.reportRuntimeFailure("soniox", "PAYMENT_REQUIRED");
  settle({ ok: true, code: "CONNECTED" });
  await Promise.all([first, second]);
  const record = controller.inspect("soniox");
  assert.equal(record.ok, false);
  assert.equal(record.code, "PAYMENT_REQUIRED");
  assert.equal(record.source, "runtime");
  assert.equal(typeof record.observedAt, "number");
  assert.equal(record.generation, 1);
});

test("probe 200 cannot clear runtime PAYMENT_REQUIRED, but loopback manual recheck can", async () => {
  initialize();
  const controller = readiness.createReadinessController({
    probeFn: async () => ({ ok: true, code: "CONNECTED" }),
  });
  controller.reportRuntimeFailure("fish-audio", "PAYMENT_REQUIRED");
  await controller.probeSystem("fish-audio", { force: true, allowBilling: true });
  assert.equal(controller.inspect("fish-audio").code, "PAYMENT_REQUIRED");
  assert.equal(controller.inspect("fish-audio").source, "runtime");
  await controller.probeSystem("fish-audio", {
    force: true,
    clearRuntime: true,
    trigger: "loopback-manual",
    allowBilling: true,
  });
  assert.equal(controller.inspect("fish-audio").code, "CONNECTED");
  assert.equal(controller.inspect("fish-audio").source, "probe");
});

test("unexpected probe exceptions still settle PROVIDER_ERROR and TTL marks cached records stale", async () => {
  initialize();
  let clock = 10_000;
  const controller = readiness.createReadinessController({
    now: () => clock,
    probeFn: async (system) => {
      if (system === "soniox") throw new Error("synthetic exception");
      return { ok: true, code: "CONNECTED" };
    },
  });
  await controller.probeSystem("soniox", { force: true });
  assert.equal(controller.inspect("soniox").code, "PROVIDER_ERROR");
  await controller.probeSystem("fish-audio", { force: true, allowBilling: true });
  assert.equal(controller.getReadiness().systems.find((system) => system.id === "fish-audio").stale, false);
  clock += readiness._test.SUCCESS_TTL_MS;
  assert.equal(controller.getReadiness().systems.find((system) => system.id === "fish-audio").stale, true);
});

test("published field invalidation is system-scoped and unrelated saves retain runtime sticky records", () => {
  initialize();
  readiness.reset();
  readiness.attachInvalidator();
  readiness.reportRuntimeFailure("fish-audio", "PAYMENT_REQUIRED");
  const unrelated = document();
  unrelated.agent.name = "Next Caty";
  resolver.publishState({ exists: true, valid: true, parsed: unrelated, revision: "b".repeat(64), fingerprint: "b".repeat(64) });
  assert.equal(readiness.inspect("fish-audio").code, "PAYMENT_REQUIRED");

  const related = document();
  related.agent.name = "Next Caty";
  related.tts.apiKey = "fish-new";
  resolver.publishState({ exists: true, valid: true, parsed: related, revision: "c".repeat(64), fingerprint: "c".repeat(64) });
  assert.equal(readiness.inspect("fish-audio"), null);
});

test("bootstrap followed by a saved gate credential raises the fixed RESTART_REQUIRED blocker", async () => {
  initialize();
  const controller = readiness.createReadinessController({
    probeFn: async () => ({ ok: true, code: "CONNECTED" }),
  });
  controller.attachInvalidator();
  await controller.bootstrap();
  assert.equal(controller.getReadiness().ready, true);
  const saved = document();
  saved.stt.sonioxApiKey = "soniox-new";
  resolver.publishState({ exists: true, valid: true, parsed: saved, revision: "b".repeat(64), fingerprint: "b".repeat(64) });
  const state = controller.getReadiness();
  const blocker = state.blockers.find((entry) => entry.system === "soniox" && entry.code === "RESTART_REQUIRED");
  assert.ok(blocker);
  assert.equal(blocker.fieldId, "soniox_api_key");
  assert.equal(blocker.message, "保存済み・meetmate の再起動が必要です");
});

test("loopback connection and public readiness rate-limit buckets remain independent", () => {
  let clock = 0;
  const loopback = createConnectionLimiter({ now: () => clock, minIntervalMs: 1_000 });
  const publicBucket = readiness.createPublicRateLimiter({
    now: () => clock,
    windowMs: 60_000,
    perAddressLimit: 1,
    globalLimit: 1,
  });
  assert.equal(loopback("soniox"), true);
  assert.equal(publicBucket("203.0.113.4").allowed, true);
  assert.equal(loopback("fish-audio"), true, "a public attempt must not consume loopback provider allowance");
  assert.equal(publicBucket("203.0.113.4").allowed, false);
  clock = 60_000;
  assert.equal(publicBucket("203.0.113.4").allowed, true);
});

test("bootstrap runs each active gate probe once and skips systems with static issues", async () => {
  initialize();
  const calls = [];
  const controller = readiness.createReadinessController({
    probeFn: async (system) => {
      calls.push(system);
      return { ok: true, code: "CONNECTED" };
    },
  });
  await controller.bootstrap();
  await controller.bootstrap();
  assert.deepEqual(calls, ["soniox", "fish-audio", "attendee", "llm", "tunnel"]);

  const missingAttendee = document();
  delete missingAttendee.attendee.apiKey;
  initialize(missingAttendee);
  const skipped = [];
  const second = readiness.createReadinessController({
    probeFn: async (system) => {
      skipped.push(system);
      return { ok: true, code: "CONNECTED" };
    },
  });
  await second.bootstrap();
  assert.equal(skipped.includes("attendee"), false);
});

test("runtime classification uses structured status and reserves NOT_ENABLED for explicit OpenClaw 404", () => {
  assert.equal(readiness.runtimeStatus({ statusCode: 404, message: "ignored" }), 404);
  assert.equal(readiness.classifyRuntimeFailure({ statusCode: 401 }), "AUTH_FAILED");
  assert.equal(readiness.classifyRuntimeFailure({ statusCode: 403 }), "PROVIDER_ERROR");
  assert.equal(readiness.classifyRuntimeFailure({ statusCode: 404 }), "PROVIDER_ERROR");
  assert.equal(readiness.classifyRuntimeFailure({ statusCode: 404 }, { notEnabled404: true }), "NOT_ENABLED");
  assert.equal(readiness.runtimeStatus(new Error("language model not found")), 0);
  assert.equal(readiness.classifyRuntimeFailure(new Error("language model not found")), "PROVIDER_ERROR");
});

test("a failed probe replaces runtime success while runtime failures remain sticky", async () => {
  initialize();
  const controller = readiness.createReadinessController({
    probeFn: async () => ({ ok: false, code: "AUTH_FAILED" }),
  });
  controller.reportRuntimeSuccess("soniox");
  await controller.probeSystem("soniox", { force: true });
  assert.deepEqual(
    { code: controller.inspect("soniox").code, source: controller.inspect("soniox").source },
    { code: "AUTH_FAILED", source: "probe" },
  );
  assert.equal(controller.getReadiness().blockers.some((entry) => entry.system === "soniox"), true);
});

test("Slack-only issues stay diagnostic while meeting-required static issues gate without blockers", () => {
  const withSlackIssue = document();
  withSlackIssue.slack.notifications.enabled = true;
  initialize(withSlackIssue);
  const controller = readiness.createReadinessController();
  const slackStatus = resolver.getStatus();
  assert.equal(slackStatus.issues.some((issue) => issue.fieldId === "slack_bot_token"), true);
  assert.equal(slackStatus.meetingIssues.some((issue) => issue.fieldId === "slack_bot_token"), false);
  for (const system of controller.gateSystems()) {
    controller.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  }
  assert.equal(controller.getReadiness().ready, true);
  assert.equal(controller.getReadiness().setupRequired, false);
  assert.deepEqual(controller.getReadiness().blockers, []);

  const withMeetingIssue = document();
  delete withMeetingIssue.agent.displayName;
  initialize(withMeetingIssue);
  assert.equal(resolver.getStatus().meetingIssues.some((issue) => issue.fieldId === "agent_display_name"), true);
  assert.equal(controller.getReadiness().ready, false);
  assert.equal(controller.getReadiness().setupRequired, true);
  assert.deepEqual(controller.getReadiness().blockers, []);

  initialize();
  assert.equal(controller.getReadiness().ready, true);
  assert.equal(controller.getReadiness().setupRequired, false);
});

test("probeOne refuses billing dispatch unless allowBilling is explicitly granted", async () => {
  initialize();
  const calls = [];
  const controller = readiness.createReadinessController({
    probeFn: async (system) => {
      calls.push(system);
      return { ok: true, code: "CONNECTED" };
    },
  });
  assert.equal(await controller.probeSystem("fish-audio", { force: true, trigger: "public-recheck" }), null);
  assert.equal(await controller.probeSystem("llm", { force: true, trigger: "join" }), null);
  assert.deepEqual(calls, []);
  await controller.probeSystem("fish-audio", {
    force: true,
    trigger: "settings-save",
    allowBilling: true,
  });
  assert.deepEqual(calls, ["fish-audio"]);
});
