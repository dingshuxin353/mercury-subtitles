# CLI / App 使用指南

Mercury CLI 是本地执行引擎。它负责配置模型、隐藏输入密钥、调用云服务、运行后台任务、保存产物和人工审阅；不需要 Agent 也能完整使用。

## 第一次使用

```bash
node --version
npm install --global mercury-subtitles@next
mercury
```

需要 Node.js 24。直接运行 `mercury` 后，按中文菜单先添加一个语音转文字模型和一个内容校验模型。模型检查会产生真实 Provider 请求；不想调用时可以先返回主页。

## 发起任务

交互 App 从主页发起的新任务默认在后台执行。高级用户可直接使用：

```bash
mercury input inspect --file "/绝对路径/subtitle.vtt" --format vtt --role transcript-source --json
mercury task submit --request "/绝对路径/request.json" --json
```

保存返回的 `task_id`。`request.json` 必须包含稳定逻辑身份派生的 `request_id`；同一次用户请求丢失输出后的重试复用它，用户明确要求重新跑时才创建新的逻辑身份。

旧 `calibrate --background --json` 仅作为过渡兼容入口；机器调用必须显式提供稳定 request ID，不能依赖随机 ID：

```bash
mercury calibrate --audio "/path/to/input.mp3" --background --request-id "stable-logical-id" --json
mercury calibrate --audio "/path/to/input.mp3" --srt "/path/to/reference.srt" --mode text-only --background --request-id "stable-logical-id" --json
mercury calibrate --audio "/path/to/input.mp3" --srt "/path/to/reference.srt" --mode text-and-segmentation --background --request-id "stable-logical-id" --json
```

`transcription_mode=provided` 只接受显式 `transcript_source`，并保证 ASR 为 0；`transcription_mode=provider` 的可选字幕必须声明 `reference`，仍会执行 ASR。两种模式共用同一 v5 幂等、后台、词典、结果和审阅链路。

## 词典

```bash
mercury dictionary create --name "产品术语" --scope global --json
mercury dictionary list --json
mercury dictionary show <dictionary-id> --json
mercury dictionary entry add <dictionary-id> --revision <revision> --entry-id entry-api --canonical API --case-sensitive true --number-sensitive false --json
mercury dictionary entry edit <dictionary-id> --revision <revision> --entry-id entry-api --case-sensitive false --clear-variants --clear-tags --clear-notes --json
mercury dictionary entry remove <dictionary-id> --revision <revision> --entry-id entry-api --json
```

布尔值必须显式写 `true` 或 `false`。`--clear-variants`、`--clear-tags` 和 `--clear-notes` 表达清空意图；所有写操作都要求当前 revision，陈旧编辑会失败而不是覆盖。

## 查询和恢复

```bash
mercury task list --json
mercury task status <task-id> --json
mercury task result <task-id> --json
mercury task watch <task-id> --jsonl
mercury worker status --json
mercury worker start --json
```

`task status/list/result/watch` 与 `worker status` 都是严格只读查询。它们不会启动 Worker，也不会调用 Provider。排队任务没有 Worker 时，显式执行 `worker start`；不要重新 submit 来唤醒。

## 取消

```bash
mercury task cancel <task-id> --json
```

取消只在安全边界生效。尚未产生纯转写时，结果会明确说明“尚未产生字幕文件”；已经发出的 Provider 请求不会假装未发生，未知结果会进入中断状态且不自动重放。

## 审阅和批准

```bash
mercury review status <task-id> --json
mercury review list <task-id> --json
mercury review decide <task-id> --change <change-id> --decision accepted --json
mercury review decide <task-id> --change <change-id> --decision rejected --json
mercury review decide <task-id> --change <change-id> --decision edited --text "人工确认文字" --json
mercury review accept-all <task-id> --json
mercury review finalize <task-id> --json
```

只有 pending 为零时才能 finalize。生成的 `approved.srt` 与 `calibrated.srt` 时间段数和毫秒边界一致。

## 完整命令表

执行 `mercury --help` 查看当前版本的权威命令；执行 `mercury <command> --help` 查看单个命令说明。
