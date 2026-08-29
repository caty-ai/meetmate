(() => {
  "use strict";

  const STATE_ROUTE = "/local-avatar/state";
  const FRAME_ROUTE = "/local-avatar/frames";
  const FRAME_NAMES = Object.freeze(["idle", "talk1", "talk2", "talk3", "blink", "talk_blink"]);
  const MAX_RECONNECTS = 6;
  const BASE_BACKOFF_MS = 250;
  const MAX_BACKOFF_MS = 4000;
  const POLL_MS = 100;
  const RENDER_MS = 40;
  const IDLE_GRACE_MS = 15000;
  const MARKER_FRESH_MS = 600;
  const BLINK_DURATION_MS = 150;
  const DEFAULT_OFFSET_MS = 300;
  const MAX_OFFSET_MS = 5000;
  const ENVELOPE_END_GRACE_MS = 300;
  const FORWARD_REANCHOR_MS = 500;
  const LEVEL_ONE_THRESHOLD = 0.375;
  const LEVEL_TWO_THRESHOLD = 0.75;
  const canvas = document.getElementById("avatar");
  const context = canvas.getContext("2d", { alpha: false });
  const query = new URLSearchParams(location.search);
  const offsetValue = query.get("offset");
  const parsedOffset = offsetValue === null || offsetValue.trim() === "" ? NaN : Number(offsetValue);
  const OFFSET_MS = Number.isFinite(parsedOffset) && parsedOffset >= 0 && parsedOffset <= MAX_OFFSET_MS
    ? parsedOffset
    : DEFAULT_OFFSET_MS;
  const visualId = query.get("v") || "";
  const fragment = new URLSearchParams(location.hash.slice(1));
  const capability = fragment.get("cap") || "";

  history.replaceState(null, "", `${location.pathname}${location.search}`);

  const frames = new Map();
  let generation = 0;
  let cancelEpoch = -1;
  let sequence = -1;
  let outputEpoch = -1;
  let sampleIndex = -1;
  let reconnects = 0;
  let stopped = false;
  let networkTimer = null;
  let renderTimer = null;
  let speaking = false;
  let lastMarkerAt = -Infinity;
  let nextTalkAt = 0;
  let nextBlinkAt = Date.now() + randomBetween(4000, 7000);
  let blinkUntil = 0;
  let blinkActive = false;
  let envelopeNextBlinkAt = null;
  let envelopeBlinkUntil = 0;
  const envelopeSchedule = createEnvelopeSchedule(Date.now);
  let envelopeActive = false;
  let currentFrame = "diagnostic";

  function randomBetween(minimum, maximum) {
    return minimum + (Math.random() * (maximum - minimum));
  }

  function createEnvelopeSchedule(now) {
    let epoch = -1;
    let sampleRate = 0;
    let windowSamples = 0;
    let windows = [];
    let earliestSample = null;
    let newestEndSample = null;
    let playbackStartWall = null;
    let anchorDecided = false;
    let pastEndSince = null;

    function reset(nextEpoch = -1) {
      epoch = nextEpoch;
      sampleRate = 0;
      windowSamples = 0;
      windows = [];
      earliestSample = null;
      newestEndSample = null;
      playbackStartWall = null;
      anchorDecided = false;
      pastEndSince = null;
    }

    function accept(nextEpoch, rate, envelopes, offsetMs) {
      if (nextEpoch !== epoch) reset(nextEpoch);
      sampleRate = rate;
      windowSamples = Math.round(rate / 10);

      const deduped = new Map();
      for (const segment of envelopes) {
        if (!segment || !Number.isSafeInteger(segment.s) || segment.s < 0 || !Array.isArray(segment.v)) continue;
        for (let index = 0; index < segment.v.length; index += 1) {
          const value = segment.v[index];
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) continue;
          deduped.set(segment.s + index * windowSamples, value);
        }
      }
      windows = [...deduped].sort((left, right) => left[0] - right[0]);
      if (windows.length === 0) return { mode: "pending" };

      const earliest = windows[0][0];
      const newestEnd = windows.at(-1)[0] + windowSamples;
      earliestSample = earliest;
      newestEndSample = newestEnd;
      const arrivalNow = now();
      if (!anchorDecided) {
        anchorDecided = true;
        if (earliest <= 2 * windowSamples) {
          playbackStartWall = arrivalNow + offsetMs - (earliest / sampleRate * 1000);
        }
      }
      if (playbackStartWall === null) return { mode: "fallback" };

      const sampleNow = (arrivalNow - playbackStartWall) * sampleRate / 1000;
      if (sampleNow - newestEnd >= sampleRate * FORWARD_REANCHOR_MS / 1000) {
        playbackStartWall = arrivalNow - (newestEnd / sampleRate * 1000);
      }
      pastEndSince = null;
      return { mode: "anchored" };
    }

    function lookup(at = now()) {
      if (playbackStartWall === null || earliestSample === null || newestEndSample === null) return { kind: "fallback" };
      const sampleNow = (at - playbackStartWall) * sampleRate / 1000;
      if (sampleNow < earliestSample) {
        pastEndSince = null;
        return { kind: "envelope", value: 0, sampleNow, phase: "before" };
      }
      for (const [start, value] of windows) {
        if (sampleNow >= start && sampleNow < start + windowSamples) {
          pastEndSince = null;
          return { kind: "envelope", value, sampleNow, phase: "window" };
        }
      }
      if (sampleNow < newestEndSample) {
        pastEndSince = null;
        return { kind: "fallback", sampleNow, phase: "hole" };
      }
      if (pastEndSince === null) pastEndSince = at;
      return {
        kind: "envelope",
        value: 0,
        sampleNow,
        phase: "past",
        idle: at - pastEndSince >= ENVELOPE_END_GRACE_MS,
      };
    }

    function prune(at = now()) {
      if (playbackStartWall === null || windows.length === 0) return;
      const sampleNow = (at - playbackStartWall) * sampleRate / 1000;
      const cutoff = sampleNow - 2 * sampleRate;
      windows = windows.filter(([start]) => start + windowSamples >= cutoff);
    }

    function snapshot() {
      return {
        epoch,
        sampleRate,
        windowSamples,
        windowCount: windows.length,
        playbackStartWall,
        anchorDecided,
        mode: playbackStartWall !== null ? "anchored" : (anchorDecided ? "fallback" : "pending"),
      };
    }

    return Object.freeze({ reset, accept, lookup, prune, snapshot });
  }

  let framesLoaded = false;

  function drawBlank() {
    context.fillStyle = "#08111f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    currentFrame = "blank";
  }

  function drawDiagnostic() {
    context.fillStyle = "#08111f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#8ba3bc";
    context.font = "32px monospace";
    context.textAlign = "center";
    context.fillText("IDLE", canvas.width / 2, canvas.height / 2);
    currentFrame = "diagnostic";
  }

  function drawFrame(name) {
    // Pre-load fallback keeps whatever is on screen (startup blank, or the
    // grace diagnostic) so a marker can never repaint a latched diagnostic
    // back to blank while frames are still in flight.
    const selected = frames.get(name) ? name : (frames.get("idle") ? "idle" : (framesLoaded ? "diagnostic" : currentFrame));
    if (selected === currentFrame) return;
    if (selected === "diagnostic") {
      drawDiagnostic();
      return;
    }
    if (selected === "blank") {
      drawBlank();
      return;
    }
    context.fillStyle = "#08111f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    // Contain-fit: preserve the frame's aspect ratio, centered with letterboxing,
    // so square/portrait character art is never stretched across the 16:9 tile.
    const image = frames.get(selected);
    const sourceWidth = image.width || canvas.width;
    const sourceHeight = image.height || canvas.height;
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(image, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
    currentFrame = selected;
  }

  function enterIdle(at = Date.now()) {
    speaking = false;
    lastMarkerAt = -Infinity;
    nextTalkAt = 0;
    blinkActive = false;
    blinkUntil = 0;
    nextBlinkAt = at + randomBetween(4000, 7000);
    drawFrame("idle");
  }

  function resetEnvelopeState(nextEpoch = -1) {
    envelopeSchedule.reset(nextEpoch);
    envelopeActive = false;
  }

  function renderLegacy(at) {
    if (speaking) {
      if (at - lastMarkerAt >= MARKER_FRESH_MS) {
        enterIdle(at);
        return;
      }
      if (at >= nextTalkAt) {
        const name = Math.random() < 0.1
          ? "talk_blink"
          : `talk${1 + Math.floor(Math.random() * 3)}`;
        drawFrame(name);
        nextTalkAt = at + randomBetween(1000 / 12, 1000 / 8);
      }
      return;
    }

    if (blinkActive) {
      if (at >= blinkUntil) enterIdle(at);
      return;
    }
    if (at >= nextBlinkAt) {
      blinkActive = true;
      blinkUntil = at + BLINK_DURATION_MS;
      drawFrame("blink");
    }
  }

  function renderEnvelope(at) {
    const lookup = envelopeSchedule.lookup(at);
    if (lookup.kind === "fallback") {
      renderLegacy(at);
      return;
    }

    envelopeSchedule.prune(at);
    if (envelopeNextBlinkAt === null) envelopeNextBlinkAt = at + randomBetween(2500, 5000);
    if (at >= envelopeNextBlinkAt) {
      envelopeBlinkUntil = at + BLINK_DURATION_MS;
      envelopeNextBlinkAt = at + randomBetween(2500, 5000);
    }
    const level = lookup.value < LEVEL_ONE_THRESHOLD
      ? 0
      : (lookup.value < LEVEL_TWO_THRESHOLD ? 1 : 2);
    if (lookup.idle === true) speaking = false;
    else speaking = true;
    if (at < envelopeBlinkUntil) {
      drawFrame(level > 0 ? "talk_blink" : "blink");
      return;
    }
    if (level === 0) {
      drawFrame("idle");
    } else if (level === 1) {
      drawFrame("talk1");
    } else {
      const schedule = envelopeSchedule.snapshot();
      const playbackMs = lookup.sampleNow / schedule.sampleRate * 1000;
      drawFrame(Math.floor(playbackMs / 300) % 2 === 0 ? "talk2" : "talk3");
    }
  }

  function render(at = Date.now()) {
    if (envelopeActive) renderEnvelope(at);
    else renderLegacy(at);
  }

  function acceptState(state, observedAt = Date.now()) {
    if (!state || state.generation !== generation) return false;
    if (!Number.isSafeInteger(state.cancelEpoch) || state.cancelEpoch < cancelEpoch) return false;
    if (!Number.isSafeInteger(state.sequence) || state.sequence <= sequence) return false;
    if (!Number.isSafeInteger(state.outputEpoch) || state.outputEpoch < outputEpoch) return false;

    if (state.cancelEpoch > cancelEpoch) {
      cancelEpoch = state.cancelEpoch;
      outputEpoch = -1;
      sampleIndex = -1;
      resetEnvelopeState();
      enterIdle(observedAt);
    }

    if (state.kind === "cancel" || state.kind === "idle") {
      cancelEpoch = state.cancelEpoch;
      outputEpoch = state.outputEpoch;
      sampleIndex = -1;
      sequence = state.sequence;
      resetEnvelopeState(state.outputEpoch);
      enterIdle(observedAt);
      return true;
    }

    if (
      state.kind !== "marker"
      || !Number.isSafeInteger(state.sampleIndex)
      || state.sampleIndex < 0
      || !Number.isSafeInteger(state.sampleRate)
      || state.sampleRate <= 0
      || (state.outputEpoch === outputEpoch && state.sampleIndex <= sampleIndex)
    ) {
      return false;
    }

    if (state.outputEpoch !== outputEpoch) resetEnvelopeState(state.outputEpoch);
    cancelEpoch = state.cancelEpoch;
    outputEpoch = state.outputEpoch;
    sampleIndex = state.sampleIndex;
    sequence = state.sequence;
    lastMarkerAt = observedAt;
    speaking = true;
    nextTalkAt = observedAt;
    blinkActive = false;
    if (Array.isArray(state.envelopes)) {
      const accepted = envelopeSchedule.accept(state.outputEpoch, state.sampleRate, state.envelopes, OFFSET_MS);
      envelopeActive = accepted.mode === "anchored";
    } else {
      envelopeActive = false;
    }
    render(observedAt);
    return true;
  }

  function scheduleNetwork(fn, delay) {
    if (stopped) return;
    if (networkTimer !== null) clearTimeout(networkTimer);
    networkTimer = setTimeout(() => {
      networkTimer = null;
      fn();
    }, delay);
  }

  function scheduleRender() {
    if (stopped) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
      scheduleRender();
    }, RENDER_MS);
  }

  function stateUrl(parameters) {
    const search = new URLSearchParams({ v: visualId, ...parameters });
    return `${STATE_ROUTE}?${search.toString()}`;
  }

  function frameUrl(name) {
    const search = new URLSearchParams({ v: visualId });
    return `${FRAME_ROUTE}/${name}.png?${search.toString()}`;
  }

  async function requestState(parameters) {
    return fetch(stateUrl(parameters), {
      method: "POST",
      headers: { Authorization: `Bearer ${capability}` },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  }

  async function loadFrame(name) {
    try {
      const response = await fetch(frameUrl(name), {
        method: "GET",
        headers: { Authorization: `Bearer ${capability}` },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("frame rejected");
      frames.set(name, await createImageBitmap(await response.blob()));
    } catch {
      frames.set(name, null);
    }
  }

  async function loadFrames() {
    // The full frame set can take tens of seconds on a narrow public tunnel,
    // so fetch the idle frame alone at full bandwidth and paint it the moment
    // it decodes; talk frames fall back to idle until they arrive. If the
    // idle fetch stalls past the grace window, show the diagnostic instead of
    // an unbounded blank tile — loading continues and a late idle replaces it.
    const grace = setTimeout(() => {
      if (!frames.get("idle") && !framesLoaded && currentFrame === "blank") drawDiagnostic();
    }, IDLE_GRACE_MS);
    await loadFrame("idle");
    clearTimeout(grace);
    if (frames.get("idle")) {
      if (speaking) render();
      else drawFrame("idle");
    } else if (currentFrame === "blank") {
      drawDiagnostic();
    }
    await loadFrame("blink");
    await Promise.all(FRAME_NAMES.filter((name) => name !== "idle" && name !== "blink").map(loadFrame));
    framesLoaded = true;
    if (speaking) render();
    else drawFrame("idle");
  }

  async function connect() {
    if (stopped || reconnects >= MAX_RECONNECTS) {
      stopped = true;
      resetEnvelopeState();
      enterIdle();
      return;
    }

    try {
      const response = await requestState({ connect: "1" });
      if (!response.ok) throw new Error("connection rejected");
      const state = await response.json();
      if (!Number.isSafeInteger(state.generation) || state.generation <= generation) {
        throw new Error("stale connection generation");
      }
      generation = state.generation;
      cancelEpoch = -1;
      sequence = -1;
      outputEpoch = -1;
      sampleIndex = -1;
      resetEnvelopeState();
      if (!acceptState(state)) throw new Error("invalid initial state");
      scheduleNetwork(poll, POLL_MS);
    } catch {
      enterIdle();
      reconnects += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** (reconnects - 1)));
      scheduleNetwork(connect, backoff);
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      const response = await requestState({ generation: String(generation), after: String(sequence) });
      if (response.status === 204) {
        scheduleNetwork(poll, POLL_MS);
        return;
      }
      if (!response.ok) throw new Error("state rejected");
      acceptState(await response.json());
      scheduleNetwork(poll, POLL_MS);
    } catch {
      generation = 0;
      cancelEpoch = -1;
      sequence = -1;
      outputEpoch = -1;
      sampleIndex = -1;
      resetEnvelopeState();
      enterIdle();
      reconnects += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** (reconnects - 1)));
      scheduleNetwork(connect, backoff);
    }
  }

  Object.defineProperty(globalThis, "__localAvatarFramesContract", {
    value: Object.freeze({
      acceptState,
      render,
      getState: () => ({
        generation,
        cancelEpoch,
        sequence,
        outputEpoch,
        sampleIndex,
        speaking,
        lastMarkerAt,
        currentFrame,
        stopped,
        envelopeActive,
        envelope: envelopeSchedule.snapshot(),
      }),
      limits: Object.freeze({
        maxReconnects: MAX_RECONNECTS,
        maxBackoffMs: MAX_BACKOFF_MS,
        markerFreshMs: MARKER_FRESH_MS,
        offsetMs: OFFSET_MS,
      }),
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });

  if (/^[A-Za-z0-9_-]{16,64}$/.test(visualId) && capability) {
    drawBlank();
    scheduleRender();
    loadFrames();
    connect();
  } else {
    drawDiagnostic();
    scheduleRender();
  }
})();
