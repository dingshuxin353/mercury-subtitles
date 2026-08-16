# Mercury Changelog

## 0.2.0-alpha.2 — 2026-08-16

### 公开发布

- 首次以 `dingshuxin353/mercury-subtitles` 公开源码，并以 `mercury-subtitles@next` 发布 npm Public Alpha。
- 包、Repository、CLI 和 Skill 的公开身份已统一；CLI 命令继续使用 `mercury`。
- 新增面向第一次使用者的 README，分别说明 CLI / App 与 Agent Skill 的能力和边界。
- 新增 Apache-2.0 License、Security、Contributing、Code of Conduct、Issue / PR 模板和公开 CI。
- 新增 allowlist 公开快照构建与审计，避免私有证据、本机路径、用户媒体和工作区状态进入公开历史。

### 运行时

- 字幕、后台任务、审阅和 Skill 运行时继承 `0.2.0-alpha.1` 已验收能力；本版本不扩展字幕业务范围。
- 要求 Node.js `>=24.0.0 <25.0.0`，Alpha 版本发布到 npm `next`，不占用 `latest`。

## 0.2.0-alpha.1 — 2026-08-16

### 新增

- 本地持久化后台任务队列与 detached 单 Worker，支持任务提交后退出终端或 Agent 会话继续执行。
- 实验性 JSON / JSONL 机器合同，覆盖任务提交、状态、事件、结果、取消和 Worker 显式恢复。
- Mercury 字幕 Skill，可由 Agent 通过自然语言创建后台任务、跨会话找回结果并继续审阅。
- 字幕修改审阅与批准流程，支持接受、驳回、编辑和生成独立 `approved.srt`。

### 改进

- 同一逻辑请求使用稳定 request ID 幂等找回，避免重复任务和重复 Provider 调用。
- 后台任务增加原子认领、心跳、崩溃恢复、结果未知中断和严格只读查询边界。
- 交互 App 默认后台提交，并明确展示任务状态、恢复动作和三种字幕产物身份。

### 修复

- 修复 Ark 深度思考导致的结构化校准不稳定。
- 修复拆分/合并字幕段的审阅映射、批准稿时间轴和崩溃恢复一致性。
- 修复 Skill 未配置模型引导与已批准任务下一步提示不准确的问题。

### 兼容与发布边界

- 保持 Alpha.3 及更早任务只读兼容；旧合同版本不新增破坏性必填字段。
- 要求 Node.js `>=24.0.0 <25.0.0`。
- 以私有 GitHub prerelease 和 tarball 附件发布；包保持 `private: true`，不发布到 npm registry。

## 0.1.0-alpha.2 — 2026-08-15

- 新增火山音视频字幕 ASR、App 式 CLI、模型中心和真实弱/强校准代表链路。
- 以私有 GitHub prerelease 发布，未发布到 npm registry。

## 0.1.0-alpha.1 — 2026-08-14

- 首个私有体验预发布，交付共享合同、CLI 和基础字幕校准流水线。
