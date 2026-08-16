# 模型服务与数据流

Mercury 把两类模型分开配置：

- 语音转文字（ASR）：把中文 MP3 变成带时间的正文。
- 内容校验（Chat）：在不破坏时间轴的前提下校验完整正文；能力允许时可结合原音。

## 当前内置连接

### 语音转文字

- 火山音视频字幕：使用同一控制台项目的 APP ID 与 Access Token。
- 火山极速版：使用其控制台要求的凭据和资源配置。

### 内容校验

- Vertex AI Gemini：推荐使用本机已登录的 Application Default Credentials。
- Gemini Developer API。
- OpenAI-compatible Chat endpoint，包括符合当前合同的兼容服务。

Mercury 不保证某个账号、区域、模型名称或配额一定可用。请在交互 App 的模型中心检查每个实例。

## 一次任务的数据流

1. MP3 发送给所选 ASR，返回带时间的统一转写。
2. Mercury 立即在本地保存 `transcribed.srt`。
3. 完整校验单元发送给所选 Chat。
4. Chat 通过音频能力检查且 MP3 不超过 15 MB 时，同一次校验可附带音频；否则只发送文本。
5. 结构完整的结果生成 `calibrated.srt` 和报告；失败不会伪造校验字幕。
6. 人工完成所有决定后，本地生成 `approved.srt`，不会再次调用 Provider。

Mercury 当前没有托管中转服务器；网络请求直接去你配置的服务。服务提供商如何保存或处理数据，请阅读相应账号和服务条款。
