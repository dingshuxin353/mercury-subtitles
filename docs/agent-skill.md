# Mercury Agent Skill

Mercury Skill 让 Codex 等支持本地 Skill 的 Agent 用自然语言调用 Mercury。它是 CLI 的客户端，不是另一个字幕引擎。

## 前置条件

1. 已安装 `mercury-subtitles@latest`。
2. 运行过 `mercury`，并在交互 App 中完成模型配置。
3. Agent 能读取本地 Skill 目录并执行本机命令。

## 安装

推荐使用标准 Skills CLI，从 Mercury 的公开 GitHub 仓库发现并安装 Skill：

```bash
npx skills add dingshuxin353/mercury-subtitles
```

安装器会让你选择目标 Agent 和项目/全局范围。需要无交互地为当前用户的 Codex 安装时，可以使用：

```bash
npx skills add dingshuxin353/mercury-subtitles --global --agent codex --skill mercury-subtitles --yes
```

安装后重新打开 Agent 会话，确保它重新发现 Skill。可以用 Skills CLI 查看已安装列表，也可以让 Mercury 只读检查兼容性：

```bash
npx skills list
mercury skill status --json
```

标准项目安装位于项目的 `.agents/skills/mercury-subtitles/`，标准全局安装位于 `~/.agents/skills/mercury-subtitles/`。Mercury 也会识别旧版本曾写入的 `~/.codex/skills/mercury-subtitles/`，但新用户不再需要使用这个旧入口。

## 更新与卸载

使用同一个 Skills CLI 管理更新和移除：

```bash
npx skills update mercury-subtitles
npx skills remove mercury-subtitles
```

如果 `mercury skill status --json` 报告多份安装，请先检查 `installations` 列表。Mercury 不会擅自覆盖或删除任何一份 Skill。

## 自然语言示例

> 用 Mercury 在后台把这个 MP3 转成字幕：`/path/to/interview.mp3`。提交后立刻告诉我 task ID，不要在会话里一直等。

普通字幕请求默认自动采用仍为 pending 的 AI 校对并生成经过验证的 `approved.srt`，不会再问一次“是否接受全部修改”。Skill 会在开始时用一句话提示这个默认策略；自动 accept-all、finalize 与本地 delivery 不增加 Provider 调用。

> 用 Mercury 查询任务 `<task-id>`。完成后告诉我 transcribed、calibrated、approved 和报告的实际路径。

> 用 Mercury 列出这个任务的校验变化，我要逐项决定，然后生成批准稿。

只有明确说“逐条检查”“人工复核”“先看修改”或“不要自动定稿”时，Skill 才切换为人工审阅；已有接受、驳回、编辑决定会保留，自动流程也只处理剩余 pending。

> 暂停这个 Mercury 任务；等它真正到安全检查点后再告诉我。随后从同一 attempt 恢复，不要重复已固定的 Provider 调用。

> 先只读分析这个失败任务能不能安全重试，告诉我将复用什么、会新增几次 ASR/Chat；没有我确认不要执行。

## 安全边界

- Agent 不应向你索要或打印 Key、Token、ADC 内容、`.env` 或 Mercury secret 文件。
- Skill 不直接调用 Provider，不自己转写音频，不绕过 Mercury 编辑 task/review 文件。
- 同一逻辑请求输出丢失时复用稳定 request ID；不确定结果不得换 ID 自动重试。
- 查询命令不会启动 Worker。queued 且 Worker 未运行时，使用显式 `worker start`。
- 暂停/恢复不创建新 attempt；重试前必须展示只读 plan，并且只能执行仍匹配当前 task revision 的 plan。
- `outcome_unknown` 不得自动恢复或重试。若用户仍要重新处理，必须作为可能重复计费的全新逻辑 request 明示确认。
- 只报告 Mercury 返回的绝对结果路径，不猜测文件位置。
- 只有 `approved_srt.exists=true` 且 `validation=passed` 才称为最终字幕；不把 transcribed/calibrated 冒充 final。
- 除非用户明确要求检查特定内容，不把整份字幕复制到聊天。

Skill 只消费稳定 `mercury.cli/v1` / Exchange Protocol v1；不会解析中文 App 页面或旧实验输出。升级 Alpha 前可以运行 `mercury skill status --json` 检查兼容性；更新 Skill 本身仍使用标准 Skills CLI。
