"use strict";

const { FirDecimator, clamp16 } = require("./resampler");
const { TRANSPORT } = require("./constants");

const RECEIVE_TAPS = 63;
const RECEIVE_CUTOFF = 7000 / 48000;
const DISCORD_FRAME_SIZE = 960;
const MAX_CONSECUTIVE_DECODE_FAILURES = 5;

function defaultCodecLoader() {
  let nativeFailure = null;
  try {
    const { OpusEncoder } = require("@discordjs/opus");
    return {
      implementation: "native",
      createDecoder() {
        const decoder = new OpusEncoder(48000, 2);
        return {
          decode(packet) {
            return Buffer.from(decoder.decode(packet, DISCORD_FRAME_SIZE));
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
    createDecoder() {
      const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
      return {
        decode(packet) {
          return Buffer.from(decoder.decode(packet, DISCORD_FRAME_SIZE));
        },
      };
    },
  };
}

function buildSpeaker(speaker) {
  return {
    platform: TRANSPORT,
    id: String(speaker.id),
    displayName: speaker.displayName,
    isBot: speaker.isBot === true,
  };
}

function createReceiveState(createDecoder) {
  return {
    carry: Buffer.alloc(0),
    decoder: createDecoder(),
    decimator: new FirDecimator(3, RECEIVE_TAPS, RECEIVE_CUTOFF),
    consecutiveDecodeFailures: 0,
    decodeWarningLogged: false,
  };
}

function processDecodedChunk(state, chunk) {
  const merged = state.carry.length > 0 ? Buffer.concat([state.carry, chunk]) : chunk;
  const usableBytes = merged.length - (merged.length % 4);
  state.carry = Buffer.from(merged.subarray(usableBytes));
  if (usableBytes === 0) return null;

  const frameCount = usableBytes / 4;
  const mono = new Float64Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    mono[index] = (merged.readInt16LE(index * 4) + merged.readInt16LE(index * 4 + 2)) / 2;
  }

  const decimated = state.decimator.process(mono);
  if (decimated.length === 0) return null;

  const output = Buffer.alloc(decimated.length * 2);
  for (let index = 0; index < decimated.length; index += 1) {
    output.writeInt16LE(clamp16(Math.round(decimated[index])), index * 2);
  }
  return output;
}

function createSubscriptionFactory(loadVoiceModule = () => require("@discordjs/voice")) {
  return function subscribe(receiver, userId) {
    const voice = loadVoiceModule();
    return receiver.subscribe(userId, { end: { behavior: voice.EndBehaviorType.Manual } });
  };
}

function createAudioIn(options = {}) {
  const sendAudio = options.sendAudio;
  if (typeof sendAudio !== "function") {
    throw new Error("sendAudio callback is required");
  }

  const codecLoader = options.codecLoader || defaultCodecLoader;
  const codec = codecLoader();
  const createDecoder = options.createDecoder || (() => codec.createDecoder());
  const subscribeStream = options.subscribeStream || createSubscriptionFactory(options.loadVoiceModule);
  const subscriptions = new Map();
  const states = new Map();
  let closed = false;

  function ensureState(userId) {
    let state = states.get(userId);
    if (!state) {
      state = createReceiveState(createDecoder);
      states.set(userId, state);
    }
    return state;
  }

  function pushDecodedPcm(userId, pcm, speaker) {
    if (closed || !Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) return;
    const output = processDecodedChunk(ensureState(userId), pcm);
    if (output && output.length > 0 && output.length % 2 === 0) {
      sendAudio(output, { speaker: buildSpeaker(speaker) });
    }
  }

  function ingestOpusPacket(userId, packet, speaker) {
    if (closed || !Buffer.isBuffer(packet) || packet.length === 0) return;
    const state = ensureState(userId);
    let decoded;
    try {
      decoded = state.decoder.decode(packet);
      state.consecutiveDecodeFailures = 0;
    } catch (error) {
      state.consecutiveDecodeFailures += 1;
      if (!state.decodeWarningLogged) {
        state.decodeWarningLogged = true;
        console.warn(`Discord Opus decode failed for user ${userId}; dropping packet: ${error.message || error}`);
      }
      if (state.consecutiveDecodeFailures >= MAX_CONSECUTIVE_DECODE_FAILURES) {
        unsubscribeUser(userId);
      }
      return;
    }
    if (!Buffer.isBuffer(decoded) || decoded.length === 0 || decoded.length % 2 !== 0) return;
    pushDecodedPcm(userId, decoded, speaker);
  }

  function unsubscribeUser(userId) {
    const subscription = subscriptions.get(userId);
    subscriptions.delete(userId);
    states.delete(userId);
    try {
      subscription?.destroy?.();
    } catch {
      // Discord receive cleanup is best-effort.
    }
  }

  function subscribeUser(receiver, speaker) {
    if (closed) return null;
    if (!receiver || !speaker || !speaker.id || speaker.isBot === true) return null;
    if (subscriptions.has(speaker.id)) return subscriptions.get(speaker.id);

    const stream = subscribeStream(receiver, speaker.id);
    const onData = (packet) => {
      try {
        ingestOpusPacket(speaker.id, packet, speaker);
      } catch (error) {
        console.error(`Discord audio receive failed for user ${speaker.id}: ${error.message || error}`);
      }
    };
    const onClose = () => unsubscribeUser(speaker.id);
    stream.on("data", onData);
    stream.once("close", onClose);
    stream.once("error", onClose);
    subscriptions.set(speaker.id, stream);
    ensureState(speaker.id);
    return stream;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const userId of subscriptions.keys()) {
      unsubscribeUser(userId);
    }
    states.clear();
  }

  return {
    implementation: codec.implementation,
    subscribeUser,
    unsubscribeUser,
    ingestOpusPacket,
    close,
    _test: {
      pushDecodedPcm,
      processDecodedChunk,
      getTrackedUserIds() {
        return [...states.keys()];
      },
    },
  };
}

module.exports = {
  MAX_CONSECUTIVE_DECODE_FAILURES,
  createAudioIn,
  _test: {
    createReceiveState,
    defaultCodecLoader,
    processDecodedChunk,
  },
};
