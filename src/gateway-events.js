// gateway-events.js — OpenClaw control-plane WS client for delegation events.

const os = require("node:os");
const pkg = require("../package.json");
const { recordEvent } = require("./metrics");

const CONNECT_SCOPES = ["operator.read", "operator.write"];
const DEFAULT_AGENT_ID = "main";
const DEFAULT_HISTORY_LIMIT = 4;
const RESULT_TEXT_MAX = 4000;
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const ABORT_RETRY_DELAYS_MS = [0, 10_000, 30_000];
const COMPLETION_FETCH_MAX_ATTEMPTS = 3;

let ws = null;
let cfg = null;
let connected = false;
let stopping = false;
let connecting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let requestSeq = 0;
let connectRequestId = null;
let warnedNoWebSocket = false;
let startRefs = 0;
let socketGeneration = 0;

const pending = new Map();
const spawnListeners = new Set();
const completionListeners = new Set();
const reconnectListeners = new Set();
const seenCompletions = new Set();
const seenCompletionChildren = new Set();
const processingCompletions = new Set();
const seenSpawns = new Set();
const childMeta = new Map();
const abortJobs = new Map();
const completionFetchAttempts = new Map();
const activeTasks = new Set();

function trackTask(promise) {
  const task = Promise.resolve(promise).finally(() => {
    activeTasks.delete(task);
  });
  activeTasks.add(task);
  return task;
}

async function drainActiveTasks() {
  while (activeTasks.size > 0) {
    await Promise.allSettled([...activeTasks]);
  }
}

function normalizeCfg(input = {}) {
  return {
    enabled: input.enabled === true,
    openclawUrl: input.openclawUrl || input.url || "",
    openclawToken: input.openclawToken || input.token || "",
    agentId: input.agentId || DEFAULT_AGENT_ID,
    clientId: "gateway-client",
    displayName: input.displayName || "Caty MeetServer",
    version: input.version || pkg.version || "0.0.0",
    platform: input.platform || process.platform || os.platform(),
    mode: "backend",
    scopes: Array.isArray(input.scopes) && input.scopes.length > 0 ? input.scopes : CONNECT_SCOPES,
    WebSocketImpl: input.WebSocketImpl || globalThis.WebSocket,
  };
}

function buildSessionKey(sessionUser, agentId = DEFAULT_AGENT_ID) {
  return `agent:${agentId || DEFAULT_AGENT_ID}:openai-user:${sessionUser}`;
}

function toWsUrl(openclawUrl) {
  const u = new URL(openclawUrl);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  return u.toString();
}

function buildConnectFrame(id, options) {
  return {
    type: "req",
    id: String(id),
    method: "connect",
    params: {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        displayName: options.displayName || "Caty MeetServer",
        version: options.version || pkg.version || "0.0.0",
        platform: options.platform || process.platform || os.platform(),
        mode: "backend",
      },
      role: "operator",
      scopes: options.scopes || CONNECT_SCOPES,
      auth: { token: options.openclawToken || options.token || "" },
    },
  };
}

function start(input = {}) {
  cfg = normalizeCfg(input);
  if (!cfg.enabled) return false;
  if (!cfg.openclawUrl || !cfg.openclawToken) {
    console.warn("⚠️  gateway-events disabled: missing OpenClaw URL/token");
    return false;
  }
  if (typeof cfg.WebSocketImpl !== "function") {
    if (!warnedNoWebSocket) {
      warnedNoWebSocket = true;
      console.warn("⚠️  gateway-events disabled: global WebSocket is unavailable");
    }
    return false;
  }
  startRefs += 1;
  if (ws && (connected || connecting)) return ws;
  stopping = false;
  connect();
  return ws;
}

function stop() {
  if (startRefs > 0) startRefs -= 1;
  if (startRefs > 0) return;
  stopping = true;
  connected = false;
  connecting = false;
  socketGeneration += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error("gateway-events stopped"));
  }
  pending.clear();
  for (const job of abortJobs.values()) {
    if (job.timer) clearTimeout(job.timer);
    job.resolve(false);
  }
  abortJobs.clear();
  if (ws) {
    try { ws.close?.(1000, "stopped"); } catch { /* no-op */ }
    try { ws.terminate?.(); } catch { /* ws package compat */ }
  }
  ws = null;
  connectRequestId = null;
  seenCompletions.clear();
  seenCompletionChildren.clear();
  processingCompletions.clear();
  seenSpawns.clear();
  childMeta.clear();
  completionFetchAttempts.clear();
}

function isConnected() {
  return connected;
}

function connect() {
  if (stopping || !cfg?.enabled) return;
  if (ws && (connected || connecting)) return;
  let url;
  try {
    url = toWsUrl(cfg.openclawUrl);
  } catch (err) {
    console.warn("⚠️  gateway-events invalid OpenClaw URL:", err.message);
    return;
  }

  try {
    connecting = true;
    socketGeneration += 1;
    const generation = socketGeneration;
    ws = new cfg.WebSocketImpl(url);
    ws.__gatewayEventsGeneration = generation;
    const messageHandler = (evt) => onMessage(evt, generation);
    const closeHandler = (evt) => onClose(evt, generation);
    const errorHandler = (err) => onError(err, generation);
    ws.addEventListener?.("message", messageHandler);
    ws.addEventListener?.("close", closeHandler);
    ws.addEventListener?.("error", errorHandler);
    if (typeof ws.on === "function") {
      ws.on("message", (data) => onMessage({ data }, generation));
      ws.on("close", (evt) => onClose(evt, generation));
      ws.on("error", (err) => onError(err, generation));
    }
  } catch (err) {
    connecting = false;
    console.warn("⚠️  gateway-events WS construction failed:", err.message || err);
    scheduleReconnect();
    return;
  }
}

function sendFrame(frame) {
  const data = JSON.stringify(frame);
  if (typeof ws?.send === "function") ws.send(data);
}

function onMessage(evt, generation = socketGeneration) {
  if (generation !== socketGeneration) return;
  let frame;
  try {
    const data = evt?.data;
    frame = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  } catch {
    return;
  }

  if (frame.type === "event") {
    if (frame.event === "connect.challenge") {
      const id = nextId();
      connectRequestId = String(id);
      sendFrame(buildConnectFrame(id, cfg));
      return;
    }
    handleEvent(frame.event, frame.payload || {});
    return;
  }

  if (frame.type === "res") {
    const item = pending.get(String(frame.id));
    if (item) {
      pending.delete(String(frame.id));
      clearTimeout(item.timer);
      if (frame.ok) item.resolve(frame.payload);
      else item.reject(new Error(frame.error?.message || frame.error?.code || "gateway request failed"));
      return;
    }

    if (frame.ok && frame.payload?.type === "hello-ok") {
      if (connectRequestId && String(frame.id) !== connectRequestId) {
        console.warn(`⚠️  gateway-events ignoring hello-ok for non-connect id: ${frame.id}`);
        return;
      }
      connectRequestId = null;
      trackTask(handleHello(frame.payload).catch((err) => {
        console.warn("⚠️  gateway-events subscribe failed:", err.message || err);
        connected = false;
        connecting = false;
        safeCloseForReconnect();
      }));
      return;
    }

    if (frame.ok === false) {
      const code = frame.error?.code || "UNKNOWN";
      const message = frame.error?.message || "gateway connect failed";
      if (!connectRequestId || String(frame.id) !== connectRequestId) {
        console.warn(`⚠️  gateway-events ignored late rejected response ${frame.id}: ${code}: ${message}`);
        return;
      }
      connectRequestId = null;
      console.warn(`⚠️  gateway-events connect rejected: ${code}: ${message}`);
      connected = false;
      connecting = false;
      safeCloseForReconnect();
      scheduleReconnect();
    }
  }
}

async function handleHello(payload) {
  const granted = payload?.auth?.scopes || [];
  const missing = cfg.scopes.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    console.warn(`⚠️  gateway-events missing scope(s): ${missing.join(", ")}`);
    throw new Error(`missing scopes: ${missing.join(", ")}`);
  }
  connected = true;
  connecting = false;
  reconnectAttempt = 0;
  await request("sessions.subscribe", {});
  console.log("🔌  gateway-events connected and subscribed");
  retryPendingAbortsOnReconnect();
  emit(reconnectListeners, {});
}

function onClose(_evt, generation = socketGeneration) {
  if (generation !== socketGeneration) return;
  connected = false;
  connecting = false;
  ws = null;
  connectRequestId = null;
  for (const [id, item] of pending) {
    pending.delete(id);
    clearTimeout(item.timer);
    item.reject(new Error("gateway-events connection closed"));
  }
  if (!stopping) scheduleReconnect();
}

function onError(err, generation = socketGeneration) {
  if (generation !== socketGeneration) return;
  if (!stopping) console.warn("⚠️  gateway-events WS error:", err?.message || err);
}

function safeCloseForReconnect() {
  try { ws?.close?.(); } catch { /* no-op */ }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
  const delay = Math.floor(cap / 2 + Math.random() * cap);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}

function nextId() {
  requestSeq += 1;
  return String(requestSeq);
}

function request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!connected || !ws) return Promise.reject(new Error("gateway-events not connected"));
  const id = nextId();
  const frame = { type: "req", id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    try {
      sendFrame(frame);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

async function verifySessionKey(sessionUser) {
  if (!cfg?.enabled) return null;
  const key = buildSessionKey(sessionUser, cfg.agentId);
  const payload = await request("sessions.resolve", { key });
  if (payload?.ok === false) throw new Error(`session resolve failed: ${key}`);
  return payload?.key || key;
}

async function abortSession(sessionUser) {
  if (!cfg?.enabled) return false;
  const sessionKey = buildSessionKey(sessionUser, cfg.agentId);
  return retryAbortSession(sessionKey);
}

function onSubagentSpawn(cb) {
  spawnListeners.add(cb);
  return () => spawnListeners.delete(cb);
}

function onSubagentCompletion(cb) {
  completionListeners.add(cb);
  return () => completionListeners.delete(cb);
}

function onReconnect(cb) {
  reconnectListeners.add(cb);
  return () => reconnectListeners.delete(cb);
}

function handleEvent(name, payload) {
  if (name !== "sessions.changed") return;
  trackTask(handleSessionsChanged(payload).catch((err) => {
    console.warn("⚠️  gateway-events demux error:", err.message || err);
  }));
}

async function handleSessionsChanged(payload) {
  if (!payload || typeof payload !== "object") return;
  const sessionKey = payload.sessionKey || "";
  const parentSessionKey = payload.parentSessionKey || "";
  const isSubagent = sessionKey.includes(":subagent:");

  if (isSubagent && payload.reason === "create") {
    const meta = {
      parentSessionKey,
      label: payload.label || payload.taskLabel || "委譲タスク",
      spawnAtMs: Date.now(),
    };
    childMeta.set(sessionKey, meta);
    if (seenSpawns.has(sessionKey)) return;
    seenSpawns.add(sessionKey);
    const item = {
      childKey: sessionKey,
      parentSessionKey: meta.parentSessionKey,
      label: meta.label,
      spawnAtMs: meta.spawnAtMs,
      source: payload.source || "self",
    };
    emit(spawnListeners, item);
    return;
  }

  if (!isSubagent || (payload.phase !== "end" && payload.reason !== "subagent-status")) return;
  const runId = payload.runId || "unknown";
  const dedupKey = `${sessionKey}:${runId}`;
  if (seenCompletionChildren.has(sessionKey) || seenCompletions.has(dedupKey)) return;
  if (processingCompletions.has(sessionKey)) return;
  processingCompletions.add(sessionKey);

  const existingMeta = childMeta.get(sessionKey) || {};
  const recovered = payload.parentSessionKey || existingMeta.parentSessionKey
    ? null
    : await recoverChildMeta(sessionKey);
  const meta = {
    parentSessionKey: payload.parentSessionKey || existingMeta.parentSessionKey || recovered?.parentSessionKey || "",
    label: payload.label || payload.taskLabel || existingMeta.label || recovered?.label || "委譲タスク",
    spawnAtMs: existingMeta.spawnAtMs || Date.now(),
  };
  childMeta.set(sessionKey, meta);
  if (!meta.parentSessionKey) {
    processingCompletions.delete(sessionKey);
    console.warn(`⚠️  gateway-events completion unroutable after recovery: ${sessionKey}`);
    safeRecordEvent("gateway_completion_dropped", { reason: "missing_parent", child_key: sessionKey });
    return;
  }

  const resultText = await fetchResultText(sessionKey);
  if (resultText === null) {
    processingCompletions.delete(sessionKey);
    const attempts = completionFetchAttempts.get(sessionKey) || 0;
    if (attempts >= COMPLETION_FETCH_MAX_ATTEMPTS) {
      seenCompletions.add(dedupKey);
      seenCompletionChildren.add(sessionKey);
      console.warn(`⚠️  gateway-events completion dropped after ${attempts} result fetch attempts: ${sessionKey}`);
      safeRecordEvent("gateway_completion_dropped", { reason: "history_fetch_failed", child_key: sessionKey, attempts });
    }
    return;
  }

  const enqueued = await emitCompletion({
    childKey: sessionKey,
    parentSessionKey: meta.parentSessionKey,
    label: meta.label,
    spawnAtMs: meta.spawnAtMs,
    status: payload.status || "ok",
    resultText,
    runId,
  });
  if (!enqueued) {
    processingCompletions.delete(sessionKey);
    console.warn(`⚠️  gateway-events completion had no active route: ${sessionKey}`);
    safeRecordEvent("gateway_completion_dropped", { reason: "no_route", child_key: sessionKey });
    return;
  }
  seenCompletions.add(dedupKey);
  seenCompletionChildren.add(sessionKey);
  processingCompletions.delete(sessionKey);
  completionFetchAttempts.delete(sessionKey);
}

async function fetchResultText(sessionKey) {
  try {
    const payload = await request("chat.history", {
      sessionKey,
      limit: DEFAULT_HISTORY_LIMIT,
      maxChars: RESULT_TEXT_MAX,
    });
    return extractLastAssistantText(payload).slice(0, RESULT_TEXT_MAX);
  } catch (err) {
    const attempts = (completionFetchAttempts.get(sessionKey) || 0) + 1;
    completionFetchAttempts.set(sessionKey, attempts);
    console.warn("⚠️  gateway-events chat.history failed:", err.message || err);
    return null;
  }
}

async function recoverChildMeta(sessionKey) {
  const fromRecord = (record) => {
    if (!record || typeof record !== "object") return null;
    const parentSessionKey = record.parentSessionKey
      || record.spawnedBy
      || record.spawnedBySessionKey
      || record.parent?.sessionKey
      || record.parent?.key
      || "";
    if (!parentSessionKey) return null;
    return {
      parentSessionKey,
      label: record.label || record.taskLabel || record.title || "",
    };
  };

  try {
    const resolved = await request("sessions.resolve", { key: sessionKey });
    const meta = fromRecord(resolved?.session || resolved);
    if (meta) return meta;
  } catch (err) {
    console.warn("⚠️  gateway-events sessions.resolve recovery failed:", err.message || err);
  }

  try {
    const listed = await request("sessions.list", { activeMinutes: 24 * 60, limit: 100, search: sessionKey });
    const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
    const found = sessions.find((item) => item?.key === sessionKey || item?.sessionKey === sessionKey) || sessions[0];
    return fromRecord(found);
  } catch (err) {
    console.warn("⚠️  gateway-events sessions.list recovery failed:", err.message || err);
    return null;
  }
}

function extractLastAssistantText(payload) {
  const messages = payload?.messages || payload?.history || payload?.items || [];
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const role = msg?.role || msg?.message?.role;
    if (role !== "assistant") continue;
    const content = msg?.content ?? msg?.message?.content ?? msg?.text ?? "";
    return contentToText(content);
  }
  return "";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : (part?.text || part?.content || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return content.text || content.content || "";
  return "";
}

function emit(listeners, payload) {
  for (const cb of [...listeners]) {
    try {
      trackTask(Promise.resolve(cb(payload)).catch((err) => {
        console.warn("⚠️  gateway-events listener failed:", err.message || err);
      }));
    } catch (err) {
      console.warn("⚠️  gateway-events listener failed:", err.message || err);
    }
  }
}

async function emitCompletion(payload) {
  let handled = false;
  const tasks = [];
  for (const cb of [...completionListeners]) {
    try {
      tasks.push(Promise.resolve(cb(payload)).then((result) => {
        if (result !== false) handled = true;
      }).catch((err) => {
        console.warn("⚠️  gateway-events listener failed:", err.message || err);
      }));
    } catch (err) {
      console.warn("⚠️  gateway-events listener failed:", err.message || err);
    }
  }
  await Promise.all(tasks);
  return handled;
}

function retryAbortSession(sessionKey) {
  if (abortJobs.has(sessionKey)) return abortJobs.get(sessionKey).promise;
  let resolveJob;
  const job = {
    sessionKey,
    attempts: 0,
    timer: null,
    promise: new Promise((resolve) => { resolveJob = resolve; }),
    resolve: resolveJob,
  };
  abortJobs.set(sessionKey, job);
  runAbortAttempt(job);
  return job.promise;
}

function runAbortAttempt(job) {
  if (stopping || !abortJobs.has(job.sessionKey)) {
    job.resolve(false);
    abortJobs.delete(job.sessionKey);
    return;
  }
  job.attempts += 1;
  request("chat.abort", { sessionKey: job.sessionKey }).then(() => {
    abortJobs.delete(job.sessionKey);
    job.resolve({ ok: true, attempts: job.attempts });
  }).catch((err) => {
    if (stopping || !abortJobs.has(job.sessionKey)) {
      job.resolve(false);
      return;
    }
    if (job.attempts >= ABORT_RETRY_DELAYS_MS.length) {
      console.warn("⚠️  gateway-events abort failed:", err.message || err);
      abortJobs.delete(job.sessionKey);
      job.resolve({ ok: false, attempts: job.attempts });
      return;
    }
    const delay = ABORT_RETRY_DELAYS_MS[job.attempts];
    job.timer = setTimeout(() => {
      job.timer = null;
      runAbortAttempt(job);
    }, delay);
    job.timer.unref?.();
  });
}

function retryPendingAbortsOnReconnect() {
  for (const job of abortJobs.values()) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    // Best-effort only: OpenClaw does not support rotating the parent session key,
    // so a failed abort can still leave the original parent run alive.
    runAbortAttempt(job);
  }
}

function safeRecordEvent(type, fields = {}) {
  try {
    recordEvent(type, fields);
  } catch {
    // Metrics must never affect the control-plane client.
  }
}

module.exports = {
  start,
  stop,
  isConnected,
  verifySessionKey,
  onSubagentSpawn,
  onSubagentCompletion,
  onReconnect,
  abortSession,
  buildSessionKey,
  _test: {
    buildConnectFrame,
    buildSessionKey,
    extractLastAssistantText,
    normalizeCfg,
    handleSessionsChanged,
    reset() {
      stop();
      cfg = null;
      stopping = false;
      connecting = false;
      startRefs = 0;
      socketGeneration += 1;
      requestSeq = 0;
      connectRequestId = null;
      warnedNoWebSocket = false;
      spawnListeners.clear();
      completionListeners.clear();
      seenCompletions.clear();
      seenCompletionChildren.clear();
      processingCompletions.clear();
      seenSpawns.clear();
      childMeta.clear();
      reconnectListeners.clear();
      completionFetchAttempts.clear();
      for (const job of abortJobs.values()) {
        if (job.timer) clearTimeout(job.timer);
        job.resolve(false);
      }
      abortJobs.clear();
    },
    drainActiveTasks,
  },
};
