"use strict";

const { EventEmitter } = require("node:events");
// Identity and wake instructions use the configured profile.
// Keep credential-source inventory line positions stable.
const { performance } = require("node:perf_hooks");
const WebSocket = require("ws");
const { VOICE_ENGINE, TTS_SAMPLE_RATE, getPipelineConfig } = require("../config");
const { getEffectiveValue } = require("../settings/resolver");
const { backendUnavailable, conversationInstructions, runLiveBackend } = require("./live-backend");
const { encode, decodeOne } = require("./msgpack-lite");

const FLUSH_IDLE_MS = 300;
const MAX_QUEUED_AUDIO_MS = 15000;
const SESSION_CAP_MS = 60 * 60 * 1000;
const sessionStarts = new Map();
// Read only when checking/starting a session, never at module load or on a
// publicly inspectable handler/config. This is the sole direct credential read.
function liveCredential() { return process.env.OPENAI_LIVE_API_KEY; }
const { scrubLogMessage } = require("../log-scrub");
const { createLiveTrace } = require("./live-trace");
const { EMOTION_TAGS, stripCanonicalEmotionTags } = require("../messages");
const SEAM_TAG = EMOTION_TAGS.find(({ fallback }) => fallback).tag;
const FLUSH_PUNCTUATION = "、。！？!?";
// Disabled: output silence is normal while Fish is still producing the tail.
// If enabled, only a lack of Fish audio while text is in flight is a stall.
const SELF_STOP_WATCHDOG_MS = 0;
const LEAD_MS = 200;
function liveEngineAvailable() {
  if (VOICE_ENGINE !== "live") return "VOICE_ENGINE is not live";
  if (!liveCredential()?.trim()) return "OPENAI_LIVE_API_KEY is missing";
  if (getEffectiveValue("tts_provider") !== "fish-audio") return "Fish Audio is not the selected TTS provider";
  if (!getEffectiveValue("fish_audio_api_key")?.trim()) return "Fish Audio key is missing";
  if (!getPipelineConfig().tts.referenceId?.trim()) return "Fish reference id is missing";
  return backendUnavailable(getPipelineConfig());
}
function liveEngineActive() { return VOICE_ENGINE === "live" && !liveEngineAvailable(); }

function detectInterruption(state, inputDelta) {
  const text = inputDelta.text || "";
  state.inputDeltas += 1;
  state.inputChars += Array.from(text).length;
  return state.pending && text.length > 0 && !state.recentOutputText.includes(text)
    && (state.inputDeltas >= 2 || state.inputChars >= 4)
    && state.firstAudioAt !== null && state.now - state.firstAudioAt >= 500;
}

function createLiveEngine(session, turnState, onAudio, options = {}) {
  const config = options.config || getPipelineConfig({}, null, options.profile);
  const now = options.now || (() => performance.now());
  const trace = options.trace || createLiveTrace(session.id, { now });
  const later = options.setTimeout || setTimeout, every = options.setInterval || setInterval;
  const cancelLater = options.clearTimeout || clearTimeout, cancelEvery = options.clearInterval || clearInterval;
  const openaiFactory = options.openaiSocketFactory || ((...args) => new WebSocket(...args));
  const fishFactory = options.fishSocketFactory || ((...args) => new WebSocket(...args));
  const emitter = new EventEmitter(), timers = new Set(), intervals = new Set();
  const delegations = new Map(), gatewayRecords = new Map(), turns = [], retries = [];
  const state = { pending: false, recentOutputText: "", inputDeltas: 0, inputChars: 0, firstAudioAt: null, now: now() };
  let openai, active, spare, started = false, closing = false, closed = false, failed = false, capped = false;
  let currentEpoch = 0, sampleOffset = 0, sequence = 0, gatewaySequence = 0;
  let queue = [], queuedBytes = 0, firstDeltaAt = null, firstAudioLogged = false, emptySince = null, overflowEpoch = null;
  let playheadMs = 0, epochStartedAt = null, lastIdleSpareRetryAt = null;
  let holdBuffer = "", seam = null, lastTextChar = "", unflushed = false;
  let flushTimer, startupTimer, closeTimer, closeResolve, closePromise;
  let instructions = conversationInstructions(config);
  if (session.config?.wakeMode === "wake") {
    instructions += "\n\nこの会話には複数の人がいます。設定されたあなた自身の名前で呼びかけられた発言にだけ返答してください。"
      + "呼ばれていない間は完全に沈黙し、相槌も打たないでください。この沈黙の指示は相槌の指示より優先します。";
  }
  const timeout = (fn, ms) => {
    const timer = later(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer;
  };
  const clear = (timer) => { cancelLater(timer); timers.delete(timer); };
  const safeClose = (socket) => { try { socket?.close(); } catch { /* Already gone. */ } };
  function fishSend(socket, event) {
    if (!socket || (socket.retired && !socket.reconnecting)) return;
    if (!socket.ready || socket.reconnecting) { socket.pending.push(event); return; }
    try { socket.ws.send(encode(event), (error) => { if (error) fishLost(socket); }); }
    catch { fishLost(socket); }
  }
  function sendEvent(event) {
    if (closed || failed || openai?.readyState !== WebSocket.OPEN) return;
    try { openai.send(JSON.stringify(event), error => { if (error) fail("OpenAI send failed"); }); }
    catch { fail("OpenAI send failed"); }
  }
  function cleanup() {
    if (closed) return;
    closed = true;
    holdBuffer = ""; seam = null;
    for (const timer of timers) cancelLater(timer);
    for (const timer of intervals) cancelEvery(timer);
    timers.clear(); intervals.clear();
    for (const row of delegations.values()) row.controller?.abort();
    // stop is terminal on Fish; it is never used for an interruption.
    if (active?.ready && !active.retired) fishSend(active, { event: "stop" });
    if (active) active.retired = true;
    if (spare) spare.retired = true;
    safeClose(active?.ws); safeClose(spare?.ws); safeClose(openai);
    queue = []; queuedBytes = 0; turnState.isAgentSpeaking = false;
    // Storage must not hold voice shutdown open, even on a stalled disk.
    void Promise.resolve().then(() => trace.close()).catch(() => console.warn("⚠️  live-engine: text trace close failed"));
    closeResolve?.();
  }
  function fail(reason) {
    if (failed || closed) return;
    failed = true;
    trace.record("error", { reason: scrubLogMessage(reason) });
    console.error(`❌  live-engine: ${reason}`);
    cleanup();
    emitter.emit("engine_error", { message: reason });
  }
  function close() {
    if (closePromise) return closePromise;
    if (closed) return Promise.resolve();
    closing = true;
    closePromise = new Promise(resolve => { closeResolve = resolve; });
    clear(startupTimer); clear(flushTimer);
    flush();
    for (const row of delegations.values()) row.controller?.abort();
    closeTimer = timeout(() => fail("Timed out waiting for session.closed"), 10000);
    sendEvent({ type: "session.close" });
    return closePromise;
  }
  function recordTurn(role, text) {
    if (turns.at(-1)?.role === role) turns.at(-1).content += text;
    else turns.push({ role, content: text });
    if (turns.length > 12) turns.shift();
  }
  function commentary(id, content) {
    if (!started || closing || capped) return;
    sendEvent({ type: "session.commentary.append", event_id: `event_${++sequence}`, delegation_id: id, content });
  }
  async function delegate(delegation) {
    if (delegation.target !== "client" || typeof delegation.id !== "string") return;
    const id = delegation.id;
    if (delegations.has(id)) { console.warn("⚠️  live-engine: duplicate delegation id ignored"); return; }
    const controller = new AbortController();
    const row = { id, status: "pending", startedAt: now(), finishedAt: null, controller };
    delegations.set(id, row);
    const startedAt = now();
    let firstResult = true;
    try {
      await runLiveBackend(config, turns, session.sessionUser, controller.signal, content => {
        if (firstResult) {
          console.log(`🎙️  live-engine: backend first-result ${Math.round(now() - startedAt)} ms`);
          firstResult = false;
        }
        trace.record("backend", { text: content, delegationId: id, epoch: currentEpoch });
        commentary(id, content);
      }, options.streamChat);
      row.status = controller.signal.aborted ? "aborted" : "completed";
    } catch {
      row.status = controller.signal.aborted ? "aborted" : "error";
      if (!controller.signal.aborted) {
        console.warn("⚠️  live-engine: backend request failed");
        commentary(id, "確認できませんでした。もう一度聞いてもらえる？");
      }
    }
    row.finishedAt = now();
  }

  function recordGateway(event, completed) {
    if (closed || closing) return;
    const key = event?.childKey || event?.id || `anonymous-${++gatewaySequence}`;
    const previous = gatewayRecords.get(key);
    gatewayRecords.set(key, {
      id: previous?.id || `gateway-subagent-${++gatewaySequence}`,
      status: completed ? "completed" : "pending",
      startedAt: previous?.startedAt ?? now(),
      finishedAt: completed ? now() : null,
    });
    console.log(`🎙️  live-engine: gateway subagent ${completed ? "completed" : "spawned"}`);
  }
  function pending() { return queuedBytes > 0 || Boolean(active?.inFlight); }
  // Only incomplete bracket groups wait; ordinary speech streams immediately.
  function filterText() {
    let output = "";
    const append = text => {
      if (seam !== null) {
        const whitespace = text.match(/^[ \t]*/)[0];
        seam += whitespace;
        text = text.slice(whitespace.length);
        if (!text) return;
        // Sentinels retain an internal seam while the shared normalizer trims
        // a leading tag. Already-sent whitespace cannot be sent a second time.
        const left = output.at(-1) || lastTextChar;
        const prefix = left && !/[ \t]/.test(left) ? "x" : "";
        output += stripCanonicalEmotionTags(prefix + seam + "x").slice(prefix.length, -1);
        seam = null;
      }
      output += text;
    };
    while (holdBuffer) {
      const start = holdBuffer.indexOf("[");
      if (start < 0) { append(holdBuffer); holdBuffer = ""; break; }
      append(holdBuffer.slice(0, start)); holdBuffer = holdBuffer.slice(start);
      // A nested opening bracket cannot belong to one control tag. Preserve
      // the preceding literal instead of swallowing it with the next tag.
      const nested = holdBuffer.indexOf("[", 1), end = holdBuffer.indexOf("]");
      if (nested >= 0 && (end < 0 || nested < end)) {
        append(holdBuffer.slice(0, nested)); holdBuffer = holdBuffer.slice(nested); continue;
      }
      if (end >= 0) {
        const group = holdBuffer.slice(0, end + 1);
        if (EMOTION_TAGS.some(({ tag }) => tag === group)
            || (Array.from(group).length <= 40 && /^\[[a-zA-Z ,_-]+\]$/.test(group))) {
          // Normalize generous control tags through the canonical seam rules too.
          const whitespace = output.match(/[ \t]*$/)[0];
          output = output.slice(0, output.length - whitespace.length);
          seam = (seam || "") + whitespace + SEAM_TAG;
        } else append(group);
        holdBuffer = holdBuffer.slice(end + 1);
      } else if (Array.from(holdBuffer).length > 40 || !/^\[[a-zA-Z ,_-]*$/.test(holdBuffer)) {
        append(holdBuffer); holdBuffer = "";
      } else {
        break;
      }
    }
    return output;
  }
  function flushFish() {
    if (!unflushed) return;
    fishSend(active, { event: "flush" }); unflushed = false;
  }
  function emitFiltered(text) {
    if (!text) return;
    if (firstDeltaAt === null || !pending()) {
      firstDeltaAt = now(); firstAudioLogged = false;
    }
    // Split only at punctuation so every occurrence flushes its preceding text.
    const parts = text.match(/[^、。！？!?]*[、。！？!?]|[^、。！？!?]+$/gu) || [];
    for (const part of parts) {
      trace.record("fish", { text: part, epoch: currentEpoch });
      fishSend(active, { event: "text", text: part });
      active.inFlight = true; active.textSerial += 1; unflushed = true;
      state.recentOutputText = Array.from(state.recentOutputText + part).slice(-40).join("");
      lastTextChar = part.at(-1);
      if (FLUSH_PUNCTUATION.includes(lastTextChar)) flushFish();
    }
  }
  function flush() {
    clear(flushTimer);
    emitFiltered(filterText());
    flushFish();
  }
  function forward(text) {
    state.inputDeltas = 0; state.inputChars = 0;
    holdBuffer += text;
    emitFiltered(filterText());
    clear(flushTimer);
    if (unflushed || holdBuffer || seam !== null) flushTimer = timeout(flush, FLUSH_IDLE_MS);
  }
  function interrupt() {
    if (closed || closing || capped) return;
    const cancelled = currentEpoch;
    trace.record("interruption", { epoch: cancelled, droppedBytes: queuedBytes });
    currentEpoch += 1;
    clear(flushTimer);
    holdBuffer = ""; seam = null; lastTextChar = ""; unflushed = false;
    if (active) { active.retired = true; active.reconnecting = false; safeClose(active.ws); }
    active = spare; spare = null;
    if (active) active.epoch = currentEpoch;
    else active = openFish(currentEpoch);
    queue = []; queuedBytes = 0; sampleOffset = 0; emptySince = null;
    state.firstAudioAt = null; state.inputDeltas = 0; state.inputChars = 0;
    state.recentOutputText = ""; firstDeltaAt = null; firstAudioLogged = false;
    playheadMs = 0; epochStartedAt = null;
    turnState.isAgentSpeaking = false;
    spare = openFish(null);
    emitter.emit("playback_cancelled", { outputEpoch: cancelled, reason: "interrupted", monotonicTime: now() });
  }
  function fishLost(socket) {
    if (socket.retired || closed || closing) return;
    socket.retired = true; socket.reconnecting = true; safeClose(socket.ws);
    while (retries.length && now() - retries[0] >= 60000) retries.shift();
    const idleSpare = socket === spare && !pending();
    if (!idleSpare || lastIdleSpareRetryAt === null || now() - lastIdleSpareRetryAt >= 60000) {
      if (retries.length >= 3) { fail("Fish reconnect budget exhausted"); return; }
      retries.push(now());
      if (idleSpare) lastIdleSpareRetryAt = now();
    }
    console.warn("⚠️  live-engine: Fish socket lost; retrying in 500 ms");
    timeout(() => {
      if (closed || closing) return;
      if (socket === active) {
        active = openFish(currentEpoch);
        // Preserve unsent deltas only; replaying already-sent text duplicates speech.
        active.pending.push(...socket.pending);
        active.inFlight = socket.pending.some(e => e.event === "text");
        active.textSerial = socket.textSerial;
      } else if (socket === spare) spare = openFish(null);
    }, 500);
  }
  function openFish(epoch) {
    const socket = { epoch, reconnecting: false, ready: false, retired: false, pending: [], odd: Buffer.alloc(0), inFlight: false, textSerial: 0, audioSerial: -1, lastAudioAt: null };
    try {
      socket.ws = fishFactory("wss://api.fish.audio/v1/tts/live", {
        headers: { Authorization: `Bearer ${getEffectiveValue("fish_audio_api_key")}`, model: "s2.1-pro" },
        handshakeTimeout: 15000,
      });
    } catch { timeout(() => fishLost(socket), 0); return socket; }
    socket.ws.on("open", () => {
      if (closed || socket.retired) { socket.retired = true; safeClose(socket.ws); return; }
      socket.ready = true;
      fishSend(socket, { event: "start", request: { text: "", reference_id: config.tts.referenceId, format: "pcm", sample_rate: TTS_SAMPLE_RATE, latency: "low" } });
      for (const event of socket.pending.splice(0)) fishSend(socket, event);
    });
    const lost = detail => {
      if (socket.retired || closed || closing) return;
      const role = socket === active ? "active" : "spare";
      console.warn(`⚠️  live-engine: Fish ${role} ${detail}`);
      fishLost(socket);
    };
    socket.ws.on("error", error => lost(`error ${scrubLogMessage(error?.message || "unknown")}`));
    socket.ws.on("close", (code, reason) => lost(`close code=${code ?? "unknown"} reason=${scrubLogMessage(reason?.toString() || "")}`));
    socket.ws.on("message", raw => {
      if (closed || socket.retired) return;
      try {
        const event = decodeOne(Buffer.from(raw));
        const type = event.event?.toString("utf8");
        if (type === "audio") {
          if (socket !== active || socket.epoch !== currentEpoch || !Buffer.isBuffer(event.audio)) return;
          if (event.audio.length && firstDeltaAt !== null && !firstAudioLogged) {
            console.log(`🎙️  live-engine: fish first-audio ${Math.round(now() - firstDeltaAt)} ms after delta (epoch ${currentEpoch})`);
            firstAudioLogged = true;
          }
          const bytes = Buffer.concat([socket.odd, event.audio]);
          socket.odd = bytes.subarray(bytes.length - bytes.length % 2);
          const pcm = bytes.subarray(0, bytes.length - bytes.length % 2);
          socket.lastAudioAt = now(); socket.audioSerial = socket.textSerial;
          if (pcm.length) { queue.push({ epoch: socket.epoch, pcm }); queuedBytes += pcm.length; }
          const limit = TTS_SAMPLE_RATE * 2 * MAX_QUEUED_AUDIO_MS / 1000;
          if (queuedBytes > limit) trace.record("audio_drop", { epoch: currentEpoch, bytes: queuedBytes - limit, sampleRate: TTS_SAMPLE_RATE });
          while (queuedBytes > limit) {
            const first = queue[0], excess = queuedBytes - limit;
            const drop = Math.min(first.pcm.length, excess);
            first.pcm = first.pcm.subarray(drop); queuedBytes -= drop;
            if (!first.pcm.length) queue.shift();
            if (overflowEpoch !== currentEpoch) { console.warn("⚠️  live-engine: audio queue limit; dropping oldest audio"); overflowEpoch = currentEpoch; }
          }
        } else if (type === "finish") {
          if (event.reason?.toString("utf8") === "error") {
            const decoded = JSON.stringify(event, (_key, value) =>
              value?.type === "Buffer" ? Buffer.from(value.data).toString("utf8") : value);
            console.warn(`⚠️  live-engine: Fish error: ${decoded}`);
            fishLost(socket);
          }
          else { socket.inFlight = false; console.log("🎙️  live-engine: Fish finish"); }
        } else console.log("🎙️  live-engine: unrecognized Fish event");
      } catch { fail("Invalid Fish frame"); }
    });
    return socket;
  }
  function tick() {
    if (closed) return;
    const time = now();
    // Fish has no per-flush completion event. After received audio drains and
    // stays quiet for 200 ms, consider that batch complete; new text keeps it live.
    if (!queuedBytes && active?.lastAudioAt !== null && active?.audioSerial === active?.textSerial
        && time - active.lastAudioAt >= 200) active.inFlight = false;
    if (SELF_STOP_WATCHDOG_MS > 0 && !capped && !closing && active?.inFlight && firstDeltaAt !== null
        && time - Math.max(firstDeltaAt, active.lastAudioAt ?? firstDeltaAt) >= SELF_STOP_WATCHDOG_MS) interrupt();
    // Re-anchor after an empty queue: elapsed silence must not become catch-up audio.
    if (queuedBytes && epochStartedAt === null) epochStartedAt = time - playheadMs;
    const dueMs = epochStartedAt === null ? 0 : Math.max(0, time - epochStartedAt - playheadMs + LEAD_MS);
    const parts = []; let remaining = Math.min(queuedBytes, Math.floor(dueMs * TTS_SAMPLE_RATE / 1000) * 2);
    while (queue.length && remaining > 0) {
      const entry = queue[0];
      if (entry.epoch !== currentEpoch) { queuedBytes -= entry.pcm.length; queue.shift(); continue; }
      const n = Math.min(remaining, entry.pcm.length);
      parts.push(entry.pcm.subarray(0, n)); entry.pcm = entry.pcm.subarray(n);
      remaining -= n; queuedBytes -= n;
      if (!entry.pcm.length) queue.shift();
    }
    if (parts.length) {
      emptySince = queuedBytes ? null : time; turnState.isAgentSpeaking = true;
      if (state.firstAudioAt === null) state.firstAudioAt = time;
      const buffer = Buffer.concat(parts), firstSampleIndex = sampleOffset;
      sampleOffset += buffer.length / 2;
      playheadMs = sampleOffset * 1000 / TTS_SAMPLE_RATE;
      if (!queuedBytes) {
        epochStartedAt = null;
        console.log(`🎙️  live-engine: epoch ${currentEpoch} played ${Math.round(playheadMs)} ms`);
      }
      onAudio(buffer, { outputEpoch: currentEpoch, firstSampleIndex, sampleRate: TTS_SAMPLE_RATE });
    } else if (!queuedBytes) {
      epochStartedAt = null;
      if (emptySince === null) emptySince = time;
      if (time - emptySince >= 200) turnState.isAgentSpeaking = false;
    }
  }
  function cap() {
    if (closed || closing || capped) return;
    capped = true; clear(flushTimer);
    holdBuffer = ""; seam = null;
    flush();
    forward("時間の上限に達したので、ここで一度切りますね。");
    flush();
    const deadline = now() + 5000;
    const drain = () => {
      if (closed || closing) return;
      if (!pending() || now() >= deadline) { void close(); return; }
      timeout(drain, 20);
    };
    timeout(drain, 20);
  }
  try {
    openai = openaiFactory("wss://api.openai.com/v1/live/sessions", {
      headers: { Authorization: `Bearer ${liveCredential()}` }, handshakeTimeout: 15000,
    });
    startupTimer = timeout(() => fail("Timed out waiting for session.started"), 20000);
    openai.on("open", () => {
      if (closed || closing) return;
      sendEvent({ type: "session.start", event_id: "event_start", session: {
        model: "gpt-live-1", instructions,
        audio: { format: { type: "audio/pcm", rate: 16000 }, output: { voice: "quartz" } },
        delegation: { type: "client" },
      } });
    });
    openai.on("error", () => fail("OpenAI socket error"));
    openai.on("close", () => { if (!closed) fail("OpenAI socket closed before session.closed"); });
    openai.on("message", raw => {
      if (closed) return;
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === "session.closed") {
          const seconds = Number(event.usage?.seconds) || 0;
          console.log(`🎙️  live-engine: usage.seconds=${seconds} estimated_usd=${seconds / 60 * 0.05}`);
          clear(closeTimer); cleanup(); return;
        }
        if (event.type === "error") { fail("OpenAI server error"); return; }
        if (closing) return;
        if (event.type === "session.started") {
          if (started) return;
          started = true; clear(startupTimer);
          if (!sessionStarts.has(session.id)) sessionStarts.set(session.id, now());
          active = openFish(currentEpoch); spare = openFish(null);
          intervals.add(every(tick, 20));
          timeout(cap, Math.max(0, SESSION_CAP_MS - (now() - sessionStarts.get(session.id))));
        } else if (started && !capped && event.type === "session.output_transcript.delta") {
          const text = typeof event.delta === "string" ? event.delta : event.delta?.text || "";
          if (!text) return;
          trace.record("live", { text, epoch: currentEpoch });
          recordTurn("assistant", text); forward(text);
        } else if (started && !capped && event.type === "session.input_transcript.delta") {
          const text = typeof event.delta === "string" ? event.delta : event.delta?.text || "";
          trace.record("input", { text, epoch: currentEpoch });
          recordTurn("user", text);
          if (turnState.isAgentSpeaking) console.log(`🪞  live-engine echo-check: ${JSON.stringify(text)}`);
          state.pending = pending(); state.now = now();
          if ((options.detectInterruption || detectInterruption)(state, { text })) interrupt();
        } else if (started && !capped && event.type === "session.delegation.created") void delegate(event.delegation || {});
        else if (event.type === "session.usage.updated") console.log(`🎙️  live-engine: usage.seconds=${Number(event.usage?.seconds) || 0}`);
        // session.output_audio.delta is deliberately discarded.
      } catch { fail("Invalid OpenAI event"); }
    });
  } catch { timeout(() => fail("OpenAI connection failed"), 0); }
  return {
    send: buf => { if (started && !closing && !capped) sendEvent({ type: "session.input_audio.append", audio: buf.toString("base64") }); },
    close,
    on: emitter.on.bind(emitter),
    handleGatewaySubagentSpawn: event => recordGateway(event, false),
    handleGatewaySubagentCompletion: event => recordGateway(event, true),
    handleGatewaySessionReply: text => commentary(null, text),
    handleGatewayAnnounceInjected: text => commentary(null, text),
    getDelegationResults: () => [...delegations.values(), ...gatewayRecords.values()].map(({ id, status, startedAt, finishedAt }) => ({ id, status, startedAt, finishedAt })),
    floorStatus: () => ({ enabled: false, engine: "live" }),
    continueWithoutArbitration: () => {},
  };
}
module.exports = { createLiveEngine, liveEngineAvailable, liveEngineActive, detectInterruption, FLUSH_IDLE_MS, FLUSH_PUNCTUATION, MAX_QUEUED_AUDIO_MS, SESSION_CAP_MS, SELF_STOP_WATCHDOG_MS, LEAD_MS };
