import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MercuryError } from './errors.js';

export const UPDATE_REGISTRY_URL = 'https://registry.npmjs.org/mercury-subtitles';
export const UPDATE_PACKAGE_NAME = 'mercury-subtitles';
export const UPDATE_TIMEOUT_MS = 5_000;
export const UPDATE_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const UPDATE_REDIRECT_LIMIT = 2;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type UpdateChannel = 'latest' | 'next';
export type InstallationKind = 'npm_global' | 'npm_local' | 'npm_exec' | 'source' | 'unknown';

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface RegistryVersionFact {
  version: string;
  node_engine: string;
}

export interface RegistryFacts {
  latest: RegistryVersionFact;
  next: RegistryVersionFact;
  versions: ReadonlyMap<string, RegistryVersionFact>;
}

export interface InstallationOrigin {
  kind: InstallationKind;
  package_root: string;
  executable_path: string;
  auto_apply: boolean;
  reason: string;
  npm_global_prefix: string | null;
  npm_global_root: string | null;
  prefix_verified: boolean;
  prefix_error: string | null;
}

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  next_version: string;
  recommended_channel: UpdateChannel;
  recommended_version: string;
  update_available: boolean;
  status: 'update_available' | 'up_to_date' | 'remote_older';
  installation: InstallationOrigin;
  target_node_engine: string;
  current_node_version: string;
  node_compatible: boolean;
  can_auto_apply: boolean;
  next_action: string;
  skill: {
    managed_separately: true;
    update_command: 'npx skills update mercury-subtitles';
  };
}

export interface UpdateApplyResult extends UpdateCheckResult {
  requested: { channel: UpdateChannel | null; version: string; direction: 'upgrade' | 'same' | 'downgrade' };
  applied: boolean;
  verified_version: string;
  npm: { command: string; arguments: string[]; exit_code: number | null };
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type SpawnCommand = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<SpawnResult>;

export interface UpdateDependencies {
  fetch?: typeof fetch;
  spawnCommand?: SpawnCommand;
  packageRoot?: string;
  executablePath?: string;
  nodeExecutable?: string;
  npmCliPath?: string;
  currentVersion?: string;
  nodeVersion?: string;
}

function parseVersion(version: string): ParsedVersion {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回了无效版本号，当前 Mercury 未做任何更改。', {
      remediation: '稍后重新检查更新；若持续出现，请从 Mercury 官方发布页核对版本。',
    });
  }
  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left.localeCompare(right, 'en');
}

export function compareVersions(leftText: string, rightText: string): number {
  const left = parseVersion(leftText);
  const right = parseVersion(rightText);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key]);
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const compared = compareIdentifiers(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

function parseLooseEngineVersion(text: string): ParsedVersion {
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/u.test(part))) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回了无法验证的 Node.js 支持范围，当前 Mercury 未做任何更改。', {
      remediation: '稍后重新检查更新；不要绕过 Node.js 版本检查。',
    });
  }
  return parseVersion(`${parts[0]}.${parts[1] ?? '0'}.${parts[2] ?? '0'}`);
}

function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  return compareVersions(left.raw, right.raw);
}

export function nodeSatisfiesEngine(nodeVersion: string, engine: string): boolean {
  const current = parseVersion(nodeVersion);
  const clauses = engine.trim().split(/\s+/u);
  if (clauses.length === 0 || clauses.some((clause) => clause.length === 0 || clause.includes('||'))) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回了无法验证的 Node.js 支持范围，当前 Mercury 未做任何更改.');
  }
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/u.exec(clause);
    if (!match) {
      throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回了无法验证的 Node.js 支持范围，当前 Mercury 未做任何更改。', {
        remediation: '稍后重新检查更新；不要绕过 Node.js 版本检查。',
      });
    }
    const target = parseLooseEngineVersion(match[2]!);
    const compared = compareParsed(current, target);
    if (match[1] === '>=') return compared >= 0;
    if (match[1] === '>') return compared > 0;
    if (match[1] === '<=') return compared <= 0;
    if (match[1] === '<') return compared < 0;
    return compared === 0;
  });
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', `更新服务缺少有效的 ${label}，当前 Mercury 未做任何更改。`, {
      remediation: '稍后重新检查更新；若持续出现，请从 Mercury 官方发布页核对版本。',
    });
  }
  return value;
}

function versionFact(metadata: Record<string, unknown>, version: string): RegistryVersionFact {
  parseVersion(version);
  const versions = metadata.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务没有提供可验证的版本清单，当前 Mercury 未做任何更改。');
  }
  const entry = (versions as Record<string, unknown>)[version];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', `更新服务缺少 ${version} 的发布事实，当前 Mercury 未做任何更改。`);
  }
  const record = entry as Record<string, unknown>;
  if (stringField(record.name, '包名') !== UPDATE_PACKAGE_NAME || stringField(record.version, '版本') !== version) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务的包身份或版本身份不一致，当前 Mercury 未做任何更改。');
  }
  const engines = record.engines;
  if (!engines || typeof engines !== 'object' || Array.isArray(engines)) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', `更新服务缺少 ${version} 的 Node.js 支持范围，当前 Mercury 未做任何更改。`);
  }
  const nodeEngine = stringField((engines as Record<string, unknown>).node, 'Node.js 支持范围');
  nodeSatisfiesEngine('24.0.0', nodeEngine);
  return { version, node_engine: nodeEngine };
}

export function parseRegistryMetadata(value: unknown): RegistryFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回的内容不是有效对象，当前 Mercury 未做任何更改。');
  }
  const metadata = value as Record<string, unknown>;
  if (stringField(metadata.name, '包名') !== UPDATE_PACKAGE_NAME) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回了其他软件包，当前 Mercury 未做任何更改。');
  }
  const distTags = metadata['dist-tags'];
  if (!distTags || typeof distTags !== 'object' || Array.isArray(distTags)) {
    throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务缺少 latest/next 渠道，当前 Mercury 未做任何更改。');
  }
  const latestText = stringField((distTags as Record<string, unknown>).latest, 'latest 渠道');
  const nextText = stringField((distTags as Record<string, unknown>).next, 'next 渠道');
  const latest = versionFact(metadata, latestText);
  const next = versionFact(metadata, nextText);
  const versions = new Map<string, RegistryVersionFact>([[latest.version, latest], [next.version, next]]);
  const rawVersions = metadata.versions as Record<string, unknown>;
  for (const version of Object.keys(rawVersions)) {
    if (SEMVER_PATTERN.test(version)) versions.set(version, versionFact(metadata, version));
  }
  return { latest, next, versions };
}

function updateTransportError(signal: AbortSignal): MercuryError {
  return new MercuryError(signal.aborted ? 'UPDATE_CHECK_TIMEOUT' : 'UPDATE_REGISTRY_UNAVAILABLE', signal.aborted
    ? '检查更新超过 5 秒，已停止联网；当前 Mercury 可以继续使用。'
    : '读取 Mercury 官方更新服务响应时连接中断；当前 Mercury 可以继续使用。', {
    remediation: '检查网络后再次运行 mercury update --check。',
  });
}

async function responseBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > UPDATE_RESPONSE_LIMIT_BYTES) {
    throw new MercuryError('UPDATE_REGISTRY_TOO_LARGE', '更新服务返回的数据过大，已安全停止检查。', {
      remediation: '稍后重新检查更新；当前 Mercury 可以继续正常使用。',
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(updateTransportError(signal));
    else signal.addEventListener('abort', () => reject(updateTransportError(signal)), { once: true });
  });
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await Promise.race([reader.read(), aborted]);
      } catch (error) {
        if (error instanceof MercuryError) throw error;
        throw updateTransportError(signal);
      }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > UPDATE_RESPONSE_LIMIT_BYTES) {
        throw new MercuryError('UPDATE_REGISTRY_TOO_LARGE', '更新服务返回的数据过大，已安全停止检查。', {
          remediation: '稍后重新检查更新；当前 Mercury 可以继续正常使用。',
        });
      }
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function allowedRegistryUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.port) {
    throw new MercuryError('UPDATE_REDIRECT_UNSAFE', '更新服务尝试跳转到非官方地址，已安全停止检查。', {
      remediation: '请检查网络代理；Mercury 只允许访问 registry.npmjs.org。',
    });
  }
  if (url.pathname.replace(/\/$/u, '') !== '/mercury-subtitles' || url.search || url.hash) {
    throw new MercuryError('UPDATE_REDIRECT_UNSAFE', '更新服务尝试跳转到未授权路径，已安全停止检查。');
  }
  return url;
}

export async function fetchRegistryFacts(fetcher: typeof fetch = fetch): Promise<RegistryFacts> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  let current = allowedRegistryUrl(UPDATE_REGISTRY_URL);
  try {
    for (let redirects = 0; redirects <= UPDATE_REDIRECT_LIMIT; redirects += 1) {
      let response: Response;
      try {
        response = await fetcher(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        const timedOut = controller.signal.aborted;
        throw new MercuryError(timedOut ? 'UPDATE_CHECK_TIMEOUT' : 'UPDATE_CHECK_OFFLINE', timedOut
          ? '检查更新超过 5 秒，已停止联网；当前 Mercury 可以继续使用。'
          : '暂时无法连接 Mercury 官方更新服务；当前 Mercury 可以继续使用。', {
          remediation: '检查网络后再次运行 mercury update --check。',
        });
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects === UPDATE_REDIRECT_LIMIT) {
          throw new MercuryError('UPDATE_REDIRECT_LIMIT', '更新服务重定向次数过多，已安全停止检查。');
        }
        const location = response.headers.get('location');
        if (!location) throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回了缺少目标的重定向。');
        current = allowedRegistryUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) {
        throw new MercuryError('UPDATE_REGISTRY_UNAVAILABLE', `更新服务暂时不可用（HTTP ${response.status}）；当前 Mercury 可以继续使用。`, {
          remediation: '稍后再次运行 mercury update --check。',
        });
      }
      const bytes = await responseBytes(response, controller.signal);
      let metadata: unknown;
      try {
        metadata = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new MercuryError('UPDATE_REGISTRY_INVALID', '更新服务返回了无法解析的数据，当前 Mercury 未做任何更改。');
      }
      return parseRegistryMetadata(metadata);
    }
    throw new MercuryError('UPDATE_REDIRECT_LIMIT', '更新服务重定向次数过多，已安全停止检查。');
  } finally {
    clearTimeout(timeout);
  }
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(() => true, () => false);
}

export async function runtimePackageRoot(): Promise<string> {
  const source = fileURLToPath(import.meta.url);
  const candidates = [path.resolve(path.dirname(source), '..'), path.resolve(path.dirname(source), '../..')];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')) as { name?: unknown };
      if (parsed.name === UPDATE_PACKAGE_NAME) return candidate;
    } catch {
      // Continue to the next fixed package-relative candidate.
    }
  }
  throw new MercuryError('UPDATE_INSTALLATION_UNKNOWN', '无法确认当前 Mercury 的安装根目录，因此不会自动升级。', {
    remediation: '运行 mercury update --check 查看手动升级方向。',
  });
}

export async function detectInstallationOrigin(
  packageRootInput: string,
  executablePathInput: string,
): Promise<InstallationOrigin> {
  const packageRoot = await realpath(packageRootInput).catch(() => path.resolve(packageRootInput));
  const executablePath = await realpath(executablePathInput).catch(() => path.resolve(executablePathInput));
  const executableRelative = path.relative(packageRoot, executablePath);
  let packageIdentityValid = false;
  try {
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown };
    packageIdentityValid = packageJson.name === UPDATE_PACKAGE_NAME;
  } catch {
    packageIdentityValid = false;
  }
  if (!packageIdentityValid || executableRelative.startsWith('..') || path.isAbsolute(executableRelative)) {
    return {
      kind: 'unknown', package_root: packageRoot, executable_path: executablePath, auto_apply: false,
      npm_global_prefix: null, npm_global_root: null, prefix_verified: false, prefix_error: null,
      reason: '当前执行入口与 Mercury 包身份无法相互验证，因此不会自动升级。',
    };
  }
  const normalized = packageRoot.split(path.sep).join('/');
  let kind: InstallationKind = 'unknown';
  let reason = '当前入口不符合已知的 npm 或源码安装布局。';
  if (/(?:^|\/)\.npm\/_npx\//u.test(normalized) || /(?:^|\/)npm-cache\/_npx\//u.test(normalized)) {
    kind = 'npm_exec';
    reason = '当前 Mercury 来自 npm exec / npx 临时目录，不能覆盖缓存。';
  } else if (path.basename(packageRoot) === UPDATE_PACKAGE_NAME && path.basename(path.dirname(packageRoot)) === 'node_modules') {
    const container = path.basename(path.dirname(path.dirname(packageRoot)));
    if (container === 'lib' || (process.platform === 'win32' && !normalized.includes('/node_modules/node_modules/'))) {
      kind = 'npm_global';
      reason = '当前 Mercury 位于 npm 全局安装目录。';
    } else {
      kind = 'npm_local';
      reason = '当前 Mercury 是项目本地依赖，Mercury 不会修改所属项目。';
    }
  } else if (await exists(path.join(packageRoot, '.git')) || await exists(path.join(packageRoot, 'src'))) {
    kind = 'source';
    reason = '当前 Mercury 从源码检出运行，不会用 npm 全局安装覆盖源码。';
  }
  let writable = false;
  if (kind === 'npm_global') {
    writable = await access(path.dirname(packageRoot), constants.W_OK).then(() => true, () => false);
    if (!writable) reason = '当前 Mercury 是 npm 全局安装，但安装目录不可写；不会请求 sudo。';
  }
  return {
    kind,
    package_root: packageRoot,
    executable_path: executablePath,
    auto_apply: false,
    npm_global_prefix: null,
    npm_global_root: null,
    prefix_verified: false,
    prefix_error: null,
    reason: kind === 'npm_global' && writable
      ? `${reason} 尚需用当前 Node.js 对应的 npm 核对实际全局前缀。`
      : reason,
  };
}

function absoluteSingleLine(value: string, label: string): string {
  const lines = value.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1 || !path.isAbsolute(lines[0]!)) {
    throw new MercuryError('UPDATE_NPM_PREFIX_INVALID', `npm 返回的${label}不是可验证的绝对路径，Mercury 不会自动升级。`, {
      exitCode: 4,
      remediation: '检查当前 Node.js/npm 的全局 prefix 配置后重新运行检查；不要使用 sudo。',
    });
  }
  return path.resolve(lines[0]!);
}

async function bindNpmGlobalInstallation(input: {
  installation: InstallationOrigin;
  nodeExecutable: string;
  npmCliPath?: string;
  spawnCommand?: SpawnCommand;
}): Promise<InstallationOrigin> {
  if (input.installation.kind !== 'npm_global') return input.installation;
  const npmCli = await trustedNpmCli(input.nodeExecutable, input.npmCliPath);
  const runner = input.spawnCommand ?? defaultSpawnCommand;
  let prefixResult: SpawnResult;
  let rootResult: SpawnResult;
  try {
    prefixResult = await runner(npmCli, ['prefix', '--global'], { timeoutMs: 5_000 });
    rootResult = await runner(npmCli, ['root', '--global'], { timeoutMs: 5_000 });
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('UPDATE_NPM_PREFIX_UNAVAILABLE', '无法安全读取当前 npm 的全局目录，Mercury 不会自动升级。', {
      exitCode: 4,
      remediation: '检查当前 Node.js/npm 配置后重新运行检查；不要使用 sudo。',
    });
  }
  if (prefixResult.code !== 0) {
    throw new MercuryError('UPDATE_NPM_PREFIX_UNAVAILABLE', '无法读取当前 npm 的全局 prefix，Mercury 不会自动升级。', {
      exitCode: 4,
      remediation: '检查当前 Node.js/npm 配置后重新运行检查；不要使用 sudo。',
    });
  }
  if (rootResult.code !== 0) {
    throw new MercuryError('UPDATE_NPM_PREFIX_UNAVAILABLE', '无法读取当前 npm 的全局模块目录，Mercury 不会自动升级。', {
      exitCode: 4,
      remediation: '检查当前 Node.js/npm 配置后重新运行检查；不要使用 sudo。',
    });
  }
  const prefixInput = absoluteSingleLine(prefixResult.stdout, '全局 prefix');
  const globalRootInput = absoluteSingleLine(rootResult.stdout, '全局模块目录');
  const prefix = await realpath(prefixInput).catch(() => prefixInput);
  const globalRoot = await realpath(globalRootInput).catch(() => globalRootInput);
  const packageRoot = await realpath(input.installation.package_root).catch(() => path.resolve(input.installation.package_root));
  const expectedPackageRoot = await realpath(path.join(globalRoot, UPDATE_PACKAGE_NAME))
    .catch(() => path.resolve(globalRoot, UPDATE_PACKAGE_NAME));
  const rootRelative = path.relative(prefix, globalRoot);
  const rootBoundToPrefix = !rootRelative.startsWith('..') && !path.isAbsolute(rootRelative);
  if (!rootBoundToPrefix || packageRoot !== expectedPackageRoot) {
    throw new MercuryError('UPDATE_NPM_PREFIX_MISMATCH', '当前 Mercury 不属于将执行安装的 npm 全局目录，已拒绝自动升级。', {
      exitCode: 4,
      remediation: '核对当前 mercury 与 npm 的实际来源；请用管理该安装的同一个 npm 更新，不要使用 sudo。',
    });
  }
  const writable = await access(globalRoot, constants.W_OK).then(() => true, () => false);
  return {
    ...input.installation,
    auto_apply: writable,
    npm_global_prefix: prefix,
    npm_global_root: globalRoot,
    prefix_verified: true,
    prefix_error: null,
    reason: writable
      ? '当前 Mercury 已与可信 npm 的实际全局 prefix 和模块目录完成绑定。'
      : '当前 Mercury 已绑定可信 npm 全局目录，但该目录不可写；不会请求 sudo。',
  };
}

function recommendedChannel(current: string, facts: RegistryFacts): UpdateChannel {
  const parsedCurrent = parseVersion(current);
  const parsedLatest = parseVersion(facts.latest.version);
  if (parsedCurrent.prerelease.length === 0) return 'latest';
  if (parsedLatest.prerelease.length === 0 && compareVersions(facts.latest.version, current) >= 0) return 'latest';
  return 'next';
}

function nextAction(origin: InstallationOrigin, updateAvailable: boolean, channel: UpdateChannel, target: string): string {
  if (!updateAvailable) return '当前渠道没有更高版本；无需安装。';
  if (origin.auto_apply) return `可确认后安装 ${target}（${channel}）；不会修改 Mercury 工作区或 Skill。`;
  if (origin.kind === 'npm_local') return `请在所属项目中把 mercury-subtitles 依赖更新到 ${target}；Mercury 不会改项目文件。`;
  if (origin.kind === 'npm_exec') return `下次运行 npx mercury-subtitles@${target}；Mercury 不会覆盖临时缓存。`;
  if (origin.kind === 'source') return '请按当前源码仓的开发/发布流程更新；Mercury 不会执行全局覆盖。';
  if (origin.kind === 'npm_global') return `${origin.reason} 请用管理当前安装的同一个 npm 更新；Mercury 不会猜测或请求 sudo。`;
  return `当前入口不能安全自动升级。可在确认安装方式后安装 mercury-subtitles@${target}，不要使用 sudo。`;
}

export async function checkForUpdates(input: {
  currentVersion: string;
  nodeVersion: string;
  packageRoot: string;
  executablePath: string;
  nodeExecutable?: string;
  npmCliPath?: string;
  spawnCommand?: SpawnCommand;
  fetch?: typeof fetch;
}): Promise<UpdateCheckResult> {
  parseVersion(input.currentVersion);
  const facts = await fetchRegistryFacts(input.fetch);
  const detected = await detectInstallationOrigin(input.packageRoot, input.executablePath);
  let installation = detected;
  if (detected.kind === 'npm_global') {
    try {
      installation = await bindNpmGlobalInstallation({
        installation: detected,
        nodeExecutable: input.nodeExecutable ?? process.execPath,
        ...(input.npmCliPath ? { npmCliPath: input.npmCliPath } : {}),
        ...(input.spawnCommand ? { spawnCommand: input.spawnCommand } : {}),
      });
    } catch (error) {
      if (!(error instanceof MercuryError) || !error.code.startsWith('UPDATE_NPM_')) throw error;
      installation = {
        ...detected,
        auto_apply: false,
        prefix_verified: false,
        prefix_error: error.code,
        reason: error.message,
      };
    }
  }
  const channel = recommendedChannel(input.currentVersion, facts);
  const target = facts[channel];
  const compared = compareVersions(target.version, input.currentVersion);
  const updateAvailable = compared > 0;
  const nodeCompatible = nodeSatisfiesEngine(input.nodeVersion, target.node_engine);
  return {
    current_version: input.currentVersion,
    latest_version: facts.latest.version,
    next_version: facts.next.version,
    recommended_channel: channel,
    recommended_version: target.version,
    update_available: updateAvailable,
    status: compared > 0 ? 'update_available' : compared === 0 ? 'up_to_date' : 'remote_older',
    installation,
    target_node_engine: target.node_engine,
    current_node_version: input.nodeVersion,
    node_compatible: nodeCompatible,
    can_auto_apply: updateAvailable && nodeCompatible && installation.auto_apply,
    next_action: nodeCompatible
      ? nextAction(installation, updateAvailable, channel, target.version)
      : `目标版本需要 Node.js ${target.node_engine}；请先切换到兼容 Node.js，再重新检查。`,
    skill: { managed_separately: true, update_command: 'npx skills update mercury-subtitles' },
  };
}

export async function defaultSpawnCommand(command: string, args: string[], options: { timeoutMs: number }): Promise<SpawnResult> {
  return await new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, { shell: false, detached: useProcessGroup, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;
    let forcedError: MercuryError | null = null;
    let terminateTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      clearTimeout(timeout);
      if (terminateTimer) clearTimeout(terminateTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const settleRejected = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const terminate = (error: MercuryError) => {
      if (forcedError) return;
      forcedError = error;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (useProcessGroup && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The process may have exited between the deadline and the signal.
        }
      };
      kill('SIGTERM');
      terminateTimer = setTimeout(() => kill('SIGKILL'), 100);
      hardTimer = setTimeout(() => settleRejected(error), 500);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      if (forcedError) return;
      total += chunk.length;
      if (total > 256 * 1024) {
        terminate(new MercuryError('UPDATE_COMMAND_OUTPUT_TOO_LARGE', '升级命令输出过大，已停止并保留当前安装。'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.once('error', () => settleRejected(new MercuryError('UPDATE_COMMAND_START_FAILED', '无法启动受控升级命令，当前安装未被确认修改。', {
      remediation: '检查当前 Node.js/npm 安装与执行权限后重新运行更新检查；不要使用 sudo。',
    })));
    const timeout = setTimeout(() => terminate(new MercuryError('UPDATE_COMMAND_TIMEOUT', '升级命令超过安全时限，已终止；不会把晚到的成功当作已升级。', {
      remediation: '检查 npm/网络状态后重新运行更新检查；不要重复运行仍在执行的安装进程。',
    })), options.timeoutMs);
    child.once('close', (code) => {
      if (settled) return;
      clearTimers();
      if (forcedError) {
        settled = true;
        reject(forcedError);
        return;
      }
      settled = true;
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function trustedNpmCli(nodeExecutable: string, explicit?: string): Promise<string> {
  const candidate = explicit ?? path.join(path.dirname(nodeExecutable), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const resolved = await realpath(candidate).catch(() => '');
  if (!resolved) {
    throw new MercuryError('UPDATE_NPM_UNAVAILABLE', '没有找到与当前 Node.js 安装对应的 npm，未执行升级。', {
      remediation: '修复 Node.js 24/npm 安装后重新运行检查；不要使用 sudo。',
    });
  }
  const resolvedNode = await realpath(nodeExecutable).catch(() => path.resolve(nodeExecutable));
  const root = path.resolve(path.dirname(resolvedNode), '..');
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MercuryError('UPDATE_NPM_UNTRUSTED', 'npm 不属于当前 Node.js 安装，Mercury 拒绝自动执行。', {
      remediation: '修复 Node.js/npm 安装来源后重试；Mercury 不会执行 PATH 中的未知命令。',
    });
  }
  const entry = await lstat(resolved);
  if (!entry.isFile()) throw new MercuryError('UPDATE_NPM_UNTRUSTED', 'npm 入口不是普通文件，Mercury 拒绝自动执行。');
  return candidate;
}

export async function applyUpdate(input: {
  currentVersion: string;
  nodeVersion: string;
  packageRoot: string;
  executablePath: string;
  nodeExecutable: string;
  yes: boolean;
  channel?: UpdateChannel;
  version?: string;
  fetch?: typeof fetch;
  spawnCommand?: SpawnCommand;
  npmCliPath?: string;
}): Promise<UpdateApplyResult> {
  if (!input.yes) {
    throw new MercuryError('UPDATE_CONFIRMATION_REQUIRED', '自动升级必须明确提供 --yes；未执行任何写入。', {
      exitCode: 2,
      remediation: '确认目标版本和安装来源后，再运行带 --yes 的 update apply。',
    });
  }
  if ((input.channel ? 1 : 0) + (input.version ? 1 : 0) !== 1) {
    throw new MercuryError('UPDATE_TARGET_REQUIRED', 'update apply 必须且只能指定 --channel 或 --version。', { exitCode: 2 });
  }
  const facts = await fetchRegistryFacts(input.fetch);
  const requestedVersion = input.version ?? facts[input.channel!].version;
  const target = facts.versions.get(requestedVersion);
  if (!target) {
    throw new MercuryError('UPDATE_VERSION_NOT_FOUND', `官方更新服务没有发布 ${requestedVersion}，未执行升级。`, {
      exitCode: 2,
      remediation: '重新检查 latest/next，或核对确切版本号。',
    });
  }
  const comparison = compareVersions(requestedVersion, input.currentVersion);
  const direction = comparison > 0 ? 'upgrade' : comparison < 0 ? 'downgrade' : 'same';
  if (input.channel && comparison < 0) {
    throw new MercuryError('UPDATE_CHANNEL_OLDER', `${input.channel} 当前指向较低版本 ${requestedVersion}，不会按渠道自动降级。`, {
      exitCode: 3,
      remediation: `如确需回退，请明确使用 --version ${requestedVersion}；回退不是推荐升级。`,
    });
  }
  if (!nodeSatisfiesEngine(input.nodeVersion, target.node_engine)) {
    throw new MercuryError('UPDATE_NODE_INCOMPATIBLE', `当前 Node.js ${input.nodeVersion} 不满足目标版本要求 ${target.node_engine}，未执行升级。`, {
      exitCode: 4,
      remediation: '先切换到兼容的 Node.js，再重新运行 update apply；Mercury 不会自动切换 Node。',
    });
  }
  const baseCheck = await checkForUpdates({
    currentVersion: input.currentVersion,
    nodeVersion: input.nodeVersion,
    packageRoot: input.packageRoot,
    executablePath: input.executablePath,
    nodeExecutable: input.nodeExecutable,
    ...(input.npmCliPath ? { npmCliPath: input.npmCliPath } : {}),
    ...(input.spawnCommand ? { spawnCommand: input.spawnCommand } : {}),
    fetch: async () => Response.json({
      name: UPDATE_PACKAGE_NAME,
      'dist-tags': { latest: facts.latest.version, next: facts.next.version },
      versions: Object.fromEntries([...facts.versions].map(([version, fact]) => [version, { name: UPDATE_PACKAGE_NAME, version, engines: { node: fact.node_engine } }])),
    }),
  });
  const installation = baseCheck.installation;
  if (comparison === 0) {
    return {
      ...baseCheck,
      requested: { channel: input.channel ?? null, version: requestedVersion, direction },
      applied: false,
      verified_version: input.currentVersion,
      npm: { command: '', arguments: [], exit_code: null },
    };
  }
  if (!installation.auto_apply) {
    if (installation.prefix_error) {
      throw new MercuryError(installation.prefix_error, installation.reason, {
        exitCode: 4,
        remediation: '核对当前 mercury 与 npm 的实际来源；请用管理该安装的同一个 npm 更新，不要使用 sudo。',
      });
    }
    throw new MercuryError('UPDATE_INSTALLATION_NOT_WRITABLE', `当前安装来源为 ${installation.kind}，Mercury 不会自动覆盖。`, {
      exitCode: 4,
      remediation: nextAction(installation, true, input.channel ?? 'latest', requestedVersion),
    });
  }
  const npmCli = await trustedNpmCli(input.nodeExecutable, input.npmCliPath);
  const verifiedPrefix = installation.npm_global_prefix;
  if (!verifiedPrefix || !installation.prefix_verified) {
    throw new MercuryError('UPDATE_NPM_PREFIX_MISMATCH', '当前 Mercury 未与将执行安装的 npm global prefix 完成绑定，已拒绝自动升级。', {
      exitCode: 4,
      remediation: '重新运行更新检查并核对安装来源；不要使用 sudo。',
    });
  }
  const npmArgs = [
    'install', '--global', '--prefix', verifiedPrefix, `${UPDATE_PACKAGE_NAME}@${requestedVersion}`,
    '--registry', 'https://registry.npmjs.org/', '--no-audit', '--no-fund', '--ignore-scripts',
  ];
  const runner = input.spawnCommand ?? defaultSpawnCommand;
  let installed: SpawnResult;
  try {
    installed = await runner(npmCli, npmArgs, { timeoutMs: 120_000 });
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('UPDATE_INSTALL_FAILED', 'npm 安装进程异常结束；Mercury 工作区未被修改。', {
      remediation: '检查 npm、安装目录权限和网络后重新检查；Mercury 不会请求 sudo。',
    });
  }
  if (installed.code !== 0) {
    throw new MercuryError('UPDATE_INSTALL_FAILED', `npm 未能完成安装（退出码 ${installed.code ?? 'unknown'}）；Mercury 工作区未被修改。`, {
      remediation: '检查安装目录权限和网络后重新检查；Mercury 不会请求 sudo。',
    });
  }
  let verified: SpawnResult;
  try {
    verified = await runner(input.nodeExecutable, [input.executablePath, '--version'], { timeoutMs: 5_000 });
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('UPDATE_VERIFY_FAILED', '安装后无法启动实际 Mercury 入口完成版本复核。', {
      remediation: '重新打开终端并运行 mercury --version；检查 PATH 指向后再决定是否重试。',
    });
  }
  const verifiedVersion = verified.stdout.trim();
  if (verified.code !== 0 || verifiedVersion !== requestedVersion) {
    throw new MercuryError('UPDATE_VERIFY_FAILED', `安装后实际入口版本为 ${verifiedVersion || '无法读取'}，与目标 ${requestedVersion} 不一致。`, {
      remediation: '重新打开终端并运行 mercury --version；检查 PATH 指向后再决定是否重试。',
    });
  }
  return {
    ...baseCheck,
    requested: { channel: input.channel ?? null, version: requestedVersion, direction },
    applied: true,
    verified_version: verifiedVersion,
    npm: { command: npmCli, arguments: npmArgs, exit_code: installed.code },
    next_action: `CLI 已验证为 ${verifiedVersion}。Skill 独立管理；需要时运行 npx skills update mercury-subtitles。`,
  };
}
