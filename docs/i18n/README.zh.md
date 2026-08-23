# Meetmate

[English](https://github.com/caty-ai/meetmate/blob/main/README.md) | [日本語](https://github.com/caty-ai/meetmate/blob/main/docs/i18n/README.ja.md) | **中文** | [ไทย](https://github.com/caty-ai/meetmate/blob/main/docs/i18n/README.th.md)

> 本文档是 [README.md](https://github.com/caty-ai/meetmate/blob/main/README.md)(英文版,为正本)的翻译。如内容出现不一致,以英文版为准。

[![CI](https://github.com/caty-ai/meetmate/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/caty-ai/meetmate/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/caty-ai/meetmate/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/meetmate?logo=npm&label=npm)](https://www.npmjs.com/package/meetmate)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D26-blue?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Meetings](https://img.shields.io/badge/works%20in-Google%20Meet%20%7C%20Zoom-blue)](#它能做什么)
[![Server](https://img.shields.io/badge/runs%20on-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#快速上手)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/hero-dark.svg">
  <img src="https://raw.githubusercontent.com/caty-ai/meetmate/main/docs/images/hero-light.svg" alt="Meetmate —— 你的 AI 智能体作为一名真正的参会者,坐在会议网格中" width="100%">
</picture>

**把你的 AI 智能体带进 Google Meet 和 Zoom —— 作为一名真正能开口说话的参会者。**

Meetmate 只做一件事:给*你的* AI 智能体在会议里留一个座位。它以有头像、有声音的参会者身份加入——你叫它的名字,它会回应;你交代事情,它会办妥。我们刻意把范围收得这么小,然后把这一件事打磨到极致。

## 快速上手

**你需要准备:** Node.js ≥ 26 · [Attendee](https://attendee.dev/) 账号 · 用于语音转文字的 [Soniox](https://soniox.com/)(或 [Deepgram](https://deepgram.com/)) · 用于语音合成的 [Fish Audio](https://fish.audio/)(包含语音 ID) · 一个 LLM 端点(OpenClaw Gateway 或任意 OpenAI 兼容端点) · 通常还需要 [ngrok](https://ngrok.com/) 或 [Tailscale](https://tailscale.com/) · 另外 Google Meet 会要求你批准机器人加入。第三方服务可能需要付费。

在一个空文件夹中:

```bash
npm install meetmate
npx meetmate init     # 向导会收集你的 API 密钥、语音 ID 和 LLM 端点 —— 并告诉你去哪里获取每一项
npx meetmate start    # 启动服务器并打印设置界面 URL
```

打开打印出来的 URL,粘贴 Meet 或 Zoom 链接,点击 **Join**。在 Meet 中批准机器人的“Ask to join”请求——然后叫它的唤醒词,开始说话。ngrok/Tailscale 和 Meet 的入会批准步骤仍需手动完成;向导结束时的提示和[安装指南](https://github.com/caty-ai/meetmate/blob/main/docs/setup-guide.md)会带你走完这些步骤。

## 它能做什么

- **它是参会者,不是会议纪要机器人。** 你的智能体带着自己的头像出现在参会者网格里,听会场讨论,开口说话——支持唤醒词检测和插话打断(你直接盖过它说话,它就会乖乖停下来)。
- **它是“你的”智能体。** 通过 OpenClaw Gateway,接入你已经在用的那个智能体——连同它的记忆、性格和技能。团队熟悉的那个“老搭档”,就这样走进会议室,所以没有两个 Meetmate 说话是一个味儿的。(没有 Gateway?任何 OpenAI 兼容端点也能用,作为更简单的基线:普通 LLM + 内置人设——见 [LLM providers](https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md#llm-providers)。)
- **当场就能派活。** “把刚才讨论的结论总结一下,发到频道里。”重活会自动委派给后台会话,所以智能体一边继续参与对话,任务一边推进。
- **“平平无奇”正是卖点。** 不用按键发言,没有特殊命令,没有尴尬的沉默。你像跟同事说话一样跟它说话——这种“没什么特别”的感觉,本身就是产品。
- **在哪开会都行,在哪运行都行。** 会议侧支持 Google Meet 和 Zoom;服务器侧支持 Windows、macOS 和 Linux。一份配置、几个 API 密钥、一条命令——头像图片想换就换。

> 📸 真实会议中的截图和演示 GIF 正在路上。

## 当前状态

| 领域 | 现状 | 备注 |
|---|---|---|
| OpenClaw Gateway | 已支持 | 目前的主路径：记忆、技能、工具和委派都留在你现有的智能体上。 |
| OpenAI 兼容基线 | 已支持 | 面向任意兼容端点的纯语音智能体模式。 |
| 通过 OpenAI 兼容网关接入 Claude Code | 集成进行中 | 使用通用的 `openai-compatible` 提供方。没有 Claude 专属的提供方分支。在真实 Google Meet 端到端验证通过之前,我们不会称其为"已支持"。 |
| Hermes api_server | 端点已验证,Meetmate 侧接线仍待完成 | 截至 2026 年 7 月 12 日,issue [#1](https://github.com/caty-ai/meetmate/issues/1) 已确认 `POST /v1/chat/completions`、SSE、Bearer 认证以及 profile/persona 注入。剩余工作是令牌交接以及 Meetmate 的 smoke/E2E 测试。 |
| Codex / Kimi Code | 计划中 | 尚未接入。 |
| 会议网格中的头像 | 目前是静态图片 | 动态头像已在 [#2](https://github.com/caty-ai/meetmate/issues/2) 中规划。 |

## 平台说明

| 主题 | 当前实际情况 |
|---|---|
| Google Meet | 主路径。请从这里开始。 |
| Zoom | 目前适用于你自己主持/管理的会议。暂不要假设支持外部主办的 Zoom 会议、OBF,或托管式 OAuth 设置。 |
| MCP 与语音大脑 | Meetmate 的 MCP 服务器是 `join` / `leave` / `status` 的控制平面。语音大脑是独立的:你真正的智能体运行在 OpenClaw 或另一个 OpenAI 兼容网关背后,并在会议中开口说话。 |

## 你需要准备

`init` 向导会替你收集 API 密钥、语音 ID 和 LLM 端点;ngrok/Tailscale 和 Meet 的入会批准步骤仍需手动完成。下表是每一项是什么、何时需要的参考。

| 项目 | 用途 | 设置名称 | 何时需要 | 备注 |
|---|---|---|---|---|
| Node.js 26+ | 运行服务器 | `node`, `npm` | 始终 | 必需。 |
| [Attendee](https://attendee.dev/) 账号 + API 密钥 | 会议机器人加入/离开 + 音频收发 | `ATTENDEE_API_KEY` | 始终 | 托管服务;请确认当前的免费/付费可用情况。 |
| [Soniox](https://console.soniox.com/) 账号 + API 密钥 | 默认语音转文字 | `STT_PROVIDER=soniox`, `SONIOX_API_KEY` | 通常 | 默认路径。价格/试用条款可能变化。 |
| [Deepgram](https://console.deepgram.com/signup) 账号 + API 密钥 | 可选的替代语音转文字 | `STT_PROVIDER=deepgram`, `DEEPGRAM_API_KEY` | 可选 | 仅在你切换出 Soniox 时需要。 |
| [Fish Audio](https://fish.audio/) 账号 + 语音 | 文字转语音的声音 | `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID`, `TTS_PROVIDER=fish-audio` | 始终 | 语音 ID 来自语音页面的 URL。价格/试用条款可能变化。 |
| OpenClaw Gateway 或其他 OpenAI 兼容 LLM 网关 | 真正的语音大脑 | `LLM_PROVIDER`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`,或 `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY` | 始终 | OpenClaw 是主路径;有状态的 OpenAI 兼容网关记录在安装指南中。 |
| [ngrok](https://ngrok.com/) 或 [Tailscale](https://tailscale.com/) | 机器人 WebSocket 的公网可达路径 | ngrok 用 `server.ngrokDomain` | 视情况而定 | `ngrok` 是常见路径。如果你的网络和 Attendee 部署允许,Tailscale 是一种替代方案。价格/免费方案细节可能变化。 |
| 允许机器人加入的 Google Meet 权限 | 让机器人进入会议 | Meet UI 的"Ask to join"批准 | Google Meet | 你必须在 Meet 中批准加入请求。 |
| [Zoom Marketplace](https://marketplace.zoom.us/) 应用/管理员设置 | Zoom 机器人权限模型 | Attendee/Zoom 侧应用设置 | 仅 Zoom | 视情况而定。不声称支持外部主办的会议和托管式 OAuth。 |

所有密钥和令牌保存在 `.env` 中（openai-compatible 的 apiKey 则在 `config.json` 中——向导会自动写入正确位置）。这两个文件都不要提交,也不要提交密钥截图或含有有效凭据的共享配置文件。

如果你接入了具备工具调用能力的 OpenAI 兼容网关,请把这条路径限制在本地且可信的范围内。Meetmate 的信任选项仅适用于可信本地网关下的可信会议;外部或不可信的会议在该模式下仍不受支持。

<a id="from-source"></a>

## 从源代码运行(面向贡献者)

```bash
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env && cp config.json.example config.json   # 然后填入密钥
npm start
```

## 我们为什么做它

会议才是人类真正协作的地方——决定、细微的语气、“诶等等,还有一件事”的瞬间。如果你的 AI 智能体只活在聊天框里,这些它全都错过了。

我们相信,智能体应该坐在它主人坐的地方。不是作为通话边缘的转写机器人,而是网格里的一位同事:在场、可被点名、派得上用场。而且因为它是*你的*智能体——带着自己的记忆和性格——区别就在于“有个 AI 进了会议”和“***她***进来了”。

Meetmate 刻意做一个小工具。它不想主持你的会议,不想给你的通话打分,也不想取代你的日历。它把你的智能体带进会议室。剩下的,是你们俩的事。

## 工作原理

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'primaryColor': '#EEEBFB', 'primaryTextColor': '#10131A', 'primaryBorderColor': '#7C3AED',
  'secondaryColor': '#F1F3F7', 'secondaryTextColor': '#10131A', 'secondaryBorderColor': '#E2E5EC',
  'mainBkg': '#F1F3F7', 'nodeBorder': '#E2E5EC', 'lineColor': '#7C3AED',
  'textColor': '#10131A', 'edgeLabelBackground': '#FFFFFF',
  'fontFamily': '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
}}}%%
flowchart LR
    M["Google Meet / Zoom"] -->|会议音频| S["语音转文字"]
    S --> W{"唤醒词?"}
    W -->|yes| L["你的智能体<br/>(OpenClaw Gateway 或<br/>OpenAI 兼容 LLM)"]
    L --> T["文字转语音"]
    T -->|智能体的声音| M
    L -.->|重型任务| B["后台委派"]
```

一个智能体 = 一个服务器实例。服务器把会议音频接入语音流水线(语音转文字 → 你的智能体的 LLM → 文字转语音),再把回复流式送回通话——快到感觉就像正常对话。

完整的工程细节——架构、模块地图、服务商、音频规格——都在 [docs/TECHNICAL.md](https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md)。

## 配置

常见调整的入口。完整参考见 [docs/operations.md](https://github.com/caty-ai/meetmate/blob/main/docs/operations.md)。

| 我想…… | 看这里 |
|---|---|
| 接入我自己的智能体(OpenClaw Gateway) | [安装指南](https://github.com/caty-ai/meetmate/blob/main/docs/setup-guide.md) |
| 使用通用的 OpenAI 兼容端点 | [TECHNICAL.md — LLM providers](https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md#llm-providers) |
| 让响应更快返回 | [Soniox 调优](https://github.com/caty-ai/meetmate/blob/main/docs/operations.md#stt-プロバイダ切替soniox-チューニング) |
| 更换声音、语速或 TTS 行为 | [声音配置](https://github.com/caty-ai/meetmate/blob/main/docs/operations.md#音声プロファイルtts) |
| 用后台委派处理重活 | [委派机制](https://github.com/caty-ai/meetmate/blob/main/docs/operations.md#委譲強制ハーネス79) |
| 出问题时回滚到之前的设置 | [紧急回滚 env](https://github.com/caty-ai/meetmate/blob/main/docs/operations.md#緊急-rollback-用-env) |
| 从 Claude Code 控制会议(MCP) | [TECHNICAL.md — MCP server](https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md#mcp-server-control-plane) |
| 让你真正的智能体成为语音大脑 | [设置指南](https://github.com/caty-ai/meetmate/blob/main/docs/setup-guide.md) |

遇到问题了?查看[故障排查](https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md#troubleshooting)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/setup-guide.md](https://github.com/caty-ai/meetmate/blob/main/docs/setup-guide.md) | 从零到第一场会议,步步引导 |
| [docs/TECHNICAL.md](https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md) | 功能详解、架构、服务商、MCP、开发 |
| [docs/architecture.md](https://github.com/caty-ai/meetmate/blob/main/docs/architecture.md) | 架构深入解析 |
| [docs/operations.md](https://github.com/caty-ai/meetmate/blob/main/docs/operations.md) | 完整的运维与调优参考 |
| [docs/deploy-checklist.md](https://github.com/caty-ai/meetmate/blob/main/docs/deploy-checklist.md) | 部署清单 |

> ℹ️ `docs/` 下的部分文档目前为日语；其中的参考表格与命令片段不受语言影响，可直接使用。

## 项目状态

- **发布**:已发布版本见 [GitHub Releases](https://github.com/caty-ai/meetmate/releases)。
- **进行中**:npm 分发与公开发布轨道([#3](https://github.com/caty-ai/meetmate/issues/3) / [#4](https://github.com/caty-ai/meetmate/issues/4))

## 参与贡献

欢迎提 Issue 和 PR——见 [CONTRIBUTING.md](https://github.com/caty-ai/meetmate/blob/main/CONTRIBUTING.md)。我们采用 issue 优先的流程和 Conventional Commits。

## 致谢

Meetmate 站在优秀的服务和开源软件之上:[Attendee](https://attendee.dev/)(会议机器人基础设施)、[Soniox](https://soniox.com/)(实时语音转文字)、[Fish Audio](https://fish.audio/)(富有表现力的语音合成)、OpenClaw Gateway(智能体基础设施——SOUL / 记忆 / 技能 / 工具),以及 OpenAI 兼容 LLM 生态。

## 许可证

[MIT](https://github.com/caty-ai/meetmate/blob/main/LICENSE) —— 署名信息见 [NOTICE](https://github.com/caty-ai/meetmate/blob/main/NOTICE)。
