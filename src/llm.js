// llm.js — LLM streaming wrapper (OpenClaw Gateway only)
// Gateway provides full agent experience: SOUL/memory/tools/skills

const http = require("http");
const https = require("https");
const { filterSilentRepliesStream } = require("./speech-policy");

// Voice-specific system prompt builder (appended to OpenClaw's SOUL.md)
// emotionTags: boolean — include emotion tag instructions (default true)
function buildVoiceAddendum({ emotionTags = true } = {}) {
  const emotionLine = emotionTags
    ? "- すべての文の先頭に感情タグを付ける。使えるタグ: (calm), (happy), (curious), (soft tone), (excited), (nervous), (grateful), (laughing), (confident)\n"
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
詳細はSlackを参照するよう案内し、口頭では短い要約を伝える。

【絶対禁止事項】
NO_REPLY は絶対に使わないこと（音声通話ではサイレント応答は不可）。
何があっても必ずテキストで応答すること。
返すことがない場合は「了解！何かあったら言ってね」のように一言添えること。`;
}

// Default addendum (backward compat)
const VOICE_SYSTEM_ADDENDUM = buildVoiceAddendum({ emotionTags: true });

/**
 * Stream a chat completion via OpenClaw Gateway.
 *
 * @param {Array<{role: string, content: string}>} messages - Conversation messages
 * @param {object} options
 * @param {string} options.openclawUrl - OpenClaw Gateway URL (required)
 * @param {string} options.openclawToken - OpenClaw Gateway token (required)
 * @param {string} [options.sessionUser] - User/session ID for OpenClaw session isolation
 * @param {string} [options.openclawSystemAddendum] - System addendum override for OpenClaw voice mode
 * @param {string} [options.model] - Model ID
 * @param {number} [options.temperature] - Temperature (default: 0.5)
 * @param {number} [options.maxTokens] - Max tokens (default: 300)
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @returns {AsyncGenerator<string>} Yields text chunks
 */
async function* streamChat(messages, options = {}) {
  if (!options.openclawUrl || !options.openclawToken) {
    throw new Error('OpenClaw Gateway is required. Set OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN.');
  }

  // First attempt
  const attempt1 = collectChunks(streamOpenClaw(messages, options));
  const result1 = await attempt1;

  // Empty response auto-retry (max 1 retry)
  if (result1.text.length === 0 && !options.signal?.aborted) {
    console.warn(`⚠️  [llm] Empty response on attempt 1 (session=${options.sessionUser}) — retrying...`);
    const attempt2 = collectChunks(streamOpenClaw(messages, options));
    const result2 = await attempt2;
    if (result2.text.length > 0) {
      console.log(`✅  [llm] Retry succeeded (${result2.text.length} chars)`);
    } else {
      console.warn(`⚠️  [llm] Empty response on attempt 2 — giving up`);
    }
    yield* result2.chunks;
    return;
  }

  yield* result1.chunks;
}

/**
 * Collect all chunks from an async generator into an array + concatenated text.
 * Returns both for diagnostic logging and replay.
 */
async function collectChunks(source) {
  const chunks = [];
  let text = "";
  for await (const chunk of source) {
    chunks.push(chunk);
    text += chunk;
  }
  // Return chunks as an async generator for yield* compatibility
  return {
    chunks: (async function* () { for (const c of chunks) yield c; })(),
    text
  };
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
    // OpenClaw Gateway /v1/chat/completions: `model` selects the OpenClaw agent
    // (or is ignored depending on routing). Do not hardcode a foundation model here.
    model: options.model || "openclaw", 
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

  yield* filterSilentRepliesStream(parseSSE(response, options.signal));
}

// ── SSE parser ──────────────────────────────────────────────────────

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
