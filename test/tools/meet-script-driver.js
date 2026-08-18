#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { Duplex } = require("node:stream");

const { createDetector } = require("./lib/energy-detector");
const { sendPacedPcm } = require("./lib/pace");
const { ScriptScheduler } = require("./lib/script-scheduler");
const { WavWriter } = require("./lib/wav");

const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;

let wsModule = null;

function getWsModule() {
  if (!wsModule) wsModule = require("ws");
  return wsModule;
}

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function stats(values) {
  if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, max: null };
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function isoPathTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function usage() {
  return `Usage: node test/tools/meet-script-driver.js [options]

Required for a live run:
  --meeting-url <url>       Google Meet URL
  --public-ws-url <wss-url> Public wss URL that Attendee dials out to

Options:
  --script <path>           Script JSON (default: test/tools/script-config.example.json)
  --assets-dir <dir>        PCM assets + manifest.json (default: test/tools/script-assets)
  --out-dir <dir>           Run output (default: test/tools/runs/<ISO timestamp>)
  --bot-name <name>         Attendee name (default: script-driver)
  --port <number>           Local WebSocket server port (default: 8765)
  --attendee-base <host>    Attendee API host (default: ATTENDEE_API_BASE_URL or app.attendee.dev)
  --mask-tail-ms <number>   Self-playback mask tail (default: 300)
  --calibration-max-floor <number>
                            Maximum plausible calibration floor RMS (default: 200)
  --strict-calibration      Abort when calibration exceeds the maximum floor
  --anchor-dbfs <number>    Anchor sine peak level (default: -12)
  --self-test               Run network-free loopback checks
  --help                    Show this help

Mask intervals are half-open [playStart, playEnd + maskTailMs).
Speech edge timestamps use the first frame of the sustained run (run-start).
Barge-in timing: start=onset+300ms, mid=onset+2500ms, late=onset+lateAfterMs
(default 6000ms) and only fires if the subject is still speaking.
audio_monotonic_ms is stream-derived; monotonic_ms is emission time, so they
differ by WebSocket delivery delay. Anchor tones and play_start_to_echo_ms stats
provide the reconciliation path between those clocks.
`;
}

function parseArgs(argv) {
  const args = {
    meetingUrl: null,
    publicWsUrl: null,
    script: path.join(__dirname, "script-config.example.json"),
    assetsDir: path.join(__dirname, "script-assets"),
    outDir: path.join(__dirname, "runs", isoPathTimestamp()),
    botName: "script-driver",
    port: 8765,
    attendeeBase: process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev",
    maskTailMs: 300,
    calibrationMaxFloor: 200,
    strictCalibration: false,
    anchorDbfs: -12,
    selfTest: false,
    help: false,
  };
  const valueFlags = new Map([
    ["--meeting-url", "meetingUrl"],
    ["--public-ws-url", "publicWsUrl"],
    ["--script", "script"],
    ["--assets-dir", "assetsDir"],
    ["--out-dir", "outDir"],
    ["--bot-name", "botName"],
    ["--port", "port"],
    ["--attendee-base", "attendeeBase"],
    ["--mask-tail-ms", "maskTailMs"],
    ["--calibration-max-floor", "calibrationMaxFloor"],
    ["--anchor-dbfs", "anchorDbfs"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--self-test") args.selfTest = true;
    else if (flag === "--strict-calibration") args.strictCalibration = true;
    else if (valueFlags.has(flag)) {
      const value = argv[++i];
      if (value == null) throw new Error(`${flag} requires a value`);
      args[valueFlags.get(flag)] = value;
    } else {
      throw new Error(`unknown option: ${flag}`);
    }
  }
  args.port = Number(args.port);
  args.maskTailMs = Number(args.maskTailMs);
  args.calibrationMaxFloor = Number(args.calibrationMaxFloor);
  args.anchorDbfs = Number(args.anchorDbfs);
  for (const key of ["script", "assetsDir", "outDir"]) args[key] = path.resolve(args[key]);
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error("--port must be 0-65535");
  if (!Number.isFinite(args.maskTailMs) || args.maskTailMs < 0) throw new Error("--mask-tail-ms must be non-negative");
  if (!Number.isFinite(args.calibrationMaxFloor) || args.calibrationMaxFloor < 0) {
    throw new Error("--calibration-max-floor must be non-negative");
  }
  if (!Number.isFinite(args.anchorDbfs) || args.anchorDbfs > 0) throw new Error("--anchor-dbfs must be at most 0");
  if (!args.help && !args.selfTest) {
    if (!args.meetingUrl) throw new Error("--meeting-url is required");
    if (!args.publicWsUrl) throw new Error("--public-ws-url is required");
    if (!String(args.publicWsUrl).startsWith("wss://")) throw new Error("--public-ws-url must use wss://");
  }
  return args;
}

class EventLog {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, "a");
    this.closed = false;
  }

  write(type, fields = {}) {
    if (this.closed) return;
    const event = { wall_ms: Date.now(), monotonic_ms: monotonicMs(), type, ...fields };
    fs.writeSync(this.fd, `${JSON.stringify(event)}\n`);
    return event;
  }

  close() {
    if (this.closed) return;
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.closed = true;
  }
}

function sinePcm(freqHz, durationMs, sampleRate, amplitude) {
  const samples = Math.round(sampleRate * durationMs / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * i / sampleRate)), i * 2);
  }
  return pcm;
}

function loadInputs(args) {
  const scriptRaw = fs.readFileSync(args.script);
  const script = JSON.parse(scriptRaw.toString("utf8"));
  const manifestFile = path.join(args.assetsDir, "manifest.json");
  const manifestRaw = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  if (manifest.sampleRate !== OUTPUT_SAMPLE_RATE) throw new Error(`asset manifest sampleRate must be ${OUTPUT_SAMPLE_RATE}`);
  const assets = new Map();
  for (const [assetId, entry] of Object.entries(manifest.assets || {})) {
    const pcm = fs.readFileSync(path.join(args.assetsDir, entry.file));
    if (pcm.length !== entry.bytes || sha256(pcm) !== entry.sha256) {
      throw new Error(`asset integrity mismatch: ${assetId}`);
    }
    assets.set(assetId, { ...entry, pcm });
  }
  for (const block of script.blocks || []) {
    for (const step of block.steps || []) {
      if ((step.type === "play" || step.type === "bargeIn") && !assets.has(step.assetId)) {
        throw new Error(`asset missing from manifest: ${step.assetId}`);
      }
      if (step.type === "bargeIn") {
        const asset = assets.get(step.assetId);
        const durationSeconds = asset.pcm.length / (manifest.sampleRate * 2);
        if (durationSeconds > 2) {
          throw new Error(`bargeIn asset ${step.assetId} exceeds 2.0 seconds (${durationSeconds.toFixed(3)}s)`);
        }
      }
    }
  }
  return {
    script,
    assets,
    scriptSha256: sha256(scriptRaw),
    manifestSha256: sha256(manifestRaw),
    manifest,
  };
}

function attendeeHost(value) {
  return String(value).replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function attendeeRequest(base, apiKey, requestPath, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const endpoint = new URL(String(base).startsWith("https://") ? String(base) : `https://${base}`);
    const req = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: requestPath,
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let response = "";
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Attendee API ${requestPath} failed (${res.statusCode}): ${response.slice(0, 200)}`));
          return;
        }
        try {
          resolve(response ? JSON.parse(response) : {});
        } catch {
          reject(new Error(`Attendee API ${requestPath} returned invalid JSON`));
        }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error("Attendee API request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function createBot(args, apiKey) {
  return attendeeRequest(args.attendeeBase, apiKey, "/api/v1/bots", {
    meeting_url: args.meetingUrl,
    bot_name: args.botName,
    websocket_settings: { audio: { url: args.publicWsUrl, sample_rate: INPUT_SAMPLE_RATE } },
  });
}

async function leaveBot(args, apiKey, botId) {
  if (!botId) return;
  await attendeeRequest(args.attendeeBase, apiKey, `/api/v1/bots/${botId}/leave`, {});
}

function startWsServer(port, onConnection) {
  return new Promise((resolve, reject) => {
    const { WebSocketServer } = getWsModule();
    const server = new WebSocketServer({ port });
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.once("listening", () => {
      server.removeListener("error", onError);
      server.on("connection", onConnection);
      resolve(server);
    });
  });
}

function closeWsServer(server) {
  if (!server) return Promise.resolve();
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function createMemoryWebSocketTransport(onConnection) {
  const { WebSocket, WebSocketServer } = getWsModule();
  class MemorySocket extends Duplex {
    _read() {}
    _write(chunk, encoding, callback) {
      this.peer.push(Buffer.from(chunk));
      callback();
    }
    _final(callback) {
      this.peer.push(null);
      callback();
    }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
  }

  const clientSocket = new MemorySocket();
  const serverSocket = new MemorySocket();
  clientSocket.peer = serverSocket;
  serverSocket.peer = clientSocket;
  serverSocket.remoteAddress = "in-memory";
  const httpServer = http.createServer();
  const server = new WebSocketServer({ server: httpServer });
  server.on("connection", onConnection);
  httpServer.emit("connection", serverSocket);
  const client = new WebSocket("ws://in-memory/", { createConnection: () => clientSocket });
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return { server, client };
}

async function waitForCalibration(detectors, timeoutMs = 15_000) {
  const deadline = monotonicMs() + timeoutMs;
  while (monotonicMs() < deadline) {
    if (detectors.every((detector) => detector.getStatus().calibrated)) return;
    await delay(100);
  }
  throw new Error(`audio calibration timeout (${timeoutMs}ms)`);
}

function reportCalibrationPlausibility(namedStatuses, options) {
  const contaminated = namedStatuses
    .filter(({ status }) => status.floorRms > options.maxFloorRms)
    .map(({ name, status }) => ({ name, floor_rms: status.floorRms }));
  if (contaminated.length === 0) return null;
  const details = {
    max_floor_rms: options.maxFloorRms,
    strict: Boolean(options.strict),
    detectors: contaminated,
  };
  options.emit("calibration_contaminated", details);
  options.warn(`Warning: calibration_contaminated: floor RMS exceeds ${options.maxFloorRms} (${contaminated.map((entry) => `${entry.name}=${entry.floor_rms}`).join(", ")})\n`);
  if (options.strict) {
    const error = new Error(`calibration contaminated: floor RMS exceeds ${options.maxFloorRms}`);
    error.details = details;
    throw error;
  }
  return details;
}

function maskTailWarningFor(echoDelays, maskTailMs) {
  const p95 = percentile(echoDelays, 0.95);
  if (p95 == null || p95 <= maskTailMs) return null;
  return { play_start_to_echo_ms_p95: p95, mask_tail_ms: maskTailMs };
}

function installTerminationHandlers(onSignal, signalSource = process) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => onSignal(signal);
    handlers.set(signal, handler);
    signalSource.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
  };
}

async function runLive(args) {
  const { WebSocket } = getWsModule();
  const apiKey = process.env.ATTENDEE_API_KEY;
  if (!apiKey) throw new Error("ATTENDEE_API_KEY is required");
  fs.mkdirSync(args.outDir, { recursive: true });
  fs.mkdirSync(path.join(args.outDir, "signals"), { recursive: true });
  const log = new EventLog(path.join(args.outDir, "events.jsonl"));
  const wav = new WavWriter(path.join(args.outDir, "mixed.wav"), { sampleRate: INPUT_SAMPLE_RATE });
  const runStarted = { wall_ms: Date.now(), monotonic_ms: monotonicMs() };
  const anchorAmplitude = Math.round(32767 * Math.pow(10, args.anchorDbfs / 20));
  const gaps = [];
  const echoDelays = [];
  const floorSamples = [];
  const playWindows = [];
  const pendingBarges = new Map();
  let lastChunkArrival = null;
  let botId = null;
  let server = null;
  let client = null;
  let heartbeat = null;
  let scheduler = null;
  let cleanupConnectionWait = () => {};
  let completed = false;
  let shuttingDown = false;
  let abortReason = null;
  let calibrationContamination = null;
  let maskTailWarning = null;
  let interruptReject;
  let lostReject;
  const interrupted = new Promise((resolve, reject) => { interruptReject = reject; });
  const connectionLost = new Promise((resolve, reject) => { lostReject = reject; });
  interrupted.catch(() => {});
  connectionLost.catch(() => {});

  const detectorOptions = { sampleRate: INPUT_SAMPLE_RATE, maskTailMs: args.maskTailMs };
  const subjectDetector = createDetector(detectorOptions);
  const echoDetector = createDetector({ ...detectorOptions, restrictAfterCalibration: true });

  function emit(type, fields = {}) {
    const event = log.write(type, fields);
    if (type === "barge_in_attempt") pendingBarges.set(fields.assetId, event);
    return event;
  }

  function checkMaskTail() {
    if (maskTailWarning) return maskTailWarning;
    maskTailWarning = maskTailWarningFor(echoDelays, args.maskTailMs);
    if (maskTailWarning) {
      emit("mask_tail_warning", maskTailWarning);
      process.stderr.write(`Warning: mask_tail_warning: echo p95 ${maskTailWarning.play_start_to_echo_ms_p95}ms exceeds mask tail ${args.maskTailMs}ms\n`);
    }
    return maskTailWarning;
  }

  function detectorEvents(pcm, arrivalMs) {
    const subjectEvents = subjectDetector.feed(pcm, arrivalMs);
    const echoEvents = echoDetector.feed(pcm, arrivalMs);
    for (const event of subjectEvents) {
      emit(event.type === "onset" ? "energy_onset" : "energy_offset", {
        audio_monotonic_ms: event.tMs,
        rms: event.rms,
        ...(event.censored ? { censored: true } : {}),
      });
      scheduler?.handleDetectorEvent(event);
    }
    for (const event of echoEvents) {
      const play = [...playWindows].reverse().find((entry) => event.tMs >= entry.startMs && event.tMs < entry.windowEndMs);
      const fields = {
        audio_monotonic_ms: event.tMs,
        rms: event.rms,
        ...(play ? { assetId: play.assetId } : {}),
        ...(event.censored ? { censored: true } : {}),
      };
      if (event.type === "onset" && play && !play.echoObserved) {
        play.echoObserved = true;
        const delayMs = event.tMs - play.startMs;
        echoDelays.push(delayMs);
        checkMaskTail();
        fields.play_start_to_echo_ms = delayMs;
        const barge = pendingBarges.get(play.assetId);
        if (barge) {
          fields.cancel_latency_anchor = true;
          fields.barge_in_attempt_monotonic_ms = barge.monotonic_ms;
          pendingBarges.delete(play.assetId);
        }
      }
      emit(event.type === "onset" ? "echo_onset" : "echo_offset", fields);
    }
  }

  function attachClient(ws) {
    if (client && client.readyState === WebSocket.OPEN) {
      ws.close(1013, "driver already connected");
      return;
    }
    client = ws;
    ws.isAlive = true;
    emit("ws_open");
    ws.on("pong", () => { ws.isAlive = true; });
    heartbeat = setInterval(() => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }, 30_000);
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.trigger !== "realtime_audio.mixed" || !message?.data?.chunk) return;
      const arrival = monotonicMs();
      if (lastChunkArrival != null) gaps.push(arrival - lastChunkArrival);
      lastChunkArrival = arrival;
      let pcm;
      try { pcm = Buffer.from(message.data.chunk, "base64"); } catch { return; }
      if (pcm.length === 0 || pcm.length % 2 !== 0) return;
      wav.append(pcm);
      detectorEvents(pcm, arrival);
    });
    ws.on("close", (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      emit("ws_close", { code, reason: reason.toString(), abort: !shuttingDown && !completed });
      if (!shuttingDown && !completed) lostReject(new Error(`WebSocket closed (${code})`));
    });
    ws.on("error", (error) => {
      if (!shuttingDown) lostReject(new Error(`WebSocket error: ${error.message}`));
    });
  }

  function onTermination(signal) {
    scheduler?.abort(signal);
    interruptReject(new Error(signal));
  }
  const removeTerminationHandlers = installTerminationHandlers(onTermination);
  emit("run_start", { meeting_url: args.meetingUrl, public_ws_url: args.publicWsUrl });

  let inputs;
  try {
    inputs = loadInputs(args);
    server = await startWsServer(args.port, attachClient);
    const connection = new Promise((resolve, reject) => {
      let timeout;
      let poll;
      cleanupConnectionWait = () => {
        clearInterval(poll);
        clearTimeout(timeout);
      };
      timeout = setTimeout(() => {
        cleanupConnectionWait();
        reject(new Error("Attendee WebSocket connection timeout (120000ms)"));
      }, 120_000);
      poll = setInterval(() => {
        if (client?.readyState === WebSocket.OPEN) {
          cleanupConnectionWait();
          resolve();
        }
      }, 50);
    });
    const bot = await createBot(args, apiKey);
    if (!bot.id) throw new Error("Attendee create response did not include id");
    botId = bot.id;
    emit("bot_created", { bot_id: botId });
    await Promise.race([connection, interrupted]);
    await Promise.race([waitForCalibration([subjectDetector, echoDetector]), interrupted, connectionLost]);
    try {
      calibrationContamination = reportCalibrationPlausibility([
        { name: "subject", status: subjectDetector.getStatus() },
        { name: "echo", status: echoDetector.getStatus() },
      ], {
        maxFloorRms: args.calibrationMaxFloor,
        strict: args.strictCalibration,
        emit,
        warn: (message) => process.stderr.write(message),
      });
    } catch (error) {
      calibrationContamination = error.details;
      throw error;
    }

    async function playPcm(assetId, pcm, metadata = {}, signal) {
      if (!client || client.readyState !== WebSocket.OPEN) throw new Error("Attendee WebSocket is not open");
      const startMs = monotonicMs();
      const durationMs = pcm.length * 1000 / (OUTPUT_SAMPLE_RATE * 2);
      const endMs = startMs + durationMs;
      subjectDetector.mask(startMs, endMs);
      echoDetector.include(startMs, endMs + args.maskTailMs);
      const window = { assetId, startMs, endMs, windowEndMs: endMs + args.maskTailMs, echoObserved: false };
      playWindows.push(window);
      const digest = sha256(pcm);
      emit("play_start", { assetId, pcm_sha256: digest, bytes: pcm.length, ...metadata });
      const paced = await sendPacedPcm({
        pcm,
        signal,
        send: async (chunk) => {
          client.send(JSON.stringify({
            trigger: "realtime_audio.bot_output",
            data: { chunk: chunk.toString("base64"), sample_rate: OUTPUT_SAMPLE_RATE },
          }));
        },
      });
      emit("play_end", {
        assetId,
        pcm_sha256: digest,
        bytes: pcm.length,
        send_count: paced.sendCount,
        duration_ms: paced.durationMs,
        max_lead_ms: paced.maxAheadMs,
        ...metadata,
      });
    }

    scheduler = new ScriptScheduler({
      now: monotonicMs,
      waitSignalDir: path.join(args.outDir, "signals"),
      onEvent(event) {
        const { type, ...fields } = event;
        emit(type, fields);
        if (fields.blockId === "B4" && fields.stepType === "waitMs" && type === "step_start") {
          subjectDetector.beginFloorResample(`B4-step-${fields.stepIndex}`);
        } else if (fields.blockId === "B4" && fields.stepType === "waitMs" && type === "step_end") {
          const sample = subjectDetector.endFloorResample();
          if (sample) {
            floorSamples.push(sample);
            emit("noise_floor_sample", { blockId: "B4", stepIndex: fields.stepIndex, ...sample });
          }
        }
      },
      playAsset: async (assetId, metadata, signal) => {
        const asset = inputs.assets.get(assetId);
        await playPcm(assetId, asset.pcm, metadata, signal);
      },
      playTone: async (freqHz, durationMs, metadata, signal) => {
        const pcm = sinePcm(freqHz, durationMs, OUTPUT_SAMPLE_RATE, anchorAmplitude);
        await playPcm(`anchor-${freqHz}hz-${metadata.repetition}`, pcm, metadata, signal);
      },
      sendChat: async (text) => {
        // attendee-chat reads the base URL at module load and the API key at
        // call time. Keep this assignment beside the lazy require; revisit if
        // src/attendee-chat.js changes either coupling.
        process.env.ATTENDEE_API_BASE_URL = attendeeHost(args.attendeeBase);
        const { sendAttendeeChatMessage } = require("../../src/attendee-chat.js");
        return sendAttendeeChatMessage(botId, text, apiKey);
      },
    });
    await Promise.race([scheduler.run(inputs.script), interrupted, connectionLost]);
    emit("run_end", { completed: true });
    completed = true;
  } catch (error) {
    abortReason = error.message;
    scheduler?.abort(abortReason);
    emit("run_abort", { reason: abortReason });
  } finally {
    shuttingDown = true;
    cleanupConnectionWait();
    removeTerminationHandlers();
    if (heartbeat) clearInterval(heartbeat);
    try { await leaveBot(args, apiKey, botId); } catch (error) { emit("bot_leave_error", { message: error.message }); }
    if (client && client.readyState !== WebSocket.CLOSED) client.terminate();
    await closeWsServer(server);
    wav.close();
    checkMaskTail();
    const ended = { wall_ms: Date.now(), monotonic_ms: monotonicMs() };
    const header = {
      version: 2,
      args: {
        meetingUrl: args.meetingUrl,
        publicWsUrl: args.publicWsUrl,
        script: args.script,
        assetsDir: args.assetsDir,
        outDir: args.outDir,
        botName: args.botName,
        port: args.port,
        attendeeBase: args.attendeeBase,
        calibrationMaxFloor: args.calibrationMaxFloor,
        strictCalibration: args.strictCalibration,
      },
      script_sha256: inputs?.scriptSha256 ?? null,
      asset_manifest_sha256: inputs?.manifestSha256 ?? null,
      asset_sample_rate: inputs?.manifest?.sampleRate ?? null,
      detector: subjectDetector.getStatus(),
      edge_convention: "run-start",
      time_base: {
        audio_monotonic_ms: "stream-derived audio time",
        monotonic_ms: "event emission time; includes WebSocket delivery delay",
        reconciliation: "anchor tones and play_start_to_echo_ms statistics",
      },
      calibration_contaminated: calibrationContamination || false,
      floor_resamples: floorSamples,
      mask_intervals: "half-open [startMs, endMs + maskTailMs)",
      anchor_tone: { frequency_hz: 1000, amplitude: anchorAmplitude, dbfs: args.anchorDbfs },
      echo_return_delay_ms: stats(echoDelays),
      mask_tail_warning: maskTailWarning || false,
      chunk_arrival_gap_ms: stats(gaps),
      started: runStarted,
      ended,
      abort_reason: abortReason,
      completed,
      operator: { subject_env_snapshot: "", tunnel_type: "", tunnel_endpoint: args.publicWsUrl || "" },
    };
    fs.writeFileSync(path.join(args.outDir, "run-header.json"), `${JSON.stringify(header, null, 2)}\n`);
    log.close();
  }
  return completed ? 0 : 1;
}

async function runSelfTest() {
  const { WebSocket } = getWsModule();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "meet-script-driver-self-test-"));
  const log = new EventLog(path.join(outDir, "events.jsonl"));
  const wav = new WavWriter(path.join(outDir, "mixed.wav"), { sampleRate: INPUT_SAMPLE_RATE });
  const subject = createDetector({ sampleRate: INPUT_SAMPLE_RATE, calibrationMs: 200, onsetFrames: 2, offsetFrames: 2, minThreshold: 120, maskTailMs: 300 });
  const echo = createDetector({ sampleRate: INPUT_SAMPLE_RATE, calibrationMs: 200, onsetFrames: 2, offsetFrames: 2, minThreshold: 120, maskTailMs: 300 });
  const observed = [];
  let serverClient;
  let fake;
  let interval;
  let subjectBurst = false;
  const echoQueue = [];
  let sampleCursor = 0;

  function record(type, fields = {}) {
    observed.push(log.write(type, fields));
  }

  function attachServer(ws) {
    serverClient = ws;
    record("ws_open");
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.trigger !== "realtime_audio.mixed") return;
      const pcm = Buffer.from(message.data.chunk, "base64");
      wav.append(pcm);
      const arrival = monotonicMs();
      for (const event of subject.feed(pcm, arrival)) record(`energy_${event.type}`, { audio_monotonic_ms: event.tMs });
      for (const event of echo.feed(pcm, arrival)) record(`echo_${event.type}`, { audio_monotonic_ms: event.tMs });
    });
  }

  let server = null;
  try {
    server = await startWsServer(0, attachServer);
    const port = server.address().port;
    fake = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      fake.once("open", resolve);
      fake.once("error", reject);
    });
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    process.stdout.write("INFO: socket listen unavailable; using in-memory WebSocket server transport\n");
    const memory = await createMemoryWebSocketTransport(attachServer);
    server = memory.server;
    fake = memory.client;
  }
  fake.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.trigger !== "realtime_audio.bot_output") return;
    const input = Buffer.from(message.data.chunk, "base64");
    const inputSamples = input.length / 2;
    const outputSamples = Math.floor(inputSamples * INPUT_SAMPLE_RATE / message.data.sample_rate);
    const resampled = Buffer.alloc(outputSamples * 2);
    for (let i = 0; i < outputSamples; i += 1) {
      const sourceIndex = Math.min(inputSamples - 1, Math.floor(i * message.data.sample_rate / INPUT_SAMPLE_RATE));
      resampled.writeInt16LE(input.readInt16LE(sourceIndex * 2), i * 2);
    }
    echoQueue.push({ dueMs: monotonicMs() + 150, pcm: resampled, offset: 0 });
  });

  interval = setInterval(() => {
    if (fake.readyState !== WebSocket.OPEN) return;
    const frame = Buffer.alloc(INPUT_SAMPLE_RATE * 2 * 20 / 1000);
    const now = monotonicMs();
    if (subjectBurst) {
      for (let i = 0; i < frame.length / 2; i += 1) {
        frame.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * 1000 * sampleCursor / INPUT_SAMPLE_RATE)), i * 2);
        sampleCursor += 1;
      }
    } else {
      sampleCursor += frame.length / 2;
      let outputOffset = 0;
      while (outputOffset < frame.length && echoQueue[0]?.dueMs <= now) {
        const entry = echoQueue[0];
        const bytes = Math.min(frame.length - outputOffset, entry.pcm.length - entry.offset);
        entry.pcm.copy(frame, outputOffset, entry.offset, entry.offset + bytes);
        entry.offset += bytes;
        outputOffset += bytes;
        if (entry.offset >= entry.pcm.length) echoQueue.shift();
      }
    }
    fake.send(JSON.stringify({ trigger: "realtime_audio.mixed", data: { chunk: frame.toString("base64") } }));
  }, 20);

  const checks = [];
  function check(name, condition) {
    checks.push({ name, condition: Boolean(condition) });
    process.stdout.write(`${condition ? "PASS" : "FAIL"}: ${name}\n`);
  }

  try {
    const deadline = monotonicMs() + 2000;
    while ((!subject.getStatus().calibrated || !echo.getStatus().calibrated) && monotonicMs() < deadline) await delay(20);
    echo.restrictToWindows(true);
    subjectBurst = true;
    await delay(180);
    subjectBurst = false;
    await delay(180);
    check("subject onset detected for synthetic 1 kHz burst", observed.some((event) => event.type === "energy_onset"));
    check("echo pass ignores audio outside playback windows", !observed.some((event) => event.type === "echo_onset"));

    const playback = sinePcm(700, 500, OUTPUT_SAMPLE_RATE, 6000);
    const playStart = monotonicMs();
    const playEnd = playStart + 500;
    subject.mask(playStart, playEnd);
    echo.include(playStart, playEnd + 300);
    const subjectOnsetsBefore = observed.filter((event) => event.type === "energy_onset").length;
    const echoOnsetsBefore = observed.filter((event) => event.type === "echo_onset").length;
    const paced = await sendPacedPcm({
      pcm: playback,
      send: async (chunk) => serverClient.send(JSON.stringify({
        trigger: "realtime_audio.bot_output",
        data: { chunk: chunk.toString("base64"), sample_rate: OUTPUT_SAMPLE_RATE },
      })),
    });
    await delay(500);
    const subjectOnsetsAfter = observed.filter((event) => event.type === "energy_onset").length;
    check("masked self-playback produces no subject onset", subjectOnsetsAfter === subjectOnsetsBefore);
    check("echo detector observes echoed playback", observed.filter((event) => event.type === "echo_onset").length > echoOnsetsBefore);
    check("paced sender stays within 200 ms lead", paced.maxAheadMs <= 200);
    wav.close();
    log.close();
    check("WAV written", fs.statSync(path.join(outDir, "mixed.wav")).size > 44);
    check("JSONL written", fs.readFileSync(path.join(outDir, "events.jsonl"), "utf8").trim().length > 0);
  } finally {
    clearInterval(interval);
    if (!wav.closed) wav.close();
    if (!log.closed) log.close();
    fake.terminate();
    await closeWsServer(server);
  }
  const passed = checks.every((entry) => entry.condition);
  process.stdout.write(`${passed ? "SELF-TEST PASS" : "SELF-TEST FAIL"}: ${outDir}\n`);
  return passed ? 0 : 1;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(usage());
      return 0;
    }
    if (args.selfTest) return await runSelfTest();
    return await runLive(args);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module && process.env.NODE_TEST_CONTEXT === undefined) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  EventLog,
  installTerminationHandlers,
  loadInputs,
  main,
  maskTailWarningFor,
  parseArgs,
  reportCalibrationPlausibility,
  runSelfTest,
  sendPacedPcm,
  sinePcm,
  stats,
  usage,
};
