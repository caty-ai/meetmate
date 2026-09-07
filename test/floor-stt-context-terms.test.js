"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { FloorClient } = require("../src/floor-client");
const { createSonioxSTT } = require("../src/stt-soniox");
const { buildKeyterms } = require("../src/stt");
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// Same EventEmitter wire as floor-client and stt-soniox-resilience tests,
// with an explicit close event to exercise audio arriving during shutdown.
function fakeWebSocketCtor(instances) {
  return class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      this.closeCalls = 0;
      instances.push(this);
    }
    send(data) { this.sent.push(data); }
    open() { this.readyState = 1; this.emit("open"); }
    receive(message) { this.emit("message", Buffer.from(JSON.stringify(message))); }
    close() { this.closeCalls += 1; this.readyState = 2; }
    finishClose() { this.readyState = 3; this.emit("close"); }
  };
}

test("E1 roster terms exclude self, trim, deduplicate, and shrink on removal", () => {
  const sockets = [];
  const client = new FloorClient({ agentId: "caty", url: "ws://fake", roomCode: "test",
    WebSocketImpl: fakeWebSocketCtor(sockets) });
  try {
    client.connect();
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "welcome", memberId: "m-caty", members: [
      { memberId: "m-caty", displayName: "ケイティ", wakeWords: ["ケイティ"] },
      { memberId: "m-ciel", displayName: "シエル", wakeWords: ["シエル"] },
    ] });
    assert.deepEqual(client.peerContextTerms(), ["シエル"]);
    const terms = client.peerContextTerms();
    terms.push("not roster data");
    socket.receive({ type: "member_joined", memberId: "m-alpha", displayName: "アルファ",
      wakeWords: [" アルファ ", "", "アルファ"], sttWakeVariants: ["しえる", " "] });
    assert.deepEqual(client.peerContextTerms(), ["シエル", "アルファ", "しえる"]);
    socket.receive({ type: "member_left", memberId: "m-ciel" });
    assert.deepEqual(client.peerContextTerms(), ["アルファ", "しえる"]);
    socket.receive({ type: "member_left", memberId: "m-alpha" });
    assert.deepEqual(client.peerContextTerms(), []);
  } finally { client.close(); }
});

test("E2/E3 context refresh reconnects once, preserves PCM and partial text, and coalesces updates", async () => {
  const sockets = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  let terms = ["ケイティ"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 1, _buildKeyterms: (x) => x, keyterms: () => terms });
  const utterances = [];
  stt.on("utterance_end", (text) => utterances.push(text));
  try {
    sockets[0].open();
    assert.deepEqual(JSON.parse(sockets[0].sent[0]).context.terms, terms);
    sockets[0].receive({ tokens: [{ text: "途中", is_final: true }] });
    terms.push("シエル"); // In-place mutation must not mutate the live config snapshot.
    assert.equal(stt.refreshContext(), true);
    await delay();
    assert.equal(sockets[0].closeCalls, 0);
    assert.deepEqual(utterances, []);
    sockets[0].receive({ tokens: [{ text: "<end>", is_final: true }] });
    assert.equal(sockets[0].sent.at(-1), "");
    assert.equal(sockets[0].closeCalls, 1);
    assert.deepEqual(utterances, ["途中"]);
    const pcm = Buffer.from([1, 2, 3, 4]);
    stt.send(pcm);
    terms = [...terms, "しえる"];
    assert.equal(stt.refreshContext(), true);
    assert.equal(sockets[0].closeCalls, 1);
    sockets[0].receive({ tokens: [{ text: "<end>", is_final: true }], finished: true });
    assert.deepEqual(utterances, ["途中"]);
    sockets[0].finishClose();
    await delay();
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.deepEqual(JSON.parse(sockets[1].sent[0]).context.terms, terms);
    assert.deepEqual(sockets[1].sent[1], pcm);
    assert.equal(stt.refreshContext(), false);
    await delay();
    assert.equal(sockets.length, 2);
    assert.equal(logs.some((line) => line.includes("予期しない切断")), false);
    terms = ["ケイティ"];
    assert.equal(stt.refreshContext(), true);
    await delay();
    sockets[1].finishClose();
    await delay();
    sockets[2].open();
    assert.deepEqual(JSON.parse(sockets[2].sent[0]).context.terms, terms);
    stt.close();
    assert.equal(stt.refreshContext(), false);
  } finally {
    stt.close();
    console.log = originalLog;
    require("../src/settings/readiness").reset();
  }
});

test("Soniox resolves changes while connecting and cancels a scheduled context reconnect on close", async () => {
  const sockets = [];
  let terms = ["own"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 1, _buildKeyterms: (x) => x, keyterms: () => terms });
  try {
    terms = ["own", "peer"];
    assert.equal(stt.refreshContext(), true);
    assert.equal(sockets[0].closeCalls, 0);
    sockets[0].open();
    assert.deepEqual(JSON.parse(sockets[0].sent[0]).context.terms, terms);
    terms = ["own"];
    stt.refreshContext();
    await delay();
    sockets[0].finishClose();
    stt.close();
    await delay();
    assert.equal(sockets.length, 1);
  } finally { stt.close(); }
});

function pipelineHarness({ enabled = true, own = ["ケイティ"], keyterms = [], floorClient } = {}) {
  const names = ["stt-provider", "llm-provider", "pipeline"];
  const paths = names.map((name) => require.resolve(`../src/${name}`));
  const saved = paths.map((file) => require.cache[file]);
  const streams = [];
  const floor = floorClient || Object.assign(new EventEmitter(), {
    connect() {}, close() {}, peerContextTerms: () => [],
  });
  const mock = (file, exports) => { require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
  mock(paths[0], { createSTT(_key, options) {
    const stream = Object.assign(new EventEmitter(), {
      options, refreshes: 0, send() {}, close() {}, refreshContext() { this.refreshes += 1; },
    });
    streams.push(stream);
    return stream;
  } });
  mock(paths[1], { createLlmProvider: () => ({ name: "openclaw", async *streamChat() {} }) });
  delete require.cache[paths[2]];
  const bootstrap = require("../src/settings/bootstrap");
  const resolver = require("../src/settings/resolver");
  bootstrap.resetStartupForTest();
  resolver.resetRuntimeForTest();
  const pipeline = require("../src/pipeline").createPipeline(
    { id: "context-terms", conversationLog: [], config: { wakeMode: "wake" } },
    { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 }, () => {}, {
      dgKey: "x", fishKey: "x", stt: { model: "nova-3", language: "ja", sampleRate: 16000 },
      llm: { provider: "openclaw", model: "test", responseTimeoutMs: 0 },
      tts: { provider: "fish-audio", sampleRate: 16000 },
      hub: { enabled, url: "ws://fake", roomCode: "test", authToken: "x" },
      gatewayEvents: { enabled: false }, greeting: "",
    }, { agentProfile: { agentId: "caty", wakeWords: own, keyterms }, floorClient: floor,
      capabilities: { perSpeakerAudio: true, echoesOwnOutput: false },
      _testExposeInternals: true });
  return { pipeline, floor, streams, cleanup() {
    pipeline.close();
    paths.forEach((file, index) => {
      delete require.cache[file];
      if (saved[index]) require.cache[file] = saved[index];
    });
    resolver.resetRuntimeForTest();
    bootstrap.resetStartupForTest();
  } };
}

test("E4 pipeline deduplicates peer terms, preserves own terms and truncates the tail at 8000 characters", () => {
  const h = pipelineHarness();
  try {
    h.floor.peerContextTerms = () => ["シエル", "ケイティ", "しえる"];
    assert.deepEqual(h.pipeline._test.resolveSttKeyterms(), ["ケイティ", "シエル", "しえる"]);
    assert.equal(typeof h.streams[0].options.keyterms, "function");
    assert.deepEqual(h.streams[0].options.keyterms(), ["ケイティ", "シエル", "しえる"]);
    h.floor.peerContextTerms = () => ["a".repeat(7996), "tail", "b"];
    const capped = h.pipeline._test.resolveSttKeyterms();
    assert.deepEqual(capped, ["ケイティ", "a".repeat(7996)]);
    assert.equal(capped.reduce((sum, term) => sum + term.length, 0), 8000);
    h.pipeline.sendAudio(Buffer.alloc(640), { speaker: {
      platform: "meet", id: "speaker", displayName: "Speaker", isBot: false,
    } });
    assert.equal(h.streams.length, 2);
    assert.deepEqual(h.streams[1].options.keyterms(), capped);
    h.floor.emit("members", []);
    assert.equal(h.streams[0].refreshes, 1);
    assert.equal(h.streams[1].refreshes, 1);
    h.floor.peerContextTerms = () => [];
    h.floor.emit("members", []);
    assert.deepEqual(h.streams[0].options.keyterms(), ["ケイティ"]);
    assert.deepEqual(h.streams[1].options.keyterms(), ["ケイティ"]);
    const previousWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      h.streams[0].refreshContext = () => { throw new Error("refresh failed"); };
      h.floor.emit("members", []);
      assert.equal(h.streams[1].refreshes, 3);
      assert.match(warnings[0], /STT context refresh failed:/);
    } finally { console.warn = previousWarn; }
  } finally { h.cleanup(); }
  const oversized = pipelineHarness({ keyterms: ["x".repeat(8001)] });
  try {
    oversized.floor.peerContextTerms = () => ["peer"];
    assert.deepEqual(oversized.pipeline._test.resolveSttKeyterms(), ["x".repeat(8001), "ケイティ"]);
  } finally { oversized.cleanup(); }
});

test("E5 hub disabled preserves the exact own keyterms then wakeWords array", () => {
  const h = pipelineHarness({ enabled: false, keyterms: ["k1", "k2"], own: ["ケイティ", "k1"] });
  try {
    h.floor.peerContextTerms = () => ["peer"];
    assert.deepEqual(h.pipeline._test.resolveSttKeyterms(), ["k1", "k2", "ケイティ", "k1"]);
    assert.deepEqual(h.streams[0].options.keyterms, ["k1", "k2", "ケイティ", "k1"]);
    h.floor.emit("members", []);
    assert.equal(h.streams[0].refreshes, 0);
  } finally { h.cleanup(); }
});

test("E6 Deepgram resolves function terms and guards non-array results", () => {
  const terms = buildKeyterms(() => ["a", "a", "b"]);
  assert.equal(terms.filter((term) => term === "a").length, 1);
  assert.equal(terms.filter((term) => term === "b").length, 1);
  assert.doesNotThrow(() => buildKeyterms(() => null));
});

test("D2-1 welcome and re-welcome emit one roster snapshot and refresh pipeline context", () => {
  const sockets = [];
  const floor = new FloorClient({ agentId: "caty", url: "ws://fake", roomCode: "test",
    WebSocketImpl: fakeWebSocketCtor(sockets) });
  const rosters = [];
  floor.on("members", (members) => rosters.push(members));
  const h = pipelineHarness({ floorClient: floor });
  try {
    const socket = sockets[0];
    socket.open();
    const peers = [
      { memberId: "ciel", wakeWords: ["シエル"] },
      { memberId: "alpha", wakeWords: ["アルファ"] },
    ];
    socket.receive({ type: "welcome", memberId: "caty", members: peers });
    assert.equal(rosters.length, 1);
    assert.deepEqual(rosters[0].map((m) => m.memberId), ["ciel", "alpha"]);
    assert.notEqual(rosters[0], floor.members);
    assert.equal(h.streams[0].refreshes, 1);
    assert.deepEqual(h.streams[0].options.keyterms(), ["ケイティ", "シエル", "アルファ"]);
    socket.receive({ type: "welcome", memberId: "caty-new", members: peers.slice(1) });
    assert.equal(rosters.length, 2);
    assert.equal(h.streams[0].refreshes, 2);
    assert.deepEqual(h.streams[0].options.keyterms(), ["ケイティ", "アルファ"]);
  } finally { h.cleanup(); }
});

test("D2-3 welcome normalizes malformed arrays and D2-9 excludes self by agentId", () => {
  const client = new FloorClient({ agentId: "caty" });
  try {
    client.handleWelcome({ memberId: "self", members: [
      { memberId: "a", wakeWords: ["A"], sttWakeVariants: "エックス" },
      { memberId: "b", wakeWords: 7, sttWakeVariants: 7 },
      { memberId: "old-self", agentId: "caty", wakeWords: ["self-term"] },
    ] });
    assert.deepEqual(client.members.slice(0, 2).map((m) => m.sttWakeVariants), [[], []]);
    assert.deepEqual(client.peerContextTerms(), ["A"]);
    client.members.push({ memberId: "raw", wakeWords: "bad", sttWakeVariants: 7 });
    assert.deepEqual(client.peerContextTerms(), ["A"]);
  } finally { client.close(); }
});

test("D2-2 a throwing keyterms callback reuses the previous config and scrubs the warning", async () => {
  const sockets = [];
  let terms = ["old"];
  let fail = false;
  const warnings = [];
  const oldWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const stt = createSonioxSTT("private-test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 1, _buildKeyterms: (x) => x, keyterms() {
      if (fail) { fail = false; throw new Error("failed private-test-key"); }
      return terms;
    } });
  try {
    sockets[0].open();
    terms = ["new"];
    stt.refreshContext();
    await delay();
    sockets[0].finishClose();
    await delay();
    fail = true;
    sockets[1].open();
    assert.deepEqual(JSON.parse(sockets[1].sent[0]).context.terms, ["old"]);
    const pcm = Buffer.from([1, 2]);
    stt.send(pcm);
    assert.equal(sockets[1].sent.at(-1), pcm);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /文脈語の解決に失敗・直前の語を使います/);
    assert.equal(warnings[0].includes("private-test-key"), false);
  } finally { stt.close(); console.warn = oldWarn; }
});

test("D2-2 a config builder throwing on open closes the socket and schedules recovery", async () => {
  const sockets = [];
  let fail = true;
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _reconnectBaseDelayMs: 1, keyterms: ["ok"], _buildKeyterms(terms) {
      if (fail) { fail = false; throw new Error("build failed"); }
      return terms;
    } });
  const errors = [];
  stt.on("error", (err) => errors.push(err.message));
  try {
    sockets[0].open();
    assert.deepEqual(errors, ["build failed"]);
    assert.equal(sockets[0].closeCalls, 1);
    sockets[0].finishClose();
    await delay();
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.deepEqual(JSON.parse(sockets[1].sent[0]).context.terms, ["ok"]);
  } finally { stt.close(); }
});

test("D2-4 final tokens arriving during context shutdown flush exactly one utterance", async () => {
  const sockets = [];
  let terms = ["old"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 1, _reconnectBaseDelayMs: 1, _buildKeyterms: (x) => x, keyterms: () => terms });
  const utterances = [];
  stt.on("utterance_end", (text) => utterances.push(text));
  try {
    sockets[0].open();
    sockets[0].receive({ tokens: [{ text: "first", is_final: true }] });
    terms = ["new"];
    stt.refreshContext();
    sockets[0].receive({ tokens: [{ text: " second", is_final: true }] });
    assert.deepEqual(utterances, []);
    sockets[0].finishClose();
    assert.deepEqual(utterances, ["first second"]);
    await delay();
    assert.equal(sockets.length, 2);
  } finally { stt.close(); require("../src/settings/readiness").reset(); }
});

test("D2-5 waits for endpoint, coalesces roster bursts, and cancels reverted terms", async () => {
  const sockets = [];
  let terms = ["old"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 15, _buildKeyterms: (x) => x, keyterms: () => terms });
  try {
    sockets[0].open();
    sockets[0].receive({ tokens: [{ text: "speaking", is_final: true }] });
    terms = ["new"];
    stt.refreshContext();
    terms = ["new", "peer"];
    stt.refreshContext();
    await delay(30);
    assert.equal(sockets[0].closeCalls, 0);
    sockets[0].receive({ tokens: [{ text: "<end>", is_final: true }] });
    assert.equal(sockets[0].closeCalls, 1);
    sockets[0].finishClose();
    await delay();
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.deepEqual(JSON.parse(sockets[1].sent[0]).context.terms, terms);
    terms = ["temporary"];
    stt.refreshContext();
    terms = ["new", "peer"];
    assert.equal(stt.refreshContext(), false);
    await delay(30);
    assert.equal(sockets[1].closeCalls, 0);
  } finally { stt.close(); require("../src/settings/readiness").reset(); }
});

test("D2-6 watchdog terminates a socket whose graceful close hangs", async () => {
  const sockets = [];
  let terms = ["old"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 1, _contextCloseTimeoutMs: 15,
    _buildKeyterms: (x) => x, keyterms: () => terms });
  let terminated = 0;
  sockets[0].terminate = () => { terminated += 1; sockets[0].finishClose(); };
  try {
    sockets[0].open();
    terms = ["new"];
    stt.refreshContext();
    await delay(40);
    assert.equal(terminated, 1);
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.deepEqual(JSON.parse(sockets[1].sent[0]).context.terms, terms);
  } finally { stt.close(); }
});

test("D2-7 pipeline close removes its members listener from an injected floor client", () => {
  const h = pipelineHarness();
  try {
    assert.equal(h.floor.listenerCount("members"), 1);
    h.pipeline.close();
    assert.equal(h.floor.listenerCount("members"), 0);
    h.floor.emit("members", []);
    assert.equal(h.streams[0].refreshes, 0);
  } finally { h.cleanup(); }
});

test("D2-4 context close flushes late final tokens together without a second utterance", async () => {
  const sockets = [];
  let terms = ["old"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 1, _buildKeyterms: (x) => x, keyterms: () => terms });
  const utterances = [];
  stt.on("utterance_end", (text) => utterances.push(text));
  try {
    sockets[0].open();
    terms = ["new"];
    stt.refreshContext();
    await delay();
    assert.equal(sockets[0].closeCalls, 1);
    sockets[0].receive({ tokens: [{ text: "late", is_final: true }] });
    stt.refreshContext();
    sockets[0].receive({ tokens: [{ text: " tail", is_final: true }] });
    assert.deepEqual(utterances, []);
    sockets[0].finishClose();
    assert.deepEqual(utterances, ["late tail"]);
    await delay();
    assert.equal(sockets.length, 2);
  } finally { stt.close(); require("../src/settings/readiness").reset(); }
});

test("D2-5 debounce resets on each roster update and shutdown cancels it", async () => {
  const sockets = [];
  let terms = ["old"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 40, _buildKeyterms: (x) => x, keyterms: () => terms });
  try {
    sockets[0].open();
    terms = ["one"];
    stt.refreshContext();
    await delay(25);
    terms = ["two"];
    stt.refreshContext();
    await delay(25);
    assert.equal(sockets[0].closeCalls, 0);
    await delay(30);
    assert.equal(sockets[0].closeCalls, 1);
    sockets[0].finishClose();
    await delay();
    sockets[1].open();
    terms = ["three"];
    stt.refreshContext();
    stt.close();
    await delay(60);
    assert.equal(sockets[1].closeCalls, 1);
    assert.equal(sockets.length, 2);
  } finally { stt.close(); }
});

test("D2-6 watchdog retries close without terminate and clears after close", async () => {
  const sockets = [];
  let terms = ["old"];
  const stt = createSonioxSTT("test-key", { _wsCtor: fakeWebSocketCtor(sockets),
    _contextDebounceMs: 1, _contextCloseTimeoutMs: 15,
    _buildKeyterms: (x) => x, keyterms: () => terms });
  try {
    sockets[0].open();
    terms = ["new"];
    stt.refreshContext();
    await delay(35);
    assert.equal(sockets[0].closeCalls, 2);
    sockets[0].finishClose();
    await delay();
    sockets[1].open();
    let terminated = 0;
    sockets[1].terminate = () => { terminated += 1; };
    terms = ["next"];
    stt.refreshContext();
    await delay(5);
    sockets[1].finishClose();
    await delay(30);
    assert.equal(terminated, 0);
    assert.equal(sockets.length, 3);
  } finally { stt.close(); }
});

test("D2-8 Deepgram re-resolves function terms on connect without changing keyword fallback", async () => {
  const sdkPath = require.resolve("@deepgram/sdk");
  const sttPath = require.resolve("../src/stt");
  const savedSdk = require.cache[sdkPath];
  const savedStt = require.cache[sttPath];
  const events = savedSdk.exports.LiveTranscriptionEvents;
  const connections = [];
  const configs = [];
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: {
    LiveTranscriptionEvents: events, createClient: () => ({ listen: { live(config) {
      configs.push(config);
      const conn = Object.assign(new EventEmitter(), { requestClose() {} });
      connections.push(conn);
      return conn;
    } } }),
  } };
  delete require.cache[sttPath];
  let terms = ["first-term"];
  const resolved = [];
  let stt;
  try {
    stt = require("../src/stt").createSTT("test-key", { keyterms: () => {
      resolved.push(terms.slice()); return terms;
    } });
    assert.ok(configs[0].keyterm.includes("first-term"));
    terms = ["second-term"];
    connections[0].emit(events.Error, new Error("keyword handshake failed"));
    await delay(180);
    assert.equal(connections.length, 2);
    assert.deepEqual(resolved, [["first-term"], ["second-term"]]);
    assert.equal(configs[1].keyterm, undefined);
    assert.equal(configs[1].keywords, undefined);
  } finally {
    stt?.close();
    require.cache[sdkPath] = savedSdk;
    require.cache[sttPath] = savedStt;
    require("../src/settings/readiness").reset();
  }
});
