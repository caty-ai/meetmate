const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

test("Deepgram STT force-emits when accumulated final text reaches cap", async () => {
  const previousCap = process.env.STT_ACCUMULATED_MAX_CHARS;
  process.env.STT_ACCUMULATED_MAX_CHARS = "12";

  const sttPath = require.resolve("../src/stt");
  const previousStt = require.cache[sttPath];
  const originalLoad = Module._load;
  delete require.cache[sttPath];

  const connection = new EventEmitter();
  connection.keepAlive = () => {};
  connection.send = () => {};
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
        createClient: () => ({
          listen: {
            live: () => connection,
          },
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { createSTT } = require("../src/stt");
    const stt = createSTT("test-key", { model: "nova-3", language: "ja", sampleRate: 16000 });
    const utterances = [];
    stt.on("utterance_end", (text) => utterances.push(text));

    connection.emit("transcript", transcriptData("abcdef", true, false));
    assert.deepEqual(utterances, []);

    connection.emit("transcript", transcriptData("ghijkl", true, false));
    assert.deepEqual(utterances, ["abcdefghijkl"]);

    connection.emit("transcript", transcriptData("zz", true, true));
    assert.deepEqual(utterances, ["abcdefghijkl", "zz"]);

    stt.close();
  } finally {
    Module._load = originalLoad;
    delete require.cache[sttPath];
    if (previousStt) require.cache[sttPath] = previousStt;
    if (previousCap === undefined) delete process.env.STT_ACCUMULATED_MAX_CHARS;
    else process.env.STT_ACCUMULATED_MAX_CHARS = previousCap;
  }
});

test("Soniox STT force-emits when accumulated final tokens reach cap", async () => {
  const previousCap = process.env.STT_ACCUMULATED_MAX_CHARS;
  process.env.STT_ACCUMULATED_MAX_CHARS = "12";

  const sonioxPath = require.resolve("../src/stt-soniox");
  const previousSoniox = require.cache[sonioxPath];
  delete require.cache[sonioxPath];

  let socket;
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      socket = this;
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }

  try {
    const { createSonioxSTT } = require("../src/stt-soniox");
    const stt = createSonioxSTT("test-key", {
      model: "stt-rt-v5",
      language: "ja",
      sampleRate: 16000,
      _wsCtor: FakeWebSocket,
      _buildKeyterms: () => [],
    });
    const utterances = [];
    stt.on("utterance_end", (text) => utterances.push(text));

    socket.emit("open");
    assert.equal(JSON.parse(socket.sent[0]).api_key, "test-key");

    socket.emit("message", JSON.stringify({
      tokens: [
        { text: "abcdef", is_final: true, confidence: 0.9 },
        { text: "ghijkl", is_final: true, confidence: 0.9 },
      ],
    }));
    assert.deepEqual(utterances, ["abcdefghijkl"]);

    socket.emit("message", JSON.stringify({
      tokens: [
        { text: "zz", is_final: true, confidence: 0.9 },
        { text: "<end>", is_final: true, confidence: 0.9 },
      ],
    }));
    assert.deepEqual(utterances, ["abcdefghijkl", "zz"]);

    stt.close();
  } finally {
    delete require.cache[sonioxPath];
    if (previousSoniox) require.cache[sonioxPath] = previousSoniox;
    if (previousCap === undefined) delete process.env.STT_ACCUMULATED_MAX_CHARS;
    else process.env.STT_ACCUMULATED_MAX_CHARS = previousCap;
  }
});

function transcriptData(text, isFinal, speechFinal) {
  return {
    is_final: isFinal,
    speech_final: speechFinal,
    channel: {
      alternatives: [
        {
          transcript: text,
          confidence: 0.99,
        },
      ],
    },
  };
}
