# Mercury Skill

Mercury Skill 让 Codex 等支持本地 Skill 的 Agent 用自然语言调用 Mercury。它是 CLI 的客户端，不是另一个字幕引擎。

## 前置条件

1. 已安装 `mercury-subtitles@next`。
2. 运行过 `mercury`，并在交互 App 中完成模型配置。
3. Agent 能读取本地 Skill 目录并执行本机命令。

## 安装

```bash
mercury skill status --json
mercury skill install --json
mercury skill status --json
```

安装后重新打开 Agent 会话，确保它重新发现 Skill。Mercury 默认安装到 `~/.codex/skills/mercury-subtitles/`；已有同名目录时不会覆盖。

## 自然语言示例

> 用 Mercury 在后台把这个 MP3 转成字幕：`/path/to/interview.mp3`。提交后立刻告诉我 task ID，不要在会话里一直等。

> 用 Mercury 查询任务 `<task-id>`。完成后告诉我 transcribed、calibrated、approved 和报告的实际路径。

> 用 Mercury 列出这个任务的校验变化，我要逐项决定，然后生成批准稿。

## 安全边界

- Agent 不应向你索要或打印 Key、Token、ADC 内容、`.env` 或 Mercury secret 文件。
- Skill 不直接调用 Provider，不自己转写音频，不绕过 Mercury 编辑 task/review 文件。
- 同一逻辑请求输出丢失时复用稳定 request ID；不确定结果不得换 ID 自动重试。
- 查询命令不会启动 Worker。queued 且 Worker 未运行时，使用显式 `worker start`。
- 只报告 Mercury 返回的绝对结果路径，不猜测文件位置。
- 除非用户明确要求检查特定内容，不把整份字幕复制到聊天。

Skill 的机器合同目前是实验性 `mercury-cli-experimental-v1`。升级 Alpha 前应先运行 `mercury skill status --json`；不兼容时按提示确认旧目录后再安装新版。
