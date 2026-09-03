"use strict";

const { complete: requestOpenClaw } = require("../llm-openclaw");
const { complete: requestOpenAi } = require("../llm-openai");
const { getPublishedValue, getRuntime, meaningful } = require("./resolver");
const { canonicalHostname } = require("../url-utils");

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const LLM_TIMEOUT_MS = 15_000;
const DISCORD_GUILDS_PAGE_SIZE = 200;

const DESCRIPTORS = Object.freeze({
  soniox: Object.freeze({
    endpoint: "https://api.soniox.com/v1/models",
    method: "GET",
    credentialId: "soniox_api_key",
    authScheme: "Bearer",
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
  deepgram: Object.freeze({
    endpoint: "https://api.deepgram.com/v1/projects",
    method: "GET",
    credentialId: "deepgram_api_key",
    authScheme: "Token",
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
  "fish-audio": Object.freeze({
    endpoint: "https://api.fish.audio/model?page_size=1&page_number=1&self=true",
    method: "GET",
    credentialId: "fish_audio_api_key",
    authScheme: "Bearer",
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
  elevenlabs: Object.freeze({
    endpoint: "https://api.elevenlabs.io/v1/user/subscription",
    method: "GET",
    credentialId: "elevenlabs_api_key",
    authHeader: "xi-api-key",
    authScheme: "",
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
  "openai-compatible": Object.freeze({
    endpoint: ({ openAiTtsBaseUrl }) => `${String(openAiTtsBaseUrl || "").replace(/\/+$/, "")}/v1/models`,
    method: "GET",
    credentialId: "openai_compatible_tts_api_key",
    authHeader: "Authorization",
    authScheme: "Bearer",
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
  attendee: Object.freeze({
    endpoint: ({ attendeeBaseUrl }) => `https://${attendeeBaseUrl}/api/v1/bots?page_size=1`,
    method: "GET",
    credentialId: "attendee_api_key",
    authScheme: "Token",
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
  llm: Object.freeze({
    endpoint: "chatCompletions",
    method: "POST",
    credentialId: "provider-specific",
    authScheme: "Bearer",
    headers: Object.freeze({ "Content-Type": "application/json" }),
    timeoutMs: LLM_TIMEOUT_MS,
    body: Object.freeze({
      messages: Object.freeze([{ role: "user", content: "ping" }]),
      max_tokens: 1,
      stream: false,
      user: "meetmate-probe",
    }),
    // Production LLM clients use node:http/node:https. requestFn is deliberately
    // separate from the fetchFn seam used by the other provider probes.
    transport: "requestFn",
  }),
  tunnel: Object.freeze({
    endpoint: "resolved-public-origin/health",
    method: "GET",
    credentialId: null,
    authScheme: null,
    headers: Object.freeze({ Accept: "application/json", "ngrok-skip-browser-warning": "true" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
  discord: Object.freeze({
    endpoint: "https://discord.com/api/v10/users/@me",
    method: "GET",
    credentialId: "discord_bot_token",
    authScheme: "Bot",
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    transport: "fetchFn",
  }),
});

function result(code, message) {
  return { ok: code === "CONNECTED", code, ...(message ? { message } : {}) };
}

function classifyStatus(status, options = {}) {
  if (status >= 200 && status < 300) return result("CONNECTED");
  if (status === 401 || (status === 403 && ["attendee", "discord"].includes(options.system))) return result("AUTH_FAILED");
  if (status === 402) return result("PAYMENT_REQUIRED");
  if (status === 429) return result("RATE_LIMITED");
  if (status === 404 && options.system === "llm") {
    return options.llmProvider === "openclaw"
      ? result("NOT_ENABLED", "OpenClaw 側で gateway.http.endpoints.chatCompletions.enabled を有効にしてください")
      : result("PROVIDER_ERROR", "ベースURL/モデル名を確認してください");
  }
  if ((status === 404 || status === 405) && options.system === "openai-compatible") {
    return result("CONNECTED", "The optional /v1/models probe endpoint is not implemented");
  }
  return result("PROVIDER_ERROR");
}

function networkCode(error, timedOut = false) {
  if (timedOut) return "TIMEOUT";
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1, current = current.cause) {
    if (["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(current.code)) {
      return "UNREACHABLE";
    }
  }
  return "PROVIDER_ERROR";
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR" || /abort/i.test(String(error?.message || ""));
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch { /* response bodies are never retained */ }
}

function parseFetchJsonError(error, context = {}) {
  if (context.signal?.reason === context.timeoutReason && isAbortError(error)) throw error;
  return result("PROVIDER_ERROR");
}

function buildFetchProbeRequest(system, options = {}, override = {}) {
  const descriptor = DESCRIPTORS[system];
  const credential = descriptor?.credentialId ? getPublishedValue(descriptor.credentialId) : null;
  const openAiTtsBaseUrl = getPublishedValue("openai_compatible_tts_base_url");
  if (system === "openai-compatible") {
    const hostname = canonicalHostname(openAiTtsBaseUrl);
    if (!hostname) return { outcome: result("NOT_CONFIGURED") };
    if (hostname === "api.openai.com" && !meaningful(credential)) return { outcome: result("NOT_CONFIGURED") };
  } else if (descriptor?.credentialId && !meaningful(credential)) {
    return { outcome: result("NOT_CONFIGURED") };
  }

  const endpointContext = {
    attendeeBaseUrl: getPublishedValue("attendee_base_url"),
    openAiTtsBaseUrl,
  };
  const endpoint = options.endpoints?.[override.endpointKey || system]
    || override.endpoint
    || (typeof descriptor.endpoint === "function" ? descriptor.endpoint(endpointContext) : descriptor.endpoint);
  const headers = { ...descriptor.headers };
  if (meaningful(credential)) {
    const authHeader = descriptor.authHeader || "Authorization";
    headers[authHeader] = descriptor.authScheme ? `${descriptor.authScheme} ${credential}` : credential;
  }
  return {
    endpoint,
    method: override.method || descriptor.method,
    headers,
    timeoutMs: override.timeoutMs ?? options.timeoutMs ?? descriptor.timeoutMs,
  };
}

async function withFetchProbeResponse(system, options = {}, override = {}, consume = async (response) => response) {
  const request = buildFetchProbeRequest(system, options, override);
  if (request.outcome) return request.outcome;
  const controller = new AbortController();
  const timeoutReason = new Error(`${system} probe timeout`);
  const timer = setTimeout(() => controller.abort(timeoutReason), request.timeoutMs);
  timer.unref?.();
  try {
    const response = await (options.fetchFn || globalThis.fetch)(request.endpoint, {
      method: request.method,
      headers: request.headers,
      redirect: "error",
      signal: controller.signal,
    });
    return await consume(response, {
      signal: controller.signal,
      timeoutReason,
    });
  } catch (error) {
    const timedOut = error === timeoutReason || (controller.signal.reason === timeoutReason && isAbortError(error));
    return result(networkCode(error, timedOut));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProbe(system, options = {}) {
  return withFetchProbeResponse(system, options, {}, async (response) => {
    await cancelBody(response);
    return classifyStatus(response.status, { system });
  });
}

function llmConnection(provider) {
  const runtime = getRuntime();
  if (provider === "openai-compatible") {
    return {
      baseUrl: getPublishedValue("openai_base_url"),
      apiKey: runtime.startup.connection.openaiApiKey,
    };
  }
  return {
    openclawUrl: runtime.startup.connection.openclawUrl,
    openclawToken: runtime.startup.connection.openclawToken,
  };
}

async function llmProbe(options = {}) {
  const provider = String(getPublishedValue("llm_provider") || "openclaw").toLowerCase();
  const model = getPublishedValue("llm_model");
  const connection = llmConnection(provider);
  const configured = provider === "openai-compatible"
    ? meaningful(connection.baseUrl) && meaningful(connection.apiKey) && meaningful(model)
    : meaningful(connection.openclawUrl) && meaningful(connection.openclawToken) && meaningful(model);
  if (!configured) return result("NOT_CONFIGURED");

  const requestFn = options.requestFn
    || options.requestFns?.[provider]
    || (provider === "openai-compatible" ? requestOpenAi : requestOpenClaw);
  try {
    const response = await requestFn(DESCRIPTORS.llm.body.messages, {
      ...connection,
      model,
      maxTokens: DESCRIPTORS.llm.body.max_tokens,
      user: DESCRIPTORS.llm.body.user,
      timeoutMs: options.timeoutMs ?? DESCRIPTORS.llm.timeoutMs,
      timeoutError: "LLM probe timeout",
    });
    const classified = classifyStatus(Number(response?.statusCode || 0), { system: "llm", llmProvider: provider });
    if (!classified.ok) return classified;
    let body;
    try { body = JSON.parse(String(response?.body ?? response?.text ?? "")); } catch { return result("PROVIDER_ERROR"); }
    return Array.isArray(body?.choices) ? result("CONNECTED") : result("PROVIDER_ERROR");
  } catch (error) {
    return result(/timeout/i.test(String(error?.message || "")) ? "TIMEOUT" : networkCode(error));
  }
}

async function fetchHealth(origin, options = {}) {
  const controller = new AbortController();
  const timeoutReason = new Error("Tunnel probe timeout");
  const timer = setTimeout(() => controller.abort(timeoutReason), options.timeoutMs ?? DESCRIPTORS.tunnel.timeoutMs);
  timer.unref?.();
  try {
    const url = new URL("/health", origin).toString();
    const response = await (options.fetchFn || globalThis.fetch)(url, {
      method: "GET",
      headers: DESCRIPTORS.tunnel.headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await cancelBody(response);
      return { code: "UNREACHABLE" };
    }
    let payload;
    try { payload = await response.json(); } catch { return { code: "UNREACHABLE" }; }
    if (!payload || typeof payload !== "object" || !Object.prototype.hasOwnProperty.call(payload, "instanceId")) {
      return { code: "UNREACHABLE" };
    }
    return { code: "CONNECTED", instanceId: payload.instanceId };
  } catch (error) {
    const timedOut = error === timeoutReason || (controller.signal.reason === timeoutReason && isAbortError(error));
    return { code: timedOut ? "TIMEOUT" : "UNREACHABLE" };
  } finally {
    clearTimeout(timer);
  }
}

async function tunnelProbe(options = {}) {
  const resolved = await options.resolvePublicOrigin?.();
  if (!resolved?.origin) return result("NOT_CONFIGURED");
  const health = await fetchHealth(resolved.origin, options);
  if (health.code !== "CONNECTED") {
    return result(health.code, "プロキシや ngrok の警告ページが介在している可能性があります");
  }
  return health.instanceId === options.instanceId
    ? result("CONNECTED")
    : result("MISMATCH", "公開URLは別の meetmate インスタンスを指しています");
}

function remainingTimeoutMs(startedAt, timeoutMs, now) {
  return timeoutMs - Math.max(0, now() - startedAt);
}

function buildDiscordGuildsEndpoint(endpoint, after) {
  const url = new URL(endpoint);
  url.searchParams.set("limit", String(DISCORD_GUILDS_PAGE_SIZE));
  if (after) url.searchParams.set("after", after);
  else url.searchParams.delete("after");
  return url.toString();
}

async function discordProbe(options = {}) {
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs ?? DESCRIPTORS.discord.timeoutMs;
  const startedAt = now();
  const authTimeoutMs = remainingTimeoutMs(startedAt, timeoutMs, now);
  if (authTimeoutMs <= 0) return result("TIMEOUT");
  const authenticated = await withFetchProbeResponse("discord", options, {
    timeoutMs: authTimeoutMs,
  }, async (response) => {
    const classified = classifyStatus(response.status, { system: "discord" });
    await cancelBody(response);
    return classified;
  });
  if (!authenticated.ok) return authenticated;

  const allowlist = [...new Set(
    (Array.isArray(getPublishedValue("discord_guild_allowlist")) ? getPublishedValue("discord_guild_allowlist") : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
  )];
  if (allowlist.length === 0) return result("CONNECTED");

  const baseEndpoint = options.endpoints?.discordGuilds || "https://discord.com/api/v10/users/@me/guilds";
  const seenCursors = new Set();
  let after = "";
  while (true) {
    const remainingMs = remainingTimeoutMs(startedAt, timeoutMs, now);
    if (remainingMs <= 0) return result("TIMEOUT");
    // Discord guild listings cap pages at 200 entries; traverse with `after`
    // while the single wall-clock probe budget still has time remaining.
    const page = await withFetchProbeResponse("discord", options, {
      endpointKey: "__discordGuildsPage",
      endpoint: buildDiscordGuildsEndpoint(baseEndpoint, after),
      timeoutMs: remainingMs,
    }, async (response, context) => {
      const guildsStatus = classifyStatus(response.status, { system: "discord" });
      if (!guildsStatus.ok) {
        await cancelBody(response);
        return guildsStatus;
      }
      let guilds;
      try {
        guilds = await response.json();
      } catch (error) {
        return parseFetchJsonError(error, context);
      }
      if (!Array.isArray(guilds)) return result("PROVIDER_ERROR");
      return { ok: true, code: "CONNECTED", guilds };
    });
    if (!page.ok) return page;
    const guilds = page.guilds;
    const presentGuildIds = new Set(guilds.map((entry) => String(entry?.id || "")).filter(Boolean));
    if (allowlist.some((guildId) => presentGuildIds.has(guildId))) return result("CONNECTED");
    if (guilds.length < DISCORD_GUILDS_PAGE_SIZE) {
      return result("ALLOWLIST_MISMATCH", "Bot が許可済みの Discord サーバーに参加していません");
    }
    const nextAfter = String(guilds.at(-1)?.id || "").trim();
    if (!nextAfter || seenCursors.has(nextAfter)) return result("PROVIDER_ERROR");
    seenCursors.add(nextAfter);
    after = nextAfter;
  }
}

function normalizedHost(value) {
  try { return new URL(value).host.toLowerCase(); } catch { return ""; }
}

async function checkWsUrlIdentity(wsUrl, options = {}) {
  const submittedHost = normalizedHost(wsUrl);
  const resolved = await options.resolvePublicOrigin?.({ submittedHost });
  const canonicalHost = normalizedHost(resolved?.origin);
  if (submittedHost && canonicalHost && submittedHost === canonicalHost) return result("CONNECTED");
  const candidates = resolved?.candidateHosts instanceof Set
    ? resolved.candidateHosts
    : new Set(resolved?.candidateHosts || []);
  if (!submittedHost || !candidates.has(submittedHost)) {
    return result("UNREACHABLE", "指定の公開URLが設定と一致しません");
  }
  const health = await fetchHealth(`https://${submittedHost}`, options);
  if (health.code !== "CONNECTED") return result("UNREACHABLE");
  return health.instanceId === options.instanceId
    ? result("CONNECTED")
    : result("MISMATCH", "入力された公開URLは別のサーバーを指しています");
}

async function probeSystem(system, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(DESCRIPTORS, system)) return result("PROVIDER_ERROR");
  if (system === "llm") return llmProbe(options);
  if (system === "tunnel") return tunnelProbe(options);
  if (system === "discord") return discordProbe(options);
  return fetchProbe(system, options);
}

module.exports = {
  DESCRIPTORS,
  checkWsUrlIdentity,
  classifyStatus,
  fetchHealth,
  networkCode,
  probeSystem,
  _test: { buildDiscordGuildsEndpoint, discordProbe, llmProbe, normalizedHost, remainingTimeoutMs, tunnelProbe },
};
