"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { encode, decodeOne } = require("../src/live-openai/msgpack-lite");
const engine = require("../src/live-openai/live-engine");
const { TTS_SAMPLE_RATE } = require("../src/config");

class Clock {
  time = 0; next = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => this.add(fn, ms, 0);
  setInterval = (fn, ms) => this.add(fn, ms, ms);
  clearTimeout = id => this.timers.delete(id);
  clearInterval = id => this.timers.delete(id);
  add(fn, ms, interval) { const id = ++this.next; this.timers.set(id, { fn, at: this.time + ms, interval }); return id; }
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next; this.time = timer.at;
      if (timer.interval) timer.at += timer.interval; else this.timers.delete(id);
      timer.fn();
    }
    this.time = end;
  }
}
const textFields = v => Buffer.isBuffer(v) ? v.toString("utf8") : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, textFields(x)])) : v;
class Socket extends EventEmitter {
  readyState = 0; sent = []; closes = 0;
  constructor(kind, url, options) { super(); this.kind = kind; this.url = url; this.options = options; }
  open() { this.readyState = 1; this.emit("open"); }
  send(raw, callback) { assert.equal(this.readyState, 1); this.sent.push(this.kind === "fish" ? textFields(decodeOne(raw)) : JSON.parse(raw)); callback?.(); }
  close() { this.closes++; this.readyState = 3; this.emit("close"); }
  event(event) { this.emit("message", this.kind === "fish" ? encode(event) : Buffer.from(JSON.stringify(event))); }
}
let ids = 0;
function harness(t, options = {}) {
  const clock = options.clock || new Clock(), fish = [], audio = [], errors = [], cancellations = [], state = { isAgentSpeaking: false };
  let openai;
  const config = { llm: { systemPrompt: "configured profile prompt", gateway: { url: "http://gateway.test", token: "test-key" }, openclawSystemAddendum: "voice rules", model: "main", temperature: 0.5, maxTokens: 100 }, tts: { referenceId: "test-voice" } };
  const handler = engine.createLiveEngine({ id: options.id || `test-${++ids}`, sessionUser: "test-user", config: { wakeMode: options.wakeMode || "always" } }, state,
    (pcm, meta) => audio.push({ pcm, meta }), {
      config, now: clock.now, setTimeout: clock.setTimeout, setInterval: clock.setInterval,
      clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval,
      openaiSocketFactory: (url, opts) => (openai = new Socket("openai", url, opts)),
      fishSocketFactory: (url, opts) => { const ws = new Socket("fish", url, opts); fish.push(ws); return ws; },
      ...options.engineOptions,
    });
  handler.on("engine_error", e => errors.push(e)); handler.on("playback_cancelled", e => cancellations.push(e));
  t.after(() => { void handler.close(); openai.event({ type: "session.closed", usage: { seconds: 0 } }); });
  openai.open();
  if (options.start !== false) { openai.event({ type: "session.started" }); fish.forEach(ws => ws.open()); }
  return { clock, fish, audio, errors, cancellations, state, handler, openai, config,
    output: delta => openai.event({ type: "session.output_transcript.delta", delta }),
    input: delta => openai.event({ type: "session.input_transcript.delta", delta }),
  };
}

test("exact session protocol, warm Fish sockets, ordered raw deltas, flush at 600 not 599", t => {
  const h = harness(t);
  assert.equal(h.openai.url, "wss://api.openai.com/v1/live/sessions");
  assert.deepEqual(h.openai.sent[0], { type: "session.start", event_id: "event_start", session: { model: "gpt-live-1", instructions: h.config.llm.systemPrompt, audio: { format: { type: "audio/pcm", rate: 16000 }, output: { voice: "quartz" } }, delegation: { type: "client" } } });
  for (const socket of h.fish) {
    assert.equal(socket.url, "wss://api.fish.audio/v1/tts/live");
    assert.equal(socket.options.headers.model, "s2.1-pro");
    assert.deepEqual(socket.sent, [{ event: "start", request: { text: "", reference_id: "test-voice", format: "pcm", sample_rate: TTS_SAMPLE_RATE, latency: "low" } }]);
  }
  for (const text of ["うん", "、", "途中で", "切れ"]) h.output(text);
  assert.deepEqual(h.fish[0].sent.slice(1), ["うん", "、", "途中で", "切れ"].map(text => ({ event: "text", text })));
  h.clock.advance(599); assert.equal(h.fish[0].sent.at(-1).event, "text");
  h.clock.advance(1); assert.deepEqual(h.fish[0].sent.at(-1), { event: "flush" });
  h.output("次"); h.clock.advance(599); assert.equal(h.fish[0].sent.at(-1).event, "text");
  h.clock.advance(1); assert.equal(h.fish[0].sent.at(-1).event, "flush");
  const pcm = Buffer.from([0, 1, 2, 3]); h.handler.send(pcm);
  assert.deepEqual(h.openai.sent.at(-1), { type: "session.input_audio.append", audio: pcm.toString("base64") });
  h.openai.event({ type: "session.output_audio.delta", delta: pcm.toString("base64") });
  assert.equal(h.audio.length, 0);
});
test("interruption promotes warm spare, cancels old epoch and rejects late old audio", t => {
  const h = harness(t); h.output("応答です");
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 2 * 2, 1) });
  h.clock.advance(520); h.input("待ってください");
  assert.equal(h.fish[0].closes, 1);
  assert.equal(h.fish.length, 3);
  assert.deepEqual(h.cancellations, [{ outputEpoch: 0, reason: "interrupted", monotonicTime: 520 }]);
  assert.equal(h.state.isAgentSpeaking, false);
  assert.equal(h.fish[0].sent.some(e => e.event === "stop"), false);
  const count = h.audio.length;
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(960, 9) });
  h.clock.advance(20); assert.equal(h.audio.length, count);
  h.output("はい"); assert.deepEqual(h.fish[1].sent.at(-1), { event: "text", text: "はい" });
  h.fish[1].event({ event: "audio", audio: Buffer.alloc(960, 2) }); h.clock.advance(20);
  assert.deepEqual(h.audio.at(-1).meta, { outputEpoch: 1, firstSampleIndex: 0, sampleRate: TTS_SAMPLE_RATE });
  assert.equal(h.audio.at(-1).pcm[0], 2);
});
test("self-echo and input in first 500 ms do not interrupt; two short deltas do", t => {
  const h = harness(t); h.output("うん、そうですね");
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 4) });
  h.clock.advance(20); h.input("待ってください");
  assert.equal(h.cancellations.length, 0);
  h.clock.advance(499); h.input("止めてください"); assert.equal(h.cancellations.length, 0);
  h.clock.advance(1); h.input("うん"); assert.equal(h.cancellations.length, 0);
  h.output("続きを"); h.input("え"); assert.equal(h.cancellations.length, 0);
  h.input("あ"); assert.equal(h.cancellations.length, 1);
});
test("detector requires pending current-epoch work and four chars or two deltas", () => {
  const base = { pending: false, inputDeltas: 0, inputChars: 0, recentOutputText: "", firstAudioAt: 0, now: 500 };
  assert.equal(engine.detectInterruption({ ...base }, { text: "待ってください" }), false);
  assert.equal(engine.detectInterruption({ ...base, pending: true, firstAudioAt: null }, { text: "待ってください" }), false);
  assert.equal(engine.detectInterruption({ ...base, pending: true }, { text: "待って" }), false);
  assert.equal(engine.detectInterruption({ ...base, pending: true }, { text: "待ってね" }), true);
});
test("odd byte held; PCM emitted at 20 ms with monotonic sample metadata; empty resets speaking", t => {
  const h = harness(t); h.output("音声");
  h.fish[0].event({ event: "audio", audio: Buffer.from([1]) }); h.clock.advance(20); assert.equal(h.audio.length, 0);
  h.fish[0].event({ event: "audio", audio: Buffer.from([2, 3, 4, 5]) }); h.clock.advance(20);
  assert.deepEqual(h.audio[0].pcm, Buffer.from([1, 2, 3, 4]));
  h.fish[0].event({ event: "audio", audio: Buffer.from([6]) }); h.clock.advance(20);
  assert.deepEqual(h.audio[1].pcm, Buffer.from([5, 6]));
  assert.deepEqual(h.audio.map(e => e.meta), [0, 2].map(firstSampleIndex => ({ outputEpoch: 0, firstSampleIndex, sampleRate: TTS_SAMPLE_RATE })));
  h.clock.advance(220); assert.equal(h.state.isAgentSpeaking, false);
});
test("queue bounded to 15 seconds, oldest bytes dropped; model-stopped watchdog at 1500", t => {
  const h = harness(t); h.output("長い回答");
  const second = TTS_SAMPLE_RATE * 2;
  h.fish[0].event({ event: "audio", audio: Buffer.concat([Buffer.alloc(second, 1), Buffer.alloc(second * 15, 2)]) });
  h.clock.advance(20); assert.equal(h.audio[0].pcm.length, second / 50); assert.equal(h.audio[0].pcm[0], 2);
  h.clock.advance(1479); assert.equal(h.cancellations.length, 0);
  h.clock.advance(1); assert.equal(h.cancellations.length, 1);
  const empty = harness(t); empty.clock.advance(1600); assert.equal(empty.cancellations.length, 0);
  const flight = harness(t); flight.output("未受信"); flight.clock.advance(1500); assert.equal(flight.cancellations.length, 1);
});
test("cap at 60 minutes says closing line, drains then closes; recreated handler keeps clock", async t => {
  assert.equal(engine.SESSION_CAP_MS, 3600000);
  const clock = new Clock(), id = `cap-${++ids}`;
  const h = harness(t, { clock, id });
  clock.advance(engine.SESSION_CAP_MS - 1); assert.equal(h.fish[0].sent.length, 1);
  clock.advance(1);
  assert.deepEqual(h.fish[0].sent.slice(-2), [{ event: "text", text: "時間の上限に達したので、ここで一度切りますね。" }, { event: "flush" }]);
  assert.equal(h.openai.sent.some(e => e.type === "session.close"), false);
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(960) }); clock.advance(220);
  assert.equal(h.openai.sent.at(-1).type, "session.close");
  const length = h.openai.sent.length; h.handler.send(Buffer.alloc(2)); assert.equal(h.openai.sent.length, length);
  h.openai.event({ type: "session.closed", usage: { seconds: 3600 } });
  assert.equal(h.fish[0].sent.at(-1).event, "stop");
  assert.equal(clock.timers.size, 0);
  const second = harness(t, { clock, id }); clock.advance(0);
  assert.equal(second.fish[0].sent.at(-2).event, "text");
  clock.advance(4999); assert.equal(second.openai.sent.some(e => e.type === "session.close"), false);
  clock.advance(1); assert.equal(second.openai.sent.at(-1).type, "session.close");
});
test("start/close deadlines and OpenAI failures emit one error and remain silent", async t => {
  const h = harness(t, { start: false }); h.handler.send(Buffer.alloc(2)); assert.equal(h.openai.sent.length, 1);
  h.clock.advance(19999); assert.equal(h.errors.length, 0); h.clock.advance(1); assert.equal(h.errors.length, 1);
  h.openai.emit("error", new Error("test-key")); assert.equal(h.errors.length, 1); assert.equal(h.clock.timers.size, 0);
  const closing = harness(t); const done = closing.handler.close(); closing.clock.advance(10000); await done;
  assert.equal(closing.errors.length, 1); assert.equal(closing.clock.timers.size, 0);
  const broken = harness(t); broken.openai.close(); assert.equal(broken.errors.length, 1);
  broken.handler.send(Buffer.alloc(2)); assert.equal(broken.openai.sent.length, 1);
});
test("Fish unexpected close retries after 500 ms, max three per minute", t => {
  const h = harness(t);
  let active = h.fish[0];
  for (let i = 0; i < 3; i++) {
    active.close(); const count = h.fish.length;
    h.clock.advance(499); assert.equal(h.fish.length, count);
    h.clock.advance(1); assert.equal(h.fish.length, count + 1);
    active = h.fish.at(-1); active.open();
  }
  active.close(); assert.equal(h.errors.length, 1); assert.equal(h.clock.timers.size, 0);
});
test("delegation copies gateway options and history, rejects duplicates, sends commentary", async t => {
  const calls = [];
  const h = harness(t, { engineOptions: { streamChat: async function* (messages, options) { calls.push({ messages, options }); yield "調べ"; yield "ました"; } } });
  h.input("質問"); h.input("です"); h.output("確認します");
  const delegation = { id: "d1", target: "client", text: "調べて" };
  h.openai.event({ type: "session.delegation.created", delegation });
  h.openai.event({ type: "session.delegation.created", delegation });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "質問です" }, { role: "assistant", content: "確認します" }, { role: "user", content: "調べて" }]);
  assert.deepEqual({ ...calls[0].options, signal: undefined }, { openclawUrl: "http://gateway.test", openclawToken: "test-key", openclawSystemAddendum: "voice rules", sessionUser: "test-user", model: "main", temperature: 0.5, maxTokens: 100, signal: undefined });
  assert.deepEqual(h.openai.sent.at(-1), { type: "session.commentary.append", event_id: "event_1", delegation_id: "d1", content: "調べました" });
  assert.deepEqual(h.handler.getDelegationResults(), [{ id: "d1", status: "completed", startedAt: 0, finishedAt: 0 }]);
  h.handler.handleGatewaySessionReply("返信"); h.handler.handleGatewayAnnounceInjected("通知");
  assert.deepEqual(h.openai.sent.slice(-2).map(e => e.delegation_id), ["gateway-1", "gateway-2"]);
});
test("delegation errors use fixed response; close aborts pending delegation", async t => {
  const h = harness(t, { engineOptions: { streamChat: async function* () { throw new Error("test-key"); } } });
  h.openai.event({ type: "session.delegation.created", delegation: { id: "bad", target: "client", task: "unknown field" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.openai.sent.at(-1).content, "確認できませんでした。もう一度聞いてもらえる？");
  let signal;
  const pending = harness(t, { engineOptions: { streamChat: async function* (_messages, options) {
    signal = options.signal; await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  } } });
  pending.openai.event({ type: "session.delegation.created", delegation: { id: "pending", target: "client" } });
  void pending.handler.close(); assert.equal(signal.aborted, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.handler.getDelegationResults()[0].status, "aborted");
});
test("wake mode appends checked-in silent-unless-addressed prompt", t => {
  const h = harness(t, { wakeMode: "wake" });
  assert.equal(h.openai.sent[0].session.instructions, h.config.llm.systemPrompt + "\n\n" + fs.readFileSync(require("node:path").join(__dirname, "../docs/research/gpt-live-1-probe/prompts/silent-unless-addressed.txt"), "utf8"));
});
test("availability reports each missing piece and active shares the decision", () => {
  const configPath = require.resolve("../src/config"), resolverPath = require.resolve("../src/settings/resolver"), enginePath = require.resolve("../src/live-openai/live-engine");
  const originals = [configPath, resolverPath, enginePath].map(p => require.cache[p]);
  const previous = process.env.OPENAI_LIVE_API_KEY;
  try {
    const values = { tts_provider: "fish-audio", fish_audio_api_key: "test-key" };
    let referenceId = "test-voice";
    const cfg = { VOICE_ENGINE: "live", TTS_SAMPLE_RATE: 24000, getPipelineConfig: () => ({ tts: { referenceId } }) };
    require.cache[configPath] = { exports: cfg };
    require.cache[resolverPath] = { exports: { getEffectiveValue: k => values[k] } };
    const fresh = () => { delete require.cache[enginePath]; return require(enginePath); };
    delete process.env.OPENAI_LIVE_API_KEY;
    assert.match(fresh().liveEngineAvailable(), /OPENAI_LIVE_API_KEY/);
    process.env.OPENAI_LIVE_API_KEY = "test-key";
    values.tts_provider = "elevenlabs"; assert.match(fresh().liveEngineAvailable(), /provider/);
    values.tts_provider = "fish-audio"; values.fish_audio_api_key = ""; assert.match(fresh().liveEngineAvailable(), /Fish Audio key/);
    values.fish_audio_api_key = "test-key"; referenceId = ""; assert.match(fresh().liveEngineAvailable(), /reference/);
    referenceId = "test-voice"; assert.equal(fresh().liveEngineAvailable(), null); assert.equal(fresh().liveEngineActive(), true);
    cfg.VOICE_ENGINE = "pipeline"; assert.match(fresh().liveEngineAvailable(), /not live/); assert.equal(fresh().liveEngineActive(), false);
  } finally {
    [configPath, resolverPath, enginePath].forEach((p, i) => { require.cache[p] = originals[i]; });
    if (previous === undefined) delete process.env.OPENAI_LIVE_API_KEY; else process.env.OPENAI_LIVE_API_KEY = previous;
  }
});
test("createHandler unset preserves pipeline handler; live missing key warns and falls back", () => {
  for (const mode of ["", "live"]) {
    const script = `
      const assert = require('node:assert/strict');
      const p = require.resolve('./src/pipeline');
      let calls = 0;
      require.cache[p] = { exports: { createPipeline: () => { calls++; return { sendAudio() {}, close() {}, on() {}, handleGatewaySubagentSpawn() {}, handleGatewaySubagentCompletion() {}, handleGatewaySessionReply() {}, handleGatewayAnnounceInjected() {}, getDelegationResults() {}, floorStatus() {}, continueWithoutArbitration() {} }; } } };
      const routes = require('./src/transport-meet/meet-routes');
      const handler = routes._test.createHandler({ id: 'branch-test', config: {} }, {}, () => {});
      assert.equal(calls, 1);
      assert.deepEqual(Object.keys(handler).sort(), ${JSON.stringify(["send", "close", "on", "handleGatewaySubagentSpawn", "handleGatewaySubagentCompletion", "handleGatewaySessionReply", "handleGatewayAnnounceInjected", "getDelegationResults", "floorStatus", "continueWithoutArbitration"].sort())});
    `;
    const env = { ...process.env, TTS_PROVIDER: "fish-audio", OPENAI_LIVE_API_KEY: "" };
    if (mode) env.VOICE_ENGINE = mode; else delete env.VOICE_ENGINE;
    const child = spawnSync(process.execPath, ["-e", script], { cwd: require("node:path").join(__dirname, ".."), env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stdout, /live voice engine \(gpt-live/);
    if (mode) assert.match(child.stderr, /falling back to the pipeline engine/);
  }
});

test("Fish connecting/reconnecting keeps unsent deltas ordered; promotion before open stays warm", t => {
  const h = harness(t, { start: false });
  h.openai.event({ type: "session.started" });
  h.output("最初"); h.output("の続き"); h.clock.advance(600);
  h.fish[0].open();
  assert.deepEqual(h.fish[0].sent.map(e => e.event), ["start", "text", "text", "flush"]);
  h.fish[0].close(); h.output("接続中"); h.output("も転送");
  h.clock.advance(500); const replacement = h.fish.at(-1); replacement.open();
  assert.deepEqual(replacement.sent.slice(1), [{ event: "text", text: "接続中" }, { event: "text", text: "も転送" }]);
  replacement.event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 4) });
  h.clock.advance(520); h.input("割り込みます");
  assert.equal(h.cancellations.length, 1);
  h.output("新しい応答"); h.fish[1].open();
  assert.deepEqual(h.fish[1].sent.map(e => e.event), ["start", "text"]);
  assert.equal(h.fish[1].sent[1].text, "新しい応答");
});
test("gateway spawn/completion are recorded without commentary or backend calls", t => {
  const h = harness(t); const before = h.openai.sent.length;
  h.handler.handleGatewaySubagentSpawn({ childKey: "child" }); h.clock.advance(40);
  h.handler.handleGatewaySubagentCompletion({ childKey: "child" });
  assert.deepEqual(h.handler.getDelegationResults(), [{ id: "gateway-subagent-1", status: "completed", startedAt: 0, finishedAt: 40 }]);
  assert.equal(h.openai.sent.length, before);
});
test("Meet routes live branch disables hub and full-duplex alone bypasses speaking/cooldown gate", () => {
  for (const mode of ["full-duplex", "gated"]) {
    const script = `
      const assert = require('node:assert/strict');
      const { EventEmitter } = require('node:events');
      global.setInterval = () => 1; global.clearInterval = () => {};
      const config = require('./src/config');
      config.HUB_CONFIG = { enabled: true };
      config.getPipelineConfig = () => ({ llm: {}, tts: {}, hub: { enabled: true } });
      let branch = 0, received = [], turn;
      const enginePath = require.resolve('./src/live-openai/live-engine');
      require.cache[enginePath] = { exports: {
        liveEngineAvailable: () => null, liveEngineActive: () => true,
        createLiveEngine(session, state, onAudio, options) {
          assert.equal(Object.hasOwn(options.config, 'hub'), false);
          assert.equal(Object.hasOwn(options, 'hub'), false);
          branch++; turn = state;
          return { send: b => received.push(b), on() {}, close() {} };
        }
      } };
      const routes = require('./src/transport-meet/meet-routes');
      routes._test.meetingSessions.set('echo-test', { id: 'echo-test', config: {}, hubConfig: { enabled: true } });
      const client = new EventEmitter(); client.readyState = 1; client.close = () => {}; client.ping = () => {};
      routes.handleWsConnection(client, { url: '/?sid=echo-test', socket: { remoteAddress: '127.0.0.1' } });
      turn.isAgentSpeaking = true; turn.inputCooldownUntil = Date.now() + 60000;
      client.emit('message', JSON.stringify({ trigger: 'realtime_audio.mixed', data: { chunk: 'AAECAw==' } }));
      assert.equal(branch, 1);
      assert.equal(received.length, ${mode === "full-duplex" ? 1 : 0});
      if (received.length) assert.deepEqual(received[0], Buffer.from([0,1,2,3]));
    `;
    const child = spawnSync(process.execPath, ["-e", script], { cwd: require("node:path").join(__dirname, ".."), env: { ...process.env, VOICE_ENGINE: "live", LIVE_ECHO_MODE: mode, WS_SHARED_TOKEN: "" }, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stderr, /floor arbitration is not available in the live voice engine prototype/);
    assert.doesNotMatch(child.stdout, /Deepgram Voice Agent モード/);
  }
});
