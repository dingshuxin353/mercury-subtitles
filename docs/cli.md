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
mercury calibrate --audio "/path/to/input.mp3" --background --json
mercury calibrate --audio "/path/to/input.mp3" --srt "/path/to/reference.srt" --mode text-only --background --json
mercury calibrate --audio "/path/to/input.mp3" --srt "/path/to/reference.srt" --mode text-and-segmentation --background --json
```

保存返回的 `task_id`。机器调用如需安全重放，应先用稳定逻辑身份派生 `request_id`，并在同一次用户请求的重试中复用它；用户明确要求重新跑时应创建新的逻辑身份。

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

取消只在安全边界生效。已经发出的 Provider 请求不会假装未发生；未知结果会进入中断状态，不自动重放。

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
