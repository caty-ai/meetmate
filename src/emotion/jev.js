"use strict";
const { VOCABULARY, questions } = require("./jev-questions");

async function askJev(text, { fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = 800, listening = false } = {}) {
  if (signal?.aborted) throw new Error("cancelled");
  // Deliberately lazy: never a registry/startup credential.
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("unavailable");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer;
  try {
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
      controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    return await Promise.race([expired, (async () => {
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model: "jev-latest", state: { speaker: "the speaker", line: text }, questions: questions(listening) }),
      });
      if (!response.ok) throw new Error("unavailable");
      const answers = (await response.json())?.answers;
      const emotion = answers?.emotion?.choice;
      const intensity = answers?.strong?.noul;
      if (!Object.hasOwn(VOCABULARY, emotion) || typeof intensity !== "number" || !Number.isFinite(intensity)) throw new Error("invalid");
      return emotion === "neutral" ? null : { emotion, intensity: Math.max(0, Math.min(1, intensity)) };
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
module.exports = { askJev };
