const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/pipeline");

const { buildMeetingContextBlock, buildMeetingContextPrompt } = _test;

function entry(seq, text, overrides = {}) {
  const addressed = overrides.addressed === true;
  return {
    seq,
    text,
    timestamp: `2026-05-04T00:00:0${seq}.000Z`,
    addressed,
    injectToLlm: addressed,
    ...overrides,
  };
}

test("meeting context can include recent unaddressed utterances before wake", () => {
  const unaddressed = entry(1, "We agreed the launch date is Friday.");
  const addressed = entry(2, "Caty, remember that finance owns the budget.", { addressed: true });
  const wake = entry(3, "Caty, what do you think about the plan?", { addressed: true });
  const buffer = [unaddressed, addressed, wake];

  const block = buildMeetingContextBlock(buffer, wake, { includeUnaddressed: true });

  assert.match(block, /launch date is Friday/);
  assert.match(block, /finance owns the budget/);
  assert.doesNotMatch(block, /what do you think/);
});

test("meeting context preserves addressed-only behavior when raw context is disabled", () => {
  const buffer = [
    entry(1, "Unaddressed side discussion."),
    entry(2, "Caty, addressed prior turn.", { addressed: true }),
    entry(3, "Caty, answer now.", { addressed: true }),
  ];

  const block = buildMeetingContextBlock(buffer, buffer[2], { includeUnaddressed: false });

  assert.doesNotMatch(block, /side discussion/);
  assert.match(block, /addressed prior turn/);
});

test("meeting context caps raw utterance count and keeps the newest entries", () => {
  const wake = entry(5, "Caty, summarize.", { addressed: true });
  const buffer = [
    entry(1, "first"),
    entry(2, "second"),
    entry(3, "third"),
    entry(4, "fourth"),
    wake,
  ];

  const block = buildMeetingContextBlock(buffer, wake, {
    includeUnaddressed: true,
    maxUtterances: 2,
  });

  assert.doesNotMatch(block, /first/);
  assert.doesNotMatch(block, /second/);
  assert.match(block, /third/);
  assert.match(block, /fourth/);
});

test("meeting context char budget truncates oversized recent context", () => {
  const wake = entry(2, "Caty, respond.", { addressed: true });
  const block = buildMeetingContextBlock(
    [entry(1, "x".repeat(200)), wake],
    wake,
    { includeUnaddressed: true, maxChars: 60 }
  );

  assert.equal(block.length <= 60, true);
  assert.match(block, /\.\.\.$/);
});

test("meeting context prompt injects context as part of the user message", () => {
  const wake = entry(2, "Caty, decide.", { addressed: true });
  const prompt = buildMeetingContextPrompt(
    [entry(1, "The customer prefers option B."), wake],
    wake,
    wake.text,
    { includeUnaddressed: true }
  );

  assert.match(prompt, /^【直近の会議の流れ】/);
  assert.match(prompt, /The customer prefers option B/);
  assert.match(prompt, /【指名された発言】\nCaty, decide\./);
});
