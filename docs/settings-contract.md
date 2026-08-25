# Settings, admin-plane, and migration contract (Epic #29 child #30)

Status: **frozen for implementation**. This contract augments the existing Node `http` server and vanilla-JavaScript dashboard on `localhost:5005`. It does not authorize another application, UI framework, persistence store, or port. `config.json` in the resolved home remains the only settings store. The settings UI, admin API, import/export, connection tests, and audio ingest form one allowlisted admin plane; meeting transport remains a separate data plane.

The credential classes used below are fixed:

- **Class 1 — external Meetmate vendors:** `SONIOX_API_KEY`, `DEEPGRAM_API_KEY`, `FISH_AUDIO_API_KEY`, `ATTENDEE_API_KEY`, and `SLACK_BOT_TOKEN`. These are primary UI fields, masked after entry, persisted only at their allowlisted `config.json` paths, and omitted from exports.
- **Class 2 — agent/LLM connection credentials:** `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, and `OPENAI_COMPATIBLE_API_KEY`. These are environment-only and absent from UI markup, admin DTOs, exports, imports, templates, and Zod schemas.
- **Class 3 — internal control tokens:** `WS_SHARED_TOKEN`, `JOIN_SHARED_TOKEN`, and `AI_MEET_JOIN_TOKEN`. These are environment-only and absent from UI markup, admin DTOs, exports, imports, templates, and Zod schemas.

## 1. Zod schema and settings-registry contract

The implementation has one declarative `SETTINGS_REGISTRY`. Zod schemas, GET masking, PUT/import projection, the vanilla-JavaScript form, export projection, override badges, and meeting-start validation are derived from it. A handler must not accept a path merely because it exists in `config.json`. Each entry has exactly these properties:

```ts
type SettingDefinition = {
  id: string;                       // stable snake_case API/UI identifier
  path: string;                     // canonical config.json dotted path
  schema: ZodType;                  // strict field validator
  ux: "basic" | "detail" | "deployment-readonly" | "hidden";
  credential: "class-1" | "none"; // class 2/3 entries are forbidden
  apply: "restart-required" | "live";
  envAlias: string | null;
  defaultValue?: unknown;
  requiredAtMeetingStart?: boolean;
};
```

`apply` is `restart-required` unless the table explicitly says `live`. `hidden` is reserved for registry fields that are conditionally irrelevant in the UI; it does not permit class 2 or class 3. Deployment-readonly values may be returned for diagnosis but PUT/import must reject changes to them. Credential values use `z.string().trim().min(1).max(4096)` and the masked round trip in §8. URL fields require `http:` or `https:`; arrays are unique, trimmed strings with at most 64 entries and 128 UTF-8 characters per entry; free text is at most 16 KiB; regex patterns are at most 2 KiB and flags match `^(?!.*(.).*\1)[dimsuvy]*$` before compilation. Unknown object keys are rejected by the strict DTO schema.

The allowlist below is complete. The compact type notation is directly translatable to Zod (`str(n)`, `text(n)`, `bool`, `int(min,max)`, `num(min,max)`, `url`, `enum(...)`, `str[]`). Entries marked `live` are the only exceptions to restart-required apply.

| ID | Config path | Type/default | UX | Credential | Apply | Env alias |
|---|---|---|---|---|---|---|
| `agent_id` | `agent.id` | `str(128)` | basic | none | restart-required | `AGENT_ID` |
| `agent_name` | `agent.name` | `str(128)` | basic | none | restart-required | none |
| `agent_display_name` | `agent.displayName` | `str(128)` | basic | none | restart-required | none |
| `agent_language` | `agent.language` | `enum(ja,en)` / `ja` | basic | none | restart-required | `AGENT_LANG` |
| `agent_greeting` | `agent.greeting` | `text(4096)` | basic | none | live | none |
| `agent_emotion_tags` | `agent.emotionTags` | `bool` / `true` | basic | none | live | none |
| `agent_wake_words` | `agent.wakeWords` | `str[]` | basic | none | restart-required | `WAKE_WORDS` |
| `agent_keyterms` | `agent.keyterms` | `str[]` | detail | none | restart-required | `SONIOX_CONTEXT_TERMS` |
| `agent_stt_wake_variants` | `agent.sttWakeVariants` | `str[]` | detail | none | restart-required | none |
| `agent_ack_variants` | `agent.ackVariants` | `str[]` | detail | none | live | none |
| `agent_progress_pings` | `agent.progressPings` | `str[]` | detail | none | live | none |
| `agent_exit_farewell` | `agent.exitFarewell` | `text(4096)` | detail | none | live | none |
| `agent_cancel_ack` | `agent.cancelAck` | `text(4096)` | detail | none | live | none |
| `agent_timeout_fallback` | `agent.timeoutFallback` | `text(4096)` | detail | none | live | none |
| `agent_avatar_url` | `agent.avatarUrl` | `url-or-empty` | detail | none | restart-required | `BOT_IMAGE_URL` |
| `llm_provider` | `llm.provider` | `enum(openclaw,openai-compatible)` / `openclaw` | basic | none | restart-required | `LLM_PROVIDER` |
| `llm_model` | `llm.model` | `str(256)` | basic | none | restart-required | none |
| `llm_temperature` | `llm.temperature` | `num(0,2)` / `0.5` | detail | none | restart-required | `AGENT_TEMPERATURE` |
| `llm_max_tokens` | `llm.maxTokens` | `int(1,32768)` / `300` | detail | none | restart-required | `AGENT_MAX_TOKENS` |
| `llm_history_max_turns` | `llm.historyMaxTurns` | `int(0,256)` / `12` | detail | none | restart-required | none |
| `llm_system_prompt` | `llm.systemPrompt` | `text(16384)` / empty | detail | none | restart-required | none |
| `openai_base_url` | `llm.openaiCompatible.baseUrl` | `url-or-empty` | detail | none | restart-required | `OPENAI_COMPATIBLE_BASE_URL` |
| `openai_empty_response_retry` | `llm.openaiCompatible.emptyResponseRetry` | `bool` / `true` | detail | none | restart-required | none |
| `openai_trusted_agent_tools` | `llm.openaiCompatible.trustedAgentTools` | `bool` / `false` | detail | none | restart-required | none |
| `soniox_api_key` | `stt.sonioxApiKey` | `secret` | basic | class-1 | restart-required | `SONIOX_API_KEY` |
| `deepgram_api_key` | `stt.apiKey` | `secret` | basic | class-1 | restart-required | `DEEPGRAM_API_KEY` |
| `stt_provider` | `stt.provider` | `enum(soniox,deepgram)` / `soniox` | basic | none | restart-required | `STT_PROVIDER` |
| `soniox_model` | `stt.soniox.model` | `str(128)` / `stt-rt-v5` | detail | none | restart-required | `SONIOX_MODEL` |
| `soniox_ws_url` | `stt.soniox.wsUrl` | `wss-url` | detail | none | restart-required | `SONIOX_WS_URL` |
| `soniox_endpoint_sensitivity` | `stt.soniox.endpointSensitivity` | `num(0,1)-or-null` | detail | none | restart-required | `SONIOX_ENDPOINT_SENSITIVITY` |
| `soniox_max_endpoint_delay_ms` | `stt.soniox.maxEndpointDelayMs` | `int(0,30000)-or-null` | detail | none | restart-required | `SONIOX_MAX_ENDPOINT_DELAY_MS` |
| `soniox_endpoint_latency_level` | `stt.soniox.endpointLatencyLevel` | `int(0,5)-or-null` | detail | none | restart-required | `SONIOX_ENDPOINT_LATENCY_LEVEL` |
| `listen_endpointing_ms` | `stt.endpointingMs` | `int(0,30000)` / `400` | detail | none | restart-required | `LISTEN_ENDPOINTING_MS` |
| `listen_utterance_end_ms` | `stt.utteranceEndMs` | `int(0,30000)` / `1200` | detail | none | restart-required | `LISTEN_UTTERANCE_END_MS` |
| `fish_audio_api_key` | `tts.apiKey` | `secret` | basic | class-1 | restart-required | `FISH_AUDIO_API_KEY` |
| `fish_audio_voice_id` | `tts.voiceId` | `str(256)` | basic | none | restart-required | `FISH_AUDIO_VOICE_ID` |
| `tts_provider` | `tts.provider` | `enum(fish-audio)` / `fish-audio` | basic | none | restart-required | `TTS_PROVIDER` |
| `fish_audio_model` | `tts.model` | `str(128)` / `s2-pro` | detail | none | restart-required | `FISH_AUDIO_MODEL` |
| `fish_audio_speed` | `tts.speed` | `num(0.5,2)` / `1` | detail | none | restart-required | `FISH_AUDIO_SPEED` |
| `fish_audio_latency` | `tts.latency` | `enum(normal,balanced,low)` / `balanced` | detail | none | restart-required | `FISH_AUDIO_LATENCY` |
| `tts_sample_rate` | `tts.sampleRate` | `int(8000,96000)` / `24000` | detail | none | restart-required | `TTS_SAMPLE_RATE` |
| `tts_cache_enabled` | `tts.cache.enabled` | `bool` / `true` | detail | none | restart-required | `TTS_CACHE_ENABLED` |
| `tts_cache_prewarm` | `tts.cache.prewarm` | `bool` / `true` | detail | none | restart-required | `TTS_CACHE_PREWARM` |
| `attendee_api_key` | `attendee.apiKey` | `secret` | basic | class-1 | restart-required | `ATTENDEE_API_KEY` |
| `attendee_base_url` | `attendee.baseUrl` | `url` / vendor default | detail | none | restart-required | `ATTENDEE_API_BASE_URL` |
| `slack_bot_token` | `slack.botToken` | `secret` | basic | class-1 | restart-required | `SLACK_BOT_TOKEN` |
| `slack_notifications_enabled` | `slack.notifications.enabled` | `bool` / `true` | basic | none | restart-required | `SLACK_NOTIFY_ENABLED` |
| `slack_notifications_target` | `slack.notifications.target` | `enum(dm,channel)` / `dm` | basic | none | restart-required | none |
| `slack_dm_user_id` | `slack.notifications.dmUserId` | `str(128)` | detail | none | restart-required | none |
| `slack_notify_channel` | `slack.notifyChannel` | `str(128)` | detail | none | restart-required | `SLACK_NOTIFY_CHANNEL` |
| `slack_summary_channel` | `slack.summaryChannel` | `str(128)` | detail | none | restart-required | `SLACK_SUMMARY_CHANNEL` |
| `slack_status_channel` | `slack.statusChannel` | `str(128)` | detail | none | restart-required | `SLACK_STATUS_CHANNEL` |
| `summary_enabled` | `summary.enabled` | `bool` / `true` | basic | none | restart-required | `SUMMARY_ENABLED` |
| `gateway_warmup_timeout_ms` | `gateway.warmupTimeoutMs` | `int(0,120000)` / `8000` | detail | none | restart-required | `GATEWAY_WARMUP_TIMEOUT_MS` |
| `gateway_display_name` | `gateway.displayName` | `str(128)` / `AI MeetServer` | detail | none | restart-required | none |
| `server_port` | `server.port` | `int(1,65535)` / `5005` | deployment-readonly | none | restart-required | `PORT` |
| `server_ngrok_domain` | `server.ngrokDomain` | `str(253)` / empty | deployment-readonly | none | restart-required | none |
| `resolved_home` | synthetic | absolute path | deployment-readonly | none | restart-required | `AI_MEET_HOME` |
| `task_extraction_enabled` | `features.taskExtractionEnabled` | `bool` / `true` | detail | none | restart-required | none |
| `streaming_equivalent_enabled` | `features.streamingEquivalentEnabled` | `bool` / `true` | detail | none | restart-required | none |

Conditional visibility is registry metadata, not schema omission: OpenAI-compatible fields are `hidden` in the rendered form unless that provider is selected, and provider-specific STT fields are likewise hidden when inactive. They remain in the DTO allowlist. No class 2 or class 3 name or path may occur in the registry or generated Zod source.

The following exhaustive extension table covers every remaining noncredential direct environment read in `docs/settings-env-inventory.json` and all 13 finite dynamic helper keys. These entries use the same registry contract; `credential` is `none` throughout. `pos-int` means an integer at least 1, `nn-int`/`nn-num` mean a nonnegative integer/number, and `ms` means `int(0,3600000)`. Apply is restart-required for every row.

| ID / config path | Type | UX | Environment alias |
|---|---|---|---|
| `mcp_base_url` / `deployment.mcpBaseUrl` | `url` | deployment-readonly | `AI_MEET_BASE_URL` |
| `mcp_join_timeout_ms` / `deployment.mcpJoinTimeoutMs` | `ms` / `60000` | deployment-readonly | `AI_MEET_JOIN_TIMEOUT_MS` |
| `attendee_retry_attempts` / `attendee.retryAttempts` | `int(0,10)` | detail | `ATTENDEE_RETRY_ATTEMPTS` |
| `attendee_retry_base_ms` / `attendee.retryBaseMs` | `ms` | detail | `ATTENDEE_RETRY_BASE_MS` |
| `attendee_timeout_ms` / `attendee.timeoutMs` | `ms` | detail | `ATTENDEE_TIMEOUT_MS` |
| `barge_in_confidence_min` / `audio.bargeInConfidenceMin` | `num(0,1)` | detail | `BARGE_IN_CONFIDENCE_MIN` |
| `barge_in_min_chars` / `audio.bargeInMinChars` | `nn-int` | detail | `BARGE_IN_MIN_CHARS` |
| `body_limit_bytes` / `server.bodyLimitBytes` | `int(1024,1048576)` | deployment-readonly | `BODY_LIMIT_BYTES` |
| `clause_pause_ms` / `audio.clausePauseMs` | `ms` | detail | `CLAUSE_PAUSE_MS` |
| `comfort_noise_amplitude` / `audio.comfortNoiseAmplitude` | `nn-num` | detail | `COMFORT_NOISE_AMPLITUDE` |
| `echo_gate_closed_bypass` / `audio.echoGateClosedBypass` | `bool` | detail | `ECHO_GATE_CLOSED_BYPASS` |
| `echo_loop_cooldown_ms` / `audio.echoLoopCooldownMs` | `ms` | detail | `ECHO_LOOP_COOLDOWN_MS` |
| `barge_in_enabled` / `features.bargeInEnabled` | `bool` | detail | `ENABLE_BARGE_IN` |
| `immediate_ack_enabled` / `features.immediateAckEnabled` | `bool` | detail | `ENABLE_IMMEDIATE_ACK` |
| `meeting_context_injection_enabled` / `features.meetingContextInjectionEnabled` | `bool` | detail | `ENABLE_MEETING_CONTEXT_INJECTION` |
| `progress_guard_enabled` / `features.progressGuardEnabled` | `bool` | detail | `ENABLE_PROGRESS_GUARD` |
| `first_chunk_min_chars` / `audio.firstChunkMinChars` | `nn-int` | detail | `FIRST_CHUNK_MIN_CHARS` |
| `first_token_delegate_ms` / `llm.firstTokenDelegateMs` | `ms` | detail | `FIRST_TOKEN_DELEGATE_MS` |
| `fish_audio_retry_max` / `tts.retryMax` | `int(0,10)` | detail | `FISH_AUDIO_RETRY_MAX` |
| `gateway_events_agent_id` / `gateway.events.agentId` | `str(128)` | detail | `GATEWAY_EVENTS_AGENT_ID` |
| `llm_response_timeout_ms` / `llm.responseTimeoutMs` | `ms` | detail | `LLM_RESPONSE_TIMEOUT_MS` |
| `meeting_context_raw_chars` / `meetingContext.rawChars` | `nn-int` | detail | `MEETING_CONTEXT_RAW_CHARS` |
| `meeting_context_raw_utterances` / `meetingContext.rawUtterances` | `nn-int` | detail | `MEETING_CONTEXT_RAW_UTTERANCES` |
| `metrics_disabled` / `metrics.disabled` | `bool` | detail | `METRICS_DISABLED` |
| `metrics_log_dir` / `metrics.logDir` | `absolute-path` | deployment-readonly | `METRICS_LOG_DIR` |
| `min_clause_len` / `audio.minClauseLen` | `nn-int` | detail | `MIN_CLAUSE_LEN` |
| `min_clause_prefix` / `audio.minClausePrefix` | `nn-int` | detail | `MIN_CLAUSE_PREFIX` |
| `openclaw_workspace` / `deployment.openclawWorkspace` | `absolute-path` | deployment-readonly | `OPENCLAW_WORKSPACE` |
| `pending_queue_max` / `audio.pendingQueueMax` | `pos-int` | detail | `PENDING_QUEUE_MAX` |
| `post_utterance_buffer_ms` / `audio.postUtteranceBufferMs` | `ms` | detail | `POST_UTTERANCE_BUFFER_MS` |
| `progress_ping_interval_ms` / `audio.progressPingIntervalMs` | `ms` | detail | `PROGRESS_PING_INTERVAL_MS` |
| `progress_ping_max` / `audio.progressPingMax` | `nn-int` | detail | `PROGRESS_PING_MAX` |
| `public_wss_url` / `deployment.publicWssUrl` | `wss-url-or-empty` | deployment-readonly | `PUBLIC_WSS_URL` |
| `sentence_pause_ms` / `audio.sentencePauseMs` | `ms` | detail | `SENTENCE_PAUSE_MS` |
| `session_grace_close_ms` / `server.sessionGraceCloseMs` | `ms` | detail | `SESSION_GRACE_CLOSE_MS` |
| `soniox_keepalive_interval_ms` / `stt.soniox.keepaliveIntervalMs` | `ms` | detail | `SONIOX_KEEPALIVE_INTERVAL_MS` |
| `soniox_pending_max` / `stt.soniox.pendingMax` | `pos-int` | detail | `SONIOX_PENDING_MAX` |
| `stt_accumulated_max_chars` / `stt.accumulatedMaxChars` | `pos-int` | detail | `STT_ACCUMULATED_MAX_CHARS` |
| `stt_keywords_enabled` / `stt.keywordsEnabled` | `bool` | detail | `STT_ENABLE_KEYWORDS` |
| `transcript_buffer_max` / `meetingContext.transcriptBufferMax` | `pos-int` | detail | `TRANSCRIPT_BUFFER_MAX` |
| `tts_cache_dir` / `tts.cache.dir` | `absolute-path` | deployment-readonly | `TTS_CACHE_DIR` |
| `tts_gap_ms` / `audio.ttsGapMs` | `ms` | detail | `TTS_GAP_MS` |
| `tts_lead_ms` / `audio.ttsLeadMs` | `ms` | detail | `TTS_LEAD_MS` |
| `wake_calibrate_enabled` / `features.wakeCalibrateEnabled` | `bool` | detail | `WAKE_CALIBRATE_ENABLED` |
| `gateway_events_enabled` / `gateway.events.enabled` | `bool` | detail | `GATEWAY_EVENTS_ENABLED` |
| `forced_delegation_abort` / `gateway.events.forcedDelegationAbort` | `bool` | detail | `FORCED_DELEGATION_ABORT` |
| `handoff_delegate_session` / `gateway.events.handoffDelegateSession` | `bool` | detail | `HANDOFF_DELEGATE_SESSION` |
| `report_chat_enabled` / `gateway.events.reportChatEnabled` | `bool` | detail | `REPORT_CHAT_ENABLED` |
| `report_voice_enabled` / `gateway.events.reportVoiceEnabled` | `bool` | detail | `REPORT_VOICE_ENABLED` |
| `handoff_cooldown_ms` / `gateway.events.handoffCooldownMs` | `ms` | detail | `HANDOFF_COOLDOWN_MS` |
| `report_voice_gap_ms` / `gateway.events.reportVoiceGapMs` | `ms` | detail | `REPORT_VOICE_GAP_MS` |
| `delegate_reply_fresh_ms` / `gateway.events.delegateReplyFreshMs` | `ms` | detail | `DELEGATE_REPLY_FRESH_MS` |
| `parent_compact_delay_ms` / `gateway.events.parentCompactDelayMs` | `ms` | detail | `PARENT_COMPACT_DELAY_MS` |
| `handoff_inflight_max` / `gateway.events.handoffInflightMax` | `pos-int` | detail | `HANDOFF_INFLIGHT_MAX` |
| `parent_compact_max_lines` / `gateway.events.parentCompactMaxLines` | `nn-int` | detail | `PARENT_COMPACT_MAX_LINES` |
| `short_utterance_skip_chars` / `gateway.events.shortUtteranceSkipChars` | `nn-int` | detail | `SHORT_UTTERANCE_SKIP_CHARS` |
| `circuit_breaker_timeouts` / `gateway.events.circuitBreakerTimeouts` | `nn-int` | detail | `CIRCUIT_BREAKER_TIMEOUTS` |

## 2. Whole-config persistence and allowlist DTO boundary

Reads and writes operate on the whole parsed `config.json` object, but clients only see the registry projection. The store algorithm is: read and parse the whole object; deep-clone it; remove class 2 paths; apply only validated allowlist values by canonical path; preserve every other unknown key byte-for-value at the JSON value level; write the complete object atomically with mode `0600`; re-read and validate; then publish the in-memory snapshot. Arrays replace as units. Omitted DTO fields preserve existing values. Explicit `null` is accepted only where the field schema permits it.

The class 2 deny paths are `gateway.url`, `gateway.token`, and `llm.openaiCompatible.apiKey`; all three are stripped during migration and every successful save, even though they are not DTO fields. Class 3 has no supported config path. Class 3-shaped legacy/unknown keys are preserved with other unknown configuration, but are ignored by runtime resolution and never projected. `_comments` and all other unknown configuration remain preserved.

DTO projection and whole-config persistence must be separate functions. `JSON.parse(req.body)` must never be merged directly, and Zod `.passthrough()` is forbidden on admin DTOs. Prototype-polluting keys (`__proto__`, `prototype`, `constructor`) are rejected at every depth.

## 3. Four-tier precedence and measured dotenv behavior

For every registry field with an environment alias, effective resolution is exactly:

1. meaningful OS/shell environment captured before dotenv at process startup;
2. meaningful value in the resolved-home `config.json` store;
3. meaningful value loaded from the resolved-home `.env` as an init/legacy seed;
4. code default.

The startup path alone captures `preDotenvEnv = { ...process.env }`, resolves home from `preDotenvEnv.AI_MEET_HOME || process.cwd()`, parses `.env` once without overriding the process launch environment, and passes immutable source-tagged snapshots to config resolution. Stores, route handlers, Zod modules, exporters, importers, tests, and registry modules must never open `envPath()` or `.env`. New executable entrypoints must call the same startup bootstrap before importing runtime consumers.

Current behavior measured on 2026-08-25:

- `src/server.js` imports `envPath()`, calls `dotenv.config({ path: envPath() })`, then imports config and providers. Dotenv's default non-override behavior leaves shell values first and supplies missing direct `process.env` reads from the resolved-home `.env`. `src/paths.js` has already pinned home before dotenv.
- `bin/ai-meet.js` itself never loads dotenv. `init` reads `.env.example` and, only for an existing file, parses the `LLM_PROVIDER=` line manually. `start` reaches dotenv indirectly by requiring `src/server.js`. `mcp` bypasses `src/server.js` and therefore bypasses dotenv.
- `src/mcp/server.js`, both when executed directly and through `meetmate mcp`, reads only inherited `process.env`; it does not load the resolved-home `.env`. Its current `AI_MEET_BASE_URL`, `AI_MEET_JOIN_TOKEN`, and `AI_MEET_JOIN_TIMEOUT_MS` behavior is therefore inconsistent with `start`.

The implementation judgment is to route both `start` and `mcp` through the central startup bootstrap; direct library imports remain side-effect free. This makes the four tiers consistent without allowing handlers to reread a mutable file.

`meaningful(value)` is false for `undefined`, `null`, empty/whitespace strings, exact `${NAME}` placeholders, case-insensitive `changeme`, `change-me`, `dummy`, `example`, `your-key`, `replace-me`, and the checked-in example sentinel values. A rejected dummy is treated as unset and never masks a lower tier. It is not an error until a meeting-start requirement needs it.

For a registry entry `r`, the UI badge formula is:

```text
launch = meaningful(preDotenvEnv[r.envAlias]) ? normalize(preDotenvEnv[r.envAlias]) : UNSET
stored = meaningful(readPath(config, r.path)) ? normalize(readPath(config, r.path)) : UNSET
showOverrideBadge = launch != UNSET
effectiveSource = launch != UNSET ? "os-env" : stored != UNSET ? "config" :
                  meaningful(dotenvSeeds[r.envAlias]) ? ".env-seed" : "default"
```

The badge exposes only alias and source, never the environment value. It is shown whenever a meaningful launch value controls the field, including when its normalized value currently equals the store, because a UI edit would still be ineffective until that launch override is removed. A `.env-seed` source may be shown as provenance but is not an override badge because the store outranks it.

## 4. 8.x class-2 migration and transactional failure behavior

On first settings-aware load of any 8.x config, scan `llm.openaiCompatible.apiKey`, `gateway.token`, and `gateway.url` before env interpolation. Values classified as placeholders/dummies by §3 are unset; real values are any other non-empty scalar. Config values from all three paths are ignored immediately for runtime resolution. Never log or return a real value.

For `llm.openaiCompatible.apiKey` and `gateway.token`, emit one deduplicated warning naming only the path and required environment variable (`OPENAI_COMPATIBLE_API_KEY` or `OPENCLAW_GATEWAY_TOKEN`) and show an environment setup guide appropriate to the current shell. `gateway.url` similarly names `OPENCLAW_GATEWAY_URL`. Migration never edits `.env`; the operator supplies class 2 values outside the admin plane. A real legacy value may keep the server in setup mode until its environment replacement is meaningful, but it may not be used as a fallback.

Migration/save is transactional: serialize the original file to a same-directory, mode-`0600`, unpredictable temporary backup; write the sanitized whole config to a separate temporary file; fsync file and directory where supported; atomic-rename; re-read and validate; then remove the backup. If any step fails, restore the original from the backup when replacement occurred, remove temporary artifacts best-effort, retain the prior in-memory snapshot, and return a structured settings error. The backup is a transaction artifact, not a second store and must not persist after success or rollback.

Migration failure aborts only that migration/save request. The HTTP server, settings UI, API, and `/health` remain up; meeting start returns the setup-mode error described in §7. Neither config loading nor setup/migration calls `process.exit`, `process.exit(1)`, or assigns a fatal `process.exitCode`. Startup logs at most a value-free warning.

## 5. Environment inventory and lock test

`docs/settings-env-inventory.json` is the machine-readable inventory. Its `extractionCommand` is exactly:

```sh
grep -rhoE 'process\.env\.[A-Z0-9_]+' src/ bin/ | sort -u
```

The frozen baseline has 89 unique direct names. Every entry carries all current `file:line` references plus its UX and credential classification. Computed bracket references are not silently mixed into that count: the finite helper-key series and the per-agent Slack-token family are recorded under `dynamicReferences`.

The lock test runs the exact command, strips the `process.env.` prefix, and deep-compares the sorted names to the 89 `directReferences[].name` values. It separately rescans `process.env[` sites and deep-compares source location plus the declared finite names/pattern. The test also validates unique names, exact count, allowed classification enums, existing source lines containing the stated reference, and the rule that class 2/3 entries have UX `hidden`. An intentional environment read change updates code, JSON, registry/precedence documentation, and this lock test in one commit.

## 6. Admin HTTP API, schemas, and localhost boundary

The single existing server continues to listen on port 5005 (or its existing port override). The admin plane is:

| Method and path | Request | Success |
|---|---|---|
| `GET /api/settings` | none | `{schemaVersion:1, revision, setupMode, fields, effective, sources, restartRequired}` |
| `PUT /api/settings` | `{schemaVersion:1, revision, fields}` | same shape with new revision |
| `GET /api/settings/export` | none | §8 export document as attachment |
| `POST /api/settings/import` | §8 export document plus `revision` | GET shape with import report |
| `POST /api/settings/connections/:provider/test` | `{revision}` where provider is `soniox|deepgram|fish-audio|attendee|slack` | `{ok, provider, code, message, durationMs}` |
| `POST /api/settings/migrate-env-class1` | `{revision}` | `{imported:[fieldId], skipped:[fieldId], revision}` |
| `POST /api/settings/audio` | multipart contract in §9 | audio metadata, never a filesystem absolute path |
| `DELETE /api/settings/audio/:id` | `{revision}` | `{deleted:true, revision}` |

`revision` is a SHA-256 digest of the last parsed whole-config bytes; stale PUT/import/delete requests return `409 SETTINGS_REVISION_CONFLICT`. `fields` is a strict object keyed by registry IDs. Credential response values are masked objects from §8, not strings. Connection tests use the effective class 1 credential already held by the resolver, perform one minimal vendor-specific authenticated request with a five-second timeout, never persist or echo response bodies, and cannot test class 2 or class 3 connections.

The admin plane requires all of: the accepted socket local address is loopback; `Host` is exactly `localhost`, `127.0.0.1`, or `[::1]` with the listener's actual port; no `Forwarded` or `X-Forwarded-*` header is present; and the path is allowlisted above (including UI assets under `/settings-assets/`). Requests arriving through ngrok fail these checks and receive `404`, not an authentication hint. The dashboard at `/` is subject to the same guard. Meeting/data-plane paths retain their current tunnel behavior. No CORS headers are emitted.

Every mutating admin request additionally requires `Content-Type` for its schema, `Origin` exactly equal to `http://localhost:<actual-port>` or the corresponding numeric-loopback origin, and `Sec-Fetch-Site` of `same-origin` when the header is present. Missing or `null` Origin is rejected. JSON request bodies are limited to 256 KiB before parsing; connection-test bodies to 4 KiB; audio uses §9's streaming cap. Keep-alive bodies are drained or the connection is closed after rejection.

All errors are JSON:

```json
{"error":{"code":"SETTINGS_VALIDATION_FAILED","message":"Request validation failed","details":[{"path":"fields.llm_temperature","code":"too_big"}],"requestId":"opaque-id"}}
```

Messages/details never contain submitted values, secrets, vendor response bodies, absolute home paths, or stack traces. Status mapping is `400` malformed JSON, `403` same-origin failure, `404` nonlocal/admin route concealment, `409` revision or version conflict, `413` body too large, `415` media type, `422` schema/semantic validation, `429` connection-test rate limit, and `500` transactional store failure.

## 7. Setup mode and meeting-start validation

An absent, empty-object, invalid, unmigrated, or incomplete config activates setup mode; it does not terminate the process. The dashboard, admin API, import/export where possible, migration guidance, connection tests for configured class 1 fields, and `/health` remain available. `/health` returns HTTP 200 with `{ok:true, setupMode:true, meetingReady:false}` plus value-free issue codes.

Meeting join/start is the validation boundary. It returns `503` with `MEETING_SETUP_REQUIRED` until the active provider combination has meaningful requirements: agent id/display name and wake word; selected STT class 1 key; Fish Audio class 1 API key and voice id; Attendee class 1 key; plus either both OpenClaw class 2 environment values or OpenAI-compatible base URL, model, and class 2 API-key environment value. Slack is required only when Slack notifications are enabled. Invalid config JSON reports a setup issue and retains the last valid snapshot if one exists. No setup path calls `process.exit(1)`.

## 8. Masking, import/export, templates, and `.env` class-1 migration

Class 1 GET fields have shape `{state:"set"|"unset"|"overridden", value:"••••••••"|""}`. PUT accepts the exact mask `"••••••••"` to preserve, a non-empty replacement to set, and `null` to clear; empty string is rejected so clearing is deliberate. The mask is a protocol constant and can never be stored. Class 2/3 have no DTO representation.

Export is `Content-Type: application/json` with:

```json
{"format":"meetmate-settings","version":1,"exportedAt":"ISO-8601","settings":{"agent_display_name":"…"}}
```

It contains only noncredential registry fields with UX `basic` or `detail`; all credentials in classes 1, 2, and 3, deployment paths, effective/source diagnostics, revisions, absolute paths, and unknown whole-config keys are excluded. Template presets use the same secret-free shape and may contain only documented nonsecret settings; they never carry blank-looking credential presets or dummy secrets.

Import accepts version 1 strictly. A version 0 document is migrated in memory through a named, deterministic migrator and reported in the response; it is never re-exported as version 0. Negative, noninteger, unknown-format, or future versions return `409 SETTINGS_IMPORT_VERSION_UNSUPPORTED`. Unknown setting IDs in a recognized version return `422` rather than being ignored. Import merges validated allowlisted values into the whole config, so unknown existing config keys remain preserved.

`POST /api/settings/migrate-env-class1` never opens `.env`. It consumes only the source-tagged `.env` seed snapshot captured by the startup bootstrap, copies meaningful class 1 values into currently-unset canonical config paths, then saves transactionally. It does not overwrite an existing store value and never migrates class 2/3. The snapshot originates at `<resolved-home>/.env`; resolved home is pre-dotenv `AI_MEET_HOME` when present and current working directory otherwise. The response reports field IDs only. A restart is required before the new store tier becomes the runtime source.

## 9. MP3 ingest, home ownership, and cache compatibility

User MP3s live only under `<resolved-home>/assets/settings-audio/`; bundled package assets remain read-only and are never overwritten, renamed, or deleted. The only metadata store is the existing `config.json`, under allowlisted `audio.clips[]` records `{id, role, text, relativePath, sha256, cacheKey, createdAt}`. `role` is one of `ack|progress|greeting|farewell|timeout`; `relativePath` is server-generated and relative to resolved home.

`POST /api/settings/audio` is one multipart request containing one `audio/mpeg` file and UTF-8 JSON metadata `{role,text,referenceId,model,sampleRate,speed,revision}`. Limit: 10 MiB per upload, 32 clips, and 128 MiB total managed audio. Stream to a mode-`0600` random temporary file while hashing; reject a second file part, NUL, traversal, symlink targets, non-MP3 extension, invalid ID3/MPEG frame signature, or dimensions outside the metadata schema. Never use the client filename; the final name is `<uuid>.mp3`. Atomic rename occurs only after config transaction success, and either side is rolled back if the other fails.

`cacheKey` is computed by the canonical `tts-cache` key function, or a shared equivalent over exactly `{text,referenceId,model,sampleRate,speed}`; latency and API key remain excluded as today. On every read and before playback, recompute it from current settings. A mismatch marks the clip `stale` in the DTO and prevents automatic use; it is never silently played for different text/voice/model/rate/speed. Deletion resolves and realpaths under the managed directory, refuses symlinks/out-of-root targets, updates config transactionally, then unlinks the owned file. Cleanup failure is reported without deleting unrelated files.

## 10. Canonical structured emotion tags

`src/messages.js` must define one immutable structured list and compose all prompt prose from it:

```js
const EMOTION_TAGS = Object.freeze([
  { tag: "[soft voice]", labelJa: "デフォルト・優しい声", fallback: true },
  { tag: "[warm]", labelJa: "温かみ" },
  { tag: "[friendly, warm]", labelJa: "親しみ＋温かみ" },
  { tag: "[empathetic, unhurried]", labelJa: "謝罪・落ち着き" },
  { tag: "[thoughtful]", labelJa: "考え深く" }
]);
```

The current duplicate tag prose at the default `voiceEmotionLine` near line 6 and `gatewayBriefingSystem` near line 71 must both call composition helpers backed by `EMOTION_TAGS`; neither site may retain a handwritten tag list. The settings UI reads the same exported data for help text. Custom tags are undecided because Fish Audio compatibility and validation evidence are absent; this version intentionally exposes no custom-tag editor.

## 11. Stable task-extraction and streaming-equivalent feature flags

The two stable registry/API/DOM identifiers are `task_extraction_enabled` and `streaming_equivalent_enabled`, with canonical paths `features.taskExtractionEnabled` and `features.streamingEquivalentEnabled`. Both are strict booleans and default to `true`, preserving the currently enabled behavior. They have no environment aliases.

These are functional feature flags, not labels. Runtime configuration must pass each resolved boolean into the actual task-extraction and streaming-equivalent branch and bypass only that branch when false. Tests must toggle each independently and observe the corresponding runtime behavior while proving the other behavior is unchanged. Rendering or persisting either flag without runtime wiring fails the contract.

## 12. Static boundary, inventory, and sentinel leak tests

The implementation gate includes deterministic static scans over `src/`, `bin/`, `public/`, and tests:

- only the startup bootstrap may contain `dotenv.config`, open `envPath()`, or read the resolved-home `.env`; settings store/route/schema/export/import modules fail the scan if they do;
- class 2/3 names and class 2 deny paths must not occur in public UI assets, settings registry, Zod schemas, GET/PUT/export/import schema fixtures, presets, or OpenAPI-like descriptions; an explicit server-side denylist/migration module and environment inventory are the only administrative exceptions;
- admin route modules may not contain `process.exit`, assign `process.exitCode`, interpolate request bodies into logs/errors, use Zod `.passthrough()`, or spread/assign unprojected request objects into config;
- the exact 89-name inventory and dynamic references pass §5's lock test;
- `src/messages.js` contains each canonical emotion tag literal only in `EMOTION_TAGS`, and both prompt outputs contain the composed list;
- settings paths are unreachable with ngrok/forwarded headers and with nonlocal Host/Origin combinations.

Sentinel integration tests use distinct high-entropy values for every credential in classes 1, 2, and 3. Class 1 sentinels may appear only in the mode-`0600` whole-config store and the in-memory provider call selected by the test; they must not appear in HTML, GET, errors, logs, connection-test responses, export, presets, generated `AGENTS.md`, or imported output. Class 2 sentinels may appear only in the test environment and intended provider call and must not remain in `config.json` after save/migration. Class 3 sentinels deliberately seeded under unknown config keys remain preserved internally, but must be ignored by runtime resolution and never appear in any admin projection, export, error, log, template, or generated file; actual class 3 runtime values come only from the environment.

## 13. Singular agent boundary and reserved expansion

This contract keeps the existing singular `agent` object. The settings registry, DTO, UI, migration, export, validation, and runtime must not introduce, infer, or synthesize an `agents` array. A top-level `agents` key is reserved for a future separately approved multi-agent contract: whole-config preservation may retain an already-existing unknown `agents` value, but the settings plane cannot expose, mutate, import, export, validate, or consume it. No singular-to-array migration is part of Issue #30.
