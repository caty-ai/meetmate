const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const readiness = require("../src/settings/readiness");

test.afterEach(() => readiness.reset());

test("Soniox error_code 402 frame records runtime PAYMENT_REQUIRED", async () => {
  await withFreshSonioxModule({}, async ({ createSonioxSTT }) => {
    const instances = [];
    const FakeWebSocket = fakeWebSocketCtor(instances);
    const stt = createSonioxSTT("test-key", { _wsCtor: FakeWebSocket, _buildKeyterms: () => [] });
    stt.on("error", () => {});
    const socket = instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", JSON.stringify({ error_code: 402, error_type: "payment_required", error_message: "quota" }));
    assert.equal(readiness.inspect("soniox").code, "PAYMENT_REQUIRED");
    assert.equal(readiness.inspect("soniox").source, "runtime");
    const system = readiness.getReadiness().systems.find((entry) => entry.id === "soniox");
    assert.equal(system.ok, false);
    assert.equal(system.code, "PAYMENT_REQUIRED");
    stt.close();
  });
});

test("Soniox handshake rejection socket error records runtime PAYMENT_REQUIRED", async () => {
  await withFreshSonioxModule({}, async ({ createSonioxSTT }) => {
    const instances = [];
    const FakeWebSocket = fakeWebSocketCtor(instances);
    const stt = createSonioxSTT("test-key", { _wsCtor: FakeWebSocket, _buildKeyterms: () => [] });
    stt.on("error", () => {});
    instances[0].emit("error", new Error("Unexpected server response: 402"));
    assert.equal(readiness.inspect("soniox").code, "PAYMENT_REQUIRED");
    assert.equal(readiness.inspect("soniox").source, "runtime");
    const system = readiness.getReadiness().systems.find((entry) => entry.id === "soniox");
    assert.equal(system.ok, false);
    assert.equal(system.code, "PAYMENT_REQUIRED");
    stt.close();
  });
});

test("Soniox socket error logs scrub the configured API key", async () => {
  await withFreshSonioxModule({}, async ({ createSonioxSTT }) => {
    const apiKey = "key" + "_" + "abc12";
    const instances = [];
    const errors = [];
    const originalError = console.error;
    const FakeWebSocket = fakeWebSocketCtor(instances);
    const stt = createSonioxSTT(apiKey, { _wsCtor: FakeWebSocket, _buildKeyterms: () => [] });
    stt.on("error", () => {});
    console.error = (...args) => errors.push(args.join(" "));

    try {
      instances[0].emit("error", new Error(`socket rejected ${apiKey}`));
    } finally {
      console.error = originalError;
      stt.close();
    }

    assert.equal(errors.length, 1);
    assert.match(errors[0], /^❌  STT\(Soniox\) error:/);
    assert.match(errors[0], /\[REDACTED\]/);
    assert.equal(errors[0].includes(apiKey), false);
  });
});

test("Soniox STT sends keepalive frames on interval while open", async () => {
  await withFreshSonioxModule(
    { SONIOX_KEEPALIVE_INTERVAL_MS: "30" },
    async ({ createSonioxSTT }) => {
      const instances = [];
      const FakeWebSocket = fakeWebSocketCtor(instances);
      const stt = createSonioxSTT("test-key", {
        model: "stt-rt-v5",
        language: "ja",
        sampleRate: 16000,
        _wsCtor: FakeWebSocket,
        _buildKeyterms: () => [],
      });

      try {
        const socket = instances[0];
        socket.readyState = FakeWebSocket.OPEN;
        socket.emit("open");

        await delay(110);

        const keepalives = socket.sent.filter(isKeepAliveFrame);
        assert.ok(keepalives.length >= 2, `expected at least 2 keepalives, got ${keepalives.length}`);
      } finally {
        stt.close();
      }
    },
  );
});

test("Soniox STT reconnects after unexpected close and flushes buffered audio", async () => {
  await withFreshSonioxModule(
    { SONIOX_KEEPALIVE_INTERVAL_MS: "10000" },
    async ({ createSonioxSTT }) => {
      const instances = [];
      const FakeWebSocket = fakeWebSocketCtor(instances);
      const stt = createSonioxSTT("test-key", {
        model: "stt-rt-v5",
        language: "ja",
        sampleRate: 16000,
        _wsCtor: FakeWebSocket,
        _buildKeyterms: () => ["ケイティ"],
        _reconnectBaseDelayMs: 10,
      });
      let closeEvents = 0;
      const utterances = [];
      stt.on("close", () => {
        closeEvents += 1;
      });
      stt.on("utterance_end", (text) => {
        utterances.push(text);
      });

      try {
        const first = instances[0];
        first.readyState = FakeWebSocket.OPEN;
        first.emit("open");
        assert.equal(JSON.parse(first.sent[0]).context.terms[0], "ケイティ");

        first.emit("message", JSON.stringify({
          tokens: [{ text: "残り", is_final: true, confidence: 0.9 }],
        }));

        const buffered = Buffer.from([1, 2, 3, 4]);
        first.readyState = FakeWebSocket.CLOSED;
        stt.send(buffered);
        first.emit("close");

        await delay(30);
        assert.equal(instances.length, 2);
        assert.deepEqual(utterances, ["残り"]);
        assert.equal(closeEvents, 0);

        const second = instances[1];
        second.readyState = FakeWebSocket.OPEN;
        second.emit("open");

        assert.equal(JSON.parse(second.sent[0]).context.terms[0], "ケイティ");
        assert.deepEqual(second.sent[1], buffered);
        assert.equal(closeEvents, 0);
      } finally {
        stt.close();
      }
    },
  );
});

test("Soniox STT close prevents reconnect and emits one final close event", async () => {
  await withFreshSonioxModule(
    { SONIOX_KEEPALIVE_INTERVAL_MS: "10000" },
    async ({ createSonioxSTT }) => {
      const instances = [];
      const FakeWebSocket = fakeWebSocketCtor(instances);
      const stt = createSonioxSTT("test-key", {
        _wsCtor: FakeWebSocket,
        _buildKeyterms: () => [],
        _reconnectBaseDelayMs: 10,
      });
      let closeEvents = 0;
      stt.on("close", () => {
        closeEvents += 1;
      });

      const socket = instances[0];
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");

      stt.close();
      socket.emit("close");
      await delay(30);

      assert.equal(instances.length, 1);
      assert.equal(closeEvents, 1);
    },
  );
});

test("Soniox STT caps pending audio while disconnected", async () => {
  await withFreshSonioxModule(
    {
      SONIOX_KEEPALIVE_INTERVAL_MS: "10000",
      SONIOX_PENDING_MAX: "5",
    },
    async ({ createSonioxSTT }) => {
      const instances = [];
      const FakeWebSocket = fakeWebSocketCtor(instances);
      const stt = createSonioxSTT("test-key", {
        _wsCtor: FakeWebSocket,
        _buildKeyterms: () => [],
      });

      try {
        for (let i = 0; i < 8; i += 1) {
          stt.send(Buffer.from([i]));
        }

        const socket = instances[0];
        socket.readyState = FakeWebSocket.OPEN;
        socket.emit("open");

        const flushedAudio = socket.sent.filter(Buffer.isBuffer);
        assert.equal(flushedAudio.length, 5);
        assert.deepEqual(flushedAudio.map((buf) => buf[0]), [3, 4, 5, 6, 7]);
      } finally {
        stt.close();
      }
    },
  );
});

function fakeWebSocketCtor(instances) {
  return class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      instances.push(this);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }
  };
}

function isKeepAliveFrame(frame) {
  if (typeof frame !== "string") return false;
  try {
    return JSON.parse(frame).type === "keepalive";
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFreshSonioxModule(env, fn) {
  const previousEnv = setEnv(env);
  const sonioxPath = require.resolve("../src/stt-soniox");
  const previousSoniox = require.cache[sonioxPath];
  delete require.cache[sonioxPath];

  try {
    return await fn(require("../src/stt-soniox"));
  } finally {
    delete require.cache[sonioxPath];
    if (previousSoniox) require.cache[sonioxPath] = previousSoniox;
    restoreEnv(previousEnv);
  }
}

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return previous;
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
