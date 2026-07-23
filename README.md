# Meetmate

**English** | [日本語](README.ja.md) | [中文](README.zh.md) | [ไทย](README.th.md)

[![License: Apache--2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Meetings](https://img.shields.io/badge/works%20in-Google%20Meet%20%7C%20Zoom-7C3AED)](#what-it-does)
[![Server](https://img.shields.io/badge/runs%20on-Windows%20%7C%20macOS%20%7C%20Linux-444)](#try-it-in-30-seconds)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.svg">
  <img src="docs/images/hero-light.svg" alt="Meetmate — your AI agent, sitting in a meeting grid as a real participant" width="100%">
</picture>

**Bring your own AI agent into Google Meet & Zoom — as a real voice participant.**

Meetmate does exactly one thing: it gives *your* AI agent a seat in your meeting. It joins as a participant with a face and a voice — you call its name, it answers; you ask for something, it gets it done. We kept the scope that small on purpose, and polished that one thing relentlessly.

## What it does

- **It's a participant, not a notetaker.** Your agent shows up in the participant grid with its own avatar, listens to the room, and speaks — with wake-word detection and barge-in (talk over it and it stops).
- **It's *your* agent.** Connect the agent you already use — with its memory, personality, and skills — via OpenClaw Gateway, or plug in any OpenAI-compatible endpoint. The same "them" your team already knows walks into the room. No two Meetmates sound alike.
- **Ask it things, right there.** "Summarize where we landed and post it to the channel." Heavy work is delegated to a background session automatically, so the agent stays in the conversation while the task runs.
- **Ordinary is the point.** No push-to-talk, no special commands, no awkward silences. You talk to it the way you talk to a colleague — that this feels unremarkable is the product.
- **Works where you meet, runs where you work.** Google Meet and Zoom on the meeting side; Windows, macOS, and Linux on the server side. One config file, one avatar image, one command.

> 📸 Screenshots and a demo GIF of a live meeting are on the way.

## Try it in 30 seconds

> ℹ️ Until the first npm release is published, use the [from-source setup](#from-source) below.

```bash
mkdir my-agent && cd my-agent
npm install meetmate
npx meetmate init     # asks for the 3 API keys, creates config.json + .env, prints next steps
npx meetmate start    # starts the server and prints the settings-UI URL
```

Open http://localhost:5005, paste a Meet or Zoom URL, and your agent joins the meeting. Call its wake word and start talking.

Prerequisites (Node.js ≥ 22, API keys for [Attendee](https://attendee.dev/) meeting bots, [Soniox](https://soniox.com/) speech-to-text, and [Fish Audio](https://fish.audio/) voice) are walked through step-by-step in the [Setup guide](docs/setup-guide.md).

### From source

```bash
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env && cp config.json.example config.json   # then fill in the keys
npm start
```

## Why we built this

Meetings are where humans actually collaborate — decisions, nuance, tone, the "oh wait, one more thing" moments. If your AI agent lives only in a chat box, it misses all of that.

We believe agents should sit where their humans sit. Not as a transcription bot at the edge of the call, but as a colleague in the grid: present, addressable, useful. And because it's *your* agent — with its own memory and character — the difference is between "an AI joined the call" and "*she* joined the call."

Meetmate is deliberately a small tool. It doesn't try to run your meeting, score your calls, or replace your calendar. It puts your agent in the room. Everything else is up to the two of you.

## How it works

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'primaryColor': '#EEEBFB', 'primaryTextColor': '#10131A', 'primaryBorderColor': '#7C3AED',
  'secondaryColor': '#F1F3F7', 'secondaryTextColor': '#10131A', 'secondaryBorderColor': '#E2E5EC',
  'mainBkg': '#F1F3F7', 'nodeBorder': '#E2E5EC', 'lineColor': '#7C3AED',
  'textColor': '#10131A', 'edgeLabelBackground': '#FFFFFF',
  'fontFamily': '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
}}}%%
flowchart LR
    M["Google Meet / Zoom"] -->|meeting audio| S["Speech to text"]
    S --> W{"Wake word?"}
    W -->|yes| L["Your agent<br/>(OpenClaw Gateway or<br/>OpenAI-compatible LLM)"]
    L --> T["Text to speech"]
    T -->|agent's voice| M
    L -.->|heavy tasks| B["Background delegation"]
```

One agent = one server instance. The server bridges meeting audio into a speech pipeline (speech-to-text → your agent's LLM → text-to-speech) and streams the reply back into the call — fast enough to feel like conversation.

Full engineering detail — architecture, module map, providers, audio specs — lives in [docs/TECHNICAL.md](docs/TECHNICAL.md).

## Configuration

Entry points for the most common tweaks. The full reference is [docs/operations.md](docs/operations.md).

| I want to… | Look at |
|---|---|
| Connect my own agent (OpenClaw Gateway) | [Setup guide](docs/setup-guide.md) |
| Use a generic OpenAI-compatible endpoint | [TECHNICAL.md — LLM providers](docs/TECHNICAL.md#llm-providers) |
| Make responses come back faster | [Soniox tuning](docs/operations.md#stt-プロバイダ切替soniox-チューニング) |
| Change the voice, speed, or TTS behavior | [Voice profile](docs/operations.md#音声プロファイルtts) |
| Use background delegation for heavy work | [Delegation harness](docs/operations.md#委譲強制ハーネス79) |
| Control meetings from Claude Code (MCP) | [TECHNICAL.md — MCP server](docs/TECHNICAL.md#mcp-server-control-plane) |

Something not working? See [Troubleshooting](docs/TECHNICAL.md#troubleshooting).

## Documentation

| Document | Contents |
|---|---|
| [docs/setup-guide.md](docs/setup-guide.md) | Zero-to-first-meeting, step by step |
| [docs/TECHNICAL.md](docs/TECHNICAL.md) | Features in detail, architecture, providers, MCP, development |
| [docs/architecture.md](docs/architecture.md) | Architecture deep dive |
| [docs/operations.md](docs/operations.md) | Full operations and tuning reference |
| [docs/deploy-checklist.md](docs/deploy-checklist.md) | Deployment checklist |

> ℹ️ Some documents under `docs/` are currently in Japanese; the reference tables and command snippets are language-neutral.

## Project status

- **Releases**: See [GitHub Releases](https://github.com/caty-ai/meetmate/releases) for published versions.
- **In progress**: npm distribution and public release track ([#136](https://github.com/caty-ai/meetmate/issues/136) / [#107](https://github.com/caty-ai/meetmate/issues/107))

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). We use an issue-first flow and Conventional Commits.

## Acknowledgments

Meetmate stands on excellent services and OSS: [Attendee](https://attendee.dev/) (meeting bot infrastructure), [Soniox](https://soniox.com/) (real-time STT), [Fish Audio](https://fish.audio/) (expressive TTS), and the OpenAI-compatible LLM ecosystem.

## License

[Apache-2.0](LICENSE)
