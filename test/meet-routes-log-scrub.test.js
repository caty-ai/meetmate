"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const test = require("node:test");

const { _test } = require("../src/transport-meet/meet-routes");

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
    result = await _test.requestBotLeave("bot-scrub", "test", apiKey, 1_000);
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
