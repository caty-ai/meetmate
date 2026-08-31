"use strict";

const TRANSPORT = "discord";
const CAPABILITIES = Object.freeze({
  chat: false,
  perSpeakerAudio: true,
  avatarStream: false,
  supportsFlush: true,
  echoesOwnOutput: false,
});

module.exports = {
  CAPABILITIES,
  TRANSPORT,
};
