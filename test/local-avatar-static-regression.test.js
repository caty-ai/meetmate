const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const Module = require("node:module");
const util = require("node:util");
const { EventEmitter } = require("node:events");
const { stringify } = require("node:querystring");
const { Readable } = require("node:stream");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "local-avatar-timeline.json"), "utf8"));
const FIXED_SESSION_ID = "00000000-0000-4000-8000-000000000173";

function avatarPng(seed, dataBytes = 0) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(1, 8);
  ihdr.writeUInt32BE(1, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  ihdr[20] = seed;
  const chunks = [signature, ihdr];
  if (dataBytes > 0) {
    const idat = Buffer.alloc(12 + dataBytes);
    idat.writeUInt32BE(dataBytes, 0);
    idat.write("IDAT", 4, "ascii");
    chunks.push(idat);
  }
  chunks.push(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  return Buffer.concat(chunks);
}

const BUNDLED_TEST_AVATAR = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function staticSettings(overrides = {}) {
  const base = {
    agent: { id: "caty", displayName: "Caty", wakeWords: ["ケイティ"] },
    avatar: { experiment: "" },
    stt: { provider: "soniox", sonioxApiKey: "soniox-test-key" },
    tts: { apiKey: "fish-test-key", voiceId: "fish-test-voice" },
    attendee: { apiKey: "test-key" },
    server: { ngrokDomain: "meetmate.example" },
    slack: { notifications: { enabled: false } },
    llm: { provider: "openclaw", model: "test" },
  };
  return {
    ...base,
    ...overrides,
    agent: { ...base.agent, ...(overrides.agent || {}) },
    avatar: { ...base.avatar, ...(overrides.avatar || {}) },
  };
}

function unavailableNgrokHttpGet() {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  queueMicrotask(() => request.emit("error", Object.assign(new Error("ngrok unavailable in test"), { code: "ECONNREFUSED" })));
  return request;
}

test("static join payload and Fish bot_output bytes match the frozen fixture", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join();
    assert.equal(join.statusCode, 200);

    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.ok(createRequest, "Attendee create request was not made");
    assert.deepEqual(JSON.parse(createRequest.body), fixture.staticAttendee.normalized);
    assert.equal(createRequest.body, fixture.staticAttendee.serialized);
    assert.equal(Buffer.byteLength(createRequest.body), fixture.staticAttendee.utf8ByteLength);
    assert.equal(Buffer.from(createRequest.body).toString("hex"), fixture.staticAttendee.serializedHex);
    assert.equal(createRequest.options.headers["Content-Length"], fixture.staticAttendee.utf8ByteLength);
    assert.deepEqual(Object.keys(JSON.parse(createRequest.body)).sort(), ["bot_image", "bot_name", "meeting_url", "websocket_settings"]);
    assert.equal("voice_agent_settings" in JSON.parse(createRequest.body), false);

    const client = harness.connect();
    const pcm = Buffer.from(fixture.pcm.base64, "base64");
    const chunks = splitPcmBySamples(pcm, fixture.pcm.chunkings[0]);
    for (const chunk of chunks) harness.pipelines[0].onAudio(chunk);

    assert.equal(client.sent.length, fixture.pcm.botOutputSendCount);
    assert.deepEqual(client.sent, fixture.pcm.botOutputSerialized);
    assert.equal(client.sent.reduce((total, serialized) => {
      const payload = JSON.parse(serialized);
      assert.equal(payload.trigger, "realtime_audio.bot_output");
      assert.equal(payload.data.sample_rate, fixture.pcm.sampleRate);
      return total + Buffer.from(payload.data.chunk, "base64").length;
    }, 0), fixture.pcm.byteCount);
    assert.deepEqual(Buffer.concat(client.sent.map((serialized) => Buffer.from(JSON.parse(serialized).data.chunk, "base64"))), pcm);

    assertStaticIsolation(harness.isolation);
  });
});

test("initialized static payload pins bot_image and omits voice_agent_settings", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.init();
    const join = await harness.join();
    assert.equal(join.statusCode, 200);

    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.deepEqual(JSON.parse(createRequest.body), fixture.staticAttendeeWithImage.normalized);
    assert.equal(createRequest.body, fixture.staticAttendeeWithImage.serialized);
    assert.equal(Buffer.byteLength(createRequest.body), fixture.staticAttendeeWithImage.utf8ByteLength);
    assert.equal("voice_agent_settings" in JSON.parse(createRequest.body), false);
    assertStaticIsolation(harness.isolation);
  });
});

test("static avatar re-reads uploaded bytes and DELETE falls back to bundled bytes without a second init", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.init();
    const uploaded = avatarPng(1);
    const assets = path.join(harness.home, "assets");
    fs.mkdirSync(path.join(assets, "avatar-frames"), { recursive: true });
    fs.writeFileSync(path.join(assets, "avatar.png"), uploaded, { mode: 0o600 });
    fs.writeFileSync(path.join(assets, ".avatar-source"), "uploaded\n", { mode: 0o600 });

    assert.equal((await harness.join()).statusCode, 200);
    let createRequest = harness.httpsRequests.filter((request) => request.options.path === "/api/v1/bots").at(-1);
    assert.deepEqual(Buffer.from(JSON.parse(createRequest.body).bot_image.data, "base64"), uploaded);
    assert.equal((await harness.leave()).statusCode, 200);

    assert.equal((await harness.deleteAvatar()).statusCode, 200);
    assert.equal((await harness.join()).statusCode, 200);
    createRequest = harness.httpsRequests.filter((request) => request.options.path === "/api/v1/bots").at(-1);
    assert.deepEqual(Buffer.from(JSON.parse(createRequest.body).bot_image.data, "base64"), BUNDLED_TEST_AVATAR);
    assert.equal(harness.initCalls, 1);
  });
});

test("URL cache is join-visible, then DELETE stays bundled for the running process", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const cached = avatarPng(2);
    const assets = path.join(harness.home, "assets");
    fs.mkdirSync(path.join(assets, "avatar-frames"), { recursive: true });
    fs.writeFileSync(path.join(assets, "avatar.png"), cached, { mode: 0o600 });
    fs.writeFileSync(path.join(assets, ".avatar-source"), "url-cache\n", { mode: 0o600 });
    await harness.init();

    assert.equal((await harness.join()).statusCode, 200);
    let createRequest = harness.httpsRequests.filter((request) => request.options.path === "/api/v1/bots").at(-1);
    assert.deepEqual(Buffer.from(JSON.parse(createRequest.body).bot_image.data, "base64"), cached);
    assert.equal((await harness.leave()).statusCode, 200);
    assert.equal((await harness.deleteAvatar()).statusCode, 200);
    assert.equal((await harness.join()).statusCode, 200);
    createRequest = harness.httpsRequests.filter((request) => request.options.path === "/api/v1/bots").at(-1);
    assert.deepEqual(Buffer.from(JSON.parse(createRequest.body).bot_image.data, "base64"), BUNDLED_TEST_AVATAR);
    assert.equal(harness.initCalls, 1);
  }, { settingsParsed: staticSettings({ agent: { avatarUrl: "https://avatar.example/cache.png" } }) });
});

test("boot URL cache fill installs valid bytes and provenance before the next join", { concurrency: false }, async () => {
  const downloaded = Buffer.from(BUNDLED_TEST_AVATAR);
  let releaseDownload;
  const avatarHttpsGet = (_url, callback) => {
    const request = new EventEmitter();
    releaseDownload = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", downloaded);
        response.emit("end");
      });
    };
    return request;
  };
  await withMeetRoutes(async (harness) => {
    await harness.init();
    assert.equal(typeof releaseDownload, "function");
    releaseDownload();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const assets = path.join(harness.home, "assets");
    assert.deepEqual(fs.readFileSync(path.join(assets, "avatar.png")), downloaded);
    assert.equal(fs.readFileSync(path.join(assets, ".avatar-source"), "utf8"), "url-cache\n");
    assert.equal(harness.consoleOutput.some((line) => line.includes("Bot avatar downloaded and cached")), true);
    assert.equal((await harness.join()).statusCode, 200);
    const createRequest = harness.httpsRequests.filter((request) => request.options.path === "/api/v1/bots").at(-1);
    assert.deepEqual(Buffer.from(JSON.parse(createRequest.body).bot_image.data, "base64"), downloaded);
    const inspected = await harness.inspectAvatar();
    assert.equal(inspected.statusCode, 200);
    assert.equal(JSON.parse(inspected.body).static.source, "url-cache");
    assert.equal(harness.initCalls, 1);
  }, {
    settingsParsed: staticSettings({ agent: { avatarUrl: "https://avatar.example/happy.png" } }),
    avatarHttpsGet,
  });
});

test("an in-flight boot URL fetch cannot clobber a settings upload or its uploaded provenance", { concurrency: false }, async () => {
  let releaseDownload;
  const avatarHttpsGet = (_url, callback) => {
    const request = new EventEmitter();
    releaseDownload = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", avatarPng(3));
        response.emit("end");
      });
    };
    return request;
  };
  await withMeetRoutes(async (harness) => {
    await harness.init();
    assert.equal(typeof releaseDownload, "function");
    const uploaded = avatarPng(4);
    const upload = await harness.uploadAvatar(uploaded);
    assert.equal(upload.statusCode, 200, upload.body.toString());
    releaseDownload();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const inspected = await harness.inspectAvatar();
    assert.equal(inspected.statusCode, 200);
    assert.equal(JSON.parse(inspected.body).static.source, "uploaded");
    assert.equal((await harness.join()).statusCode, 200);
    const createRequest = harness.httpsRequests.filter((request) => request.options.path === "/api/v1/bots").at(-1);
    assert.deepEqual(Buffer.from(JSON.parse(createRequest.body).bot_image.data, "base64"), uploaded);
    assert.equal(harness.initCalls, 1);
  }, {
    settingsParsed: staticSettings({ agent: { avatarUrl: "https://avatar.example/race.png" } }),
    avatarHttpsGet,
  });
});

test("upload then DELETE vetoes a held boot URL cache fill for the rest of the process", { concurrency: false }, async () => {
  let releaseDownload;
  const avatarHttpsGet = (_url, callback) => {
    const request = new EventEmitter();
    releaseDownload = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", avatarPng(5));
        response.emit("end");
      });
    };
    return request;
  };
  await withMeetRoutes(async (harness) => {
    await harness.init();
    assert.equal(typeof releaseDownload, "function");
    assert.equal((await harness.uploadAvatar(avatarPng(6))).statusCode, 200);
    assert.equal((await harness.deleteAvatar()).statusCode, 200);
    releaseDownload();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fs.existsSync(path.join(harness.home, "assets", "avatar.png")), false);
    assert.equal(fs.existsSync(path.join(harness.home, "assets", ".avatar-source")), false);
    const inspected = await harness.inspectAvatar();
    assert.equal(JSON.parse(inspected.body).static.source, "bundled");
    assert.equal((await harness.join()).statusCode, 200);
    const createRequest = harness.httpsRequests.filter((request) => request.options.path === "/api/v1/bots").at(-1);
    assert.deepEqual(Buffer.from(JSON.parse(createRequest.body).bot_image.data, "base64"), BUNDLED_TEST_AVATAR);
    assert.equal(harness.initCalls, 1);
  }, {
    settingsParsed: staticSettings({ agent: { avatarUrl: "https://avatar.example/delete-race.png" } }),
    avatarHttpsGet,
  });
});

test("boot URL cache fill respects the 64 MiB managed avatar total cap", { concurrency: false }, async () => {
  const remote = avatarPng(7, 5 * 1024 * 1024 - 57);
  assert.equal(remote.length, 5 * 1024 * 1024);
  let releaseDownload;
  const avatarHttpsGet = (_url, callback) => {
    const request = new EventEmitter();
    releaseDownload = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", remote);
        response.emit("end");
      });
    };
    return request;
  };
  await withMeetRoutes(async (harness) => {
    const frames = path.join(harness.home, "assets", "avatar-frames");
    fs.mkdirSync(frames, { recursive: true });
    for (const name of ["idle", "talk1", "talk2", "talk3", "blink", "talk_blink"]) {
      const target = path.join(frames, `${name}.png`);
      fs.writeFileSync(target, Buffer.alloc(1));
      fs.truncateSync(target, 10 * 1024 * 1024);
    }
    await harness.init();
    assert.equal(typeof releaseDownload, "function");
    releaseDownload();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fs.existsSync(path.join(harness.home, "assets", "avatar.png")), false);
    assert.equal(fs.existsSync(path.join(harness.home, "assets", ".avatar-source")), false);
    assert.equal(JSON.parse((await harness.inspectAvatar()).body).static.source, "bundled");
    assert.equal(harness.initCalls, 1);
  }, {
    settingsParsed: staticSettings({ agent: { avatarUrl: "https://avatar.example/total-cap.png" } }),
    avatarHttpsGet,
  });
});

test("avatarExperiment uses configured default, explicit empty overrides it, and duplicate keys fail closed", { concurrency: false }, async () => {
  const configured = staticSettings({ avatar: { experiment: "hybrid-local-frames" } });
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({}, { host: "meetmate.example", "x-forwarded-proto": "https" });
    assert.equal(join.statusCode, 200);
    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.equal(new URL(JSON.parse(createRequest.body).voice_agent_settings.url).pathname, "/local-avatar/frames.html");
  }, { settingsParsed: configured });
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: "" });
    assert.equal(join.statusCode, 200);
    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.equal(Object.hasOwn(JSON.parse(createRequest.body), "voice_agent_settings"), false);
  }, { settingsParsed: configured });
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: ["", "hybrid-local-l0"] });
    assert.equal(join.statusCode, 400);
    assert.equal(join.text, "avatarExperiment が不正です。");
    assert.equal(harness.httpsRequests.some((request) => request.options.path === "/api/v1/bots"), false);
  }, { settingsParsed: configured });
});

test("Attendee success logging excludes an echoed WebSocket token", { concurrency: false }, async () => {
  const sentinel = "WS-SHARED-TOKEN-ECHO-29-7f9c2e";
  await withMeetRoutes(async (harness) => {
    const join = await harness.join();
    assert.equal(join.statusCode, 200);

    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    assert.ok(createRequest, "Attendee create request was not made");
    const echoed = JSON.parse(createRequest.responseBody);
    assert.equal(new URL(echoed.websocket_settings.audio.url).searchParams.get("token"), sentinel);
    assert.equal(
      harness.consoleOutput.some((line) => line.includes(sentinel)),
      false,
      harness.consoleOutput.join("\n"),
    );
    assert.equal(harness.consoleOutput.some((line) => /Bot起動成功:.*statusCode.*201.*botId.*bot-echo-29/.test(line)), true);
  }, {
    env: { WS_SHARED_TOKEN: sentinel },
    attendeeCreateResponse: (requestBody) => {
      const payload = JSON.parse(requestBody);
      return JSON.stringify({ id: "bot-echo-29", websocket_settings: payload.websocket_settings });
    },
  });
});

test("Slack notifier honors default-enabled and saved-false settings", { concurrency: false }, async () => {
  const cases = [
    { notifications: { target: "dm", dmUserId: "UDEFAULT29" }, expected: true },
    { notifications: { enabled: false, target: "dm", dmUserId: "UDISABLED29" }, expected: false },
  ];

  for (const { notifications, expected } of cases) {
    await withMeetRoutes(async (harness) => {
      assert.equal((await harness.join()).statusCode, 200);
      assert.equal(harness.slackNotifiers.length, 1);
      assert.equal(harness.slackNotifiers[0].options.enabled, expected);
      assert.equal(harness.slackNotifiers[0].enabled, expected);
    }, {
      env: { SLACK_NOTIFY_ENABLED: undefined },
      settingsParsed: {
        agent: { id: "caty", displayName: "Caty", wakeWords: ["ケイティ"] },
        stt: { provider: "soniox", sonioxApiKey: "soniox-test-key" },
        tts: { apiKey: "fish-test-key", voiceId: "fish-test-voice" },
        attendee: { apiKey: "test-key" },
        server: { ngrokDomain: "meetmate.example" },
        slack: { botToken: "xoxb-test!fixture", notifications },
        llm: { provider: "openclaw", model: "test" },
      },
    });
  }
});

test("hybrid-local-l0 adds only voice_agent_settings to the initialized payload", { concurrency: false }, async () => {
  let staticBody;
  await withMeetRoutes(async (harness) => {
    await harness.init();
    assert.equal((await harness.join()).statusCode, 200);
    staticBody = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots").body;
  });

  await withMeetRoutes(async (harness) => {
    await harness.init();
    const join = await harness.join(
      { avatarExperiment: "hybrid-local-l0" },
      { host: "meetmate.example", "x-forwarded-proto": "https" }
    );
    assert.equal(join.statusCode, 200);
    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    const livePayload = JSON.parse(createRequest.body);
    const url = new URL(livePayload.voice_agent_settings.url);
    const capability = new URLSearchParams(url.hash.slice(1)).get("cap");

    assert.equal(url.origin, "https://meetmate.example");
    assert.equal(url.pathname, "/local-avatar/index.html");
    assert.match(url.searchParams.get("v"), /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(Buffer.from(capability, "base64url").length, 32);

    delete livePayload.voice_agent_settings;
    assert.equal(JSON.stringify(livePayload), staticBody);
    assert.deepEqual(livePayload.websocket_settings, fixture.staticAttendeeWithImage.normalized.websocket_settings);
  });
});

test("unknown avatar experiment fails before creating an Attendee bot", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join({ avatarExperiment: "unknown" });
    assert.equal(join.statusCode, 400);
    assert.equal(harness.httpsRequests.some((request) => request.options.path === "/api/v1/bots"), false);
  });
});

test("hybrid-local-l0 snapshots configured rig background settings into the connect response", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join(
      { avatarExperiment: "hybrid-local-l0" },
      { host: "meetmate.example", "x-forwarded-proto": "https" }
    );
    assert.equal(join.statusCode, 200);
    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    const launch = new URL(JSON.parse(createRequest.body).voice_agent_settings.url);
    const capability = new URLSearchParams(launch.hash.slice(1)).get("cap");
    harness.connect();
    const visual = harness.pipelines[0].session.localAvatarSession;

    assert.deepEqual(
      visual.connect({ capability, origin: launch.origin }).background,
      { mode: "chroma", color: "#123456" },
    );
  }, {
    settingsParsed: staticSettings({
      avatar: {
        experiment: "",
        rigBackgroundMode: "chroma",
        rigBackgroundColor: "#123456",
      },
    }),
  });
});

test("live page state failures cannot interrupt or duplicate realtime audio", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    const join = await harness.join(
      { avatarExperiment: "hybrid-local-l0" },
      { host: "meetmate.example", "x-forwarded-proto": "https" }
    );
    assert.equal(join.statusCode, 200);
    const createRequest = harness.httpsRequests.find((request) => request.options.path === "/api/v1/bots");
    const launch = new URL(JSON.parse(createRequest.body).voice_agent_settings.url);
    const capability = new URLSearchParams(launch.hash.slice(1)).get("cap");
    const client = harness.connect();
    const visual = harness.pipelines[0].session.localAvatarSession;
    const connected = visual.connect({ capability, origin: launch.origin });

    harness.pipelines[0].onAudio(Buffer.from([1, 0]), {
      outputEpoch: 0,
      firstSampleIndex: 0,
      sampleRate: fixture.pcm.sampleRate,
    });
    assert.equal(client.sent.length, 1);
    assert.equal(JSON.parse(client.sent[0]).trigger, "realtime_audio.bot_output");
    const marker = visual.readState({
      capability,
      origin: launch.origin,
      generation: connected.generation,
      afterSequence: connected.sequence,
    });
    assert.equal(marker.kind, "marker");
    assert.equal(marker.sampleIndex, 0);

    const publishMarker = visual.publishMarker;
    visual.publishMarker = () => { throw new Error("visual-only failure"); };
    harness.pipelines[0].onAudio(Buffer.from([2, 0]), {
      outputEpoch: 0,
      firstSampleIndex: 1,
      sampleRate: fixture.pcm.sampleRate,
    });
    visual.publishMarker = publishMarker;
    assert.equal(client.sent.length, 2);
    assert.deepEqual(client.sent.map((item) => JSON.parse(item).data.chunk), ["AQA=", "AgA="]);

    const sequenceBeforeFailedAudio = visual.snapshot().sequence;
    client.send = () => { throw new Error("audio send failure"); };
    harness.pipelines[0].onAudio(Buffer.from([3, 0]), {
      outputEpoch: 0,
      firstSampleIndex: 2,
      sampleRate: fixture.pcm.sampleRate,
    });
    assert.equal(visual.snapshot().sequence, sequenceBeforeFailedAudio);

    harness.pipelines[0].emit("playback_cancelled", {
      outputEpoch: 0,
      reason: "external_abort",
      monotonicTime: 1,
    });
    const cancelled = visual.readState({
      capability,
      origin: launch.origin,
      generation: connected.generation,
      afterSequence: marker.sequence,
    });
    assert.equal(cancelled.kind, "cancel");

    assert.equal((await harness.leave()).statusCode, 200);
    assert.equal(visual.verifyCapability(capability), false);
  });
});

test("static-isolation detector rejects an in-memory live socket violation", () => {
  const simulated = emptyIsolationEvidence();
  simulated.socketCreations.push("simulated local-avatar socket");
  assert.throws(() => assertStaticIsolation(simulated), /local-avatar socket/);
  simulated.socketCreations.length = 0;
  assert.doesNotThrow(() => assertStaticIsolation(simulated));
});

test("mixed input, echo gate, reconnect, and delayed cleanup stay fixed", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.join();
    const firstClient = harness.connect();
    const firstPipeline = harness.pipelines[0];
    const mixed = Buffer.from([9, 8, 7, 6]);
    const mixedMessage = JSON.stringify({ trigger: "realtime_audio.mixed", data: { chunk: mixed.toString("base64") } });

    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.deepEqual(firstPipeline.receivedInput, [mixed]);

    firstPipeline.turnState.isAgentSpeaking = true;
    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.equal(firstPipeline.receivedInput.length, 1);
    assert.equal(firstPipeline.turnState.droppedEchoFrames, 1);

    firstPipeline.turnState.isAgentSpeaking = false;
    firstPipeline.turnState.inputCooldownUntil = Date.now() + 1000;
    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.equal(firstPipeline.receivedInput.length, 1);
    assert.equal(firstPipeline.turnState.droppedEchoFrames, 2);

    firstPipeline.turnState.inputCooldownUntil = 0;
    firstClient.emit("message", Buffer.from(mixedMessage));
    assert.deepEqual(firstPipeline.receivedInput, [mixed, mixed]);
    assert.equal(firstPipeline.turnState.droppedEchoFrames, 0);

    firstClient.emit("close");
    assert.equal(firstPipeline.closeCalls, 1);
    const secondClient = harness.connect();
    assert.equal(secondClient.closed.length, 0);
    assert.equal(harness.pipelines.length, 2);

    await delay(30);
    assert.equal((await harness.activeSession()).body.active, true, "reconnect must cancel delayed cleanup");

    secondClient.emit("close");
    assert.equal(harness.pipelines[1].closeCalls, 1);
    assert.equal((await harness.activeSession()).body.active, true, "cleanup must remain delayed");
    await delay(30);
    assert.equal((await harness.activeSession()).body.active, false);
  });
});

test("exit, leave, and reconnect rejection retain current lifecycle behavior", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.join();
    const client = harness.connect();

    harness.pipelines[0].emit("exit_requested", {
      sessionId: FIXED_SESSION_ID,
      trigger: "voice_command",
      text: "退出します",
    });
    assert.deepEqual(client.closed, [{ code: 1000, reason: "Exit requested by user" }]);
    assert.equal(harness.httpsRequests.some((request) => request.options.path === "/api/v1/bots/bot-static-173/leave"), true);

    const rejectedReconnect = harness.connect();
    assert.deepEqual(rejectedReconnect.closed, [{ code: 1000, reason: "Session is leaving" }]);
    assert.equal(harness.pipelines.length, 1);

    const leave = await harness.leave();
    assert.equal(leave.statusCode, 200);
    assert.match(leave.text, /退出リクエスト送信/);
    assert.equal((await harness.activeSession()).body.active, false);
  });
});

test("static path forwards greeting and turn configuration without avatar capability", { concurrency: false }, async () => {
  await withMeetRoutes(async (harness) => {
    await harness.join({ greeting: "固定された挨拶", prompt: "固定された指示" });
    harness.connect();

    const handlerConfig = harness.pipelineConfigCalls.at(-1);
    assert.equal(handlerConfig.overrides.greeting, "固定された挨拶");
    assert.equal(handlerConfig.overrides.prompt, "固定された指示");
    assert.equal(handlerConfig.overrides.wakeMode, "off");
    assert.equal(harness.pipelines[0].session.config.greeting, "固定された挨拶");
    assert.equal(Object.keys(harness.pipelines[0].options).some((key) => /avatar/i.test(key)), false);
    assertStaticIsolation(harness.isolation);
  });
});

function assertStaticIsolation(evidence) {
  assert.deepEqual(evidence.moduleLoads, [], `unexpected local-avatar module: ${evidence.moduleLoads.join(", ")}`);
  assert.deepEqual(evidence.capabilities, [], `unexpected local-avatar capability: ${evidence.capabilities.join(", ")}`);
  assert.deepEqual(evidence.pageReads, [], `unexpected local-avatar page read: ${evidence.pageReads.join(", ")}`);
  assert.deepEqual(evidence.socketCreations, [], `unexpected local-avatar socket: ${evidence.socketCreations.join(", ")}`);
  assert.deepEqual(evidence.timerCreations, [], `unexpected local-avatar timer: ${evidence.timerCreations.join(", ")}`);
  assert.deepEqual(evidence.networkRequests, [], `unexpected local-avatar network: ${evidence.networkRequests.join(", ")}`);
}

function emptyIsolationEvidence() {
  return {
    moduleLoads: [],
    capabilities: [],
    pageReads: [],
    socketCreations: [],
    timerCreations: [],
    networkRequests: [],
  };
}

async function withMeetRoutes(fn, options = {}) {
  const settingsResolver = require("../src/settings/resolver");
  const readiness = require("../src/settings/readiness");
  const routesPath = require.resolve("../src/transport-meet/meet-routes");
  const settingsRoutesPath = require.resolve("../src/settings/routes");
  const avatarAssetsPath = require.resolve("../src/settings/avatar-assets");
  const src = path.join(__dirname, "..", "src");
  const mockPaths = [
    "config.js",
    "pipeline.js",
    "gateway-warmup.js",
    "session-events.js",
    "slack-notifier.js",
    "summarizer.js",
    "agent-profile.js",
    "attendee-chat.js",
    "gateway-events.js",
    "metrics.js",
    "delegation-results.js",
    "gateway-session-tracker.js",
    "ui-routes.js",
    "paths.js",
  ].map((file) => path.join(src, file));
  const localAvatarPath = path.join(src, "transport-meet", "local-avatar-session.js");
  const cachePaths = [routesPath, settingsRoutesPath, avatarAssetsPath, localAvatarPath, ...mockPaths];
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-static-avatar-"));
  const previousCache = new Map(cachePaths.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of cachePaths) delete require.cache[require.resolve(file)];

  const restoreEnv = setEnv({
    ATTENDEE_API_KEY: "test-key",
    FISH_AUDIO_API_KEY: "fish-test-key",
    SESSION_GRACE_CLOSE_MS: "20",
    SLACK_NOTIFY_ENABLED: "false",
    SUMMARY_ENABLED: "false",
    JOIN_SHARED_TOKEN: undefined,
    WS_SHARED_TOKEN: undefined,
    ...(options.env || {}),
  });
  settingsResolver.resetRuntimeForTest();
  readiness.reset();
  settingsResolver.initializeRuntime({
    state: {
      exists: true,
      valid: true,
      revision: "a".repeat(64),
      fingerprint: "local-avatar-regression",
      parsed: options.settingsParsed || staticSettings(),
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({}),
      dotenvSeeds: Object.freeze({}),
      resolvedHome: tempHome,
      configPath: path.join(tempHome, "config.json"),
      connection: Object.freeze({
        provider: "openclaw",
        openclawUrl: "http://gateway.invalid",
        openclawToken: "test",
        openaiApiKey: "",
      }),
    }),
    serverPort: 5005,
  });
  for (const system of readiness.gateSystems()) {
    readiness.setProbeObservation(system, { ok: true, code: "CONNECTED" });
  }
  const isolation = emptyIsolationEvidence();
  const httpsRequests = [];
  const pipelines = [];
  const pipelineConfigCalls = [];
  const slackNotifiers = [];
  const consoleOutput = [];
  const originalHttpsRequest = https.request;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsGet = https.get;
  const originalFetch = global.fetch;
  const originalRandomUUID = crypto.randomUUID;
  const originalRandomBytes = crypto.randomBytes;
  const originalLoad = Module._load;
  const originalReadFile = fs.readFile;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };

  const avatarAssets = require(avatarAssetsPath);
  installMock(avatarAssetsPath, {
    ...avatarAssets,
    readBundledAvatar: () => Buffer.from(BUNDLED_TEST_AVATAR),
  });

  class GuardedWebSocket {
    static OPEN = 1;
    constructor(url) {
      isolation.socketCreations.push(String(url));
    }
  }

  installMock(path.join(src, "config.js"), {
    SAMPLE_RATE: 16_000,
    TTS_SAMPLE_RATE: fixture.pcm.sampleRate,
    TTS_PROVIDER: "fish-audio",
    loadConfig: () => ({
      attendee: { apiKey: "test-key" },
      server: { ngrokDomain: "meetmate.example" },
      slack: { notifications: {} },
    }),
    validateSttProviderApiKey: () => true,
    resolveMessages: () => ({ delegation: {}, slack: {}, prompts: { summary: "summary" } }),
    getPipelineConfig: (overrides = {}) => {
      pipelineConfigCalls.push({ overrides: { ...overrides } });
      return {
        stt: { provider: "soniox", sampleRate: 16_000 },
        llm: { provider: "openclaw", model: "test", gateway: { url: "http://gateway.invalid", token: "test" } },
        tts: { sampleRate: fixture.pcm.sampleRate },
        gatewayEvents: { enabled: false },
        greeting: overrides.greeting || "",
      };
    },
  });
  installMock(path.join(src, "pipeline.js"), {
    createPipeline: (session, turnState, onAudio, config, options) => {
      const pipeline = new EventEmitter();
      Object.assign(pipeline, {
        session,
        turnState,
        onAudio,
        config,
        options,
        receivedInput: [],
        closeCalls: 0,
        sendAudio(buffer) { this.receivedInput.push(Buffer.from(buffer)); },
        close() { this.closeCalls += 1; },
        getDelegationResults: () => [],
      });
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  installMock(path.join(src, "gateway-warmup.js"), {
    warmUpGatewaySession: () => {},
  });
  installMock(path.join(src, "session-events.js"), { SessionLifecycle: FakeLifecycle });
  installMock(path.join(src, "slack-notifier.js"), {
    SlackNotifier: class CapturingSlackNotifier extends FakeSlackNotifier {
      constructor(...args) {
        super(...args);
        slackNotifiers.push(this);
      }
    },
  });
  installMock(path.join(src, "summarizer.js"), { summarizeConversation: async () => "" });
  installMock(path.join(src, "agent-profile.js"), {
    resolveAgentProfile: () => ({
      agentId: "caty",
      name: "Caty",
      displayName: "AI",
      attendeeApiKey: "test-key",
      wakeWords: ["ケイティ"],
    }),
    AgentNotFoundError: class AgentNotFoundError extends Error {},
  });
  installMock(path.join(src, "attendee-chat.js"), { sendAttendeeChatMessage: async () => true });
  installMock(path.join(src, "gateway-events.js"), {});
  installMock(path.join(src, "metrics.js"), { recordEvent: () => {} });
  installMock(path.join(src, "delegation-results.js"), { buildDelegationResultsSection: () => "" });
  installMock(path.join(src, "gateway-session-tracker.js"), {
    createGatewaySessionTracker: () => ({
      trackGatewaySession: () => {},
      untrackGatewaySession: () => false,
      findGatewayRoute: () => null,
    }),
  });
  installMock(path.join(src, "ui-routes.js"), {
    serveLocalAvatar: (_req, _res, url) => {
      if (/local-avatar/i.test(url.pathname)) isolation.pageReads.push(url.pathname);
      return false;
    },
    servePublicAsset: (_req, _res, url) => {
      if (/local-avatar/i.test(url.pathname)) isolation.pageReads.push(url.pathname);
      return false;
    },
    sendMetricsSummary: async () => false,
  });
  installMock(path.join(src, "paths.js"), {
    logsDir: () => "/tmp/meetmate-m0-logs",
    avatarCachePath: () => path.join(tempHome, "assets", "avatar.png"),
    bundledAssetPath: (name) => `/tmp/${name}`,
    bundledPublicDir: () => "/tmp/meetmate-m0-public",
  });

  Module._load = function guardedLoad(request, parent, isMain) {
    if (/local-avatar/i.test(String(request))) isolation.moduleLoads.push(String(request));
    if (request === "ws") return { WebSocket: GuardedWebSocket };
    if (request === "@deepgram/sdk") {
      return {
        createClient: () => ({ agent: () => new EventEmitter() }),
        AgentEvents: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  fs.readFile = function guardedReadFile(filename, ...args) {
    if (/local-avatar/i.test(String(filename))) isolation.pageReads.push(String(filename));
    return originalReadFile.call(this, filename, ...args);
  };
  global.setTimeout = function guardedTimeout(callback, ms, ...args) {
    const stack = new Error().stack || "";
    if (/src\/.*local-avatar/i.test(stack)) isolation.timerCreations.push(stack);
    return originalSetTimeout(callback, ms, ...args);
  };
  global.setInterval = function guardedInterval(callback, ms, ...args) {
    const stack = new Error().stack || "";
    if (/src\/.*local-avatar/i.test(stack)) isolation.timerCreations.push(stack);
    return originalSetInterval(callback, ms, ...args);
  };
  https.request = (requestOptions, callback) => {
    const record = { options: requestOptions, body: "" };
    httpsRequests.push(record);
    if (requestOptions.hostname !== "app.attendee.dev") isolation.networkRequests.push(`${requestOptions.hostname}${requestOptions.path}`);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = (chunk) => { record.body += String(chunk); };
    request.end = () => {
      let responseBody = "{}";
      if (requestOptions.path === "/api/v1/bots") {
        const payload = JSON.parse(record.body);
        for (const key of Object.keys(payload)) {
          if (/avatar|voice_agent/i.test(key)) isolation.capabilities.push(key);
        }
        responseBody = typeof options.attendeeCreateResponse === "function"
          ? options.attendeeCreateResponse(record.body)
          : '{"id":"bot-static-173"}';
      }
      record.responseBody = responseBody;
      const response = new EventEmitter();
      response.statusCode = requestOptions.path === "/api/v1/bots" ? 201 : 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", responseBody);
        response.emit("end");
      });
    };
    return request;
  };
  http.request = (...args) => {
    isolation.networkRequests.push(String(args[0]));
    return originalHttpRequest(...args);
  };
  http.get = (...args) => {
    isolation.networkRequests.push(String(args[0]));
    return originalHttpGet(...args);
  };
  https.get = (...args) => {
    isolation.networkRequests.push(String(args[0]));
    return options.avatarHttpsGet ? options.avatarHttpsGet(...args) : originalHttpsGet(...args);
  };
  global.fetch = async (...args) => {
    isolation.networkRequests.push(String(args[0]));
    throw new Error("unexpected static-path fetch");
  };
  crypto.randomUUID = () => FIXED_SESSION_ID;
  crypto.randomBytes = (size) => Buffer.alloc(size, 0x5a);
  console.log = (...args) => { consoleOutput.push(util.format(...args)); };
  console.warn = (...args) => { consoleOutput.push(util.format(...args)); };
  console.error = (...args) => { consoleOutput.push(util.format(...args)); };

  let routes;
  const clients = [];
  let initCalls = 0;
  try {
    routes = require(routesPath);
    const { createSettingsHandler } = require(settingsRoutesPath);
    routes._test.configureReadinessForTest({
      fetchFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
      httpGet: unavailableNgrokHttpGet,
      requestFn: async () => { throw Object.assign(new Error("network unavailable in test"), { code: "ENETUNREACH" }); },
    });
    const settingsHandler = createSettingsHandler({
      port: 5005,
      readinessController: { configure() {}, async probeGateSystems() {} },
      avatar: { minIntervalMs: 0 },
    });
    const harness = {
      home: tempHome,
      isolation,
      httpsRequests,
      pipelines,
      pipelineConfigCalls,
      slackNotifiers,
      consoleOutput,
      init() {
        initCalls += 1;
        return routes.init({ detectNgrok: false, loadAvatar: true });
      },
      get initCalls() { return initCalls; },
      async join(overrides = {}, headers = {}) {
        return requestHttp(routes, "POST", "/join-meeting", {
          meetingUrl: fixture.staticAttendee.normalized.meeting_url,
          wsUrl: "wss://meetmate.example/realtime?mode=static",
          conversationMode: "one_to_one",
          ...overrides,
        }, headers);
      },
      connect() {
        const client = new FakeClient();
        clients.push(client);
        routes.handleWsConnection(client, {
          url: `/realtime?sid=${FIXED_SESSION_ID}`,
          socket: { remoteAddress: "127.0.0.1" },
        });
        return client;
      },
      leave() {
        return requestHttp(routes, "POST", "/leave-meeting", { sessionId: FIXED_SESSION_ID });
      },
      activeSession() {
        return requestHttp(routes, "GET", "/active-session");
      },
      deleteAvatar() {
        return requestSettings(settingsHandler, "DELETE", "/api/settings/avatar/static");
      },
      inspectAvatar() {
        return requestSettings(settingsHandler, "GET", "/api/settings/avatar");
      },
      uploadAvatar(bytes) {
        return requestSettingsAvatarUpload(settingsHandler, bytes);
      },
    };
    await fn(harness);
  } finally {
    for (const client of clients) {
      client.emit("close");
      client.removeAllListeners();
    }
    await new Promise((resolve) => originalSetTimeout(resolve, 25));
    https.request = originalHttpsRequest;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.get = originalHttpsGet;
    global.fetch = originalFetch;
    crypto.randomUUID = originalRandomUUID;
    crypto.randomBytes = originalRandomBytes;
    Module._load = originalLoad;
    fs.readFile = originalReadFile;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    Object.assign(console, originalConsole);
    restoreEnv();
    readiness.reset();
    settingsResolver.resetRuntimeForTest();
    fs.rmSync(tempHome, { recursive: true, force: true });
    for (const file of cachePaths) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const previous = previousCache.get(resolved);
      if (previous) require.cache[resolved] = previous;
    }
  }
}

class FakeLifecycle extends EventEmitter {
  constructor(sessionId, platform, meta) {
    super();
    this.sessionId = sessionId;
    this.platform = platform;
    this._meta = meta;
    this.state = "created";
    this.isTerminal = false;
  }
  transition(state) {
    this.state = state;
    this.isTerminal = ["completed", "failed", "cancelled"].includes(state);
  }
  setConversationLog(log) { this._conversationLog = log; }
}

class FakeSlackNotifier {
  constructor(botToken, channelId, options = {}) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.options = options;
    this.enabled = options.enabled !== false
      && !!botToken
      && (options.notifyTarget === "dm" ? !!options.dmUserId : !!(options.statusChannelId || channelId));
  }
  postStatus() { return Promise.resolve(); }
  startElapsedUpdates() {}
  stopElapsedUpdates() {}
  postSummary() { return Promise.resolve(); }
  postTranscript() { return Promise.resolve(); }
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.isAlive = true;
    this.sent = [];
    this.closed = [];
    this.terminated = 0;
  }
  send(payload) { this.sent.push(payload); }
  close(code, reason) { this.closed.push({ code, reason }); }
  terminate() { this.terminated += 1; }
  ping() {}
}

async function requestHttp(routes, method, url, formData = null, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  const result = { statusCode: null, headers: null, text: "", body: null };
  const res = {
    writeHead(statusCode, headers) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(body = "") {
      result.text = String(body);
      if (result.headers?.["Content-Type"]?.startsWith("application/json")) result.body = JSON.parse(result.text);
    },
  };
  const pending = routes.handleHttp(req, res);
  await Promise.resolve();
  if (formData) req.emit("data", Buffer.from(stringify(formData)));
  req.emit("end");
  await pending;
  return result;
}

async function requestSettings(handler, method, url, body = Buffer.alloc(0), headers = {}) {
  const req = Readable.from(body.length ? [body] : []);
  Object.assign(req, {
    method,
    url,
    headers: {
      host: "localhost:5005",
      ...(method === "GET" ? {} : { origin: "http://localhost:5005", "sec-fetch-site": "same-origin" }),
      ...headers,
    },
    socket: { localAddress: "127.0.0.1", localPort: 5005 },
  });
  const result = { statusCode: null, headers: null, body: Buffer.alloc(0) };
  const res = {
    writeHead(statusCode, responseHeaders) {
      result.statusCode = statusCode;
      result.headers = responseHeaders;
    },
    end(chunk = Buffer.alloc(0)) {
      result.body = Buffer.concat([result.body, Buffer.from(chunk)]);
    },
  };
  await handler(req, res);
  return result;
}

function requestSettingsAvatarUpload(handler, bytes) {
  const boundary = "meetmate-static-freshness";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return requestSettings(handler, "POST", "/api/settings/avatar/static", body, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
}

function splitPcmBySamples(buffer, sampleCounts) {
  const chunks = [];
  let offset = 0;
  for (const count of sampleCounts) {
    chunks.push(buffer.subarray(offset, offset + count * 2));
    offset += count * 2;
  }
  assert.equal(offset, buffer.length);
  return chunks;
}

function installMock(filename, exports) {
  const resolved = require.resolve(filename);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
