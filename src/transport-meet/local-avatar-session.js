const crypto = require("crypto");

const HTML_ROUTE = "/local-avatar/index.html";
const FRAMES_HTML_ROUTE = "/local-avatar/frames.html";
const SCRIPT_ROUTE = "/local-avatar/local-avatar.js";
const FRAMES_SCRIPT_ROUTE = "/local-avatar/frames.js";
const STATE_ROUTE = "/local-avatar/state";
const FACE_HOST_HTML_ROUTE = "/local-avatar/face-host.html";
const HTML_ROUTES = new Set([HTML_ROUTE, FRAMES_HTML_ROUTE, FACE_HOST_HTML_ROUTE]);
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const DEFAULT_QUEUE_LIMIT = 8;
const MAX_QUEUE_LIMIT = 64;
const DEFAULT_RETRY_LIMIT = 3;
const MAX_RETRY_LIMIT = 8;
const MAX_ENVELOPE_PUSH_VALUES = 150;
const MAX_ENVELOPE_VALUES = 256;
const ENVELOPE_WINDOW_MS = 100;
const ENVELOPE_HISTORY_MS = 20_000;
const DEFAULT_BACKGROUND = Object.freeze({ mode: "solid", color: "#08111f" });
const BACKGROUND_MODES = new Set(["solid", "image", "chroma"]);
const BACKGROUND_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
// #266 page audio (faceAudio=page only): freshness and queue bounds.
const AUDIO_ROUTE = "/local-avatar/audio";
const AUDIO_HEARTBEAT_FRESH_MS = 1000;
const AUDIO_BACKLOG_LIMIT_MS = 2000;
const AUDIO_QUEUE_LIMIT_MS = 2000;
const AUDIO_EPOCH_MEMORY = 16;
const AUDIO_CONTEXT_STATES = new Set(["running", "suspended", "closed", "interrupted"]);

const sessions = new Map();

function createLocalAvatarSession(options = {}) {
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const visualId = toBase64Url(randomBytes(16));
  const capability = toBase64Url(randomBytes(32));
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const htmlRoute = options.htmlRoute || HTML_ROUTE;
  if (!HTML_ROUTES.has(htmlRoute)) throw new Error("invalid local avatar HTML route");
  if ((options.mode === "face-package" && (!options.facePackage || htmlRoute !== FACE_HOST_HTML_ROUTE))
    || (htmlRoute === FACE_HOST_HTML_ROUTE && options.mode !== "face-package")) {
    throw new Error("face package mode requires a validated package and host route");
  }
  if (options.pageAudio === true && options.mode !== "face-package") throw new Error("page audio requires face package mode");
  const session = new LocalAvatarSession({
    mode: options.mode || (htmlRoute === FRAMES_HTML_ROUTE ? "hybrid-local-frames" : "hybrid-local-l0"),
    facePackage: options.facePackage,
    mountId: options.mode === "face-package" ? toBase64Url(randomBytes(32)) : null,
    visualId,
    capability,
    publicOrigin,
    now: options.now,
    ttlMs: options.ttlMs,
    queueLimit: options.queueLimit,
    retryLimit: options.retryLimit,
    logger: options.logger,
    background: options.background,
    backgroundImage: options.backgroundImage,
    pageAudio: options.pageAudio === true,
  });

  if (sessions.has(visualId)) throw new Error("local avatar visual id collision");
  sessions.set(visualId, session);

  return {
    session,
    capability,
    launchUrl: `${publicOrigin}${htmlRoute}?v=${encodeURIComponent(visualId)}#cap=${encodeURIComponent(capability)}`,
  };
}

class LocalAvatarSession {
  constructor({ visualId, capability, publicOrigin, now, ttlMs, queueLimit, retryLimit, logger, background, backgroundImage, mode, facePackage, mountId, pageAudio }) {
    this.mode = mode;
    if (mode === "face-package") {
      this.facePackage = facePackage;
      this.mountId = mountId;
      this._utterances = [];
      this._faceRate = null;
      this._listen = { id: 0, active: false };
    }
    if (mode === "face-package" && pageAudio === true) {
      // The meetmate host page owns reply sound; packages stay audio-free (#266).
      this.pageAudio = true;
      this._audio = { stream: null, heartbeat: null, routed: new Set(), lost: new Set(), closeListener: null };
    }
    this.visualId = visualId;
    this.publicOrigin = publicOrigin;
    this._now = typeof now === "function" ? now : Date.now;
    this._logger = logger || null;
    this._capabilityHash = hashCapability(capability);
    this._ttlMs = clampInteger(ttlMs, DEFAULT_TTL_MS, 1, MAX_TTL_MS);
    this._expiresAt = this._now() + this._ttlMs;
    this._queueLimit = clampInteger(queueLimit, DEFAULT_QUEUE_LIMIT, 1, MAX_QUEUE_LIMIT);
    this._retryLimit = clampInteger(retryLimit, DEFAULT_RETRY_LIMIT, 0, MAX_RETRY_LIMIT);
    this._queue = [];
    this._lastDelivery = null;
    this._closed = false;
    this._generation = 0;
    this._sourceGeneration = 0;
    this._sequence = 0;
    this._cancelEpoch = 0;
    this._outputEpoch = -1;
    this._lastSampleIndex = -1;
    this._lastCancelledOutputEpoch = -1;
    this._dropped = 0;
    this._envelopeLog = [];
    this._envelopeDropped = 0;
    // #294 D5: the join-time picture lives only in memory; `image` is its cache token.
    this._backgroundImage = normalizeBackgroundImage(background, backgroundImage);
    this._background = normalizeBackground(background, this._backgroundImage);
    // #283 face status facts: observations only, they change no page behavior.
    this._pageFirstSeenAt = null;
    this._firstConnectedAt = null;
    this._connectedAt = null;
    this._connectedGeneration = 0;
    this._lastPollAt = null;
    this._closedReason = null;
  }

  backgroundState() {
    return { ...this._background };
  }

  // #294 D5: bytes for GET /local-avatar/background; the route verifies the capability first.
  backgroundImage() {
    if (this._closed || !this._backgroundImage) return null;
    return { bytes: this._backgroundImage.bytes, type: this._backgroundImage.type };
  }

  isLive() {
    if (!this._closed && this._now() >= this._expiresAt) this.close("expired");
    return !this._closed;
  }

  verifyCapability(candidate) {
    const candidateHash = hashCapability(typeof candidate === "string" ? candidate : "");
    const equal = crypto.timingSafeEqual(this._capabilityHash, candidateHash);
    const now = this._now();
    if (!equal || this._closed || now >= this._expiresAt) {
      if (!this._closed && now >= this._expiresAt) this.close("expired");
      return false;
    }
    this._expiresAt = now + this._ttlMs;
    return true;
  }

  connect({ capability, origin }) {
    if (origin !== this.publicOrigin || !this.verifyCapability(capability)) return null;

    this._generation += 1;
    const now = this._now();
    this._firstConnectedAt ??= now;
    this._connectedAt = now;
    this._connectedGeneration = this._generation;
    this._lastPollAt = null;
    this._queue.length = 0;
    this._lastDelivery = null;
    this._lastSampleIndex = -1;
    this._envelopeLog.length = 0;
    if (this.mode === "face-package") this._resetFaceHistory();
    if (this.pageAudio) {
      // A new page generation supersedes the previous stream and its heartbeat.
      this._closeAudioStream(true);
      this._audio.heartbeat = null;
    }
    return {
      ...this._state("idle", {
        outputEpoch: this._outputEpoch,
        sampleIndex: null,
        sampleRate: null,
      }),
      background: this.backgroundState(),
    };
  }

  publishMarker(metadata, sourceGeneration = this._sourceGeneration) {
    if (this._closed || this._generation === 0 || this._now() >= this._expiresAt) return false;
    if (sourceGeneration !== this._sourceGeneration) return false;

    const outputEpoch = toNonNegativeInteger(metadata?.outputEpoch);
    const sampleIndex = toNonNegativeInteger(metadata?.firstSampleIndex);
    const sampleRate = toPositiveInteger(metadata?.sampleRate);
    if (outputEpoch === null || sampleIndex === null || sampleRate === null) return false;
    if (outputEpoch <= this._lastCancelledOutputEpoch || outputEpoch < this._outputEpoch) return false;

    if (outputEpoch > this._outputEpoch) {
      this._outputEpoch = outputEpoch;
      this._lastSampleIndex = -1;
      this._queue.length = 0;
      this._lastDelivery = null;
      this._envelopeLog.length = 0;
      if (this.mode === "face-package") this._resetFaceHistory();
    }
    if (sampleIndex <= this._lastSampleIndex) return false;

    this._lastSampleIndex = sampleIndex;
    this._appendEnvelopeSegments(metadata?.envelopeSegments, sampleRate);
    if (this.mode === "face-package") {
      this._faceRate = sampleRate;
      const id = metadata?.utteranceId;
      if (Number.isSafeInteger(id) && id > 0) {
        let utterance = this._utterances.find((item) => item.utteranceId === id);
        if (!utterance) {
          utterance = { utteranceId: id, utteranceStartSample: sampleIndex, endSample: null,
            emotion: null, intensity: 0, emotionRevision: 0 };
          this._utterances.push(utterance);
        }
        if (utterance.endSample === null) {
          utterance.lastSample = sampleIndex + (Number.isSafeInteger(metadata.sampleCount) ? metadata.sampleCount : 0);
          if (metadata.emotionRevision > utterance.emotionRevision) this._setEmotion(utterance, metadata);
        }
      }
      const cutoff = sampleIndex - sampleRate * ENVELOPE_HISTORY_MS / 1000;
      this._utterances = this._utterances.filter((item) => item.endSample === null || item.endSample >= cutoff).slice(-256);
    }
    return this._enqueue(this._state("marker", { outputEpoch, sampleIndex, sampleRate }));
  }

  _resetFaceHistory() {
    this._utterances.length = 0;
    this._faceRate = null;
    this._listen.active = false;
    delete this._listen.cue;
  }

  _faceWritable(sourceGeneration) {
    return this.mode === "face-package" && this.isLive() && this._generation > 0
      && sourceGeneration === this._sourceGeneration;
  }

  _setEmotion(utterance, value) {
    const known = ["joy", "trust", "fear", "surprise", "sadness", "disgust", "anger", "anticipation"];
    if (value.emotion !== null && !known.includes(value.emotion)) return false;
    if (!Number.isFinite(value.intensity) || value.intensity < 0 || value.intensity > 1) return false;
    if (!Number.isSafeInteger(value.emotionRevision) || value.emotionRevision <= utterance.emotionRevision) return false;
    utterance.emotion = value.emotion;
    utterance.intensity = value.intensity;
    utterance.emotionRevision = value.emotionRevision;
    return true;
  }

  _faceSnapshot() {
    return this._enqueue(this._state("marker", { outputEpoch: this._outputEpoch,
      sampleIndex: this._lastSampleIndex, sampleRate: this._faceRate }));
  }

  publishEmotion(event, sourceGeneration = this._sourceGeneration) {
    if (!this._faceWritable(sourceGeneration) || event?.outputEpoch !== this._outputEpoch) return false;
    const utterance = this._utterances.at(-1);
    if (utterance?.utteranceId !== event.utteranceId) return false;
    if (!utterance || !this._setEmotion(utterance, event)) return false;
    return this._faceSnapshot();
  }

  endUtterance(event, sourceGeneration = this._sourceGeneration) {
    if (!this._faceWritable(sourceGeneration) || event?.outputEpoch !== this._outputEpoch) return false;
    const utterance = this._utterances.find((item) => item.utteranceId === event.utteranceId && item.endSample === null);
    if (!utterance) return false;
    utterance.endSample = utterance.lastSample;
    return this._faceSnapshot();
  }

  publishListen(event, sourceGeneration = this._sourceGeneration) {
    if (!this._faceWritable(sourceGeneration)) return false;
    if (typeof event?.active === "boolean") {
      if (event.active && !this._listen.active) this._listen.id += 1;
      this._listen.active = event.active;
    }
    if (event?.cue) {
      const normalized = { emotionRevision: 0 };
      if (this._setEmotion(normalized, { ...event.cue, emotionRevision: 1 })) {
        this._listen.cue = { id: (this._listen.cue?.id || 0) + 1,
          emotion: normalized.emotion, intensity: normalized.intensity, expiresAt: this._now() + 4000 };
      }
    }
    return this._faceSnapshot();
  }

  cancelPlayback(event, sourceGeneration = this._sourceGeneration) {
    if (this._closed || this._generation === 0 || this._now() >= this._expiresAt) return false;
    if (sourceGeneration !== this._sourceGeneration) return false;
    const outputEpoch = toNonNegativeInteger(event?.outputEpoch);
    if (outputEpoch === null || outputEpoch <= this._lastCancelledOutputEpoch || outputEpoch < this._outputEpoch) {
      return false;
    }

    this._lastCancelledOutputEpoch = outputEpoch;
    this._outputEpoch = Math.max(this._outputEpoch, outputEpoch);
    this._lastSampleIndex = -1;
    this._cancelEpoch += 1;
    this._queue.length = 0;
    this._lastDelivery = null;
    this._envelopeLog.length = 0;
    if (this.mode === "face-package") this._resetFaceHistory();
    if (this.pageAudio) this._cancelAudio(outputEpoch);
    return this._enqueue(this._state("cancel", {
      outputEpoch,
      sampleIndex: null,
      sampleRate: null,
    }));
  }

  beginSource() {
    if (this._closed || this._now() >= this._expiresAt) return null;
    this._sourceGeneration += 1;
    this._outputEpoch = -1;
    this._lastSampleIndex = -1;
    this._lastCancelledOutputEpoch = -1;
    this._cancelEpoch += 1;
    this._queue.length = 0;
    this._lastDelivery = null;
    this._envelopeLog.length = 0;
    if (this.mode === "face-package") this._resetFaceHistory();
    if (this.pageAudio) {
      // A new source restarts output epochs at 0: purge, push cancel, forget old epochs.
      this._cancelAudio(Number.MAX_SAFE_INTEGER, -1);
      this._audio.routed.clear();
      this._audio.lost.clear();
    }
    if (this._generation > 0) {
      this._enqueue(this._state("idle", {
        outputEpoch: this._outputEpoch,
        sampleIndex: null,
        sampleRate: null,
      }));
    }
    return this._sourceGeneration;
  }

  // ---- #266 page audio (faceAudio=page only) -------------------------------

  // Stores the heartbeat carried by an authenticated state poll (200 or 204).
  recordHeartbeat(body) {
    if (!this.pageAudio || this._closed) return false;
    const audio = body?.audio;
    if (!audio || typeof audio !== "object" || !AUDIO_CONTEXT_STATES.has(audio.state)) return false;
    const playedEpoch = toInteger(audio.playedEpoch);
    const playedSample = toNonNegativeInteger(audio.playedSample);
    const receivedSample = toNonNegativeInteger(audio.receivedSample);
    if (playedEpoch === null || playedEpoch < -1 || playedSample === null || receivedSample === null
      || playedSample > receivedSample) return false;
    this._audio.heartbeat = { state: audio.state, playedEpoch, playedSample, receivedSample, at: this._now() };
    return true;
  }

  audioHeartbeat() {
    return this.pageAudio && this._audio.heartbeat ? { ...this._audio.heartbeat } : null;
  }

  // Audio-ready (§2.2): stream open for this generation, fresh running heartbeat, bounded backlog.
  audioReady() {
    if (!this.pageAudio || !this.isLive()) return false;
    const stream = this._audio.stream;
    const heartbeat = this._audio.heartbeat;
    if (!stream || stream.closed || stream.generation !== this._generation || !heartbeat) return false;
    if (this._now() - heartbeat.at > AUDIO_HEARTBEAT_FRESH_MS || heartbeat.state !== "running") return false;
    const pageBacklogMs = stream.rate > 0 ? (heartbeat.receivedSample - heartbeat.playedSample) / stream.rate * 1000 : 0;
    return stream.queuedMs + pageBacklogMs <= AUDIO_BACKLOG_LIMIT_MS;
  }

  isPageLost(outputEpoch) {
    return Boolean(this.pageAudio && this._audio.lost.has(outputEpoch));
  }

  // One listener per session: a bot WebSocket reconnect replaces the previous connection's listener.
  onPageAudioClose(listener) {
    if (this.pageAudio && !this._closed && typeof listener === "function") this._audio.closeListener = listener;
  }

  // Server-side stream close (forces the page's stream stop). true when a stream was open.
  closeAudioStream() {
    if (!this.pageAudio || !this._audio.stream) return false;
    this._closeAudioStream(true);
    return true;
  }

  // Exactly the /local-avatar/state checks, plus the mode. One stream per session; no replay.
  openAudioStream({ capability, origin, generation, res, headers }) {
    if (!this.pageAudio || origin !== this.publicOrigin || !this.verifyCapability(capability)) return false;
    if (toPositiveInteger(generation) !== this._generation) return false;
    this._closeAudioStream(true);
    // A heartbeat from before this stream describes the old stream's playback; wait for a fresh one.
    this._audio.heartbeat = null;
    const stream = { res, generation: this._generation, queue: [], queuedMs: 0, epochs: new Set(), rate: 0, closed: false };
    this._audio.stream = stream;
    res.writeHead(200, headers);
    res.flushHeaders?.();
    const gone = () => this._audioStreamGone(stream);
    res.on?.("close", gone);
    res.on?.("error", gone);
    res.on?.("drain", () => this._pumpAudio(stream));
    return true;
  }

  // Enqueues one page-routed chunk. false = not delivered (cancelled, page-lost, no stream, overflow).
  pushAudio(buffer, metadata, sourceGeneration = this._sourceGeneration) {
    if (!this.pageAudio || !this.isLive() || this._generation === 0 || sourceGeneration !== this._sourceGeneration) return false;
    const outputEpoch = toNonNegativeInteger(metadata?.outputEpoch);
    const firstSampleIndex = toNonNegativeInteger(metadata?.firstSampleIndex);
    const sampleRate = toPositiveInteger(metadata?.sampleRate);
    if (!Buffer.isBuffer(buffer) || outputEpoch === null || firstSampleIndex === null || sampleRate === null) return false;
    if (outputEpoch <= this._lastCancelledOutputEpoch) return false;
    remember(this._audio.routed, outputEpoch);
    if (this._audio.lost.has(outputEpoch)) return false;
    const stream = this._audio.stream;
    if (!stream || stream.closed || stream.generation !== this._generation) {
      remember(this._audio.lost, outputEpoch);
      return false;
    }
    const pcm = buffer.subarray(0, buffer.length - (buffer.length % 2));
    const utteranceId = Number.isSafeInteger(metadata.utteranceId) && metadata.utteranceId > 0 ? metadata.utteranceId : null;
    const frame = encodeAudioFrame({ t: "pcm", generation: this._generation, outputEpoch, cancelEpoch: this._cancelEpoch,
      firstSampleIndex, sampleRate, utteranceId }, pcm);
    const ms = pcm.length / 2 / sampleRate * 1000;
    stream.queue.push({ outputEpoch, cancelEpoch: this._cancelEpoch, frame, ms });
    stream.queuedMs += ms;
    stream.epochs.add(outputEpoch);
    stream.rate = sampleRate;
    this._pumpAudio(stream);
    if (stream.queuedMs > AUDIO_QUEUE_LIMIT_MS) {
      // Overflow: the current epoch loses its tail and the next epoch falls back (§2.3).
      this._closeAudioStream(true);
      return false;
    }
    return true;
  }

  _pumpAudio(stream) {
    while (!stream.closed && stream.queue.length > 0 && !stream.res.writableNeedDrain) {
      const item = stream.queue.shift();
      stream.queuedMs -= item.ms;
      try { stream.res.write(item.frame); } catch { this._audioStreamGone(stream); return; }
    }
    if (stream.queue.length === 0) stream.queuedMs = 0;
  }

  // Purges queued frames of epochs <= upTo and every queued frame encoded under an older cancelEpoch,
  // then pushes a cancel frame ahead of any later frame.
  _cancelAudio(upTo, frameOutputEpoch = upTo) {
    const stream = this._audio.stream;
    if (!stream || stream.closed) return;
    stream.queue = stream.queue.filter((item) => item.outputEpoch > upTo && item.cancelEpoch >= this._cancelEpoch);
    stream.queuedMs = stream.queue.reduce((total, item) => total + item.ms, 0);
    for (const epoch of [...stream.epochs]) if (epoch <= upTo) stream.epochs.delete(epoch);
    try {
      stream.res.write(encodeAudioFrame({ t: "cancel", generation: this._generation, cancelEpoch: this._cancelEpoch,
        outputEpoch: frameOutputEpoch }));
    } catch { this._audioStreamGone(stream); }
  }

  _closeAudioStream(end) {
    const stream = this._audio.stream;
    if (!stream) return;
    this._audioStreamGone(stream);
    if (end) {
      try { stream.res.end(); } catch { /* the socket is already gone */ }
    }
  }

  // Every in-flight page-routed epoch of a dead stream is page-lost, even if a new stream opens.
  _audioStreamGone(stream) {
    if (stream.closed) return;
    stream.closed = true;
    stream.queue.length = 0;
    stream.queuedMs = 0;
    for (const epoch of stream.epochs) {
      if (epoch > this._lastCancelledOutputEpoch) remember(this._audio.lost, epoch);
    }
    stream.epochs.clear();
    if (this._audio.stream === stream) this._audio.stream = null;
  }

  // #283: the first valid face-host.html GET or face-descriptor POST.
  recordPageSeen() {
    if (this._closed || this._pageFirstSeenAt !== null) return false;
    this._pageFirstSeenAt = this._now();
    return true;
  }

  // #283: an authenticated state poll (200 or 204); a poll of an older generation never counts.
  recordPoll(generation) {
    if (this._closed || this._generation === 0 || toPositiveInteger(generation) !== this._generation) return false;
    this._lastPollAt = this._now();
    return true;
  }

  readState({ capability, origin, generation, afterSequence }) {
    if (origin !== this.publicOrigin || !this.verifyCapability(capability)) return null;
    if (toPositiveInteger(generation) !== this._generation) return null;

    const after = toInteger(afterSequence);
    if (after === null) return null;
    if (this._lastDelivery && after >= this._lastDelivery.state.sequence) this._lastDelivery = null;

    if (this._queue.length > 0) {
      const state = this._queue.at(-1);
      this._queue.length = 0;
      this._lastDelivery = { state, attempts: 1 };
      return state.sequence > after ? state : undefined;
    }

    if (
      this._lastDelivery
      && this._lastDelivery.state.sequence > after
      && this._lastDelivery.attempts <= this._retryLimit
    ) {
      this._lastDelivery.attempts += 1;
      return this._lastDelivery.state;
    }

    this._lastDelivery = null;
    return undefined;
  }

  close(reason = "session_end") {
    if (this._closed) return false;
    this._closed = true;
    this._closedReason = reason;
    this._backgroundImage = null;
    this._queue.length = 0;
    this._lastDelivery = null;
    this._capabilityHash.fill(0);
    if (this.pageAudio) {
      // Close and leave: purge, push a cancel frame, then end the response.
      this._cancelEpoch += 1;
      this._cancelAudio(Number.MAX_SAFE_INTEGER, this._outputEpoch);
      this._closeAudioStream(true);
      this._audio.heartbeat = null;
      const listener = this._audio.closeListener;
      this._audio.closeListener = null;
      try { listener?.(); } catch { /* meeting cleanup must continue */ }
    }
    if (this.mode === "face-package") {
      this.facePackage = null;
      this.mountId = null;
      this._utterances.length = 0;
    }
    sessions.delete(this.visualId);
    this._safeLog("local avatar session closed", { visualId: this.visualId, reason });
    return true;
  }

  snapshot() {
    return {
      visualId: this.visualId,
      closed: this._closed,
      expiresAt: this._expiresAt,
      generation: this._generation,
      sourceGeneration: this._sourceGeneration,
      sequence: this._sequence,
      cancelEpoch: this._cancelEpoch,
      outputEpoch: this._outputEpoch,
      lastSampleIndex: this._lastSampleIndex,
      queueSize: this._queue.length,
      queueLimit: this._queueLimit,
      retryLimit: this._retryLimit,
      dropped: this._dropped,
      envelopeDropped: this._envelopeDropped,
      pageFirstSeenAt: this._pageFirstSeenAt,
      firstConnectedAt: this._firstConnectedAt,
      connectedAt: this._connectedAt,
      connectedGeneration: this._connectedGeneration,
      lastPollAt: this._lastPollAt,
      closedReason: this._closedReason,
    };
  }

  _state(kind, values) {
    this._sequence += 1;
    const state = {
      kind,
      generation: this._generation,
      cancelEpoch: this._cancelEpoch,
      sequence: this._sequence,
      outputEpoch: values.outputEpoch,
      sampleIndex: values.sampleIndex,
      sampleRate: values.sampleRate,
    };
    if (this.mode === "face-package") {
      state.utterances = this._utterances.map((item) => ({ ...item }));
      const latest = this._utterances.at(-1);
      if (latest) {
        for (const key of ["utteranceId", "utteranceStartSample", "emotion", "intensity", "emotionRevision"]) state[key] = latest[key];
      }
      state.listening = { id: this._listen.id, active: this._listen.active };
      if (this._listen.cue?.expiresAt > this._now()) state.cue = { ...this._listen.cue };
      // Page-owned epoch: the host's wall-clock timeline stays idle for it (#266 §2.5).
      if (this.pageAudio && this._audio.routed.has(values.outputEpoch)) state.audio = "page";
    }
    if (kind === "marker") {
      state.envelopes = this._envelopeLog.map((segment) => ({
        s: segment.s,
        v: segment.v.slice(),
      }));
    }
    return state;
  }

  _enqueue(state) {
    if (this.mode === "face-package") {
      this._queue.length = 0;
      this._queue.push(state);
      return true;
    }
    if (state.kind === "marker") {
      const markerIndex = this._queue.findIndex((queued) => (
        queued.kind === "marker" && queued.outputEpoch === state.outputEpoch
      ));
      if (markerIndex !== -1) {
        this._queue[markerIndex] = state;
        return true;
      }
    }
    if (this._queue.length >= this._queueLimit) {
      this._dropped += 1;
      return false;
    }
    this._queue.push(state);
    return true;
  }

  _appendEnvelopeSegments(input, sampleRate) {
    if (!Array.isArray(input)) return;
    let pushedValues = 0;
    const accepted = [];
    for (const segment of input) {
      if (segment && Array.isArray(segment.v)) pushedValues += segment.v.length;
      if (pushedValues > MAX_ENVELOPE_PUSH_VALUES) return;
      if (
        !segment
        || !Number.isSafeInteger(segment.s)
        || segment.s < 0
        || !Array.isArray(segment.v)
        || segment.v.length === 0
        || segment.v.some((value) => typeof value !== "number" || !Number.isFinite(value))
      ) {
        return;
      }
      accepted.push({
        s: segment.s,
        v: segment.v.map((value) => Math.max(0, Math.min(1, value))),
      });
    }
    if (accepted.length === 0) return;

    const windowSamples = Math.round(sampleRate * ENVELOPE_WINDOW_MS / 1000);

    for (const segment of accepted) {
      const previous = this._envelopeLog.at(-1);
      if (previous && segment.s === previous.s + previous.v.length * windowSamples) {
        previous.v.push(...segment.v);
      } else {
        this._envelopeLog.push({ s: segment.s, v: segment.v.slice() });
      }
    }
    const newestEnd = this._envelopeLog.reduce(
      (latest, segment) => Math.max(latest, segment.s + segment.v.length * windowSamples),
      0,
    );
    const historyStart = newestEnd - (sampleRate * ENVELOPE_HISTORY_MS / 1000);
    this._trimEnvelopePrefix(windowSamples, (segment) => {
      if (segment.s >= historyStart) return 0;
      return Math.min(segment.v.length, Math.floor((historyStart - segment.s) / windowSamples));
    });

    const totalValues = this._envelopeLog.reduce((total, segment) => total + segment.v.length, 0);
    if (totalValues > MAX_ENVELOPE_VALUES) {
      let excess = totalValues - MAX_ENVELOPE_VALUES;
      this._trimEnvelopePrefix(windowSamples, (segment) => {
        const dropped = Math.min(excess, segment.v.length);
        excess -= dropped;
        return dropped;
      });
    }
  }

  _trimEnvelopePrefix(windowSamples, countForSegment) {
    for (let index = 0; index < this._envelopeLog.length;) {
      const segment = this._envelopeLog[index];
      const dropCount = countForSegment(segment);
      if (dropCount <= 0) {
        index += 1;
        continue;
      }
      this._envelopeDropped += dropCount;
      if (dropCount >= segment.v.length) {
        this._envelopeLog.splice(index, 1);
        continue;
      }
      segment.s += dropCount * windowSamples;
      segment.v.splice(0, dropCount);
      index += 1;
    }
  }

  _safeLog(message, fields) {
    try {
      this._logger?.info?.(redactLogValue(message), redactLogValue(fields));
    } catch {
      // Visual diagnostics must not affect the meeting lifecycle.
    }
  }
}

function getLocalAvatarSession(visualId) {
  return sessions.get(String(visualId || "")) || null;
}

function getFaceMount(mountId) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(mountId || ""))) return null;
  for (const session of sessions.values()) {
    if (session.mode === "face-package" && session.mountId === mountId && session.isLive()) return session;
  }
  return null;
}

function hasLocalAvatarSessions() {
  return sessions.size > 0;
}

function redactLogValue(value) {
  if (typeof value === "string") {
    return value
      .replace(/(\/local-avatar\/pkg\/)[^/\s?]+/gi, "$1[REDACTED]")
      .replace(/([?&]v=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/(#cap=)[^\s&#]+/gi, "$1[REDACTED]")
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1[REDACTED]")
      .replace(/(["'](?:[a-z_-]*(?:token|secret|password|authorization|credential|private_key)|capability|api(?:\s+|[_-]?)key|private-?key)["']\s*:\s*["'])(?!\[REDACTED\])[^"']*/gi, "$1[REDACTED]")
      .replace(/((?:capability|token)\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = /capability|authorization|token|mountId|visualId/i.test(key) ? "[REDACTED]" : redactLogValue(item);
    }
    return redacted;
  }
  return value;
}

// Page audio wire frame: u32be length of the rest, u16be header length, JSON header, PCM (s16le mono).
function encodeAudioFrame(header, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const frame = Buffer.alloc(6 + json.length + payload.length);
  frame.writeUInt32BE(2 + json.length + payload.length, 0);
  frame.writeUInt16BE(json.length, 4);
  json.copy(frame, 6);
  payload.copy(frame, 6 + json.length);
  return frame;
}

function remember(set, value) {
  set.add(value);
  if (set.size <= AUDIO_EPOCH_MEMORY) return;
  for (const old of [...set].sort((a, b) => a - b).slice(0, set.size - AUDIO_EPOCH_MEMORY)) set.delete(old);
}

function hashCapability(capability) {
  return crypto.createHash("sha256").update(String(capability), "utf8").digest();
}

function normalizePublicOrigin(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("local avatar requires a public HTTPS origin");
  }
  return parsed.origin;
}

function toBase64Url(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("randomBytes must return a Buffer");
  return value.toString("base64url");
}

function isValidBackground(value) {
  return Boolean(value)
    && BACKGROUND_MODES.has(value.mode)
    && typeof value.color === "string"
    && /^#[0-9a-f]{6}$/i.test(value.color);
}

function normalizeBackground(value, image = null) {
  if (!isValidBackground(value)) return { ...DEFAULT_BACKGROUND, image: null };
  return { mode: value.mode, color: value.color, image: image ? image.version : null };
}

function normalizeBackgroundImage(background, value) {
  if (!isValidBackground(background) || background.mode !== "image" || !value
      || !Buffer.isBuffer(value.bytes) || value.bytes.length === 0
      || !BACKGROUND_IMAGE_TYPES.has(value.type)
      || typeof value.version !== "string" || !/^[0-9a-f]{16}$/.test(value.version)) {
    return null;
  }
  return { bytes: value.bytes, type: value.type, version: value.version };
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toNonNegativeInteger(value) {
  const parsed = toInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function toPositiveInteger(value) {
  const parsed = toInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

module.exports = {
  HTML_ROUTE,
  FRAMES_HTML_ROUTE,
  SCRIPT_ROUTE,
  FRAMES_SCRIPT_ROUTE,
  STATE_ROUTE,
  AUDIO_ROUTE,
  createLocalAvatarSession,
  getLocalAvatarSession,
  getFaceMount,
  hasLocalAvatarSessions,
  redactLogValue,
  _test: {
    DEFAULT_QUEUE_LIMIT,
    DEFAULT_RETRY_LIMIT,
    MAX_TTL_MS,
    MAX_ENVELOPE_PUSH_VALUES,
    MAX_ENVELOPE_VALUES,
    ENVELOPE_HISTORY_MS,
    AUDIO_HEARTBEAT_FRESH_MS,
    AUDIO_BACKLOG_LIMIT_MS,
    AUDIO_QUEUE_LIMIT_MS,
    encodeAudioFrame,
    sessions,
  },
};
