<div align="center">

![Mercury — 把中文 MP3 变成可交付字幕](https://raw.githubusercontent.com/dingshuxin353/mercury-subtitles/main/assets/readme-cover.svg)

# Mercury

**把中文 MP3 变成可检查、可修改、可交付的字幕。**

[![npm latest](https://img.shields.io/npm/v/mercury-subtitles/latest?label=npm%20latest&color=5b5bd6)](https://www.npmjs.com/package/mercury-subtitles)
[![Node 24](https://img.shields.io/badge/Node.js-24-3c873a)](https://nodejs.org/)
[![CI](https://github.com/dingshuxin353/mercury-subtitles/actions/workflows/ci.yml/badge.svg)](https://github.com/dingshuxin353/mercury-subtitles/actions/workflows/ci.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Stable](https://img.shields.io/badge/status-Stable-2f855a)](https://github.com/dingshuxin353/mercury-subtitles/releases)

[三步开始](#三步开始) · [CLI / App](#方式一直接使用-cli--app) · [Agent Skill](#方式二让-agent-通过-skill-使用) · [隐私说明](#你的数据会去哪里) · [遇到问题](#常见问题)

</div>

> [!IMPORTANT]
> Mercury `0.3.0` 是 V0.3 稳定版，面向愿意安装 Node.js 24 的 CLI 与 Agent 用户。处理重要素材时仍建议保留原文件，并先用副本熟悉工作流。

## 你会得到什么

一份 MP3 最多会得到三份用途明确的字幕，以及一份报告：

| 产物 | 适合什么时候用 |
| --- | --- |
| `*.transcribed.srt` | 云端语音转文字的原始结果；方便比较 ASR 到底听出了什么。 |
| `*.calibrated.srt` | AI 结合完整正文和可用音频校对错字后的版本；cue 数量、顺序和毫秒时间轴与纯转写完全相同。 |
| `*.approved.srt` | 你逐项接受、驳回或编辑后生成的批准稿；这是最适合交付的版本。 |
| `calibration-report.md` | 本次模型、校验模式、修改摘要、警告和文件位置。 |

Mercury 会在本地保存任务和结果；长任务可以在后台继续运行。终端或 Agent 会话关掉后，任务不必跟着消失。

## 选择你的使用方式

| | CLI / App | Mercury Skill |
| --- | --- | --- |
| 适合你 | 想自己按菜单配置和运行 | 想对 Codex 等 Agent 直接说人话 |
| 负责什么 | 真正配置模型、调用服务、保存和审阅结果 | 把自然语言请求安全地转换成 Mercury 命令 |
| 是否能单独使用 | 可以 | 不可以，必须先安装 CLI |
| 是否接触密钥 | 仅在 Mercury 隐藏输入里配置 | 不读取、不收集，也不直接调用云服务 |

第一次使用，推荐先走 CLI / App，把模型配置好；之后再安装 Skill。

## 三步开始

### 1. 确认 Node.js 版本

```bash
node --version
```

需要显示 `v24.x.x`。如果还是 Node 22，请先安装或切换到 [Node.js 24](https://nodejs.org/)，然后重新打开终端。

### 2. 安装当前已发布版本

```bash
npm install --global mercury-subtitles@latest
```

`@latest` 是 Mercury 的稳定渠道。安装后请运行 `mercury --version` 核对实际版本；需要固定本版本时使用 `npm install --global mercury-subtitles@0.3.0`。公开预发布渠道 `@next` 保留不可变的 `0.3.0-rc.2`，不会覆盖稳定安装。

如果当前还是 `0.3.0-alpha.2`，旧版尚无 `mercury update` 命令。首次进入具备内置更新能力的 0.3 系列版本，需要使用管理现有安装的同一个 npm、同一个 global prefix，显式安装确切版本：

```bash
npm install --global mercury-subtitles@0.3.0
```

如果旧安装使用了自定义 `--prefix`，上述命令也必须带完全相同的 `--prefix`；不要使用 `sudo`，不要让 `npx` 修改另一套全局安装。该一次性动作是 bootstrap，不是旧版内置升级。从 `0.3.0-rc.1` 起才可使用 Mercury 内置更新，例如：

```bash
mercury update apply --version 0.3.0 --yes --json
```

CLI 更新不会静默更新或删除 Skill；Skill 仍由 Skills CLI 单独管理。

### 3. 打开 Mercury

```bash
mercury
```

首次进入会看到中文向导。依次完成：

1. 在“模型中心”添加一个语音转文字服务。
2. 添加一个内容校验服务。
3. 先执行模型检查，再从主页选择“运行新字幕任务”。
4. 选择本地 MP3；有参考 SRT 时可以一起提供。

密钥会使用隐藏输入，不需要写 `.env`、JSON 或 `credential_ref`。暂时不想调用云服务，也可以先进入模型中心了解配置项后退出。

## 方式一：直接使用 CLI / App

日常使用只需要记住一个命令：

```bash
mercury
```

它会打开中文交互界面，负责模型配置、检查、发起任务、查看最近任务和人工审阅。新任务默认进入本地后台队列，提交后你可以退出终端。

需要脚本化时，再使用高级命令：

```bash
# 稳定后台提交，并立即返回任务 ID
mercury task submit --request "/绝对路径/request.json" --json

# 找回任务状态和结果
mercury task status <task-id> --json
mercury task result <task-id> --json

# 在安全检查点暂停/恢复；失败重试必须先查看只读计划
mercury task pause <task-id> --json
mercury task resume <task-id> --json
mercury task retry-plan <task-id> --json
mercury task retry <task-id> --plan <plan-id> --json

# 业务目录暂时不可用时，只重试本地批准稿交付（不会调用 Provider）
mercury task deliver <task-id> --json

# Worker 停止且任务仍在排队时，显式恢复
mercury worker status --json
mercury worker start --json
```

`request.json` 使用 Exchange Protocol v1，并必须包含一个稳定 `request_id`：同一次逻辑请求丢失输出后重试时复用它，用户明确要求重新处理时才生成新的 ID。外部字幕先用 `mercury input inspect ... --json` 检查，并在 request 中显式声明 `transcript_source` 或 `reference`；完整 request 字段见下方 CLI 文档。

如需把最终批准字幕交付到业务目录，可在 request 的 `output` 中增加 `"approved_srt_directory": "/规范化绝对路径"`。Mercury 只在 approved.srt 形成后发布内容寻址的 0600 副本；工作区仍是事实源。目录属于 request 指纹，不能用同一 request ID 改目录；交付失败后使用上面的 `task deliver`，无需重跑 ASR 或 Chat。

查询状态不会偷偷启动 Worker，也不会重复提交任务。Provider 结果不确定时，Mercury 会停下来阻止自动重放，避免重复调用或计费。

`0.3.0` 继续使用 Exchange Protocol v1：脚本可显式导入 SRT、VTT 或 transcript JSON 作为转写事实源（ASR 0 调用），也可用 `reference` 继续走 ASR；两种模式共用稳定任务、事件、结果、词典快照和审阅合同。安全暂停/同 attempt 恢复，以及只读 retry plan + append-only retry 均保持兼容；Provider 结果不确定时仍禁止自动重放。全局/项目词典通过 `mercury dictionary ... --json` 管理，任务创建后固定 revision/hash。

不知道命令时可从一屏帮助开始：

```bash
mercury --help
mercury help task
mercury help task submit
```

检查 CLI 更新不会修改配置、任务或 Skill：

```bash
mercury update --check
```

CLI 与 Skill 是两份独立安装事实。CLI 更新完成不代表 Skill 已更新；Skill 仍使用 `npx skills update mercury-subtitles` 单独管理。

新任务的纯转写、AI 校验、人工批准与业务目录交付 SRT 统一采用无句读风格：句读位置替换为一个空格，连续空白会折叠。版本号、`B-roll`、URL、邮箱和技术缩写中的词法符号会保留，包裹 URL 的括号、方括号和引号不会被误当成 URL 本体。AI 校验只修正每个纯转写 cue 内的文字，不拆分、合并、移动或调整时间；即使请求使用历史 `text-and-segmentation` 模式，当前版本也会冻结原 cue。如果修正文字在固定 cue 内超过 24 字或两行，任务会明确停止而不偷偷改断句。Provider/raw 证据仍保持原样，历史任务不会被改写。

[CLI 完整说明 →](https://github.com/dingshuxin353/mercury-subtitles/blob/main/docs/cli.md)

## 方式二：让 Agent 通过 Skill 使用

先安装 Mercury CLI 并完成模型配置，然后从公开仓库安装 Skill：

```bash
npx skills add dingshuxin353/mercury-subtitles
```

安装器会让你选择 Agent 和安装范围。想直接安装到当前用户的 Codex，可以使用：

```bash
npx skills add dingshuxin353/mercury-subtitles --global --agent codex --skill mercury-subtitles --yes
```

安装后可以让 Mercury 只读检查是否发现了兼容 Skill：

```bash
mercury skill status --json
```

重新打开一个 Agent 会话后，可以直接说：

> 用 Mercury 在后台为 `/path/to/interview.mp3` 生成字幕，完成后告诉我三份字幕和报告在哪里。

也可以在另一个会话里继续：

> 用 Mercury 查看任务 `<task-id>` 的状态；如果完成了，带我审阅修改并生成批准稿。

Skill 只使用 Mercury 的机器命令，当前完整迁移到稳定 `mercury.cli/v1` / Exchange v1。它不会向你索要 Key，不会自行上传音频，不会绕过 Mercury 直接调用 ASR 或 Chat 服务，也不会凭空拼出结果路径；暂停、恢复、重试计划、外部转录、词典、审阅和批准稿业务目录交付都复用同一稳定合同。

[Skill 完整说明 →](https://github.com/dingshuxin353/mercury-subtitles/blob/main/docs/agent-skill.md)

## 人工批准校验结果

校验完成后，Mercury 会把每一处正文变化列为待决定项。你可以：

- 接受：采用校验后的文字；
- 驳回：保留纯转写文字；
- 编辑：使用你亲自确认的文字。

所有项目决定完毕后才会生成 `approved.srt`。批准稿沿用校验字幕的完整时间轴，不通过删段或合段来掩盖正文分配问题。

稳定 request 可选指定批准稿业务目录。再次修改同一任务的审阅决定时，旧业务文件保持不可变；下一次 finalize 按新批准稿 hash 生成新路径，任务结果会区分 latest 与 history。

## 你的数据会去哪里

- **本地保存：** 配置、任务、日志和结果默认位于 `~/mercury-workspace/`。
- **密钥：** 只在 Mercury 的隐藏输入中填写，并保存在当前用户可读的私有文件中；不要把 Key、Token 或 ADC 内容发到聊天或 GitHub Issue。
- **语音转文字：** MP3 会发送给你在模型中心选择的 ASR 服务。
- **AI 校验：** 字幕正文会发送给你选择的 Chat 服务；当模型已通过音频能力检查且 MP3 不超过 15 MB 时，强校验还会发送音频。
- **Mercury 自身：** 当前版本没有 Mercury 托管的云端中转服务。网络请求直接去你配置的模型服务。

提交 Issue 前，请删除本机路径、字幕正文、task/request/log ID 和 Provider 原始响应。

[模型服务与数据流 →](https://github.com/dingshuxin353/mercury-subtitles/blob/main/docs/providers.md) · [隐私与安全 →](https://github.com/dingshuxin353/mercury-subtitles/blob/main/docs/privacy.md)

## 当前支持与限制

- 运行环境：Node.js `>=24.0.0 <25.0.0`。
- 当前主要在 macOS 上完成真实体验验收；Windows 和 Linux 欢迎反馈。
- 输入以中文 MP3 为主；视频、翻译、批量任务、本地 ASR、插件市场和多 Worker 尚未提供。
- 大于 15 MB 的音频不会发送给 Chat 做强校验，但仍可按文本路径处理；这不是 ASR 的通用大小上限。
- 内置 ASR：火山音视频字幕、火山极速版。校验模型支持 Vertex AI Gemini、Gemini Developer API 与 OpenAI-compatible Chat endpoint；实际可用性仍取决于你的账号、区域和模型权限。
- Exchange Protocol v1 是 V0.3 的稳定外部机器合同；内部 task/job/lock 文件仍不是公共 API。自动化用户升级前请阅读 [CHANGELOG](./CHANGELOG.md)。

## 常见问题

<details>
<summary><strong>安装成功，但提示 <code>mercury: command not found</code></strong></summary>

如果你执行的是项目内 `npm install`，命令不会自动进入全局 PATH。推荐重新全局安装：

```bash
npm install --global mercury-subtitles@latest
```

或者在本地项目中使用 `npm exec -- mercury`。
</details>

<details>
<summary><strong>提示当前不能在 Node.js 22 下启动</strong></summary>

这是有意的兼容性保护。切换到 Node.js 24、重新打开终端，再执行 `node --version` 和 `mercury`。
</details>

<details>
<summary><strong>终端退出后，后台任务怎么找回来</strong></summary>

重新运行 `mercury`，进入“查看最近任务”。Agent 用户也可以把 task ID 交给 Mercury Skill。若任务仍排队但 Worker 已停止，显式运行 `mercury worker start --json`，不要重新提交同一音频来唤醒。
</details>

<details>
<summary><strong>为什么有纯转写，却没有校验后字幕</strong></summary>

这通常表示 ASR 已成功、Chat 校验失败或返回结构不完整。Mercury 会保留真实的部分结果，不会伪造 `calibrated.srt`。打开任务详情和报告查看恢复建议。
</details>

<details>
<summary><strong>如何升级或卸载</strong></summary>

先只读检查 CLI / App 更新：

```bash
mercury update --check
```

如果当前入口不是与同一个可信 npm global prefix 完整绑定、且该目录可写的全局安装，Mercury 会拒绝自动覆盖并给出适合该来源的手动动作，而不是修改项目、本地 npm exec 缓存或源码。自动升级会先显示目标并要求确认；机器模式必须显式使用 `--yes`。稳定版也可手工安装：

```bash
npm install --global mercury-subtitles@latest
```

升级或重新配置 Skill：

```bash
npx skills update mercury-subtitles
npx skills list
```

卸载 CLI / App：

```bash
npm uninstall --global mercury-subtitles
```

卸载 CLI 不会自动删除 `~/mercury-workspace/` 或由 Skills CLI 管理的 Skill，避免误删任务和人工审阅结果。Skill 的移除请使用 `npx skills remove mercury-subtitles`；确认不再需要后再处理工作区。
</details>

[更多故障排查 →](https://github.com/dingshuxin353/mercury-subtitles/blob/main/docs/troubleshooting.md)

## 给开发者

```bash
git clone https://github.com/dingshuxin353/mercury-subtitles.git
cd mercury-subtitles
npm ci
npm run verify
```

<details>
<summary><strong>查看源码结构和包导出</strong></summary>

- `src/`：CLI、后台任务、模型适配、字幕核心与审阅流程。
- `schemas/`：版本化机器合同。
- `skills/mercury-subtitles/`：随包交付的 Agent Skill。
- `test/`：合同、故障注入、CLI、包消费与历史兼容回归。
- 包导出：根合同、`./subtitle-core`、`./output-report`、`./model-center` 以及 `./schemas/v1/*` 至 `./schemas/v4/*`。

[架构概览 →](https://github.com/dingshuxin353/mercury-subtitles/blob/main/docs/architecture.md)
</details>

贡献前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。安全问题请使用 [私密漏洞报告](https://github.com/dingshuxin353/mercury-subtitles/security/advisories/new)，不要公开粘贴凭据或私有媒体。

## 版本与反馈

- 当前稳定版：`0.3.0`，通过 npm `latest` 分发；`next` 保留 `0.3.0-rc.2` 作为不可覆盖的预发布历史。实际渠道版本请以 `npm view mercury-subtitles dist-tags --json` 为准。
- 版本变化：[CHANGELOG.md](./CHANGELOG.md)
- 下载与校验：[GitHub Releases](https://github.com/dingshuxin353/mercury-subtitles/releases)
- 安装或配置求助：[创建安装帮助](https://github.com/dingshuxin353/mercury-subtitles/issues/new?template=installation-help.yml)
- 缺陷与建议：[GitHub Issues](https://github.com/dingshuxin353/mercury-subtitles/issues)

---

Mercury is licensed under [Apache-2.0](./LICENSE). Copyright 2026 Mercury contributors.
