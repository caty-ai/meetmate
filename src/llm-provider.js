// llm-provider.js — LLM provider dispatcher
// Selects the LLM backend via options.provider or the LLM_PROVIDER env var
// (default: "openclaw"). Keeps streamChat as a plain pass-through so call
// sites continue supplying backend options directly.
//
// provider=openclaw → src/llm-openclaw.js (default, unchanged behavior)
// unknown provider  → openclaw fallback (openai-compatible arrives in A-7c)

const { streamChat, complete, timeoutHandoff } = require("./llm-openclaw");

function openclawProvider() {
  return {
    name: "openclaw",
    streamChat,
    complete,
    warmup: undefined,
    timeoutHandoff,
  };
}

function createLlmProvider(options = {}) {
  const provider = String(
    options.provider || process.env.LLM_PROVIDER || "openclaw",
  ).toLowerCase();

  if (provider === "openclaw") {
    return openclawProvider();
  }

  console.error(
    "⚠️  LLM provider=" + provider + " は未対応です。openclaw にフォールバックします。",
  );
  return openclawProvider();
}

module.exports = { createLlmProvider };
