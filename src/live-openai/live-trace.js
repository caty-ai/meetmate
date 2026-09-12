"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { logsDir } = require("../paths");

const LABELS = {
  input: "入力音声の認識文（話者の本人確認なし）",
  live: "Liveが生成した返答文",
  backend: "Hermesの回答（読み上げ前）",
  fish: "Fishに渡した文章（実際の再生保証なし）",
};

function createLiveTrace(sessionId, options = {}) {
  const warn = options.warn || (() => console.warn("⚠️  live-engine: text trace unavailable or incomplete"));
  const now = options.now || (() => performance.now());
  const start = now();
  let seq = 0, stopped = false, closing = false, closePromise;
  let json, readable, previous = "";
  const fail = () => {
    if (stopped) return;
    stopped = true; warn();
    json?.destroy(); readable?.destroy();
  };
  let filePath;
  try {
    const dir = options.directory || logsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = path.join(dir, `live-text-${randomUUID()}`);
    filePath = base + ".jsonl";
    json = fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 });
    readable = fs.createWriteStream(base + ".txt", { flags: "wx", mode: 0o600 });
    json.on("error", fail); readable.on("error", fail);
    readable.write("Live text trace — 音声の録音ではありません。入力は音声認識結果です。\n各段階の全文を記録します。Fishの文章も、そのまま聞こえた保証はありません。\n");
  } catch { fail(); }
  function record(kind, data = {}) {
    if (stopped || closing) return;
    // Bound diagnostics memory if storage cannot keep up. Voice continues.
    if (json.writableLength + readable.writableLength > 1024 * 1024) { fail(); return; }
    const row = { seq: ++seq, ms: Math.round(now() - start), kind, ...data };
    json.write(JSON.stringify(row) + "\n");
    const group = `${kind}:${data.epoch ?? ""}:${data.delegationId ?? ""}`;
    if (LABELS[kind] && typeof data.text === "string") {
      if (previous !== group) readable.write(`\n\n[${row.ms}ms / ${LABELS[kind]} / epoch ${data.epoch ?? "-"}]\n`);
      readable.write(data.text);
    } else readable.write(`\n\n[${row.ms}ms / ${kind}] ${JSON.stringify(data)}\n`);
    previous = LABELS[kind] && typeof data.text === "string" ? group : "";
  }
  record("start", { sessionId, timestamp: new Date().toISOString() });
  return {
    filePath,
    record,
    close() {
      if (closePromise) return closePromise;
      record("end"); closing = true;
      closePromise = Promise.all([json, readable].map(stream => new Promise(resolve => {
        if (!stream || stream.closed) { resolve(); return; }
        stream.once("close", resolve);
        if (!stream.destroyed) stream.end();
      })));
      return closePromise;
    },
  };
}

module.exports = { createLiveTrace };
