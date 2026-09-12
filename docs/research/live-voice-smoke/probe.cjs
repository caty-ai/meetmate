#!/usr/bin/env node
"use strict";
// Explicit local smoke only: never starts the Meet server or creates a bot.
// Usage: AI_MEET_HOME=... node probe.cjs backend|audio NEW_OUTPUT_DIR [pcm16.wav]
const fs = require("node:fs"), path = require("node:path");
const { performance } = require("node:perf_hooks");
const WebSocket = require("ws");
const home = process.env.AI_MEET_HOME;
if (!home) throw new Error("AI_MEET_HOME is required");
require("dotenv").config({ path: path.join(home, ".env"), quiet: true });
const { getPipelineConfig, TTS_SAMPLE_RATE } = require("../../../src/config");
const { createLiveEngine } = require("../../../src/live-openai/live-engine");
const { runLiveBackend, backendUnavailable } = require("../../../src/live-openai/live-backend");
const { createLlmProvider } = require("../../../src/llm-provider");
const { decodeOne } = require("../../../src/live-openai/msgpack-lite");
const [mode, out, input] = process.argv.slice(2);
if (!["backend", "audio"].includes(mode) || !out) throw new Error("Use backend|audio NEW_OUTPUT_DIR [pcm16.wav]");
const config = getPipelineConfig();
const problem = backendUnavailable(config); if (problem) throw new Error(problem);
fs.mkdirSync(out); // Never overwrite an earlier recording.
const start = performance.now(), rows = [], audio = [], received = [];
const sessionUser = `meet-live253-smoke-${Date.now()}-caty`;
const mark = (kind, data = {}) => { const row = { ms: Math.round(performance.now() - start), kind, ...data }; rows.push(row); console.log(JSON.stringify(row)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function wave(pcm, rate) {
  const h = Buffer.alloc(44); h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function readWave(file) {
  const b = fs.readFileSync(file); let pcm;
  if (b.toString("ascii", 0, 4) !== "RIFF") throw new Error("Expected WAV");
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4), n = b.readUInt32LE(at + 4);
    if (id === "fmt " && (b.readUInt16LE(at + 8) !== 1 || b.readUInt16LE(at + 10) !== 1 || b.readUInt32LE(at + 12) !== 16000 || b.readUInt16LE(at + 22) !== 16)) throw new Error("Expected PCM16 mono 16 kHz");
    if (id === "data") pcm = b.subarray(at + 8, at + 8 + n);
    at += 8 + n + n % 2;
  }
  if (!pcm || pcm.length > 16000 * 2 * 15) throw new Error("Input must be at most 15 seconds");
  return pcm;
}
async function main() {
  if (mode === "backend") {
    const turns = [{ role: "user", content: "音声接続の短いテストです。ツールや外部操作は使わず、あなたの名前と、この会話だけの合言葉『青いりんご』を、一文で返してください。" }];
    for (let turn = 1; turn <= 2; turn++) {
      const parts = []; mark("backend_start", { turn, model: config.llm.model });
      await runLiveBackend(config, turns, sessionUser, AbortSignal.timeout(30000), text => { parts.push(text); mark("backend_result", { turn, text }); });
      turns.push({ role: "assistant", content: parts.join("") }, { role: "user", content: "今の合言葉は何でしたか？ツールを使わず一言で教えて。" });
    }
    return;
  }
  const pcm = readWave(input), proof = "みずいろのこねこ";
  let started, handler, deadline;
  const ready = new Promise(resolve => { started = resolve; });
  const provider = createLlmProvider({ provider: config.llm.provider });
  const pendingText = [];
  handler = createLiveEngine({ id: sessionUser, sessionUser, config: { wakeMode: "wake" } }, {}, (b, metadata) => {
    audio.push(Buffer.from(b)); mark("playback", { bytes: b.length, epoch: metadata.outputEpoch });
  }, {
    config,
    openaiSocketFactory: (...args) => {
      const ws = new WebSocket(...args);
      ws.on("message", raw => {
        const e = JSON.parse(raw);
        if (e.type === "session.started") started(true);
        if (/transcript.delta$/.test(e.type)) mark(e.type, { text: e.delta });
        if (e.type === "session.delegation.created") mark("delegation", { id: e.delegation?.id });
        if (e.type === "session.closed") mark("closed", { seconds: e.usage?.seconds });
        if (e.type === "error") mark("live_error", { code: e.error?.code });
      });
      ws.on("close", () => started(false)); return ws;
    },
    fishSocketFactory: (...args) => {
      const ws = new WebSocket(...args), original = ws.send.bind(ws);
      ws.send = (raw, ...rest) => {
        const e = decodeOne(raw), kind = e.event?.toString();
        if (kind === "text") { const text = e.text.toString(); pendingText.push(text); mark("fish_text", { text }); }
        return original(raw, ...rest);
      };
      ws.on("message", raw => { const e = decodeOne(raw); if (e.event?.toString() === "audio") received.push(Buffer.from(e.audio)); });
      return ws;
    },
    streamChat: async function* (messages, options) {
      mark("backend_start", { model: options.model });
      // Only the real backend sees this nonce. Its appearance in Live speech
      // proves a result returned across the actual client-delegation route.
      const context = [{ role: "system", content: `接続試験です。ツールは使わないでください。確認コードを聞かれたら「${proof}」とだけ答えてください。` }, ...messages];
      for await (const chunk of provider.streamChat(context, options)) { mark("backend_chunk", { text: chunk }); yield chunk; }
      mark("backend_done");
    },
  });
  handler.on("engine_error", e => mark("engine_error", e));
  handler.on("playback_cancelled", e => mark("cancelled", e));
  deadline = setTimeout(() => { void handler.close(); }, 55000);
  try {
    if (!await ready) throw new Error("Live did not start");
    mark("input_start");
    const inputAt = performance.now();
    for (let offset = 0; offset < pcm.length; offset += 640) {
      handler.send(pcm.subarray(offset, offset + 640));
      await sleep(Math.max(0, inputAt + (offset + 640) / 32 - performance.now()));
    }
    mark("input_end");
    for (let n = 0; n < 140; n++) { handler.send(Buffer.alloc(3200)); await sleep(100); }
    for (let n = 0; n < 100; n++) {
      if (rows.some(r => r.kind === "backend_done") && audio.length) break;
      handler.send(Buffer.alloc(3200)); await sleep(100);
    }
    for (let n = 0; n < 80; n++) { handler.send(Buffer.alloc(3200)); await sleep(100); }
  } finally {
    await handler.close(); clearTimeout(deadline);
    fs.writeFileSync(path.join(out, "played.wav"), wave(Buffer.concat(audio), TTS_SAMPLE_RATE));
    fs.writeFileSync(path.join(out, "fish-received.wav"), wave(Buffer.concat(received), TTS_SAMPLE_RATE));
    mark("summary", { audioBytes: audio.reduce((n, b) => n + b.length, 0), proofReturned: rows.filter(r => r.kind === "backend_chunk").map(r => r.text).join("").includes(proof), proofSpoken: pendingText.join("").includes(proof) });
  }
}
main().catch(error => { mark("failed", { name: error.name, code: error.code }); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(out, "trace.json"), JSON.stringify(rows, null, 2));
});
