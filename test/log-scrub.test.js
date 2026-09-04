const test = require("node:test");
const assert = require("node:assert/strict");

const logScrub = require("../src/log-scrub");
const discordLogScrub = require("../src/transport-discord/log-scrub");

test("scrubs configured secrets, including values shorter than 16 characters", () => {
  const configuredSecret = ["open", "claw", "runtime", "key"].join("-");
  const shortSecret = ["tiny", "key"].join("-");

  assert.equal(
    logScrub.scrubLogMessage(`gateway rejected ${configuredSecret}`, configuredSecret),
    "gateway rejected [REDACTED]"
  );
  assert.equal(
    logScrub.scrubLogMessage(`gateway rejected ${shortSecret}`, shortSecret),
    "gateway rejected [REDACTED]"
  );
});

test("scrubs labelled token and Authorization Bearer forms", () => {
  const value = ["labelled", "fixture"].join("-");
  const rows = [
    [`request failed token=${value}`, "request failed token=[REDACTED]"],
    [`request failed Authorization: Bearer ${value}`, "request failed Authorization: Bearer [REDACTED]"],
  ];

  for (const [message, expected] of rows) {
    assert.equal(logScrub.scrubLogMessage(message), expected);
  }
});

test("leaves benign log messages unchanged", () => {
  const message = "gateway disconnected before handshake completed";
  assert.equal(logScrub.scrubLogMessage(message), message);
});

test("missing or non-string secrets never throw and still scrub labelled values", () => {
  const value = ["labelled", "fixture"].join("-");

  for (const secret of [undefined, "", 42, { value: "unused" }]) {
    assert.doesNotThrow(() => logScrub.scrubLogMessage(`token=${value}`, secret));
    assert.equal(logScrub.scrubLogMessage(`token=${value}`, secret), "token=[REDACTED]");
  }
});

test("exports identical generic and Discord aliases through the compatibility shim", () => {
  assert.equal(logScrub.scrubDiscordLogMessage, logScrub.scrubLogMessage);
  assert.equal(discordLogScrub, logScrub);
  assert.equal(discordLogScrub.scrubLogMessage, logScrub.scrubLogMessage);
  assert.equal(discordLogScrub.scrubDiscordLogMessage, logScrub.scrubDiscordLogMessage);
});
