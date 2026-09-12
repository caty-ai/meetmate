"use strict";

const { createLlmProvider } = require("../llm-provider");
const { EMOTION_TAGS, stripCanonicalEmotionTags } = require("../messages");

function backendUnavailable(config) {
  const llm = config.llm || {};
  const connection = llm.provider === "openai-compatible" ? llm.openaiCompatible : llm.gateway;
  if (llm.provider === "openai-compatible") {
    return connection?.baseUrl && connection?.apiKey ? null : "Live backend OpenAI-compatible connection is missing";
  }
  return connection?.url && connection?.token ? null : "Live backend OpenClaw connection is missing";
}

function conversationInstructions(config) {
  // The shared pipeline addendum asks for TTS control tags and turn-based
  // speech. Live needs conversation instructions, not those transport rules.
  const profile = (config.llm.systemPrompt || config.systemPrompt || "").split("\n")
    .filter(line => !EMOTION_TAGS.some(({ tag }) => line.includes(tag))
      && !/感情タグ|\[\[\[chat:|相手の話をしっかり聞いてから応答する/.test(line)).join("\n");
  return profile + "\n\nあなたは設定された本人の音声会話の窓口です。自然で短い日本語で話してください。短い相槌を含め、各発言の最後に必ず句点または疑問符を付けてください。"
    + "\nBackchannel policy: 短い相槌は適度に。返答の邪魔をしないでください。"
    + "\nInterruption policy: 相手が割り込んだら話すのを止めて聞いてください。"
    + "\nDelegation policy:\nBackend tools: 本人の記憶・判断・会話・作業を担当するバックエンド。"
    + "\nDelegate to the backend when: 挨拶や相槌以外の質問・相談・依頼への回答が必要なとき。"
    + "\nDo not delegate to the backend when: 挨拶、相槌、聞き返し、届いた回答の言い直しだけのとき。"
    + "\nバックエンドから結果が来る前に答えを推測しないでください。感情タグや演出指示は出力しないでください。";
}

async function runLiveBackend(config, turns, sessionUser, signal, onResult, streamOverride) {
  const llm = config.llm;
  const stream = streamOverride || createLlmProvider({ provider: llm.provider }).streamChat;
  const messages = [
    { role: "system", content: "音声会話の途中です。以下の会話の最新の質問・相談に、あなた自身として短い日本語で答えてください。最初の一文で要点を伝えてください。音声用の感情タグやマークダウンは不要です。" },
    ...turns.map(turn => ({ ...turn })),
  ];
  let pending = "", sent = false;
  const emit = text => {
    const clean = stripCanonicalEmotionTags(text);
    if (!signal.aborted && clean) { onResult(clean); sent = true; }
  };
  for await (const chunk of stream(messages, {
    openclawUrl: llm.gateway?.url, openclawToken: llm.gateway?.token,
    openclawSystemAddendum: "音声会話中です。短い日本語で回答し、感情タグは付けないでください。",
    ...(llm.provider === "openai-compatible" ? llm.openaiCompatible : {}),
    sessionUser: sessionUser ?? undefined, model: llm.model, temperature: llm.temperature, maxTokens: llm.maxTokens,
    timeoutMs: llm.responseTimeoutMs || 60000, signal,
  })) {
    if (signal.aborted) return;
    pending += chunk;
    // Send each complete sentence once. Do not wait for a long backend turn,
    // and do not send raw token fragments for Live to repeatedly paraphrase.
    let match;
    while ((match = pending.match(/^([\s\S]*?[。！？!?\n])/))) {
      emit(match[1]); pending = pending.slice(match[1].length);
    }
  }
  emit(pending);
  if (!sent && !signal.aborted) throw new Error("Live backend returned no speech");
}

module.exports = { backendUnavailable, conversationInstructions, runLiveBackend };
