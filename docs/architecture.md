# 架构概览

Mercury 是一个本地优先的 Node.js CLI。它把 Provider 调用、后台持久化和 Agent 使用边界放在同一个可审计的本地执行引擎中。

```text
用户 / Agent
    │
    ├── 交互 App
    └── Mercury Skill ── 机器 CLI
                         │
                    本地任务队列
                         │
                    单 Worker
                    ┌────┴────┐
                  ASR        Chat
                    └────┬────┘
                 转写 / 校验结果
                         │
                    人工审阅
                         │
                    approved.srt
```

## 关键边界

- CLI 是唯一执行入口；Skill 不直接调用 Provider。
- request ID 为同一次逻辑用户请求提供幂等找回，不把未来的主动重跑永久去重。
- Provider 调用在发出前持久化状态；结果未知时不自动重放。
- task/job/event/review 使用版本化 schema 和同一 task owner lock 下的原子状态转换。
- pause/resume 以可验证安全检查点继续同一 attempt；retry 先形成只读计划，再追加新 attempt 和逐调用事实。
- 状态、列表、结果与 Worker 状态查询严格只读。
- ASR 成功后立即保留纯转写；校验失败不会抹掉可用部分结果。
- approved 只在全部人工决定完成后生成，并保持校验字幕的完整时间轴。

公开包提供 Exchange Protocol v1、subtitle core、output report、model center 及 v1–v5 schema。稳定 Agent/机器入口是 `mercury.cli/v1`；冻结的历史 schema 1–4 和 Alpha.1 v5 任务保持只读兼容。
