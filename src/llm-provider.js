// llm-provider.js — LLM provider dispatcher
// Selects the LLM backend via options.provider or the LLM_PROVIDER env var
// (default: "openclaw"). Keeps streamChat as a plain pass-through so call
// sites continue supplying backend options directly.
//
// provider=openclaw          → src/llm-openclaw.js (default, unchanged behavior)
// provider=openai-compatible → src/llm-openai.js
// unknown provider           → openclaw fallback

const { streamChat, complete, timeoutHandoff } = require("./llm-openclaw");
const openai = require("./llm-openai");

function openclawProvider() {
  return {
    name: "openclaw",
    streamChat,
    complete,
    warmup: undefined,
    timeoutHandoff,
  };
}

function openaiCompatibleProvider() {
  return {
    name: "openai-compatible",
    streamChat: openai.streamChat,
    complete: openai.complete,
    warmup: undefined,
    timeoutHandoff: undefined,
  };
}

function createLlmProvider(options = {}) {
  const provider = String(
    options.provider || process.env.LLM_PROVIDER || "openclaw",
  ).toLowerCase();

  if (provider === "openclaw") {
    return openclawProvider();
  }

  if (provider === "openai-compatible") {
    return openaiCompatibleProvider();
  }

  console.error(
    "⚠️  LLM provider=" + provider + " は未対応です。openclaw にフォールバックします。",
  );
  return openclawProvider();
}

module.exports = { createLlmProvider };
