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
  const MARKER_FRESH_MS = 600;
  const BLINK_DURATION_MS = 150;
  const canvas = document.getElementById("avatar");
  const context = canvas.getContext("2d", { alpha: false });
  const query = new URLSearchParams(location.search);
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
  let currentFrame = "diagnostic";

  function randomBetween(minimum, maximum) {
    return minimum + (Math.random() * (maximum - minimum));
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
    const selected = frames.get(name) ? name : (frames.get("idle") ? "idle" : (framesLoaded ? "diagnostic" : "blank"));
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

  function render(at = Date.now()) {
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

  function acceptState(state, observedAt = Date.now()) {
    if (!state || state.generation !== generation) return false;
    if (!Number.isSafeInteger(state.cancelEpoch) || state.cancelEpoch < cancelEpoch) return false;
    if (!Number.isSafeInteger(state.sequence) || state.sequence <= sequence) return false;
    if (!Number.isSafeInteger(state.outputEpoch) || state.outputEpoch < outputEpoch) return false;

    if (state.cancelEpoch > cancelEpoch) {
      cancelEpoch = state.cancelEpoch;
      outputEpoch = -1;
      sampleIndex = -1;
      enterIdle(observedAt);
    }

    if (state.kind === "cancel" || state.kind === "idle") {
      cancelEpoch = state.cancelEpoch;
      outputEpoch = state.outputEpoch;
      sampleIndex = -1;
      sequence = state.sequence;
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

    cancelEpoch = state.cancelEpoch;
    outputEpoch = state.outputEpoch;
    sampleIndex = state.sampleIndex;
    sequence = state.sequence;
    lastMarkerAt = observedAt;
    speaking = true;
    nextTalkAt = observedAt;
    blinkActive = false;
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
    // it decodes; talk frames fall back to idle until they arrive.
    await loadFrame("idle");
    if (frames.get("idle")) {
      if (speaking) render();
      else drawFrame("idle");
    }
    await Promise.all(FRAME_NAMES.filter((name) => name !== "idle").map(loadFrame));
    framesLoaded = true;
    if (speaking) render();
    else drawFrame("idle");
  }

  async function connect() {
    if (stopped || reconnects >= MAX_RECONNECTS) {
      stopped = true;
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
      }),
      limits: Object.freeze({
        maxReconnects: MAX_RECONNECTS,
        maxBackoffMs: MAX_BACKOFF_MS,
        markerFreshMs: MARKER_FRESH_MS,
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
