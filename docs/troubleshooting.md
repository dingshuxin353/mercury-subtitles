# 故障排查

## Node 版本不支持

Mercury Public Alpha 固定要求 Node.js 24。切换后重新打开终端：

```bash
node --version
mercury --version
```

## 安装后找不到命令

全局安装：

```bash
npm install --global mercury-subtitles@next
```

项目内安装则使用 `npm exec -- mercury`。

## 模型尚未配置

直接运行 `mercury`，从“模型中心”按向导添加服务。不要把密钥写到命令参数、聊天或 Issue。

## 任务排队但没有继续

```bash
mercury worker status --json
mercury worker start --json
mercury task status <task-id> --json
```

不要重新 submit 来唤醒任务。

## Provider 结果未知

网络断开可能发生在 Provider 已收到请求之后。Mercury 会把任务标记为不可自动重放的中断，避免重复调用或收费。保留 task ID，根据命令返回的恢复动作处理；不要自行换 request ID 重试。

## 只有纯转写字幕

ASR 成功、Chat 失败时会保留 `transcribed.srt`。查看任务详情和 `calibration-report.md`，修复模型配置后由用户决定是否创建一次新的逻辑任务。

## Skill 没有被 Agent 发现

确认状态：

```bash
mercury skill status --json
```

安装后通常需要打开一个新 Agent 会话。已有同名 Skill 时 Mercury 不会覆盖，请先检查路径和来源再处理。

如果仍无法解决，请使用 [安装帮助模板](https://github.com/dingshuxin353/mercury-subtitles/issues/new?template=installation-help.yml)，只提交脱敏信息。
