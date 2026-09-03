"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createAudioIn } = require("../src/transport-discord/audio-in");
const { goertzelDb, naiveDecimate, splitBufferRandomly, stereoTone48k } = require("./helpers/discord-audio-fixtures");

function createOpusScriptCodec() {
  const OpusScript = require("opusscript");
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  return {
    createDecoder() {
      const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
      return {
        decode(packet) {
          return Buffer.from(decoder.decode(packet, 960));
        },
      };
    },
    encode(frame) {
      return Buffer.from(encoder.encode(frame, 960));
    },
  };
}

function encodeStereoPackets(stereoBuffer, codec) {
  const packets = [];
  for (let offset = 0; offset + 3840 <= stereoBuffer.length; offset += 3840) {
    packets.push(codec.encode(stereoBuffer.subarray(offset, offset + 3840)));
  }
  return packets;
}

test("audio-in keeps per-user receive state isolated across interleaved packets using the opusscript fallback", async () => {
  const codec = createOpusScriptCodec();
  const userA = stereoTone48k(440, 3);
  const userB = stereoTone48k(1000, 3);
  const packetsA = encodeStereoPackets(userA, codec);
  const packetsB = encodeStereoPackets(userB, codec);
  const outputs = { a: [], b: [] };

  const audioIn = createAudioIn({
    sendAudio(buffer, meta) {
      outputs[meta.speaker.id].push(buffer);
    },
    codecLoader() {
      return {
        implementation: "opusscript",
        createDecoder: codec.createDecoder,
      };
    },
  });

  const speakerA = { id: "a", displayName: "A", isBot: false };
  const speakerB = { id: "b", displayName: "B", isBot: false };
  for (let index = 0; index < packetsA.length; index += 1) {
    audioIn.ingestOpusPacket("a", packetsA[index], speakerA);
    audioIn.ingestOpusPacket("b", packetsB[index], speakerB);
  }

  const interleavedA = Buffer.concat(outputs.a);
  const interleavedB = Buffer.concat(outputs.b);

  const sequentialA = [];
  const sequentialB = [];
  const controlA = createAudioIn({
    sendAudio(buffer) {
      sequentialA.push(buffer);
    },
    codecLoader() {
      return {
        implementation: "opusscript",
        createDecoder: codec.createDecoder,
      };
    },
  });
  const controlB = createAudioIn({
    sendAudio(buffer) {
      sequentialB.push(buffer);
    },
    codecLoader() {
      return {
        implementation: "opusscript",
        createDecoder: codec.createDecoder,
      };
    },
  });
  for (const packet of packetsA) controlA.ingestOpusPacket("a", packet, speakerA);
  for (const packet of packetsB) controlB.ingestOpusPacket("b", packet, speakerB);

  assert.equal(audioIn.implementation, "opusscript");
  assert.deepEqual(interleavedA, Buffer.concat(sequentialA));
  assert.deepEqual(interleavedB, Buffer.concat(sequentialB));
});

test("audio-in treats 3-byte DTX packets as normal packet flow and preserves even-byte output", async () => {
  const output = [];
  const audioIn = createAudioIn({
    sendAudio(buffer) {
      output.push(buffer);
    },
    codecLoader() {
      return {
        implementation: "stub-dtx",
        createDecoder() {
          return {
            decode(packet) {
              if (packet.length === 3) {
                return Buffer.alloc(3840);
              }
              return Buffer.alloc(0);
            },
          };
        },
      };
    },
  });

  audioIn.ingestOpusPacket("speaker-1", Buffer.from([0x00, 0x01, 0x02]), {
    id: "speaker-1",
    displayName: "Speaker",
    isBot: false,
  });

  assert.equal(output.length > 0, true);
  assert.equal(output.every((chunk) => chunk.length % 2 === 0), true);
});

test("audio-in drops odd-length decoded PCM instead of forwarding malformed boundary audio", async () => {
  const output = [];
  const audioIn = createAudioIn({
    sendAudio(buffer) {
      output.push(buffer);
    },
    codecLoader() {
      return {
        implementation: "stub-odd",
        createDecoder() {
          return {
            decode() {
              return Buffer.alloc(5);
            },
          };
        },
      };
    },
  });

  audioIn.ingestOpusPacket("speaker-1", Buffer.from([0x01]), {
    id: "speaker-1",
    displayName: "Speaker",
    isBot: false,
  });

  assert.deepEqual(output, []);
});

test("audio-in resampler suppresses aliasing compared with naive 3:1 decimation", async () => {
  const tone = stereoTone48k(13000, 3);
  const chunks = splitBufferRandomly(tone, 0x115);
  const output = [];
  const audioIn = createAudioIn({
    sendAudio(buffer) {
      output.push(buffer);
    },
    codecLoader() {
      return {
        implementation: "pcm-fixture",
        createDecoder() {
          return {
            decode(packet) {
              return packet;
            },
          };
        },
      };
    },
  });

  for (const chunk of chunks) {
    audioIn._test.pushDecodedPcm("speaker-1", chunk, {
      id: "speaker-1",
      displayName: "Speaker",
      isBot: false,
    });
  }

  const filtered = Buffer.concat(output);
  const naive = naiveDecimate(tone, 3);
  const filteredAlias = goertzelDb(filtered, 16000, 3000);
  const naiveAlias = goertzelDb(naive, 16000, 3000);

  assert.equal(filtered.length > 0, true);
  assert.ok(filteredAlias <= naiveAlias - 20, `expected filtered alias (${filteredAlias}) <= naive alias (${naiveAlias}) - 20 dB`);
});

test("audio-in keeps duplicate subscriptions stable and retires only after five consecutive decode failures", () => {
  const stream = new EventEmitter();
  stream.destroyCalls = 0;
  stream.destroy = () => { stream.destroyCalls += 1; };
  let subscribeCalls = 0;
  const releasedSpeakers = [];
  const audioIn = createAudioIn({
    sendAudio() {},
    releaseSpeaker(userId) {
      releasedSpeakers.push(userId);
    },
    subscribeStream() {
      subscribeCalls += 1;
      return stream;
    },
    codecLoader() {
      return {
        implementation: "decode-threshold",
        createDecoder() {
          return {
            decode(packet) {
              if (packet[0] === 0) throw new Error("bad opus");
              return Buffer.alloc(3840);
            },
          };
        },
      };
    },
  });
  const speaker = { id: 202, displayName: "Speaker", isBot: false };

  assert.equal(audioIn.subscribeUser({}, speaker), stream);
  assert.equal(audioIn.subscribeUser({}, speaker), stream);
  assert.equal(subscribeCalls, 1);

  for (let index = 0; index < 4; index += 1) stream.emit("data", Buffer.from([0]));
  assert.deepEqual(audioIn._test.getTrackedUserIds(), [202]);
  assert.deepEqual(releasedSpeakers, []);
  stream.emit("data", Buffer.from([1]));
  assert.deepEqual(releasedSpeakers, []);
  for (let index = 0; index < 4; index += 1) stream.emit("data", Buffer.from([0]));
  assert.deepEqual(audioIn._test.getTrackedUserIds(), [202]);
  assert.deepEqual(releasedSpeakers, []);

  stream.emit("data", Buffer.from([0]));
  assert.deepEqual(audioIn._test.getTrackedUserIds(), []);
  assert.equal(stream.destroyCalls, 1);
  assert.deepEqual(releasedSpeakers, ["202"]);
});

test("audio-in stream error and close retire a speaker only once", () => {
  const stream = new EventEmitter();
  stream.destroy = () => {};
  const releasedSpeakers = [];
  const audioIn = createAudioIn({
    sendAudio() {},
    releaseSpeaker(userId) {
      releasedSpeakers.push(userId);
    },
    subscribeStream() {
      return stream;
    },
    codecLoader() {
      return {
        implementation: "stream-retire",
        createDecoder() {
          return { decode: () => Buffer.alloc(3840) };
        },
      };
    },
  });

  audioIn.subscribeUser({}, { id: "speaker-1", displayName: "Speaker", isBot: false });
  stream.emit("error", new Error("receive failed"));
  stream.emit("close");

  assert.deepEqual(audioIn._test.getTrackedUserIds(), []);
  assert.deepEqual(releasedSpeakers, ["speaker-1"]);
});

test("audio-in explicit unsubscribe and close do not release pipeline speakers", () => {
  const streams = new Map();
  const releasedSpeakers = [];
  const audioIn = createAudioIn({
    sendAudio() {},
    releaseSpeaker(userId) {
      releasedSpeakers.push(userId);
    },
    subscribeStream(_receiver, userId) {
      const stream = new EventEmitter();
      stream.destroy = () => {};
      streams.set(userId, stream);
      return stream;
    },
    codecLoader() {
      return {
        implementation: "explicit-cleanup",
        createDecoder() {
          return { decode: () => Buffer.alloc(3840) };
        },
      };
    },
  });

  audioIn.subscribeUser({}, { id: "speaker-1", displayName: "One", isBot: false });
  audioIn.subscribeUser({}, { id: "speaker-2", displayName: "Two", isBot: false });
  audioIn.unsubscribeUser("speaker-1");
  audioIn.close();

  assert.equal(streams.size, 2);
  assert.deepEqual(releasedSpeakers, []);
});

test("audio-in decode retirement keeps working without a releaseSpeaker option", () => {
  const stream = new EventEmitter();
  stream.destroyCalls = 0;
  stream.destroy = () => { stream.destroyCalls += 1; };
  const audioIn = createAudioIn({
    sendAudio() {},
    subscribeStream() {
      return stream;
    },
    codecLoader() {
      return {
        implementation: "no-release-hook",
        createDecoder() {
          return {
            decode() {
              throw new Error("bad opus");
            },
          };
        },
      };
    },
  });

  audioIn.subscribeUser({}, { id: "speaker-1", displayName: "Speaker", isBot: false });
  assert.doesNotThrow(() => {
    for (let index = 0; index < 5; index += 1) stream.emit("data", Buffer.from([0]));
  });

  assert.deepEqual(audioIn._test.getTrackedUserIds(), []);
  assert.equal(stream.destroyCalls, 1);
});

test("audio-in contains releaseSpeaker failures and continues receiving other users", () => {
  const streams = new Map();
  const audioIn = createAudioIn({
    sendAudio() {},
    releaseSpeaker() {
      throw new Error("pipeline cleanup failed");
    },
    subscribeStream(_receiver, userId) {
      const stream = new EventEmitter();
      stream.destroy = () => {};
      streams.set(userId, stream);
      return stream;
    },
    codecLoader() {
      return {
        implementation: "throwing-release-hook",
        createDecoder() {
          return {
            decode(packet) {
              if (packet[0] === 0) throw new Error("bad opus");
              return Buffer.alloc(3840);
            },
          };
        },
      };
    },
  });

  audioIn.subscribeUser({}, { id: "speaker-1", displayName: "One", isBot: false });
  assert.doesNotThrow(() => {
    for (let index = 0; index < 5; index += 1) streams.get("speaker-1").emit("data", Buffer.from([0]));
  });

  const nextStream = audioIn.subscribeUser({}, { id: "speaker-2", displayName: "Two", isBot: false });
  assert.equal(nextStream, streams.get("speaker-2"));
  assert.deepEqual(audioIn._test.getTrackedUserIds(), ["speaker-2"]);
});

test("audio-in scrubs decode and receive failure logs", () => {
  const botToken = ["bot-", "abc123"].join("");
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const warnings = [];
  const errors = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    const decodeFailure = createAudioIn({
      sendAudio() {},
      getSecret: () => botToken,
      codecLoader() {
        return {
          implementation: "decode-failure",
          createDecoder() {
            return { decode() { throw new Error(["token", "=", botToken].join("")); } };
          },
        };
      },
    });
    decodeFailure.ingestOpusPacket("speaker-1", Buffer.from([0]), {
      id: "speaker-1",
      displayName: "One",
      isBot: false,
    });

    const stream = new EventEmitter();
    stream.destroy = () => {};
    const receiveFailure = createAudioIn({
      sendAudio() { throw new Error(["token", "=", botToken].join("")); },
      getSecret: () => botToken,
      subscribeStream() { return stream; },
      codecLoader() {
        return {
          implementation: "receive-failure",
          createDecoder() { return { decode: () => Buffer.alloc(3840) }; },
        };
      },
    });
    receiveFailure.subscribeUser({}, { id: "speaker-2", displayName: "Two", isBot: false });
    stream.emit("data", Buffer.from([1]));

    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    for (const line of [...warnings, ...errors]) {
      assert.equal(line.includes(botToken), false, line);
      assert.equal(line.includes("token=[REDACTED]"), true, line);
    }
  } finally {
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  }
});
