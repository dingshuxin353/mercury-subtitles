export function runtimeVersionProblem(
  version: string = process.versions.node,
): string | null {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (major === 24) return null;
  return [
    `Mercury 当前不能在 Node.js ${version} 下启动。`,
    '需要 Node.js 24（支持范围：>=24 <25）。',
    '请安装或切换到 Node.js 24，重新打开终端后再运行 mercury。',
  ].join('\n');
}
