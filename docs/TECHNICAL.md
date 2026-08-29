# Meetmate — Technical reference

The front [README](../README.md) covers what Meetmate is and how to try it. This page is the engineering entrance: features in detail, architecture, configuration surfaces, providers, MCP, and development workflow.

## Table of contents

- [Feature reference](#feature-reference)
- [Architecture](#architecture)
- [Data directory (`AI_MEET_HOME`)](#data-directory-ai_meet_home)
- [Installation notes (`meetmate init`)](#installation-notes-meetmate-init)
- [Environment variables (`.env`)](#environment-variables-env)
- [Agent configuration (`config.json`)](#agent-configuration-configjson)
- [LLM providers](#llm-providers)
- [MCP server (control plane)](#mcp-server-control-plane)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Feature reference

- **Google Meet / Zoom support** — joins meetings through the Attendee bot API
- **OpenClaw Gateway integration** — full support for SOUL / memory / skills / tools
- **Wake-word detection + barge-in** (interrupting the agent mid-speech)
- **Low-latency STT** — Soniox `stt-rt-v5` by default; switch to Deepgram with `STT_PROVIDER=deepgram`
- **Expressive TTS** — Fish Audio S2-Pro (emotion-tag anchor scheme keeps the voice stable)
- **Fixed-line TTS cache** — acks / pings / greetings / farewells play instantly from a PCM disk cache; pre-seeding with real recorded takes is supported
- **Delegation harness** — heavy work is forcibly delegated to a background session so the front agent stays conversational ([#79](https://github.com/caty-ai/meetmate/issues/79); design spec: [deep-interview-79-delegation-harness.md](deep-interview-79-delegation-harness.md))
- **Meeting chat posting** — `[[[chat: ...]]]` tags in LLM replies are posted to the meeting chat instead of being spoken
- **Emoji guard** — two layers: LLM prompt ban + mechanical strip right before TTS
- **LCM (Lossless Context Management) auto-recording** / **Slack integration** (status notifications, summaries, full transcripts)

## Architecture

**One agent = one server instance.** Any agent runs with just `config.json` + `.env` + an avatar image.

Input-side STT runs at 16 kHz; output-side TTS / `bot_output` runs at 24 kHz. The Attendee input leg and output leg are independent.

### Key modules

| Module | Role |
|---|---|
| [`src/pipeline.js`](../src/pipeline.js) | Audio pipeline control |
| [`src/agent-profile.js`](../src/agent-profile.js) | Agent profile resolution |
| [`src/paths.js`](../src/paths.js) | Home-directory contract (`AI_MEET_HOME`) — see [Data directory](#data-directory-ai_meet_home) |
| [`src/llm-provider.js`](../src/llm-provider.js) | LLM provider switch (OpenClaw default / OpenAI-compatible) |
| [`src/stt-provider.js`](../src/stt-provider.js) | STT provider switch (soniox default / deepgram) |
| [`src/stt-soniox.js`](../src/stt-soniox.js) | Soniox STT (stt-rt-v5, WebSocket) |
| [`src/stt.js`](../src/stt.js) | Deepgram STT (fallback) |
| [`src/tts-fish.js`](../src/tts-fish.js) | Fish Audio TTS |
| [`src/speech-policy.js`](../src/speech-policy.js) | NO_REPLY suppression, text sanitization |
| [`src/exit-handler.js`](../src/exit-handler.js) | Exit detection and cleanup |

See [architecture.md](architecture.md) for the full deep dive.

## Data directory (`AI_MEET_HOME`)

Everything the server **writes**, plus your user configuration, lives in one *home* directory — by default the **current working directory**, or the directory set in the `AI_MEET_HOME` environment variable:

| Path (under home) | Contents |
|---|---|
| `config.json` / `.env` | Your agent configuration and credentials |
| `logs/` | Runtime logs and delegation metrics (`metrics.jsonl`) |
| `assets/avatar.png` | Optional avatar override (falls back to the bundled default image) |
| `assets/tts-cache/` | Fixed-line TTS cache |

Read-only bundled assets (the web UI, the default avatar) always come from the installed package itself. Filler audio is not bundled — see NOTICE — so supply your own takes under `assets/fillers/` to use the cache seeder. `TTS_CACHE_DIR` and `METRICS_LOG_DIR` are still honored as explicit overrides. Running `npm start` from a source checkout keeps the repository root as home, so the from-source behavior is unchanged.

## Installation notes (`meetmate init`)

`meetmate init` copies the bundled `config.json.example` / `.env.example` into the **current directory** and fills in the credentials you enter (`SONIOX_API_KEY`, `FISH_AUDIO_API_KEY`, `ATTENDEE_API_KEY`). It refuses to overwrite existing files unless you pass `--force`. Then edit `config.json` to set your agent's name, wake words, and fixed lines.

Service notes:

- [Attendee](https://attendee.dev/) is a SaaS (a self-hosted edition also exists) that puts bots into Google Meet / Zoom. All bot join/leave and audio I/O goes through the Attendee API.
- For the Fish Audio Voice ID, open the page of the voice you want (your own or a public one) on [fish.audio](https://fish.audio/) and copy the ID at the end of the URL.

## Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | LLM provider (`openclaw` (default) / `openai-compatible`) |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL (required for `openclaw`, e.g. `http://localhost:18789`) |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token (required for `openclaw`) |
| `OPENAI_COMPATIBLE_BASE_URL` | Base URL of an OpenAI-compatible API (required for `openai-compatible`) |
| `OPENAI_COMPATIBLE_API_KEY` | API key for the OpenAI-compatible API (required for `openai-compatible`) |
| `SONIOX_API_KEY` | STT (default provider Soniox) |
| `FISH_AUDIO_API_KEY` | TTS |
| `FISH_AUDIO_VOICE_ID` | TTS voice ID (voice clone) |
| `ATTENDEE_API_KEY` | Meet / Zoom bot API |

Optional variables (`PORT`, `AGENT_LANG`, Slack integration, …) and the full tuning reference are in [operations.md](operations.md).

## Agent configuration (`config.json`)

Agent ID / display name / wake words / fixed lines (greeting, ackVariants, progressPings, …) and the TTS / STT / Slack / Attendee settings are all collected here. `config.json.example` is already aligned with the emotion-tag anchor scheme (for S2-Pro), so copy it and fill in the variables.

If wake-word recognition is unreliable, the **wake-calibrate** feature (`/calibrate`, enabled with `WAKE_CALIBRATE_ENABLED=1`) collects misrecognition variants from your real utterances in the browser. See [setup-guide.md](setup-guide.md).

## LLM providers

| `llm.provider` / `LLM_PROVIDER` | Behavior |
|---|---|
| `openclaw` | Default. Uses SOUL / memory / skills / tools through the OpenClaw Gateway |
| `openai-compatible` | Talks directly to an OpenAI-compatible API. No OpenClaw Gateway required |

`openai-compatible` is a degraded mode that answers by voice with a plain LLM and a built-in persona template. It is the OSS baseline when no Gateway is configured; OpenClaw-specific memory / skills / tools are unavailable. Claude models are used through an OpenAI-compatible proxy (e.g. LiteLLM); there is no native Anthropic adapter ([#114](https://github.com/caty-ai/meetmate/issues/114)).

If you select `openai-compatible` in `config.json`, set `LLM_PROVIDER` in `.env` to match (the environment variable takes precedence over `config.json`). Missing or incomplete settings no longer make the server exit at startup: it boots into **setup mode** (settings UI, settings API, and `/health` stay available; meeting start is blocked until the required fields are filled). `${...}` placeholder syntax is no longer used in `config.json` — leave unused credential fields empty instead of inventing dummy values. Connection values (`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `OPENAI_COMPATIBLE_API_KEY`) are environment-only: put them in `.env`; if written into `config.json` they are ignored with a startup warning.

For stateful OpenAI-compatible gateways that already own the session history, set `llm.historyMaxTurns` to `0` so Meetmate sends only the current user turn (plus the standalone system prompt, if configured). In the same cases, set `llm.openaiCompatible.emptyResponseRetry` to `false`: the default one-time empty-stream replay is kept for backward compatibility, but replaying the same turn can be unsafe when the upstream gateway may already have executed tools or mutated its native session.

`llm.openaiCompatible.trustedAgentTools` is a separate opt-in, defaulting to `false`. When enabled, Meetmate adds `X-Caty-Agent-Trust: trusted` on OpenAI-compatible requests. This is intended only for a trusted local tool-capable gateway in a trusted meeting. External or untrusted meetings remain unsupported for that mode.

The `llm` schema in `config.json`:

```json
{
  "llm": {
    "provider": "openclaw",
    "model": "openclaw",
    "temperature": 0.5,
    "maxTokens": 300,
    "historyMaxTurns": 12,
    "systemPrompt": "",
    "openaiCompatible": {
      "baseUrl": "",
      "apiKey": "",
      "emptyResponseRetry": true,
      "trustedAgentTools": false
    }
  }
}
```

Resolution order for `provider` / `temperature` / `maxTokens` / `openaiCompatible`: per-session overrides → agent settings → environment variables → `configJson.llm` → defaults. The corresponding environment variables are `LLM_PROVIDER`, `AGENT_TEMPERATURE`, `AGENT_MAX_TOKENS`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`. `model` and `historyMaxTurns` do not read environment variables; they resolve overrides → agent settings → `configJson.llm` → defaults. `openaiCompatible.emptyResponseRetry` resolves overrides → agent settings → `configJson.llm.openaiCompatible` → `true`. `openaiCompatible.trustedAgentTools` resolves overrides → agent settings → `configJson.llm.openaiCompatible` → `false`. For `openai-compatible`, `systemPrompt` resolves `overrides.prompt` → `configJson.llm.systemPrompt` → built-in persona, with voice-specific rules appended.

Requests go to `{baseUrl}/v1/chat/completions`; if `baseUrl` already ends with `/v1`, it is not doubled. Streaming SSE now fails loudly on malformed JSON and `event: error` frames instead of silently treating them as empty output. Unknown provider names warn and fall back to `openclaw`.

## MCP server (control plane)

A thin stdio MCP server lets LLM clients (Claude Code, other agents) control meeting participation directly — the voice pipeline itself stays out of MCP scope. Register it with:

```bash
claude mcp add meetmate -- npx meetmate mcp
```

Environment: `AI_MEET_BASE_URL` selects the Meetmate REST API to control (default `http://localhost:5005`); `AI_MEET_JOIN_TOKEN` is optional and forwarded as the `x-join-token` header and `joinToken` field; `AI_MEET_JOIN_TIMEOUT_MS` adjusts the `join_meeting` call budget (default 60000 ms — joins can take up to ~50 s server-side; the other tools time out at 15 s).

| Tool | Action |
|---|---|
| `join_meeting(meetingUrl, briefing?, conversationMode?)` | Join a Meet / Zoom meeting (proxies `POST /join-meeting`; the WebSocket URL is derived automatically) |
| `leave_meeting(sessionId?)` | Leave the active session (or a specific one) |
| `get_active_session()` | List active sessions as JSON |
| `health()` | Service health check |

## Troubleshooting

**Q. Responses come back slowly after I stop speaking**
Set `SONIOX_MAX_ENDPOINT_DELAY_MS=1000` in `.env` (when unset, the Soniox server-side default of `2000` applies; try `800` if needed) and restart the server. If your utterances start getting cut off mid-sentence, lower `SONIOX_ENDPOINT_SENSITIVITY` toward `0.0〜-0.2`. Details: [Soniox tuning](operations.md#stt-プロバイダ切替soniox-チューニング).

**Q. Posting to the meeting chat fails**
Messages containing emojis or rare script characters are rejected with a 400 by the Attendee server ("Message cannot contain emojis or rare script characters."). Send-failure warnings go to `logs/meet-server.stderr.log` when running under the launchd/systemd service (with a plain `npm start` they appear on the terminal's stderr); check there first. (On a systemd install the unit appends app output to those files directly — `journalctl --user -u <label>` only shows service lifecycle lines, not these warnings.)

**Q. The TTS voice is unstable or goes wild**
S2-Pro tends to destabilize on tag-less utterances, so the design assumes the "anchor scheme": one emotion tag in every utterance ([voice profile](operations.md#音声プロファイルtts)). If it is still unstable, `FISH_AUDIO_MODEL=s1` rolls back to the previous model immediately.

**Q. STT accuracy suddenly degraded**
Set `STT_PROVIDER=deepgram` in `.env` and restart to switch to Deepgram immediately. For misrecognized names and jargon, add comma-separated entries to `SONIOX_CONTEXT_TERMS`.

**Q. Fixed lines (acks etc.) sound different from usual**
The TTS cache is missing and playback fell back to live synthesis. The cache key depends on `voiceId` / `FISH_AUDIO_SPEED` / `FISH_AUDIO_MODEL` / `TTS_SAMPLE_RATE`; re-run `node scripts/seed-tts-cache-from-fillers.js` after changing any of them ([seeding guide](operations.md#実収録テイクのシード72--75)).

**Q. How do I check the delegation harness is working?**
It logs to `logs/metrics.jsonl` (JSONL). Aggregate with `node scripts/aggregate-metrics.js logs/metrics.jsonl`.

If none of this helps, open an [Issue](https://github.com/caty-ai/meetmate/issues) with logs (under `logs/`) and reproduction steps.

## Development

### Dev server

```bash
npm run dev   # auto-reload via node --watch
```

### Tests

Uses the Node.js built-in test runner (`node:test`). No external services required; the whole suite finishes in seconds.

```bash
npm test                          # all tests (node --test)
npm run test:meet:repro           # only the Meet multi-participant reproduction test
```

### Smoke and operations scripts

| Script | Purpose |
|---|---|
| [`scripts/soniox-smoke.js`](../scripts/soniox-smoke.js) | Soniox STT connectivity check |
| [`scripts/seed-tts-cache-from-fillers.js`](../scripts/seed-tts-cache-from-fillers.js) | Pre-generate the TTS cache from recorded takes (requires `ffmpeg` on PATH — not installed by default on Ubuntu: `sudo apt install ffmpeg`) |
| [`scripts/aggregate-metrics.js`](../scripts/aggregate-metrics.js) | Aggregate delegation-harness metrics |
| [`scripts/install-service.sh`](../scripts/install-service.sh) | Cross-platform daemonization: dispatches to launchd (macOS) or a systemd user unit (Linux/WSL2), with watchdog restart support on both |
| [`scripts/install-launchagent.sh`](../scripts/install-launchagent.sh) | macOS launchd daemonization (called by install-service.sh; usable directly) |

### Logs

Runtime logs go under `logs/`. Application warnings/errors: `logs/meet-server.stderr.log` (under a launchd or systemd install; a plain `npm start` prints them to the terminal). On systemd installs `journalctl --user -u <label>` carries only the systemd lifecycle events (start/stop/failure) — application output goes to the `logs/` files, not the journal. Delegation metrics: `logs/metrics.jsonl`.
