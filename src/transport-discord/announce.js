"use strict";

const DEFAULT_TIMEOUT_MS = 15_000;

function formatWakeWords(wakeWords) {
  const items = Array.isArray(wakeWords)
    ? wakeWords.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  return items.join("、");
}

function renderAnnounceText(agentDisplayName, wakeWords) {
  const displayName = String(agentDisplayName || "AI").trim() || "AI";
  const wakeWordText = formatWakeWords(wakeWords);
  const callout = wakeWordText ? `${wakeWordText}と呼びかけられたときだけ応答し、` : "";
  return `私は${displayName}です。${callout}音声を文字起こしして返答します。会話の記録は運営者に保存されます。`;
}

function readPlaybackDuration(state) {
  return Number(
    state?.resource?.playbackDuration
    ?? state?.playbackDuration
    ?? 0
  );
}

async function runAnnounce(options = {}) {
  const {
    audioOut,
    synthesize,
    synthOptions = {},
    text,
    sampleRate,
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    loadVoiceModule = () => require("@discordjs/voice"),
    timers = globalThis,
  } = options;

  if (!audioOut || typeof audioOut.onAudio !== "function" || typeof audioOut.finish !== "function") {
    throw new Error("audioOut with onAudio() and finish() is required");
  }
  if (typeof synthesize !== "function") throw new Error("synthesize function is required");

  const player = audioOut.getPlayer();
  const voice = loadVoiceModule();
  const playingStatus = voice.AudioPlayerStatus?.Playing || "playing";
  const idleStatus = voice.AudioPlayerStatus?.Idle || "idle";
  let totalBytes = 0;
  let sawPlaying = false;
  let playerError = null;
  let timedOut = false;
  let aborted = signal?.aborted === true;
  let timeout = null;
  let maxPlaybackDuration = 0;
  let cleanup = () => {};

  const timeoutResult = new Promise((resolve) => {
    timeout = timers.setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, code: "timeout" });
    }, timeoutMs);
    timeout.unref?.();
  });

  const waitForIdle = new Promise((resolve) => {
    cleanup = () => {
      player?.removeListener?.("stateChange", onStateChange);
      player?.removeListener?.("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };

    const finish = (result) => {
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      finish({ ok: false, code: "aborted" });
    };

    const onError = (error) => {
      playerError = error;
      finish({ ok: false, code: "player_error", error });
    };

    const onStateChange = (oldState, newState) => {
      const status = newState?.status ?? newState;
      maxPlaybackDuration = Math.max(
        maxPlaybackDuration,
        readPlaybackDuration(oldState),
        readPlaybackDuration(newState)
      );
      if (status === playingStatus) {
        sawPlaying = true;
      }
      if (status === idleStatus && sawPlaying) {
        finish({
          ok: true,
          playbackDuration: Math.max(readPlaybackDuration(oldState), maxPlaybackDuration),
        });
      }
    };

    player?.on?.("stateChange", onStateChange);
    player?.on?.("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });

  const synthPromise = Promise.resolve().then(() => synthesize(text, {
    ...synthOptions,
    sampleRate,
    signal,
    onAudio(chunk) {
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
      totalBytes += chunk.length;
      audioOut.onAudio(chunk, { outputEpoch: 0 });
    },
  })).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, code: signal?.aborted ? "aborted" : "synthesis_error", error }),
  );

  try {
    const synthResult = await Promise.race([synthPromise, timeoutResult]);
    if (synthResult.ok !== true) {
      if (timedOut) {
        signal?.throwIfAborted?.();
      }
      return { ok: false, code: synthResult.code, error: synthResult.error || null, totalBytes };
    }
    if (totalBytes === 0) {
      return { ok: false, code: "zero_audio", totalBytes, playbackDuration: 0 };
    }

    audioOut.finish();
    const idleResult = await Promise.race([waitForIdle, timeoutResult]);
    if (!idleResult.ok) {
      return {
        ok: false,
        code: timedOut ? "timeout" : aborted ? "aborted" : playerError ? "player_error" : idleResult.code,
        error: playerError || idleResult.error || null,
        totalBytes,
      };
    }

    const expectedDurationMs = totalBytes === 0 ? 0 : (totalBytes / 2 / sampleRate) * 1000;
    const playbackDuration = idleResult.playbackDuration || 0;
    if (!sawPlaying) {
      return { ok: false, code: "never_played", totalBytes, playbackDuration };
    }
    if (playbackDuration < expectedDurationMs * 0.8) {
      return { ok: false, code: "duration_short", totalBytes, playbackDuration, expectedDurationMs };
    }

    return {
      ok: true,
      text,
      totalBytes,
      playbackDuration,
      expectedDurationMs,
    };
  } finally {
    timers.clearTimeout(timeout);
    cleanup();
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  renderAnnounceText,
  runAnnounce,
};
