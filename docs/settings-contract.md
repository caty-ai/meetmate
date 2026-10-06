# Settings, admin-plane, and migration contract (Epic #29 child #30)

Version: **v1.3.0**

Changelog: hub cloud group + class-1 `hub_token`/`room_salt`, four cloud admin routes, and non-transferable shared/hosted hub state — owner approved via PR #195 labels on 2026-09-05.

Status: **approved baseline — CP#1 owner approval recorded 2026-08-29 ([#29 comment](https://github.com/caty-ai/meetmate/issues/29#issuecomment-5460738835)); v1.3.0 amendment approved via PR #195 labels on 2026-09-05**. This contract augments the existing Node `http` server and vanilla-JavaScript dashboard on `localhost:5005`. It does not authorize another application, UI framework, persistence store, or port. `config.json` in the resolved home remains the only settings store. The settings UI, admin API, import/export, connection tests, TTS preview, and audio ingest form one allowlisted admin plane; meeting transport remains a separate data plane.

The credential classes used below are fixed:

- **Class 1 — external Meetmate vendors:** `SONIOX_API_KEY`, `DEEPGRAM_API_KEY`, `FISH_AUDIO_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_COMPATIBLE_TTS_API_KEY`, `ATTENDEE_API_KEY`, `SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `HUB_TOKEN`, and the hosted hub `room_salt`. These are masked after entry or provisioning, persisted only at their allowlisted `config.json` paths, and omitted from exports. The OpenAI-compatible TTS key is optional for non-OpenAI base URLs, but remains class 1 when configured.
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
  apply: "restart-required" | "live" | "next-join";
  envAlias: string | null;
  defaultValue?: unknown;
  requiredWhen?:
    | { always: true }
    | { transport: Array<"meet" | "zoom" | "discord"> }
    | { setting: string; equals: unknown; explicit?: true };
  writeSurface: "settings" | "audio-only" | "none";
  transferable: boolean;
};
```

`apply` is `restart-required` unless the table explicitly says `live` or `next-join`. `next-join` is saved immediately and captured when a new meeting starts. `writeSurface` defaults to `settings` for `basic|detail`; every `deployment-readonly` entry is `none`, and `audio_clips` is `audio-only`. `transferable` defaults to `true`; `false` means the setting is never exported or imported. `hidden` is reserved for registry fields that are conditionally irrelevant in the UI; it does not permit class 2 or class 3. Deployment-readonly values may be returned for diagnosis but PUT/import must reject changes to them. Credential values use `z.string().trim().min(1).max(4096)` and the masked round trip in §8.

`requiredWhen` is the closed meeting-start predicate vocabulary. `{always:true}` is unconditional. `{transport:[...]}` uses a non-empty list of canonical server-derived session transports; an absent or unknown join transport evaluates every transport predicate as required. `{setting,equals}` compares the resolved registry value, and `explicit:true` additionally requires that setting's source to be neither `default` nor `unset`. A join re-evaluates these predicates for its server-derived transport. The context-free `/health.meetingReady` retains the Attendee-plane requirements and includes the Discord transport requirement only when Discord is configured by a meaningful `discord.botToken` or a non-empty `discord.guildAllowlist`. Resolver-owned dynamic Slack-token and OpenAI-compatible TTS hostname exceptions remain outside this vocabulary. A third resolver-owned exception (#260): an entry of the Attendee slot that `bot_host` does not select is never reported missing — the cloud slot is `attendee_base_url`, `attendee_api_key` and `face_timeline_offset_ms`, the self-hosted slot is `attendee_self_hosted_url`, `attendee_self_hosted_api_key` and `face_timeline_offset_ms_self_hosted`, and an absent `bot_host` selects the cloud slot. Discord joins are never gated on Attendee entries; Meet/Zoom joins are gated on the selected slot only.

The compact type glossary is normative. `url` means an absolute URL whose scheme is exactly `http:` or `https:` and whose username, password, fragment, and surrounding whitespace are absent. `url-or-empty` is either the exact empty string or a `url`; whitespace-only is not empty. `hostname` is one DNS hostname with no scheme, userinfo, path, query, fragment, or port. `hostname-or-empty` is either the exact empty string or a `hostname`; schemes, userinfo/credentials, paths, queries, fragments, and ports are rejected. `https-origin-or-empty` is either the exact empty string or a `https:` URL with no userinfo, query, or fragment, whose parsed path is `/`; its scheme must be spelled lowercase `https://`, its port (if any) is 1–5 digits without a leading zero, and no path segment at all may be written (not even `/.` or `/foo/..`). Explicit `:443`, mixed-case hosts, IDN hosts, and bracketed IPv6 hosts are accepted as written. `ws-url` analogously requires an absolute `ws:` or `wss:` URL. `wss-url` requires only `wss:`, and `wss-url-or-empty` is the exact empty string or a `wss-url`. `attendee-endpoint-or-empty` (#260) is either the exact empty string or an absolute `https:` or `http:` URL of at most 2048 characters with no surrounding whitespace, no username or password (no `@` before the host), no query and no fragment, an optional port 1–65535, and an optional base path; only ASCII letters, digits and `- . _ ~ : / [ ] %` may appear (brackets only around an IPv6 host), so no non-ASCII character, whitespace, control character, backslash, `?`, `#` or `@` — an international host name is entered in its punycode `xn--` form; the written path must be exactly the path the URL parser returns (no `.` or `..` segment, no empty segment `//`, no percent-encoding or other rewrite); one trailing `/` is accepted; the parsed and stored value is one canonical form — lower-case scheme, the host as the URL parser returns it, the port only when it is not the scheme's default, the path without a trailing `/` — which re-parses to itself (`https://host/` is stored as `https://host`, `HTTPS://HOST:443/` as `https://host`, `https://host:8443/base/` as `https://host:8443/base`); with `http:`, an IP-literal host (IPv4-mapped IPv6 unwrapped) must be in the private set P = `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7` (link-local, `0.0.0.0`, `::`, multicast and public addresses are not in P), while an `http:` name, `localhost` included, is accepted syntactically and judged at connect time: every resolved address must be in P and the socket connects to a verified address. The validator never touches the network; P has one implementation, `isPrivateAddress` in `src/attendee-endpoint.js`. `header-token-or-empty` is either the exact empty string or an RFC 7230 header token containing 1–128 ASCII token characters; the case-insensitive reserved names `Authorization`, `Proxy-Authorization`, `Content-Length`, `Content-Type`, `Host`, `Connection`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Expect`, `Keep-Alive`, and `X-Caty-Agent-Trust` are rejected. `absolute-path` is a platform-absolute filesystem path after parsing and normalization; a relative path, URL, or empty string is invalid, and API errors must not echo the path. A type suffix `-or-null` means the base validator or the literal JSON `null`, with no implicit empty-string-to-null coercion. Arrays are unique, trimmed strings with at most 64 entries and 128 UTF-8 characters per entry; free text is at most 16 KiB; regex patterns are at most 2 KiB and flags match `^(?!.*(.).*\1)[dimsuvy]*$` before compilation. Unknown object keys are rejected by the strict DTO schema.

The allowlist below is complete. The compact type notation is directly translatable to Zod (`str(n)`, `text(n)`, `bool`, `int(min,max)`, `num(min,max)`, `url`, `enum(...)`, `str[]`). Entries marked `live` are the only exceptions to restart-required apply.

| ID | Config path | Type/default | UX | Credential | Apply | Env alias | Transferable |
|---|---|---|---|---|---|---|---|
| `agent_id` | `agent.id` | `str(128)` | basic | none | restart-required | `AGENT_ID` | default |
| `agent_name` | `agent.name` | `str(128)` | basic | none | restart-required | none | default |
| `agent_display_name` | `agent.displayName` | `str(128)` | basic | none | restart-required | none | default |
| `agent_language` | `agent.language` | `enum(ja,en)` / `ja` | basic | none | restart-required | `AGENT_LANG` | default |
| `agent_greeting` | `agent.greeting` | `text(4096)` | basic | none | live | none | default |
| `agent_emotion_tags` | `agent.emotionTags` | `bool` / `true` | basic | none | live | none | default |
| `agent_wake_words` | `agent.wakeWords` | `str[]` | basic | none | restart-required | `WAKE_WORDS` | default |
| `agent_reply_trigger` | `agent.replyTrigger` | `enum(wake,jev)` / `wake` | basic | none | live | none | default |
| `agent_reply_judge_addressed_min` | `agent.replyJudge.addressedMin` | `num(0,1)` / `0.75` | hidden | none | live | none | default |
| `agent_reply_judge_finished_min` | `agent.replyJudge.finishedMin` | `num(0,1)` / `0.75` | hidden | none | live | none | default |
| `agent_reply_judge_continuation_wait_ms` | `agent.replyJudge.continuationWaitMs` | `int(0,10000)` / `3000` | hidden | none | live | none | default |
| `agent_reply_judge_timeout_ms` | `agent.replyJudge.timeoutMs` | `int(50,5000)` / `800` | hidden | none | live | none | default |
| `agent_reply_judge_context_lines` | `agent.replyJudge.contextLines` | `int(0,20)` / `6` | hidden | none | live | none | default |
| `agent_keyterms` | `agent.keyterms` | `str[]` | detail | none | restart-required | `SONIOX_CONTEXT_TERMS` | default |
| `agent_stt_wake_variants` | `agent.sttWakeVariants` | `str[]` | detail | none | restart-required | none | default |
| `agent_ack_variants` | `agent.ackVariants` | `str[]` | detail | none | live | none | default |
| `agent_progress_pings` | `agent.progressPings` | `str[]` | detail | none | live | none | default |
| `agent_exit_farewell` | `agent.exitFarewell` | `text(4096)` | detail | none | live | none | default |
| `agent_cancel_ack` | `agent.cancelAck` | `text(4096)` | detail | none | live | none | default |
| `agent_timeout_fallback` | `agent.timeoutFallback` | `text(4096)` | detail | none | live | none | default |
| `agent_avatar_url` | `agent.avatarUrl` | `url-or-empty` | detail | none | restart-required | `BOT_IMAGE_URL` | default |
| `avatar_experiment` | `avatar.experiment` | `enum(,hybrid-local-l0,hybrid-local-frames,face-package)` / empty | basic | none | live | none | default |
| `face_package_dir` | `avatar.facePackageDir` | absolute path | deployment-readonly | none | restart-required | none | false |
| `emotion_judge` | `avatar.emotionJudge` | enum(off,tags,jev) / `off` | detail | none | live | none | default |
| `face_listen_reactions` | `avatar.faceListenReactions` | bool / `false` | detail | none | next-join | none | default |
| `face_timeline_offset_ms` | `avatar.faceTimelineOffsetMs` | `int(-3000,3000)` / `300` | detail | none | next-join | none | default |
| `face_audio_default` | `avatar.faceAudioDefault` | `enum(,page)` / empty | detail | none | next-join | none | default |
| `face_timeline_offset_ms_self_hosted` | `avatar.faceTimelineOffsetMsSelfHosted` | `int(-3000,3000)` / `300` | detail | none | next-join | none | default |
| `avatar_rig_background_mode` | `avatar.rigBackgroundMode` | `enum(solid,image,chroma)` / `solid` | basic | none | live | none | default |
| `avatar_rig_background_color` | `avatar.rigBackgroundColor` | `hex-color` / `#08111f` | basic | none | live | none | default |
| `llm_provider` | `llm.provider` | `enum(openclaw,openai-compatible)` / `openclaw` | basic | none | restart-required | `LLM_PROVIDER` | default |
| `llm_model` | `llm.model` | `str(256)` | basic | none | restart-required | none | default |
| `llm_temperature` | `llm.temperature` | `num(0,2)` / `0.5` | detail | none | restart-required | `AGENT_TEMPERATURE` | default |
| `llm_max_tokens` | `llm.maxTokens` | `int(1,32768)` / `300` | detail | none | restart-required | `AGENT_MAX_TOKENS` | default |
| `llm_history_max_turns` | `llm.historyMaxTurns` | `int(0,256)` / `12` | detail | none | restart-required | none | default |
| `llm_system_prompt` | `llm.systemPrompt` | `text(16384)` / empty | detail | none | restart-required | none | default |
| `openai_base_url` | `llm.openaiCompatible.baseUrl` | `url-or-empty` | detail | none | restart-required | `OPENAI_COMPATIBLE_BASE_URL` | default |
| `openai_empty_response_retry` | `llm.openaiCompatible.emptyResponseRetry` | `bool` / `true` | detail | none | restart-required | none | default |
| `openai_trusted_agent_tools` | `llm.openaiCompatible.trustedAgentTools` | `bool` / `false` | detail | none | restart-required | none | default |
| `openai_session_header` | `llm.openaiCompatible.sessionHeader` | `header-token-or-empty` / empty | detail | none | restart-required | none | default |
| `soniox_api_key` | `stt.sonioxApiKey` | `secret` | basic | class-1 | restart-required | `SONIOX_API_KEY` | default |
| `deepgram_api_key` | `stt.apiKey` | `secret` | basic | class-1 | restart-required | `DEEPGRAM_API_KEY` | default |
| `stt_provider` | `stt.provider` | `enum(soniox,deepgram)` / `soniox` | basic | none | restart-required | `STT_PROVIDER` | default |
| `soniox_model` | `stt.soniox.model` | `str(128)` / `stt-rt-v5` | detail | none | restart-required | `SONIOX_MODEL` | default |
| `soniox_ws_url` | `stt.soniox.wsUrl` | `wss-url` | detail | none | restart-required | `SONIOX_WS_URL` | default |
| `soniox_endpoint_sensitivity` | `stt.soniox.endpointSensitivity` | `num(-1,1)-or-null` | detail | none | restart-required | `SONIOX_ENDPOINT_SENSITIVITY` | default |
| `soniox_max_endpoint_delay_ms` | `stt.soniox.maxEndpointDelayMs` | `int(0,30000)-or-null` | detail | none | restart-required | `SONIOX_MAX_ENDPOINT_DELAY_MS` | default |
| `soniox_endpoint_latency_level` | `stt.soniox.endpointLatencyLevel` | `int(0,5)-or-null` | detail | none | restart-required | `SONIOX_ENDPOINT_LATENCY_LEVEL` | default |
| `listen_endpointing_ms` | `stt.endpointingMs` | `int(0,30000)` / `400` | detail | none | restart-required | `LISTEN_ENDPOINTING_MS` | default |
| `listen_utterance_end_ms` | `stt.utteranceEndMs` | `int(0,30000)` / `1200` | detail | none | restart-required | `LISTEN_UTTERANCE_END_MS` | default |
| `fish_audio_api_key` | `tts.apiKey` | `secret` | basic | class-1 | restart-required | `FISH_AUDIO_API_KEY` | default |
| `fish_audio_voice_id` | `tts.voiceId` | `str(256)` | basic | none | restart-required | `FISH_AUDIO_VOICE_ID` | default |
| `tts_provider` | `tts.provider` | `enum(fish-audio,elevenlabs,openai-compatible)` / `fish-audio` | basic | none | restart-required | `TTS_PROVIDER` | default |
| `fish_audio_model` | `tts.model` | `str(128)` / `s2-pro` | detail | none | restart-required | `FISH_AUDIO_MODEL` | default |
| `fish_audio_speed` | `tts.speed` | `num(0.5,2)` / `1` | detail | none | restart-required | `FISH_AUDIO_SPEED` | default |
| `fish_audio_latency` | `tts.latency` | `enum(normal,balanced,low)` / `balanced` | detail | none | restart-required | `FISH_AUDIO_LATENCY` | default |
| `elevenlabs_api_key` | `tts.elevenlabs.apiKey` | `secret` | basic | class-1 | restart-required | `ELEVENLABS_API_KEY` | default |
| `elevenlabs_voice_id` | `tts.elevenlabs.voiceId` | `str(256)` | basic | none | restart-required | `ELEVENLABS_VOICE_ID` | default |
| `elevenlabs_model` | `tts.elevenlabs.model` | `str(128)` / `eleven_multilingual_v2` | detail | none | restart-required | `ELEVENLABS_MODEL` | default |
| `openai_compatible_tts_api_key` | `tts.openaiCompatibleTts.apiKey` | `secret` | basic | class-1 | restart-required | `OPENAI_COMPATIBLE_TTS_API_KEY` | default |
| `openai_compatible_tts_base_url` | `tts.openaiCompatibleTts.baseUrl` | `url` / `https://api.openai.com` | basic | none | restart-required | `OPENAI_COMPATIBLE_TTS_BASE_URL` | default |
| `openai_compatible_tts_model` | `tts.openaiCompatibleTts.model` | `str(128)` / `gpt-4o-mini-tts` | detail | none | restart-required | `OPENAI_COMPATIBLE_TTS_MODEL` | default |
| `openai_compatible_tts_voice` | `tts.openaiCompatibleTts.voice` | `str(128)` / `alloy` | detail | none | restart-required | `OPENAI_COMPATIBLE_TTS_VOICE` | default |
| `openai_compatible_tts_source_sample_rate` | `tts.openaiCompatibleTts.sourceSampleRate` | `int(8000,96000)` / `24000` | detail | none | restart-required | `OPENAI_COMPATIBLE_TTS_SOURCE_SAMPLE_RATE` | default |
| `tts_sample_rate` | `tts.sampleRate` | `int(8000,96000)` / `24000` | detail | none | restart-required | `TTS_SAMPLE_RATE` | default |
| `tts_cache_enabled` | `tts.cache.enabled` | `bool` / `true` | detail | none | restart-required | `TTS_CACHE_ENABLED` | default |
| `tts_cache_prewarm` | `tts.cache.prewarm` | `bool` / `true` | detail | none | restart-required | `TTS_CACHE_PREWARM` | default |
| `attendee_api_key` | `attendee.apiKey` | `secret` | basic | class-1 | restart-required | `ATTENDEE_API_KEY` | default |
| `attendee_base_url` | `attendee.baseUrl` | `hostname` / `app.attendee.dev` | detail | none | restart-required | `ATTENDEE_API_BASE_URL` | default |
| `bot_host` | `attendee.host` | `enum(attendee-cloud,attendee-self-hosted)` / `attendee-cloud` | basic | none | next-join | none | false |
| `attendee_self_hosted_url` | `attendee.selfHosted.url` | `attendee-endpoint-or-empty` / empty | basic | none | next-join | none | false |
| `attendee_self_hosted_api_key` | `attendee.selfHosted.apiKey` | `secret` | basic | class-1 | next-join | none | default |
| `slack_bot_token` | `slack.botToken` | `secret` | basic | class-1 | restart-required | `SLACK_BOT_TOKEN` | default |
| `slack_notifications_enabled` | `slack.notifications.enabled` | `bool` / `true` | basic | none | restart-required | `SLACK_NOTIFY_ENABLED` | default |
| `slack_notifications_target` | `slack.notifications.target` | `enum(dm,channel)` / `dm` | basic | none | restart-required | none | default |
| `slack_dm_user_id` | `slack.notifications.dmUserId` | `str(128)` | detail | none | restart-required | none | default |
| `slack_notify_channel` | `slack.notifyChannel` | `str(128)` | detail | none | restart-required | `SLACK_NOTIFY_CHANNEL` | default |
| `slack_summary_channel` | `slack.summaryChannel` | `str(128)` | detail | none | restart-required | `SLACK_SUMMARY_CHANNEL` | default |
| `slack_status_channel` | `slack.statusChannel` | `str(128)` | detail | none | restart-required | `SLACK_STATUS_CHANNEL` | default |
| `discord_bot_token` | `discord.botToken` | `secret` | basic | class-1 | restart-required | `DISCORD_BOT_TOKEN` | default |
| `discord_guild_allowlist` | `discord.guildAllowlist` | `str[]` (unique, ≤64, each `^[0-9]{17,20}$`) / `[]` | basic | none | restart-required | none | default |
| `discord_lcm_ingest_enabled` | `discord.lcmIngestEnabled` | `bool` / `false` | basic | none | restart-required | none | default |
| `hub_cloud_url` | `hub.cloudUrl` | `url` | basic | none | restart-required | `CATY_CLOUD_URL` | default |
| `hub_token` | `hub.token` | `secret` | hidden | class-1 | restart-required | `HUB_TOKEN` | default |
| `hub_installation_id` | `hub.installationId` | `str(256)` | hidden | none | restart-required | none | false |
| `hub_cloud_hub_url` | `hub.cloudHubUrl` | `ws-url` | hidden | none | restart-required | none | false |
| `hub_url` | `hub.url` | `ws-url` | hidden | none | restart-required | `HUB_URL` | false |
| `hub_room_salt` | `hub.roomSalt` | `secret` | hidden | class-1 | restart-required | none | default |
| `hub_room_salt_version` | `hub.roomSaltVersion` | `str(128)` | hidden | none | restart-required | none | false |
| `hub_plan_id` | `hub.planId` | `str(128)` | hidden | none | restart-required | none | false |
| `hub_expires_at` | `hub.expiresAt` | `iso-datetime` | hidden | none | restart-required | none | false |
| `hub_config_refreshed_at` | `hub.configRefreshedAt` | `iso-datetime` | hidden | none | restart-required | none | false |
| `summary_enabled` | `summary.enabled` | `bool` / `true` | basic | none | restart-required | `SUMMARY_ENABLED` | default |
| `gateway_warmup_timeout_ms` | `gateway.warmupTimeoutMs` | `int(0,120000)` / `8000` | detail | none | restart-required | `GATEWAY_WARMUP_TIMEOUT_MS` | default |
| `gateway_display_name` | `gateway.displayName` | `str(128)` / `AI MeetServer` | detail | none | restart-required | none | default |
| `server_port` | `server.port` | `int(1,65535)` / `5005` | deployment-readonly | none | restart-required | `PORT` | default |
| `server_ngrok_domain` | `server.ngrokDomain` | `hostname-or-empty` / empty | detail | none | restart-required | none | default |
| `public_origin` | `server.publicOrigin` | `https-origin-or-empty` / empty | detail | none | restart-required | `PUBLIC_ORIGIN` | default |
| `settings_remote_access` | `server.remoteSettingsAccess` | `bool` / `false` | detail | none | live | none | false |
| `settings_remote_login` | `server.remoteSettingsLogin` | `text(254)` / empty | detail | none | live | none | false |
| `resolved_home` | synthetic | absolute path | deployment-readonly | none | restart-required | `AI_MEET_HOME` | default |
| `task_extraction_enabled` | `features.taskExtractionEnabled` | `bool` / `true` | detail | none | restart-required | none | default |
| `streaming_equivalent_enabled` | `features.streamingEquivalentEnabled` | `bool` / `true` | detail | none | restart-required | none | default |
| `audio_clips` | `audio.clips` | `clip-record[]` / `[]` | detail | none | live | none | default |

The registry contains exactly 104 rows. `attendee.selfHosted.apiKey` (`attendee_self_hosted_api_key`) is a class-1 credential with every class-1 rule of §8 (masked GET, `MASK` keeps / `null` clears, chmod 600 store, export exclusion); it has no environment alias. `hub.url`, `hub.roomCode`, and `hub.sharedToken` belong to shared mode. Hosted setup writes the returned `hub_url` only to `hub.cloudHubUrl`; a cloud connect/disconnect round trip never changes the shared-mode fields. `hub.configRefreshAfterSeconds` is server-owned cache metadata rather than a user setting: it is absent from the registry and every admin DTO, and is committed atomically with `hub.configRefreshedAt` and the last-good hosted configuration.

Conditional visibility is registry metadata, not schema omission: provider-specific STT and TTS fields are hidden in the rendered form unless their provider is selected. Required-at-meeting-start checks use `requiredWhen`; the dynamic Slack-token and OpenAI-compatible TTS hostname escapes remain resolver-owned as specified above. The Slack token's `requiredWhen` only emits the `slack_bot_token` setup issue — Slack is filtered out of the join gate (see the `meetingIssues` split in the join/start section). `OPENAI_COMPATIBLE_TTS_API_KEY` is required when the selected base URL host is `api.openai.com`; it may be omitted only for a non-OpenAI base URL such as a local server. Provider-aware setup validation accepts any registry-valid Fish Audio sample rate, ElevenLabs PCM rates 8000/16000/22050/24000/44100, and only 24000 for OpenAI-compatible TTS. These fields remain in the DTO allowlist. No class 2 or class 3 name or path may occur in the registry or generated Zod source.

`audio_clips.writeSurface` is `audio-only`; it is projected into GET for the clip manager but rejected by PUT/import/export. `resolved_home.writeSurface` is `none`. `server_ngrok_domain` is an editable detail setting: PUT/import persist `server.ngrokDomain`, its apply state is restart-required, and its `hostname-or-empty` validator rejects a scheme, path, port, credentials/userinfo, query, or fragment.

**Public origin resolution:** Both `resolveLocalAvatarPublicOrigin` (local-avatar launch) and `resolvePublicOrigin` (readiness `tunnel` probe) resolve `public_origin` (resolved via §3: pre-dotenv `PUBLIC_ORIGIN` OS env → store → `PUBLIC_ORIGIN` `.env` seed → default) → `server_ngrok_domain` (`https://<domain>`) → the `PUBLIC_WSS_URL` env-exclusive diagnostic (`wss://`→`https://`, backward compatibility only) → ngrok autodetect (port 4040). `server_ngrok_domain` stays hostname-only. Tunnel `NOT_CONFIGURED`/`MISMATCH` issues attribute to `public_origin` when it is set, else `server_ngrok_domain`. ngrok autodetect accepts only an https tunnel whose `config.addr` targets this server's listen port on a loopback host (`localhost`, `127.0.0.1` or `::1`); a tunnel that forwards anywhere else, or reports no `config.addr`, is ignored, so an operator whose tunnel is not recognised sets `server_ngrok_domain` or `public_origin`. `GET /info` resolves `publicWsUrl` as `public_origin` (an `https:` value becomes `wss://<host>`, read from the same snapshot as `resolveLocalAvatarPublicOrigin`) → a request `Host` containing `ngrok` → the boot-time ngrok detection (a configured `server_ngrok_domain`, else that autodetect) → `PUBLIC_WSS_URL`, else empty.

`avatar_rig_background_mode` と `avatar_rig_background_color` は共有フィールドであり、2.5Dリグ・フレームセット・フェイスパッケージのアバター背景に適用される。`image` は「設定画面でアップロードした背景画像（§9A）→ なければ、または読み込めなければ各ページのローカル生成物へ埋め込まれた画像 → なければ `avatar_rig_background_color`」の順で使う。フェイスパッケージでは meetmate のホストページが画像を描き、`background-transparent` を宣言したパッケージにだけ `transparent` を送る（`docs/face-packages.md`）。`image` でアップロードが無い間は readiness に `AVATAR_BACKGROUND_IMAGE_MISSING` の notice が出る（ブロッカーではない）。

The following exhaustive extension table covers every remaining noncredential direct environment read in `docs/settings-env-inventory.json` and all 13 finite dynamic helper keys. These are **not** settings-registry entries: every row is `deployment-readonly`, has no canonical config path, is absent from PUT/import/export, and appears only as a value-safe current diagnostic in the detail UI. Resolution is meaningful pre-dotenv launch environment, then meaningful resolved-home `.env`, then the existing code default; the config tier in §3 does not apply. These 59 env-exclusive diagnostics are outside the editable resolver-migration duty in §5. Their inventoried current direct reads, including env-exclusive reads in `src/pipeline.js`, may remain because bootstrap's non-overriding dotenv load makes `process.env` produce the same typed result as that three-tier diagnostic resolver. This exception does not turn a diagnostic into a setting and does not apply to any alias owned by an editable `writeSurface:"settings"` registry entry. `pos-int` means an integer at least 1, `nn-int`/`nn-num` mean a nonnegative integer/number, and `ms` means `int(0,3600000)`.

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
| `local_avatar_envelope_enabled` | `bool` (`off` disables) | `LOCAL_AVATAR_ENVELOPE` |
| `local_avatar_envelope_slack_ms` | `nn-num` / `2000` | `LOCAL_AVATAR_ENVELOPE_SLACK_MS` |
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

The store algorithm is: acquire the one-process settings lock; read and parse the whole object and its bytes; deep-clone it; remove every class 2 deny path below; apply only validated registry values by canonical path; preserve every other unknown key byte-for-value at the JSON value level; write a same-directory unpredictable temporary file with mode `0600`; fsync it; **while still holding the lock, re-read the committed file and compare its SHA-256 to the request revision immediately before rename**; atomic-rename; fsync the directory where supported; re-read and validate; then atomically publish the parsed in-memory snapshot under §3 and release the lock. A successful response must not become observable before that publish. Arrays replace as units. Omitted DTO fields preserve existing values. Explicit `null` is accepted only where the field schema permits it.

There is one setup-recovery revision exception. When `config.json` is absent or its bytes cannot be parsed as JSON, GET reports the literal revision `"bootstrap"`; an empty but parseable object has its normal SHA-256 revision. Only `PUT /api/settings` and `POST /api/settings/migrate-env-class1` may accept `"bootstrap"`, and only while the file is still absent or parse-invalid at both validation and precommit. All other endpoints require a 64-hex SHA-256 revision and reject `"bootstrap"`. A bootstrap PUT/migration constructs a new valid whole document from its validated allowlisted input and registry defaults/seeds; parse-invalid bytes cannot supply preserved unknown keys, but remain protected by the transactional backup/rollback rules in §4. The request retains an internal fingerprint of the absent/invalid state and fails with `409 SETTINGS_REVISION_CONFLICT` if that state changes before rename. After the first successful recovery commit, the response and all subsequent GETs use the committed bytes' SHA-256 revision and normal revision checks; `"bootstrap"` can never be persisted or accepted again while the file is parseable.

Issue #30 supports one Meetmate process per resolved home. If another live process owns or races the lock, the request fails without retry or write as `503 SETTINGS_MULTI_PROCESS_UNSUPPORTED`; last-writer-wins is forbidden. A stale lock whose recorded PID is provably absent may be cleaned up, but an unverifiable owner is treated as live. This is an explicit unsupported topology, not an optimistic-concurrency feature.

The class 2 deny paths are `gateway.url`, `gateway.token`, `llm.openaiCompatible.apiKey`, `agent.gatewayUrl`, `agent.gatewayToken`, and `agent.openaiCompatible.apiKey`, plus the same three agent-level names beneath any legacy per-agent container and the `gatewayUrl`, `gatewayToken`, or `openaiCompatible.apiKey` members of per-session `overrides`. Runtime reads from all these config/profile/override locations are disabled; only the startup environment snapshot may supply class 2 values. Persistent deny paths are stripped during migration and every successful save even though they are not DTO fields. Class 2 values must not be copied into `AgentProfile`, session profiles, debug DTOs, or structured logs. Class 3 has no supported config path. Class 3-shaped legacy/unknown keys are preserved with other unknown configuration, but are ignored by runtime resolution and never projected. `_comments` and all other unknown configuration remain preserved.

DTO projection and whole-config persistence must be separate functions. `JSON.parse(req.body)` must never be merged directly, and Zod `.passthrough()` is forbidden on admin DTOs. Prototype-polluting keys (`__proto__`, `prototype`, `constructor`) are rejected at every depth. The existing wake-calibration save path must call this same locked, revision-checked, class-2-stripping, atomic-`0600` store; its current independent lock/tmp writer is not an exception. `/calibrate/status` supplies the current revision to the bundled page; `/calibrate/apply` sends strict `{variants,revision}`, rejects stale revision, and returns `{ok:true,added,total,revision}` after the shared store commits. It never writes `.bak`, `.tmp`, or `config.json` independently.

## 3. Four-tier precedence and measured dotenv behavior

For every editable main-registry field with `writeSurface:"settings"` and an environment alias, effective resolution is exactly:

1. meaningful OS/shell environment captured before dotenv at process startup;
2. meaningful value in the resolved-home `config.json` store;
3. meaningful value loaded from the resolved-home `.env` as an init/legacy seed;
4. code default.

The startup path alone captures `preDotenvEnv = { ...process.env }`, resolves home from `preDotenvEnv.AI_MEET_HOME || process.cwd()`, parses `.env` once without overriding the process launch environment, and passes immutable source-tagged snapshots to config resolution. Stores, route handlers, Zod modules, exporters, importers, tests, and registry modules must never open `envPath()` or `.env`. New executable entrypoints must call the same startup bootstrap before importing runtime consumers. Every current direct-read site for an editable registry entry with `writeSurface:"settings"`, including cache-key generation and any such site in `src/pipeline.js`, receives resolver output. The separately inventoried 59 env-exclusive diagnostics may retain equivalent direct reads under §§1 and 5; this Epic does not require a blanket `src/pipeline.js` environment-read rewrite.

Noneditable main entries are separate from that rule. `server_port` is a deployment-readonly diagnostic of the actual bound port, not a PUT/import field; `resolved_home` is the absolute home pinned from meaningful pre-dotenv `AI_MEET_HOME`, otherwise launch cwd, and a `.env` `AI_MEET_HOME` line or config can never affect it; `audio_clips` is stored and changed only through the audio endpoints. None of these three is promised editable four-tier behavior or an override badge.

Current behavior measured on 2026-08-25:

- `src/server.js` imports `envPath()`, calls `dotenv.config({ path: envPath() })`, then imports config and providers. Dotenv's default non-override behavior leaves shell values first and supplies missing direct `process.env` reads from the resolved-home `.env`. `src/paths.js` has already pinned home before dotenv.
- `bin/ai-meet.js` itself never loads dotenv. Under the frozen `docs/cli-contract.md`, `init` may read and write the resolved-home `.env`: it reads `.env.example` and, only for an existing file, parses the `LLM_PROVIDER=` line manually. This wizard-only file access is not runtime settings resolution and is the scanner exception in §§5 and 12. `start` reaches dotenv indirectly by requiring `src/server.js`. `mcp` bypasses `src/server.js` and therefore bypasses dotenv.
- `src/mcp/server.js`, both when executed directly and through `meetmate mcp`, reads only inherited `process.env`; it does not load the resolved-home `.env`. Its current `AI_MEET_BASE_URL`, `AI_MEET_JOIN_TOKEN`, and `AI_MEET_JOIN_TIMEOUT_MS` behavior is therefore inconsistent with `start`.

The implementation judgment is to route both `start` and `mcp` through the central startup bootstrap; direct library imports remain side-effect free. This makes the four tiers consistent without allowing handlers to reread a mutable file.

`normalize(value)` trims strings; typed numeric fields then parse a finite base-10 numeric string and compare its canonical numeric value (so `"1"`, `"1.0"`, and numeric `1` are equal), while booleans/enums use their registry parser and all other strings compare exactly after trimming. `meaningful(value)` is false only for `undefined`, `null`, a normalized empty string, an exact generic placeholder matching `^\$\{[A-Z][A-Z0-9_]*\}$`, or one of these 14 exact, case-sensitive checked-in sentinels after normalization: `your_gateway_token_here`, `your_deepgram_key`, `your_soniox_key`, `your_attendee_key`, `your_fish_audio_key`, `your_voice_id`, `your_slack_bot_token`, `your_discord_bot_token`, `your-model-id`, `your_openai_compatible_key`, `your-agent-id`, `YourAgent`, `your-agent`, and `エージェント名`. No substring or case-insensitive fuzzy matching is allowed. A rejected sentinel is treated as unset and never masks a lower tier. It is not an error until a meeting-start requirement needs it.

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

### Runtime state and snapshot-publish model

At bootstrap, the resolver computes a typed `bootOperationalSnapshot` from the four tiers above. That snapshot is the current process's running value for every `restart-required` editable field and is immutable for the lifetime of the process. `SettingsEnvelope.effective` means **the values this process is using now**, not a preview of values after restart: restart-required entries come from `bootOperationalSnapshot`, while `live` and `next-join` entries are read from the latest atomically published snapshot. A `next-join` consumer captures that value at meeting creation; active meetings retain their captured value. A successful publish therefore makes a live edit observable to all subsequent reads and operations without rereading `config.json` and without restarting.

The store owns one immutable `publishedSnapshot`. After rename, fsync, re-read, and validation succeed, it swaps that snapshot in memory before returning success. The same publish invalidates every module-level cache derived from editable settings, explicitly including `resolveAgentProfile._cached` and equivalent profile/provider/message caches, so the next access derives live values from the new snapshot. Consumers must neither reread the file nor retain a reference to a superseded mutable object. On transaction failure, neither `publishedSnapshot` nor any cache generation changes.

For each editable registry entry `r`, let `running(r)` be its current process value as defined above and let `nextBootEffective(r)` be the value the resolver would produce for `r` at the next boot: the full four-tier resolution of §3 (pre-dotenv OS/shell snapshot of the current process, then the newly committed store, then the `.env` seed, then the code default). `nextBootEffective` is a prediction of the post-restart running value, so a missing/nonmeaningful stored value falls through to the lower tiers exactly as the resolver would at boot — it is never compared as a bare `UNSET`. Equality uses §3's typed normalization and compares unmasked credential values internally. The response is calculated at publish time as:

```text
effective[r] = r.apply != "restart-required" ? publishedSnapshot.resolved[r]
                                  : bootOperationalSnapshot[r]
restartRequired = sort(unique({ r.id |
  r.writeSurface == "settings" &&
  r.apply == "restart-required" &&
  nextBootEffective(r) != running(r)
}))
```

Live and next-join entries are excluded from `restartRequired` at publish time even if their stored bytes changed, because their running value changes with the published snapshot. Restart-required entries remain at the boot value until a new process boots; publishing their saved values changes `fields` and `restartRequired`, but not `effective` or its boot-time `sources` entry. After restart, the resolver establishes a new `bootOperationalSnapshot` and recomputes the list against the same nextBootEffective-versus-running formula, which by construction empties the list when no tier input changed across the restart: a config that omits a path (falling through to its default or seed) and an OS launch override that masks a differing stored value both yield `nextBootEffective(r) == running(r)`, so neither produces a permanent restart prompt. The override badge — not `restartRequired` — is what explains that a stored edit is masked by an OS override. Test T12-04 must include the case "publish a restart-required edit, restart, and assert `restartRequired` is empty", plus the negative cases above (omitted path; OS override) asserting the field never enters the list.

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

The baseline has 100 unique direct names. Every entry carries all current `file:line` references plus its registry-aligned UX and credential classification. Computed bracket references are not silently mixed into that count: the 13 finite helper keys and the per-agent Slack-token family are recorded under `dynamicReferences`. Every noncredential extension/helper entry is `deployment-readonly` with `env-only-readonly-diagnostic` handling; class 2/3 and dynamic Slack entries remain `hidden`.

The lock test tokenizes all production JavaScript under `src/` and `bin/`, inventories both `process.env.NAME` and literal/computed `process.env[...]`, and deep-compares every token to the direct or dynamic sets. It rejects unconsumed syntax rather than ignoring it: destructuring/aliasing from `process.env`, optional chaining such as `process?.env` or `process.env?.NAME`, nonliteral computed access outside a declared finite helper/pattern, and shadowed `process` identifiers all fail. It also validates unique names, exact count, allowed classification enums, existing source lines containing the stated reference, exact registry/inventory UX agreement, and the rule that class 2/3 entries have UX `hidden`. Inventory coverage and resolver-migration duty are separate assertions: an inventoried `env-only-readonly-diagnostic` reference is covered but is not a required migration site. An intentional environment read change updates code, JSON, registry/precedence documentation, and this lock test in one commit.

The future settings-boundary module allowlist is exact: `src/settings/bootstrap.js`, `src/settings/registry.js`, `src/settings/resolver.js`, `src/settings/schemas.js`, `src/settings/store.js`, `src/settings/routes.js`, `src/settings/audio.js`, and `src/settings/class2-migration.js`. Any other `src/settings/*.js` file fails the boundary test until this contract is amended. Within that directory, only `bootstrap.js` may read `process.env`, snapshot launch environment, or parse `.env`; it hands immutable typed values to settings consumers. Only `bootstrap.js` and `class2-migration.js` may name class 2 environment variables/deny paths in production settings code, and migration consumes the snapshot rather than reading environment directly. `docs/settings-env-inventory.json` is the machine-readable name exception. Outside `src/settings/`, direct reads are permitted only when the syntax-consuming inventory classifies the exact site as an env-exclusive diagnostic, a class-3 internal control, or the declared dynamic Slack compatibility input; class 2 runtime sites remain bound to the immutable startup snapshot. The frozen `bin/ai-meet.js init` resolved-home `.env` read/write behavior in `docs/cli-contract.md` is the sole production file-I/O exception. Tests may set/delete environment variables in fixtures.

Resolver-migration duty applies exactly to editable main-registry entries with `writeSurface:"settings"`: for every such entry with an environment alias, **every current `file:line`** listed in that alias's `directReferences[].references` inventory entry must consume injected resolver output instead of reading `process.env`. This explicitly includes both `FISH_AUDIO_MODEL` sites, `src/tts-cache.js:50` and `src/tts-fish.js:197`, and every other editable cache/provider/pipeline reference recorded by the inventory. It excludes all 59 `env-only-readonly-diagnostic` rows and their pipeline references; those remain env-exclusive, are behaviorally equal to their diagnostic resolver output, and are outside the Epic's pipeline migration scope. Deployment-readonly and hidden environment-only inputs retain their separately documented security and inventory rules.

The dynamic Slack compatibility key is derived only when the normalized uppercase agent ID matches `^[A-Z0-9_-]+$`; the resulting environment name must match `^[A-Z0-9_-]+_SLACK_BOT_TOKEN$`. Priority is: meaningful per-agent launch/seed token, then the four-tier resolved singular `slack_bot_token` (`SLACK_BOT_TOKEN` launch → config → `.env` seed → unset). Invalid IDs do not trigger a bracket lookup.

## 6. Admin HTTP API, schemas, and localhost boundary

The single existing server continues to listen on port 5005 (or its existing port override). The admin plane is:

| Method and path | Request | Success |
|---|---|---|
| `GET /api/settings` | none | `SettingsEnvelope` below |
| `PUT /api/settings` | `SettingsMutation` below | `SettingsEnvelope` with new revision |
| `GET /api/settings/export` | none | `ExportDocument` in §8 as attachment |
| `POST /api/settings/import` | `ImportRequest` below | `SettingsEnvelope` plus `import` report |
| `POST /api/settings/cloud/connect` | Strict `{revision:Sha256Revision,cloudUrl?:https-url}`; local-admin + same-origin + committed-revision gates; single-flight and one start/second rate limit; local plane only (#288 X2: a remote request answers `403 SETTINGS_REMOTE_LOCAL_ONLY` before anything else) | `{ok:true,authorizeUrl,expiresAt}`; route-specific errors: `400 SETTINGS_CLOUD_URL_INVALID`, `409 SETTINGS_CLOUD_CONNECT_IN_PROGRESS`, `409 SETTINGS_CLOUD_CONNECT_CANCELLED`, `429 SETTINGS_CLOUD_CONNECT_RATE_LIMITED`, `502 SETTINGS_CLOUD_CONNECT_FAILED` |
| `GET /api/settings/cloud/status` | Local-admin gate; no same-origin, revision, or rate-limit gate | Hosted status shape below; stale-refresh failure retains last-good state and does not fail the status response; on the remote plane (#288) the status is returned without the stale refresh |
| `POST /api/settings/cloud/refresh` | Strict `{revision:Sha256Revision}`; local-admin + same-origin + committed-revision gates; no route rate limit | `{ok:true,revision,refreshAfterSeconds}`; route-specific errors: `400 SETTINGS_CLOUD_NOT_CONNECTED`, `502 SETTINGS_CLOUD_REFRESH_FAILED` |
| `POST /api/settings/cloud/disconnect` | Strict `{revision:Sha256Revision,force?:bool}`; local-admin + same-origin + committed-revision gates; no route rate limit | `{ok:true,revision,forced}`; route-specific error: `502 SETTINGS_CLOUD_DISCONNECT_FAILED` unless `force:true` |
| `POST /api/settings/connections/:provider/test` | `{revision}` where provider is `soniox|deepgram|fish-audio|elevenlabs|openai-compatible|attendee|llm|tunnel|slack|discord` (the §6 connection-test provider table) | `{ok, provider, code, message, durationMs}`, or `501 TEST_NOT_IMPLEMENTED` for the not-yet-implemented tier (`slack` only) |
| `POST /api/settings/migrate-env-class1` | `{revision}` | `{imported:[fieldId], skipped:[fieldId], revision}` |
| `POST /api/settings/tts-preview` | `{revision,text}` | buffered `audio/wav` per §9 |
| `POST /api/settings/audio` | multipart contract in §9 | `{clip,revision}`, never a filesystem absolute path |
| `DELETE /api/settings/audio/:id` | `{revision}` | `{deleted:true, revision}` |

Every JSON object is strict: the listed keys are required unless marked optional and unknown keys fail with `422`. `Sha256Revision` is exactly `^[a-f0-9]{64}$`, the SHA-256 digest of the last parsed whole-config bytes, and `Revision` is `Sha256Revision | "bootstrap"` solely for the §2 setup-recovery flow. Import, connection test, TTS preview, audio upload, and audio delete request schemas accept only `Sha256Revision`; PUT and class-1 migration accept `Revision`. All ID and value types below are generated from `SETTINGS_REGISTRY` plus the fixed diagnostic table; `StrictSubset<K,V>` means a strict partial object whose only possible keys are `K`. No extension diagnostic, unknown config key, class 2/3 name, class 2/3 value, or deny-path name may enter a settings map.

```ts
type Sha256Revision = string; // runtime schema: /^[a-f0-9]{64}$/
type BootstrapRevision = "bootstrap";
type Revision = Sha256Revision | BootstrapRevision;
type EditableSettingId = RegistryIdWhere<{ writeSurface: "settings" }>;
type CredentialFieldId = RegistryIdWhere<{ credential: "class-1" }>;
type StoreFieldId = EditableSettingId | "audio_clips";
type EffectiveFieldId = EditableSettingId;
type MainDiagnosticId = "server_port" | "resolved_home";
type ExtensionDiagnosticId = DiagnosticTableId; // exactly the 59 IDs in §1
type DiagnosticId = MainDiagnosticId | ExtensionDiagnosticId;
type WritableFieldId = EditableSettingId;
type ImportableFieldId = RegistryIdWhere<{
  writeSurface: "settings";
  credential: "none";
  transferable: true;
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
  attendeeHostKind: "cloud" | "self-hosted";      // #274/#260; running-server value (stored bot_host, else the URL rule), not a setting or diagnostic
  remoteAccess: {                                  // #288; value-free, attached by the settings handler (not by buildEnvelope)
    enabled: boolean;                              // effective settings_remote_access
    origin: string;                                // the allowed origin when enabled and R2 holds, else ""
    via: "local" | "remote";                       // the plane this response was served on
  };
};
type SettingsMutation = {
  schemaVersion: 1;
  revision: Revision;
  fields: { [K in WritableFieldId]?: MutationValue<K> };
};
type ImportRequest = {
  revision: Sha256Revision;
  document: ExportDocument;
};
type ImportSuccess = SettingsEnvelope & {
  import: { imported: ImportableFieldId[]; skipped: ImportableFieldId[] };
};
type ConnectionCode = "CONNECTED" | "NOT_CONFIGURED" | "AUTH_FAILED" | "PAYMENT_REQUIRED" |
                      "NOT_ENABLED" | "MISMATCH" | "RESTART_REQUIRED" | "UNREACHABLE" |
                      "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_ERROR" | "ALLOWLIST_MISMATCH";
// Exactly the key set of the `connectionResult` message map in `src/settings/routes.js`. Eleven of the
// twelve literals are partitioned into the readiness hard/soft sets (`HARD_CODES` / `SOFT_CODES` in
// `src/settings/readiness.js`) plus `CONNECTED`; `ALLOWLIST_MISMATCH` is emitted only by the `discord`
// connection test (kept verbatim by `probeOne`) and is not a runtime-failure code — `reportRuntimeFailure`
// would record it as `PROVIDER_ERROR`, which cannot occur because `discord` is not a gate system (#132).
// A probe may not emit a code outside this union.
// `RESTART_REQUIRED` is a readiness-blocker code; the manual route forces a fresh probe, so it never
// appears in a connection-test response.
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
{"schemaVersion":1,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","setupMode":false,"fields":{"agent_language":"ja","fish_audio_api_key":{"state":"set","value":"••••••••"}},"effective":{"agent_language":"ja","fish_audio_api_key":{"state":"set","value":"••••••••"}},"sources":{"agent_language":"config","fish_audio_api_key":"config"},"restartRequired":[],"issues":[],"diagnostics":{"barge_in_min_chars":{"value":2,"source":"default"}},"attendeeHostKind":"cloud"}
```

`fields` may contain only stored `StoreFieldId` values and therefore never contains synthetic `resolved_home` or read-only runtime `server_port`. `effective` and `sources` use only `EffectiveFieldId`; their present key sets must match each other, but need not match `fields`. `effective`, `sources`, and `restartRequired` obey §3's running-state formula. `attendeeHostKind` (#274) is the Attendee host kind of the running server (see "Page-audio default" below); it is non-secret, is never accepted by a mutation/import, and appears on every envelope response (GET, PUT success, import success). `remoteAccess` (#288) likewise appears on every envelope response the settings handler emits (GET, PUT success, import success), is value-free (no header value, login or pin), and is never accepted by a mutation/import; it is attached in `src/settings/routes.js`, so `buildEnvelope` stays request-agnostic. Every non-null-by-construction `issues[].fieldId` is an editable registry ID. `diagnostics` contains only the two noneditable main diagnostics plus the 59 extension IDs, displays current noncredential values only, and is never accepted by a mutation/import. The normal GET includes all available safe projections even though the strict subset types permit setup-mode omission. Stale PUT/import/migrate/audio/delete requests return `409 SETTINGS_REVISION_CONFLICT`. The store rechecks the same revision at precommit (§2), so validation-time freshness is insufficient. In absent/parse-invalid setup mode, only PUT and class-1 migration bearing `"bootstrap"` pass this gate; all other operations that require a committed config revision are rejected.

The remaining strict request/response schemas and examples are:

```json
{"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

This is the complete request for connection test, class-1 migration, and DELETE. Connection-test success is exactly `{"ok":true,"provider":"soniox","code":"CONNECTED","message":"Connection succeeded","durationMs":123}`; failure uses the same five fields with `ok:false`, a finite `ConnectionCode`, and a value-free message. Class-1 migration success is exactly `{"imported":["soniox_api_key"],"skipped":["fish_audio_api_key"],"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`. DELETE success is exactly `{"deleted":true,"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`.

The cloud setup action is single-flight and limited to one start per second. While a browser setup is pending, a second `POST /api/settings/cloud/connect` returns `409 SETTINGS_CLOUD_CONNECT_IN_PROGRESS` and never starts another loopback listener. The listener binds only `127.0.0.1`; its redirect is always `http://127.0.0.1:<port>/hub/callback`. Callback errors (`access_denied`, `state_invalid`, `token_invalid`, or `server_error`) render a failure page with a retry instruction, never an apparent success.

`GET /api/settings/cloud/status` returns exactly `{"connected":bool,"plan_id":string|null,"installation_id":string|null,"hub_url":string|null,"room_salt_version":string|null,"expires_at":string|null}` plus optional `config_refreshed_at`. It never returns a token, salt, pending marker, or stored error. Status reads enforce the hub-config cache: `hub.configRefreshedAt` is age-checked against `refresh_after_s` (86,400 seconds when omitted), stale values trigger `GET /v1/hub/config`, and a failed refresh retains the complete last-good configuration while recording the failure in process state.

OAuth completion re-reads the committed revision before its server-owned credential save, so unrelated settings edits during browser authorization do not orphan the installation. Disconnect retains `hub.cloudUrl` and all shared-mode fields, but removes the hosted credential and identity/config cache fields, including `hub.cloudHubUrl`. An operating-system `HUB_TOKEN` override remains active because settings actions never modify the process environment.

Literal import success example:

```json
{"schemaVersion":1,"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","setupMode":false,"fields":{"agent_language":"ja"},"effective":{"agent_language":"ja"},"sources":{"agent_language":"config"},"restartRequired":["agent_language"],"issues":[],"diagnostics":{"server_port":{"value":5005,"source":"runtime"}},"attendeeHostKind":"cloud","import":{"imported":["agent_language"],"skipped":[]}}
```

Connection tests perform one minimal provider-specific request with a five-second timeout and never persist or echo response bodies. Vendor probes (`soniox`, `deepgram`, `fish-audio`, `elevenlabs`, `openai-compatible`, `attendee`, `discord`, and `slack` once implemented) authenticate with the class 1 credential of the latest published settings snapshot held by the resolver (a saved restart-required change is probed before the restart; readiness separately reports `RESTART_REQUIRED`) and cannot test class 2 or class 3 connections; the `attendee` probe targets the slot selected by the published `bot_host` and its request is composed by `src/attendee-endpoint.js` (the injected `fetchFn` replaces dispatch only; `options.endpoints` does not apply to it); the two exceptions are `llm`, which exercises the class-2 agent connection from the immutable startup snapshot (never from the settings store), and `tunnel`, which sends no credential and only checks the public origin's identity. The connection-test provider enum is exactly the `PROVIDERS` set in `src/settings/routes.js` — ten literals as of this revision — and every literal is a route: no provider route may disappear merely because its test is optional. The tiers are:

| Provider literal | Tier | Probe target | Implemented | Origin |
|---|---|---|---|---|
| `soniox` | required (v1 STT gate) | Soniox API with the class-1 key | yes | v1 |
| `fish-audio` | required (v1 TTS gate) | Fish Audio API with the class-1 key | yes | v1 |
| `deepgram` | optional gate — required when `stt_provider` is `deepgram` | Deepgram API with the class-1 key | yes | v1 |
| `elevenlabs` | optional gate — required when `tts_provider` is `elevenlabs` | ElevenLabs API with the class-1 key | yes | #101 |
| `openai-compatible` | optional gate — required when `tts_provider` is `openai-compatible` | OpenAI-compatible TTS base URL with the optional class-1 key | yes | #101 |
| `attendee` | optional gate | the selected slot's endpoint with that slot's class-1 key | yes | v1 |
| `llm` | optional gate | the configured agent/LLM connection (class-2 credentials read from the startup snapshot only, never from the settings store) | yes | #84 |
| `tunnel` | optional gate | the public origin resolved from `public_origin`, else `server_ngrok_domain`, else `PUBLIC_WSS_URL` (backward compatibility), else ngrok autodetect (only a tunnel whose `config.addr` targets this server's listen port on a loopback host; otherwise set `server_ngrok_domain` or `public_origin`), checking that it answers as this instance (`MISMATCH` otherwise) | yes | #84 |
| `slack` | optional, non-gate | Slack API with the class-1 token | no — exact `501 TEST_NOT_IMPLEMENTED` | v1 |
| `discord` | optional, non-gate (excluded from `gateSystems()` by #132; the class-1 bot token is instead a §7 join-time requirement for discord-transport session starts) | Discord API with the class-1 bot token; verifies the bot is a member of at least one allowlisted guild when `discord_guild_allowlist` is non-empty (`ALLOWLIST_MISMATCH` otherwise) | yes | #123 / #132 (EPIC #41) |

"Gate" means the provider is one of the readiness gate systems (`gateSystems()` in `src/settings/readiness.js`: the selected STT provider, the selected TTS provider, `attendee`, `llm`, `tunnel` — `discord` is intentionally not a gate system, #132); a gate provider that is not selected by the current `stt_provider` / `tts_provider` value still keeps its route and its implemented test. Fish Audio, ElevenLabs, OpenAI-compatible, and `llm` probes may incur vendor billing, so background readiness probing skips them unless billing is allowed; the manual route above always allows it. Until a not-yet-implemented test (`slack` only at this revision) is implemented, its route returns `501` with the standard error envelope and code `TEST_NOT_IMPLEMENTED`, without a vendor request and before revision checking. Once an optional test is implemented, it must use the same five-second, value-free contract and may not regress to `501` silently.

Completeness cross-check (docs track code, not the reverse): the provider table above must equal `PROVIDERS`, and the `TEST_NOT_IMPLEMENTED` tier must equal `PROVIDERS ∖ IMPLEMENTED_PROVIDERS`, both in `src/settings/routes.js`; `test/settings-connections-preview-cases.js` is the executable lock (the "only non-gate Slack remains exact 501" case covers `slack` → `501` and `deepgram|attendee|llm|tunnel` → `200`; the ElevenLabs / OpenAI-compatible cases cover the other two). Adding or removing a provider literal or a `ConnectionCode` literal is a contract amendment that updates this section, the route table, the `ConnectionCode` type, and T12-14 in the same change. Amendment applied by the EPIC #41 integration (this revision): the `discord` provider (#123) and the `ALLOWLIST_MISMATCH` code (#132) are appended to the provider table, the route table, the `ConnectionCode` type, and T12-14.

The localhost guard applies **only** to `/api/settings`, `/api/settings/*`, the settings page `/settings`, and its exact UI asset allowlist under `/settings-assets/`. It requires all of: the accepted socket local address is loopback; `Host` is exactly `localhost`, `127.0.0.1`, or `[::1]` with the listener's actual port; and no `Forwarded` or `X-Forwarded-*` header is present. Requests arriving through ngrok fail these checks and receive `404`, not an authentication hint. The existing dashboard at `/`, its existing assets, `/health`, `/calibrate*`, `/agents`, join/leave/session APIs, meeting WebSocket/data-plane paths, and all other existing APIs retain their current routing and tunnel reachability; they must not be placed behind this guard. Existing API payloads and behavior also remain unchanged, except `/health` may add only the backward-compatible §7 fields `setupMode`, `meetingReady`, and `settingsIssues`. No CORS headers are emitted by the settings plane. The only other way in is the opt-in remote plane below (#288); with it switched off, this guard is the whole boundary.

Every mutating admin request additionally requires `Content-Type` for its schema, `Origin` exactly equal to `http://localhost:<actual-port>` or the corresponding numeric-loopback origin, and `Sec-Fetch-Site` of `same-origin` when the header is present. Missing or `null` Origin is rejected. JSON request bodies are limited to 256 KiB before parsing; connection-test bodies to 4 KiB; audio uses §9's streaming cap. Keep-alive bodies are drained or the connection is closed after rejection.

`/settings` and every `/settings-assets/*` response carry `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on both planes (#288).

### Remote settings access through Tailscale Serve (#288)

The rules above describe the **local** plane. `settings_remote_access` (`server.remoteSettingsAccess`, `bool`, default `false`, live, not transferable, no environment alias) adds a second, **remote** plane. `handleSettings` classifies each request once, at its single gate: `local` when the localhost guard above holds (unchanged); otherwise `remote` when every rule R0–R6 below holds; otherwise the `404` above. With the switch `false` or absent, no remote rule runs and every request that is not a local-admin request receives exactly today's bytes (`404`, `text/plain; charset=utf-8`, `Connection: close`, `Not Found`). The classification is handed to every same-origin check and every write path; no route decides the plane again. Turning the switch on, changing `public_origin`, and setting or clearing the login pin are possible only from a local-admin request or by editing `config.json` on the server.

A request is remote only when all of these hold (`isRemoteAdminRequest` in `src/settings/routes.js`; it never throws — any failure, including an unparsable `public_origin` or a malformed header, means "not remote"):

- **R0** — the effective `settings_remote_access` is `true` (read per request, so turning it off applies from the next request).
- **R1** — the socket's local **and** remote addresses are loopback (the proxy runs on the same host).
- **R2** — the effective (running, boot-time for this `restart-required` row) `public_origin` is non-empty and `A = new URL(public_origin)` is `https:` with a hostname ending in `.ts.net`. Normalisation: `A.host` (lower-case host, default `:443` dropped) is the *allowed authority* and `A.origin` the *allowed origin*; these two strings are the only forms compared. A saved but not yet restarted `public_origin` does not move the door.
- **R3** — `Host`, ASCII-lower-cased, equals the allowed authority exactly (a client that writes an explicit `:443` is refused).
- **R4** — `X-Forwarded-Proto` is exactly `https`, `X-Forwarded-Host` (ASCII-lower-cased) equals the allowed authority, and no `Forwarded` header is present.
- **R5** — `Tailscale-User-Login` is present and non-empty. When the login pin `settings_remote_login` (`server.remoteSettingsLogin`, `text(254)` trimmed, default empty, live, not transferable, no environment alias) is non-empty, the login must equal it under ASCII case folding. The login value is never logged or returned.
- **R6** — `X-Forwarded-For` is exactly one IP literal (no list, port, brackets, zone id or whitespace) inside `100.64.0.0/10` or `fd7a:115c:a1e0::/48`; an IPv4-mapped IPv6 literal is unwrapped and judged as IPv4; membership uses `net.BlockList`, never a string prefix.
- `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For` and `Tailscale-User-Login` each occur exactly once in `req.rawHeaders` (counted case-insensitively; header values are read from there). A request without `rawHeaders` is not remote; the local plane never reads `rawHeaders`.

These rules do not authenticate Tailscale Serve: only R1 is a property of the connection, and R2–R6 are trustworthy only because Serve in HTTP mode overwrites those headers and is the only thing forwarding outside traffic to the loopback port. **Precondition of the feature: Tailscale Serve (HTTP mode, tailnet only) must be the only thing forwarding to this port — no Funnel, no other tunnel, reverse proxy or port-forward to the same port.** v1 supports Tailscale Serve only.

Same-origin on the remote plane: every check above that requires a loopback `Origin` instead requires `Origin` to equal the allowed origin exactly, and `Sec-Fetch-Site`, when present, to be `same-origin`; missing or `null` Origin is rejected (`403 SETTINGS_ORIGIN_REJECTED`). A local request can never satisfy the remote origin rule and vice versa. In addition, any remote request to `/api/settings` or `/api/settings/*` (every method) carrying a `Sec-Fetch-Site` other than `same-origin` or `none` is rejected with `403 SETTINGS_ORIGIN_REJECTED` before dispatch; `/settings` and `/settings-assets/*` are exempt. A remote `GET /api/settings/cloud/status` returns the status without the stale refresh, so no remote `GET` writes or calls out. No CORS headers are emitted on either plane.

Everything the local plane can do is allowed remotely, including class-1 credentials (still write-only: masked GET, `MASK` keeps, `null` clears, absent from export) and endpoints, except:

- **X1** — a remote request cannot widen its own door. The check runs on the final field map handed to the store (after `MASK` resolution in PUT; after the import diff): the map is rejected with `403 SETTINGS_REMOTE_FIELD_LOCKED` when it contains `settings_remote_access` with any value other than `false` (re-affirming `true` is rejected), contains `settings_remote_login` at all, or contains `public_origin` with a value not equal to the stored one (absent = empty). A same-value `public_origin` passes, so an export of this instance imports remotely. Turning the switch off remotely is allowed. A remote request whose parsed body carries `revision: "bootstrap"` is rejected with `403 SETTINGS_REMOTE_FIELD_LOCKED` at every parse site that can see it (PUT, `migrate-env-class1`, `cloud/connect`, `cloud/refresh`, `cloud/disconnect`) before the route acts; the `Sha256Revision`-only schemas reject it as `422` as before. Nothing is saved and the revision is unchanged on any of these refusals.
- **X2** — `POST /api/settings/cloud/connect` is local-only: a remote request gets `403 SETTINGS_REMOTE_LOCAL_ONLY` and no listener is opened. `cloud/status`, `cloud/refresh` and `cloud/disconnect` work remotely.

Unchanged on both planes: every body limit, rate limit, revision gate and error shape, and the WebSocket-upgrade refusal for settings paths in `src/server.js`. `public_origin` empty, not a `.ts.net` origin, or changed and restarted to another origin makes R2/R3 fail, so remote requests get `404` until it is fixed locally.

All settings-plane errors use the one strict JSON shape:

```json
{"error":{"code":"SETTINGS_VALIDATION_FAILED","message":"Request validation failed","details":[{"path":"fields.llm_temperature","code":"too_big"}],"requestId":"opaque-id"}}
```

`details` is optional; when present it is an array of strict `{path:string,code:string}` objects. Messages/details never contain submitted values, secrets, vendor response bodies, absolute home paths, or stack traces. Status mapping is `400` malformed JSON, `403` same-origin failure (`SETTINGS_ORIGIN_REJECTED`) and the two remote-plane refusals (`SETTINGS_REMOTE_FIELD_LOCKED`, `SETTINGS_REMOTE_LOCAL_ONLY`, #288), `404` nonlocal/admin route concealment, `409` revision or version conflict, `413` body too large, `415` media type, `422` schema/semantic validation, `429` connection-test rate limit, `500` transactional store failure, `501 TEST_NOT_IMPLEMENTED` for an optional provider test not yet implemented, `503` unsupported multi-process access, and `504` preview timeout.

## 7. Setup mode and meeting-start validation

An absent, empty-object, invalid, unmigrated, or incomplete config activates setup mode; it does not terminate the process. An absent or parse-invalid document uses §2's `"bootstrap"` recovery revision; a parseable empty/incomplete document uses its SHA-256 revision. The dashboard, admin API, import/export where possible, migration guidance, connection tests for configured class 1 fields where a committed revision exists, and `/health` remain available. The existing `/health` response stays backward compatible; additive `setupMode` and `meetingReady` are booleans and `settingsIssues` is exactly `SettingsIssue[]`. Every issue has a non-null editable registry `fieldId`: document-level invalid JSON maps to `agent_id` + `CONFIG_DOCUMENT_INVALID`; missing environment-only LLM connection maps to `llm_provider` + `LLM_CONNECTION_ENV_REQUIRED`; legacy connection config maps to `llm_provider` + `LEGACY_CONNECTION_CONFIG_PRESENT`; identity mismatch maps to `agent_id` + `AGENT_ID_RECONCILIATION_REQUIRED`. No issue contains class 2/3 names, deny paths, submitted values, or environment aliases.

The dashboard readiness payload and readiness recheck responses include an additive `notices: {code, message}[]` (empty when absent). Notices are informational and never affect `ready`, `setupRequired`, `meetingReady`, `blockers`, or `/health settingsIssues`. `AGENTS_KEY_UNSUPPORTED` and `GROUP_GREETING_TEMPLATE_UNSUPPORTED` report the presence of `agents` and `agent.messages.groupGreetingTemplate`, respectively: presence-check on the whole-config document, key names only, value-free. Messages are fixed strings and never include configuration values.

Meeting join/start is the validation boundary. It returns `503` with `MEETING_SETUP_REQUIRED` until the active provider combination has meaningful requirements: agent id/display name and wake word; selected STT class 1 key; the selected TTS provider's class 1 key and voice id (where the provider defines one); for meet/zoom-transport session starts, the selected Attendee slot's class 1 key (and, for the self-hosted slot, its endpoint); for discord-transport session starts, the Discord class 1 bot token; plus a valid environment-only agent/LLM connection. Slack never gates meeting start: a missing Slack token (notifications explicitly enabled from a non-default source) is still reported as a setup issue in `issues` / `setupMode`, but it is excluded from the join gate — `getStatus()` exposes the join-gating subset as `meetingIssues` (every issue whose registry path is not under `slack.`), `meetingReady` is derived from that subset, and the `503 MEETING_SETUP_REQUIRED` body's `error.issues` array (the wire key stays `issues`) carries `meetingIssues` only. The gate runs after join authorization (an invalid join token answers `401` before `503`) and before the duplicate-session and URL checks. The join request's transport is derived server-side from the join route; a join whose transport cannot be determined is validated against every transport's requirements. Missing connection state uses the `llm_provider` issue mapping above, never class 2 names. Invalid config JSON reports the mapped `agent_id` setup issue and retains the last valid snapshot if one exists. No setup path calls `process.exit(1)`.

The current `src/server.js:bootstrap` fatal `AGENT_ID` mismatch is replaced by setup reconciliation: meaningful launch `AGENT_ID` still wins under §3, but when it differs from meaningful `agent.id` the server remains up, emits value-free `AGENT_ID_RECONCILIATION_REQUIRED`, blocks meeting start, and lets the operator align or remove one source in the settings guidance. Neither value is printed. Saving an unrelated field does not silently reconcile identity.

## 8. Masking, import/export, templates, and `.env` class-1 migration

Class 1 GET fields have shape `{state:"set"|"unset"|"overridden", value:"••••••••"|""}`. PUT accepts the exact mask `"••••••••"` to preserve, a non-empty replacement to set, and `null` to clear; empty string is rejected so clearing is deliberate. The mask is a protocol constant and can never be stored. Class 2/3 have no DTO representation.

Export is `Content-Type: application/json` with the strict `ExportDocument` schema:

```json
{"format":"meetmate-settings","version":1,"exportedAt":"ISO-8601","settings":{"agent_display_name":"…"}}
```

The four top-level keys are required and no others are accepted; `format` is the literal `meetmate-settings`, `version` is the literal integer `1`, `exportedAt` is a UTC RFC 3339 timestamp, and `settings` is a strict object of writable, noncredential `basic|detail` registry IDs whose `transferable` metadata is `true`. It excludes `audio_clips`, all credentials in classes 1, 2, and 3, deployment diagnostics, effective/source diagnostics, revisions, absolute paths, unknown whole-config keys, the shared-mode `hub_url`, and the server-owned hosted fields `hub_installation_id`, `hub_cloud_hub_url`, `hub_room_salt_version`, `hub_plan_id`, `hub_expires_at`, and `hub_config_refreshed_at`. The user-entered `hub_cloud_url` is the only transferable `hub.*` setting. Template presets use the same secret-free shape and may contain only documented nonsecret settings; they never carry blank-looking credential presets or dummy secrets.

Import accepts version 1 strictly and has no version-0 migrator. Negative, noninteger, zero, unknown-format, or future versions return `409 SETTINGS_IMPORT_VERSION_UNSUPPORTED`. Unknown setting IDs in a recognized version return `422` rather than being ignored. Import merges validated allowlisted values into the whole config, so unknown existing config keys remain preserved. Success adds exactly `"import":{"imported":[ImportableFieldId],"skipped":[ImportableFieldId]}` to `SettingsEnvelope`; both arrays are sorted/unique and all other envelope fields retain §6's schema.

`POST /api/settings/migrate-env-class1` never opens `.env`. It consumes only the source-tagged `.env` seed snapshot captured by the startup bootstrap, copies meaningful class 1 values into canonical config paths whose current stored value is not meaningful, then saves transactionally. It does not overwrite a meaningful store value and never migrates class 2/3. The snapshot originates at `<resolved-home>/.env`; resolved home is pre-dotenv `AI_MEET_HOME` when present and current working directory otherwise. The response reports field IDs only. A restart is required before the new store tier becomes the runtime source. Success UI/guidance says: “Migrated legacy `.env` vendor values; those legacy lines are no longer needed.” Meetmate never edits or deletes `.env`; the operator removes legacy class-1 lines manually after verifying restart.

Post-implementation template shapes are locked:

- `config.json.example` and `meetmate init` output contain the canonical main-registry config paths, including class 1 paths, and contain none of the persistent class 2 deny paths. `gateway` may retain nonsecret `warmupTimeoutMs`/`displayName`; `llm.openaiCompatible` may retain nonsecret `baseUrl`, `emptyResponseRetry`, `trustedAgentTools`, and `sessionHeader`, but no `apiKey` member.
- `.env.example` and generated `.env` retain class 2/3 variables plus deployment-readonly/legacy seed aliases, but the new example does not present class 1 vendor keys as the normal configuration surface. Existing class-1 `.env` values remain accepted only as §3 seeds and explicit migration inputs.
- `src/agents-template.md` / generated `AGENTS.md` name configuration keys and file locations only. They say class 1 values belong in `config.json` via the localhost settings UI, class 2/3 values remain environment-only, and legacy class-1 `.env` lines may be removed only by the operator after migration. They never include values, `KEY=value` assignments, or instructions to print/read secrets.

Template tests parse both examples, assert the deny paths are absent, seed distinct sentinels into both storage classes, generate `AGENTS.md`, and prove no sentinel or `KEY=value` line leaks. Tests also assert config example keys are either registry paths, documented unknown-preservation examples, or the fixed nonsecret prompt/message namespaces; `.env.example` names must exist in the environment inventory or the explicit class 2/3 set.

## 9. MP3 ingest, home ownership, and cache compatibility

User audio lives only under `<resolved-home>/assets/settings-audio/`; bundled package assets remain read-only and are never overwritten, renamed, or deleted. The only metadata store is the existing `config.json`, under registry-owned `audio.clips[]`. Each strict record has every field below and no others:

```json
{"id":"550e8400-e29b-41d4-a716-446655440000","role":"ack","text":"[soft voice] 了解です。","sourceRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.mp3","pcmRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.pcm","sourceSha256":"64 lowercase hex","pcmSha256":"64 lowercase hex","cacheKey":"64 lowercase hex","referenceId":"voice-id-or-null","model":"s2-pro","sampleRate":24000,"speed":1,"durationMs":1200,"sourceBytes":12345,"pcmBytes":57600,"createdAt":"UTC RFC 3339"}
```

`role` is one of `ack|progress|greeting|farewell|timeout`; both paths are server-generated, relative to resolved home, and must resolve beneath the managed directory. `referenceId` is a trimmed string or `null`; `model` is a nonempty trimmed string; `sampleRate`/`speed` satisfy the registry; sizes/duration are nonnegative integers. API/GET clip views add the required computed booleans `stale` and `playable`; these two members are never persisted.

`POST /api/settings/audio` is one multipart request containing exactly one `audio` file part (`audio/mpeg`, filename ending `.mp3`) and exactly one UTF-8 JSON `metadata` field with strict `{role,text,revision}`. `text` is trimmed, 1–4096 UTF-8 characters; `revision` is §6's `Sha256Revision`; no reference/model/rate/speed input is trusted from the client because those values come from the current effective TTS registry snapshot. Limit: 10 MiB source, 30 seconds decoded audio, 32 clips, and 128 MiB total managed source+PCM. Stream to a mode-`0600` random temporary file while hashing; reject another file, NUL, traversal, symlink targets, non-MP3 extension, invalid ID3/MPEG frame signature, or schema/cap violations. Never use the client filename.

Ingest reuses the repository's existing `FFMPEG || "ffmpeg"` convention and adds no npm dependency. Before the config commit, run the resolved executable with an argument array (never a shell): `-nostdin -v error -i <temp.mp3> -f s16le -ac 1 -ar <effective tts.sampleRate> <temp.pcm>`. Missing ffmpeg, nonzero exit, timeout, stderr failure, odd PCM byte length, or decoded-duration overflow rejects the request and removes temporaries. The owned outputs are `<uuid>.mp3` and `<uuid>.pcm`, both mode `0600`; PCM is mono signed 16-bit little-endian at the recorded sample rate, exactly the format `src/tts-cache.js` streams. Final-file renames and the revision-checked config transaction are one rollback unit: no `audio.clips` record may point at a missing file, and failed config commit removes newly installed files.

`cacheKey` is computed by the canonical `tts-cache` key function, or a shared equivalent over exactly `{text,referenceId,model,sampleRate,speed}`; latency and API key remain excluded as today. On every read and before playback, recompute it from current settings. A mismatch marks the clip `stale` in the GET metadata and prevents automatic use; it is never silently played for different text/voice/model/rate/speed.

Runtime lookup is only for an exact `role` plus current `cacheKey`. If multiple valid clips match, choose newest `createdAt`, then lexically smallest `id` as a deterministic tie-break. Stale metadata, missing file, symlink/out-of-root path, hash mismatch, invalid PCM, read error, or playback error falls back to the existing Fish Audio synthesis path without deleting the record. Deletion `lstat`s both paths, resolves/realpaths beneath the managed directory, refuses symlinks/out-of-root targets, updates config transactionally, then unlinks only the two owned files; cleanup failure is reported without deleting unrelated files.

Audio-upload success is exactly:

```json
{"clip":{"id":"550e8400-e29b-41d4-a716-446655440000","role":"ack","text":"[soft voice] 了解です。","sourceRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.mp3","pcmRelativePath":"assets/settings-audio/550e8400-e29b-41d4-a716-446655440000.pcm","sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pcmSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cacheKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","referenceId":null,"model":"s2-pro","sampleRate":24000,"speed":1,"durationMs":1200,"sourceBytes":12345,"pcmBytes":57600,"createdAt":"2026-08-25T00:00:00.000Z","stale":false,"playable":true},"revision":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

### TTS preview

`POST /api/settings/tts-preview` accepts only `{"revision":Sha256Revision,"text":string}`; normalized text is 1–500 UTF-8 characters. It uses the current effective Fish Audio class-1 credential, voice, model, sample rate, speed, and latency. This is the operator's own vendor key and account: the UI states that preview requests incur the operator's Fish Audio usage/billing; Meetmate supplies no platform key or subsidy.

One 30-second wall-clock `AbortController` covers all retries and synthesis. The server buffers the complete result, rejects output beyond 15 seconds or `effectiveSampleRate * 2 * 15 + 44` bytes, wraps mono PCM S16LE in a WAV header, and only then sends `200 Content-Type: audio/wav`, `Content-Length`, and `Cache-Control: no-store`; partial audio is never returned. Timeout aborts upstream and returns `504 SETTINGS_PREVIEW_TIMEOUT`. The endpoint does not save config/cache/audio metadata. Logs and metrics contain only request ID, duration, byte count, and stable outcome code—never preview text, credential, authorization header, request/response body, vendor body, or audio bytes.

## 9A. Avatar visual assets

Avatar administration remains inside the loopback settings plane. The subrouter has exactly these eight asset routes plus three preview GETs:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings/avatar` | Inspect local static/frame/background/rig state without network access |
| `POST` | `/api/settings/avatar/static` | Upload or replace `assets/avatar.png` |
| `DELETE` | `/api/settings/avatar/static` | Remove the home static image and provenance marker |
| `POST` | `/api/settings/avatar/frames/:name` | Upload or replace one allowlisted frame |
| `DELETE` | `/api/settings/avatar/frames/:name` | Remove one allowlisted frame |
| `DELETE` | `/api/settings/avatar/frames` | Remove all six allowlisted frames |
| `POST` | `/api/settings/avatar/background` | Upload or replace `assets/avatar-background` (#294) |
| `DELETE` | `/api/settings/avatar/background` | Remove the background picture (idempotent) |
| `GET` | `/api/settings/avatar/static/preview` | Read the effective static PNG |
| `GET` | `/api/settings/avatar/frames/:name/preview` | Read one managed frame PNG |
| `GET` | `/api/settings/avatar/background/preview` | Read the background picture (`image/png` or `image/jpeg`) |

Every non-GET beneath `/api/settings/avatar` crosses one structural same-origin check before route dispatch. The three POST routes share their own handler-local rate limiter and never consume connection-test or TTS-preview allowance. Upload is one multipart `image` file part with `image/png` and a `.png` filename; the validated filename is discarded. Destinations are only the server-chosen `assets/avatar.png` or `assets/avatar-frames/<allowlisted-name>.png`. Frame names are exactly `idle|talk1|talk2|talk3|blink|talk_blink`; raw `%`, NUL, slash, backslash, decode errors, and every value outside that set return the same 404 shape.

Static images are capped at 5 MiB, frames at 10 MiB each, and all managed static/frame bytes together at 64 MiB. After staging, validation requires the PNG signature, an `IHDR` chunk at bytes 12–15, positive dimensions no larger than 4096×4096 or 16,777,216 pixels, structurally bounded chunks, and the exact terminal zero-length `IEND` chunk. This is a dimension/shape sanity check, not a full PNG decode. Managed directories are mode `0700`; installed images and `.avatar-source` are mode `0600`; every read/write uses lstat, containment, realpath re-verification, staging rename, and rollback discipline. Bundled package assets are never mutated.

The sidecar `assets/.avatar-source` contains only `uploaded` or `url-cache`. Inspection reports `static.source` as `uploaded`, `url-cache`, or `bundled`; a legacy home file without a marker is `url-cache` when `agent_avatar_url` is configured and `uploaded` otherwise. Preview responses use `Content-Type: image/png`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`; missing and unsafe managed paths share one 404 response. Upload responses include the stored bytes' SHA-256 and asset metadata. Asset mutations have no config revision because the files live outside `config.json` and promotion is atomic.

The meet plane reads the home `avatar.png` afresh on every Join, with the same managed-path checks and a 5 MiB bound, then falls back to the bundled PNG without network access. Boot-time URL fetching is cache-fill only and runs once when the home image is absent. After the download completes it rechecks both the home path and sidecar before writing `url-cache`, so a concurrent settings upload marked `uploaded` cannot be clobbered. Deleting a URL cache uses bundled bytes for subsequent joins in the same process; a later process restart may cache the still-configured URL again.

**Background picture (#294).** The background upload accepts one multipart `image` part declared `image/png` or `image/jpeg` with a `.png`, `.jpg` or `.jpeg` filename (any other declared type is `415 SETTINGS_MEDIA_TYPE_UNSUPPORTED`; any other filename keeps the existing filename rejection). After staging, the magic bytes decide the type and both the declared type and the extension must agree with it, else `415 SETTINGS_AVATAR_TYPE_MISMATCH`. PNG uses the shape check above (`SETTINGS_AVATAR_PNG_INVALID`). JPEG is a segment walk, not a decode (`SETTINGS_AVATAR_JPEG_INVALID`, same status as the PNG error): `FF D8` first and `FF D9` last; from offset 2, fill `FF` bytes are skipped, the standalone markers `01`, `D0`–`D9` and an `SOS` (`DA`) before the first SOF reject, every other segment length must be ≥ 2 and in bounds; the first SOF must be `C0`/`C1`/`C2` with 1-byte precision then height and width (u16be, 1–4096 each, ≤ 16,777,216 pixels) — `C3`, `C5`–`C7`, `C9`–`CB`, `CD`–`CF` reject; entropy-coded data and APP1 thumbnails are never parsed. The cap is 8 MiB (`413 SETTINGS_AVATAR_FILE_TOO_LARGE`) and the picture counts toward the 64 MiB total (`413 SETTINGS_AVATAR_TOTAL_LIMIT`). The destination is the single server-chosen, extension-less file `assets/avatar-background` (mode `0600`), promoted atomically with rollback and no source marker; the response is `{ background: { name, type, bytes, sha256, width, height } }`. Every read (preview, inspection, join) re-sniffs and fully re-validates the file; anything else counts as "no picture" (preview 404). Inspection adds `background: { present, type, bytes, width, height, previewUrl }` and `limits.backgroundBytes` (8 MiB).

The meet plane reads the picture once at Join, only when `avatar_rig_background_mode` is `image`, and keeps the bytes in the local-avatar session's memory; any failure is one value-free log line (`local-avatar background image unavailable (<code>)`) and the Join continues without it. The page receives only `background.image`, the first 16 hex digits of the picture's SHA-256 (a cache token, `null` without a picture), and fetches the bytes from `GET /local-avatar/background?v=<visualId>` with the session capability as a Bearer header (exact query, GET only, uniform 404, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, local-avatar CSP). Replacing or deleting the file mid-meeting does not affect the live session.

Export and import walk registry values only, so asset files — `assets/avatar.png`, the frames and `assets/avatar-background` — are structurally excluded from the settings document. `avatar_rig_background_mode` and `avatar_rig_background_color` stay transferable; importing `image` onto a host without an uploaded picture falls back to the build-time embed, else the colour, and raises the readiness notice `AVATAR_BACKGROUND_IMAGE_MISSING` (never a blocker).

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

The implementation gate includes the following stable test IDs. Static scans cover `src/`, `bin/`, `public/`, examples, and tests; the appendix maps every upstream Done when row to at least one ID.

- **T12-01 — registry/schema/type lock:** deep-compare registry, generated strict Zod schemas, UI grouping, write surfaces, UX, aliases, defaults, and effective/source projections; prove class 2/3 are absent, only class 1/general settings are writable, `server_ngrok_domain` accepts only hostname-or-empty, `public_origin` accepts only https-origin-or-empty, and the `absolute-path`/`-or-null` glossary behavior is enforced.
- **T12-02 — environment inventory and migration-duty lock:** tokenize all production JavaScript and prove the 100 direct names plus every dot/bracket/dynamic reference and both classification axes match `docs/settings-env-inventory.json`. Require injected resolver output at every current direct-read site owned by an editable `writeSurface:"settings"` alias, including `FISH_AUDIO_MODEL` at `src/tts-cache.js:50` and `src/tts-fish.js:197`; do not place the 59 env-only diagnostic rows on that required-migration list. For retained env-exclusive reads, including pipeline sites, compare typed direct-read output with diagnostic resolver output under OS, `.env`, and default cases.
- **T12-03 — startup/bootstrap and scanner exceptions:** prove `start` and `mcp` use the one pre-dotenv startup capture, resolved-home selection is pinned before dotenv, and stores/handlers never open `.env`. Only the eight §5 settings modules may exist; only settings `bootstrap.js` may read `process.env` or `.env` within that directory. The scanner separately permits the exact inventoried env-only/control reads and frozen `bin/ai-meet.js init` resolved-home `.env` read/write behavior, while rejecting unclassified reads and class-2 access outside its startup/migration boundary.
- **T12-04 — runtime snapshot/apply model:** boot with distinct saved and running values, publish live and restart-required edits, and prove `effective` remains the current process value, live fields change without file reread/restart, restart-required fields remain at boot values, and `restartRequired` equals the sorted nextBootEffective-versus-running formula with live IDs excluded. Include the closure cases of §3: publish a restart-required edit, restart, and assert `restartRequired` is empty; assert an omitted store path and an OS-launch-overridden field never enter the list (before or after restart). Assert that the UI restart wording and displayed restart list exactly reflect the returned `restartRequired` state. Prime `resolveAgentProfile._cached` and equivalent caches before publish and prove they are invalidated; a failed transaction must publish nothing.
- **T12-05 — whole-store transaction/recovery:** exercise whole-config unknown preservation except class-2 deny paths, DTO separation, stale revision, wake-calibration race, same-directory atomic rename, mode `0600`, symlink rejection, corruption/rollback, and a live second process. Cover absent and parse-invalid GET revision `"bootstrap"`, acceptance only by bootstrap PUT/migrate, precommit state races, and successful transition to an ordinary SHA-256 revision.
- **T12-06 — admin API and localhost boundary:** strict fixtures cover every §6 method/path, JSON shape, body/media limits, Host/socket/Origin/Sec-Fetch/forwarded-header cases, value-free errors, and status mapping. Settings routes/assets are unreachable through ngrok while `/`, existing assets, `/health`, `/calibrate*`, `/agents`, join/session APIs, and meeting WebSocket fixtures retain their prior reachability.
- **T12-07 — setup and meeting-start gate:** start with absent, empty, parse-invalid, unmigrated, and provider-incomplete configs; prove HTTP/UI/API/health survive, setup fields are value-safe, meeting start alone enforces requirements and returns `503 MEETING_SETUP_REQUIRED`, and no setup/migration path exits the process.
- **T12-08 — masking/import/export/templates/CLI:** prove class-1 mask preserve/replace/explicit-clear, credential-free version-1 export, rejection of version 0/unknown/future versions and unknown keys, editable nonsecret presets, class-specific example/generated-file shapes, frozen `meetmate init` class-1 destination, and `docs/cli-contract.md` precedence/class-2 amendments. A fresh second agent can use exported settings without a repository clone, and generated guidance documents class-3 regeneration without revealing values.
- **T12-09 — audio ownership/mismatch/runtime:** test the 10 MiB streaming cap, filename/path/symlink/signature sanitization, resolved-home ownership, bundled-asset immutability, ffmpeg missing/failure, PCM format/rate, cache-key text/reference/model/rate/speed mismatch and UI `stale` warning, deterministic duplicate selection, stale/missing fallback, owned-pair deletion, and runtime use independent of any seeder.
- **T12-10 — canonical emotion source:** assert each of the five canonical tag literals occurs only in structured `EMOTION_TAGS`, both `messages.js` prompt sites use composed output, the UI exposes only the ON/OFF toggle plus fixed read-only five-tag help, and default behavior is enabled.
- **T12-11 — feature/provider ownership and runtime wiring:** toggle `task_extraction_enabled` and `streaming_equivalent_enabled` independently and observe the exact §11 branches. Registry/meeting tests also lock Deepgram/Attendee settings plus wake words, language, icon, model, and voice ownership to the declared paths and providers.
- **T12-12 — 8.x migration transactions:** seed every class-2 legacy path and class-1 `.env` source; prove class 2 is detected, value-free warned, ignored, stripped on save, and rollback-safe, while class-1 migration copies only eligible values from the startup snapshot. Failures abort only the request, leave HTTP/setup alive, and never edit `.env`; resolved-home and cwd fallback are covered.
- **T12-13 — credential/sentinel leak matrix:** use distinct high-entropy class 1/2/3 values across all API, UI, export/import, presets, health, errors, logs, templates, and generated files. Also test the 14 exact case-sensitive placeholder sentinels, meaningful near misses, canonical numeric equality, and static rejection of class 2/3 names/deny paths from public/admin schema surfaces.
- **T12-14 — connection tests and preview:** lock the route enum to the §6 provider table (ten literals, equal to `PROVIDERS` in `src/settings/routes.js`; unknown literals are `422`); require working Soniox and Fish Audio tests, permit exact `501 TEST_NOT_IMPLEMENTED` only for the not-yet-implemented tier (Slack), and verify implemented tests (Deepgram, ElevenLabs, OpenAI-compatible, Attendee, `llm`, `tunnel`, Discord included) use the effective class-1 credential — or, for `llm`, the class-2 startup snapshot; `tunnel` sends none — with a five-second limit, value-free output, and a `code` drawn only from the twelve-literal `ConnectionCode` union. Preview fixtures prove user-key selection, WAV format, one 30-second budget, the 15-second cap, no partial response, and value-free logs.
- **T12-15 — settings remain singular-agent; legacy `agents` is never consumed:** `agents` is not supported; a pre-existing value is preserved, never consumed, and triggers a value-free boot warning. Prove no settings/UI/DTO/migration/runtime path synthesizes or consumes an `agents` array.
- **T12-16 — post-child-3 effective system test:** after Epic child 3, run the operator path UI edit → save → required restart if listed → runtime behavior, recording measured evidence for every editable field family and the live-without-restart exceptions.
- **T12-17 — operator-documentation acceptance:** README/setup guide describe the first meeting, exact five emotion tags, class separation/migration, apply wording, and current UI; screenshot fixtures are refreshed against the accepted settings screen.
- **T12-18 — integration/release evidence gate:** the Epic integration record must include the E-6③ full L1–7 integration review, Epic-to-main verification, and T-5 annotated-tag/release/8.x migration documentation evidence. These are downstream Epic gates, not authorization for Issue #30 to merge or release.
- **T12-19 — upstream trace completeness:** parse Appendix A and assert exactly 15 distinct `E29-*` rows and 23 distinct `D30-*` rows, with no blank contract-section or §12-test cell, no duplicate source ID, and no upstream Done when row omitted.
- **T12-21 — remote settings access (#288):** `test/settings-remote-access.test.js` — with the switch off every non-local request gets today's `404` bytes; the R0–R6 admission matrix (loopback both ends, `.ts.net` `public_origin` normalised with `new URL`, `Host`/`X-Forwarded-Host`/`X-Forwarded-Proto`, no `Forwarded`, identity header and optional pin, `X-Forwarded-For` parser rows, each header exactly once in `rawHeaders`, a saved-but-not-restarted `public_origin`); every route `handleSettings` dispatches answers remotely as locally (a table that fails when a route is added); framing headers; remote Origin / `Sec-Fetch-Site` rules and the side-effect-free remote `cloud/status`; X1 (locked fields on the final map, remote bootstrap) and X2; class-1 write-only over the remote plane; `remoteAccess` on GET/PUT/import; public surfaces untouched. The settings-page rows live in `test/settings-ui.test.js`.
- **T12-20 — CP#1 approval gate:** while the owner-approval record is absent, assert that this document remains `proposed — pending CP#1 owner approval` and no implementation/release workflow treats it as approved; once recorded, update the status and retain the approval evidence.

Sentinel integration tests use distinct high-entropy values for every credential in classes 1, 2, and 3. Class 1 sentinels may appear only in the mode-`0600` whole-config store and the in-memory provider call selected by the test; they must not appear in HTML, GET, errors, logs, connection-test responses, export, presets, generated `AGENTS.md`, or imported output. Class 2 sentinels may appear only in the test environment and intended provider call and must not remain in `config.json` after save/migration. Class 3 sentinels deliberately seeded under unknown config keys remain preserved internally, but must be ignored by runtime resolution and never appear in any admin projection, export, error, log, template, or generated file; actual class 3 runtime values come only from the environment.

## 13. Singular agent boundary and reserved expansion

This contract keeps the existing singular `agent` object. The settings registry, DTO, UI, migration, export, validation, and runtime must not introduce, infer, or synthesize an `agents` array. `agents` is not supported; a pre-existing value is preserved, never consumed, and triggers a value-free boot warning. The settings plane cannot expose, mutate, import, export, validate, or consume it. No singular-to-array migration is part of Issue #30.

## Appendix A. Epic #29 v4 / Issue #30 Done when trace

The GitHub Issue bodies are the source of truth for this trace. The table has one row for every Epic #29 v4 Done when line (15) and every Issue #30 Done when line (23): 38 total, zero unmapped. “Contract section” identifies the normative destination; “§12 test” identifies executable or evidence-gate coverage. T12-19 locks the table's cardinality and nonblank mappings.

| Source | Frozen Done when line | Contract section | §12 test |
|---|---|---|---|
| `E29-01` | Setup mode: even with empty settings, `meetmate start` serves HTTP/UI/API/health only; meetings are disabled with 503 and required validation moves to meeting start. | §§6–7 | T12-07 |
| `E29-02` | The admin screen alone covers voice presets, emotion ON/OFF with the default five tags, class-1 Soniox/Deepgram/Fish/Attendee/Slack keys, model/voice, Slack/ngrok, task/stream flags, wake words, language, and icon. | §§1, 6, 8–11 | T12-01, T12-08, T12-09, T12-10, T12-11, T12-14 |
| `E29-03` | UI warns when setting text and prerecorded MP3 disagree; user audio is ingested under `AI_MEET_HOME`, bundled audio is read-only, and runtime is not seeder-dependent. | §9 | T12-09 |
| `E29-04` | Class-1 keys are masked, omitted from export, support masked round trip, and have an explicit clear operation. | §8 | T12-08, T12-13 |
| `E29-05` | Complete allowlist separation: class 2 has no UI/state/schema slot, class 3 is also hidden, sentinels never leak through API/export/UI/logs, and static scans keep dotenv/`envPath`/class-2 names out of settings handlers/stores. | §§1–2, 5, 8, 12 | T12-01, T12-03, T12-13 |
| `E29-06` | `config.json` is the only settings source; `.env` is an initial seed; init sends class 1 to the store; precedence is pre-dotenv OS > store > `.env` > default; only startup captures pre-dotenv state; override diagnostics and the legacy class-1 destination are fixed. | §§2–3, 8 | T12-03, T12-08, T12-12 |
| `E29-07` | A readable env manifest/lock covers 100 static names plus dynamic references, all `src` `process.env` references, and both axes, while class 2/3 are excluded from visible current-source diagnosis. | §§1, 5 | T12-02, T12-13 |
| `E29-08` | Apply behavior is mostly restart-required, UI wording is accurate, and precedence inconsistencies are removed. | §§1, 3 | T12-04 |
| `E29-09` | The settings admin boundary enforces localhost/Host/same-Origin and is unavailable through ngrok; only settings UI/API are guarded and the current dashboard remains reachable. | §6 | T12-06 |
| `I288-01` | Amendment (#288, outside the 38 rows above): opt-in remote settings access through the operator's Tailscale Serve origin — off by default and byte-identical when off; R0–R6 admission; remote writes same-origin to the allowed origin; X1 / X2; class-1 stays write-only; `remoteAccess` on every envelope. | §6 | T12-21 |
| `E29-10` | Emotion tags have one structured source feeding both `messages.js` sites. | §10 | T12-10 |
| `E29-11` | Soniox/Fish connection tests and TTS preview exist and never log secrets. | §§6, 9 | T12-14, T12-13 |
| `E29-12` | Export/import has version handling, rejects unknown/old forms, excludes classes 1/2/3, supports editable presets/templates, lets a second agent operate without a repo clone, and documents class-3 regeneration. | §8 | T12-08, T12-13 |
| `E29-13` | After child 3 and before docs, the effective test measures UI change → save → restart → runtime behavior per child. | §12 | T12-16 |
| `E29-14` | README/docs cover the first meeting, setup guide lists the exact five tags, and screenshots are updated. | §§10, 12 | T12-17 |
| `E29-15` | The E-6③ full L1–7 integration review passes; Epic → main verification and T-5 annotated-tag/release/8.x migration documentation are evidenced. | §12 | T12-18 |
| `D30-01` | Zod settings schema includes only class 1 and general settings; classes 2/3 are absent. | §1 | T12-01, T12-13 |
| `D30-02` | `config.json` remains the single store with no new settings file and has atomic, `0600`, symlink, concurrency, and corruption handling. | §§2, 4 | T12-05 |
| `D30-03` | Precedence and the override-display formula are frozen. | §3 | T12-03, T12-04 |
| `D30-04` | Environment inventory locks 100 names plus dynamic references and two classification axes. | §5 | T12-02 |
| `D30-05` | Admin API endpoints/JSON, local socket/Host/same-Origin/ngrok boundary, errors, and body limits are fixed. | §6 | T12-06 |
| `D30-06` | Setup mode keeps UI/API/health alive, meeting returns 503, and validation moves to meeting start. | §7 | T12-07 |
| `D30-07` | Apply behavior is mostly restart-required and UI wording reflects actual runtime behavior. | §§1, 3 | T12-04 |
| `D30-08` | Masked round trip/clear, export version and unknown/old rejection, credential exclusion, presets, and templates are fixed. | §8 | T12-08, T12-13 |
| `D30-09` | MP3 ingest is rooted under `AI_MEET_HOME`, keeps app/bundled assets read-only, and enforces upload size/sanitization. | §9 | T12-09 |
| `D30-10` | The canonical emotion list feeds the named `messages.js` sites. | §10 | T12-10 |
| `D30-11` | Task/stream identifiers and Deepgram/Attendee/wake/language/voice ownership are explicit. | §§1, 7, 11 | T12-11 |
| `D30-12` | 8.x class-2 migration detects, warns, guides, ignores, strips on save, backs up, rolls back, and aborts only the failed request while setup survives. | §§2, 4, 7 | T12-12 |
| `D30-13` | Whole-config persistence is separated from DTO projection; nonallowlisted keys are preserved except class-2 deny paths. | §2 | T12-05 |
| `D30-14` | “Failure stop” means abort the save/migration request while HTTP remains alive. | §§4, 7 | T12-07, T12-12 |
| `D30-15` | Class-1 placeholder/dummy meaningfulness and lower-tier fallback are fixed. | §3 | T12-13 |
| `D30-16` | All startup paths (`server`/`bin`/`mcp`) have consistent `.env` behavior. | §§3, 5 | T12-03 |
| `D30-17` | The OS tier is the startup-only pre-dotenv `process.env` snapshot; stores/handlers never open `.env`. | §§3, 5 | T12-03 |
| `D30-18` | The legacy class-1 `.env` end state uses resolved home with cwd fallback. | §§3, 8 | T12-12 |
| `D30-19` | MP3 mismatch formula and task/stream runtime wiring are contractual, not display-only. | §§9, 11 | T12-09, T12-11 |
| `D30-20` | Frozen CLI-contract amendments make class 2 environment-only, init write class 1 to the store, and preserve precedence. | §§3, 8 | T12-08 |
| `D30-21` | Verification includes sentinel coverage and the static-grep boundary. | §§5, 12 | T12-02, T12-03, T12-13 |
| `D30-22` | Runtime remains singular-agent; `agents` is not supported; a pre-existing value is preserved, never consumed, and triggers a value-free boot warning. | §13 | T12-15 |
| `D30-23` | CP#1 owner approval is required before the contract is treated as approved. | Status, §12 | T12-20 |

### Face packages (#254)

`avatar_experiment` additionally accepts `face-package`. Each join must explicitly
request that value; the global default alone does not enable a face session.
`face_package_dir` (`avatar.facePackageDir`) is an absolute, deployment-only,
restart-required path, excluded from UI GET values, PUT, import and export.
Invalid/unset packages use the static image and log `MM-MMT-003` without paths.
`emotion_judge` (`avatar.emotionJudge`) is live, `off` (default) / `tags` / `jev`.
`face_listen_reactions` (`avatar.faceListenReactions`) defaults to false and applies
only to explicitly created face sessions (start a new meeting after changing it).
`face_timeline_offset_ms` (`avatar.faceTimelineOffsetMs`) is a signed integer in
[-3000, 3000], default 300, next-join: the face host waits this many milliseconds
after the server marks audio before animating it. It is read once per face session
and sent as the descriptor's `timelineOffsetMs`; a running session keeps its value.
`face_timeline_offset_ms_self_hosted` (`avatar.faceTimelineOffsetMsSelfHosted`, #260)
has the same shape and default; the value of the host selected by `bot_host` at join
time is the one sent (`face_timeline_offset_ms` for the cloud slot).
`TYPESAFE_API_KEY` is environment-only and lazy, outside the settings registry.
See [Face packages and Face Protocol v1](face-packages.md) for the serving boundary,
manifest and optional user-transcript reaction judgement.

### Page-audio default (#274)

`face_audio_default` (`avatar.faceAudioDefault`) is `""` (WebSocket, default) or
`page`, next-join, transferable, with no environment alias. Join precedence: an
explicit `faceAudio` field on `POST /join-meeting` (`page` or `""`; a present empty
field counts as explicit) wins and keeps the #266 validation and messages. Only an
absent field consults this default, and it turns page audio on only when the
default is `page`, the Attendee host kind is `self-hosted`, the join explicitly
resolved `avatarExperiment=face-package`, and the session's floor hub is not
enabled. Otherwise the join silently uses the WebSocket path; the default never
causes a join error. MCP `join_meeting` is unchanged.

Attendee host kind (#260): (1) when `bot_host` is stored in the requested snapshot
(its source is neither `default` nor `unset`), `attendee-self-hosted` is
`self-hosted` and `attendee-cloud` is `cloud`, and `attendee_base_url` is not
consulted; (2) with no `bot_host` stored, the pre-#260 rule holds unchanged: the
`attendee_base_url` of that snapshot, trimmed and case-folded; `app.attendee.dev`,
empty or absent is `cloud`, any other hostname is `self-hosted`. The kind never
selects a key or a destination — the slot is `bot_host` alone, so an installation
whose legacy hostname points at its own Attendee keeps the cloud slot and the
`self-hosted` kind, exactly as before. `src/attendee-host-kind.js` is the only
source; a join records the kind on its target at resolution and decides page audio
from that target and the `face_audio_default` value read in the same synchronous
span. No save stores `bot_host` unless the request names it (a bootstrap-revision
save does not seed it). The settings envelope carries it as `attendeeHostKind`, and
`GET /info` carries exactly two additive members, `attendeeHostKind` and
`faceAudioDefault`, for the join form. The settings screen shows the field only for
face-package on self-hosted Attendee; on cloud it shows a one-line note instead,
and a stored value is unused.

Sample rates: inbound meeting audio stays a fixed 16 kHz (`SAMPLE_RATE`) because
the Deepgram/Soniox STT providers, the mixed-STT window, the Discord 48k→16k
decimation and wake calibration all assume it. Caty's outgoing voice stays
`tts_sample_rate`; with Attendee keep it at 8000, 16000 or 24000, the only rates
Attendee realtime audio accepts, because any page-audio reply can fall back to the
WebSocket path. The rate at which Attendee captures the face page's audio is an
Attendee-server setting (`WEBPAGE_STREAMER_AUDIO_SAMPLE_RATE` on a patched
self-hosted Attendee; upstream is fixed at 16 kHz; 48 kHz recommended for this
mode). meetmate does not change it and cannot read it.

### Reply trigger (#267, trial)

`agent_reply_trigger` (`agent.replyTrigger`) is basic and live, `wake` (default) /
`jev`, read per utterance. `wake` keeps today's wake-word gate unchanged. `jev`
also answers a line without a wake word when jev judges it addressed to the agent
and finished; it sends recent meeting lines (speakers as pseudonyms) to the
external judge and needs the same lazy `TYPESAFE_API_KEY`; without it the mode is
silent. With `hub.enabled` it behaves as `wake` and logs one warning per session.
The hidden, live `agent.replyJudge.*` rows keep the owner-fixed defaults:
`addressedMin` 0.75, `finishedMin` 0.75, `continuationWaitMs` 3000, `timeoutMs`
800, `contextLines` 6. See [the design note](design/267-jev-turn-taking.md).
