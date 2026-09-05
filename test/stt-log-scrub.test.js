const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const readiness = require("../src/settings/readiness");

test.afterEach(() => readiness.reset());

test("Deepgram operator logs scrub configured secrets and preserve benign messages", async (t) => {
  const dgKey = ["dg", "184", "key"].join("");
  const sttPath = require.resolve("../src/stt");
  const previousStt = require.cache[sttPath];
  const originalLoad = Module._load;
  const originalError = console.error;
  const logs = [];
  const connection = new EventEmitter();
  let sendError;

  connection.keepAlive = () => {};
  connection.send = () => {
    if (sendError) throw sendError;
  };
  connection.requestClose = () => {};

  Module._load = function load(request, parent, isMain) {
    if (request === "@deepgram/sdk") {
      return {
        LiveTranscriptionEvents: {
          Open: "open",
          Transcript: "transcript",
          UtteranceEnd: "utterance_end",
          Error: "error",
          Close: "close",
        },
        createClient: () => ({ listen: { live: () => connection } }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  console.error = (...args) => logs.push(args);
  delete require.cache[sttPath];

  let stt;
  try {
    const { createSTT } = require("../src/stt");
    stt = createSTT(dgKey, { model: "nova-3", language: "ja", sampleRate: 16_000 });
    stt.on("error", () => {});
    connection.emit("open");

    connection.emit("error", Object.assign(new Error(`Deepgram rejected ${dgKey}`), { code: "DG_TEST" }));
    connection.emit("error", new Error("Deepgram stream unavailable"));

    sendError = new Error(`send rejected ${dgKey}`);
    stt.send(Buffer.alloc(0));
    sendError = new Error("send buffer unavailable");
    stt.send(Buffer.alloc(0));

    const rows = [
      ["connection secret row", logs[0], ["❌  STT error:", "Deepgram rejected [REDACTED] (code=DG_TEST)"]],
      ["connection benign row", logs[1], ["❌  STT error:", "Deepgram stream unavailable"]],
      ["send secret row", logs[2], ["❌  STT send error:", "send rejected [REDACTED]"]],
      ["send benign row", logs[3], ["❌  STT send error:", "send buffer unavailable"]],
    ];
    for (const [name, actual, expected] of rows) {
      await t.test(name, () => assert.deepEqual(actual, expected));
    }
  } finally {
    stt?.close();
    Module._load = originalLoad;
    console.error = originalError;
    delete require.cache[sttPath];
    if (previousStt) require.cache[sttPath] = previousStt;
  }
});
