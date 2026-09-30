#!/usr/bin/env node
"use strict";

// Offline A/V sync analyzer for #266 (not shipped). Compares the audio RMS envelope of a
// recording with the video luminance of the flash face package (brightness follows `level`)
// and reports the A/V offset (median/p10/p90) and drift over the recording.
//
//   node analyze.js --video recording.mp4            (needs ffmpeg on PATH)
//   node analyze.js --wav audio.wav --luma luma.csv  (CSV rows: time_s,luma)
//   node analyze.js --wav audio.wav --onsets         (audio burst onsets, for the §2.8(b) latency probe)
//   node analyze.js --selftest
//
// Sign: offsetMs = video time - audio time for the same event. Positive = the face is late.

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const HOP_S = 0.005; // envelope resolution
const SMOOTH_S = 0.1; // matches the 100 ms server envelope windows
const WINDOW_S = 10;
const STEP_S = 2;
const MAX_LAG_S = 0.5;
const MIN_PEAK = 0.3;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (["selftest", "onsets"].includes(name)) args[name] = true;
    else args[name] = argv[++i];
  }
  return args;
}

function readWav(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let format = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = { code: bytes.readUInt16LE(body), channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format) throw new Error("data chunk before fmt chunk");
      return decodePcm(bytes.subarray(body, body + size), format);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function decodePcm(data, { code, channels, rate, bits }) {
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * width;
      if (code === 1 && bits === 16) sum += data.readInt16LE(at) / 32768;
      else if (code === 3 && bits === 32) sum += data.readFloatLE(at);
      else throw new Error(`unsupported WAV format ${code}/${bits}`);
    }
    samples[i] = sum / channels;
  }
  return { samples, rate };
}

function readLumaCsv(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const [time, luma] = line.split(",").map(Number);
    if (Number.isFinite(time) && Number.isFinite(luma)) rows.push({ time, luma });
  }
  if (rows.length < 2) throw new Error("luma CSV needs time_s,luma rows");
  return rows.sort((a, b) => a.time - b.time);
}

function readVideo(file) {
  const audio = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"],
    { maxBuffer: 1 << 30 });
  if (audio.status !== 0) throw new Error(`ffmpeg audio extraction failed: ${audio.stderr}`);
  const pcm = audio.stdout;
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  const video = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-an", "-vf",
    "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (video.status !== 0) throw new Error(`ffmpeg luminance extraction failed: ${video.stderr}`);
  const rows = [];
  let time = null;
  for (const line of video.stdout.split("\n")) {
    const pts = /pts_time:([0-9.]+)/.exec(line);
    if (pts) time = Number(pts[1]);
    const yavg = /YAVG=([0-9.]+)/.exec(line);
    if (yavg && time !== null) rows.push({ time, luma: Number(yavg[1]) });
  }
  return { audio: { samples, rate: 48000 }, luma: rows };
}

function meanSquares({ samples, rate }) {
  const hop = Math.round(rate * HOP_S);
  const count = Math.floor(samples.length / hop);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) sum += samples[j] * samples[j];
    out[i] = sum / hop;
  }
  return out;
}

// RMS envelope on a HOP_S grid, then a SMOOTH_S boxcar (used for onsets).
function audioEnvelope(audio) {
  return boxcar(meanSquares(audio).map(Math.sqrt), Math.round(SMOOTH_S / HOP_S));
}

// The face shows one level per 100 ms envelope window, held for the window. The window phase
// relative to the recording is unknown, so build the held RMS envelope for every phase.
function steppedEnvelopes(audio) {
  const squares = meanSquares(audio);
  const width = Math.round(SMOOTH_S / HOP_S);
  const phases = [];
  for (let phase = 0; phase < width; phase++) {
    const out = new Float64Array(squares.length);
    for (let start = phase - width; start < squares.length; start += width) {
      const from = Math.max(0, start), to = Math.min(squares.length, start + width);
      if (to <= from) continue;
      let sum = 0;
      for (let i = from; i < to; i++) sum += squares[i];
      const level = Math.sqrt(sum / (to - from));
      for (let i = from; i < to; i++) out[i] = level;
    }
    phases.push(out);
  }
  return phases;
}

function boxcar(values, width) {
  const out = new Float64Array(values.length);
  const half = Math.floor(width / 2);
  let sum = 0;
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) { sum += values[i]; prefix[i + 1] = sum; }
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half), to = Math.min(values.length, i + half + 1);
    out[i] = (prefix[to] - prefix[from]) / (to - from);
  }
  return out;
}

// Frame luminance linearly interpolated between frames on the same grid. A frame-hold would add
// a systematic half-frame lag; interpolation leaves a phase-dependent residual of at most ±1/2 frame.
function lumaSeries(rows, count) {
  const out = new Float64Array(count);
  let index = 0;
  for (let i = 0; i < count; i++) {
    const time = i * HOP_S;
    while (index + 1 < rows.length && rows[index + 1].time <= time) index++;
    const current = rows[index], next = rows[index + 1];
    out[i] = next && time > current.time
      ? current.luma + (next.luma - current.luma) * (time - current.time) / (next.time - current.time)
      : current.luma;
  }
  return out;
}

function correlationAt(a, b, start, length, lag) {
  let sumA = 0, sumB = 0, n = 0;
  for (let i = start; i < start + length; i++) {
    const j = i + lag;
    if (j < 0 || j >= b.length) continue;
    sumA += a[i]; sumB += b[j]; n++;
  }
  if (n < length / 2) return -1;
  const meanA = sumA / n, meanB = sumB / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = start; i < start + length; i++) {
    const j = i + lag;
    if (j < 0 || j >= b.length) continue;
    const da = a[i] - meanA, db = b[j] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  return varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : -1;
}

function percentile(sorted, p) {
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

function analyze(audio, lumaRows) {
  const phases = steppedEnvelopes(audio);
  const smooth = audioEnvelope(audio);
  const count = smooth.length;
  const luma = lumaSeries(lumaRows, count);
  const length = Math.round(WINDOW_S / HOP_S), step = Math.round(STEP_S / HOP_S), maxLag = Math.round(MAX_LAG_S / HOP_S);
  const windows = [];
  for (let start = 0; start + length <= count; start += step) {
    // Coarse lag on the smooth envelope, then the joint (window phase, lag) search around it.
    let coarse = 0, coarseBest = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag += 2) {
      const score = correlationAt(smooth, luma, start, length, lag);
      if (score > coarseBest) { coarseBest = score; coarse = lag; }
    }
    let best = -Infinity, bestLag = 0, envelope = smooth;
    for (const candidate of phases) {
      for (let lag = Math.max(-maxLag, coarse - 30); lag <= Math.min(maxLag, coarse + 30); lag++) {
        const score = correlationAt(candidate, luma, start, length, lag);
        if (score > best) { best = score; bestLag = lag; envelope = candidate; }
      }
    }
    const scores = new Map([-1, 0, 1].map((d) => [bestLag + d, correlationAt(envelope, luma, start, length, bestLag + d)]));
    if (best < MIN_PEAK || Math.abs(bestLag) === maxLag) continue;
    // Parabolic interpolation around the peak for sub-hop resolution.
    const left = scores.get(bestLag - 1), right = scores.get(bestLag + 1);
    const denominator = left - 2 * best + right;
    const refined = denominator < 0 ? bestLag + 0.5 * (left - right) / denominator : bestLag;
    windows.push({ centerS: (start + length / 2) * HOP_S, offsetMs: refined * HOP_S * 1000, peak: best });
  }
  if (windows.length < 2) throw new Error("not enough correlated windows; is the flash package on screen and the reply audible?");
  const sorted = windows.map((w) => w.offsetMs).sort((a, b) => a - b);
  // Theil-Sen slope: robust to the occasional mis-locked window.
  const slopes = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const dt = windows[j].centerS - windows[i].centerS;
      if (dt >= WINDOW_S) slopes.push((windows[j].offsetMs - windows[i].offsetMs) / dt);
    }
  }
  slopes.sort((a, b) => a - b);
  const durationS = count * HOP_S;
  const medianMs = percentile(sorted, 0.5);
  const driftMsPerMin = slopes.length ? percentile(slopes, 0.5) * 60 : 0;
  return {
    durationS: round(durationS), windows: windows.length,
    offsetMs: { median: round(medianMs), p10: round(percentile(sorted, 0.1)), p90: round(percentile(sorted, 0.9)) },
    driftMsPerMin: round(driftMsPerMin),
    doneWhen3: { longEnough: durationS >= 60, medianWithin40ms: Math.abs(medianMs) <= 40, driftWithin5msPerMin: Math.abs(driftMsPerMin) <= 5 },
  };
}

function onsets(audio, { thresholdRatio = 0.2, quietS = 0.3 } = {}) {
  const envelope = audioEnvelope(audio);
  const peak = envelope.reduce((max, v) => Math.max(max, v), 0);
  const threshold = peak * thresholdRatio;
  const out = [];
  let quiet = Math.round(quietS / HOP_S);
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] < threshold) { quiet++; continue; }
    if (quiet >= Math.round(quietS / HOP_S)) out.push(round(i * HOP_S * 1000));
    quiet = 0;
  }
  return { thresholdRatio, onsetsMs: out };
}

const round = (value) => Math.round(value * 10) / 10;

// ---- self-test: synthetic recording with a known offset and drift --------

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthetic({ seconds, offsetMs, driftMsPerMin, seed, rate = 16000, fps = 29.97 }) {
  const random = mulberry32(seed);
  const samples = new Float32Array(seconds * rate);
  // Replies of 4-12 s separated by 0.4-2 s of silence. Each reply is a new output epoch, so its
  // 100 ms envelope windows restart at the reply's first sample (as on the server).
  // Inside a reply: speech-like bursts, 80-600 ms on, 60-500 ms off, varying loudness.
  const gain = new Float32Array(samples.length);
  const replyStarts = [];
  for (let reply = Math.round(rate * 0.5); reply < samples.length;) {
    const end = Math.min(samples.length, reply + Math.round(rate * (4 + random() * 8)));
    replyStarts.push(reply);
    for (let at = reply; at < end;) {
      const on = Math.round(rate * (0.08 + random() * 0.52)), off = Math.round(rate * (0.06 + random() * 0.44));
      const loud = 0.2 + random() * 0.7;
      for (let i = at; i < Math.min(end, at + on); i++) gain[i] = loud;
      at += on + off;
    }
    reply = end + Math.round(rate * (0.4 + random() * 1.6));
  }
  for (let i = 0; i < samples.length; i++) samples[i] = gain[i] * Math.sin(2 * Math.PI * 220 * i / rate) * (0.7 + 0.3 * random());
  const width = Math.round(0.1 * rate);
  const windowLevel = (time) => {
    const sample = Math.floor(time * rate);
    if (sample < 0) return 0;
    let replyStart = 0;
    for (const start of replyStarts) if (start <= sample) replyStart = start;
    const from = replyStart + Math.floor((sample - replyStart) / width) * width;
    let sum = 0, n = 0;
    for (let i = from; i < Math.min(samples.length, from + width); i++) { sum += samples[i] ** 2; n++; }
    return n ? Math.sqrt(sum / n) : 0;
  };
  // The face shows that level late by offset + drift; the camera samples it at the frame rate.
  const luma = [];
  for (let frame = 0; frame < Math.floor(seconds * fps); frame++) {
    const time = frame / fps;
    const lateS = (offsetMs + driftMsPerMin * time / 60) / 1000;
    luma.push({ time, luma: 16 + 219 * Math.min(1, windowLevel(time - lateS) * 1.4) + (random() - 0.5) * 2 });
  }
  return { audio: { samples, rate }, luma };
}

function selftest() {
  // 60 fps capture. Tolerances: median ±6 ms, drift ±4 ms/min (see README "Resolution").
  const cases = [
    { seconds: 90, offsetMs: 80, driftMsPerMin: 20, seed: 266, fps: 60 },
    { seconds: 75, offsetMs: -60, driftMsPerMin: 0, seed: 1266, fps: 60 },
    { seconds: 120, offsetMs: 5, driftMsPerMin: -4, seed: 9, fps: 60 },
  ];
  for (const input of cases) {
    const { audio, luma } = synthetic(input);
    const result = analyze(audio, luma);
    const expectedMedian = input.offsetMs + input.driftMsPerMin * (input.seconds / 2) / 60;
    const medianError = Math.abs(result.offsetMs.median - expectedMedian);
    const driftError = Math.abs(result.driftMsPerMin - input.driftMsPerMin);
    console.log(JSON.stringify({ input, result: { offsetMs: result.offsetMs, driftMsPerMin: result.driftMsPerMin, windows: result.windows } }));
    if (medianError > 6 || driftError > 4 || !result.doneWhen3.longEnough) {
      console.error(`selftest: FAIL (median error ${medianError} ms, drift error ${driftError} ms/min)`);
      return 1;
    }
  }
  console.log("selftest: ok");
  return 0;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.selftest) return selftest();
  if (args.video) {
    const { audio, luma } = readVideo(args.video);
    console.log(JSON.stringify(analyze(audio, luma), null, 2));
    return 0;
  }
  if (args.wav && args.onsets) {
    console.log(JSON.stringify(onsets(readWav(args.wav)), null, 2));
    return 0;
  }
  if (args.wav && args.luma) {
    console.log(JSON.stringify(analyze(readWav(args.wav), readLumaCsv(args.luma)), null, 2));
    return 0;
  }
  console.error("usage: analyze.js --video FILE | --wav FILE --luma FILE.csv | --wav FILE --onsets | --selftest");
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { analyze, onsets, synthetic, readWav, readLumaCsv };
