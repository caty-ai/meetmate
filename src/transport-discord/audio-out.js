"use strict";

const { PassThrough } = require("node:stream");
const { FirInterpolator2, clamp16 } = require("./resampler");

const SEND_TAPS = 63;
const SEND_CUTOFF = 11000 / 48000;
const DISCORD_FRAME_BYTES = 3840;
const DISCORD_FRAME_SIZE = 960;

function defaultCodecLoader() {
  let nativeFailure = null;
  try {
    const { OpusEncoder } = require("@discordjs/opus");
    return {
      implementation: "native",
      createEncoder() {
        const encoder = new OpusEncoder(48000, 2);
        return {
          encode(frame) {
            return Buffer.from(encoder.encode(frame, DISCORD_FRAME_SIZE));
          },
        };
      },
    };
  } catch (error) {
    nativeFailure = error;
  }

  const OpusScript = require("opusscript");
  return {
    implementation: "opusscript",
    nativeFailure,
    createEncoder() {
      const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
      return {
        encode(frame) {
          return Buffer.from(encoder.encode(frame, DISCORD_FRAME_SIZE));
        },
      };
    },
  };
}

function loadVoiceAdapter() {
  return require("@discordjs/voice");
}

function createStereoFrameBuffer(sampleRate, resampler, carry, chunk) {
  const merged = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
  const usableBytes = merged.length - (merged.length % 2);
  const nextCarry = Buffer.from(merged.subarray(usableBytes));
  if (usableBytes === 0) {
    return { stereo: Buffer.alloc(0), carry: nextCarry };
  }

  const sampleCount = usableBytes / 2;
  const mono = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    mono[index] = merged.readInt16LE(index * 2);
  }

  const output = sampleRate === 24000 ? resampler.process(mono) : mono;
  const stereo = Buffer.alloc(output.length * 4);
  for (let index = 0; index < output.length; index += 1) {
    const sample = clamp16(Math.round(output[index]));
    stereo.writeInt16LE(sample, index * 4);
    stereo.writeInt16LE(sample, index * 4 + 2);
  }
  return { stereo, carry: nextCarry };
}

function createAudioOut(options = {}) {
  const sampleRate = options.sampleRate;
  if (sampleRate !== 24000 && sampleRate !== 48000) {
    throw new Error("Discord audio-out only supports 24000 or 48000 Hz PCM");
  }

  const codecLoader = options.codecLoader || defaultCodecLoader;
  const codec = codecLoader();
  const encoder = (options.createEncoder || (() => codec.createEncoder()))();
  const voice = options.voice || loadVoiceAdapter();
  const eventSource = options.eventSource;
  const connection = options.connection;
  if (!connection || typeof connection.subscribe !== "function") {
    throw new Error("Discord voice connection is required");
  }

  const player = options.player || voice.createAudioPlayer({
    behaviors: {
      noSubscriber: voice.NoSubscriberBehavior.Play,
    },
  });
  connection.subscribe(player);

  let currentStream = null;
  let currentResource = null;
  let closed = false;
  let pcmCarry = Buffer.alloc(0);
  let frameCarry = Buffer.alloc(0);
  let lastCancelledEpoch = -Infinity;
  const resampler = sampleRate === 24000 ? new FirInterpolator2(SEND_TAPS, SEND_CUTOFF) : null;

  function destroyCurrentStream() {
    if (currentStream) {
      currentStream.destroy();
      currentStream = null;
    }
    currentResource = null;
    pcmCarry = Buffer.alloc(0);
    frameCarry = Buffer.alloc(0);
  }

  function ensureWritableStream() {
    if (currentStream && !currentStream.destroyed) return currentStream;
    currentStream = new PassThrough();
    currentResource = voice.createAudioResource(currentStream, {
      inputType: voice.StreamType.Opus,
      inlineVolume: false,
    });
    player.play(currentResource);
    return currentStream;
  }

  function writeStereoChunk(stereo) {
    const writable = ensureWritableStream();
    const combined = frameCarry.length > 0 ? Buffer.concat([frameCarry, stereo]) : stereo;
    let offset = 0;
    while (offset + DISCORD_FRAME_BYTES <= combined.length) {
      const frame = combined.subarray(offset, offset + DISCORD_FRAME_BYTES);
      writable.write(encoder.encode(frame));
      offset += DISCORD_FRAME_BYTES;
    }
    frameCarry = Buffer.from(combined.subarray(offset));
  }

  function handleCancelled(event) {
    const cancelledEpoch = Number.isFinite(event?.outputEpoch) ? event.outputEpoch : -Infinity;
    if (cancelledEpoch > lastCancelledEpoch) {
      lastCancelledEpoch = cancelledEpoch;
    }
    try {
      player.stop(true);
    } catch {
      // Player stop must be best-effort and non-throwing at the boundary.
    }
    destroyCurrentStream();
  }

  const onPlaybackCancelled = (event) => handleCancelled(event);
  eventSource?.on?.("playback_cancelled", onPlaybackCancelled);

  function onAudio(buffer, metadata = {}) {
    if (closed || !Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length % 2 !== 0) return;
    if (
      Number.isFinite(lastCancelledEpoch)
      && (!Number.isFinite(metadata.outputEpoch) || metadata.outputEpoch <= lastCancelledEpoch)
    ) return;
    const transformed = createStereoFrameBuffer(sampleRate, resampler, pcmCarry, buffer);
    pcmCarry = transformed.carry;
    if (transformed.stereo.length > 0) {
      writeStereoChunk(transformed.stereo);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    eventSource?.removeListener?.("playback_cancelled", onPlaybackCancelled);
    try {
      player.stop(true);
    } catch {
      // Close must remain non-throwing for terminal teardown.
    }
    destroyCurrentStream();
  }

  return {
    implementation: codec.implementation,
    finish() {
      const stream = currentStream;
      currentStream = null;
      currentResource = null;
      stream?.end();
    },
    getPlayer() {
      return player;
    },
    onAudio,
    close,
    _test: {
      getPlayer() {
        return player;
      },
      getCurrentResource() {
        return currentResource;
      },
      getState() {
        return {
          closed,
          lastCancelledEpoch,
          pcmCarryBytes: pcmCarry.length,
          frameCarryBytes: frameCarry.length,
        };
      },
      handleCancelled,
    },
  };
}

module.exports = {
  createAudioOut,
  _test: {
    createStereoFrameBuffer,
    defaultCodecLoader,
  },
};
