# AI Meet Participant

[English](README.md) | [日本語](README.ja.md) | **中文** | [ไทย](README.th.md)

> 本文档是 [README.md](README.md)（英文原版）的翻译。如内容有出入，以英文版为准。

[![Version](https://img.shields.io/badge/version-v7.9.0--rc.1-blue)](https://github.com/caty-ai/meetmate/releases)
[![Stable](https://img.shields.io/badge/stable-v7.8.0-brightgreen)](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
[![License: Apache--2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Google%20Meet%20%7C%20Zoom-4285F4)](#功能特性)

一个让 AI 智能体以实时语音参与者身份加入 Google Meet / Zoom 的桥接服务器。通过 OpenClaw Gateway 集成，任何智能体都可以接入语音会议并对话。

```
STT (Soniox) → 唤醒词检测 → LLM (默认 OpenClaw Gateway) → TTS (Fish Audio S2-Pro) → Meet / Zoom
```

## 目录

- [功能特性](#功能特性)
- [截图](#截图)
- [架构](#架构)
- [快速开始](#快速开始)
- [配置](#配置)
- [故障排查](#故障排查)
- [文档](#文档)
- [开发](#开发)
- [项目状态](#项目状态)
- [参与贡献](#参与贡献)
- [致谢](#致谢)
- [许可证](#许可证)

## 功能特性

- **支持 Google Meet / Zoom** — 通过 Attendee bot API 加入会议
- **OpenClaw Gateway 集成** — 完整支持 SOUL / memory / skills / tools
- **唤醒词检测 + 插话打断**（barge-in，可打断智能体发言）
- **低延迟 STT** — 默认 Soniox `stt-rt-v5`；设置 `STT_PROVIDER=deepgram` 可切换到 Deepgram
- **富有表现力的 TTS** — Fish Audio S2-Pro（emotion-tag anchor 方案保持音色稳定）
- **固定台词 TTS 缓存** — 应答 / 提示音 / 问候 / 告别等从 PCM 磁盘缓存即时播放；支持用真实录音预填充
- **委派执行框架** — 繁重任务被强制委派到后台会话，前台智能体专注对话（[#79](https://github.com/caty-ai/meetmate/issues/79)）
- **会议聊天发帖** — LLM 回复中的 `[[[chat: ...]]]` 标签不朗读，而是发到会议聊天区
- **表情符号防护** — 两层结构：LLM 提示词禁用 + TTS 前机械过滤
- **LCM（Lossless Context Management）自动记录** / **Slack 联动**（状态通知、摘要、完整记录）

## 截图

<!-- TODO: 图片放入 docs/images/ 后取消注释
![控制界面](docs/images/ui-join.png)
![会议进行中](docs/images/in-meeting.png)
-->

在浏览器中打开 http://localhost:5005，粘贴 Meet / Zoom 的 URL，智能体即可加入会议。会议中头像（`assets/avatar.png`）会显示为参与者磁贴，用唤醒词呼叫即可获得语音回应。

> 📸 截图与演示 GIF 正在准备中。

## 架构

**一个智能体 = 一个服务器实例。** 只需 `config.json` + `.env` + 头像图片即可运行任意智能体。

输入侧 STT 为 16 kHz，输出侧 TTS / `bot_output` 为 24 kHz。Attendee 的输入通道与输出通道相互独立。

### 主要模块

| 模块 | 职责 |
|---|---|
| [`src/pipeline.js`](src/pipeline.js) | 音频管线控制 |
| [`src/agent-profile.js`](src/agent-profile.js) | 智能体配置解析 |
| [`src/paths.js`](src/paths.js) | 主目录契约（`AI_MEET_HOME`）— 见[数据目录](#数据目录ai_meet_home) |
| [`src/llm-provider.js`](src/llm-provider.js) | LLM 提供方切换（默认 OpenClaw / OpenAI 兼容） |
| [`src/stt-provider.js`](src/stt-provider.js) | STT 提供方切换（默认 soniox / deepgram） |
| [`src/stt-soniox.js`](src/stt-soniox.js) | Soniox STT（stt-rt-v5，WebSocket） |
| [`src/stt.js`](src/stt.js) | Deepgram STT（备选） |
| [`src/tts-fish.js`](src/tts-fish.js) | Fish Audio TTS |
| [`src/speech-policy.js`](src/speech-policy.js) | NO_REPLY 抑制、文本净化 |
| [`src/exit-handler.js`](src/exit-handler.js) | 退出检测与清理 |

详见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

### 前提条件

- Node.js 22 或更高（依据 `package.json` 的 `engines`）
- LLM 提供方：`openclaw`（默认）或 `openai-compatible`
  - `openclaw` 需要 OpenClaw Gateway，提供包括 SOUL / memory / skills / tools 在内的完整智能体体验
  - `openai-compatible` 连接任意 OpenAI 兼容 API，无需 OpenClaw Gateway
- 各服务的 API 密钥（Soniox / Fish Audio / Attendee）
  - [Attendee](https://attendee.dev/) 是将 bot 接入 Google Meet / Zoom 的 SaaS（也有自托管版）。bot 的进出会与音频输入输出均通过 Attendee API
  - Fish Audio 的 Voice ID：在 [fish.audio](https://fish.audio/) 打开想用的声音（自制或公开声音）页面，复制 URL 末尾的 ID

### 方式 A：npm 包（推荐）

> ℹ️ 在首个 npm 版本发布之前，请使用下方的[方式 B](#方式-b从源码运行)。

```bash
mkdir my-agent && cd my-agent
npm install ai-meet-participant
npx ai-meet init    # 交互式询问 3 个 API 密钥，然后生成 config.json 和 .env
npx ai-meet start   # 启动服务器并打印设置界面的 URL
```

`init` 会把随包附带的 `config.json.example` / `.env.example` 复制到**当前目录**，并填入你输入的凭据（`SONIOX_API_KEY`、`FISH_AUDIO_API_KEY`、`ATTENDEE_API_KEY`）。若已存在同名文件则拒绝覆盖，除非加 `--force`。之后编辑 `config.json` 设置智能体名称、唤醒词和固定台词。

### 方式 B：从源码运行

```bash
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env        # 填入密钥
cp config.json.example config.json
npm start
```

在浏览器中打开 http://localhost:5005，粘贴 Meet / Zoom 的 URL 并点击加入。

> 💡 如果唤醒词识别不稳定，可用 **wake-calibrate** 功能（`/calibrate`，通过 `WAKE_CALIBRATE_ENABLED=1` 启用）在浏览器中从真实发音收集误识别变体。参见 [docs/setup-guide.md](docs/setup-guide.md)。

### 数据目录（`AI_MEET_HOME`）

服务器**写入**的所有内容以及用户配置都集中在一个 *home* 目录中 —— 默认为**当前工作目录**，可通过环境变量 `AI_MEET_HOME` 更改：

| 路径（home 下） | 内容 |
|---|---|
| `config.json` / `.env` | 智能体配置与凭据 |
| `logs/` | 运行日志与委派指标（`metrics.jsonl`） |
| `assets/avatar.png` | 可选的头像覆盖（未放置时回退到随包默认图片） |
| `assets/tts-cache/` | 固定台词 TTS 缓存 |

只读的随包资源（Web UI、默认头像、填充音频）始终从已安装的包本身读取。`TTS_CACHE_DIR` 与 `METRICS_LOG_DIR` 作为显式覆盖仍然有效。从源码 checkout 运行 `npm start` 时 home 即仓库根目录，因此源码方式的行为不变。

### 环境变量（`.env`）

| 变量 | 用途 |
|---|---|
| `LLM_PROVIDER` | LLM 提供方（`openclaw`（默认）/ `openai-compatible`） |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway URL（`openclaw` 必需，如 `http://localhost:18789`） |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 认证令牌（`openclaw` 必需） |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI 兼容 API 的基础 URL（`openai-compatible` 必需） |
| `OPENAI_COMPATIBLE_API_KEY` | OpenAI 兼容 API 密钥（`openai-compatible` 必需） |
| `SONIOX_API_KEY` | STT（默认提供方 Soniox） |
| `FISH_AUDIO_API_KEY` | TTS |
| `FISH_AUDIO_VOICE_ID` | TTS 声音 ID（声音克隆） |
| `ATTENDEE_API_KEY` | Meet / Zoom bot API |

可选变量（`PORT`、`AGENT_LANG`、Slack 集成等）与全部调优参考见 [docs/operations.md](docs/operations.md)。

### 智能体配置（`config.json`）

智能体 ID / 显示名 / 唤醒词 / 固定台词（greeting、ackVariants、progressPings 等）以及 TTS / STT / Slack / Attendee 的设置都集中于此。`config.json.example` 已按 emotion-tag anchor 方案（S2-Pro 用）对齐，复制后填入变量即可运行。

### LLM 提供方

| `llm.provider` / `LLM_PROVIDER` | 行为 |
|---|---|
| `openclaw` | 默认。通过 OpenClaw Gateway 使用 SOUL / memory / skills / tools |
| `openai-compatible` | 直接调用 OpenAI 兼容 API。无需 OpenClaw Gateway |

`openai-compatible` 是降级模式：用普通 LLM 加内置人设模板进行语音应答。它是未配置 Gateway 时的 OSS 最低保证；OpenClaw 专属的 memory / skills / tools 不可用。Claude 模型需经 OpenAI 兼容代理（如 LiteLLM）使用；没有 Anthropic 原生适配器（[#114](https://github.com/caty-ai/meetmate/issues/114)）。

如果在 `config.json` 中选择 `openai-compatible`，请同步设置 `.env` 的 `LLM_PROVIDER`（环境变量优先于 `config.json`）。`config.json` 中未解析的 `${...}` 占位符（未设置或留空）**会导致启动时报错退出**，因此不使用的功能的 env（`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `SLACK_BOT_TOKEN` 等）也请保留虚拟值，不要删除或留空 —— 或者把相应块从 `config.json` 中整块删除。

`config.json` 的 `llm` 模式如下：

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

`provider` / `temperature` / `maxTokens` / `openaiCompatible` 的解析顺序为：会话级 overrides → agent 设置 → 环境变量 → `configJson.llm` → 默认值。对应的环境变量为 `LLM_PROVIDER`、`AGENT_TEMPERATURE`、`AGENT_MAX_TOKENS`、`OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_COMPATIBLE_API_KEY`。`model` 与 `historyMaxTurns` 不读取环境变量，按 overrides → agent 设置 → `configJson.llm` → 默认值解析。`openai-compatible` 的 `systemPrompt` 按 `overrides.prompt` → `configJson.llm.systemPrompt` → 内置人设的顺序解析，并附加语音专用规则。

请求发送到 `{baseUrl}/v1/chat/completions`；若 `baseUrl` 已以 `/v1` 结尾则不会重复。未知的提供方名称会警告并回退到 `openclaw`。

### MCP 服务器（控制平面）

一个轻量 stdio MCP 服务器，让 LLM 客户端（Claude Code、其他智能体）直接控制会议参与 — 语音管线本身不在 MCP 范围内。注册方式：

```bash
claude mcp add ai-meet -- npx ai-meet mcp
```

环境变量：`AI_MEET_BASE_URL` 指定要控制的 REST API（默认 `http://localhost:5005`）；`AI_MEET_JOIN_TOKEN` 可选，会作为 `x-join-token` 头和 `joinToken` 字段转发；`AI_MEET_JOIN_TIMEOUT_MS` 调整 `join_meeting` 的等待时间（默认 60000 ms — 加入在服务器侧最长可能需要约 50 秒；其他工具为 15 秒）。

| 工具 | 行为 |
|---|---|
| `join_meeting(meetingUrl, briefing?, conversationMode?)` | 加入 Meet / Zoom 会议（代理 `POST /join-meeting`；WebSocket URL 自动推导） |
| `leave_meeting(sessionId?)` | 离开活动会话（或指定会话） |
| `get_active_session()` | 以 JSON 列出活动会话 |
| `health()` | 服务健康检查 |

## 配置

这里只汇总常用调整入口。完整参考见 [docs/operations.md](docs/operations.md)。

| 我想… | 查看 |
|---|---|
| 让回应更快返回 | [Soniox 调优](docs/operations.md#stt-プロバイダ切替soniox-チューニング) |
| 更改声音、语速或 TTS 行为 | [声音配置](docs/operations.md#音声プロファイルtts) |
| 出问题时回滚到旧设置 | [紧急回滚 env](docs/operations.md#緊急-rollback-用-env) |
| 使用后台委派处理繁重任务 | [委派框架](docs/operations.md#委譲強制ハーネス79) |
| 用真实录音填充 TTS 缓存 | [录音预填充](docs/operations.md#実収録テイクのシード72--75) |

## 故障排查

**Q. 我说完后回应返回很慢**
在 `.env` 中设置 `SONIOX_MAX_ENDPOINT_DELAY_MS=1000`（未设置时采用 Soniox 服务端默认值 `2000`；必要时 `800`）并重启服务器。若发言开始被中途截断，将 `SONIOX_ENDPOINT_SENSITIVITY` 向 `0.0〜-0.2` 调低。详见 [Soniox 调优](docs/operations.md#stt-プロバイダ切替soniox-チューニング)。

**Q. 向会议聊天发帖失败**
包含表情符号或罕见文字的消息会被 Attendee 服务器以 400 拒绝（"Message cannot contain emojis or rare script characters."）。在 launchd 常驻运行时，发送失败的警告输出到 `logs/meet-server.stderr.log`（直接 `npm start` 时输出到终端 stderr），请先查看。

**Q. TTS 音色不稳定、失控**
S2-Pro 在无标签发言时容易音色失控，因此设计上假定"锚点方案"：每次发言带一个情感标签（[声音配置](docs/operations.md#音声プロファイルtts)）。若仍不稳定，`FISH_AUDIO_MODEL=s1` 可立即回滚到旧模型。

**Q. STT 识别突然变差**
在 `.env` 中设置 `STT_PROVIDER=deepgram` 并重启即可立即切换到 Deepgram。人名、术语的误识别可在 `SONIOX_CONTEXT_TERMS` 中以逗号分隔登记来改善。

**Q. 固定台词（应答等）的声音和平时不一样**
TTS 缓存未命中，回退到了实时合成。缓存键依赖 `voiceId` / `FISH_AUDIO_SPEED` / `FISH_AUDIO_MODEL` / `TTS_SAMPLE_RATE`，修改这些后请重新运行 `node scripts/seed-tts-cache-from-fillers.js`（[预填充步骤](docs/operations.md#実収録テイクのシード72--75)）。

**Q. 如何确认委派框架在工作？**
以 JSONL 记录在 `logs/metrics.jsonl`。可用 `node scripts/aggregate-metrics.js logs/metrics.jsonl` 汇总。

若仍未解决，请附上日志（`logs/` 下）和复现步骤到 [Issues](https://github.com/caty-ai/meetmate/issues) 报告。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/setup-guide.md](docs/setup-guide.md) | 详细安装指南 |
| [docs/architecture.md](docs/architecture.md) | 架构解析 |
| [docs/operations.md](docs/operations.md) | 运维与调优完整参考 |
| [docs/deploy-checklist.md](docs/deploy-checklist.md) | 部署检查清单 |
| [docs/deep-interview-79-delegation-harness.md](docs/deep-interview-79-delegation-harness.md) | 委派框架设计规格 |

> ℹ️ `docs/` 下部分文档目前为日文；参考表格与命令片段与语言无关。

## 开发

### 开发服务器

```bash
npm run dev   # 通过 node --watch 自动重载启动
```

### 测试

使用 Node.js 内置 test runner（`node:test`）。无外部依赖，数秒内跑完全部测试。

```bash
node --test                       # 全部测试（35 个测试文件）
npm run test:meet:repro           # 仅 Meet 多参与者复现测试
```

### 冒烟与运维脚本

| 脚本 | 用途 |
|---|---|
| [`scripts/soniox-smoke.js`](scripts/soniox-smoke.js) | Soniox STT 连通性检查 |
| [`scripts/seed-tts-cache-from-fillers.js`](scripts/seed-tts-cache-from-fillers.js) | 从真实录音预生成 TTS 缓存 |
| [`scripts/aggregate-metrics.js`](scripts/aggregate-metrics.js) | 委派框架指标汇总 |
| [`scripts/install-launchagent.sh`](scripts/install-launchagent.sh) | macOS launchd 常驻化（带 watchdog） |

### 日志

运行日志输出在 `logs/` 下。应用侧 warn/error 见 `logs/meet-server.stderr.log`（launchd 常驻时；直接 `npm start` 时输出到终端），委派框架指标见 `logs/metrics.jsonl`。

## 项目状态

- **最新版**：`v7.9.0-rc.1`（2026-07-07，以 `GATEWAY_EVENTS_ENABLED=true` 在生产运行中）
- **稳定版**：[`v7.8.0-stable`](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
- **进行中**：npm 分发与公开发布（[#136](https://github.com/caty-ai/meetmate/issues/136) / [#107](https://github.com/caty-ai/meetmate/issues/107)）

## 参与贡献

欢迎贡献。Issue 优先的开发流程、分支规范与 PR 写法见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

本项目建立在以下服务与项目之上：

- [Attendee](https://attendee.dev/) — Google Meet / Zoom 的 bot 接入 API
- [Soniox](https://soniox.com/) — 实时语音识别（`stt-rt-v5`）
- [Fish Audio](https://fish.audio/) — 富有表现力的语音合成（S2-Pro）
- OpenClaw Gateway — 智能体基础设施（SOUL / memory / skills / tools）

## 许可证

[Apache License 2.0](LICENSE) — 另见 [NOTICE](NOTICE)
