/* Face Protocol v1 host. No audio ownership: the sample clock only animates pixels. */
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
  function createTimeline({ send, now = Date.now, offset = 300, supports = [], listen = false }) {
    let generation = 0, sequence = -1, cancelEpoch = -1, epoch = -1;
    let rate = 0, anchor = null, newest = null, windows = [], utterances = [];
    let active = null, revision = -1, completed = new Set(), listening = null, cueId = null;
    supports = normalizeSupports(supports);
    const has = (name) => supports.includes(name);
    function end(reason) {
      if (active !== null) send({ type: "speak-end", id: active, reason });
      active = null; revision = -1;
    }
    function reset() {
      end("interrupt");
      if (listening !== null) send({ type: "listen-end", id: listening });
      listening = null; cueId = null;
      rate = 0; anchor = null; newest = null; windows = []; utterances = []; completed = new Set();
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
      if (anchor === null) anchor = time + offset - nextUtterances[0].utteranceStartSample / rate * 1000;
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
      if (anchor === null) return;
      const sample = (now() - anchor) * rate / 1000;
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
        send({ type: "level", id: active, v: found?.[1] ?? 0 });
        break;
      }
      // Retained ids only need to cover the bounded server history.
      const ids = new Set(utterances.map((u) => u.utteranceId));
      completed = new Set([...completed].filter((id) => ids.has(id)));
    }
    return { connect, accept, tick, reset };
  }

  if (typeof module !== "undefined" && module.exports) { module.exports = { createTimeline }; return; }

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
  // An opaque-origin iframe requires '*'. Only non-secret visual protocol data
  // goes to this specific WindowProxy; capability and mount descriptors stay here.
  const post = (message) => frame.contentWindow?.postMessage(message, "*");
  const request = (route, query = {}) => fetch(`${route}?${new URLSearchParams({ v: visualId, ...query })}`, {
    method: "POST", headers: { Authorization: `Bearer ${capability}` },
    credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
  });
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
    reconnects = Math.min(reconnects + 1, 5);
    later(retry, Math.min(4000, 250 * 2 ** (reconnects - 1)));
  }
  async function connect() {
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
      later(poll, 100);
    } catch { backoff(); }
  }
  async function poll() {
    try {
      const response = await request("/local-avatar/state", { generation: String(generation), after: String(sequence) });
      if (response.status !== 204) {
        if (response.status === 404 || response.status === 401) { stopped = true; timeline.reset(); return; }
        if (!response.ok) throw new Error("rejected");
        const state = await response.json();
        if (!timeline.accept(state)) throw new Error("state");
        sequence = state.sequence;
      }
      reconnects = 0;
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
      timeline = createTimeline({ send: post, offset, supports: descriptor.supports, listen: descriptor.listenReactions === true });
      if (descriptor.background) {
        background = descriptor.background;
        document.documentElement.style.background = background.color;
      }
      frame.src = `/local-avatar/pkg/${descriptor.mountId}/${descriptor.entry}${descriptor.query ? `?${descriptor.query}` : ""}`;
      document.body.append(frame);
    } catch { backoff(load); }
  }
  const ticker = setInterval(() => { if (ready && !stopped) timeline.tick(); }, 33);
  addEventListener("pagehide", () => { stopped = true; clearTimeout(timer); clearInterval(ticker); timeline?.reset(); });
  load();
})();
