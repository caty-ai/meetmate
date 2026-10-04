"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { _test } = require("../src/transport-meet/meet-routes");
const { resolveBotHostTarget } = require("../src/attendee-endpoint");
const resolver = require("../src/settings/resolver");

// A real Attendee target (src/attendee-endpoint.js) carrying the given sentinel credential.
function leaveTarget(credential) {
  const home = path.join(os.tmpdir(), "meetmate-routes-log-scrub");
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: { exists: true, valid: true, parsed: { attendee: { apiKey: credential, baseUrl: "attendee.test" } }, revision: "d".repeat(64), fingerprint: "routes-log-scrub" },
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

function respondingRequest(statusCode, body) {
  return (_options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.write = () => true;
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      callback(response);
      response.emit("data", body);
      response.emit("end");
    });
    return request;
  };
}

test("late delegation persistence logs scrub labelled secrets", () => {
  const secret = "key" + "_" + "abc12";
  const logPath = "/tmp/meetmate-log-scrub.md";
  const warnings = [];
  const originalExistsSync = fs.existsSync;
  const originalAppendFileSync = fs.appendFileSync;
  const originalWarn = console.warn;
  fs.existsSync = (target) => target === logPath || originalExistsSync(target);
  fs.appendFileSync = (target, ...args) => {
    if (target === logPath) throw new Error(`api_key=${secret}`);
    return originalAppendFileSync(target, ...args);
  };
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    _test.appendLateDelegationToPersistedLogs(
      { conversationLogMdPath: logPath },
      { label: "task", status: "ok", resultText: "done" },
    );
  } finally {
    fs.existsSync = originalExistsSync;
    fs.appendFileSync = originalAppendFileSync;
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^⚠️  late delegation result persistence failed:/);
  assert.match(warnings[0], /\[REDACTED\]/);
  assert.equal(warnings[0].includes(secret), false);
});

test("Attendee leave request error logs scrub the active API key", async () => {
  const apiKey = "key" + "_" + "abc12";
  const errors = [];
  const originalRequest = https.request;
  const originalError = console.error;
  https.request = () => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.write = () => true;
    request.end = () => queueMicrotask(() => request.emit("error", new Error(`leave failed ${apiKey}`)));
    return request;
  };
  console.error = (...args) => errors.push(args.join(" "));

  let result;
  try {
    result = await _test.requestBotLeave("bot-scrub", "test", leaveTarget(apiKey), 1_000);
  } finally {
    https.request = originalRequest;
    console.error = originalError;
  }

  assert.equal(result.ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^❌  Attendee bot leave error \(test\):/);
  assert.match(errors[0], /\[REDACTED\]/);
  assert.equal(errors[0].includes(apiKey), false);
});

test("Attendee leave request error logs preserve benign messages", async () => {
  const apiKey = "key" + "_" + "abc12";
  const errors = [];
  const originalRequest = https.request;
  const originalError = console.error;
  https.request = () => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.write = () => true;
    request.end = () => queueMicrotask(() => request.emit("error", new Error("upstream 503")));
    return request;
  };
  console.error = (...args) => errors.push(args.join(" "));

  let result;
  try {
    result = await _test.requestBotLeave("bot-scrub", "test", leaveTarget(apiKey), 1_000);
  } finally {
    https.request = originalRequest;
    console.error = originalError;
  }

  assert.equal(result.ok, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], "❌  Attendee bot leave error (test): upstream 503");
  assert.equal(errors[0].includes("[REDACTED]"), false);
});

test("#260 Attendee leave response bodies echoing the key are scrubbed from the leave log", async () => {
  const sentinel = "SENTINEL-LEAVE-CREDENTIAL-7e";
  const target = leaveTarget(sentinel);
  const echoes = [
    `echo ${sentinel}`,
    `Authorization: Token ${sentinel}`,
    JSON.stringify({ authorization: `Token ${sentinel}`, note: "bad credential" }),
  ];
  const originalRequest = https.request;
  const originalLog = console.log;
  for (const echo of echoes) {
    const lines = [];
    https.request = respondingRequest(401, echo);
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const result = await _test.requestBotLeave("bot-scrub", "test", target, 1_000);
      assert.deepEqual(result, { ok: true, statusCode: 401 });
    } finally {
      https.request = originalRequest;
      console.log = originalLog;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^🚪  Attendee bot leave \(test\): bot-scrub → 401 /);
    assert.equal(lines[0].includes(sentinel), false, lines[0]);
    assert.match(lines[0], /\[REDACTED\]/);
  }
});

test("#260 Attendee leave log redacts an unrelated Token-scheme credential without an explicit secret", async () => {
  const target = leaveTarget("SENTINEL-LEAVE-CREDENTIAL-8f");
  const foreign = "SENTINEL-FOREIGN-VALUE-31";
  const lines = [];
  const originalRequest = https.request;
  const originalLog = console.log;
  https.request = respondingRequest(200, `upstream said Authorization: Token ${foreign}, token bucket ok`);
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await _test.requestBotLeave("bot-scrub", "test", target, 1_000);
  } finally {
    https.request = originalRequest;
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(foreign), false, lines[0]);
  assert.match(lines[0], /Authorization: Token \[REDACTED\], token bucket ok$/);
});

test("#260 Attendee leave with a copied target fails closed without a request", async () => {
  const target = leaveTarget("SENTINEL-LEAVE-CREDENTIAL-9a");
  const errors = [];
  let requests = 0;
  const originalRequest = https.request;
  const originalError = console.error;
  https.request = () => {
    requests += 1;
    throw new Error("must not be called");
  };
  console.error = (...args) => errors.push(args.join(" "));
  let result;
  try {
    result = await _test.requestBotLeave("bot-scrub", "test", { ...target }, 1_000);
  } finally {
    https.request = originalRequest;
    console.error = originalError;
  }
  assert.equal(result.ok, false);
  assert.equal(requests, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^❌  Attendee bot leave error \(test\): /);
});
