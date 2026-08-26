"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("diffFields returns only values that differ from the loaded form state", () => {
  const { diffFields } = require("../public/settings.js");
  const loaded = {
    agent_name: "Meetmate",
    agent_wake_words: ["ミートメイト", "アシスタント"],
    summary_enabled: true,
    nullable_value: null,
  };
  const current = {
    agent_name: "Meetmate",
    agent_wake_words: ["ミートメイト", "アシスタント"],
    summary_enabled: false,
    nullable_value: null,
  };
  assert.deepEqual(diffFields(loaded, current), { summary_enabled: false });
});

test("diffFields supports explicit null, additions, and does not initialize the DOM", () => {
  const modulePath = require.resolve("../public/settings.js");
  delete require.cache[modulePath];
  assert.doesNotThrow(() => require(modulePath));
  const { diffFields } = require(modulePath);
  assert.deepEqual(
    diffFields({ credential: { state: "set", value: "masked" } }, { credential: null, added: 0 }),
    { credential: null, added: 0 },
  );
  assert.deepEqual(diffFields({ preserved: "value" }, {}), {});
});
