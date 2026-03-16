// llm.js — LLM streaming wrapper
// Supports two backends:
//   1. OpenClaw Gateway (full Caty with SOUL/memory/tools/skills)
//   2. OpenRouter (fallback, direct Claude API)

const http = require("http");
const https = require("https");

// Voice-specific system prompt builder (appended to OpenClaw's SOUL.md)
// emotionTags: boolean — include emotion tag instructions (default true)
function buildVoiceAddendum({ emotionTags = true } = {}) {
  const emotionLine = emotionTags
    ? "- すべての文の先頭に感情タグを付ける。使えるタグ: [calm], [happy], [curious], [soft tone], [excited], [nervous], [grateful], [laughing], [confident]\n"
    : "";

  return `あなたは音声通話中です。

【応答ルール】
- 短く話す（1回の発話は2〜3文まで。長くならないこと！）
${emotionLine}- コードブロック、マークダウン記法、長いリスト、テーブルは使わない（音声で読み上げるので）
- 相手の話をしっかり聞いてから応答する
- 音声では結論→次アクションを優先。詳細はSlackで共有する

【ツール実行ルール】
音声通話中は会話を止めないことが最優先。

軽い処理（直接実行OK）:
  memory_search、天気、単発web検索、短いメッセージ送信、1回で終わる確認系
  → 「ちょっと調べるね」等のつなぎを入れてから実行

重い処理（sessions_spawnで委譲）:
  複数ステップ、長文読解、ファイル/リポジトリ横断、exec、
  Deep Research、GitHub操作、デバッグ、スキル発動
  → 「調べてみるね、サブエージェントに頼んでおくね」と即答
  → 詳細はSlackに投稿、口頭では要約だけ伝える

判断に迷ったら: まず軽い方で試す。
タイムアウトした場合は自動でサブエージェントに切り替わるので安心して試してOK。

【サブエージェント結果の報告】
セッション履歴にサブエージェントの結果が返ってきている場合は、
ユーザーの発話に応答した後、「あ、さっきの結果が返ってきたみたい」と自発的に報告すること。
詳細はSlackを参照するよう案内し、口頭では短い要約を伝える。`;
}

// Default addendum (backward compat)
const VOICE_SYSTEM_ADDENDUM = buildVoiceAddendum({ emotionTags: true });

/**
 * Stream a chat completion.
 *
 * @param {string|null} systemPrompt - System prompt (used for OpenRouter only; ignored for OpenClaw)
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {object} options
 * @param {string} [options.apiKey] - OpenRouter API key (fallback mode)
 * @param {string} [options.openclawUrl] - OpenClaw Gateway URL (e.g., "http://localhost:18789")
 * @param {string} [options.openclawToken] - OpenClaw Gateway token
 * @param {string} [options.sessionUser] - User/session ID for OpenClaw session isolation
 * @param {string} [options.openclawSystemAddendum] - System addendum override for OpenClaw voice mode
 * @param {string} [options.model] - Model ID
 * @param {number} [options.temperature] - Temperature (default: 0.5)
 * @param {number} [options.maxTokens] - Max tokens (default: 300)
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @returns {AsyncGenerator<string>} Yields text chunks
 */
async function* streamChat(systemPrompt, messages, options = {}) {
  const useOpenClaw = !!(options.openclawUrl && options.openclawToken);

  if (useOpenClaw) {
    yield* streamOpenClaw(messages, options);
  } else {
    yield* streamOpenRouter(systemPrompt, messages, options);
  }
}

// ── OpenClaw Gateway backend ────────────────────────────────────────

async function* streamOpenClaw(messages, options) {
  const gatewayUrl = new URL(options.openclawUrl);
  const token = options.openclawToken;
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens || 500; // Higher for tool use responses

  // Build messages: voice addendum as system + user messages only
  // (OpenClaw injects SOUL.md/AGENTS.md/memory automatically)
  const systemAddendum =
    typeof options.openclawSystemAddendum === "string"
      ? options.openclawSystemAddendum
      : VOICE_SYSTEM_ADDENDUM;

  const apiMessages = [
    { role: "system", content: systemAddendum },
    ...messages,
  ];

  const body = JSON.stringify({
    model: options.model || "anthropic/claude-sonnet-4-6",
    stream: true,
    temperature,
    max_tokens: maxTokens,
    messages: apiMessages,
    ...(options.sessionUser ? { user: options.sessionUser } : {}),
  });

  const isHttps = gatewayUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const response = await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: gatewayUrl.hostname,
        port: gatewayUrl.port || (isHttps ? 443 : 80),
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => resolve(res)
    );

    req.on("error", reject);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(new Error("LLM request aborted"));
      }, { once: true });
    }

    req.setTimeout(60_000, () => {
      req.destroy(new Error("OpenClaw Gateway request timeout"));
    });

    req.write(body);
    req.end();
  });

  if (response.statusCode !== 200) {
    let errBody = "";
    for await (const chunk of response) errBody += chunk;
    throw new Error(`OpenClaw Gateway error (${response.statusCode}): ${errBody.slice(0, 200)}`);
  }

  yield* parseSSE(response, options.signal);
}

// ── OpenRouter backend (fallback) ───────────────────────────────────

async function* streamOpenRouter(systemPrompt, messages, options) {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for LLM");

  const model = options.model || "anthropic/claude-sonnet-4-5";
  const temperature = options.temperature ?? 0.5;
  const maxTokens = options.maxTokens || 300;

  const body = JSON.stringify({
    model,
    stream: true,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  });

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "openrouter.ai",
        port: 443,
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "HTTP-Referer": "https://example.com/private-repo",
          "X-Title": "AI Phone",
        },
      },
      (res) => resolve(res)
    );

    req.on("error", reject);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(new Error("LLM request aborted"));
      }, { once: true });
    }

    req.setTimeout(30_000, () => {
      req.destroy(new Error("LLM request timeout"));
    });

    req.write(body);
    req.end();
  });

  if (response.statusCode !== 200) {
    let errBody = "";
    for await (const chunk of response) errBody += chunk;
    throw new Error(`OpenRouter API error (${response.statusCode}): ${errBody.slice(0, 200)}`);
  }

  yield* parseSSE(response, options.signal);
}

// ── Shared SSE parser ───────────────────────────────────────────────

async function* parseSSE(response, signal) {
  let buffer = "";
  for await (const chunk of response) {
    if (signal?.aborted) break;

    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // skip unparseable lines
      }
    }
  }

  // Flush remaining
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
      try {
        const parsed = JSON.parse(trimmed.slice(6));
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // skip
      }
    }
  }
}

module.exports = { streamChat, VOICE_SYSTEM_ADDENDUM, buildVoiceAddendum };
