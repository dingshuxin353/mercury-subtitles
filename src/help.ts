import { MercuryError } from './errors.js';

type Effect = 'none' | 'local_read' | 'local_write' | 'network_read' | 'network_write' | 'provider';

export interface CommandFact {
  name: string;
  summary: string;
  usage: string;
  example: string;
  required?: string[];
  optional?: string[];
  effects: Effect[];
  next: string;
}

export interface CommandGroup {
  name: string;
  title: string;
  summary: string;
  commands: CommandFact[];
}

const GROUPS: CommandGroup[] = [
  {
    name: 'task', title: '字幕任务', summary: '创建、查看、控制任务并找回结果。', commands: [
      { name: 'submit', summary: '从稳定 request JSON 创建后台任务。', usage: 'mercury task submit --request <绝对路径> --json', example: 'mercury task submit --request "/tmp/request.json" --json', required: ['--request：mercury.exchange.request/v1 的绝对路径'], effects: ['local_write', 'provider'], next: '保存返回的 task ID；用 task status 查询，不要更换 request ID 重提。' },
      { name: 'status', summary: '只读查看一个任务的当前状态与下一步。', usage: 'mercury task status <task-id> --json', example: 'mercury task status tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_read'], next: '按 current_actions 与 next_action 决定暂停、恢复、审阅或打开结果。' },
      { name: 'list', summary: '只读列出本地任务。', usage: 'mercury task list [--limit <1-100>] [--cursor <游标>] --json', example: 'mercury task list --limit 10 --json', optional: ['--limit、--cursor'], effects: ['local_read'], next: '选择 task ID 后运行 task status 或 task result。' },
      { name: 'watch', summary: '从事件序号只读跟随任务，不触发 Worker。', usage: 'mercury task watch <task-id> [--after <序号>] --jsonl', example: 'mercury task watch tsk-20260101-120000-abcd1234 --after 0 --jsonl', required: ['task-id'], optional: ['--after'], effects: ['local_read'], next: '终态事件出现后用 task result 获取可信产物路径。' },
      { name: 'result', summary: '只读获取任务结果与产物。', usage: 'mercury task result <task-id> --json', example: 'mercury task result tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_read'], next: '有待审阅修改时进入 review；已批准时直接打开 approved.srt。' },
      { name: 'pause', summary: '请求任务在可证明安全的检查点暂停。', usage: 'mercury task pause <task-id> --json', example: 'mercury task pause tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_write'], next: '状态为 pausing 时继续只读查询；不要中止已发出的 Provider 请求。' },
      { name: 'resume', summary: '从安全检查点恢复同一 attempt。', usage: 'mercury task resume <task-id> --json', example: 'mercury task resume tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_write', 'provider'], next: '保存返回状态；response_persisted 恢复不会重复 Provider。' },
      { name: 'retry-plan', summary: '严格只读生成安全重试计划。', usage: 'mercury task retry-plan <task-id> --json', example: 'mercury task retry-plan tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_read'], next: '仅在 allowed=true 且用户接受预计调用时执行 retry。' },
      { name: 'retry', summary: '按未过期计划显式创建新 attempt。', usage: 'mercury task retry <task-id> --plan <plan-id> --json', example: 'mercury task retry tsk-20260101-120000-abcd1234 --plan rpl-abc123 --json', required: ['task-id、--plan'], effects: ['local_write', 'provider'], next: '保存同一 task ID；不要重复执行相同计划。' },
      { name: 'deliver', summary: '本地重试交付当前 approved.srt。', usage: 'mercury task deliver <task-id> --json', example: 'mercury task deliver tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_write'], next: '只在 approved 已存在且 delivery 建议恢复时执行；不会调用 Provider。' },
      { name: 'cancel', summary: '取消尚可安全停止的任务。', usage: 'mercury task cancel <task-id> --json', example: 'mercury task cancel tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_write'], next: '若 Provider 已 in-flight，等待安全边界；不要重提相同任务。' },
    ],
  },
  {
    name: 'model', title: '模型与服务', summary: '查看、添加、检查和维护 ASR/Chat 模型。', commands: [
      { name: 'list', summary: '查看已配置模型；普通用户推荐在 App 模型中心操作。', usage: 'mercury model list [--json]', example: 'mercury model list', effects: ['local_read'], next: '需要配置时运行 mercury，进入“模型与服务”。' },
      { name: 'add', summary: '在交互终端隐藏输入新增模型。', usage: 'mercury model add', example: 'mercury model add', effects: ['local_write'], next: '新增后执行 model check，再设为默认。' },
      { name: 'edit', summary: '交互编辑一个模型。', usage: 'mercury model edit --model <model-id>', example: 'mercury model edit --model chat-default', required: ['--model'], effects: ['local_write'], next: '编辑后重新检查模型。' },
      { name: 'check', summary: '检查模型是否真正可用。', usage: 'mercury model check --model <model-id> [--audio <MP3>]', example: 'mercury model check --model chat-default', required: ['--model'], optional: ['ASR/强 Chat 使用 --audio'], effects: ['network_write', 'provider'], next: '通过后可设为默认并创建任务。' },
      { name: 'enable', summary: '启用模型。', usage: 'mercury model enable --model <model-id>', example: 'mercury model enable --model chat-default', required: ['--model'], effects: ['local_write'], next: '检查模型并确认默认选择。' },
      { name: 'disable', summary: '停用非默认模型。', usage: 'mercury model disable --model <model-id>', example: 'mercury model disable --model chat-backup', required: ['--model'], effects: ['local_write'], next: '如需继续使用同类任务，确认仍有可用默认模型。' },
      { name: 'default', summary: '把模型设为所属用途的默认项。', usage: 'mercury model default --model <model-id>', example: 'mercury model default --model chat-default', required: ['--model'], effects: ['local_write'], next: '新任务将使用该默认模型。' },
      { name: 'delete', summary: '删除一个模型配置；需要明确目标。', usage: 'mercury model delete --model <model-id>', example: 'mercury model delete --model chat-backup', required: ['--model'], effects: ['local_write'], next: '确认默认模型仍存在；历史任务事实不会被改写。' },
    ],
  },
  {
    name: 'dictionary', title: '词典', summary: '管理全局/项目词典及条目 revision。', commands: [
      { name: 'create', summary: '创建全局或项目词典。', usage: 'mercury dictionary create --name <名称> --scope global|project [--project <key>] --json', example: 'mercury dictionary create --name "产品术语" --scope project --project demo --json', required: ['--name、--scope；project 还需 --project'], effects: ['local_write'], next: '保存 dictionary_id/revision，再用 entry add 新增词条。' },
      { name: 'list', summary: '只读列出词典。', usage: 'mercury dictionary list [--scope global|project] [--project <key>] --json', example: 'mercury dictionary list --json', effects: ['local_read'], next: '用 dictionary show 查看 revision 与条目。' },
      { name: 'show', summary: '只读查看词典当前或指定 revision。', usage: 'mercury dictionary show <dictionary-id> [--revision <revision>] --json', example: 'mercury dictionary show dict-product-terms --json', required: ['dictionary-id'], effects: ['local_read'], next: '修改时必须使用刚读取的 revision。' },
      { name: 'entry add', summary: '按 revision 乐观并发新增词条。', usage: 'mercury dictionary entry add <dictionary-id> --revision <rev> --entry-id <entry-id> --canonical <正文> [--variant <写法>] --json', example: 'mercury dictionary entry add dict-product-terms --revision rev-abc123 --entry-id entry-wan-3-0 --canonical "Wan 3.0" --json', required: ['dictionary-id、--revision、--entry-id（entry- 前缀）、--canonical'], effects: ['local_write'], next: '保存返回的新 revision；后续编辑必须使用新 revision。' },
      { name: 'entry edit', summary: '按 revision 编辑已有词条。', usage: 'mercury dictionary entry edit <dictionary-id> --revision <rev> --entry-id <entry-id> [字段] --json', example: 'mercury dictionary entry edit dict-product-terms --revision rev-abc123 --entry-id entry-wan-3-0 --variant "千问万3.0" --json', required: ['dictionary-id、--revision、--entry-id'], effects: ['local_write'], next: '保存新 revision；冲突时重新 show，不要覆盖他人修改。' },
      { name: 'entry remove', summary: '按 revision 删除词条。', usage: 'mercury dictionary entry remove <dictionary-id> --revision <rev> --entry-id <entry-id> --json', example: 'mercury dictionary entry remove dict-product-terms --revision rev-abc123 --entry-id entry-old --json', required: ['dictionary-id、--revision、--entry-id'], effects: ['local_write'], next: '确认新 revision 与剩余条目。' },
      { name: 'validate', summary: '只读验证 JSON/CSV 词典文件。', usage: 'mercury dictionary validate --file <绝对路径> --json', example: 'mercury dictionary validate --file "/tmp/terms.csv" --json', required: ['--file'], effects: ['local_read'], next: '通过后先运行 import --dry-run。' },
      { name: 'import', summary: '先 dry-run，再用 plan ID 确认导入。', usage: 'mercury dictionary import --dictionary <id> --file <绝对路径> --format json|csv --dry-run --json', example: 'mercury dictionary import --dictionary dict-product-terms --file "/tmp/terms.csv" --format csv --dry-run --json', required: ['--dictionary、--file、--format'], optional: ['写入时用 --confirm <plan-id> 替代 --dry-run'], effects: ['local_read', 'local_write'], next: '核对 dry-run 后，用同一文件和 --confirm plan-id 写入。' },
      { name: 'export', summary: '导出一个不可覆盖的 JSON/CSV 文件。', usage: 'mercury dictionary export <dictionary-id> --format json|csv --output <绝对路径> --json', example: 'mercury dictionary export dict-product-terms --format json --output "/tmp/terms.json" --json', required: ['dictionary-id、--format、--output'], effects: ['local_read', 'local_write'], next: '保存输出 hash；Mercury 不覆盖已有文件。' },
    ],
  },
  {
    name: 'worker', title: '后台 Worker', summary: '只读查看或显式启动本地单 Worker。', commands: [
      { name: 'status', summary: '只读查看 Worker，不会启动任务。', usage: 'mercury worker status --json', example: 'mercury worker status --json', effects: ['local_read'], next: '有安全 queued 任务且 Worker 停止时，显式运行 worker start。' },
      { name: 'start', summary: '仅在存在安全 queued 任务时启动 Worker。', usage: 'mercury worker start --json', example: 'mercury worker start --json', effects: ['local_write'], next: '用 task status/watch 只读跟踪；不要重复提交任务。' },
    ],
  },
  {
    name: 'review', title: '人工审阅', summary: '查看文字修改、逐项决定并生成 approved.srt。', commands: [
      { name: 'status', summary: '只读查看审阅状态。', usage: 'mercury review status <task-id> --json', example: 'mercury review status tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_read'], next: 'pending 时用 review list；finalized 时打开 approved.srt。' },
      { name: 'list', summary: '分页只读列出审阅变更。', usage: 'mercury review list <task-id> [--after <change-id>] [--limit <1-50>] --json', example: 'mercury review list tsk-20260101-120000-abcd1234 --limit 10 --json', required: ['task-id'], effects: ['local_read'], next: '对 change ID 使用 decide；不要跨 cue 改时间轴。' },
      { name: 'decide', summary: '接受、拒绝或编辑一个文字变更。', usage: 'mercury review decide <task-id> --change <id> (--accept|--reject|--text <正文>) --json', example: 'mercury review decide tsk-20260101-120000-abcd1234 --change chg-abc --accept --json', required: ['task-id、--change、三种决定之一'], effects: ['local_write'], next: '继续处理 pending；完成后 finalize。' },
      { name: 'accept-all', summary: '按精确 pending 数确认接受剩余变更。', usage: 'mercury review accept-all <task-id> --confirm-count <n> --json', example: 'mercury review accept-all tsk-20260101-120000-abcd1234 --confirm-count 3 --json', required: ['task-id、--confirm-count'], effects: ['local_write'], next: '确认 pending=0 后运行 finalize。' },
      { name: 'finalize', summary: '从全部决定生成或复用 approved.srt。', usage: 'mercury review finalize <task-id> --json', example: 'mercury review finalize tsk-20260101-120000-abcd1234 --json', required: ['task-id'], effects: ['local_write'], next: '打开 approved 绝对路径；配置业务目录时会本地交付。' },
    ],
  },
  {
    name: 'protocol', title: '协议能力', summary: '供 Agent/外部软件只读发现稳定合同。', commands: [
      { name: 'version', summary: '只读返回协议版本。', usage: 'mercury protocol version --json', example: 'mercury protocol version --json', effects: ['none'], next: '按返回的 v1 合同构造稳定请求。' },
      { name: 'capabilities', summary: '只读返回当前 CLI 能力。', usage: 'mercury protocol capabilities --json', example: 'mercury protocol capabilities --json', effects: ['none'], next: '只调用 advertised capability；不要从 provider 名猜 model ID。' },
    ],
  },
  {
    name: 'config', title: '配置状态', summary: '只读发现配置，或显式迁移旧配置。', commands: [
      { name: 'status', summary: '只读返回模型 ID、默认项与就绪状态。', usage: 'mercury config status --json', example: 'mercury config status --json', effects: ['local_read'], next: '未配置时运行 mercury，进入“模型与服务”并隐藏输入密钥。' },
      { name: 'migrate', summary: '先只读 check，再用 plan ID 显式迁移。', usage: 'mercury config migrate --check --json | mercury config migrate --plan <plan-id> --json', example: 'mercury config migrate --check --json', effects: ['local_read', 'local_write'], next: '核对计划后才执行 --plan；失败会保留 0600 备份。' },
    ],
  },
  {
    name: 'skill', title: 'Agent / Skill', summary: '查看随包 Skill；CLI 与 Skill 更新相互独立。', commands: [
      { name: 'status', summary: '只读查看 Mercury Skill 安装事实。', usage: 'mercury skill status --json', example: 'mercury skill status --json', effects: ['local_read'], next: '安装/更新优先使用标准 Skills CLI。' },
      { name: 'install', summary: '旧版兼容安装入口；新用户优先标准 Skills CLI。', usage: 'mercury skill install [--target <目录>] --json', example: 'mercury skill install --json', effects: ['local_write'], next: '今后使用 npx skills update mercury-subtitles 更新 Skill。' },
    ],
  },
  {
    name: 'update', title: '检查与更新 CLI', summary: '显式检查官方版本；只在可信 npm global 中确认后自动更新。', commands: [
      { name: 'check', summary: '只读检查 latest/next、Node 与安装来源。', usage: 'mercury update check --json', example: 'mercury update check --json', effects: ['network_read'], next: '普通用户也可运行 mercury update --check；检查不会更新 Skill。' },
      { name: 'apply', summary: '机器模式显式安装渠道或确切版本。', usage: 'mercury update apply (--channel latest|next|--version <exact>) --yes --json', example: 'mercury update apply --channel latest --yes --json', required: ['--channel 或 --version 二选一、--yes'], effects: ['network_write', 'local_write'], next: '重开终端运行 mercury --version；Skill 另用 npx skills update mercury-subtitles。' },
    ],
  },
  {
    name: 'input', title: '输入检查', summary: '只读检查 MP3/SRT/VTT/transcript JSON。', commands: [
      { name: 'inspect', summary: '验证绝对路径、格式、角色与 hash。', usage: 'mercury input inspect --file <绝对路径> --format auto|mp3|srt|vtt|transcript-json --role media|transcript-source|reference --json', example: 'mercury input inspect --file "/tmp/subtitles.srt" --format srt --role transcript-source --json', required: ['--file、--format、--role'], effects: ['local_read'], next: '把返回的路径/hash/角色写入稳定 request；机器模式不猜角色。' },
    ],
  },
];

const ROOT_GROUP_NAMES = GROUPS.map((group) => group.name);
const LEGACY = `Mercury 兼容命令（deprecated）

这些入口继续可执行，但不用于新的 Agent/脚本。完整稳定命令请查看 mercury help。

  mercury setup [--config <setup.json>] [--confirm-cloud-data]
  mercury calibrate --audio <MP3> [--srt <SRT>] [--background]
  mercury request id --audio <MP3> --intent <stable-label> --json
  mercury model add|edit|enable|disable|default|delete ...
  mercury task ... --experimental
  mercury worker ... --experimental
  mercury review ... --experimental

副作用：setup/model 会写配置；calibrate 可能调用 Provider；--experimental 只保留旧合同。
下一步：新自动化使用 mercury.cli/v1；普通用户直接运行 mercury。
`;

export function mainHelp(version: string): string {
  return `Mercury ${version}｜中文 AI 字幕

第一次使用
  mercury                         打开交互式 App（推荐）
  在“模型与服务”中隐藏输入凭据，然后创建第一份字幕任务

创建字幕
  mercury                         从 App 创建任务
  mercury task submit --request <request.json> --json
                                  Agent/脚本稳定提交

查看与继续
  mercury task list --limit 10 --json
  mercury task status <task-id> --json
  mercury review status <task-id> --json

管理
  mercury                         模型、词典、最近任务
  mercury update --check          只读检查 CLI 更新

Agent / Skill
  mercury protocol capabilities --json
  npx skills update mercury-subtitles

获取更多帮助
  mercury help task               查看任务命令
  mercury help update             查看安全升级
  mercury help <组> <命令>         查看具体用法
  mercury help legacy             查看兼容命令
`;
}

function effectsText(effects: Effect[]): string {
  if (effects.length === 1 && effects[0] === 'none') return '不联网、不写入、不调用 Provider。';
  const network = effects.includes('network_read') ? '只读联网' : effects.includes('network_write') ? '联网并安装' : '不联网';
  const writes = effects.includes('local_write') ? '会写入明确的本地目标' : '不写入';
  const provider = effects.includes('provider') ? '按任务状态可能调用 Provider' : '不调用 Provider';
  return `${network}；${writes}；${provider}。`;
}

function commandHelp(group: CommandGroup, command: CommandFact): string {
  return `${group.title} / ${command.name}

${command.summary}

用法
  ${command.usage}
${command.required?.length ? `\n+必填\n${command.required.map((item) => `  ${item}`).join('\n')}\n` : ''}${command.optional?.length ? `\n+可选\n${command.optional.map((item) => `  ${item}`).join('\n')}\n` : ''}
示例
  ${command.example}

副作用
  ${effectsText(command.effects)}

下一步
  ${command.next}
`;
}

function groupHelp(group: CommandGroup): string {
  const lines = group.commands.map((command) => `  ${command.name.padEnd(14)} ${command.summary}`);
  return `${group.title}（${group.name}）

${group.summary}

子命令
${lines.join('\n')}

查看具体命令
  mercury help ${group.name} <命令>

示例
  mercury help ${group.name} ${group.commands[0]!.name}
`;
}

function helpPath(args: string[]): string[] | null {
  if (args[0] === '--help' || args[0] === '-h') return [];
  if (args[0] === 'help') return args.slice(1).filter((value) => !value.startsWith('-'));
  const hasHelp = args.includes('--help') || args.includes('-h');
  const group = GROUPS.find((candidate) => candidate.name === args[0]);
  if (group?.name === 'update' && args.length === 1) return null;
  if (group && (args.length === 1 || hasHelp)) {
    const beforeHelp = args.slice(1, args.findIndex((value) => value === '--help' || value === '-h'));
    return [group.name, ...beforeHelp.filter((value) => !value.startsWith('-'))];
  }
  return null;
}

export function renderHelp(args: string[], version: string): string | null {
  const path = helpPath(args);
  if (path === null) return null;
  if (path.length === 0) return mainHelp(version);
  if (path[0] === 'legacy') return LEGACY;
  const group = GROUPS.find((candidate) => candidate.name === path[0]);
  if (!group) {
    const suggestion = suggest(path[0] ?? '', ROOT_GROUP_NAMES);
    throw new MercuryError('CLI_HELP_TOPIC_INVALID', `没有名为“${path.join(' ')}”的帮助主题。`, {
      exitCode: 2,
      remediation: suggestion ? `你是否想查看 mercury help ${suggestion}？` : '运行 mercury help 查看可用帮助组。',
    });
  }
  if (path.length === 1) return groupHelp(group);
  const requested = path.slice(1).join(' ');
  const command = [...group.commands].sort((left, right) => right.name.length - left.name.length)
    .find((candidate) => requested === candidate.name || requested.startsWith(`${candidate.name} `));
  if (command) return commandHelp(group, command);
  const suggestion = suggest(requested, group.commands.map((candidate) => candidate.name));
  throw new MercuryError('CLI_HELP_TOPIC_INVALID', `“${group.name} ${requested}”不是可用命令。`, {
    exitCode: 2,
    remediation: suggestion
      ? `你是否想查看 mercury help ${group.name} ${suggestion}？只显示建议，不会执行命令。`
      : `运行 mercury help ${group.name} 查看该组命令。`,
  });
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function suggest(value: string, candidates: string[]): string | null {
  const ranked = candidates.map((candidate) => ({ candidate, distance: editDistance(value, candidate) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate, 'en'));
  const best = ranked[0];
  if (!best) return null;
  const threshold = Math.max(1, Math.min(3, Math.floor(Math.max(value.length, best.candidate.length) / 3)));
  return best.distance <= threshold ? best.candidate : null;
}

export function unknownCommandRemediation(args: string[]): string {
  const group = GROUPS.find((candidate) => candidate.name === args[0]);
  if (group && args[1]) {
    const requested = args.slice(1).filter((item) => !item.startsWith('-')).join(' ');
    const candidate = suggest(requested, group.commands.map((command) => command.name));
    return candidate
      ? `你是否想运行 mercury ${group.name} ${candidate}？该建议未执行。先运行 mercury help ${group.name} ${candidate} 查看用法。`
      : `运行 mercury help ${group.name} 查看该组命令；没有自动执行任何猜测。`;
  }
  const candidate = suggest(args[0] ?? '', ROOT_GROUP_NAMES);
  return candidate
    ? `你是否想运行 mercury ${candidate}？该建议未执行。先运行 mercury help ${candidate} 查看用法。`
    : '运行 mercury help 查看命令；没有自动执行任何猜测。';
}

export function localCommandHelpRemediation(args: string[]): string {
  const group = GROUPS.find((candidate) => candidate.name === args[0]);
  if (group) {
    const requested = args.slice(1).filter((item) => !item.startsWith('-')).join(' ');
    const command = [...group.commands]
      .sort((left, right) => right.name.length - left.name.length)
      .find((candidate) => requested === candidate.name || requested.startsWith(`${candidate.name} `));
    return command
      ? `运行 mercury help ${group.name} ${command.name} 查看完整用法。`
      : `运行 mercury help ${group.name} 查看该组命令。`;
  }
  if (['setup', 'calibrate', 'request'].includes(args[0] ?? ''))
    return '运行 mercury help legacy 查看该兼容命令；普通用户推荐直接运行 mercury。';
  return '运行 mercury help 查看可用命令。';
}

export function helpGroups(): readonly CommandGroup[] {
  return GROUPS;
}
