(() => {
  "use strict";

  const STATE_ROUTE = "/local-avatar/state";
  const MAX_RECONNECTS = 6;
  const BASE_BACKOFF_MS = 250;
  const MAX_BACKOFF_MS = 4000;
  const POLL_MS = 100;
  const canvas = document.getElementById("avatar");
  const context = canvas.getContext("2d", { alpha: false });
  const query = new URLSearchParams(location.search);
  const visualId = query.get("v") || "";
  const fragment = new URLSearchParams(location.hash.slice(1));
  const capability = fragment.get("cap") || "";

  history.replaceState(null, "", `${location.pathname}${location.search}`);

  let generation = 0;
  let cancelEpoch = -1;
  let sequence = -1;
  let outputEpoch = -1;
  let sampleIndex = -1;
  let reconnects = 0;
  let stopped = false;
  let scheduled = null;

  function drawIdle() {
    context.fillStyle = "#08111f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#8ba3bc";
    context.font = "32px monospace";
    context.textAlign = "center";
    context.fillText("IDLE", canvas.width / 2, canvas.height / 2);
  }

  function drawMarker(index, epoch) {
    const position = index % canvas.width;
    context.fillStyle = "#08111f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#39d98a";
    context.fillRect(position, 0, 4, canvas.height);
    context.fillStyle = "#e7f4ff";
    context.font = "40px monospace";
    context.textAlign = "center";
    context.fillText(`epoch ${epoch} sample ${index}`, canvas.width / 2, canvas.height / 2);
  }

  function acceptState(state) {
    if (!state || state.generation !== generation) return false;
    if (!Number.isSafeInteger(state.cancelEpoch) || state.cancelEpoch < cancelEpoch) return false;
    if (!Number.isSafeInteger(state.sequence) || state.sequence <= sequence) return false;
    if (!Number.isSafeInteger(state.outputEpoch) || state.outputEpoch < outputEpoch) return false;

    if (state.cancelEpoch > cancelEpoch) {
      cancelEpoch = state.cancelEpoch;
      outputEpoch = -1;
      sampleIndex = -1;
      drawIdle();
    }

    if (state.kind === "cancel" || state.kind === "idle") {
      cancelEpoch = state.cancelEpoch;
      outputEpoch = state.outputEpoch;
      sampleIndex = -1;
      sequence = state.sequence;
      drawIdle();
      return true;
    }

    if (
      state.kind !== "marker"
      || !Number.isSafeInteger(state.sampleIndex)
      || state.sampleIndex < 0
      || (state.outputEpoch === outputEpoch && state.sampleIndex <= sampleIndex)
    ) {
      return false;
    }

    cancelEpoch = state.cancelEpoch;
    outputEpoch = state.outputEpoch;
    sampleIndex = state.sampleIndex;
    sequence = state.sequence;
    drawMarker(sampleIndex, outputEpoch);
    return true;
  }

  function schedule(fn, delay) {
    if (stopped) return;
    if (scheduled !== null) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      fn();
    }, delay);
  }

  function stateUrl(parameters) {
    const search = new URLSearchParams({ v: visualId, ...parameters });
    return `${STATE_ROUTE}?${search.toString()}`;
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

  async function connect() {
    if (stopped || reconnects >= MAX_RECONNECTS) {
      stopped = true;
      drawIdle();
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
      schedule(poll, POLL_MS);
    } catch {
      drawIdle();
      reconnects += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** (reconnects - 1)));
      schedule(connect, backoff);
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      const response = await requestState({ generation: String(generation), after: String(sequence) });
      if (response.status === 204) {
        schedule(poll, POLL_MS);
        return;
      }
      if (!response.ok) throw new Error("state rejected");
      acceptState(await response.json());
      schedule(poll, POLL_MS);
    } catch {
      generation = 0;
      cancelEpoch = -1;
      sequence = -1;
      outputEpoch = -1;
      sampleIndex = -1;
      drawIdle();
      reconnects += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** (reconnects - 1)));
      schedule(connect, backoff);
    }
  }

  Object.defineProperty(globalThis, "__localAvatarContract", {
    value: Object.freeze({
      acceptState,
      getState: () => ({ generation, cancelEpoch, sequence, outputEpoch, sampleIndex, stopped }),
      limits: Object.freeze({ maxReconnects: MAX_RECONNECTS, maxBackoffMs: MAX_BACKOFF_MS }),
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });

  drawIdle();
  if (/^[A-Za-z0-9_-]{16,64}$/.test(visualId) && capability) connect();
})();
