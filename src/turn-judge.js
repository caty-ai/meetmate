"use strict";

// #267 opt-in reply trigger: ask jev whether the latest meeting line is spoken
// to the assistant and whether the speaker has finished their turn.
// Owns its HTTP call; shares only the lazy TYPESAFE_API_KEY env var name with
// src/emotion/jev.js. judgeTurn() never throws or rejects: every failure is
// { decision: "ignore", reason }.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const UNKNOWN_LABEL = "unknown";

function buildQuestions(assistantLabel = "Caty") {
  const name = String(assistantLabel || "Caty");
  return {
    addressed: {
      type: "noul",
      instructions: `The latest line is spoken to ${name} (the AI assistant in this meeting) and expects ${name} to answer or act, including a reply to something ${name} just asked or offered, rather than being said to other people in the meeting, being a remark about ${name}, or being only a filler or backchannel such as "um" or "uh-huh".`,
    },
    finished: {
      type: "noul",
      instructions: "The speaker has finished their turn with the latest line (a complete question, request, answer or statement), rather than pausing mid-sentence and about to continue; a line that stops in the middle of a phrase, such as on a particle or an unfinished modifier, is not finished.",
    },
  };
}

function participantLabel(index) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return `参加者${index < letters.length ? letters[index] : index + 1}`;
}

/**
 * Build the jev request state. Speakers are identified by an opaque key and
 * sent as stable pseudonyms (参加者A, 参加者B, …), never by display name;
 * unattributed lines are labelled "unknown" and assistant lines use
 * `assistantLabel`.
 *
 * @param {{ assistantName: string, assistantLabel?: string,
 *   lines: Array<{ speakerKey?: string|null, assistant?: boolean, text: string }>,
 *   latest: { speakerKey?: string|null, text: string } }} input
 */
function buildJudgeState({ assistantName, assistantLabel, lines = [], latest }) {
  const labels = new Map();
  const labelFor = (item) => {
    if (item?.assistant) return assistantLabel || assistantName;
    const key = item?.speakerKey;
    if (key === null || key === undefined || key === "" || key === UNKNOWN_LABEL) return UNKNOWN_LABEL;
    if (!labels.has(key)) labels.set(key, participantLabel(labels.size));
    return labels.get(key);
  };
  const format = (item) => `${labelFor(item)}: ${String(item?.text || "").trim()}`;
  const recent = lines.filter((item) => String(item?.text || "").trim()).map(format);
  return {
    assistant_name: assistantName,
    recent_lines: recent,
    latest_line: format(latest),
  };
}

function decide(addressed, finished, addressedMin, finishedMin) {
  if (addressed >= addressedMin && finished >= finishedMin) return "speak";
  if (addressed >= addressedMin) return "wait";
  return "ignore";
}

/**
 * @param {{ state: object, addressedMin: number, finishedMin: number,
 *   timeoutMs?: number, signal?: AbortSignal|null, fetch?: Function,
 *   questions?: object }} options
 * @returns {Promise<{ decision: "speak"|"wait"|"ignore", addressed: number|null,
 *   finished: number|null, latencyMs: number, reason: string }>}
 */
async function judgeTurn(options = {}) {
  const startedAt = performance.now();
  const result = (decision, reason, addressed = null, finished = null) => ({
    decision,
    addressed,
    finished,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    reason,
  });
  let reason = null;
  let timer = null;
  let onAbort = null;
  const signal = options.signal || null;
  try {
    const {
      state,
      addressedMin,
      finishedMin,
      timeoutMs = 800,
      fetch: fetchImpl = globalThis.fetch,
      questions = buildQuestions(),
    } = options;
    if (signal?.aborted) return result("ignore", "aborted");
    if (!Number.isFinite(addressedMin) || !Number.isFinite(finishedMin)) return result("ignore", "invalid_threshold");
    // Deliberately lazy: never a registry/startup credential.
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) return result("ignore", "no_key");
    if (typeof fetchImpl !== "function") return result("ignore", "no_fetch");

    const controller = new AbortController();
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    onAbort = () => {
      reason ||= "aborted";
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      reason ||= "timeout";
      controller.abort();
    }, Math.max(0, Number(timeoutMs) || 0));
    timer.unref?.();

    const request = Promise.resolve().then(() => fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model: MODEL, state, questions }),
    }));
    request.catch(() => {});
    const response = await Promise.race([request, aborted]);
    if (reason) return result("ignore", reason);
    if (!response || response.ok !== true) {
      const status = Number(response?.status);
      return result("ignore", Number.isInteger(status) && status > 0 ? `http_${status}` : "http_error");
    }
    const parsed = Promise.resolve().then(() => response.json());
    parsed.catch(() => {});
    const body = await Promise.race([parsed, aborted]);
    if (reason) return result("ignore", reason);
    const addressed = body?.answers?.addressed?.noul;
    const finished = body?.answers?.finished?.noul;
    if (typeof addressed !== "number" || !Number.isFinite(addressed)
      || typeof finished !== "number" || !Number.isFinite(finished)) {
      return result("ignore", "invalid_answer");
    }
    const a = Math.max(0, Math.min(1, addressed));
    const f = Math.max(0, Math.min(1, finished));
    return result(decide(a, f, addressedMin, finishedMin), "scores", a, f);
  } catch {
    return result("ignore", reason || "error");
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

module.exports = { ENDPOINT, MODEL, buildQuestions, buildJudgeState, judgeTurn };
