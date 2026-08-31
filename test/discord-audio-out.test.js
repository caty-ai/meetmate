"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createAudioOut } = require("../src/transport-discord/audio-out");
const { monoTone, splitBufferRandomly } = require("./helpers/discord-audio-fixtures");

function createVoiceHarness() {
  const resources = [];
  const player = new EventEmitter();
  player.played = [];
  player.stopCalls = [];
  player.play = (resource) => {
    player.played.push(resource);
  };
  player.stop = (force) => {
    player.stopCalls.push(force);
  };

  const connection = {
    subscriptions: [],
    subscribe(target) {
      this.subscriptions.push(target);
    },
  };

  return {
    connection,
    player,
    voice: {
      NoSubscriberBehavior: { Play: "play" },
      StreamType: { Opus: "opus" },
      createAudioPlayer() {
        return player;
      },
      createAudioResource(stream, options) {
        const resource = { stream, options };
        resources.push(resource);
        return resource;
      },
    },
    resources,
  };
}

function createOpusScriptEncoder() {
  const OpusScript = require("opusscript");
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  return {
    implementation: "opusscript",
    createEncoder() {
      return {
        encode(frame) {
          return Buffer.from(encoder.encode(frame, 960));
        },
      };
    },
  };
}

test("audio-out uses the opusscript fallback path and emits player-paced opus resources", async () => {
  const harness = createVoiceHarness();
  const events = new EventEmitter();
  const codec = createOpusScriptEncoder();
  const audioOut = createAudioOut({
    sampleRate: 24000,
    connection: harness.connection,
    voice: harness.voice,
    eventSource: events,
    codecLoader() {
      return codec;
    },
  });

  const chunks = splitBufferRandomly(monoTone(24000, 440, 1), 0x2400);
  for (const chunk of chunks) {
    audioOut.onAudio(chunk, { outputEpoch: 0 });
  }

  assert.equal(audioOut.implementation, "opusscript");
  assert.equal(harness.connection.subscriptions.length, 1);
  assert.equal(harness.resources.length, 1);
  assert.equal(harness.resources[0].options.inputType, "opus");
  assert.equal(harness.resources[0].stream.readable, true);
  audioOut.finish();
  assert.equal(audioOut._test.getCurrentResource(), null);
});

test("audio-out keys purge off playback_cancelled and rejects late audio for cancelled epochs only", async () => {
  const harness = createVoiceHarness();
  const events = new EventEmitter();
  const audioOut = createAudioOut({
    sampleRate: 24000,
    connection: harness.connection,
    voice: harness.voice,
    eventSource: events,
    codecLoader: createOpusScriptEncoder,
  });

  audioOut.onAudio(monoTone(24000, 440, 0.08), { outputEpoch: 2 });
  events.emit("playback_cancelled", { outputEpoch: 2 });
  const resourcesAfterCancel = harness.resources.length;
  audioOut.onAudio(monoTone(24000, 440, 0.08), { outputEpoch: 2 });
  assert.equal(harness.resources.length, resourcesAfterCancel);
  audioOut.onAudio(monoTone(24000, 440, 0.08));
  assert.equal(harness.resources.length, resourcesAfterCancel);

  audioOut.onAudio(monoTone(24000, 440, 0.08), { outputEpoch: 3 });
  assert.equal(harness.player.stopCalls.at(-1), true);
  assert.equal(harness.resources.length, resourcesAfterCancel + 1);
});

test("audio-out does not infer flush from silent epoch deltas without playback_cancelled", async () => {
  const harness = createVoiceHarness();
  const audioOut = createAudioOut({
    sampleRate: 48000,
    connection: harness.connection,
    voice: harness.voice,
    codecLoader: createOpusScriptEncoder,
  });

  audioOut.onAudio(monoTone(48000, 440, 0.04), { outputEpoch: 0 });
  const resourcesBefore = harness.resources.length;
  audioOut.onAudio(monoTone(48000, 440, 0.04), { outputEpoch: 1 });

  assert.equal(harness.player.stopCalls.length, 0);
  assert.equal(harness.resources.length, resourcesBefore);
});

test("audio-out drops onAudio calls after teardown instead of re-buffering into a new stream", async () => {
  const harness = createVoiceHarness();
  const audioOut = createAudioOut({
    sampleRate: 24000,
    connection: harness.connection,
    voice: harness.voice,
    codecLoader: createOpusScriptEncoder,
  });

  audioOut.close();
  audioOut.onAudio(monoTone(24000, 440, 0.08), { outputEpoch: 0 });

  assert.equal(harness.player.stopCalls.at(-1), true);
  assert.equal(harness.resources.length, 0);
});
