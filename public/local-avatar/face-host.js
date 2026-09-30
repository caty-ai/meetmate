/* Face Protocol v1 host. By default no audio ownership: the sample clock only animates pixels.
   With faceAudio=page (#266) this host page, never the package, plays reply PCM. */
(() => {
  "use strict";
  const EMOTIONS = new Set([null, "joy", "trust", "fear", "surprise", "sadness", "disgust", "anger", "anticipation"]);
  const SUPPORTS = new Set(["speak", "level", "emotion", "background", "listen", "cue"]);
  function normalizeSupports(values) {
    if (!Array.isArray(values) || values.length > 32
      || values.some((v) => typeof v !== "string" || !/^[a-z][a-z0-9-]{0,31}(?![\s\S])/.test(v))) throw new Error("supports");
    return [...new Set(values.filter((v) => SUPPORTS.has(v)))];
  }
  const integer = (v) => Number.isSafeInteger(v) && v >= 0;
  const validEmotion = (v) => EMOTIONS.has(v.emotion) && Number.isFinite(v.intensity) && v.intensity >= 0 && v.intensity <= 1;

  // Cumulative sample-indexed utterances survive latest-state delivery. The clock
  // never infers an utterance end from a silent/missing envelope window.
  function createTimeline({ send, now = Date.now, offset = 300, supports = [], listen = false, pageSample }) {
    let generation = 0, sequence = -1, cancelEpoch = -1, epoch = -1;
    let rate = 0, anchor = null, newest = null, windows = [], utterances = [];
    let active = null, revision = -1, completed = new Set(), listening = null, cueId = null;
    // Page-owned epoch (#266 §2.5): the page's scheduled chunks drive the mouth; the wall clock stays idle.
    let pageOwned = false;
    supports = normalizeSupports(supports);
    const has = (name) => supports.includes(name);
    function end(reason) {
      if (active !== null) send({ type: "speak-end", id: active, reason });
      active = null; revision = -1;
    }
    function reset() {
      // Every stop path idles a page-owned mouth fully: speak-end (interrupt) and level 0.
      const pageActive = pageOwned ? active : null;
      end("interrupt");
      if (pageActive !== null) send({ type: "level", id: pageActive, v: 0 });
      if (listening !== null) send({ type: "listen-end", id: listening });
      listening = null; cueId = null;
      rate = 0; anchor = null; newest = null; windows = []; utterances = []; completed = new Set();
      pageOwned = false;
    }
    // After a page stop the mouth goes idle at once and the interrupted segment never resumes.
    function idle() {
      if (!pageOwned || active === null) return;
      const id = active;
      end("interrupt");
      completed.add(id);
      send({ type: "level", id, v: 0 });
    }
    function connect(value) {
      if (!Number.isSafeInteger(value) || value <= generation) return false;
      reset(); generation = value; sequence = -1; cancelEpoch = -1; epoch = -1;
      return true;
    }
    function accept(state) {
      if (!state || state.generation !== generation || !integer(state.sequence) || state.sequence <= sequence
        || !integer(state.cancelEpoch) || state.cancelEpoch < cancelEpoch
        || !Number.isSafeInteger(state.outputEpoch) || state.outputEpoch < epoch
        || !["idle", "cancel", "marker"].includes(state.kind)) return false;
      if (state.cancelEpoch !== cancelEpoch || state.outputEpoch !== epoch) reset();
      cancelEpoch = state.cancelEpoch; epoch = state.outputEpoch; sequence = state.sequence;
      if (listen && has("listen") && state.listening && integer(state.listening.id) && typeof state.listening.active === "boolean") {
        const next = state.listening.active ? state.listening.id : null;
        if (next !== listening) {
          if (listening !== null) send({ type: "listen-end", id: listening });
          listening = next;
          if (listening !== null) send({ type: "listen-start", id: listening });
        }
      }
      if (listen && has("cue") && state.cue && integer(state.cue.id) && state.cue.id !== cueId && validEmotion(state.cue)) {
        cueId = state.cue.id;
        send({ type: "cue", id: cueId, emotion: state.cue.emotion, intensity: state.cue.intensity });
      }
      if (state.kind !== "marker") { reset(); return true; }
      if (state.audio === "page") pageOwned = true;
      if (!Number.isSafeInteger(state.sampleRate) || state.sampleRate <= 0 || !Array.isArray(state.utterances)) return true;
      const nextUtterances = state.utterances.filter((u) => u && integer(u.utteranceId)
        && integer(u.utteranceStartSample) && integer(u.lastSample) && u.lastSample >= u.utteranceStartSample
        && (u.endSample === null || (integer(u.endSample) && u.endSample >= u.utteranceStartSample))
        && integer(u.emotionRevision) && validEmotion(u));
      if (!nextUtterances.length) return true;
      rate = state.sampleRate;
      const width = Math.round(rate / 10);
      const map = new Map(windows);
      for (const segment of state.envelopes || []) {
        if (!segment || !integer(segment.s) || !Array.isArray(segment.v)) continue;
        segment.v.forEach((v, i) => {
          if (Number.isFinite(v) && v >= 0 && v <= 1) map.set(segment.s + i * width, v);
        });
      }
      const endSample = Math.max(...nextUtterances.map((u) => u.lastSample));
      const time = now();
      if (pageOwned) anchor = null;
      else if (anchor === null) anchor = time + offset - nextUtterances[0].utteranceStartSample / rate * 1000;
      else if (newest !== null && endSample > newest && (time - anchor) * rate / 1000 - newest >= rate * 0.5) {
        // The output sample clock pauses during synthesis gaps, even in one epoch.
        anchor = time + offset - newest / rate * 1000;
      }
      newest = endSample;
      windows = [...map].filter(([s]) => s >= endSample - rate * 20).sort((a, b) => a[0] - b[0]);
      utterances = nextUtterances;
      return true;
    }
    function tick() {
      let sample, gap = false;
      if (pageOwned) {
        const position = pageSample ? pageSample(epoch) : null;
        if (!position || !rate) return;
        sample = position.sample; gap = position.gap;
      } else {
        if (anchor === null) return;
        sample = (now() - anchor) * rate / 1000;
      }
      for (const u of utterances) {
        if (completed.has(u.utteranceId) || sample < u.utteranceStartSample) continue;
        if (active !== u.utteranceId) {
          end("end"); active = u.utteranceId; revision = u.emotionRevision;
          send({ type: "speak-start", id: active, emotion: has("emotion") ? u.emotion : null,
            intensity: has("emotion") ? u.intensity : 0 });
        } else if (has("emotion") && revision < u.emotionRevision) {
          revision = u.emotionRevision;
          send({ type: "speak-emotion", id: active, emotion: u.emotion, intensity: u.intensity });
        }
        if (u.endSample !== null && sample >= u.endSample) {
          end("end"); completed.add(u.utteranceId);
          continue;
        }
        const found = windows.find(([s]) => sample >= s && sample < s + Math.round(rate / 10));
        send({ type: "level", id: active, v: gap ? 0 : found?.[1] ?? 0 });
        break;
      }
      // Retained ids only need to cover the bounded server history.
      const ids = new Set(utterances.map((u) => u.utteranceId));
      completed = new Set([...completed].filter((id) => ids.has(id)));
    }
    return { connect, accept, tick, reset, idle };
  }

  // Page audio player (#266 §2.4), faceAudio=page only. Scheduling is driven by stream arrival,
  // never by rAF. One cursor per stream, shared across epochs.
  const LEAD_S = 0.15, GUARD_S = 0.02, MAX_FRAME = 1 << 20;
  function createPlayer({ context, onStop = () => {} }) {
    let generation = 0, cancelEpoch = -1, cancelled = -1, epoch = null, next = 0, received = 0, cursor = 0;
    let nodes = [], rows = [], pending = new Uint8Array(0);
    const now = () => context.currentTime;
    function stopWhere(match) {
      const kept = [];
      for (const node of nodes) {
        if (!match(node)) { kept.push(node); continue; }
        try { node.source.stop(); } catch { /* already stopped */ }
        try { node.source.disconnect(); } catch { /* already disconnected */ }
      }
      nodes = kept;
    }
    // (A) Epoch stop: keep the stream, rewind the cursor, delete the epoch's map rows.
    function epochStop(upTo) {
      stopWhere((node) => node.epoch <= upTo);
      rows = rows.filter((row) => row.epoch > upTo);
      cursor = now();
      if (epoch !== null && epoch <= upTo) { epoch = null; next = 0; received = 0; }
      onStop();
    }
    // (B) Stream stop: no scheduled node outlives its stream.
    function stop() {
      stopWhere(() => true);
      rows = []; epoch = null; next = 0; received = 0; cursor = now(); pending = new Uint8Array(0);
      onStop();
    }
    function begin(value) {
      generation = value; cancelEpoch = -1; cancelled = -1; epoch = null; next = 0; received = 0;
      cursor = now(); pending = new Uint8Array(0);
    }
    function advance(value) {
      if (nodes.length || rows.length) epochStop(Number.MAX_SAFE_INTEGER);
      cancelEpoch = value; cancelled = -1; epoch = null; next = 0; received = 0;
    }
    // A stale cancelEpoch seen on the state poll is an epoch stop too.
    function observe(state) {
      if (state && state.generation === generation && integer(state.cancelEpoch) && state.cancelEpoch > cancelEpoch) advance(state.cancelEpoch);
    }
    function frame(header, pcm) {
      if (!header || header.generation !== generation || !integer(header.cancelEpoch) || header.cancelEpoch < cancelEpoch) return false;
      if (header.t === "cancel") {
        // Everything scheduled under an older cancelEpoch is stale; otherwise stop up to the cancelled epoch.
        const newer = header.cancelEpoch > cancelEpoch;
        const known = Number.isSafeInteger(header.outputEpoch);
        if (newer) { cancelEpoch = header.cancelEpoch; cancelled = -1; }
        if (known) cancelled = Math.max(cancelled, header.outputEpoch);
        epochStop(newer || !known ? Number.MAX_SAFE_INTEGER : header.outputEpoch);
        return true;
      }
      if (header.cancelEpoch > cancelEpoch) advance(header.cancelEpoch);
      if (header.t !== "pcm" || !integer(header.outputEpoch) || header.outputEpoch <= cancelled || !integer(header.firstSampleIndex)
        || !Number.isSafeInteger(header.sampleRate) || header.sampleRate <= 0 || pcm.length < 2) return false;
      if (epoch !== null && header.outputEpoch < epoch) return false;
      const first = header.outputEpoch !== epoch;
      if (first) { epoch = header.outputEpoch; next = 0; received = 0; }
      if (header.firstSampleIndex < next) return false;
      const count = Math.floor(pcm.length / 2);
      const buffer = context.createBuffer(1, count, header.sampleRate);
      const channel = buffer.getChannelData(0);
      const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
      for (let i = 0; i < count; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const start = Math.max(cursor, now() + (first ? LEAD_S : GUARD_S));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const node = { source, epoch };
      source.onended = () => { nodes = nodes.filter((item) => item !== node); };
      source.start(start);
      nodes.push(node);
      cursor = start + count / header.sampleRate;
      rows.push({ epoch, first: header.firstSampleIndex, count, start, rate: header.sampleRate });
      rows = rows.filter((row) => row.epoch === epoch || row.start + row.count / row.rate > now());
      received += count;
      next = header.firstSampleIndex + count;
      return true;
    }
    // Length-prefixed frames: u32be length of the rest, u16be header length, JSON header, s16le PCM.
    function feed(chunk) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending); merged.set(chunk, pending.length);
      const view = new DataView(merged.buffer);
      const decoder = new TextDecoder();
      let offset = 0;
      while (merged.length - offset >= 4) {
        const length = view.getUint32(offset);
        if (length < 2 || length > MAX_FRAME) throw new Error("frame");
        if (merged.length - offset - 4 < length) break;
        const headerLength = view.getUint16(offset + 4);
        if (headerLength > length - 2) throw new Error("frame");
        const header = JSON.parse(decoder.decode(merged.subarray(offset + 6, offset + 6 + headerLength)));
        frame(header, merged.subarray(offset + 6 + headerLength, offset + 4 + length));
        offset += 4 + length;
      }
      pending = merged.slice(offset);
    }
    // Sample position of an epoch on the scheduled chunks; gap = between chunks (silence).
    function position(wanted) {
      const t = now();
      let last = null;
      for (const row of rows) {
        if (row.epoch !== wanted || row.start > t) continue;
        const end = row.start + row.count / row.rate;
        if (t < end) return { sample: row.first + (t - row.start) * row.rate, gap: false };
        if (!last || end > last.end) last = { end, sample: row.first + row.count };
      }
      return last ? { sample: last.sample, gap: true } : null;
    }
    // Heartbeat counters are cumulative samples of playedEpoch only.
    function heartbeat() {
      const t = now();
      let played = 0;
      for (const row of rows) {
        if (row.epoch === epoch) played += Math.max(0, Math.min(row.count, Math.floor((t - row.start) * row.rate)));
      }
      return { state: context.state, playedEpoch: epoch === null ? -1 : epoch, playedSample: Math.min(played, received), receivedSample: received };
    }
    return { begin, feed, frame, observe, stop, position, heartbeat, scheduled: () => nodes.length, cursor: () => cursor };
  }

  if (typeof module !== "undefined" && module.exports) { module.exports = { createTimeline, createPlayer }; return; }

  const visualId = new URLSearchParams(location.search).get("v") || "";
  const capability = new URLSearchParams(location.hash.slice(1)).get("cap") || "";
  history.replaceState(null, "", location.pathname + location.search);
  document.documentElement.style.cssText = "margin:0;height:100%;background:#08111f";
  document.body.style.cssText = "margin:0;height:100%;overflow:hidden";
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "");
  // opacity, not visibility: Chrome throttles rAF in hidden cross-origin frames, so a package waiting for its first frame would never send face-ready.
  frame.style.cssText = "border:0;width:100vw;height:100vh;display:block;opacity:0";
  let descriptor, timeline, ready = false, sequence = -1, generation = 0, background;
  let stopped = false, reconnects = 0, timer;
  // Page audio (descriptor.pageAudio only): { context, player, stream, endedAt }. PCM stays in this page.
  let audio = null;
  // An opaque-origin iframe requires '*'. Only non-secret visual protocol data
  // goes to this specific WindowProxy; capability and mount descriptors stay here.
  const post = (message) => frame.contentWindow?.postMessage(message, "*");
  const request = (route, query = {}, extra = {}) => fetch(`${route}?${new URLSearchParams({ v: visualId, ...query })}`, {
    method: "POST", headers: { Authorization: `Bearer ${capability}` },
    credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", ...extra,
  });
  // (B) stream stop: abort the fetch and stop every scheduled node; the mouth goes idle.
  function stopStream() {
    if (!audio?.stream) return;
    const { controller } = audio.stream;
    audio.stream = null;
    audio.endedAt = Date.now();
    try { controller.abort(); } catch { /* already aborted */ }
    audio.player.stop();
  }
  // A plain POST with a complete (empty) body; opened only while the state poll is healthy.
  function openStream(force) {
    if (!audio || audio.stream || stopped || generation <= 0 || (!force && Date.now() - audio.endedAt < 500)) return;
    const stream = { controller: new AbortController() };
    audio.stream = stream;
    audio.player.begin(generation);
    (async () => {
      try {
        const response = await request("/local-avatar/audio", { generation: String(generation) }, { signal: stream.controller.signal });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        while (audio.stream === stream) {
          const { done, value } = await reader.read();
          if (done || audio.stream !== stream) break;
          audio.player.feed(value);
        }
      } catch { /* fetch error or malformed frame: the stream is over */ }
      finally { if (audio.stream === stream) stopStream(); }
    })();
  }
  function heartbeatBody() {
    if (!audio) return undefined;
    if (audio.context.state === "suspended") audio.context.resume?.()?.catch?.(() => {});
    return { body: JSON.stringify({ audio: audio.player.heartbeat() }) };
  }
  function init() {
    post({ type: "host-init", spec: "face-package/1", supports: descriptor.supports,
      ...(descriptor.viewport ? { viewport: descriptor.viewport } : {}),
      ...(descriptor.quality ? { quality: descriptor.quality } : {}) });
    if (background && descriptor.supports.includes("background")) post({ type: "background", ...background });
  }
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== frame.contentWindow || !descriptor || !data || typeof data !== "object" || Array.isArray(data)
      || (data.spec !== undefined && data.spec !== "face-package/1")) return;
    if (data.type === "face-hello") init();
    if (data.type === "face-ready") {
      if (ready) return;
      ready = true; frame.style.opacity = "1"; init();
      connect();
    }
  });
  const later = (fn, ms) => { if (!stopped) { clearTimeout(timer); timer = setTimeout(fn, ms); } };
  function backoff(retry = connect) {
    timeline?.reset();
    stopStream();
    reconnects = Math.min(reconnects + 1, 5);
    later(retry, Math.min(4000, 250 * 2 ** (reconnects - 1)));
  }
  async function connect() {
    stopStream();
    try {
      const response = await request("/local-avatar/state", { connect: "1" });
      if (response.status === 404 || response.status === 401) { stopped = true; timeline.reset(); return; }
      if (!response.ok) throw new Error("rejected");
      const state = await response.json();
      if (!timeline.connect(state.generation)) throw new Error("generation");
      generation = state.generation;
      background = state.background;
      if (background?.color && /^#[0-9a-f]{6}$/i.test(background.color)) document.documentElement.style.background = background.color;
      init();
      if (!timeline.accept(state)) throw new Error("state");
      sequence = state.sequence;
      openStream(true);
      audio?.player.observe(state);
      later(poll, 100);
    } catch { backoff(); }
  }
  async function poll() {
    try {
      const response = await request("/local-avatar/state", { generation: String(generation), after: String(sequence) }, heartbeatBody());
      if (response.status !== 204) {
        if (response.status === 404 || response.status === 401) { stopped = true; timeline.reset(); stopStream(); return; }
        if (!response.ok) throw new Error("rejected");
        const state = await response.json();
        if (!timeline.accept(state)) throw new Error("state");
        audio?.player.observe(state);
        sequence = state.sequence;
      }
      reconnects = 0;
      openStream(false);
      later(poll, 100);
    } catch { backoff(); }
  }
  async function load() {
    try {
      const response = await request("/local-avatar/face-descriptor");
      if (response.status === 404 || response.status === 401) { stopped = true; return; }
      if (!response.ok) throw new Error("descriptor");
      const candidate = await response.json();
      candidate.supports = normalizeSupports(candidate.supports);
      if (!candidate.supports.includes("speak") || !candidate.supports.includes("level")) throw new Error("supports");
      if (stopped) return;
      reconnects = 0;
      descriptor = candidate;
      const offset = Number.isSafeInteger(descriptor.timelineOffsetMs) && Math.abs(descriptor.timelineOffsetMs) <= 3000
        ? descriptor.timelineOffsetMs : 300;
      if (descriptor.pageAudio === true && typeof AudioContext === "function") {
        try {
          const context = new AudioContext({ latencyHint: "interactive" });
          audio = { context, stream: null, endedAt: -Infinity, player: createPlayer({ context, onStop: () => timeline?.idle() }) };
        } catch { audio = null; }
      }
      timeline = createTimeline({ send: post, offset, supports: descriptor.supports, listen: descriptor.listenReactions === true,
        ...(audio ? { pageSample: (epoch) => audio.player.position(epoch) } : {}) });
      if (descriptor.background) {
        background = descriptor.background;
        document.documentElement.style.background = background.color;
      }
      frame.src = `/local-avatar/pkg/${descriptor.mountId}/${descriptor.entry}${descriptor.query ? `?${descriptor.query}` : ""}`;
      document.body.append(frame);
    } catch { backoff(load); }
  }
  const ticker = setInterval(() => { if (ready && !stopped) timeline.tick(); }, 33);
  addEventListener("pagehide", () => {
    stopped = true; clearTimeout(timer); clearInterval(ticker); stopStream(); timeline?.reset();
    try { audio?.context.close(); } catch { /* already closed */ }
  });
  load();
})();
