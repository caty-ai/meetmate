const test = require("node:test");
const assert = require("node:assert/strict");

const { SlackNotifier } = require("../src/slack-notifier");

test("Slack operator logs scrub the bot token and preserve benign messages", async (t) => {
  const botToken = ["sl", "184", "key"].join("");
  const notifier = new SlackNotifier(botToken, "channel-184", { enabled: true });
  const lifecycle = {
    sessionId: "session-184",
    transport: "meet",
    meta: { meetingUrl: "https://meet.google.com/test" },
    state: "joining",
    isTerminal: false,
    durationFormatted: "00:00",
    _conversationLog: [],
  };
  const summary = { summary: ["summary"], decisions: [], todos: [] };
  const originalError = console.error;
  const logs = [];
  let failure;

  notifier._slackApi = async () => { throw failure; };
  console.error = (...args) => logs.push(args);

  const rows = [
    {
      name: "postStatus",
      prefix: "⚠️  Slack postStatus error (session=session-184):",
      invoke: () => notifier.postStatus(lifecycle),
    },
    {
      name: "postSummary",
      prefix: "⚠️  Slack postSummary error (session=session-184):",
      invoke: () => notifier.postSummary(lifecycle, summary),
    },
    {
      name: "postTranscript",
      prefix: "⚠️  Slack postTranscript error (session=session-184):",
      invoke: () => notifier.postTranscript(lifecycle, "transcript"),
    },
  ];

  try {
    for (const row of rows) {
      failure = new Error(`Slack rejected ${botToken}`);
      await row.invoke();
      failure = new Error("Slack service unavailable");
      await row.invoke();
    }

    const expected = rows.flatMap(({ prefix }) => [
      [prefix, "Slack rejected [REDACTED]"],
      [prefix, "Slack service unavailable"],
    ]);
    const names = rows.flatMap(({ name }) => [
      `${name} secret row`,
      `${name} benign row`,
    ]);
    for (const [index, name] of names.entries()) {
      await t.test(name, () => assert.deepEqual(logs[index], expected[index]));
    }
  } finally {
    console.error = originalError;
    notifier.destroy();
  }
});
