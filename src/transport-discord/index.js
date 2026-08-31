"use strict";

const { createHttpRoutes } = require("./http-routes");
const { createDiscordSessionManager } = require("./discord-session");
const { CAPABILITIES, TRANSPORT } = require("./constants");

function createDiscordAdapter(options = {}) {
  const getDiscordConfig = options.getDiscordConfig || (() => null);
  const writePlainResponse = options.writePlainResponse;
  const sessionManager = createDiscordSessionManager({
    getDiscordConfig,
    ...options.sessionOptions,
  });
  const handleHttp = createHttpRoutes({
    writePlainResponse,
    joinSession: (body) => sessionManager.join(body),
    leaveSession: (body) => sessionManager.leave(body),
    getSessionStatus: () => sessionManager.getStatus(),
  });

  return {
    transport: TRANSPORT,
    prefixes: ["/api/discord"],
    capabilities: CAPABILITIES,
    handleHttp,
    shutdown() {
      return sessionManager.shutdown();
    },
  };
}

module.exports = {
  CAPABILITIES,
  TRANSPORT,
  createDiscordAdapter,
};
