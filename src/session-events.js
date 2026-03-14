// session-events.js — Session lifecycle state machine
// Session lifecycle state machine

const { EventEmitter } = require("events");

const VALID_TRANSITIONS = {
  idle:           ["initiating"],
  initiating:     ["ringing", "in-progress", "failed"],
  ringing:        ["in-progress", "failed"],
  "in-progress":  ["ending", "completed", "failed"],
  ending:         ["completed", "failed"],
  completed:      [],
  failed:         [],
};

const TERMINAL_STATES = new Set(["completed", "failed"]);

/**
 * Session lifecycle state machine.
 *
 * Events:
 *   'state_change' — { sessionId, from, to, transport, meta, timestamp }
 *   'session_start' — { sessionId, transport, to, from, timestamp }
 *   'session_end'   — { sessionId, transport, state, duration, conversationLog, timestamp }
 */
class SessionLifecycle extends EventEmitter {
  /**
   * @param {string} sessionId
   * @param {"meet"|"zoom"} transport
   * @param {object} [meta] — extra metadata (to, from, meetingUrl, etc.)
   */
  constructor(sessionId, transport, meta = {}) {
    super();
    this._sessionId = sessionId;
    this._transport = transport;
    this._state = "idle";
    this._createdAt = Date.now();
    this._startedAt = null; // set when entering in-progress
    this._endedAt = null;
    this._meta = meta;
    this._conversationLog = [];
    this._history = [{ state: "idle", timestamp: Date.now() }];
  }

  get sessionId() { return this._sessionId; }
  get transport() { return this._transport; }
  get state() { return this._state; }
  get startedAt() { return this._startedAt; }
  get endedAt() { return this._endedAt; }
  get isTerminal() { return TERMINAL_STATES.has(this._state); }
  get meta() { return this._meta; }

  /** Duration in seconds since in-progress (or 0 if not started yet). */
  get duration() {
    if (!this._startedAt) return 0;
    const end = this._endedAt || Date.now();
    return Math.round((end - this._startedAt) / 1000);
  }

  /** Formatted duration string (M:SS or H:MM:SS). */
  get durationFormatted() {
    const secs = this.duration;
    if (secs < 3600) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    }
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  /** Bind a conversation log array for summary generation. */
  setConversationLog(log) {
    this._conversationLog = log;
  }

  /**
   * Transition to a new state.
   * @param {string} newState
   * @param {object} [meta] — optional metadata for this transition
   * @returns {boolean} true if transition succeeded
   */
  transition(newState, meta = {}) {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed || !allowed.includes(newState)) {
      console.warn(
        `⚠️  SessionLifecycle: invalid transition ${this._state} → ${newState} (session=${this._sessionId})`
      );
      return false;
    }

    const from = this._state;
    this._state = newState;
    this._history.push({ state: newState, timestamp: Date.now(), meta });

    const now = Date.now();

    // Track in-progress start
    if (newState === "in-progress" && !this._startedAt) {
      this._startedAt = now;
    }

    // Track end time
    if (TERMINAL_STATES.has(newState)) {
      this._endedAt = now;
    }

    const eventData = {
      sessionId: this._sessionId,
      from,
      to: newState,
      transport: this._transport,
      meta: { ...this._meta, ...meta },
      timestamp: now,
    };

    this.emit("state_change", eventData);

    // Emit session_start when entering in-progress
    if (newState === "in-progress" && from !== "in-progress") {
      this.emit("session_start", {
        sessionId: this._sessionId,
        transport: this._transport,
        to: this._meta.to || null,
        from: this._meta.from || null,
        agents: this._meta.agents || null,
        timestamp: now,
      });
    }

    // Emit session_end on terminal state
    if (TERMINAL_STATES.has(newState)) {
      this.emit("session_end", {
        sessionId: this._sessionId,
        transport: this._transport,
        state: newState,
        duration: this.duration,
        durationFormatted: this.durationFormatted,
        conversationLog: this._conversationLog,
        agents: this._meta.agents || null,
        timestamp: now,
      });
    }

    return true;
  }

  /** Serializable snapshot. */
  toJSON() {
    return {
      sessionId: this._sessionId,
      transport: this._transport,
      state: this._state,
      createdAt: this._createdAt,
      startedAt: this._startedAt,
      endedAt: this._endedAt,
      duration: this.duration,
      durationFormatted: this.durationFormatted,
      meta: this._meta,
      history: this._history,
    };
  }
}

module.exports = { SessionLifecycle, VALID_TRANSITIONS, TERMINAL_STATES };
