# Contributing to Mercury

感谢你帮助 Mercury 变得更可靠、更好用。请先在 Issue 中说明问题或建议，再为明确范围的变更提交 Pull Request。

## 本地开发

需要 Node.js `>=24.0.0 <25.0.0`。仓库使用提交的 npm lockfile：

```bash
npm ci
npm run verify
```

开发分支请保持单一目的，提交信息说明用户可见结果。PR 必须填写模板中的测试、兼容性、隐私与包检查项。

## 测试边界

- 默认使用 fixture、stub 和故障注入，不要让测试依赖个人云账号。
- 真实 Provider 调用必须先说明目的、次数和数据授权；不要把密钥写入源码、fixture、日志或 PR。
- 不要提交私人音频、字幕正文、Provider 原始响应、真实 task/request/log ID 或本机绝对路径。
- 修改冻结 schema 时必须保留旧产物只读兼容；不要在既有版本中新增破坏性必填字段。
- 修改后台任务、审阅或 Skill 时，必须验证幂等、崩溃恢复、严格只读查询和未知 Provider 结果不重放。

## 发布包检查

`npm run verify` 会执行生成文件、类型、构建、测试、安装后包消费和敏感信息扫描。公开维护者还应构建 allowlist 快照并执行：

```bash
npm run build:public-snapshot -- /absolute/path/to/empty-directory
node scripts/verify-public-snapshot.mjs /absolute/path/to/public-snapshot
```

提交贡献即表示你同意按本项目的 Apache-2.0 许可证提供该贡献。参与社区时请遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
