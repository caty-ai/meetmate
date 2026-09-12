"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { encode, decodeOne } = require("../src/live-openai/msgpack-lite");
const engine = require("../src/live-openai/live-engine");
const { conversationInstructions } = require("../src/live-openai/live-backend");
const { stripCanonicalEmotionTags, EMOTION_TAGS } = require("../src/messages");
const { TTS_SAMPLE_RATE } = require("../src/config");

class Clock {
  time = 0; next = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => this.add(fn, ms, 0);
  setInterval = (fn, ms) => this.add(fn, ms, ms);
  clearTimeout = id => this.timers.delete(id);
  clearInterval = id => this.timers.delete(id);
  add(fn, ms, interval) { const id = ++this.next; this.timers.set(id, { fn, at: this.time + ms, interval }); return id; }
  // Simulate one delayed timer delivery, without replaying missed interval ticks.
  jump(ms) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.time) continue;
      if (timer.interval) timer.at = this.time + timer.interval; else this.timers.delete(id);
      timer.fn();
    }
  }
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
  const traceRows = [];
  let openai;
  const config = { llm: { systemPrompt: options.systemPrompt || "configured profile prompt", gateway: { url: "http://gateway.test", token: "test-key" }, openclawSystemAddendum: "voice rules", model: "main", temperature: 0.5, maxTokens: 100 }, tts: { referenceId: "test-voice" } };
  const handler = engine.createLiveEngine({ id: options.id || `test-${++ids}`, sessionUser: "test-user", config: { wakeMode: options.wakeMode || "always" } }, state,
    (pcm, meta) => audio.push({ pcm, meta }), {
      // Existing tests preserve the old transport baseline; sentence-mode tests override this.
      textMode: "legacy",
      trace: { record: (kind, data) => traceRows.push({ kind, ...data }), close: async () => {} },
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
  return { traceRows, clock, fish, audio, errors, cancellations, state, handler, openai, config,
    output: delta => openai.event({ type: "session.output_transcript.delta", delta }),
    input: delta => openai.event({ type: "session.input_transcript.delta", delta }),
  };
}

test("exact session protocol, warm Fish sockets, ordered deltas, flush at 300 not 299", t => {
  const h = harness(t);
  assert.equal(h.openai.url, "wss://api.openai.com/v1/live/sessions");
  assert.deepEqual(h.openai.sent[0], { type: "session.start", event_id: "event_start", session: { model: "gpt-live-1", instructions: conversationInstructions(h.config), audio: { format: { type: "audio/pcm", rate: 16000 }, output: { voice: "quartz" } }, delegation: { type: "client" } } });
  for (const socket of h.fish) {
    assert.equal(socket.url, "wss://api.fish.audio/v1/tts/live");
    assert.equal(socket.options.headers.model, "s2.1-pro");
    assert.deepEqual(socket.sent, [{ event: "start", request: { text: "", reference_id: "test-voice", format: "pcm", sample_rate: TTS_SAMPLE_RATE, latency: "low" } }]);
  }
  for (const text of ["うん", "そう", "途中で", "切れ"]) h.output(text);
  assert.deepEqual(h.fish[0].sent.slice(1), ["うん", "そう", "途中で", "切れ"].map(text => ({ event: "text", text })));
  h.clock.advance(299); assert.equal(h.fish[0].sent.at(-1).event, "text");
  h.clock.advance(1); assert.deepEqual(h.fish[0].sent.at(-1), { event: "flush" });
  h.output("次"); h.clock.advance(299); assert.equal(h.fish[0].sent.at(-1).event, "text");
  h.clock.advance(1); assert.equal(h.fish[0].sent.at(-1).event, "flush");
  const pcm = Buffer.from([0, 1, 2, 3]); h.handler.send(pcm);
  assert.deepEqual(h.openai.sent.at(-1), { type: "session.input_audio.append", audio: pcm.toString("base64") });
  h.openai.event({ type: "session.output_audio.delta", delta: pcm.toString("base64") });
  assert.equal(h.audio.length, 0);
});
test("interruption promotes warm spare, cancels old epoch and rejects late old audio", t => {
  const warnings = []; t.mock.method(console, "warn", line => warnings.push(line));
  const h = harness(t); h.output("応答です");
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 2 * 2, 1) });
  h.clock.advance(520); h.input("待ってください");
  assert.equal(h.fish[0].closes, 1);
  assert.equal(warnings.some(line => line.includes("Fish socket lost")), false);
  assert.equal(h.fish.length, 3);
  assert.deepEqual(h.cancellations, [{ outputEpoch: 0, reason: "interrupted", monotonicTime: 520 }]);
  assert.equal(h.traceRows.find(r => r.kind === "interruption").epoch, 0);
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
test("queue bounded to 15 seconds; output silence never cancels queued or in-flight text", t => {
  assert.equal(engine.SELF_STOP_WATCHDOG_MS, 0);
  const h = harness(t); h.output("長い回答");
  const second = TTS_SAMPLE_RATE * 2;
  h.fish[0].event({ event: "audio", audio: Buffer.concat([Buffer.alloc(second, 1), Buffer.alloc(second * 15, 2)]) });
  assert.deepEqual(h.traceRows.find(r => r.kind === "audio_drop"), { kind: "audio_drop", epoch: 0, bytes: second, sampleRate: TTS_SAMPLE_RATE });
  h.clock.advance(20); assert.equal(h.audio[0].pcm.length, second * engine.LEAD_MS / 1000);
  assert.equal(h.audio[0].pcm[0], 2);
  h.clock.advance(16000);
  assert.equal(h.cancellations.length, 0);
  assert.equal(Buffer.concat(h.audio.map(a => a.pcm)).length, second * 15);
  const flight = harness(t); flight.output("未受信"); flight.clock.advance(5000);
  assert.equal(flight.cancellations.length, 0);
  assert.equal(flight.fish[0].closes, 0);
});
test("normal answer keeps its entire tail after five seconds without input or output deltas", t => {
  const h = harness(t); h.output("回答");
  h.clock.advance(1000);
  const pcm = Buffer.alloc(TTS_SAMPLE_RATE * 2 * 3, 7);
  h.fish[0].event({ event: "audio", audio: pcm });
  h.clock.advance(5000);
  assert.deepEqual(Buffer.concat(h.audio.map(a => a.pcm)), pcm);
  assert.deepEqual(h.cancellations, []);
  assert.equal(h.fish[0].closes, 0);
  assert.equal(h.state.isAgentSpeaking, false);
});
test("wall-clock pacer catches up a delayed tick with 200 ms lead and whole samples", t => {
  assert.equal(engine.LEAD_MS, 200);
  const h = harness(t); h.output("回答");
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 4) });
  h.clock.advance(20);
  assert.equal(h.audio[0].pcm.length, TTS_SAMPLE_RATE * 2 * engine.LEAD_MS / 1000);
  h.clock.jump(60);
  assert.equal(h.audio.length, 2);
  assert.equal(h.audio[1].pcm.length, TTS_SAMPLE_RATE * 2 * 60 / 1000);
  h.clock.jump(23.123);
  const bytes = h.audio.reduce((sum, a) => sum + a.pcm.length, 0);
  assert.equal(bytes, Math.floor((engine.LEAD_MS + 83.123) * TTS_SAMPLE_RATE / 1000) * 2);
  let samples = 0;
  for (const a of h.audio) {
    assert.equal(a.pcm.length % 2, 0);
    assert.equal(a.meta.firstSampleIndex, samples); samples += a.pcm.length / 2;
  }
});
test("resuming an empty queue re-anchors pacing without a silence-sized burst", t => {
  const h = harness(t); h.output("回答");
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 2 / 10) });
  h.clock.advance(20); assert.equal(h.state.isAgentSpeaking, true);
  h.clock.advance(199); assert.equal(h.state.isAgentSpeaking, true);
  h.clock.advance(1); assert.equal(h.state.isAgentSpeaking, false);
  h.clock.advance(5000);
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 4) });
  h.clock.advance(20);
  assert.equal(h.audio[1].pcm.length, TTS_SAMPLE_RATE * 2 * engine.LEAD_MS / 1000);
  assert.equal(h.audio[1].meta.firstSampleIndex, TTS_SAMPLE_RATE / 10);
  assert.equal(h.state.isAgentSpeaking, true);
});
test("latency diagnostics measure the first delta and audio event, and log again for a new utterance", t => {
  const logs = []; t.mock.method(console, "log", line => logs.push(line));
  const h = harness(t); h.output("非公開の文章");
  h.clock.advance(100); h.output("続き"); h.clock.advance(250);
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 2 / 10) });
  h.clock.advance(250);
  h.output("次の文章"); h.clock.advance(50);
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(TTS_SAMPLE_RATE * 2 / 10) });
  h.clock.advance(20);
  assert.deepEqual(logs.filter(line => line.includes("fish first-audio")), [
    "🎙️  live-engine: fish first-audio 350 ms after delta (epoch 0)",
    "🎙️  live-engine: fish first-audio 50 ms after delta (epoch 0)",
  ]);
  assert.deepEqual(logs.filter(line => line.includes(" played ")), [
    "🎙️  live-engine: epoch 0 played 100 ms", "🎙️  live-engine: epoch 0 played 200 ms",
  ]);
  assert.equal(logs.some(line => /非公開|続き|次の文章/.test(line)), false);
});
test("cap at 60 minutes says closing line, drains then closes; recreated handler keeps clock", async t => {
  assert.equal(engine.SESSION_CAP_MS, 3600000);
  const clock = new Clock(), id = `cap-${++ids}`;
  const h = harness(t, { clock, id });
  clock.advance(engine.SESSION_CAP_MS - 1); assert.equal(h.fish[0].sent.length, 1);
  clock.advance(1);
  assert.deepEqual(h.fish[0].sent.slice(1), [{ event: "text", text: "時間の上限に達したので、" }, { event: "flush" }, { event: "text", text: "ここで一度切りますね。" }, { event: "flush" }]);
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
test("Fish error finish logs decoded details before retrying, including an idle spare", t => {
  const warnings = []; t.mock.method(console, "warn", line => warnings.push(line));
  const h = harness(t);
  h.fish[1].event({ event: "finish", reason: "error", message: "empty buffer", time: 1 });
  assert.equal(warnings[0], '⚠️  live-engine: Fish error: {"event":"finish","reason":"error","message":"empty buffer","time":1}');
  assert.match(warnings[1], /Fish socket lost/);
  h.clock.advance(500); h.fish.at(-1).open();
  h.output("回答"); h.clock.advance(600);
  h.fish[0].event({ event: "finish", reason: "error", message: "flush failed" });
  assert.match(warnings[2], /Fish error: .*flush failed/);
  assert.match(warnings[3], /Fish socket lost/);
  assert.deepEqual(h.errors, []);
});
test("idle spare losses consume at most one retry per minute; active losses still consume budget", t => {
  const h = harness(t);
  let spare = h.fish[1];
  for (let i = 0; i < 5; i++) {
    spare.close(); h.clock.advance(500); spare = h.fish.at(-1); spare.open();
  }
  assert.deepEqual(h.errors, []);
  h.clock.advance(60000);
  spare.close(); h.clock.advance(500); h.fish.at(-1).open();
  let active = h.fish[0];
  for (let i = 0; i < 2; i++) {
    active.close(); h.clock.advance(500); active = h.fish.at(-1); active.open();
  }
  assert.deepEqual(h.errors, []);
  active.close(); assert.equal(h.errors.length, 1);
});
test("intentional shutdown retires both Fish sockets without retry warnings", async t => {
  const warnings = []; t.mock.method(console, "warn", line => warnings.push(line));
  const h = harness(t); const done = h.handler.close();
  h.openai.event({ type: "session.closed" }); await done;
  assert.deepEqual(h.fish.map(ws => ws.closes), [1, 1]);
  assert.equal(warnings.some(line => line.includes("Fish socket lost")), false);
  assert.equal(h.clock.timers.size, 0);
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
  assert.equal(calls[0].messages[0].role, "system");
  assert.deepEqual(calls[0].messages.slice(1), [{ role: "user", content: "質問です" }, { role: "assistant", content: "確認します" }]);
  assert.deepEqual({ ...calls[0].options, signal: undefined }, { openclawUrl: "http://gateway.test", openclawToken: "test-key", openclawSystemAddendum: "音声会話中です。短い日本語で回答し、感情タグは付けないでください。", sessionUser: "test-user", model: "main", temperature: 0.5, maxTokens: 100, timeoutMs: 60000, signal: undefined });
  assert.deepEqual(h.openai.sent.at(-1), { type: "session.commentary.append", event_id: "event_1", delegation_id: "d1", content: "調べました" });
  assert.deepEqual(h.traceRows.filter(r => r.kind === "backend"), [{ kind: "backend", text: "調べました", delegationId: "d1", epoch: 0 }]);
  assert.deepEqual(h.handler.getDelegationResults(), [{ id: "d1", status: "completed", startedAt: 0, finishedAt: 0 }]);
  h.handler.handleGatewaySessionReply("返信"); h.handler.handleGatewayAnnounceInjected("通知");
  assert.deepEqual(h.openai.sent.slice(-2).map(e => e.delegation_id), [null, null]);
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
test("wake mode retains the configured identity without injecting Caty", t => {
  const h = harness(t, { wakeMode: "wake", systemPrompt: "あなたはルカ（Luca）。" });
  const instructions = h.openai.sent[0].session.instructions;
  assert.ok(instructions.startsWith(conversationInstructions(h.config)));
  assert.match(instructions, /設定されたあなた自身の名前で呼びかけられた発言にだけ返答/);
  assert.match(instructions, /呼ばれていない間は完全に沈黙/);
  assert.match(instructions, /あなたはルカ（Luca）/);
  assert.match(instructions, /沈黙の指示は相槌の指示より優先/);
  assert.doesNotMatch(instructions, /caty|キャティ|ケイティ/i);
});
test("availability reports each missing piece and active shares the decision", () => {
  const configPath = require.resolve("../src/config"), resolverPath = require.resolve("../src/settings/resolver"), enginePath = require.resolve("../src/live-openai/live-engine");
  const originals = [configPath, resolverPath, enginePath].map(p => require.cache[p]);
  const previous = process.env.OPENAI_LIVE_API_KEY;
  try {
    const values = { tts_provider: "fish-audio", fish_audio_api_key: "test-key" };
    let referenceId = "test-voice";
    const cfg = { VOICE_ENGINE: "live", TTS_SAMPLE_RATE: 24000, getPipelineConfig: () => ({ tts: { referenceId }, llm: { provider: "openclaw", gateway: { url: "http://backend.test", token: "test-key" } } }) };
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
  assert.deepEqual(replacement.sent.slice(1), [{ event: "text", text: "接続中" }, { event: "text", text: "も転送" }, { event: "flush" }]);
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

const fishText = h => h.fish[0].sent.filter(e => e.event === "text").map(e => e.text).join("");
test("split emotion tag never reaches Fish, echo state, or the first-audio clock", t => {
  const logs = [], echoes = [];
  t.mock.method(console, "log", line => logs.push(line));
  const h = harness(t, { engineOptions: { detectInterruption: state => { echoes.push(state.recentOutputText); return false; } } });
  for (const delta of ["[", "so", "ft", " vo", "ice", "]", "こん", "にち", "は。"]) {
    h.output(delta); h.input("確認"); h.clock.advance(200);
  }
  assert.equal(fishText(h), "こんにちは。");
  assert.deepEqual(h.fish[0].sent.slice(-2), [{ event: "text", text: "は。" }, { event: "flush" }]);
  assert.equal(echoes.some(text => /\[|soft|voice/.test(text)), false);
  assert.equal(echoes.at(-1), "こんにちは。");
  h.fish[0].event({ event: "audio", audio: Buffer.alloc(960) });
  assert.equal(logs.find(line => line.includes("fish first-audio")), "🎙️  live-engine: fish first-audio 600 ms after delta (epoch 0)");
});
test("canonical and generous tags collapse leading and internal whitespace seams across deltas", t => {
  for (const { tag } of [...EMOTION_TAGS, { tag: "[smiling]" }]) {
    for (const prefix of ["", "前", "前 "]) {
      const h = harness(t);
      if (prefix) h.output(prefix);
      for (const delta of [tag.slice(0, 2), tag.slice(2), " ", "\t", "後。"]) h.output(delta);
      assert.equal(fishText(h), stripCanonicalEmotionTags(prefix + "[warm] \t後。"));
    }
  }
});
test("a split tag never leaks across either idle or long pauses", t => {
  const h = harness(t); h.output("前[so");
  h.clock.advance(301); assert.equal(fishText(h), "前");
  h.clock.advance(2000); h.output("ft voice]こんにちは。");
  assert.equal(fishText(h), "前こんにちは。");
});
test("idle flush sends ordinary text but holds incomplete tags", t => {
  const h = harness(t); h.output("前[soft");
  h.clock.advance(300);
  assert.deepEqual(h.fish[0].sent.slice(1), [{ event: "text", text: "前" }, { event: "flush" }]);
  const tag = harness(t); tag.output("[warm] "); tag.clock.advance(2000);
  assert.equal(tag.fish[0].sent.length, 1);
});
test("bracket length and sentence punctuation preserve literal groups", t => {
  for (const text of ["[" + "あ".repeat(40), "[" + "a".repeat(39) + "]", "[本文。続き]", "[本文！]", "[本文？]"]) {
    const h = harness(t); h.output(text);
    assert.equal(fishText(h), text);
  }
  const h = harness(t); h.output("[" + "a".repeat(38) + "]本文");
  assert.equal(fishText(h), "本文");
});
test("each punctuation flushes immediately once, including punctuation-only deltas", t => {
  assert.equal(engine.FLUSH_IDLE_MS, 300);
  assert.equal(engine.FLUSH_PUNCTUATION, "、。！？!?");
  const h = harness(t);
  for (const mark of engine.FLUSH_PUNCTUATION) {
    h.output("本文"); const before = h.fish[0].sent.length;
    h.output(mark);
    assert.deepEqual(h.fish[0].sent.slice(before), [{ event: "text", text: mark }, { event: "flush" }]);
  }
  const before = h.fish[0].sent.length; h.output("一、二。続き");
  assert.deepEqual(h.fish[0].sent.slice(before), [{ event: "text", text: "一、" }, { event: "flush" }, { event: "text", text: "二。" }, { event: "flush" }, { event: "text", text: "続き" }]);
  h.clock.advance(300); assert.equal(h.fish[0].sent.at(-1).event, "flush");
  const count = h.fish[0].sent.length; h.clock.advance(1500); assert.equal(h.fish[0].sent.length, count);
});
test("interruption clears held tags and their timers before the next epoch", t => {
  const h = harness(t, { engineOptions: { detectInterruption: () => true } });
  h.output("前[soft"); h.input("中断"); h.output("新しい本文。");
  h.clock.advance(2000);
  assert.equal(fishText(h), "前");
  assert.deepEqual(h.fish[1].sent.slice(1), [{ event: "text", text: "新しい本文。" }, { event: "flush" }]);
  assert.equal(h.cancellations.length, 1);
});
test("close drops an incomplete control tag", async t => {
  const h = harness(t); h.output("[soft"); const done = h.handler.close();
  assert.deepEqual(h.fish[0].sent.slice(1), []);
  h.openai.event({ type: "session.closed" }); await done;
  assert.equal(h.clock.timers.size, 0);
});

test("completed groups normalize whitespace on both sides within a delta", t => {
  const h = harness(t); const text = "前  [warm] \t [thoughtful]   後。";
  h.output(text);
  assert.equal(fishText(h), stripCanonicalEmotionTags(text));
});

test("unclosed literal and nested brackets cannot swallow Japanese speech or the cap", t => {
  const h = harness(t); h.output("価格は[100円です");
  assert.equal(fishText(h), "価格は[100円です");
  const nested = harness(t); nested.output("["); nested.output("はい、[warm]了解しました。");
  assert.equal(fishText(nested), "[はい、了解しました。");
  const cap = harness(t); cap.output("[soft"); cap.clock.advance(engine.SESSION_CAP_MS);
  assert.match(fishText(cap), /時間の上限に達したので/);
  assert.doesNotMatch(fishText(cap), /soft/);
});

test("closed Japanese/numeric brackets preserve speech in one or many deltas", t => {
  for (const parts of [["価格は[100円です]ですよ"], ["価格は[", "100円です", "]ですよ"]]) {
    const h = harness(t); for (const part of parts) h.output(part);
    assert.equal(fishText(h), "価格は[100円です]ですよ");
  }
});

test("text trace separates recognized input, generated output and filtered Fish text", t => {
  const h = harness(t);
  h.input("ルカ、聞こえる？");
  h.output({});
  h.output({ text: "はい、聞こえます。" });
  assert.deepEqual(h.traceRows.filter(r => r.kind === "input").map(r => r.text), ["ルカ、聞こえる？"]);
  assert.deepEqual(h.traceRows.filter(r => r.kind === "live").map(r => r.text), ["はい、聞こえます。"]);
  assert.equal(h.traceRows.filter(r => r.kind === "fish").map(r => r.text).join(""), "はい、聞こえます。");
});

test("voice shutdown does not wait for stalled trace storage", async t => {
  const h = harness(t, { engineOptions: { trace: { record() {}, close: () => new Promise(() => {}) } } });
  const closing = h.handler.close();
  h.openai.event({ type: "session.closed", usage: { seconds: 0 } });
  await closing;
  assert.equal(h.state.isAgentSpeaking, false);
});

test("trace close exceptions cannot reject voice shutdown", async t => {
  const warnings = []; t.mock.method(console, "warn", value => warnings.push(value));
  const h = harness(t, { engineOptions: { trace: { record() {}, close() { throw new Error("disk failure"); } } } });
  const closing = h.handler.close();
  h.openai.event({ type: "session.closed", usage: { seconds: 0 } });
  await closing; await new Promise(resolve => setImmediate(resolve));
  assert.ok(warnings.some(value => value.includes("text trace close failed")));
});

test("default sentence mode never sends fragments on comma or idle timeout", t => {
  const h = harness(t, { engineOptions: { textMode: undefined } });
  h.output("何"); h.clock.advance(300);
  h.output("でも、"); h.clock.advance(3000);
  assert.deepEqual(h.fish[0].sent.map(e => e.event), ["start"]);
  h.output("話して。");
  assert.deepEqual(h.fish[0].sent.slice(1), [{ event: "text", text: "何でも、話して。" }, { event: "flush" }]);
  assert.deepEqual(h.traceRows.filter(r => r.kind === "fish").map(r => r.text), ["何でも、話して。"]);
});

test("sentence mode preserves multiple sentences, filtered tags and punctuationless tail", t => {
  const h = harness(t, { engineOptions: { textMode: undefined } });
  const tag = EMOTION_TAGS[0].tag;
  h.output("こんにちは" + tag.slice(0, 3)); h.clock.advance(1000);
  h.output(tag.slice(3) + "。元気？まだ途中");
  assert.deepEqual(h.fish[0].sent.slice(1), [{ event: "text", text: "こんにちは。" }, { event: "flush" }, { event: "text", text: "元気？" }, { event: "flush" }]);
  h.clock.advance(10000);
  assert.equal(h.fish[0].sent.length, 5);
  void h.handler.close();
  assert.equal(h.fish[0].sent.length, 5);
});

test("sentence mode drops buffered text on interruption and never joins old and new speech", t => {
  const h = harness(t, { engineOptions: { textMode: undefined, detectInterruption: () => true } });
  h.output("古い未完"); h.input("待って"); h.output("新しい回答。");
  assert.deepEqual(h.fish[0].sent.map(e => e.event), ["start"]);
  assert.deepEqual(h.fish[1].sent.slice(1), [{ event: "text", text: "新しい回答。" }, { event: "flush" }]);
});

test("sentence mode cap discards unfinished text before its complete announcement", t => {
  const h = harness(t, { engineOptions: { textMode: undefined } });
  h.output("読まない途中"); h.clock.jump(engine.SESSION_CAP_MS);
  assert.deepEqual(h.fish[0].sent.slice(1), [{ event: "text", text: "時間の上限に達したので、ここで一度切りますね。" }, { event: "flush" }]);
});
