"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");

const { createDiscordSessionManager } = require("../src/transport-discord/discord-session");

const GUILD_ID = "11111111111111111";
const CHANNEL_ID = "22222222222222222";
const BOT_ID = "44444444444444444";

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDiscordLifecycleHarness(options = {}) {
  const clients = [];
  const connections = [];
  const pipelines = [];
  const reconnectCalls = [];
  const coordinatorState = { lease: null, releaseCalls: 0, sequence: 0 };
  let sessionSequence = 0;

  const voice = {
    AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
    VoiceConnectionStatus: { Ready: "ready", Destroyed: "destroyed", Disconnected: "disconnected" },
  };
  const guild = { id: GUILD_ID, voiceAdapterCreator: {}, channels: { cache: new Map() } };
  const channel = { id: CHANNEL_ID, members: new Map() };
  guild.channels.cache.set(CHANNEL_ID, channel);

  const coordinator = {
    tryAcquire(transport, sessionId) {
      coordinatorState.sequence += 1;
      if (options.allowSupersede === true) {
        coordinatorState.lease = Object.freeze({ transport, sessionId, sequence: coordinatorState.sequence });
        return coordinatorState.lease;
      }
      if (coordinatorState.lease) return null;
      coordinatorState.lease = Object.freeze({ transport, sessionId, sequence: coordinatorState.sequence });
      return coordinatorState.lease;
    },
    release(lease) {
      if (lease === coordinatorState.lease) {
        coordinatorState.releaseCalls += 1;
        coordinatorState.lease = null;
      }
    },
    active() {
      return coordinatorState.lease
        ? { transport: coordinatorState.lease.transport, sessionId: coordinatorState.lease.sessionId }
        : null;
    },
  };

  const manager = createDiscordSessionManager({
    getDiscordConfig: () => ({ token: "discord-token", guildAllowlist: [GUILD_ID] }),
    getPipelineConfig: () => ({
      systemPrompt: "system",
      greeting: "hello",
      fishKey: "fish-key",
      llm: { model: "test", provider: "openclaw" },
      tts: { sampleRate: 24_000, referenceId: "voice", latency: "balanced", speed: 1 },
      slack: {
        enabled: false,
        channelId: "",
        statusChannelId: "",
        summaryChannelId: "",
        notifyTarget: "dm",
        dmUserId: "",
        labels: {},
      },
      summary: { prompt: "summary" },
    }),
    resolveAgentProfile: () => ({
      agentId: "caty",
      name: "Caty",
      displayName: "Caty",
      model: "test",
      voiceId: "voice",
      wakeWords: ["ケイティ"],
    }),
    sessionCoordinator: coordinator,
    loadVoiceModule: () => voice,
    loadDiscordModule: () => ({
      GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
      Client: function MockClient() {},
    }),
    createClient() {
      const client = new EventEmitter();
      client.user = { id: BOT_ID };
      client.guilds = { cache: new Map([[GUILD_ID, guild]]) };
      client.login = async () => {};
      client.destroyCalls = 0;
      client.destroy = () => { client.destroyCalls += 1; };
      clients.push(client);
      return client;
    },
    resolveVoiceTarget: async () => ({ guild, channel, receiver: null }),
    joinVoice() {
      const connection = new EventEmitter();
      connection.receiver = {};
      connection.destroyCalls = 0;
      connection.destroy = () => { connection.destroyCalls += 1; };
      connections.push(connection);
      return connection;
    },
    createAudioOut() {
      const player = new EventEmitter();
      player.state = { status: "idle" };
      return {
        onAudio() {},
        finish() {
          const playing = { status: "playing", resource: { playbackDuration: 1_000 } };
          const idle = { status: "idle" };
          player.state = playing;
          player.emit("stateChange", idle, playing);
          player.state = idle;
          player.emit("stateChange", playing, idle);
        },
        getPlayer: () => player,
        close() {},
      };
    },
    createAudioIn: () => ({ subscribeUser() {}, unsubscribeUser() {}, close() {} }),
    createPipeline() {
      const pipeline = new EventEmitter();
      pipeline.sendAudio = () => {};
      pipeline.closeCalls = 0;
      pipeline.close = () => { pipeline.closeCalls += 1; };
      pipelines.push(pipeline);
      return pipeline;
    },
    warmUpGatewaySession: () => Promise.resolve(),
    createNotifier: () => ({
      postStatus: () => Promise.resolve(),
      startElapsedUpdates() {},
      stopElapsedUpdates() {},
      postSummary: () => Promise.resolve(),
    }),
    summarizeConversation: async () => ({ summary: [], decisions: [], todos: [] }),
    synthesize: async (_text, synthOptions) => {
      synthOptions.onAudio(Buffer.alloc(48_000));
    },
    waitForReconnect(connection, timeoutMs) {
      reconnectCalls.push({ connection, timeoutMs });
      return options.reconnectResult || Promise.resolve();
    },
    gatewayTracker: {
      trackGatewaySession() {},
      untrackGatewaySession() {},
    },
    now: () => 1_725_000_000_000 + sessionSequence,
    randomBytes: () => {
      sessionSequence += 1;
      return Buffer.from([0, 0, sessionSequence]);
    },
  });

  return { manager, clients, connections, pipelines, reconnectCalls, coordinatorState };
}

test("Discord superseded owner events cannot terminalize the current session", async () => {
  const harness = createDiscordLifecycleHarness({ allowSupersede: true });
  const firstJoin = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(firstJoin.status, 200);
  const superseded = harness.manager._test.getActiveSession();

  const secondJoin = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(secondJoin.status, 200);
  const current = harness.manager._test.getActiveSession();
  assert.notEqual(current.id, superseded.id);
  assert.equal(current.lifecycle.state, "in-progress");

  harness.connections[0].emit("stateChange", { status: "ready" }, { status: "destroyed" });
  harness.clients[0].emit("invalidated");
  await flushEvents();

  assert.equal(superseded.lifecycle.state, "in-progress");
  assert.equal(current.lifecycle.state, "in-progress");
  assert.equal(harness.manager._test.getActiveSession(), current);
  assert.equal(harness.coordinatorState.releaseCalls, 0);
  assert.equal(harness.connections[1].destroyCalls, 0);
  await harness.manager.leave();
});

test("Discord successful voice reconnect preserves the active non-terminal session", async () => {
  const harness = createDiscordLifecycleHarness();
  const joined = await harness.manager.join({ guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(joined.status, 200);
  const active = harness.manager._test.getActiveSession();

  harness.connections[0].emit("stateChange", { status: "ready" }, { status: "disconnected" });
  await flushEvents();

  assert.deepEqual(harness.reconnectCalls, [{ connection: harness.connections[0], timeoutMs: 500 }]);
  assert.equal(active.lifecycle.state, "in-progress");
  assert.equal(harness.manager._test.getActiveSession(), active);
  assert.equal(harness.coordinatorState.releaseCalls, 0);
  assert.equal(harness.connections[0].destroyCalls, 0);
  await harness.manager.leave();
});

test("server dispatch positively falls through non-Discord HTTP traffic to Meet unchanged", () => {
  const root = path.join(__dirname, "..");
  const probe = runAttendeeFallthroughProbe(root);
  assert.equal(probe.status, 0, probe.stderr);
  const match = probe.stdout.match(/ATTENDEE_FALLTHROUGH=(\{.*\})/);
  assert.ok(match, probe.stdout);
  assert.deepEqual(JSON.parse(match[1]), {
    meetCalls: 1,
    discordCalls: 0,
    request: {
      method: "POST",
      url: "/join-meeting?source=regression",
      marker: "attendee-positive-path",
    },
    response: {
      status: 202,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Meet-Path": "unchanged" },
      body: "meet-fallthrough-ok",
    },
  });
});

function runAttendeeFallthroughProbe(root) {
  const src = path.join(root, "src");
  const paths = {
    server: path.join(src, "server.js"),
    meet: path.join(src, "transport-meet", "meet-routes.js"),
    discord: path.join(src, "transport-discord", "index.js"),
    bootstrap: path.join(src, "settings", "bootstrap.js"),
    store: path.join(src, "settings", "store.js"),
    resolver: path.join(src, "settings", "resolver.js"),
    migration: path.join(src, "settings", "class2-migration.js"),
    settingsRoutes: path.join(src, "settings", "routes.js"),
    calibrate: path.join(src, "wake-calibrate", "calibrate-routes.js"),
    config: path.join(src, "config.js"),
    profile: path.join(src, "agent-profile.js"),
  };
  const script = String.raw`
    const { EventEmitter } = require("node:events");
    const Module = require("node:module");
    const realHttp = require("node:http");
    const paths = ${JSON.stringify(paths)};
    const entry = (filename, exports) => ({ id: filename, filename, loaded: true, exports });
    let meetCalls = 0;
    let discordCalls = 0;
    let observedRequest = null;

    require.cache[paths.meet] = entry(paths.meet, {
      init: async () => {},
      handleHttp(req, res) {
        meetCalls += 1;
        observedRequest = { method: req.method, url: req.url, marker: req.marker };
        res.writeHead(202, { "Content-Type": "text/plain; charset=utf-8", "X-Meet-Path": "unchanged" });
        res.end("meet-fallthrough-ok");
      },
      handleWsConnection() {},
      startReadinessBootstrap() {},
      writePlainResponse(res, status, body) { res.writeHead(status, {}); res.end(body); },
    });
    require.cache[paths.discord] = entry(paths.discord, {
      createDiscordAdapter() {
        return {
          transport: "discord",
          prefixes: ["/api/discord"],
          capabilities: {},
          handleHttp(_req, res) { discordCalls += 1; res.writeHead(299, {}); res.end("discord"); },
        };
      },
    });
    require.cache[paths.bootstrap] = entry(paths.bootstrap, { captureStartup: () => ({ configPath: "config.json" }) });
    require.cache[paths.store] = entry(paths.store, {
      readConfigState: () => ({ exists: false, valid: false, parsed: null, revision: "test", fingerprint: "missing" }),
    });
    require.cache[paths.resolver] = entry(paths.resolver, {
      getEffectiveValue: (key) => key === "server_port" ? 5005 : null,
      initializeRuntime() {},
      getStatus: () => ({ setupMode: true, meetingReady: false, issues: [] }),
      setServerPort() {},
    });
    require.cache[paths.migration] = entry(paths.migration, { warnLegacyClass2() {} });
    require.cache[paths.settingsRoutes] = entry(paths.settingsRoutes, { createSettingsHandler: () => async () => false });
    require.cache[paths.calibrate] = entry(paths.calibrate, { handleCalibrate() {}, handleCalibrateWs() {} });
    require.cache[paths.config] = entry(paths.config, { loadConfig: () => ({ agent: { id: "test" } }) });
    require.cache[paths.profile] = entry(paths.profile, { resolveAgentProfile: () => ({ agentId: "caty" }) });

    class FakeWebSocketServer extends EventEmitter { handleUpgrade() {} }
    const fakeHttp = { ...realHttp };
    fakeHttp.createServer = (handler) => {
      const server = new EventEmitter();
      server.address = () => ({ port: 5005 });
      server.listen = (_port, callback) => {
        callback();
        setImmediate(async () => {
          const response = { status: null, headers: null, body: "",
            writeHead(status, headers) { this.status = status; this.headers = headers; },
            end(chunk = "") { this.body += String(chunk); },
          };
          await handler({
            method: "POST",
            url: "/join-meeting?source=regression",
            marker: "attendee-positive-path",
            headers: { "x-regression": "preserve" },
            socket: { remoteAddress: "127.0.0.1" },
          }, response);
          process.stdout.write("ATTENDEE_FALLTHROUGH=" + JSON.stringify({
            meetCalls, discordCalls, request: observedRequest, response,
          }) + "\n");
          process.exit(0);
        });
        return server;
      };
      return server;
    };
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "node:http" || request === "http") return fakeHttp;
      if (request === "ws") return { WebSocketServer: FakeWebSocketServer };
      return originalLoad.call(this, request, parent, isMain);
    };
    require(paths.server);
  `;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}
