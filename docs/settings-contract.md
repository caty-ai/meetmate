# Settings, admin-plane, and migration contract (Epic #29 child #30)

Status: **proposed — pending CP#1 owner approval**. This v1.1 contract augments the existing Node `http` server and vanilla-JavaScript dashboard on `localhost:5005`. It does not authorize another application, UI framework, persistence store, or port. `config.json` in the resolved home remains the only settings store. The settings UI, admin API, import/export, connection tests, TTS preview, and audio ingest form one allowlisted admin plane; meeting transport remains a separate data plane.

The credential classes used below are fixed:

- **Class 1 — external Meetmate vendors:** `SONIOX_API_KEY`, `DEEPGRAM_API_KEY`, `FISH_AUDIO_API_KEY`, `ATTENDEE_API_KEY`, and `SLACK_BOT_TOKEN`. These are primary UI fields, masked after entry, persisted only at their allowlisted `config.json` paths, and omitted from exports.
- **Class 2 — agent/LLM connection credentials:** `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, and `OPENAI_COMPATIBLE_API_KEY`. These are environment-only and absent from UI markup, admin DTOs, exports, imports, presets, and Zod schemas. Value-free `.env.example` and generated-instance guidance may name the environment keys but never contain their values.
- **Class 3 — internal control tokens:** `WS_SHARED_TOKEN`, `JOIN_SHARED_TOKEN`, and `AI_MEET_JOIN_TOKEN`. These are environment-only and absent from UI markup, admin DTOs, exports, imports, presets, and Zod schemas. Value-free `.env.example` and generated-instance guidance may name the keys but never contain their values.

## 1. Zod schema and settings-registry contract

The implementation has one declarative `SETTINGS_REGISTRY`. Zod schemas, GET masking, PUT/import projection, the vanilla-JavaScript form, export projection, override badges, and meeting-start validation are derived from it. A handler must not accept a path merely because it exists in `config.json`. Each entry has exactly these properties:

```ts
type SettingDefinition = {
  id: string;                       // stable snake_case API/UI identifier
  path: string | null;              // canonical config.json dotted path; null only for synthetic diagnostics
  schema: ZodType;                  // strict field validator
  ux: "basic" | "detail" | "deployment-readonly" | "hidden";
  credential: "class-1" | "none"; // class 2/3 entries are forbidden
  apply: "restart-required" | "live";
  envAlias: string | null;
  defaultValue?: unknown;
  requiredAtMeetingStart?: boolean;
  writeSurface: "settings" | "audio-only" | "none";
};
```

`apply` is `restart-required` unless the table explicitly says `live`. `writeSurface` defaults to `settings` for `basic|detail`; every `deployment-readonly` entry is `none`, and `audio_clips` is `audio-only`. `hidden` is reserved for registry fields that are conditionally irrelevant in the UI; it does not permit class 2 or class 3. Deployment-readonly values may be returned for diagnosis but PUT/import must reject changes to them. Credential values use `z.string().trim().min(1).max(4096)` and the masked round trip in §8. `url` means an absolute URL whose scheme is exactly `http:` or `https:` and whose username, password, fragment, and surrounding whitespace are absent. `url-or-empty` is either the exact empty string or a `url`; whitespace-only is not empty. `hostname` is one DNS hostname with no scheme, userinfo, path, query, fragment, or port. `wss-url` analogously requires an absolute `wss:` URL, and `wss-url-or-empty` is the exact empty string or a `wss-url`. Arrays are unique, trimmed strings with at most 64 entries and 128 UTF-8 characters per entry; free text is at most 16 KiB; regex patterns are at most 2 KiB and flags match `^(?!.*(.).*\1)[dimsuvy]*$` before compilation. Unknown object keys are rejected by the strict DTO schema.

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
| `soniox_endpoint_sensitivity` | `stt.soniox.endpointSensitivity` | `num(-1,1)-or-null` | detail | none | restart-required | `SONIOX_ENDPOINT_SENSITIVITY` |
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
| `attendee_base_url` | `attendee.baseUrl` | `hostname` / `app.attendee.dev` | detail | none | restart-required | `ATTENDEE_API_BASE_URL` |
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
| `server_ngrok_domain` | `server.ngrokDomain` | `str(253)` / empty | detail | none | restart-required | none |
| `resolved_home` | synthetic | absolute path | deployment-readonly | none | restart-required | `AI_MEET_HOME` |
| `task_extraction_enabled` | `features.taskExtractionEnabled` | `bool` / `true` | detail | none | restart-required | none |
| `streaming_equivalent_enabled` | `features.streamingEquivalentEnabled` | `bool` / `true` | detail | none | restart-required | none |
| `audio_clips` | `audio.clips` | `clip-record[]` / `[]` | detail | none | live | none |

Conditional visibility is registry metadata, not schema omission: OpenAI-compatible fields are `hidden` in the rendered form unless that provider is selected, and provider-specific STT fields are likewise hidden when inactive. They remain in the DTO allowlist. No class 2 or class 3 name or path may occur in the registry or generated Zod source.

`audio_clips.writeSurface` is `audio-only`; it is projected into GET for the clip manager but rejected by PUT/import/export. `resolved_home.writeSurface` is `none`. `server_ngrok_domain` is an editable detail setting: PUT/import persist `server.ngrokDomain`, and its apply state is restart-required.

The following exhaustive extension table covers every remaining noncredential direct environment read in `docs/settings-env-inventory.json` and all 13 finite dynamic helper keys. These are **not** settings-registry entries: every row is `deployment-readonly`, has no canonical config path, is absent from PUT/import/export, and appears only as a value-safe current diagnostic in the detail UI. Resolution is meaningful pre-dotenv launch environment, then meaningful resolved-home `.env`, then the existing code default; the config tier in §3 does not apply. Runtime consumers still receive these values from the central resolver and must not read `process.env` directly. `pos-int` means an integer at least 1, `nn-int`/`nn-num` mean a nonnegative integer/number, and `ms` means `int(0,3600000)`.

| Diagnostic ID | Type | Environment alias |
|---|---|---|
| `mcp_base_url` | `url` | `AI_MEET_BASE_URL` |
| `mcp_join_timeout_ms` | `ms` / `60000` | `AI_MEET_JOIN_TIMEOUT_MS` |
| `attendee_retry_attempts` | `int(0,10)` | `ATTENDEE_RETRY_ATTEMPTS` |
| `attendee_retry_base_ms` | `ms` | `ATTENDEE_RETRY_BASE_MS` |
| `attendee_timeout_ms` | `ms` | `ATTENDEE_TIMEOUT_MS` |
| `barge_in_confidence_min` | `num(0,1)` | `BARGE_IN_CONFIDENCE_MIN` |
| `barge_in_min_chars` | `nn-int` | `BARGE_IN_MIN_CHARS` |
| `body_limit_bytes` | `int(1024,1048576)` | `BODY_LIMIT_BYTES` |
| `clause_pause_ms` | `ms` | `CLAUSE_PAUSE_MS` |
| `comfort_noise_amplitude` | `nn-num` | `COMFORT_NOISE_AMPLITUDE` |
| `echo_gate_closed_bypass` | `bool` | `ECHO_GATE_CLOSED_BYPASS` |
| `echo_loop_cooldown_ms` | `ms` | `ECHO_LOOP_COOLDOWN_MS` |
| `barge_in_enabled` | `bool` | `ENABLE_BARGE_IN` |
| `immediate_ack_enabled` | `bool` | `ENABLE_IMMEDIATE_ACK` |
| `meeting_context_injection_enabled` | `bool` | `ENABLE_MEETING_CONTEXT_INJECTION` |
| `progress_guard_enabled` | `bool` | `ENABLE_PROGRESS_GUARD` |
| `first_chunk_min_chars` | `nn-int` | `FIRST_CHUNK_MIN_CHARS` |
| `first_token_delegate_ms` | `ms` | `FIRST_TOKEN_DELEGATE_MS` |
| `fish_audio_retry_max` | `int(0,10)` | `FISH_AUDIO_RETRY_MAX` |
| `gateway_events_agent_id` | `str(128)` | `GATEWAY_EVENTS_AGENT_ID` |
| `llm_response_timeout_ms` | `ms` | `LLM_RESPONSE_TIMEOUT_MS` |
| `meeting_context_raw_chars` | `nn-int` | `MEETING_CONTEXT_RAW_CHARS` |
| `meeting_context_raw_utterances` | `nn-int` | `MEETING_CONTEXT_RAW_UTTERANCES` |
| `metrics_disabled` | `bool` | `METRICS_DISABLED` |
| `metrics_log_dir` | `absolute-path` | `METRICS_LOG_DIR` |
| `min_clause_len` | `nn-int` | `MIN_CLAUSE_LEN` |
| `min_clause_prefix` | `nn-int` | `MIN_CLAUSE_PREFIX` |
| `openclaw_workspace` | `absolute-path` | `OPENCLAW_WORKSPACE` |
| `pending_queue_max` | `pos-int` | `PENDING_QUEUE_MAX` |
| `post_utterance_buffer_ms` | `ms` | `POST_UTTERANCE_BUFFER_MS` |
| `progress_ping_interval_ms` | `ms` | `PROGRESS_PING_INTERVAL_MS` |
| `progress_ping_max` | `nn-int` | `PROGRESS_PING_MAX` |
| `public_wss_url` | `wss-url-or-empty` | `PUBLIC_WSS_URL` |
| `sentence_pause_ms` | `ms` | `SENTENCE_PAUSE_MS` |
| `session_grace_close_ms` | `ms` | `SESSION_GRACE_CLOSE_MS` |
| `soniox_keepalive_interval_ms` | `ms` | `SONIOX_KEEPALIVE_INTERVAL_MS` |
| `soniox_pending_max` | `pos-int` | `SONIOX_PENDING_MAX` |
| `stt_accumulated_max_chars` | `pos-int` | `STT_ACCUMULATED_MAX_CHARS` |
| `stt_keywords_enabled` | `bool` | `STT_ENABLE_KEYWORDS` |
| `transcript_buffer_max` | `pos-int` | `TRANSCRIPT_BUFFER_MAX` |
| `tts_cache_dir` | `absolute-path` | `TTS_CACHE_DIR` |
| `tts_gap_ms` | `ms` | `TTS_GAP_MS` |
| `tts_lead_ms` | `ms` | `TTS_LEAD_MS` |
| `wake_calibrate_enabled` | `bool` | `WAKE_CALIBRATE_ENABLED` |
| `gateway_events_enabled` | `bool` | `GATEWAY_EVENTS_ENABLED` |
| `forced_delegation_abort` | `bool` | `FORCED_DELEGATION_ABORT` |
| `handoff_delegate_session` | `bool` | `HANDOFF_DELEGATE_SESSION` |
| `report_chat_enabled` | `bool` | `REPORT_CHAT_ENABLED` |
| `report_voice_enabled` | `bool` | `REPORT_VOICE_ENABLED` |
| `handoff_cooldown_ms` | `ms` | `HANDOFF_COOLDOWN_MS` |
| `report_voice_gap_ms` | `ms` | `REPORT_VOICE_GAP_MS` |
| `delegate_reply_fresh_ms` | `ms` | `DELEGATE_REPLY_FRESH_MS` |
| `parent_compact_delay_ms` | `ms` | `PARENT_COMPACT_DELAY_MS` |
| `handoff_inflight_max` | `pos-int` | `HANDOFF_INFLIGHT_MAX` |
| `parent_compact_max_lines` | `nn-int` | `PARENT_COMPACT_MAX_LINES` |
| `short_utterance_skip_chars` | `nn-int` | `SHORT_UTTERANCE_SKIP_CHARS` |
| `circuit_breaker_timeouts` | `nn-int` | `CIRCUIT_BREAKER_TIMEOUTS` |

## 2. Whole-config persistence and allowlist DTO boundary

Reads and writes operate on the whole parsed `config.json` object, but clients only see the registry projection. Before any read or write, `lstat` each **existing** config or managed-audio path; a symbolic link is rejected with `SETTINGS_SYMLINK_REJECTED` without following it. A missing `config.json` is setup mode, not a symlink error. The recommended implementation uses `O_NOFOLLOW` where the platform supplies it in addition to, not instead of, the `lstat` check.

The store algorithm is: acquire the one-process settings lock; read and parse the whole object and its bytes; deep-clone it; remove every class 2 deny path below; apply only validated registry values by canonical path; preserve every other unknown key byte-for-value at the JSON value level; write a same-directory unpredictable temporary file with mode `0600`; fsync it; **while still holding the lock, re-read the committed file and compare its SHA-256 to the request revision immediately before rename**; atomic-rename; fsync the directory where supported; re-read and validate; then publish the in-memory snapshot and release the lock. Arrays replace as units. Omitted DTO fields preserve existing values. Explicit `null` is accepted only where the field schema permits it.

Issue #30 supports one Meetmate process per resolved home. If another live process owns or races the lock, the request fails without retry or write as `503 SETTINGS_MULTI_PROCESS_UNSUPPORTED`; last-writer-wins is forbidden. A stale lock whose recorded PID is provably absent may be cleaned up, but an unverifiable owner is treated as live. This is an explicit unsupported topology, not an optimistic-concurrency feature.

The class 2 deny paths are `gateway.url`, `gateway.token`, `llm.openaiCompatible.apiKey`, `agent.gatewayUrl`, `agent.gatewayToken`, and `agent.openaiCompatible.apiKey`, plus the same three agent-level names beneath any legacy per-agent container and the `gatewayUrl`, `gatewayToken`, or `openaiCompatible.apiKey` members of per-session `overrides`. Runtime reads from all these config/profile/override locations are disabled; only the startup environment snapshot may supply class 2 values. Persistent deny paths are stripped during migration and every successful save even though they are not DTO fields. Class 2 values must not be copied into `AgentProfile`, session profiles, debug DTOs, or structured logs. Class 3 has no supported config path. Class 3-shaped legacy/unknown keys are preserved with other unknown configuration, but are ignored by runtime resolution and never projected. `_comments` and all other unknown configuration remain preserved.

DTO projection and whole-config persistence must be separate functions. `JSON.parse(req.body)` must never be merged directly, and Zod `.passthrough()` is forbidden on admin DTOs. Prototype-polluting keys (`__proto__`, `prototype`, `constructor`) are rejected at every depth. The existing wake-calibration save path must call this same locked, revision-checked, class-2-stripping, atomic-`0600` store; its current independent lock/tmp writer is not an exception. `/calibrate/status` supplies the current revision to the bundled page; `/calibrate/apply` sends strict `{variants,revision}`, rejects stale revision, and returns `{ok:true,added,total,revision}` after the shared store commits. It never writes `.bak`, `.tmp`, or `config.json` independently.

## 3. Four-tier precedence and measured dotenv behavior

For every editable main-registry field with `writeSurface:"settings"` and an environment alias, effective resolution is exactly:

1. meaningful OS/shell environment captured before dotenv at process startup;
2. meaningful value in the resolved-home `config.json` store;
3. meaningful value loaded from the resolved-home `.env` as an init/legacy seed;
4. code default.

The startup path alone captures `preDotenvEnv = { ...process.env }`, resolves home from `preDotenvEnv.AI_MEET_HOME || process.cwd()`, parses `.env` once without overriding the process launch environment, and passes immutable source-tagged snapshots to config resolution. Stores, route handlers, Zod modules, exporters, importers, tests, and registry modules must never open `envPath()` or `.env`. New executable entrypoints must call the same startup bootstrap before importing runtime consumers. Every runtime consumer, including pipeline constants and cache-key generation, receives resolver output; direct `process.env` reads are forbidden outside the bootstrap boundary.

Noneditable main entries are separate from that rule. `server_port` is a deployment-readonly diagnostic of the actual bound port, not a PUT/import field; `resolved_home` is the absolute home pinned from meaningful pre-dotenv `AI_MEET_HOME`, otherwise launch cwd, and a `.env` `AI_MEET_HOME` line or config can never affect it; `audio_clips` is stored and changed only through the audio endpoints. None of these three is promised editable four-tier behavior or an override badge.

Current behavior measured on 2026-08-25:

- `src/server.js` imports `envPath()`, calls `dotenv.config({ path: envPath() })`, then imports config and providers. Dotenv's default non-override behavior leaves shell values first and supplies missing direct `process.env` reads from the resolved-home `.env`. `src/paths.js` has already pinned home before dotenv.
- `bin/ai-meet.js` itself never loads dotenv. `init` reads `.env.example` and, only for an existing file, parses the `LLM_PROVIDER=` line manually. `start` reaches dotenv indirectly by requiring `src/server.js`. `mcp` bypasses `src/server.js` and therefore bypasses dotenv.
- `src/mcp/server.js`, both when executed directly and through `meetmate mcp`, reads only inherited `process.env`; it does not load the resolved-home `.env`. Its current `AI_MEET_BASE_URL`, `AI_MEET_JOIN_TOKEN`, and `AI_MEET_JOIN_TIMEOUT_MS` behavior is therefore inconsistent with `start`.

The implementation judgment is to route both `start` and `mcp` through the central startup bootstrap; direct library imports remain side-effect free. This makes the four tiers consistent without allowing handlers to reread a mutable file.

`normalize(value)` trims strings; typed numeric fields then parse a finite base-10 numeric string and compare its canonical numeric value (so `"1"`, `"1.0"`, and numeric `1` are equal), while booleans/enums use their registry parser and all other strings compare exactly after trimming. `meaningful(value)` is false only for `undefined`, `null`, a normalized empty string, an exact generic placeholder matching `^\$\{[A-Z][A-Z0-9_]*\}$`, or one of these 13 exact, case-sensitive checked-in sentinels after normalization: `your_gateway_token_here`, `your_deepgram_key`, `your_soniox_key`, `your_attendee_key`, `your_fish_audio_key`, `your_voice_id`, `your_slack_bot_token`, `your-model-id`, `your_openai_compatible_key`, `your-agent-id`, `YourAgent`, `your-agent`, and `エージェント名`. No substring or case-insensitive fuzzy matching is allowed. A rejected sentinel is treated as unset and never masks a lower tier. It is not an error until a meeting-start requirement needs it.

For an editable registry entry `r`, the UI badge formula is:

```text
launch = meaningful(preDotenvEnv[r.envAlias]) ? normalize(preDotenvEnv[r.envAlias]) : UNSET
stored = meaningful(readPath(config, r.path)) ? normalize(readPath(config, r.path)) : UNSET
showOverrideBadge = launch != UNSET
effectiveSource = launch != UNSET ? "os-env" : stored != UNSET ? "config" :
                  meaningful(dotenvSeeds[r.envAlias]) ? ".env-seed" : "default"
```

The badge exposes only alias and source, never the environment value. It is shown whenever a meaningful launch value controls the field, including when its normalized value currently equals the store, because a UI edit would still be ineffective until that launch override is removed. A `.env-seed` source may be shown as provenance but is not an override badge because the store outranks it.

The registry is the UX source of truth: generated UI grouping, inventory UX, DTO inclusion, write surface, effective/source projection, restart state, and runtime parser all deep-compare against registry metadata. In particular `BOT_IMAGE_URL` and `ATTENDEE_API_BASE_URL` are `detail`, while `SLACK_NOTIFY_ENABLED` and `SUMMARY_ENABLED` are `basic`. A registry/inventory lock test fails any mismatch.

## 4. 8.x class-2 and class-1 migration behavior

On first settings-aware load of any 8.x config, scan every persistent class 2 deny path in §2 before env interpolation. Values that are not meaningful under §3 are unset; real values are any other non-empty scalar. Config values from all deny paths are ignored immediately for runtime resolution. Never log or return a real value.

Emit one deduplicated value-free warning that names only the legacy path and required environment variable, and show shell-appropriate setup guidance. Migration never edits `.env`; the operator supplies class 2 values outside the admin plane. A real legacy value may keep the server in setup mode until its environment replacement is meaningful, but it may not be used as a fallback. Class 2 names are permitted only in server-side bootstrap/migration code, value-free server guidance/docs, the environment inventory, and generated instance guidance; they remain forbidden in public UI assets and every admin schema or response.

Migration/save is transactional under §2: serialize the original file to a same-directory, mode-`0600`, unpredictable temporary backup; write the sanitized whole config to a separate temporary file; precommit revision-check; fsync file and directory where supported; atomic-rename; re-read and validate; then remove the backup. If any step fails, restore the original from the backup when replacement occurred, remove temporary artifacts best-effort, retain the prior in-memory snapshot, and return a structured settings error. The backup is a transaction artifact, not a second store and must not persist after success or rollback.

Migration failure aborts only that migration/save request. The HTTP server, settings UI, API, and `/health` remain up; meeting start returns the setup-mode error described in §7. Neither config loading nor setup/migration calls `process.exit`, `process.exit(1)`, or assigns a fatal `process.exitCode`. Startup logs at most a value-free warning. There is no settings export/import version-0 migrator; §8 accepts version 1 only.

## 5. Environment inventory and lock test

`docs/settings-env-inventory.json` is the machine-readable migration inventory and ends with exactly one trailing newline. Its legacy `extractionCommand` remains recorded for reproducibility:

```sh
grep -rhoE 'process\.env\.[A-Z0-9_]+' src/ bin/ | sort -u
```

The baseline has 89 unique direct names. Every entry carries all current `file:line` references plus its registry-aligned UX and credential classification. The known direct-read migration sites explicitly include `src/tts-cache.js:30` (`FISH_AUDIO_MODEL`; the review requirement called this `src/tts-cache.js:31`, but the current checkout places the token on line 30) as well as `src/tts-fish.js:182`. Computed bracket references are not silently mixed into that count: the 13 finite helper keys and the per-agent Slack-token family are recorded under `dynamicReferences`. Every noncredential extension/helper entry is `deployment-readonly` with `env-only-readonly-diagnostic` handling; class 2/3 and dynamic Slack entries remain `hidden`.

The lock test tokenizes all production JavaScript under `src/` and `bin/`, inventories both `process.env.NAME` and literal/computed `process.env[...]`, and deep-compares every token to the direct or dynamic sets. It rejects unconsumed syntax rather than ignoring it: destructuring/aliasing from `process.env`, optional chaining such as `process?.env` or `process.env?.NAME`, nonliteral computed access outside a declared finite helper/pattern, and shadowed `process` identifiers all fail. It also validates unique names, exact count, allowed classification enums, existing source lines containing the stated reference, exact registry/inventory UX agreement, and the rule that class 2/3 entries have UX `hidden`. An intentional environment read change updates code, JSON, registry/precedence documentation, and this lock test in one commit.

The future settings-boundary module allowlist is exact: `src/settings/bootstrap.js`, `src/settings/registry.js`, `src/settings/resolver.js`, `src/settings/schemas.js`, `src/settings/store.js`, `src/settings/routes.js`, `src/settings/audio.js`, and `src/settings/class2-migration.js`. Any other `src/settings/*.js` file fails the boundary test until this contract is amended. Only `bootstrap.js` may read `process.env`, snapshot launch environment, or parse `.env`; it hands immutable typed values to every consumer. Only `bootstrap.js` and `class2-migration.js` may name class 2 environment variables/deny paths in production settings code, and migration consumes the snapshot rather than reading environment directly. `docs/settings-env-inventory.json` is the machine-readable name exception. Tests may set/delete environment variables in fixtures, but no settings store, route, registry, schema, profile, cache, provider, pipeline, wake-calibration, or import/export module is allowlisted for direct reads.

For every editable main-registry entry with an environment alias, **every** `file:line` listed in that alias's `directReferences[].references` inventory entry is a required resolver-migration site. The Fish Audio cache/model locations are examples, not the limit; implementation is incomplete while any listed runtime site still reads `process.env` instead of injected resolver output.

The dynamic Slack compatibility key is derived only when the normalized uppercase agent ID matches `^[A-Z0-9_-]+$`; the resulting environment name must match `^[A-Z0-9_-]+_SLACK_BOT_TOKEN$`. Priority is: meaningful per-agent launch/seed token, then the four-tier resolved singular `slack_bot_token` (`SLACK_BOT_TOKEN` launch → config → `.env` seed → unset). Invalid IDs do not trigger a bracket lookup.

## 6. Admin HTTP API, schemas, and localhost boundary

The single existing server continues to listen on port 5005 (or its existing port override). The admin plane is:

| Method and path | Request | Success |
|---|---|---|
| `GET /api/settings` | none | `SettingsEnvelope` below |
| `PUT /api/settings` | `SettingsMutation` below | `SettingsEnvelope` with new revision |
| `GET /api/settings/export` | none | `ExportDocument` in §8 as attachment |
| `POST /api/settings/import` | `ImportRequest` below | `SettingsEnvelope` plus `import` report |
| `POST /api/settings/connections/:provider/test` | `{revision}` where provider is `soniox|deepgram|fish-audio|attendee|slack` | `{ok, provider, code, message, durationMs}` |
| `POST /api/settings/migrate-env-class1` | `{revision}` | `{imported:[fieldId], skipped:[fieldId], revision}` |
| `POST /api/settings/tts-preview` | `{revision,text}` | buffered `audio/wav` per §9 |
| `POST /api/settings/audio` | multipart contract in §9 | `{clip,revision}`, never a filesystem absolute path |
| `DELETE /api/settings/audio/:id` | `{revision}` | `{deleted:true, revision}` |

Every JSON object is strict: the listed keys are required unless marked optional and unknown keys fail with `422`. `Revision` is exactly `^[a-f0-9]{64}$`, the SHA-256 digest of the last parsed whole-config bytes. All ID and value types below are generated from `SETTINGS_REGISTRY` plus the fixed diagnostic table; `StrictSubset<K,V>` means a strict partial object whose only possible keys are `K`. No extension diagnostic, unknown config key, class 2/3 name, class 2/3 value, or deny-path name may enter a settings map.

```ts
type EditableSettingId = RegistryIdWhere<{ writeSurface: "settings" }>;
type CredentialFieldId = RegistryIdWhere<{ credential: "class-1" }>;
type StoreFieldId = EditableSettingId | "audio_clips";
type EffectiveFieldId = EditableSettingId;
type MainDiagnosticId = "server_port" | "resolved_home";
type ExtensionDiagnosticId = DiagnosticTableId; // exactly the 57 IDs in §1
type DiagnosticId = MainDiagnosticId | ExtensionDiagnosticId;
type WritableFieldId = EditableSettingId;
type ImportableFieldId = RegistryIdWhere<{
  writeSurface: "settings";
  credential: "none";
}>;
type RestartRequiredFieldId = RegistryIdWhere<{
  writeSurface: "settings";
  apply: "restart-required";
}>;
type StrictSubset<K extends string, M extends { [P in K]: unknown }> = {
  [P in K]?: M[P]; // runtime schema is .strict(); keys outside K are rejected
};

type CredentialView = { state: "set" | "unset" | "overridden"; value: "••••••••" | "" };
type StoreValue<K extends StoreFieldId> =
  K extends CredentialFieldId ? CredentialView :
  K extends "audio_clips" ? ClipView[] : RegistryOutput<K>;
type EffectiveValue<K extends EffectiveFieldId> =
  K extends CredentialFieldId ? CredentialView : RegistryOutput<K>;
type MutationValue<K extends WritableFieldId> =
  K extends CredentialFieldId ? "••••••••" | NonEmptySecretString | null : RegistryInput<K>;
type DiagnosticValue<K extends DiagnosticId> =
  K extends "server_port" ? number :
  K extends "resolved_home" ? AbsolutePathString : DiagnosticTableOutput<K>;
type EffectiveSource<K extends EffectiveFieldId> =
  RegistryEnvAlias<K> extends string ? "os-env" | "config" | ".env-seed" | "default" | "unset"
                                     : "config" | "default" | "unset";
type DiagnosticSource<K extends DiagnosticId> =
  K extends MainDiagnosticId ? "runtime" : "os-env" | ".env-seed" | "default";

type CommonIssueCode = "VALUE_REQUIRED" | "VALUE_INVALID" | "PROVIDER_DEPENDENCY_REQUIRED";
type IssueCodeFor<K extends EditableSettingId> =
  K extends "agent_id" ? CommonIssueCode | "CONFIG_DOCUMENT_INVALID" | "AGENT_ID_RECONCILIATION_REQUIRED" :
  K extends "llm_provider" ? CommonIssueCode | "LLM_CONNECTION_ENV_REQUIRED" | "LEGACY_CONNECTION_CONFIG_PRESENT" :
  CommonIssueCode;
type SettingsIssue = { [K in EditableSettingId]: {
  fieldId: K;
  code: IssueCodeFor<K>;
} }[EditableSettingId];

type SettingsEnvelope = {
  schemaVersion: 1;
  revision: Revision;
  setupMode: boolean;
  fields: StrictSubset<StoreFieldId, { [K in StoreFieldId]: StoreValue<K> }>;
  effective: StrictSubset<EffectiveFieldId, { [K in EffectiveFieldId]: EffectiveValue<K> }>;
  sources: StrictSubset<EffectiveFieldId, { [K in EffectiveFieldId]: EffectiveSource<K> }>;
  restartRequired: RestartRequiredFieldId[];      // sorted and unique
  issues: SettingsIssue[];
  diagnostics: StrictSubset<DiagnosticId, { [K in DiagnosticId]: {
    value: DiagnosticValue<K>;
    source: DiagnosticSource<K>;
  } }>;
};
type SettingsMutation = {
  schemaVersion: 1;
  revision: Revision;
  fields: { [K in WritableFieldId]?: MutationValue<K> };
};
type ImportRequest = {
  revision: Revision;
  document: ExportDocument;
};
type ImportSuccess = SettingsEnvelope & {
  import: { imported: ImportableFieldId[]; skipped: ImportableFieldId[] };
};
type ConnectionCode = "CONNECTED" | "NOT_CONFIGURED" | "AUTH_FAILED" | "UNREACHABLE" |
                      "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_ERROR";
```

Strict mutation/import request examples are:

```json
{"schemaVersion":1,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fields":{"agent_language":"ja","server_ngrok_domain":"meetmate.example"}}
```

```json
{"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","document":{"format":"meetmate-settings","version":1,"exportedAt":"2026-08-25T00:00:00.000Z","settings":{"agent_language":"ja","server_ngrok_domain":"meetmate.example"}}}
```

Example GET/PUT success (ellipses here mean additional registry-derived keys; literal ellipses are not valid JSON):

```json
{"schemaVersion":1,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","setupMode":false,"fields":{"agent_language":"ja","fish_audio_api_key":{"state":"set","value":"••••••••"}},"effective":{"agent_language":"ja","fish_audio_api_key":{"state":"set","value":"••••••••"}},"sources":{"agent_language":"config","fish_audio_api_key":"config"},"restartRequired":[],"issues":[],"diagnostics":{"barge_in_min_chars":{"value":2,"source":"default"}}}
```

`fields` may contain only stored `StoreFieldId` values and therefore never contains synthetic `resolved_home` or read-only runtime `server_port`. `effective` and `sources` use only `EffectiveFieldId`; their present key sets must match each other, but need not match `fields`. `restartRequired` contains only editable registry IDs whose `apply` is `restart-required`; every non-null-by-construction `issues[].fieldId` is an editable registry ID. `diagnostics` contains only the two noneditable main diagnostics plus the 57 extension IDs, displays current noncredential values only, and is never accepted by a mutation/import. The normal GET includes all available safe projections even though the strict subset types permit setup-mode omission. Stale PUT/import/migrate/audio/delete requests return `409 SETTINGS_REVISION_CONFLICT`. The store rechecks the same revision at precommit (§2), so validation-time freshness is insufficient.

The remaining strict request/response schemas and examples are:

```json
{"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

This is the complete request for connection test, class-1 migration, and DELETE. Connection-test success is exactly `{"ok":true,"provider":"soniox","code":"CONNECTED","message":"Connection succeeded","durationMs":123}`; failure uses the same five fields with `ok:false`, a finite `ConnectionCode`, and a value-free message. Class-1 migration success is exactly `{"imported":["soniox_api_key"],"skipped":["fish_audio_api_key"],"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`. DELETE success is exactly `{"deleted":true,"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`.

Literal import success example:

```json
{"schemaVersion":1,"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","setupMode":false,"fields":{"agent_language":"ja"},"effective":{"agent_language":"ja"},"sources":{"agent_language":"config"},"restartRequired":["agent_language"],"issues":[],"diagnostics":{"server_port":{"value":5005,"source":"runtime"}},"import":{"imported":["agent_language"],"skipped":[]}}
```

Connection tests use the effective class 1 credential already held by the resolver, perform one minimal vendor-specific authenticated request with a five-second timeout, never persist or echo response bodies, and cannot test class 2 or class 3 connections. The five provider literals are the complete endpoint enum. Soniox and Fish Audio are the Epic's core readiness path; Deepgram, Attendee, and Slack tests are additive compatibility/integration checks and do not widen core scope.

The localhost guard applies **only** to `/api/settings`, `/api/settings/*`, the settings page `/settings`, and its exact UI asset allowlist under `/settings-assets/`. It requires all of: the accepted socket local address is loopback; `Host` is exactly `localhost`, `127.0.0.1`, or `[::1]` with the listener's actual port; and no `Forwarded` or `X-Forwarded-*` header is present. Requests arriving through ngrok fail these checks and receive `404`, not an authentication hint. The existing dashboard at `/`, its existing assets, `/health`, `/calibrate*`, `/agents`, join/leave/session APIs, meeting WebSocket/data-plane paths, and all other existing APIs retain their current routing and tunnel reachability; they must not be placed behind this guard. Existing API payloads and behavior also remain unchanged, except `/health` may add only the backward-compatible §7 fields `setupMode`, `meetingReady`, and `settingsIssues`. No CORS headers are emitted by the settings plane.

Every mutating admin request additionally requires `Content-Type` for its schema, `Origin` exactly equal to `http://localhost:<actual-port>` or the corresponding numeric-loopback origin, and `Sec-Fetch-Site` of `same-origin` when the header is present. Missing or `null` Origin is rejected. JSON request bodies are limited to 256 KiB before parsing; connection-test bodies to 4 KiB; audio uses §9's streaming cap. Keep-alive bodies are drained or the connection is closed after rejection.

All settings-plane errors use the one strict JSON shape:

```json
{"error":{"code":"SETTINGS_VALIDATION_FAILED","message":"Request validation failed","details":[{"path":"fields.llm_temperature","code":"too_big"}],"requestId":"opaque-id"}}
```

`details` is optional; when present it is an array of strict `{path:string,code:string}` objects. Messages/details never contain submitted values, secrets, vendor response bodies, absolute home paths, or stack traces. Status mapping is `400` malformed JSON, `403` same-origin failure, `404` nonlocal/admin route concealment, `409` revision or version conflict, `413` body too large, `415` media type, `422` schema/semantic validation, `429` connection-test rate limit, `500` transactional store failure, `503` unsupported multi-process access, and `504` preview timeout.

## 7. Setup mode and meeting-start validation

An absent, empty-object, invalid, unmigrated, or incomplete config activates setup mode; it does not terminate the process. The dashboard, admin API, import/export where possible, migration guidance, connection tests for configured class 1 fields, and `/health` remain available. The existing `/health` response stays backward compatible; additive `setupMode` and `meetingReady` are booleans and `settingsIssues` is exactly `SettingsIssue[]`. Every issue has a non-null editable registry `fieldId`: document-level invalid JSON maps to `agent_id` + `CONFIG_DOCUMENT_INVALID`; missing environment-only LLM connection maps to `llm_provider` + `LLM_CONNECTION_ENV_REQUIRED`; legacy connection config maps to `llm_provider` + `LEGACY_CONNECTION_CONFIG_PRESENT`; identity mismatch maps to `agent_id` + `AGENT_ID_RECONCILIATION_REQUIRED`. No issue contains class 2/3 names, deny paths, submitted values, or environment aliases.

Meeting join/start is the validation boundary. It returns `503` with `MEETING_SETUP_REQUIRED` until the active provider combination has meaningful requirements: agent id/display name and wake word; selected STT class 1 key; Fish Audio class 1 API key and voice id; Attendee class 1 key; plus a valid environment-only agent/LLM connection. Slack is required only when Slack notifications are enabled. Missing connection state uses the `llm_provider` issue mapping above, never class 2 names. Invalid config JSON reports the mapped `agent_id` setup issue and retains the last valid snapshot if one exists. No setup path calls `process.exit(1)`.

The current `src/server.js:bootstrap` fatal `AGENT_ID` mismatch is replaced by setup reconciliation: meaningful launch `AGENT_ID` still wins under §3, but when it differs from meaningful `agent.id` the server remains up, emits value-free `AGENT_ID_RECONCILIATION_REQUIRED`, blocks meeting start, and lets the operator align or remove one source in the settings guidance. Neither value is printed. Saving an unrelated field does not silently reconcile identity.

## 8. Masking, import/export, templates, and `.env` class-1 migration

Class 1 GET fields have shape `{state:"set"|"unset"|"overridden", value:"••••••••"|""}`. PUT accepts the exact mask `"••••••••"` to preserve, a non-empty replacement to set, and `null` to clear; empty string is rejected so clearing is deliberate. The mask is a protocol constant and can never be stored. Class 2/3 have no DTO representation.

Export is `Content-Type: application/json` with the strict `ExportDocument` schema:

```json
{"format":"meetmate-settings","version":1,"exportedAt":"ISO-8601","settings":{"agent_display_name":"…"}}
```

The four top-level keys are required and no others are accepted; `format` is the literal `meetmate-settings`, `version` is the literal integer `1`, `exportedAt` is a UTC RFC 3339 timestamp, and `settings` is a strict object of writable, noncredential `basic|detail` registry IDs. It excludes `audio_clips`, all credentials in classes 1, 2, and 3, deployment diagnostics, effective/source diagnostics, revisions, absolute paths, and unknown whole-config keys. Template presets use the same secret-free shape and may contain only documented nonsecret settings; they never carry blank-looking credential presets or dummy secrets.

Import accepts version 1 strictly and has no version-0 migrator. Negative, noninteger, zero, unknown-format, or future versions return `409 SETTINGS_IMPORT_VERSION_UNSUPPORTED`. Unknown setting IDs in a recognized version return `422` rather than being ignored. Import merges validated allowlisted values into the whole config, so unknown existing config keys remain preserved. Success adds exactly `"import":{"imported":[ImportableFieldId],"skipped":[ImportableFieldId]}` to `SettingsEnvelope`; both arrays are sorted/unique and all other envelope fields retain §6's schema.

`POST /api/settings/migrate-env-class1` never opens `.env`. It consumes only the source-tagged `.env` seed snapshot captured by the startup bootstrap, copies meaningful class 1 values into canonical config paths whose current stored value is not meaningful, then saves transactionally. It does not overwrite a meaningful store value and never migrates class 2/3. The snapshot originates at `<resolved-home>/.env`; resolved home is pre-dotenv `AI_MEET_HOME` when present and current working directory otherwise. The response reports field IDs only. A restart is required before the new store tier becomes the runtime source. Success UI/guidance says: “Migrated legacy `.env` vendor values; those legacy lines are no longer needed.” Meetmate never edits or deletes `.env`; the operator removes legacy class-1 lines manually after verifying restart.

Post-implementation template shapes are locked:

- `config.json.example` and `meetmate init` output contain the canonical main-registry config paths, including class 1 paths, and contain none of the persistent class 2 deny paths. `gateway` may retain nonsecret `warmupTimeoutMs`/`displayName`; `llm.openaiCompatible` may retain nonsecret `baseUrl`, `emptyResponseRetry`, and `trustedAgentTools`, but no `apiKey` member.
- `.env.example` and generated `.env` retain class 2/3 variables plus deployment-readonly/legacy seed aliases, but the new example does not present class 1 vendor keys as the normal configuration surface. Existing class-1 `.env` values remain accepted only as §3 seeds and explicit migration inputs.
- `src/agents-template.md` / generated `AGENTS.md` name configuration keys and file locations only. They say class 1 values belong in `config.json` via the localhost settings UI, class 2/3 values remain environment-only, and legacy class-1 `.env` lines may be removed only by the operator after migration. They never include values, `KEY=value` assignments, or instructions to print/read secrets.

Template tests parse both examples, assert the deny paths are absent, seed distinct sentinels into both storage classes, generate `AGENTS.md`, and prove no sentinel or `KEY=value` line leaks. Tests also assert config example keys are either registry paths, documented unknown-preservation examples, or the fixed nonsecret prompt/message namespaces; `.env.example` names must exist in the environment inventory or the explicit class 2/3 set.

## 9. MP3 ingest, home ownership, and cache compatibility

User audio lives only under `<resolved-home>/assets/settings-audio/`; bundled package assets remain read-only and are never overwritten, renamed, or deleted. The only metadata store is the existing `config.json`, under registry-owned `audio.clips[]`. Each strict record has every field below and no others:

```json
{"id":"550e8400-e29b-41d4-a716-446655440000","role":"ack","text":"[soft voice] 了解です。","sourceRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.mp3","pcmRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.pcm","sourceSha256":"64 lowercase hex","pcmSha256":"64 lowercase hex","cacheKey":"64 lowercase hex","referenceId":"voice-id-or-null","model":"s2-pro","sampleRate":24000,"speed":1,"durationMs":1200,"sourceBytes":12345,"pcmBytes":57600,"createdAt":"UTC RFC 3339"}
```

`role` is one of `ack|progress|greeting|farewell|timeout`; both paths are server-generated, relative to resolved home, and must resolve beneath the managed directory. `referenceId` is a trimmed string or `null`; `model` is a nonempty trimmed string; `sampleRate`/`speed` satisfy the registry; sizes/duration are nonnegative integers. API/GET clip views add the required computed booleans `stale` and `playable`; these two members are never persisted.

`POST /api/settings/audio` is one multipart request containing exactly one `audio` file part (`audio/mpeg`, filename ending `.mp3`) and exactly one UTF-8 JSON `metadata` field with strict `{role,text,revision}`. `text` is trimmed, 1–4096 UTF-8 characters; `revision` is §6's `Revision`; no reference/model/rate/speed input is trusted from the client because those values come from the current effective TTS registry snapshot. Limit: 10 MiB source, 30 seconds decoded audio, 32 clips, and 128 MiB total managed source+PCM. Stream to a mode-`0600` random temporary file while hashing; reject another file, NUL, traversal, symlink targets, non-MP3 extension, invalid ID3/MPEG frame signature, or schema/cap violations. Never use the client filename.

Ingest reuses the repository's existing `FFMPEG || "ffmpeg"` convention and adds no npm dependency. Before the config commit, run the resolved executable with an argument array (never a shell): `-nostdin -v error -i <temp.mp3> -f s16le -ac 1 -ar <effective tts.sampleRate> <temp.pcm>`. Missing ffmpeg, nonzero exit, timeout, stderr failure, odd PCM byte length, or decoded-duration overflow rejects the request and removes temporaries. The owned outputs are `<uuid>.mp3` and `<uuid>.pcm`, both mode `0600`; PCM is mono signed 16-bit little-endian at the recorded sample rate, exactly the format `src/tts-cache.js` streams. Final-file renames and the revision-checked config transaction are one rollback unit: no `audio.clips` record may point at a missing file, and failed config commit removes newly installed files.

`cacheKey` is computed by the canonical `tts-cache` key function, or a shared equivalent over exactly `{text,referenceId,model,sampleRate,speed}`; latency and API key remain excluded as today. On every read and before playback, recompute it from current settings. A mismatch marks the clip `stale` in the GET metadata and prevents automatic use; it is never silently played for different text/voice/model/rate/speed.

Runtime lookup is only for an exact `role` plus current `cacheKey`. If multiple valid clips match, choose newest `createdAt`, then lexically smallest `id` as a deterministic tie-break. Stale metadata, missing file, symlink/out-of-root path, hash mismatch, invalid PCM, read error, or playback error falls back to the existing Fish Audio synthesis path without deleting the record. Deletion `lstat`s both paths, resolves/realpaths beneath the managed directory, refuses symlinks/out-of-root targets, updates config transactionally, then unlinks only the two owned files; cleanup failure is reported without deleting unrelated files.

Audio-upload success is exactly:

```json
{"clip":{"id":"550e8400-e29b-41d4-a716-446655440000","role":"ack","text":"[soft voice] 了解です。","sourceRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.mp3","pcmRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.pcm","sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pcmSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cacheKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","referenceId":null,"model":"s2-pro","sampleRate":24000,"speed":1,"durationMs":1200,"sourceBytes":12345,"pcmBytes":57600,"createdAt":"2026-08-25T00:00:00.000Z","stale":false,"playable":true},"revision":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

### TTS preview

`POST /api/settings/tts-preview` accepts only `{"revision":Revision,"text":string}`; normalized text is 1–500 UTF-8 characters. It uses the current effective Fish Audio class-1 credential, voice, model, sample rate, speed, and latency. This is the operator's own vendor key and account: the UI states that preview requests incur the operator's Fish Audio usage/billing; Meetmate supplies no platform key or subsidy.

One 30-second wall-clock `AbortController` covers all retries and synthesis. The server buffers the complete result, rejects output beyond 15 seconds or `effectiveSampleRate * 2 * 15 + 44` bytes, wraps mono PCM S16LE in a WAV header, and only then sends `200 Content-Type: audio/wav`, `Content-Length`, and `Cache-Control: no-store`; partial audio is never returned. Timeout aborts upstream and returns `504 SETTINGS_PREVIEW_TIMEOUT`. The endpoint does not save config/cache/audio metadata. Logs and metrics contain only request ID, duration, byte count, and stable outcome code—never preview text, credential, authorization header, request/response body, vendor body, or audio bytes.

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

The current duplicate tag prose at the default `voiceEmotionLine` near line 6 and `gatewayBriefingSystem` near line 71 must both call composition helpers backed by `EMOTION_TAGS`; neither site may retain a handwritten tag list. The settings UI reads the same exported data for help text. Issue #30 exposes exactly one `agent_emotion_tags` ON/OFF toggle and the fixed five-tag read-only help list above—no add, edit, remove, reorder, or arbitrary tag input. Per the owner decision on 2026-08-25, custom-list editing is deferred until Fish Audio compatibility verification; after that evidence exists, a **follow-up Issue** under Epic v4 must define validation and editing behavior. No custom-list work belongs to this contract.

## 11. Stable task-extraction and streaming-equivalent feature flags

The two stable registry/API/DOM identifiers are `task_extraction_enabled` and `streaming_equivalent_enabled`, with canonical paths `features.taskExtractionEnabled` and `features.streamingEquivalentEnabled`. Both are strict booleans and default to `true`, preserving the currently enabled behavior. They have no environment aliases.

These are functional feature flags, not labels. Task extraction is pinned to `src/transport-meet/meet-routes.js:handleMeetSessionEnd` → `src/summarizer.js:summarizeConversation`: when false, summary and decisions remain enabled but the task/TODO prompt and extraction branch is bypassed and `todos` is `[]`; when true, current task extraction remains. Streaming-equivalent is pinned to `src/llm-openai.js:streamChat`: when false, only the OpenAI-compatible streaming-equivalent adapter is bypassed (the provider's nonstreaming completion is adapted as one complete chunk), while OpenClaw streaming and all other pipeline behavior remain unchanged. Runtime configuration must pass each resolved boolean into those symbols. Tests toggle each independently and observe the named branch while proving the other behavior is unchanged. Rendering or persisting either flag without runtime wiring fails the contract.

## 12. Static boundary, inventory, and sentinel leak tests

The implementation gate includes deterministic static scans over `src/`, `bin/`, `public/`, examples, and tests:

- only the exact eight `src/settings/*.js` paths enumerated in §5 may exist; only `src/settings/bootstrap.js` may contain `dotenv.config`, open `envPath()`, read the resolved-home `.env`, or directly read `process.env`; every other production module fails the scan if it does;
- class 2/3 names and class 2 deny paths must not occur in public UI assets, settings registry, Zod schemas, GET/PUT/export/import/health schema fixtures, presets, or OpenAPI-like descriptions; `src/settings/bootstrap.js`, `src/settings/class2-migration.js`, value-free server guidance, `docs/settings-env-inventory.json`, `.env.example`, and generated instance guidance are the only name-only exceptions;
- admin route modules may not contain `process.exit`, assign `process.exitCode`, interpolate request bodies into logs/errors, use Zod `.passthrough()`, or spread/assign unprojected request objects into config;
- the exact 89-name inventory and all dot/bracket/dynamic references pass §5's syntax-consuming lock test, including `FISH_AUDIO_MODEL` in `tts-cache`;
- every extension row has no config path, is absent from PUT/import/export schemas, is deployment-readonly in inventory/UI, and its runtime site consumes resolver output;
- registry and inventory UX deep-compare for every alias; the four named alignments in §3 and every other row are locked;
- the 13 checked-in sentinels are tested for exact case-sensitive rejection after normalization, while near-miss real values remain meaningful and numeric-string equality is canonical;
- `src/messages.js` contains each canonical emotion tag literal only in `EMOTION_TAGS`, and both prompt outputs contain the composed list;
- settings paths/assets are unreachable with ngrok/forwarded headers and nonlocal Host/Origin combinations, while `/`, its assets, `/health`, `/calibrate*`, `/agents`, join/session APIs, and meeting WebSocket regression fixtures remain unchanged and reachable as before;
- store/wake-calibration race, stale revision, symlink, mode `0600`, rollback, and live second-process cases exercise §2; audio tests exercise ffmpeg missing/failure, PCM format/rate, deterministic duplicate selection, stale/missing fallback, and owned-pair deletion;
- strict success/error fixtures cover every §6 endpoint and reject unknown keys, wrong revision placement, class 2/3 projection, version 0, and incomplete audio metadata; preview tests prove WAV format, the single 30-second budget, the 15-second cap, no partial response, user-key selection, and value-free logs;
- post-class-2 config/.env/AGENTS template shapes and sentinel leak tests in §8 pass.

Sentinel integration tests use distinct high-entropy values for every credential in classes 1, 2, and 3. Class 1 sentinels may appear only in the mode-`0600` whole-config store and the in-memory provider call selected by the test; they must not appear in HTML, GET, errors, logs, connection-test responses, export, presets, generated `AGENTS.md`, or imported output. Class 2 sentinels may appear only in the test environment and intended provider call and must not remain in `config.json` after save/migration. Class 3 sentinels deliberately seeded under unknown config keys remain preserved internally, but must be ignored by runtime resolution and never appear in any admin projection, export, error, log, template, or generated file; actual class 3 runtime values come only from the environment.

## 13. Singular agent boundary and reserved expansion

This contract keeps the existing singular `agent` object. The settings registry, DTO, UI, migration, export, validation, and runtime must not introduce, infer, or synthesize an `agents` array. A top-level `agents` key is reserved for a future separately approved multi-agent contract: whole-config preservation may retain an already-existing unknown `agents` value, but the settings plane cannot expose, mutate, import, export, validate, or consume it. No singular-to-array migration is part of Issue #30.
