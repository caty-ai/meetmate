# AI Meet Participant

**English** | [日本語](README.ja.md) | [中文](README.zh.md) | [ไทย](README.th.md)

[![Version](https://img.shields.io/badge/version-v7.9.0--rc.1-blue)](https://github.com/caty-ai/meetmate/releases)
[![Stable](https://img.shields.io/badge/stable-v7.8.0-brightgreen)](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
[![License: Apache--2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Google%20Meet%20%7C%20Zoom-4285F4)](#features)

A bridge server that puts an AI agent into Google Meet / Zoom as a real-time, voice-interactive participant. With OpenClaw Gateway integration, any agent can join your meetings and talk.

```
STT (Soniox) → wake-word detection → LLM (OpenClaw Gateway by default) → TTS (Fish Audio S2-Pro) → Meet / Zoom
```

## Table of contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Development](#development)
- [Project status](#project-status)
- [Contributing](#contributing)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Features

- **Google Meet / Zoom support** — joins meetings through the Attendee bot API
- **OpenClaw Gateway integration** — full support for SOUL / memory / skills / tools
- **Wake-word detection + barge-in** (interrupting the agent mid-speech)
- **Low-latency STT** — Soniox `stt-rt-v5` by default; switch to Deepgram with `STT_PROVIDER=deepgram`
- **Expressive TTS** — Fish Audio S2-Pro (emotion-tag anchor scheme keeps the voice stable)
- **Fixed-line TTS cache** — acks / pings / greetings / farewells play instantly from a PCM disk cache; pre-seeding with real recorded takes is supported
- **Delegation harness** — heavy work is forcibly delegated to a background session so the front agent stays conversational ([#79](https://github.com/caty-ai/meetmate/issues/79))
- **Meeting chat posting** — `[[[chat: ...]]]` tags in LLM replies are posted to the meeting chat instead of being spoken
- **Emoji guard** — two layers: LLM prompt ban + mechanical strip right before TTS
- **LCM (Lossless Context Management) auto-recording** / **Slack integration** (status notifications, summaries, full transcripts)

## Screenshots

<!-- TODO: uncomment once images are placed in docs/images/
![Control UI](docs/images/ui-join.png)
![In a meeting](docs/images/in-meeting.png)
-->

Open http://localhost:5005 in a browser, paste a Meet / Zoom URL, and the agent joins the meeting. While in the meeting the avatar (`assets/avatar.png`) appears as the agent's participant tile, and the agent answers by voice when called with its wake word.

> 📸 Screenshots and demo GIFs are in preparation.

## Architecture

**One agent = one server instance.** Any agent runs with just `config.json` + `.env` + an avatar image.

Input-side STT runs at 16 kHz; output-side TTS / `bot_output` runs at 24 kHz. The Attendee input leg and output leg are independent.

### Key modules

| Module | Role |
|---|---|
| [`src/pipeline.js`](src/pipeline.js) | Audio pipeline control |
| [`src/agent-profile.js`](src/agent-profile.js) | Agent profile resolution |
| [`src/paths.js`](src/paths.js) | Home-directory contract (`AI_MEET_HOME`) — see [Data directory](#data-directory-ai_meet_home) |
| [`src/llm-provider.js`](src/llm-provider.js) | LLM provider switch (OpenClaw default / OpenAI-compatible) |
| [`src/stt-provider.js`](src/stt-provider.js) | STT provider switch (soniox default / deepgram) |
| [`src/stt-soniox.js`](src/stt-soniox.js) | Soniox STT (stt-rt-v5, WebSocket) |
| [`src/stt.js`](src/stt.js) | Deepgram STT (fallback) |
| [`src/tts-fish.js`](src/tts-fish.js) | Fish Audio TTS |
| [`src/speech-policy.js`](src/speech-policy.js) | NO_REPLY suppression, text sanitization |
| [`src/exit-handler.js`](src/exit-handler.js) | Exit detection and cleanup |

See [docs/architecture.md](docs/architecture.md) for details.

## Quick start

### Prerequisites

- Node.js 22 or later (per `engines` in `package.json`)
- An LLM provider: `openclaw` (default) or `openai-compatible`
  - `openclaw` requires an OpenClaw Gateway and provides the full agent experience including SOUL / memory / skills / tools
  - `openai-compatible` connects to any OpenAI-compatible API; no OpenClaw Gateway needed
- API keys for each service (Soniox / Fish Audio / Attendee)
  - [Attendee](https://attendee.dev/) is a SaaS (a self-hosted edition also exists) that puts bots into Google Meet / Zoom. All bot join/leave and audio I/O goes through the Attendee API
  - For the Fish Audio Voice ID, open the page of the voice you want (your own or a public one) on [fish.audio](https://fish.audio/) and copy the ID at the end of the URL

### Option A: npm package (recommended)

> ℹ️ Until the first npm release is published, use [Option B](#option-b-from-source) below.

```bash
mkdir my-agent && cd my-agent
npm install ai-meet-participant
npx ai-meet init    # interactively asks for the 3 API keys, then creates config.json + .env
npx ai-meet start   # starts the server and prints the settings-UI URL
```

`init` copies the bundled `config.json.example` / `.env.example` into the **current directory** and fills in the credentials you enter (`SONIOX_API_KEY`, `FISH_AUDIO_API_KEY`, `ATTENDEE_API_KEY`). It refuses to overwrite existing files unless you pass `--force`. Then edit `config.json` to set your agent's name, wake words, and fixed lines.

### Option B: from source

```bash
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env        # then fill in the keys
cp config.json.example config.json
npm start
```

Open http://localhost:5005, paste a Meet / Zoom URL, and click Join.

> 💡 If wake-word recognition is unreliable, the **wake-calibrate** feature (`/calibrate`, enabled with `WAKE_CALIBRATE_ENABLED=1`) collects misrecognition variants from your real utterances in the browser. See [docs/setup-guide.md](docs/setup-guide.md).

### Data directory (`AI_MEET_HOME`)

Everything the server **writes**, plus your user configuration, lives in one *home* directory — by default the **current working directory**, or the directory set in the `AI_MEET_HOME` environment variable:

| Path (under home) | Contents |
|---|---|
| `config.json` / `.env` | Your agent configuration and credentials |
| `logs/` | Runtime logs and delegation metrics (`metrics.jsonl`) |
| `assets/avatar.png` | Optional avatar override (falls back to the bundled default image) |
| `assets/tts-cache/` | Fixed-line TTS cache |

Read-only bundled assets (the web UI, the default avatar, filler audio) always come from the installed package itself. `TTS_CACHE_DIR` and `METRICS_LOG_DIR` are still honored as explicit overrides. Running `npm start` from a source checkout keeps the repository root as home, so the from-source behavior is unchanged.

### Environment variables (`.env`)

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

Optional variables (`PORT`, `AGENT_LANG`, Slack integration, …) and the full tuning reference are in [docs/operations.md](docs/operations.md).

### Agent configuration (`config.json`)

Agent ID / display name / wake words / fixed lines (greeting, ackVariants, progressPings, …) and the TTS / STT / Slack / Attendee settings are all collected here. `config.json.example` is already aligned with the emotion-tag anchor scheme (for S2-Pro), so copy it and fill in the variables.

### LLM providers

| `llm.provider` / `LLM_PROVIDER` | Behavior |
|---|---|
| `openclaw` | Default. Uses SOUL / memory / skills / tools through the OpenClaw Gateway |
| `openai-compatible` | Talks directly to an OpenAI-compatible API. No OpenClaw Gateway required |

`openai-compatible` is a degraded mode that answers by voice with a plain LLM and a built-in persona template. It is the OSS baseline when no Gateway is configured; OpenClaw-specific memory / skills / tools are unavailable. Claude models are used through an OpenAI-compatible proxy (e.g. LiteLLM); there is no native Anthropic adapter ([#114](https://github.com/caty-ai/meetmate/issues/114)).

If you select `openai-compatible` in `config.json`, set `LLM_PROVIDER` in `.env` to match (the environment variable takes precedence over `config.json`). Unresolved `${...}` placeholders in `config.json` (unset or blank) **make the server exit with an error at startup**, so keep dummy values for envs of features you don't use (`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `SLACK_BOT_TOKEN`, …) instead of deleting or blanking them — or delete the whole block from `config.json`.

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
      "apiKey": ""
    }
  }
}
```

Resolution order for `provider` / `temperature` / `maxTokens` / `openaiCompatible`: per-session overrides → agent settings → environment variables → `configJson.llm` → defaults. The corresponding environment variables are `LLM_PROVIDER`, `AGENT_TEMPERATURE`, `AGENT_MAX_TOKENS`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`. `model` and `historyMaxTurns` do not read environment variables; they resolve overrides → agent settings → `configJson.llm` → defaults. For `openai-compatible`, `systemPrompt` resolves `overrides.prompt` → `configJson.llm.systemPrompt` → built-in persona, with voice-specific rules appended.

Requests go to `{baseUrl}/v1/chat/completions`; if `baseUrl` already ends with `/v1`, it is not doubled. Unknown provider names warn and fall back to `openclaw`.

### MCP server (control plane)

A thin stdio MCP server lets LLM clients (Claude Code, other agents) control meeting participation directly — the voice pipeline itself stays out of MCP scope. Register it with:

```bash
claude mcp add ai-meet -- npx ai-meet mcp
```

Environment: `AI_MEET_BASE_URL` selects the AI Meet REST API to control (default `http://localhost:5005`); `AI_MEET_JOIN_TOKEN` is optional and forwarded as the `x-join-token` header and `joinToken` field.

| Tool | Action |
|---|---|
| `join_meeting(meetingUrl, briefing?, conversationMode?)` | Join a Meet / Zoom meeting (proxies `POST /join-meeting`; the WebSocket URL is derived automatically) |
| `leave_meeting(sessionId?)` | Leave the active session (or a specific one) |
| `get_active_session()` | List active sessions as JSON |
| `health()` | Service health check |

## Configuration

Entry points for the most common tweaks. The full reference is [docs/operations.md](docs/operations.md).

| I want to… | Look at |
|---|---|
| Make responses come back faster | [Soniox tuning](docs/operations.md#stt-プロバイダ切替soniox-チューニング) |
| Change the voice, speed, or TTS behavior | [Voice profile](docs/operations.md#音声プロファイルtts) |
| Roll back to previous settings when something is off | [Emergency rollback envs](docs/operations.md#緊急-rollback-用-env) |
| Use background delegation for heavy work | [Delegation harness](docs/operations.md#委譲強制ハーネス79) |
| Seed the TTS cache with real recorded takes | [Seeding recorded takes](docs/operations.md#実収録テイクのシード72--75) |

## Troubleshooting

**Q. Responses come back slowly after I stop speaking**
Set `SONIOX_MAX_ENDPOINT_DELAY_MS=1000` in `.env` (when unset, the Soniox server-side default of `2000` applies; try `800` if needed) and restart the server. If your utterances start getting cut off mid-sentence, lower `SONIOX_ENDPOINT_SENSITIVITY` toward `0.0〜-0.2`. Details: [Soniox tuning](docs/operations.md#stt-プロバイダ切替soniox-チューニング).

**Q. Posting to the meeting chat fails**
Messages containing emojis or rare script characters are rejected with a 400 by the Attendee server ("Message cannot contain emojis or rare script characters."). Send-failure warnings go to `logs/meet-server.stderr.log` when running under the launchd agent (with a plain `npm start` they appear on the terminal's stderr); check there first.

**Q. The TTS voice is unstable or goes wild**
S2-Pro tends to destabilize on tag-less utterances, so the design assumes the "anchor scheme": one emotion tag in every utterance ([voice profile](docs/operations.md#音声プロファイルtts)). If it is still unstable, `FISH_AUDIO_MODEL=s1` rolls back to the previous model immediately.

**Q. STT accuracy suddenly degraded**
Set `STT_PROVIDER=deepgram` in `.env` and restart to switch to Deepgram immediately. For misrecognized names and jargon, add comma-separated entries to `SONIOX_CONTEXT_TERMS`.

**Q. Fixed lines (acks etc.) sound different from usual**
The TTS cache is missing and playback fell back to live synthesis. The cache key depends on `voiceId` / `FISH_AUDIO_SPEED` / `FISH_AUDIO_MODEL` / `TTS_SAMPLE_RATE`; re-run `node scripts/seed-tts-cache-from-fillers.js` after changing any of them ([seeding guide](docs/operations.md#実収録テイクのシード72--75)).

**Q. How do I check the delegation harness is working?**
It logs to `logs/metrics.jsonl` (JSONL). Aggregate with `node scripts/aggregate-metrics.js logs/metrics.jsonl`.

If none of this helps, open an [Issue](https://github.com/caty-ai/meetmate/issues) with logs (under `logs/`) and reproduction steps.

## Documentation

| Document | Contents |
|---|---|
| [docs/setup-guide.md](docs/setup-guide.md) | Detailed setup guide |
| [docs/architecture.md](docs/architecture.md) | Architecture deep dive |
| [docs/operations.md](docs/operations.md) | Full operations and tuning reference |
| [docs/deploy-checklist.md](docs/deploy-checklist.md) | Deployment checklist |
| [docs/deep-interview-79-delegation-harness.md](docs/deep-interview-79-delegation-harness.md) | Design spec of the delegation harness |

> ℹ️ Some documents under `docs/` are currently in Japanese; the reference tables and command snippets are language-neutral.

## Development

### Dev server

```bash
npm run dev   # auto-reload via node --watch
```

### Tests

Uses the Node.js built-in test runner (`node:test`). No external services required; the whole suite finishes in seconds.

```bash
node --test                       # all tests (35 test files)
npm run test:meet:repro           # only the Meet multi-participant reproduction test
```

### Smoke and operations scripts

| Script | Purpose |
|---|---|
| [`scripts/soniox-smoke.js`](scripts/soniox-smoke.js) | Soniox STT connectivity check |
| [`scripts/seed-tts-cache-from-fillers.js`](scripts/seed-tts-cache-from-fillers.js) | Pre-generate the TTS cache from recorded takes |
| [`scripts/aggregate-metrics.js`](scripts/aggregate-metrics.js) | Aggregate delegation-harness metrics |
| [`scripts/install-launchagent.sh`](scripts/install-launchagent.sh) | macOS launchd daemonization (with watchdog) |

### Logs

Runtime logs go under `logs/`. Application warnings/errors: `logs/meet-server.stderr.log` (under the launchd install; a plain `npm start` prints them to the terminal). Delegation metrics: `logs/metrics.jsonl`.

## Project status

- **Latest**: `v7.9.0-rc.1` (2026-07-07, in production with `GATEWAY_EVENTS_ENABLED=true`)
- **Stable**: [`v7.8.0-stable`](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
- **In progress**: npm distribution and public release track ([#136](https://github.com/caty-ai/meetmate/issues/136) / [#107](https://github.com/caty-ai/meetmate/issues/107))

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the issue-first workflow, branch discipline, and PR conventions.

## Acknowledgments

This project stands on the following services and projects:

- [Attendee](https://attendee.dev/) — bot participation API for Google Meet / Zoom
- [Soniox](https://soniox.com/) — real-time speech recognition (`stt-rt-v5`)
- [Fish Audio](https://fish.audio/) — expressive speech synthesis (S2-Pro)
- OpenClaw Gateway — agent infrastructure (SOUL / memory / skills / tools)

## License

[Apache License 2.0](LICENSE) — see also [NOTICE](NOTICE)
