"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { FloorClient } = require("../src/floor-client");
const { createSonioxSTT } = require("../src/stt-soniox");
const { buildKeyterms } = require("../src/stt");
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));

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
    _buildKeyterms: (x) => x, keyterms: () => terms });
  const utterances = [];
  stt.on("utterance_end", (text) => utterances.push(text));
  try {
    sockets[0].open();
    assert.deepEqual(JSON.parse(sockets[0].sent[0]).context.terms, terms);
    sockets[0].receive({ tokens: [{ text: "途中", is_final: true }] });
    terms.push("シエル"); // In-place mutation must not mutate the live config snapshot.
    assert.equal(stt.refreshContext(), true);
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
    _buildKeyterms: (x) => x, keyterms: () => terms });
  try {
    terms = ["own", "peer"];
    assert.equal(stt.refreshContext(), true);
    assert.equal(sockets[0].closeCalls, 0);
    sockets[0].open();
    assert.deepEqual(JSON.parse(sockets[0].sent[0]).context.terms, terms);
    terms = ["own"];
    stt.refreshContext();
    sockets[0].finishClose();
    stt.close();
    await delay();
    assert.equal(sockets.length, 1);
  } finally { stt.close(); }
});

function pipelineHarness({ enabled = true, own = ["ケイティ"], keyterms = [] } = {}) {
  const names = ["stt-provider", "llm-provider", "pipeline"];
  const paths = names.map((name) => require.resolve(`../src/${name}`));
  const saved = paths.map((file) => require.cache[file]);
  const streams = [];
  const floor = Object.assign(new EventEmitter(), {
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
