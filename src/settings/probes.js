"use strict";

const { complete: requestOpenClaw } = require("../llm-openclaw");
const { complete: requestOpenAi } = require("../llm-openai");
const { getPublishedValue, getRuntime, meaningful } = require("./resolver");

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const LLM_TIMEOUT_MS = 15_000;

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
});

function result(code, message) {
  return { ok: code === "CONNECTED", code, ...(message ? { message } : {}) };
}

function classifyStatus(status, options = {}) {
  if (status >= 200 && status < 300) return result("CONNECTED");
  if (status === 401 || (status === 403 && options.system === "attendee")) return result("AUTH_FAILED");
  if (status === 402) return result("PAYMENT_REQUIRED");
  if (status === 429) return result("RATE_LIMITED");
  if (status === 404 && options.system === "llm") {
    return options.llmProvider === "openclaw"
      ? result("NOT_ENABLED", "OpenClaw 側で gateway.http.endpoints.chatCompletions.enabled を有効にしてください")
      : result("PROVIDER_ERROR", "ベースURL/モデル名を確認してください");
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

async function fetchProbe(system, options = {}) {
  const descriptor = DESCRIPTORS[system];
  const credential = getPublishedValue(descriptor.credentialId);
  const openAiTtsBaseUrl = getPublishedValue("openai_compatible_tts_base_url");
  if (system === "openai-compatible") {
    let hosted = false;
    try { hosted = new URL(openAiTtsBaseUrl).hostname.toLowerCase() === "api.openai.com"; } catch { return result("NOT_CONFIGURED"); }
    if (hosted && !meaningful(credential)) return result("NOT_CONFIGURED");
  } else if (!meaningful(credential)) {
    return result("NOT_CONFIGURED");
  }

  const controller = new AbortController();
  const timeoutReason = new Error(`${system} probe timeout`);
  const timer = setTimeout(() => controller.abort(timeoutReason), options.timeoutMs ?? descriptor.timeoutMs);
  timer.unref?.();
  try {
    const endpointContext = {
      attendeeBaseUrl: getPublishedValue("attendee_base_url"),
      openAiTtsBaseUrl,
    };
    const endpoint = options.endpoints?.[system]
      || (typeof descriptor.endpoint === "function" ? descriptor.endpoint(endpointContext) : descriptor.endpoint);
    const headers = { ...descriptor.headers };
    if (meaningful(credential)) {
      const authHeader = descriptor.authHeader || "Authorization";
      headers[authHeader] = descriptor.authScheme ? `${descriptor.authScheme} ${credential}` : credential;
    }
    const response = await (options.fetchFn || globalThis.fetch)(endpoint, {
      method: descriptor.method,
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    await cancelBody(response);
    return classifyStatus(response.status, { system });
  } catch (error) {
    const timedOut = error === timeoutReason || (controller.signal.reason === timeoutReason && isAbortError(error));
    return result(networkCode(error, timedOut));
  } finally {
    clearTimeout(timer);
  }
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
  return fetchProbe(system, options);
}

module.exports = {
  DESCRIPTORS,
  checkWsUrlIdentity,
  classifyStatus,
  fetchHealth,
  networkCode,
  probeSystem,
  _test: { llmProbe, normalizedHost, tunnelProbe },
};
