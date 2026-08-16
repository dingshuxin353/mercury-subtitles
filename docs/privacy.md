# 隐私与安全

## 本地文件

Mercury 默认把用户数据放在 `~/mercury-workspace/`，包括模型配置、任务、事件、日志、审阅和字幕结果。安装目录和源码仓不保存用户任务。

密钥通过交互界面的隐藏输入采集，写入仅当前用户可读的私有文件。配置、任务 JSON、报告和普通日志不应包含密钥正文。

## 云端发送

- MP3 会发送给你选定的 ASR。
- 字幕正文会发送给你选定的 Chat。
- 只有音频能力检查通过且 MP3 不超过 15 MB 时，音频才会随 Chat 强校验请求发送。
- 人工审阅、批准稿生成、状态查询和结果找回都在本地完成，不产生 Provider 调用。

## 报告问题前脱敏

不要在公开 Issue、PR、聊天或截图中提供：

- Key、Token、Authorization、ADC 文件或完整环境变量；
- 私有音频或完整字幕正文；
- Provider 原始响应；
- 完整的 task/request/log/provider ID；
- 用户名、本机绝对路径或整个 Mercury 工作区。

请只提供 Mercury 版本、Node 版本、脱敏错误码、最小复现步骤和不含私人内容的 fixture。安全漏洞请走 [私密报告](https://github.com/dingshuxin353/mercury-subtitles/security/advisories/new)。
