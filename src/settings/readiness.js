"use strict";

const probes = require("./probes");
const { resolveBotHostTarget } = require("../attendee-endpoint");
const { diagnosticIdFor } = require("./diagnostic-id");
const {
  buildEnvelope,
  getPublishedValue,
  getRawConfig,
  getStatus,
  registerCacheInvalidator,
} = require("./resolver");

const BILLING_SYSTEMS = new Set(["fish-audio", "elevenlabs", "openai-compatible", "llm"]);
const HARD_CODES = new Set([
  "AUTH_FAILED", "NOT_CONFIGURED", "PAYMENT_REQUIRED", "NOT_ENABLED", "MISMATCH", "RESTART_REQUIRED",
]);
const SOFT_CODES = new Set(["TIMEOUT", "UNREACHABLE", "RATE_LIMITED", "PROVIDER_ERROR"]);
const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const FAILURE_BACKOFF_MS = 30_000;
const JOIN_REVALIDATION_BUDGET_MS = 8_000;

const FIELD_SYSTEMS = Object.freeze({
  stt_provider: Object.freeze(["soniox", "deepgram"]),
  soniox_api_key: Object.freeze(["soniox"]),
  soniox_model: Object.freeze(["soniox"]),
  soniox_ws_url: Object.freeze(["soniox"]),
  soniox_endpoint_sensitivity: Object.freeze(["soniox"]),
  soniox_max_endpoint_delay_ms: Object.freeze(["soniox"]),
  soniox_endpoint_latency_level: Object.freeze(["soniox"]),
  deepgram_api_key: Object.freeze(["deepgram"]),
  fish_audio_api_key: Object.freeze(["fish-audio"]),
  fish_audio_voice_id: Object.freeze(["fish-audio"]),
  fish_audio_model: Object.freeze(["fish-audio"]),
  fish_audio_speed: Object.freeze(["fish-audio"]),
  fish_audio_latency: Object.freeze(["fish-audio"]),
  elevenlabs_api_key: Object.freeze(["elevenlabs"]),
  elevenlabs_voice_id: Object.freeze(["elevenlabs"]),
  elevenlabs_model: Object.freeze(["elevenlabs"]),
  openai_compatible_tts_api_key: Object.freeze(["openai-compatible"]),
  openai_compatible_tts_base_url: Object.freeze(["openai-compatible"]),
  openai_compatible_tts_model: Object.freeze(["openai-compatible"]),
  openai_compatible_tts_voice: Object.freeze(["openai-compatible"]),
  tts_provider: Object.freeze(["fish-audio", "elevenlabs", "openai-compatible"]),
  tts_sample_rate: Object.freeze(["fish-audio", "elevenlabs", "openai-compatible"]),
  attendee_api_key: Object.freeze(["attendee"]),
  attendee_base_url: Object.freeze(["attendee"]),
  bot_host: Object.freeze(["attendee"]),
  attendee_self_hosted_url: Object.freeze(["attendee"]),
  attendee_self_hosted_api_key: Object.freeze(["attendee"]),
  discord_bot_token: Object.freeze(["discord"]),
  discord_guild_allowlist: Object.freeze(["discord"]),
  discord_lcm_ingest_enabled: Object.freeze(["discord"]),
  llm_provider: Object.freeze(["llm"]),
  llm_model: Object.freeze(["llm"]),
  openai_base_url: Object.freeze(["llm"]),
  openai_empty_response_retry: Object.freeze(["llm"]),
  openai_trusted_agent_tools: Object.freeze(["llm"]),
  openai_session_header: Object.freeze(["llm"]),
  server_ngrok_domain: Object.freeze(["tunnel"]),
  public_origin: Object.freeze(["tunnel"]),
});

const DEFAULT_FIELDS = Object.freeze({
  soniox: "soniox_api_key",
  deepgram: "deepgram_api_key",
  "fish-audio": "fish_audio_api_key",
  elevenlabs: "elevenlabs_api_key",
  "openai-compatible": "openai_compatible_tts_base_url",
  attendee: "attendee_api_key",
  discord: "discord_bot_token",
  llm: "llm_provider",
  tunnel: "server_ngrok_domain",
  settings: "agent_id",
});

const MESSAGES = Object.freeze({
  AUTH_FAILED: "認証情報を確認してください",
  ALLOWLIST_MISMATCH: "許可済みの Discord サーバーに Bot が参加していません",
  NOT_CONFIGURED: "必要な接続設定が未入力です",
  PAYMENT_REQUIRED: "プロバイダーの支払い状態を確認してください",
  NOT_ENABLED: "OpenClaw 側で gateway.http.endpoints.chatCompletions.enabled を有効にしてください",
  MISMATCH: "公開URLは別の meetmate インスタンスを指しています",
  RESTART_REQUIRED: "保存済み・meetmate の再起動が必要です",
  TIMEOUT: "接続確認がタイムアウトしました",
  UNREACHABLE: "接続先へ到達できませんでした",
  RATE_LIMITED: "プロバイダー側のレート制限に達しました",
  PROVIDER_ERROR: "プロバイダーの応答を確認できませんでした",
});

const LEGACY_NOTICES = Object.freeze({
  agents: Object.freeze({
    code: "AGENTS_KEY_UNSUPPORTED",
    message: "config.json の agents キーはこのバージョンでは使われません（1 サーバー = 1 エージェント）。設定は無視されます",
  }),
  "agent.messages.groupGreetingTemplate": Object.freeze({
    code: "GROUP_GREETING_TEMPLATE_UNSUPPORTED",
    message: "config.json の agent.messages.groupGreetingTemplate キーはこのバージョンでは使われません。設定は無視されます",
  }),
});

function legacyNotices() {
  try {
    const parsed = getRawConfig();
    // Loading the profile module before bootstrap would eagerly initialize config.
    const { collectLegacyMultiAgentKeys } = require("../agent-profile");
    return collectLegacyMultiAgentKeys(parsed).map((key) => ({ ...LEGACY_NOTICES[key] }));
  } catch {
    // Raw configuration may be unavailable before runtime initialization.
    return [];
  }
}

// `targetId` (#260) is internal to the controller and never leaves it.
function cloneRecord(record) {
  if (!record) return null;
  const { targetId: _targetId, ...rest } = record;
  return rest;
}

function systemsForFields(fieldIds) {
  const systems = new Set();
  for (const fieldId of fieldIds || []) {
    for (const system of FIELD_SYSTEMS[fieldId] || []) systems.add(system);
  }
  return systems;
}

function fieldFor(system, code, message = "") {
  if (system === "tunnel" && ["NOT_CONFIGURED", "MISMATCH"].includes(code)) {
    return String(getPublishedValue("public_origin") || "").trim() ? "public_origin" : "server_ngrok_domain";
  }
  if (system === "discord" && code === "ALLOWLIST_MISMATCH") return "discord_guild_allowlist";
  // #260: the selected slot's key, or its URL when the endpoint is the likely cause.
  if (system === "attendee" && getPublishedValue("bot_host") === "attendee-self-hosted") {
    const missingUrl = code === "NOT_CONFIGURED" && !String(getPublishedValue("attendee_self_hosted_url") || "").trim();
    return missingUrl || ["UNREACHABLE", "TIMEOUT"].includes(code) ? "attendee_self_hosted_url" : "attendee_self_hosted_api_key";
  }
  if (system === "openai-compatible") {
    return ["AUTH_FAILED", "PAYMENT_REQUIRED"].includes(code)
      ? "openai_compatible_tts_api_key"
      : "openai_compatible_tts_base_url";
  }
  if (system === "llm") {
    if (code === "NOT_ENABLED") return "panel-connections";
    if (/model/i.test(message)) return "llm_model";
    if (getPublishedValue("llm_provider") === "openai-compatible" && ["AUTH_FAILED", "PROVIDER_ERROR"].includes(code)) {
      return "openai_base_url";
    }
    return "panel-connections";
  }
  return DEFAULT_FIELDS[system] || "panel-connections";
}

function messageFor(system, code, message) {
  let value = message || MESSAGES[code] || code;
  if (BILLING_SYSTEMS.has(system) && HARD_CODES.has(code)) {
    value += "。メイン画面の再チェックでは確認できません。設定画面で保存または接続テストを実行してください";
  }
  return value;
}

function runtimeStatus(error) {
  for (const value of [error?.statusCode, error?.status, error?.error_code, error?.code]) {
    const normalized = String(value ?? "").trim();
    if (/^40[1234]$|^429$/.test(normalized)) return Number(normalized);
  }
  return 0;
}

function classifyRuntimeFailure(error, options = {}) {
  const status = runtimeStatus(error);
  if (status === 401) return "AUTH_FAILED";
  if (status === 402) return "PAYMENT_REQUIRED";
  if (status === 404) return options.notEnabled404 === true ? "NOT_ENABLED" : "PROVIDER_ERROR";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

function createReadinessController(options = {}) {
  const records = new Map();
  const generations = new Map();
  const inflight = new Map();
  const backoffUntil = new Map();
  let dependencies = { ...(options.probeOptions || {}) };
  let probeFn = options.probeFn || probes.probeSystem;
  let now = options.now || Date.now;
  let bootstrapStarted = false;
  const invalidateCallback = (fieldIds) => invalidateFields(fieldIds);

  function generation(system) {
    return generations.get(system) || 0;
  }

  function bump(system) {
    const next = generation(system) + 1;
    generations.set(system, next);
    return next;
  }

  function gateSystems() {
    const stt = String(getPublishedValue("stt_provider") || "soniox").toLowerCase();
    const selectedTts = String(getPublishedValue("tts_provider") || "fish-audio").toLowerCase();
    const tts = ["fish-audio", "elevenlabs", "openai-compatible"].includes(selectedTts)
      ? selectedTts
      : "fish-audio";
    // Discord is intentionally excluded from the main readiness gate by issue #132.
    // /info.ready remains context-free here per issue #129 residual 2.
    return [stt === "deepgram" ? "deepgram" : "soniox", tts, "attendee", "llm", "tunnel"];
  }

  function configure(next = {}) {
    if (next.probeOptions) dependencies = { ...dependencies, ...next.probeOptions };
    if (typeof next.probeFn === "function") probeFn = next.probeFn;
    if (typeof next.now === "function") now = next.now;
    attachInvalidator();
  }

  function attachInvalidator() {
    registerCacheInvalidator(invalidateCallback);
  }

  function invalidateSystem(system) {
    bump(system);
    records.delete(system);
    backoffUntil.delete(system);
  }

  function invalidateFields(fieldIds) {
    for (const system of systemsForFields(fieldIds)) invalidateSystem(system);
  }

  function clearRuntime(system) {
    if (records.get(system)?.source !== "runtime") return;
    invalidateSystem(system);
  }

  function writeRuntime(system, ok, code) {
    const nextGeneration = bump(system);
    const record = { ok, code, source: "runtime", observedAt: now(), generation: nextGeneration };
    records.set(system, record);
    if (ok) backoffUntil.delete(system);
    else backoffUntil.set(system, { until: now() + FAILURE_BACKOFF_MS, targetId: undefined });
    return cloneRecord(record);
  }

  function reportRuntimeFailure(system, code) {
    return writeRuntime(system, false, HARD_CODES.has(code) || SOFT_CODES.has(code) ? code : "PROVIDER_ERROR");
  }

  function reportRuntimeSuccess(system) {
    return writeRuntime(system, true, "CONNECTED");
  }

  async function probeOne(system, probeOptions = {}) {
    if (BILLING_SYSTEMS.has(system) && probeOptions.allowBilling !== true) {
      return cloneRecord(records.get(system));
    }
    if (probeOptions.clearRuntime) clearRuntime(system);
    // #260: an attendee probe belongs to one target — the given one (join revalidation), else
    // the published target at probe start. Its record, inflight entry and backoff carry that id.
    const { target: givenTarget, ...options } = probeOptions;
    const target = system === "attendee" ? givenTarget || resolveBotHostTarget({ snapshot: "published" }) : null;
    const targetId = target ? target.targetId : undefined;
    const currentGeneration = generation(system);
    const existing = inflight.get(system);
    if (existing?.generation === currentGeneration && existing.targetId === targetId) return existing.promise;
    const backoff = backoffUntil.get(system);
    if (!options.force && records.get(system)?.ok === false && backoff && backoff.targetId === targetId && now() < backoff.until) {
      return cloneRecord(records.get(system));
    }
    const startGeneration = generation(system);
    let entry;
    const promise = (async () => {
      let outcome;
      try {
        outcome = await probeFn(system, { ...dependencies, ...options, ...(target ? { target } : {}) });
      } catch {
        outcome = { ok: false, code: "PROVIDER_ERROR" };
      } finally {
        if (!outcome || typeof outcome.code !== "string") outcome = { ok: false, code: "PROVIDER_ERROR" };
        const current = records.get(system);
        // A probe that a newer probe (another target) replaced in `inflight` writes nothing.
        if (
          generation(system) === startGeneration
          && inflight.get(system) === entry
          && !(current?.source === "runtime" && current.ok === false && !options.clearRuntime)
        ) {
          const record = {
            ok: outcome.ok === true,
            code: outcome.ok === true ? "CONNECTED" : outcome.code,
            source: "probe",
            observedAt: now(),
            generation: startGeneration,
            ...(outcome.message ? { message: String(outcome.message) } : {}),
            ...(targetId !== undefined ? { targetId } : {}),
          };
          records.set(system, record);
          if (record.ok) backoffUntil.delete(system);
          else backoffUntil.set(system, { until: now() + FAILURE_BACKOFF_MS, targetId });
        }
        if (inflight.get(system) === entry) inflight.delete(system);
      }
      return cloneRecord(records.get(system));
    })();
    entry = { generation: startGeneration, targetId, promise };
    inflight.set(system, entry);
    return promise;
  }

  function statusFor(options) {
    return options && Object.prototype.hasOwnProperty.call(options, "transport")
      ? getStatus({ transport: options.transport })
      : getStatus();
  }

  function staticIssuesBySystem(options) {
    const grouped = new Map();
    const active = new Set(gateSystems());
    for (const issue of statusFor(options).issues || []) {
      const mapped = FIELD_SYSTEMS[issue.fieldId] || [];
      for (const system of mapped) {
        if (!active.has(system)) continue;
        const list = grouped.get(system) || [];
        list.push(issue);
        grouped.set(system, list);
      }
    }
    return grouped;
  }

  async function probeSystems(systems, probeOptions = {}) {
    const unique = [...new Set(systems || [])];
    return Promise.all(unique.map((system) => probeOne(system, probeOptions)));
  }

  async function probeGateSystems(probeOptions = {}) {
    return probeSystems(gateSystems(), probeOptions);
  }

  async function bootstrap() {
    if (bootstrapStarted) return;
    bootstrapStarted = true;
    const staticBySystem = staticIssuesBySystem();
    const systems = gateSystems().filter((system) => !staticBySystem.has(system));
    await probeSystems(systems, { trigger: "bootstrap", allowBilling: true });
  }

  function isStale(record) {
    if (!record) return false;
    const ttl = record.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    return now() - record.observedAt >= ttl;
  }

  function restartBlockers() {
    const changed = new Set(buildEnvelope().restartRequired || []);
    const blockers = [];
    for (const system of gateSystems()) {
      const fieldId = Object.keys(FIELD_SYSTEMS).find((id) => changed.has(id) && FIELD_SYSTEMS[id].includes(system));
      if (fieldId) blockers.push({ system, code: "RESTART_REQUIRED", fieldId, message: MESSAGES.RESTART_REQUIRED, diagnosticId: diagnosticIdFor(system, "RESTART_REQUIRED") });
    }
    return blockers;
  }

  // #260: with an expected target id (a join), an attendee record of another target counts as
  // absent. A record without an id (seeded by setProbeObservation) matches any expected id.
  function foreignRecord(system, record, expectedId) {
    return system === "attendee" && expectedId !== undefined
      && record?.targetId !== undefined && record.targetId !== expectedId;
  }

  function getReadiness(options) {
    const active = gateSystems();
    const restarts = restartBlockers();
    const restartBySystem = new Map(restarts.map((blocker) => [blocker.system, blocker]));
    const staticBySystem = staticIssuesBySystem(options);
    const expectedId = options?.target?.targetId;
    const recordFor = (system) => {
      const record = records.get(system);
      return foreignRecord(system, record, expectedId) ? undefined : record;
    };
    const blockers = [];
    const systems = active.map((system) => {
      const restart = restartBySystem.get(system);
      const record = recordFor(system);
      const code = restart?.code || record?.code || "PENDING";
      const fieldId = restart?.fieldId || fieldFor(system, code, record?.message);
      return {
        id: system,
        ok: restart ? false : record?.ok === true,
        code,
        stale: isStale(record),
        fieldId,
        diagnosticId: diagnosticIdFor(system, code),
      };
    });

    for (const [system, issues] of staticBySystem) {
      for (const issue of issues) {
        blockers.push({
          system,
          code: issue.code,
          fieldId: issue.fieldId,
          message: "ミーティング開始に必要な設定を確認してください",
          diagnosticId: diagnosticIdFor(system, issue.code),
        });
      }
    }
    for (const restart of restarts) blockers.push(restart);
    for (const system of active) {
      if (staticBySystem.has(system) || restartBySystem.has(system)) continue;
      const record = recordFor(system);
      if (!record || !HARD_CODES.has(record.code)) continue;
      blockers.push({
        system,
        code: record.code,
        fieldId: fieldFor(system, record.code, record.message),
        message: messageFor(system, record.code, record.message),
        diagnosticId: diagnosticIdFor(system, record.code),
      });
    }
    const settled = systems.every((system) => system.code !== "PENDING");
    const meetingReady = statusFor(options).meetingReady;
    return {
      ready: settled && blockers.length === 0 && meetingReady,
      setupRequired: !meetingReady,
      systems,
      blockers,
      notices: legacyNotices(),
    };
  }

  async function recheckPublic() {
    const systems = gateSystems().filter((system) => !BILLING_SYSTEMS.has(system));
    await probeSystems(systems, { trigger: "public-recheck", allowBilling: false });
    return getReadiness();
  }

  // `options.target` (#260) is the join's target: it is probed as given, never re-resolved,
  // and an attendee record of another target counts as stale.
  async function revalidateForJoin(options = {}) {
    const expectedId = options.target?.targetId;
    const systems = gateSystems().filter((system) => {
      if (BILLING_SYSTEMS.has(system)) return false;
      const record = records.get(system);
      return Boolean(record && (!record.ok || isStale(record) || foreignRecord(system, record, expectedId)));
    });
    if (!systems.length) return getReadiness(options);
    const budgetMs = options.budgetMs ?? JOIN_REVALIDATION_BUDGET_MS;
    let timer;
    await Promise.race([
      probeSystems(systems, { trigger: "join", allowBilling: false, ...(options.target ? { target: options.target } : {}) }),
      new Promise((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return getReadiness(options);
  }

  function setProbeObservation(system, outcome) {
    const currentGeneration = generation(system);
    const record = {
      ok: outcome?.ok === true,
      code: outcome?.ok === true ? "CONNECTED" : String(outcome?.code || "PROVIDER_ERROR"),
      source: "probe",
      observedAt: now(),
      generation: currentGeneration,
      ...(outcome?.message ? { message: String(outcome.message) } : {}),
    };
    const current = records.get(system);
    if (!(current?.source === "runtime" && current.ok === false)) records.set(system, record);
    return cloneRecord(records.get(system));
  }

  function reset() {
    records.clear();
    generations.clear();
    inflight.clear();
    backoffUntil.clear();
    dependencies = { ...(options.probeOptions || {}) };
    probeFn = options.probeFn || probes.probeSystem;
    now = options.now || Date.now;
    bootstrapStarted = false;
  }

  function inspect(system) {
    return cloneRecord(records.get(system));
  }

  return {
    attachInvalidator,
    bootstrap,
    classifyRuntimeFailure,
    configure,
    fieldFor,
    gateSystems,
    getReadiness,
    inspect,
    invalidateFields,
    probeGateSystems,
    probeSystem: probeOne,
    probeSystems,
    recheckPublic,
    reportRuntimeFailure,
    reportRuntimeSuccess,
    reset,
    revalidateForJoin,
    setProbeObservation,
  };
}

function createPublicRateLimiter(options = {}) {
  const now = options.now || Date.now;
  const windowMs = options.windowMs ?? 60_000;
  const perAddressLimit = options.perAddressLimit ?? 3;
  const globalLimit = options.globalLimit ?? 30;
  let windowStart = now();
  let globalCount = 0;
  const counts = new Map();
  return function take(address) {
    const current = now();
    if (current - windowStart >= windowMs) {
      windowStart = current;
      globalCount = 0;
      counts.clear();
    }
    const key = String(address || "unknown");
    const count = counts.get(key) || 0;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - current) / 1000));
    if (count >= perAddressLimit || globalCount >= globalLimit) return { allowed: false, retryAfterSeconds };
    counts.set(key, count + 1);
    globalCount += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const readiness = createReadinessController();

module.exports = {
  ...readiness,
  BILLING_SYSTEMS,
  FIELD_SYSTEMS,
  HARD_CODES,
  SOFT_CODES,
  createPublicRateLimiter,
  createReadinessController,
  runtimeStatus,
  systemsForFields,
  _test: {
    FAILURE_BACKOFF_MS,
    FAILURE_TTL_MS,
    JOIN_REVALIDATION_BUDGET_MS,
    SUCCESS_TTL_MS,
    fieldFor,
    messageFor,
    runtimeStatus,
  },
};
