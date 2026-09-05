"use strict";

const path = require("node:path");
const { z } = require("zod");

const characterLength = (value) => [...value].length;
const trimmedString = (max) => z.string().trim().min(1).max(max);
const text = (max) => z.string().refine((value) => characterLength(value) <= max, "too_big");
const secret = z.string().trim().min(1).max(4096);
const bool = z.boolean();
const integer = (min, max) => z.number().int().min(min).max(max);
const number = (min, max) => z.number().finite().min(min).max(max);
const nullable = (schema) => schema.nullable();
const stringArray = z.array(z.string().trim().min(1).refine((value) => characterLength(value) <= 128, "too_big"))
  .max(64)
  .refine((values) => new Set(values).size === values.length, "duplicate");
const snowflakeArray = z.array(z.string().trim().regex(/^[0-9]{17,20}$/))
  .max(64)
  .refine((values) => new Set(values).size === values.length, "duplicate");
// Keep identity, framing, hop-by-hop, and Meetmate trust headers operator-controlled.
const RESERVED_SESSION_HEADER_NAMES = Object.freeze([
  "authorization",
  "proxy-authorization",
  "content-length",
  "content-type",
  "host",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "keep-alive",
  "x-caty-agent-trust",
]);
const sessionHeader = z.string()
  .regex(/^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,128})?$/)
  .refine((value) => !RESERVED_SESSION_HEADER_NAMES.includes(value.toLowerCase()), "reserved_header");
const HTTPS_ORIGIN_SHAPE = /^https:\/\/(?:\[[0-9A-Fa-f:.]+\]|[^\s/?#@:\[\]]+)(?::[1-9][0-9]{0,4})?$/;

function exactUrl(protocols, allowEmpty = false) {
  return z.string().refine((value) => {
    if (allowEmpty && value === "") return true;
    if (value !== value.trim()) return false;
    try {
      const parsed = new URL(value);
      return protocols.includes(parsed.protocol)
        && !parsed.username
        && !parsed.password
        && !parsed.hash;
    } catch {
      return false;
    }
  }, "invalid_url");
}

function httpsOrigin(allowEmpty = false) {
  return z.string().refine((value) => {
    if (allowEmpty && value === "") return true;
    if (!HTTPS_ORIGIN_SHAPE.test(value)) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password
        && !parsed.search && !parsed.hash && parsed.pathname === "/";
    } catch {
      return false;
    }
  }, "invalid_https_origin");
}

function hostname(allowEmpty = false) {
  return z.string().refine((value) => {
    if (allowEmpty && value === "") return true;
    if (value !== value.trim() || value.length > 253 || value.includes(":")) return false;
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(value);
  }, "invalid_hostname");
}

const absolutePath = z.string().refine((value) => value !== "" && path.isAbsolute(value) && !/^https?:/i.test(value), "invalid_absolute_path");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const clipText = z.string().trim().min(1).refine((value) => characterLength(value) <= 4096, "too_big");
const clipRecord = z.object({
  id: z.string().uuid(),
  role: z.enum(["ack", "progress", "greeting", "farewell", "timeout"]),
  text: clipText,
  sourceRelativePath: trimmedString(1024),
  pcmRelativePath: trimmedString(1024),
  sourceSha256: hash,
  pcmSha256: hash,
  cacheKey: hash,
  referenceId: trimmedString(256).nullable(),
  model: trimmedString(128),
  sampleRate: integer(8000, 96000),
  speed: number(0.5, 2),
  durationMs: integer(0, Number.MAX_SAFE_INTEGER),
  sourceBytes: integer(0, Number.MAX_SAFE_INTEGER),
  pcmBytes: integer(0, Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime({ offset: false }),
}).strict();

function definition(id, configPath, schema, options = {}) {
  return Object.freeze({
    id,
    path: configPath,
    schema,
    ux: options.ux || "detail",
    credential: options.credential || "none",
    apply: options.apply || "restart-required",
    envAlias: options.envAlias || null,
    ...(Object.prototype.hasOwnProperty.call(options, "defaultValue") ? { defaultValue: options.defaultValue } : {}),
    requiredWhen: options.requiredWhen ? Object.freeze({
      ...options.requiredWhen,
      ...(options.requiredWhen.transport
        ? { transport: Object.freeze([...options.requiredWhen.transport]) }
        : {}),
    }) : null,
    writeSurface: options.writeSurface || (options.ux === "deployment-readonly" ? "none" : "settings"),
    transferable: options.transferable !== false,
    multiline: options.multiline === true,
    visibleWhen: options.visibleWhen ? Object.freeze({ ...options.visibleWhen }) : null,
  });
}

const d = definition;
const SETTINGS_REGISTRY = Object.freeze([
  d("agent_id", "agent.id", trimmedString(128), { ux: "basic", envAlias: "AGENT_ID", requiredWhen: { always: true } }),
  d("agent_name", "agent.name", trimmedString(128), { ux: "basic" }),
  d("agent_display_name", "agent.displayName", trimmedString(128), { ux: "basic", requiredWhen: { always: true } }),
  d("agent_language", "agent.language", z.enum(["ja", "en"]), { ux: "basic", envAlias: "AGENT_LANG", defaultValue: "ja" }),
  d("agent_greeting", "agent.greeting", text(4096), { ux: "basic", apply: "live", multiline: true }),
  d("agent_emotion_tags", "agent.emotionTags", bool, { ux: "basic", apply: "live", defaultValue: true }),
  d("agent_wake_words", "agent.wakeWords", stringArray, { ux: "basic", envAlias: "WAKE_WORDS", requiredWhen: { always: true } }),
  d("agent_keyterms", "agent.keyterms", stringArray, { envAlias: "SONIOX_CONTEXT_TERMS" }),
  d("agent_stt_wake_variants", "agent.sttWakeVariants", stringArray),
  d("agent_ack_variants", "agent.ackVariants", stringArray, { apply: "live", multiline: true }),
  d("agent_progress_pings", "agent.progressPings", stringArray, { apply: "live", multiline: true }),
  d("agent_exit_farewell", "agent.exitFarewell", text(4096), { apply: "live", multiline: true }),
  d("agent_cancel_ack", "agent.cancelAck", text(4096), { apply: "live", multiline: true }),
  d("agent_timeout_fallback", "agent.timeoutFallback", text(4096), { apply: "live", multiline: true }),
  d("agent_avatar_url", "agent.avatarUrl", exactUrl(["http:", "https:"], true), { envAlias: "BOT_IMAGE_URL" }),
  d("avatar_experiment", "avatar.experiment", z.enum(["", "hybrid-local-l0", "hybrid-local-frames"]), { ux: "basic", apply: "live", defaultValue: "" }),
  d("avatar_rig_background_mode", "avatar.rigBackgroundMode", z.enum(["solid", "image", "chroma"]), { ux: "basic", apply: "live", defaultValue: "solid" }),
  d("avatar_rig_background_color", "avatar.rigBackgroundColor", z.string().regex(/^#[0-9a-f]{6}$/i), { ux: "basic", apply: "live", defaultValue: "#08111f" }),
  d("llm_provider", "llm.provider", z.enum(["openclaw", "openai-compatible"]), { ux: "basic", envAlias: "LLM_PROVIDER", defaultValue: "openclaw" }),
  d("llm_model", "llm.model", trimmedString(256), { ux: "basic" }),
  d("llm_temperature", "llm.temperature", number(0, 2), { envAlias: "AGENT_TEMPERATURE", defaultValue: 0.5 }),
  d("llm_max_tokens", "llm.maxTokens", integer(1, 32768), { envAlias: "AGENT_MAX_TOKENS", defaultValue: 300 }),
  d("llm_history_max_turns", "llm.historyMaxTurns", integer(0, 256), { defaultValue: 12 }),
  d("llm_system_prompt", "llm.systemPrompt", text(16384), { defaultValue: "", multiline: true }),
  d("openai_base_url", "llm.openaiCompatible.baseUrl", exactUrl(["http:", "https:"], true), { envAlias: "OPENAI_COMPATIBLE_BASE_URL", visibleWhen: { id: "llm_provider", value: "openai-compatible" } }),
  d("openai_empty_response_retry", "llm.openaiCompatible.emptyResponseRetry", bool, { defaultValue: true, visibleWhen: { id: "llm_provider", value: "openai-compatible" } }),
  d("openai_trusted_agent_tools", "llm.openaiCompatible.trustedAgentTools", bool, { defaultValue: false, visibleWhen: { id: "llm_provider", value: "openai-compatible" } }),
  d("openai_session_header", "llm.openaiCompatible.sessionHeader", sessionHeader, { defaultValue: "", visibleWhen: { id: "llm_provider", value: "openai-compatible" } }),
  d("soniox_api_key", "stt.sonioxApiKey", secret, { ux: "basic", credential: "class-1", envAlias: "SONIOX_API_KEY", requiredWhen: { setting: "stt_provider", equals: "soniox" }, visibleWhen: { id: "stt_provider", value: "soniox" } }),
  d("deepgram_api_key", "stt.apiKey", secret, { ux: "basic", credential: "class-1", envAlias: "DEEPGRAM_API_KEY", requiredWhen: { setting: "stt_provider", equals: "deepgram" }, visibleWhen: { id: "stt_provider", value: "deepgram" } }),
  d("stt_provider", "stt.provider", z.enum(["soniox", "deepgram"]), { ux: "basic", envAlias: "STT_PROVIDER", defaultValue: "soniox" }),
  d("soniox_model", "stt.soniox.model", trimmedString(128), { envAlias: "SONIOX_MODEL", defaultValue: "stt-rt-v5", visibleWhen: { id: "stt_provider", value: "soniox" } }),
  d("soniox_ws_url", "stt.soniox.wsUrl", exactUrl(["wss:"]), { envAlias: "SONIOX_WS_URL", visibleWhen: { id: "stt_provider", value: "soniox" } }),
  d("soniox_endpoint_sensitivity", "stt.soniox.endpointSensitivity", nullable(number(-1, 1)), { envAlias: "SONIOX_ENDPOINT_SENSITIVITY", visibleWhen: { id: "stt_provider", value: "soniox" } }),
  d("soniox_max_endpoint_delay_ms", "stt.soniox.maxEndpointDelayMs", nullable(integer(0, 30000)), { envAlias: "SONIOX_MAX_ENDPOINT_DELAY_MS", visibleWhen: { id: "stt_provider", value: "soniox" } }),
  d("soniox_endpoint_latency_level", "stt.soniox.endpointLatencyLevel", nullable(integer(0, 5)), { envAlias: "SONIOX_ENDPOINT_LATENCY_LEVEL", visibleWhen: { id: "stt_provider", value: "soniox" } }),
  d("listen_endpointing_ms", "stt.endpointingMs", integer(0, 30000), { envAlias: "LISTEN_ENDPOINTING_MS", defaultValue: 400 }),
  d("listen_utterance_end_ms", "stt.utteranceEndMs", integer(0, 30000), { envAlias: "LISTEN_UTTERANCE_END_MS", defaultValue: 1200 }),
  d("fish_audio_api_key", "tts.apiKey", secret, { ux: "basic", credential: "class-1", envAlias: "FISH_AUDIO_API_KEY", requiredWhen: { setting: "tts_provider", equals: "fish-audio" }, visibleWhen: { id: "tts_provider", value: "fish-audio" } }),
  d("fish_audio_voice_id", "tts.voiceId", trimmedString(256), { ux: "basic", envAlias: "FISH_AUDIO_VOICE_ID", requiredWhen: { setting: "tts_provider", equals: "fish-audio" }, visibleWhen: { id: "tts_provider", value: "fish-audio" } }),
  d("tts_provider", "tts.provider", z.enum(["fish-audio", "elevenlabs", "openai-compatible"]), { ux: "basic", envAlias: "TTS_PROVIDER", defaultValue: "fish-audio" }),
  d("fish_audio_model", "tts.model", trimmedString(128), { envAlias: "FISH_AUDIO_MODEL", defaultValue: "s2-pro", visibleWhen: { id: "tts_provider", value: "fish-audio" } }),
  d("fish_audio_speed", "tts.speed", number(0.5, 2), { envAlias: "FISH_AUDIO_SPEED", defaultValue: 1, visibleWhen: { id: "tts_provider", value: "fish-audio" } }),
  d("fish_audio_latency", "tts.latency", z.enum(["normal", "balanced", "low"]), { envAlias: "FISH_AUDIO_LATENCY", defaultValue: "balanced", visibleWhen: { id: "tts_provider", value: "fish-audio" } }),
  d("elevenlabs_api_key", "tts.elevenlabs.apiKey", secret, { ux: "basic", credential: "class-1", envAlias: "ELEVENLABS_API_KEY", requiredWhen: { setting: "tts_provider", equals: "elevenlabs" }, visibleWhen: { id: "tts_provider", value: "elevenlabs" } }),
  d("elevenlabs_voice_id", "tts.elevenlabs.voiceId", trimmedString(256), { ux: "basic", envAlias: "ELEVENLABS_VOICE_ID", requiredWhen: { setting: "tts_provider", equals: "elevenlabs" }, visibleWhen: { id: "tts_provider", value: "elevenlabs" } }),
  d("elevenlabs_model", "tts.elevenlabs.model", trimmedString(128), { envAlias: "ELEVENLABS_MODEL", defaultValue: "eleven_multilingual_v2", visibleWhen: { id: "tts_provider", value: "elevenlabs" } }),
  d("openai_compatible_tts_api_key", "tts.openaiCompatibleTts.apiKey", secret, { ux: "basic", credential: "class-1", envAlias: "OPENAI_COMPATIBLE_TTS_API_KEY", requiredWhen: { setting: "tts_provider", equals: "openai-compatible" }, visibleWhen: { id: "tts_provider", value: "openai-compatible" } }),
  d("openai_compatible_tts_base_url", "tts.openaiCompatibleTts.baseUrl", exactUrl(["http:", "https:"]), { ux: "basic", envAlias: "OPENAI_COMPATIBLE_TTS_BASE_URL", defaultValue: "https://api.openai.com", visibleWhen: { id: "tts_provider", value: "openai-compatible" } }),
  d("openai_compatible_tts_model", "tts.openaiCompatibleTts.model", trimmedString(128), { envAlias: "OPENAI_COMPATIBLE_TTS_MODEL", defaultValue: "gpt-4o-mini-tts", visibleWhen: { id: "tts_provider", value: "openai-compatible" } }),
  d("openai_compatible_tts_voice", "tts.openaiCompatibleTts.voice", trimmedString(128), { envAlias: "OPENAI_COMPATIBLE_TTS_VOICE", defaultValue: "alloy", visibleWhen: { id: "tts_provider", value: "openai-compatible" } }),
  d("tts_sample_rate", "tts.sampleRate", integer(8000, 96000), { envAlias: "TTS_SAMPLE_RATE", defaultValue: 24000 }),
  d("tts_cache_enabled", "tts.cache.enabled", bool, { envAlias: "TTS_CACHE_ENABLED", defaultValue: true }),
  d("tts_cache_prewarm", "tts.cache.prewarm", bool, { envAlias: "TTS_CACHE_PREWARM", defaultValue: true }),
  d("attendee_api_key", "attendee.apiKey", secret, { ux: "basic", credential: "class-1", envAlias: "ATTENDEE_API_KEY", requiredWhen: { transport: ["meet", "zoom"] } }),
  d("attendee_base_url", "attendee.baseUrl", hostname(), { envAlias: "ATTENDEE_API_BASE_URL", defaultValue: "app.attendee.dev" }),
  d("slack_bot_token", "slack.botToken", secret, { ux: "basic", credential: "class-1", envAlias: "SLACK_BOT_TOKEN", requiredWhen: { setting: "slack_notifications_enabled", equals: true, explicit: true } }),
  d("slack_notifications_enabled", "slack.notifications.enabled", bool, { ux: "basic", envAlias: "SLACK_NOTIFY_ENABLED", defaultValue: true }),
  d("slack_notifications_target", "slack.notifications.target", z.enum(["dm", "channel"]), { ux: "basic", defaultValue: "dm" }),
  d("slack_dm_user_id", "slack.notifications.dmUserId", trimmedString(128)),
  d("slack_notify_channel", "slack.notifyChannel", trimmedString(128), { envAlias: "SLACK_NOTIFY_CHANNEL" }),
  d("slack_summary_channel", "slack.summaryChannel", trimmedString(128), { envAlias: "SLACK_SUMMARY_CHANNEL" }),
  d("slack_status_channel", "slack.statusChannel", trimmedString(128), { envAlias: "SLACK_STATUS_CHANNEL" }),
  d("discord_bot_token", "discord.botToken", secret, { ux: "basic", credential: "class-1", envAlias: "DISCORD_BOT_TOKEN", requiredWhen: { transport: ["discord"] } }),
  d("discord_guild_allowlist", "discord.guildAllowlist", snowflakeArray, { ux: "basic", defaultValue: [] }),
  d("discord_lcm_ingest_enabled", "discord.lcmIngestEnabled", bool, { ux: "basic", defaultValue: false }),
  d("hub_cloud_url", "hub.cloudUrl", exactUrl(["https:"]), { ux: "basic", envAlias: "CATY_CLOUD_URL" }),
  d("hub_token", "hub.token", secret, { ux: "hidden", credential: "class-1", envAlias: "HUB_TOKEN" }),
  d("hub_installation_id", "hub.installationId", trimmedString(256), { ux: "hidden", transferable: false }),
  d("hub_cloud_hub_url", "hub.cloudHubUrl", exactUrl(["ws:", "wss:"]), { ux: "hidden", transferable: false }),
  d("hub_url", "hub.url", exactUrl(["ws:", "wss:"]), { ux: "hidden", envAlias: "HUB_URL", transferable: false }),
  d("hub_room_salt", "hub.roomSalt", secret, { ux: "hidden", credential: "class-1" }),
  d("hub_room_salt_version", "hub.roomSaltVersion", trimmedString(128), { ux: "hidden", transferable: false }),
  d("hub_plan_id", "hub.planId", trimmedString(128), { ux: "hidden", transferable: false }),
  d("hub_expires_at", "hub.expiresAt", z.string().datetime({ offset: true }), { ux: "hidden", transferable: false }),
  d("hub_config_refreshed_at", "hub.configRefreshedAt", z.string().datetime({ offset: true }), { ux: "hidden", transferable: false }),
  d("summary_enabled", "summary.enabled", bool, { ux: "basic", envAlias: "SUMMARY_ENABLED", defaultValue: true }),
  d("gateway_warmup_timeout_ms", "gateway.warmupTimeoutMs", integer(0, 120000), { envAlias: "GATEWAY_WARMUP_TIMEOUT_MS", defaultValue: 8000 }),
  d("gateway_display_name", "gateway.displayName", trimmedString(128), { defaultValue: "AI MeetServer" }),
  d("server_port", "server.port", integer(1, 65535), { ux: "deployment-readonly", envAlias: "PORT", defaultValue: 5005, writeSurface: "none" }),
  d("server_ngrok_domain", "server.ngrokDomain", hostname(true), { defaultValue: "" }),
  d("public_origin", "server.publicOrigin", httpsOrigin(true), { envAlias: "PUBLIC_ORIGIN", defaultValue: "" }),
  d("resolved_home", null, absolutePath, { ux: "deployment-readonly", envAlias: "AI_MEET_HOME", writeSurface: "none" }),
  d("task_extraction_enabled", "features.taskExtractionEnabled", bool, { defaultValue: true }),
  d("streaming_equivalent_enabled", "features.streamingEquivalentEnabled", bool, { defaultValue: true }),
  d("audio_clips", "audio.clips", z.array(clipRecord).max(32), { apply: "live", defaultValue: [], writeSurface: "audio-only" }),
]);

const REGISTRY_BY_ID = Object.freeze(Object.fromEntries(SETTINGS_REGISTRY.map((entry) => [entry.id, entry])));
const MASK = "••••••••";

// These are read-only launch diagnostics, not settings-registry entries.
const ENV_DIAGNOSTICS = Object.freeze([
  ["mcp_base_url", "AI_MEET_BASE_URL", "url", "http://localhost:5005"],
  ["mcp_join_timeout_ms", "AI_MEET_JOIN_TIMEOUT_MS", "number", 60000],
  ["attendee_retry_attempts", "ATTENDEE_RETRY_ATTEMPTS", "number", 3],
  ["attendee_retry_base_ms", "ATTENDEE_RETRY_BASE_MS", "number", 800],
  ["attendee_timeout_ms", "ATTENDEE_TIMEOUT_MS", "number", 15000],
  ["barge_in_confidence_min", "BARGE_IN_CONFIDENCE_MIN", "number", 0.45],
  ["barge_in_min_chars", "BARGE_IN_MIN_CHARS", "number", 2],
  ["body_limit_bytes", "BODY_LIMIT_BYTES", "number", 1000000],
  ["clause_pause_ms", "CLAUSE_PAUSE_MS", "number", 300],
  ["comfort_noise_amplitude", "COMFORT_NOISE_AMPLITUDE", "number", 30],
  ["echo_gate_closed_bypass", "ECHO_GATE_CLOSED_BYPASS", "boolean", false],
  ["echo_loop_cooldown_ms", "ECHO_LOOP_COOLDOWN_MS", "number", 300],
  ["barge_in_enabled", "ENABLE_BARGE_IN", "boolean", true],
  ["immediate_ack_enabled", "ENABLE_IMMEDIATE_ACK", "boolean", true],
  ["meeting_context_injection_enabled", "ENABLE_MEETING_CONTEXT_INJECTION", "boolean", false],
  ["progress_guard_enabled", "ENABLE_PROGRESS_GUARD", "boolean", true],
  ["first_chunk_min_chars", "FIRST_CHUNK_MIN_CHARS", "number", 12],
  ["first_token_delegate_ms", "FIRST_TOKEN_DELEGATE_MS", "number", 15000],
  ["fish_audio_retry_max", "FISH_AUDIO_RETRY_MAX", "number", 2],
  ["gateway_events_agent_id", "GATEWAY_EVENTS_AGENT_ID", "string", "main"],
  ["llm_response_timeout_ms", "LLM_RESPONSE_TIMEOUT_MS", "number", 35000],
  ["local_avatar_envelope_enabled", "LOCAL_AVATAR_ENVELOPE", "boolean", true],
  ["local_avatar_envelope_slack_ms", "LOCAL_AVATAR_ENVELOPE_SLACK_MS", "number", 2000],
  ["meeting_context_raw_chars", "MEETING_CONTEXT_RAW_CHARS", "number", 1800],
  ["meeting_context_raw_utterances", "MEETING_CONTEXT_RAW_UTTERANCES", "number", 10],
  ["metrics_disabled", "METRICS_DISABLED", "boolean", false],
  ["metrics_log_dir", "METRICS_LOG_DIR", "metrics-path", null],
  ["min_clause_len", "MIN_CLAUSE_LEN", "number", 15],
  ["min_clause_prefix", "MIN_CLAUSE_PREFIX", "number", 6],
  ["openclaw_workspace", "OPENCLAW_WORKSPACE", "home-path", null],
  ["pending_queue_max", "PENDING_QUEUE_MAX", "number", 3],
  ["post_utterance_buffer_ms", "POST_UTTERANCE_BUFFER_MS", "number", 500],
  ["progress_ping_interval_ms", "PROGRESS_PING_INTERVAL_MS", "number", 10000],
  ["progress_ping_max", "PROGRESS_PING_MAX", "number", 3],
  ["public_wss_url", "PUBLIC_WSS_URL", "string", ""],
  ["sentence_pause_ms", "SENTENCE_PAUSE_MS", "number", 700],
  ["session_grace_close_ms", "SESSION_GRACE_CLOSE_MS", "number", 15000],
  ["soniox_keepalive_interval_ms", "SONIOX_KEEPALIVE_INTERVAL_MS", "number", 8000],
  ["soniox_pending_max", "SONIOX_PENDING_MAX", "number", 200],
  ["stt_accumulated_max_chars", "STT_ACCUMULATED_MAX_CHARS", "number", 120],
  ["stt_keywords_enabled", "STT_ENABLE_KEYWORDS", "boolean", true],
  ["transcript_buffer_max", "TRANSCRIPT_BUFFER_MAX", "number", 50],
  ["tts_cache_dir", "TTS_CACHE_DIR", "tts-path", null],
  ["tts_gap_ms", "TTS_GAP_MS", "number", 250],
  ["tts_lead_ms", "TTS_LEAD_MS", "number", 200],
  ["wake_calibrate_enabled", "WAKE_CALIBRATE_ENABLED", "boolean", false],
  ["gateway_events_enabled", "GATEWAY_EVENTS_ENABLED", "boolean", false],
  ["forced_delegation_abort", "FORCED_DELEGATION_ABORT", "boolean", true],
  ["handoff_delegate_session", "HANDOFF_DELEGATE_SESSION", "boolean", true],
  ["report_chat_enabled", "REPORT_CHAT_ENABLED", "boolean", true],
  ["report_voice_enabled", "REPORT_VOICE_ENABLED", "boolean", true],
  ["handoff_cooldown_ms", "HANDOFF_COOLDOWN_MS", "number", 20000],
  ["report_voice_gap_ms", "REPORT_VOICE_GAP_MS", "number", 4000],
  ["delegate_reply_fresh_ms", "DELEGATE_REPLY_FRESH_MS", "number", 90000],
  ["parent_compact_delay_ms", "PARENT_COMPACT_DELAY_MS", "number", 5000],
  ["handoff_inflight_max", "HANDOFF_INFLIGHT_MAX", "number", 2],
  ["parent_compact_max_lines", "PARENT_COMPACT_MAX_LINES", "number", 0],
  ["short_utterance_skip_chars", "SHORT_UTTERANCE_SKIP_CHARS", "number", 24],
  ["circuit_breaker_timeouts", "CIRCUIT_BREAKER_TIMEOUTS", "number", 2],
].map(([id, envAlias, type, defaultValue]) => Object.freeze({ id, envAlias, type, defaultValue })));

module.exports = {
  MASK,
  ENV_DIAGNOSTICS,
  SETTINGS_REGISTRY,
  REGISTRY_BY_ID,
  validators: Object.freeze({ absolutePath, clipRecord, hostname, httpsOrigin, secret, stringArray }),
};
