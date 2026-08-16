import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Entry, ExchangeDictionaryV1 } from '../contracts/generated/exchange-dictionary-v1.js';
import { createDictionary, listDictionaries, makeDictionaryEntry, mutateDictionary, readDictionary, validateDictionaryDocument } from '../dictionary.js';
import { MercuryError } from '../errors.js';
import { canonicalJson } from '../exchange/storage.js';
import { sha256File } from '../tasks.js';

function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function values(args: string[], name: string): string[] { const result: string[] = []; for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1]) result.push(args[++i]!); return result; }
function required(args: string[], name: string): string { const found = option(args, name); if (!found || found.startsWith('--')) throw new MercuryError('CLI_OPTION_VALUE_MISSING', `${name} 缺少参数值。`, { exitCode: 2 }); return found; }
function bool(value: string | undefined, fallback: boolean): boolean { if (value === undefined) return fallback; if (value === 'true') return true; if (value === 'false') return false; throw new MercuryError('CLI_ARGUMENT_INVALID', '布尔值必须是 true 或 false。', { exitCode: 2 }); }
function ensureOnly(args: string[], valued: string[], flags: string[] = []) { const allowed = new Set([...valued, ...flags, '--json']); for (let index = 0; index < args.length; index += 1) { const entry = args[index]!; if (!allowed.has(entry)) throw new MercuryError('CLI_ARGUMENT_INVALID', `不支持的参数：${entry}`, { exitCode: 2 }); if (valued.includes(entry)) { if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new MercuryError('CLI_OPTION_VALUE_MISSING', `${entry} 缺少参数值。`, { exitCode: 2 }); index += 1; } } }

function parseCsv(source: string, now = () => new Date()): Entry[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) { if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; } else if (char === '"') quoted = false; else field += char; }
    else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/u, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new MercuryError('DICTIONARY_IMPORT_INVALID', 'CSV 引号未闭合。', { exitCode: 2 });
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  const expected = ['entry_id', 'canonical', 'variants', 'kind', 'language', 'case_sensitive', 'number_sensitive', 'notes', 'tags', 'enabled'];
  if (!header || header.join(',') !== expected.join(',')) throw new MercuryError('DICTIONARY_IMPORT_INVALID', `CSV 表头必须是 ${expected.join(',')}`, { exitCode: 2 });
  return rows.filter((candidate) => candidate.some(Boolean)).map((candidate, index) => {
    if (candidate.length !== expected.length) throw new MercuryError('DICTIONARY_IMPORT_INVALID', `CSV 第 ${index + 2} 行列数不正确。`, { exitCode: 2 });
    let variants: unknown; let tags: unknown;
    try { variants = JSON.parse(candidate[2]!); tags = JSON.parse(candidate[8]!); } catch { throw new MercuryError('DICTIONARY_IMPORT_INVALID', `CSV 第 ${index + 2} 行多值字段必须是 JSON array。`, { exitCode: 2 }); }
    if (!Array.isArray(variants) || !variants.every((item) => typeof item === 'string') || !Array.isArray(tags) || !tags.every((item) => typeof item === 'string')) throw new MercuryError('DICTIONARY_IMPORT_INVALID', `CSV 第 ${index + 2} 行 variants/tags 无效。`, { exitCode: 2 });
    return makeDictionaryEntry({ entry_id: candidate[0]!, canonical: candidate[1]!, variants, kind: candidate[3] as Entry['kind'], language: candidate[4]!, case_sensitive: bool(candidate[5], false), number_sensitive: bool(candidate[6], false), notes: candidate[7] || null, tags, enabled: bool(candidate[9], true) }, now);
  });
}

function csvCell(value: string): string { const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value; return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; }
function dictionaryCsv(value: ExchangeDictionaryV1): string {
  const header = ['entry_id', 'canonical', 'variants', 'kind', 'language', 'case_sensitive', 'number_sensitive', 'notes', 'tags', 'enabled'];
  return `${[header, ...value.entries.map((entry) => [entry.entry_id, entry.canonical, JSON.stringify(entry.variants), entry.kind, entry.language, String(entry.case_sensitive), String(entry.number_sensitive), entry.notes ?? '', JSON.stringify(entry.tags), String(entry.enabled)])].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
async function importEntries(file: string, format: 'json' | 'csv'): Promise<Entry[]> {
  if (!path.isAbsolute(file)) throw new MercuryError('CLI_ARGUMENT_INVALID', '词典文件必须使用绝对路径。', { exitCode: 2 });
  const entry = await lstat(file).catch(() => null); if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > 10 * 1024 * 1024) throw new MercuryError('DICTIONARY_IMPORT_INVALID', '词典导入文件必须是 10MB 内普通文件。', { exitCode: 2 });
  let source: string; try { source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)).replace(/^\uFEFF/u, ''); } catch { throw new MercuryError('DICTIONARY_IMPORT_INVALID', '词典导入固定使用 UTF-8。', { exitCode: 2 }); }
  if (format === 'csv') return parseCsv(source);
  let raw: unknown; try { raw = JSON.parse(source); } catch { throw new MercuryError('DICTIONARY_IMPORT_INVALID', '词典 JSON 无法解析。', { exitCode: 2 }); }
  return validateDictionaryDocument(raw).entries;
}

async function plan(workspace: string, dictionaryId: string, file: string, format: 'json' | 'csv') {
  const current = await readDictionary(workspace, dictionaryId); const entries = await importEntries(file, format);
  const currentById = new Map(current.entries.map((entry) => [entry.entry_id, entry]));
  const importedIds = new Set<string>();
  for (const entry of entries) { if (importedIds.has(entry.entry_id)) throw new MercuryError('DICTIONARY_IMPORT_INVALID', `导入包含重复 entry ID：${entry.entry_id}`, { exitCode: 2 }); importedIds.add(entry.entry_id); }
  const added = entries.filter((entry) => !currentById.has(entry.entry_id)).length;
  const updated = entries.filter((entry) => currentById.has(entry.entry_id) && canonicalJson(currentById.get(entry.entry_id)) !== canonicalJson(entry)).length;
  const fileHash = await sha256File(file); const id = `plan-${createHash('sha256').update(`${dictionaryId}\n${current.revision}\n${fileHash}\n${format}`).digest('hex').slice(0, 24)}`;
  return { plan_id: id, dictionary_id: dictionaryId, base_revision: current.revision, file_sha256: fileHash, format, added, updated, unchanged: entries.length - added - updated, rejected: 0, entries };
}

export async function runDictionaryCommand(workspace: string, args: string[]): Promise<unknown> {
  const operation = args[0];
  if (operation === 'create') {
    ensureOnly(args.slice(1), ['--name', '--scope', '--project'], ['--default']);
    const scope = required(args, '--scope'); if (!['global', 'project'].includes(scope)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--scope 必须是 global 或 project。', { exitCode: 2 });
    const projectKey = option(args, '--project');
    return createDictionary(workspace, { name: required(args, '--name'), scope: scope as 'global' | 'project', ...(projectKey ? { projectKey } : {}), isDefault: args.includes('--default') });
  }
  if (operation === 'list') {
    ensureOnly(args.slice(1), ['--scope', '--project']); const scope = option(args, '--scope'); if (scope && !['global', 'project'].includes(scope)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--scope 必须是 global 或 project。', { exitCode: 2 });
    const dictionaries = await listDictionaries(workspace, { ...(scope ? { scope: scope as 'global' | 'project' } : {}), ...(option(args, '--project') ? { projectKey: option(args, '--project')! } : {}) });
    return { dictionaries: dictionaries.map((dictionary) => ({ dictionary_id: dictionary.dictionary_id, name: dictionary.name, scope: dictionary.scope, project_key: dictionary.project_key, revision: dictionary.revision, content_hash: dictionary.content_hash, enabled: dictionary.enabled, is_default: dictionary.is_default, entry_count: dictionary.entries.length })) };
  }
  if (operation === 'show') { ensureOnly(args.slice(2), ['--revision']); const id = args[1]; if (!id || id.startsWith('--')) throw new MercuryError('CLI_ARGUMENT_INVALID', 'dictionary show 必须提供词典 ID。', { exitCode: 2 }); return readDictionary(workspace, id, option(args, '--revision')); }
  if (operation === 'entry') {
    const action = args[1]; const id = args[2]; if (!['add', 'edit', 'remove'].includes(action ?? '') || !id || id.startsWith('--')) throw new MercuryError('CLI_ARGUMENT_INVALID', 'dictionary entry 需要 add|edit|remove 和词典 ID。', { exitCode: 2 });
    const commandArgs = args.slice(3); ensureOnly(commandArgs, ['--revision', '--entry-id', '--canonical', '--variant', '--kind', '--language', '--notes', '--tag', '--enabled'], ['--case-sensitive', '--number-sensitive']);
    const expected = required(commandArgs, '--revision'); const entryId = required(commandArgs, '--entry-id');
    return mutateDictionary(workspace, id, expected, (current) => {
      const index = current.entries.findIndex((entry) => entry.entry_id === entryId);
      if (action === 'remove') { if (index < 0) throw new MercuryError('DICTIONARY_ENTRY_NOT_FOUND', `未找到条目 ${entryId}。`, { exitCode: 2 }); current.entries.splice(index, 1); return; }
      if (action === 'add' && index >= 0) throw new MercuryError('DICTIONARY_ENTRY_CONFLICT', `条目 ${entryId} 已存在。`, { exitCode: 3 });
      if (action === 'edit' && index < 0) throw new MercuryError('DICTIONARY_ENTRY_NOT_FOUND', `未找到条目 ${entryId}。`, { exitCode: 2 });
      const previous = index >= 0 ? current.entries[index]! : undefined;
      const canonical = option(commandArgs, '--canonical') ?? previous?.canonical; if (!canonical) throw new MercuryError('CLI_OPTION_VALUE_MISSING', '--canonical 缺少参数值。', { exitCode: 2 });
      const entry = makeDictionaryEntry({
        ...previous, entry_id: entryId, canonical,
        ...(commandArgs.includes('--variant') ? { variants: values(commandArgs, '--variant') } : {}),
        ...(option(commandArgs, '--kind') ? { kind: option(commandArgs, '--kind') as Entry['kind'] } : {}),
        ...(option(commandArgs, '--language') ? { language: option(commandArgs, '--language')! } : {}),
        case_sensitive: commandArgs.includes('--case-sensitive') || previous?.case_sensitive === true,
        number_sensitive: commandArgs.includes('--number-sensitive') || previous?.number_sensitive === true,
        ...(option(commandArgs, '--notes') !== undefined ? { notes: option(commandArgs, '--notes')! } : {}),
        ...(commandArgs.includes('--tag') ? { tags: values(commandArgs, '--tag') } : {}),
        enabled: bool(option(commandArgs, '--enabled'), previous?.enabled ?? true),
      });
      if (index >= 0) current.entries[index] = entry; else current.entries.push(entry);
    });
  }
  if (operation === 'validate') { ensureOnly(args.slice(1), ['--file']); const file = required(args, '--file'); const entries = await importEntries(file, path.extname(file).toLowerCase() === '.csv' ? 'csv' : 'json'); return { valid: true, entry_count: entries.length, sha256: await sha256File(file) }; }
  if (operation === 'import') {
    ensureOnly(args.slice(1), ['--file', '--format', '--dictionary', '--confirm'], ['--dry-run']);
    const file = required(args, '--file'); const dictionaryId = required(args, '--dictionary'); const format = required(args, '--format'); if (!['json', 'csv'].includes(format)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--format 必须是 json 或 csv。', { exitCode: 2 });
    const proposed = await plan(workspace, dictionaryId, file, format as 'json' | 'csv');
    if (args.includes('--dry-run')) return { ...proposed, entries: undefined, writes: 0 };
    const confirm = required(args, '--confirm'); if (confirm !== proposed.plan_id) throw new MercuryError('DICTIONARY_IMPORT_PLAN_STALE', '导入 plan 已过期或与当前输入不匹配。', { exitCode: 3 });
    const result = await mutateDictionary(workspace, dictionaryId, proposed.base_revision, (current) => { const byId = new Map(current.entries.map((entry) => [entry.entry_id, entry])); for (const entry of proposed.entries) byId.set(entry.entry_id, entry); current.entries = [...byId.values()]; });
    return { plan_id: proposed.plan_id, previous_revision: result.previous_revision, revision: result.dictionary.revision, content_hash: result.dictionary.content_hash, added: proposed.added, updated: proposed.updated };
  }
  if (operation === 'export') {
    const id = args[1]; if (!id || id.startsWith('--')) throw new MercuryError('CLI_ARGUMENT_INVALID', 'dictionary export 必须提供词典 ID。', { exitCode: 2 }); ensureOnly(args.slice(2), ['--format', '--output', '--revision']);
    const format = required(args, '--format'); if (!['json', 'csv'].includes(format)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--format 必须是 json 或 csv。', { exitCode: 2 }); const output = required(args, '--output'); if (!path.isAbsolute(output)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--output 必须是绝对路径。', { exitCode: 2 });
    if (await lstat(output).then(() => true).catch(() => false)) throw new MercuryError('OUTPUT_ALREADY_EXISTS', '导出目标已存在，Mercury 不会覆盖。', { exitCode: 3 });
    const dictionary = await readDictionary(workspace, id, option(args, '--revision')); const content = format === 'json' ? canonicalJson(dictionary) : dictionaryCsv(dictionary);
    const handle = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); } await chmod(output, 0o600);
    return { dictionary_id: id, revision: dictionary.revision, format, path: output, sha256: await sha256File(output), bytes: (await lstat(output)).size };
  }
  throw new MercuryError('CLI_COMMAND_INVALID', `不支持的词典命令：${operation ?? ''}`, { exitCode: 2 });
}
