"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { WebSocket } = require("ws");

const STATES = Object.freeze({
  DISABLED: "DISABLED",
  CONNECTING: "CONNECTING",
  READY: "READY",
  QUEUED: "QUEUED",
  HELD: "HELD",
  DEGRADED: "DEGRADED",
});

const VERDICT_TIMEOUT_MS = 1_500;
const ACQUIRE_RESPONSE_TIMEOUT_MS = 8_000;
const READY_GRACE_MS = 15_000;
const ASSIGN_BUFFER_GRACE_MS = 2_000;

function normalizeWakeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/([エケセテネヘメレゲゼデベペ])(?:ー|イ)/gu, "$1")
    .replace(/[ーッっ]/gu, "")
    .replace(/\s+/gu, "");
}

function extractWakeHits(text, members) {
  const normalized = normalizeWakeText(text);
  const ranked = [];
  let order = 0;
  for (const member of Array.isArray(members) ? members : []) {
    let first = -1;
    const variants = [
      ...(Array.isArray(member?.wakeWords) ? member.wakeWords : []),
      ...(Array.isArray(member?.sttWakeVariants) ? member.sttWakeVariants : []),
    ];
    for (const wakeWord of variants) {
      const needle = normalizeWakeText(wakeWord);
      if (!needle) continue;
      const index = normalized.indexOf(needle);
      if (index >= 0 && (first < 0 || index < first)) first = index;
    }
    if (first >= 0 && typeof member?.memberId === "string" && member.memberId) {
      ranked.push({ memberId: member.memberId, first, order });
    }
    order += 1;
  }
  ranked.sort((left, right) => left.first - right.first || left.order - right.order);
  return ranked.map(({ memberId }) => memberId);
}

function roundSequence(roundId) {
  const match = /^r(\d+)$/u.exec(String(roundId || ""));
  return match ? Number(match[1]) : null;
}

function addSocketListener(socket, event, listener) {
  if (typeof socket.on === "function") socket.on(event, listener);
  else if (typeof socket.addEventListener === "function") socket.addEventListener(event, listener);
}

function socketOpen(socket) {
  return Boolean(socket && (socket.readyState === 1 || socket.readyState === socket.OPEN));
}

class FloorClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url || null;
    this.roomCode = options.roomCode || null;
    this.authToken = options.authToken || "";
    this.agentId = options.agentId || "";
    this.displayName = options.displayName || this.agentId;
    this.wakeWords = Array.isArray(options.wakeWords) ? options.wakeWords.slice() : [];
    this.clientInstanceId = options.clientInstanceId || randomUUID();
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.timers = options.timers || globalThis;
    this.random = options.random || Math.random;
    this.now = options.now || Date.now;
    this.verdictTimeoutMs = options.verdictTimeoutMs ?? VERDICT_TIMEOUT_MS;
    this.acquireResponseTimeoutMs = options.acquireResponseTimeoutMs ?? ACQUIRE_RESPONSE_TIMEOUT_MS;
    this.readyGraceMs = options.readyGraceMs ?? READY_GRACE_MS;
    this.assignBufferGraceMs = options.assignBufferGraceMs ?? ASSIGN_BUFFER_GRACE_MS;
    this.debug = options.debug === true;
    this.onAbortPlayback = options.onAbortPlayback || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onFallbackCancel = options.onFallbackCancel || (() => {});

    this.enabled = Boolean(this.url && this.roomCode);
    this.state = this.enabled ? STATES.CONNECTING : STATES.DISABLED;
    this.socket = null;
    this.socketGeneration = 0;
    this.memberId = null;
    this.connectionEpoch = null;
    this.members = [];
    this.seq = 0;
    this.idSequence = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.readyGraceTimer = null;
    this.connectStartedAt = null;
    this.hasBeenReady = false;
    this.stopped = false;
    this.latestRoundSequence = null;
    this.reports = new Map();
    this.timedOutReports = new Map();
    this.unclaimedAssignments = new Map();
    this.activePeerSpeakers = new Set();
    this.pendingAcquire = null;
    this.grant = null;
    this.grantExtendTimer = null;
  }

  transition(next, detail = {}) {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.emit("state", { previous, state: next, ...detail });
  }

  nextId(prefix) {
    this.idSequence += 1;
    return `${this.clientInstanceId}:${prefix}:${this.idSequence}`;
  }

  connect() {
    if (!this.enabled || this.stopped) return Promise.resolve(false);
    if (this.socket && (socketOpen(this.socket) || this.socket.readyState === 0)) return Promise.resolve(true);
    if (this.connectStartedAt === null) {
      this.connectStartedAt = this.now();
      this.armReadyGrace();
    }
    if (!this.hasBeenReady && this.state !== STATES.DEGRADED) this.transition(STATES.CONNECTING);
    const generation = ++this.socketGeneration;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.handleDisconnect(generation, error);
      return Promise.resolve(false);
    }
    this.socket = socket;
    addSocketListener(socket, "open", () => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.send({
        type: "hello",
        proto: 1,
        roomCode: this.roomCode,
        authToken: this.authToken,
        agentId: this.agentId,
        displayName: this.displayName,
        wakeWords: this.wakeWords.slice(),
        clientInstanceId: this.clientInstanceId,
      });
    });
    addSocketListener(socket, "message", (raw) => {
      if (!this.isCurrentSocket(generation, socket)) return;
      const payload = raw?.data ?? raw;
      let message;
      try {
        message = JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload));
      } catch {
        this.emit("protocol_error", new Error("invalid hub JSON"));
        return;
      }
      this.handleMessage(message);
    });
    addSocketListener(socket, "close", () => this.handleDisconnect(generation));
    addSocketListener(socket, "error", (error) => this.handleDisconnect(generation, error));
    return Promise.resolve(true);
  }

  armReadyGrace() {
    if (this.readyGraceTimer !== null) return;
    this.readyGraceTimer = this.timers.setTimeout(() => {
      this.readyGraceTimer = null;
      if (this.stopped || this.hasBeenReady || this.state === STATES.READY || this.state === STATES.HELD) return;
      this.transition(STATES.DEGRADED, { cause: "ready_timeout" });
      this.emit("degraded", { cause: "ready_timeout", delayMs: this.fallbackDelayMs() });
    }, this.readyGraceMs);
    this.readyGraceTimer?.unref?.();
  }

  isCurrentSocket(generation, socket) {
    return generation === this.socketGeneration && socket === this.socket;
  }

  send(message) {
    if (!socketOpen(this.socket)) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  handleMessage(message) {
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "welcome":
        this.handleWelcome(message);
        break;
      case "turn_assign":
        this.handleAssignment(message);
        break;
      case "granted":
      case "queued":
      case "denied":
        this.handleAcquireResponse(message);
        break;
      case "rejected":
        this.handleRejected(message);
        break;
      case "revoked":
        this.handleRevoked(message);
        break;
      case "member_joined":
        this.members = [...this.members.filter((member) => member.memberId !== message.memberId), {
          memberId: message.memberId,
          displayName: message.displayName,
          wakeWords: Array.isArray(message.wakeWords) ? message.wakeWords.slice() : [],
          sttWakeVariants: Array.isArray(message.sttWakeVariants) ? message.sttWakeVariants.slice() : [],
        }];
        this.emit("members", this.members.slice());
        break;
      case "member_left":
        this.members = this.members.filter((member) => member.memberId !== message.memberId);
        this.activePeerSpeakers.delete(message.memberId);
        this.emit("members", this.members.slice());
        break;
      case "speech":
        if (this.debug) {
          console.debug(`🔊  floor speech ${message.phase || "unknown"} member=${message.memberId || "unknown"}`);
        }
        if (message.memberId && message.memberId !== this.memberId) {
          if (message.phase === "started") this.activePeerSpeakers.add(message.memberId);
          if (message.phase === "ended") this.activePeerSpeakers.delete(message.memberId);
        }
        this.emit("speech", message);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "error":
        this.emit("hub_error", message);
        break;
      default:
        this.emit("message", message);
    }
  }

  handleWelcome(message) {
    if (message.proto !== undefined && message.proto !== 1) {
      this.emit("protocol_error", new Error(`unsupported hub proto ${message.proto}`));
      return;
    }
    this.memberId = message.memberId;
    this.connectionEpoch = message.connectionEpoch;
    this.members = Array.isArray(message.members) ? message.members.map((member) => ({
      ...member,
      wakeWords: Array.isArray(member.wakeWords) ? member.wakeWords.slice() : [],
    })) : [];
    this.hasBeenReady = true;
    this.reconnectAttempt = 0;
    if (this.readyGraceTimer !== null) this.timers.clearTimeout(this.readyGraceTimer);
    this.readyGraceTimer = null;
    this.transition(STATES.READY);
    const ready = {
      roomCode: this.roomCode,
      memberId: this.memberId,
      connectionEpoch: this.connectionEpoch,
      members: this.members.slice(),
      floorState: message.floorState || { holder: null, queue: [] },
    };
    this.onReady(ready);
    this.emit("ready", ready);
  }

  reportWake(hits, options = {}) {
    if (this.enabled && this.state === STATES.CONNECTING) {
      return this.waitForReady().then((ready) => ready
        ? this.reportWake(hits, options)
        : { kind: "degraded", delayMs: this.fallbackDelayMs() });
    }
    if (!this.enabled || ![STATES.READY, STATES.QUEUED, STATES.HELD].includes(this.state)) {
      return Promise.resolve({ kind: "degraded", delayMs: this.fallbackDelayMs() });
    }
    const reportId = this.nextId("report");
    this.seq += 1;
    let resolveReport;
    const promise = new Promise((resolve) => { resolveReport = resolve; });
    const record = {
      reportId,
      seq: this.seq,
      resolve: resolveReport,
      settled: false,
      fallbackActive: false,
      onFallbackCancel: options.onFallbackCancel || null,
      suppressGlobalFallbackCancel: options.suppressGlobalFallbackCancel === true,
      timer: null,
    };
    const normalizedHits = Array.isArray(hits) ? hits.slice() : [];
    if (!options.settleEmpty || normalizedHits.length > 0) {
      record.timer = this.timers.setTimeout(() => {
        record.timer = null;
        if (record.settled) return;
        record.settled = true;
        record.fallbackActive = true;
        this.reports.delete(reportId);
        record.lateTimer = this.timers.setTimeout(() => {
          this.timedOutReports.delete(reportId);
        }, this.assignBufferGraceMs);
        record.lateTimer?.unref?.();
        this.timedOutReports.set(reportId, record);
        resolveReport({ kind: "verdict_timeout", reportId, seq: record.seq });
        this.emit("verdict_timeout", { reportId, seq: record.seq });
      }, this.verdictTimeoutMs);
      record.timer?.unref?.();
    }
    this.reports.set(reportId, record);
    if (!this.send({ type: "wake_report", reportId, seq: record.seq, hits: normalizedHits })) {
      if (record.timer !== null) this.timers.clearTimeout(record.timer);
      record.timer = null;
      record.settled = true;
      this.reports.delete(reportId);
      resolveReport({ kind: "degraded", delayMs: this.fallbackDelayMs() });
    } else if (options.settleEmpty && normalizedHits.length === 0) {
      record.settled = true;
      this.reports.delete(reportId);
      resolveReport({ kind: "empty", reportId, seq: record.seq });
    }
    return promise;
  }

  reportText(text, options = {}) {
    if (this.enabled && this.state === STATES.CONNECTING) {
      return this.waitForReady().then((ready) => ready
        ? this.reportText(text, options)
        : { kind: "degraded", delayMs: this.fallbackDelayMs() });
    }
    const hits = extractWakeHits(text, this.members);
    return this.reportWake(hits, { ...options, settleEmpty: hits.length === 0 });
  }

  matchingReports(message) {
    const consumed = new Set(Array.isArray(message.consumedReportIds) ? message.consumedReportIds : []);
    return [...this.reports.values(), ...this.timedOutReports.values()]
      .filter((record) => consumed.has(record.reportId));
  }

  handleAssignment(message) {
    if (message.memberId === null) {
      console.log(`ℹ️  floor turn unassigned cause=${message.cause || "unknown"}`);
    }
    const sequence = roundSequence(message.roundId);
    if (sequence !== null) this.supersedeOlderAcquire(sequence);
    if (sequence !== null && (this.latestRoundSequence === null || sequence > this.latestRoundSequence)) {
      this.latestRoundSequence = sequence;
    }
    const matched = this.matchingReports(message);
    for (const record of matched) {
      if (record.timer !== null) this.timers.clearTimeout(record.timer);
      if (record.lateTimer !== null && record.lateTimer !== undefined) this.timers.clearTimeout(record.lateTimer);
      record.timer = null;
      if (record.fallbackActive && message.memberId !== this.memberId) {
        const detail = { reportId: record.reportId, roundId: message.roundId, memberId: message.memberId };
        record.onFallbackCancel?.(detail);
        if (!record.suppressGlobalFallbackCancel) this.onFallbackCancel(detail);
        this.emit("fallback_cancelled", detail);
      }
      if (!record.settled) {
        record.settled = true;
        record.resolve({
          kind: message.memberId === this.memberId ? "assigned" : "not_assigned",
          assignment: message,
          reportId: record.reportId,
        });
      }
      this.reports.delete(record.reportId);
      this.timedOutReports.delete(record.reportId);
    }
    if (message.memberId === this.memberId && matched.length === 0) {
      const timer = this.timers.setTimeout(() => {
        const waiting = this.unclaimedAssignments.get(message.roundId);
        if (!waiting) return;
        this.unclaimedAssignments.delete(message.roundId);
        this.declineAssignment(message.roundId, "missing_utterance");
        this.emit("assignment_declined", { roundId: message.roundId, cause: "missing_utterance" });
      }, this.assignBufferGraceMs);
      timer?.unref?.();
      this.unclaimedAssignments.set(message.roundId, { assignment: message, timer });
    }
    this.emit("assignment", message);
  }

  claimAssignment() {
    const waiting = this.unclaimedAssignments.values().next().value;
    if (!waiting) return null;
    this.unclaimedAssignments.delete(waiting.assignment.roundId);
    this.timers.clearTimeout(waiting.timer);
    return waiting.assignment;
  }

  declineAssignment(roundId, cause) {
    return this.send({ type: "assign_declined", roundId, cause });
  }

  supersedeOlderAcquire(newerSequence) {
    for (const [roundId, waiting] of this.unclaimedAssignments) {
      const sequence = roundSequence(roundId);
      if (sequence !== null && sequence < newerSequence) {
        this.timers.clearTimeout(waiting.timer);
        this.unclaimedAssignments.delete(roundId);
      }
    }
    const pending = this.pendingAcquire;
    if (!pending) return;
    const pendingSequence = roundSequence(pending.roundId);
    if (pendingSequence === null || pendingSequence >= newerSequence) return;
    this.send({ type: "cancel", reqId: pending.reqId });
    this.finishAcquireError(Object.assign(new Error("floor request superseded"), { code: "superseded" }));
  }

  acquire(roundId) {
    if (this.grant && this.isFenceCurrent(this.grant)) {
      if (this.grant.roundId === roundId) return Promise.resolve({ ...this.grant });
      return Promise.reject(Object.assign(new Error("held floor grant belongs to another round"), {
        code: "grant_mismatch",
      }));
    }
    const requestedSequence = roundSequence(roundId);
    if (
      requestedSequence !== null
      && this.latestRoundSequence !== null
      && requestedSequence < this.latestRoundSequence
    ) {
      return Promise.reject(Object.assign(new Error("floor request superseded"), { code: "superseded" }));
    }
    if (this.pendingAcquire) {
      if (this.pendingAcquire.roundId === roundId) return this.pendingAcquire.promise;
      return Promise.reject(Object.assign(new Error("floor request already pending"), { code: "floor_busy" }));
    }
    if (this.state !== STATES.READY || !socketOpen(this.socket)) {
      return Promise.reject(Object.assign(new Error("floor hub is not ready"), { code: "not_ready" }));
    }
    const reqId = this.nextId("req");
    let resolveAcquire;
    let rejectAcquire;
    const promise = new Promise((resolve, reject) => {
      resolveAcquire = resolve;
      rejectAcquire = reject;
    });
    const pending = {
      reqId,
      roundId,
      promise,
      resolve: resolveAcquire,
      reject: rejectAcquire,
      acknowledged: false,
      timer: null,
    };
    pending.timer = this.timers.setTimeout(() => {
      if (this.pendingAcquire !== pending || pending.acknowledged) return;
      this.send({ type: "cancel", reqId });
      this.finishAcquireError(Object.assign(new Error("floor response timeout"), { code: "acquire_timeout" }));
    }, this.acquireResponseTimeoutMs);
    pending.timer?.unref?.();
    this.pendingAcquire = pending;
    if (!this.send({ type: "request_floor", reqId, roundId })) {
      this.finishAcquireError(Object.assign(new Error("floor socket unavailable"), { code: "not_ready" }));
    }
    return promise;
  }

  isAssignmentCurrent(assignment) {
    const sequence = roundSequence(assignment?.roundId);
    return sequence === null || this.latestRoundSequence === null || sequence >= this.latestRoundSequence;
  }

  handleAcquireResponse(message) {
    const pending = this.pendingAcquire;
    if (!pending || (message.reqId && message.reqId !== pending.reqId)) {
      if (message.type === "granted" && message.grantId) {
        this.send({ type: "release", grantId: message.grantId, cause: "stale_grant" });
      }
      if (message.type === "rejected") this.emit("rejected", message);
      return;
    }
    if (message.type === "queued") {
      pending.acknowledged = true;
      if (pending.timer !== null) this.timers.clearTimeout(pending.timer);
      pending.timer = null;
      this.transition(STATES.QUEUED, { reqId: pending.reqId, roundId: pending.roundId });
      this.emit("queued", message);
      return;
    }
    if (message.type === "granted") {
      if (pending.timer !== null) this.timers.clearTimeout(pending.timer);
      const grant = {
        reqId: pending.reqId,
        roundId: pending.roundId,
        grantId: message.grantId,
        leaseMs: message.leaseMs,
        connectionEpoch: this.connectionEpoch,
      };
      this.pendingAcquire = null;
      this.grant = grant;
      this.armGrantExtension(grant);
      this.transition(STATES.HELD, { grantId: grant.grantId });
      pending.resolve({ ...grant });
      this.emit("granted", { ...grant });
      return;
    }
    const error = Object.assign(new Error(message.cause || message.type), {
      code: message.cause || message.type,
      response: message,
    });
    this.finishAcquireError(error);
  }

  handleRejected(message) {
    if (message.reqId) {
      this.handleAcquireResponse(message);
      return;
    }

    // Arbitration rejects wake_report without echoing reportId (§5.5). WebSocket
    // frames are ordered and the hub handles report/reply synchronously, so an
    // anonymous rejection belongs to the oldest report not already consumed by
    // an earlier ordered turn_assign. Do not let it reject an unrelated queued
    // floor request merely because both operations overlap.
    if (!message.grantId && !message.roundId) {
      const report = [...this.reports.values()].find((record) => !record.settled);
      if (report) {
        if (report.timer !== null) this.timers.clearTimeout(report.timer);
        report.timer = null;
        report.settled = true;
        this.reports.delete(report.reportId);
        report.resolve({ kind: "rejected", reportId: report.reportId, response: message });
        this.emit("report_rejected", { reportId: report.reportId, response: message });
        return;
      }
    }

    this.emit("rejected", message);
  }

  finishAcquireError(error) {
    const pending = this.pendingAcquire;
    if (!pending) return;
    if (pending.timer !== null) this.timers.clearTimeout(pending.timer);
    this.pendingAcquire = null;
    if (this.state === STATES.QUEUED) this.transition(socketOpen(this.socket) ? STATES.READY : STATES.DEGRADED);
    pending.reject(error);
  }

  fence() {
    if (!this.grant) return null;
    return { grantId: this.grant.grantId, connectionEpoch: this.grant.connectionEpoch };
  }

  clearGrantExtension() {
    if (this.grantExtendTimer !== null) this.timers.clearTimeout(this.grantExtendTimer);
    this.grantExtendTimer = null;
  }

  armGrantExtension(grant) {
    this.clearGrantExtension();
    const delayMs = Math.max(1_000, Math.min(5_000, Math.floor(Number(grant.leaseMs || 15_000) / 2)));
    this.grantExtendTimer = this.timers.setTimeout(() => {
      this.grantExtendTimer = null;
      if (this.grant !== grant || !this.isFenceCurrent(grant)) return;
      this.extend();
      this.armGrantExtension(grant);
    }, delayMs);
    this.grantExtendTimer?.unref?.();
  }

  isFenceCurrent(fence) {
    return Boolean(
      fence
      && this.grant
      && this.state === STATES.HELD
      && socketOpen(this.socket)
      && fence.grantId === this.grant.grantId
      && fence.connectionEpoch === this.connectionEpoch
      && this.grant.connectionEpoch === this.connectionEpoch
    );
  }

  speech(phase, tailMs = 0) {
    if (!this.grant || !["started", "ended"].includes(phase)) return false;
    return this.send({
      type: "speech",
      grantId: this.grant.grantId,
      phase,
      tailMs,
    });
  }

  extend() {
    return this.grant ? this.send({ type: "extend", grantId: this.grant.grantId }) : false;
  }

  release(cause = "completed") {
    if (!this.grant) return false;
    const grantId = this.grant.grantId;
    this.clearGrantExtension();
    this.grant = null;
    const sent = this.send({ type: "release", grantId, cause });
    this.transition(socketOpen(this.socket) ? STATES.READY : STATES.DEGRADED, { cause });
    this.emit("released", { grantId, cause });
    return sent;
  }

  cancelPending(cause = "cancelled") {
    if (!this.pendingAcquire) return false;
    const { reqId } = this.pendingAcquire;
    this.send({ type: "cancel", reqId });
    this.finishAcquireError(Object.assign(new Error(cause), { code: cause }));
    return true;
  }

  handleRevoked(message) {
    if (!this.grant || message.grantId !== this.grant.grantId) return;
    const stale = this.grant;
    this.clearGrantExtension();
    this.grant = null;
    this.transition(socketOpen(this.socket) ? STATES.READY : STATES.DEGRADED, { cause: message.cause });
    this.onAbortPlayback({ cause: message.cause || "revoked", grantId: stale.grantId });
    this.emit("revoked", message);
  }

  handleDisconnect(generation, error) {
    if (generation !== this.socketGeneration || this.stopped) return;
    const wasHolder = Boolean(this.grant);
    const staleGrant = this.grant;
    this.clearGrantExtension();
    this.socket = null;
    this.connectionEpoch = null;
    this.grant = null;
    this.latestRoundSequence = null;
    const degradedDelayMs = this.fallbackDelayMs();
    for (const report of this.reports.values()) {
      if (report.timer !== null) this.timers.clearTimeout(report.timer);
      if (!report.settled) {
        report.settled = true;
        report.resolve({ kind: "degraded", delayMs: degradedDelayMs });
      }
    }
    this.reports.clear();
    for (const report of this.timedOutReports.values()) {
      if (report.lateTimer !== null && report.lateTimer !== undefined) this.timers.clearTimeout(report.lateTimer);
    }
    this.timedOutReports.clear();
    this.activePeerSpeakers.clear();
    for (const waiting of this.unclaimedAssignments.values()) {
      this.timers.clearTimeout(waiting.timer);
    }
    this.unclaimedAssignments.clear();
    if (this.pendingAcquire) {
      this.finishAcquireError(Object.assign(new Error("floor disconnected"), { code: "disconnected" }));
    }
    if (wasHolder) {
      this.onAbortPlayback({ cause: "disconnect", grantId: staleGrant.grantId });
      this.emit("revoked", { type: "revoked", grantId: staleGrant.grantId, cause: "disconnect" });
    }
    if (this.hasBeenReady) {
      this.transition(STATES.DEGRADED, { cause: "disconnect" });
      this.emit("degraded", { cause: "disconnect", delayMs: degradedDelayMs, holder: wasHolder });
    } else if (this.connectStartedAt !== null && this.now() - this.connectStartedAt >= this.readyGraceMs) {
      this.transition(STATES.DEGRADED, { cause: "ready_timeout" });
    } else {
      this.transition(STATES.CONNECTING, { cause: "disconnect" });
    }
    if (error) this.emit("socket_error", error);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    const base = Math.min(10_000, 250 * (2 ** Math.min(this.reconnectAttempt, 6)));
    const delayMs = Math.round(base * (0.5 + this.random()));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer?.unref?.();
    this.emit("reconnect_scheduled", { attempt: this.reconnectAttempt, delayMs });
  }

  fallbackDelayMs() {
    return Math.round(200 + (this.random() * 600));
  }

  waitForReady() {
    if (!this.enabled) return Promise.resolve(false);
    if ([STATES.READY, STATES.HELD, STATES.QUEUED].includes(this.state)) return Promise.resolve(true);
    if ([STATES.DEGRADED, STATES.DISABLED].includes(this.state)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onReady = () => finish(true);
      const onState = ({ state }) => {
        if (state === STATES.DEGRADED || state === STATES.DISABLED) finish(false);
      };
      const finish = (value) => {
        this.off("ready", onReady);
        this.off("state", onState);
        resolve(value);
      };
      this.on("ready", onReady);
      this.on("state", onState);
    });
  }

  remainingReadyGraceMs() {
    if (this.connectStartedAt === null) return this.readyGraceMs;
    return Math.max(0, this.readyGraceMs - (this.now() - this.connectStartedAt));
  }

  hasActivePeerSpeech() {
    return this.activePeerSpeakers.size > 0;
  }

  hasUnsettledReports() {
    return [...this.reports.values()].some((record) => !record.settled);
  }

  close(cause = "client_close") {
    if (this.stopped) return;
    this.cancelPending(cause);
    this.release(cause);
    this.stopped = true;
    this.socketGeneration += 1;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.readyGraceTimer !== null) this.timers.clearTimeout(this.readyGraceTimer);
    this.reconnectTimer = null;
    this.readyGraceTimer = null;
    this.clearGrantExtension();
    for (const report of this.reports.values()) {
      if (report.timer !== null) this.timers.clearTimeout(report.timer);
      if (!report.settled) report.resolve({ kind: "closed" });
    }
    this.reports.clear();
    for (const report of this.timedOutReports.values()) {
      if (report.lateTimer !== null && report.lateTimer !== undefined) this.timers.clearTimeout(report.lateTimer);
    }
    this.timedOutReports.clear();
    this.activePeerSpeakers.clear();
    for (const waiting of this.unclaimedAssignments.values()) this.timers.clearTimeout(waiting.timer);
    this.unclaimedAssignments.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket && typeof socket.close === "function") socket.close(1000, cause);
    this.memberId = null;
    this.connectionEpoch = null;
    this.transition(STATES.DISABLED, { cause });
  }
}

module.exports = {
  ACQUIRE_RESPONSE_TIMEOUT_MS,
  ASSIGN_BUFFER_GRACE_MS,
  FloorClient,
  READY_GRACE_MS,
  STATES,
  VERDICT_TIMEOUT_MS,
  extractWakeHits,
  normalizeWakeText,
  roundSequence,
};
