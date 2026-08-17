import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExchangeDictionaryV1, ExchangeRequestV1 } from './contracts/index.js';
import type { Entry } from './contracts/generated/exchange-dictionary-v1.js';
import type { DictionaryReference } from './contracts/generated/task-record-v5.js';
import type { AsrHintsEvidence } from './contracts/adapters/asr.js';
import { assertExchangeContract } from './contracts/index.js';
import { MercuryError } from './errors.js';
import { withOwnedLock } from './background/owned-lock.js';
import { canonicalJson, readStableJson, writeStableJsonAtomic } from './exchange/storage.js';

interface DictionaryPointerV1 {
  contract: 'mercury.dictionary-pointer/v1'; dictionary_id: string; current_revision: string; content_hash: string;
  scope: 'global' | 'project'; project_key: string | null; name: string; enabled: boolean; is_default: boolean; updated_at: string;
}

export interface ResolvedDictionarySnapshot {
  contract: 'mercury.dictionary-snapshot/v1'; task_id: string; created_at: string;
  resolved: DictionaryReference[]; entries: Array<Entry & { source: DictionaryReference['source']; dictionary_id: string; revision: string }>;
  conflicts: Array<{ key: string; entry_ids: string[] }>;
  matched_entry_ids: string[]; chat_context_entry_ids: string[];
  asr_hints: AsrHintsEvidence;
  extensions: Record<string, unknown>;
}

const DICTIONARY_ID = /^dict-[a-z0-9][a-z0-9-]{2,63}$/u;
const ENTRY_ID = /^entry-[a-z0-9][a-z0-9-]{2,63}$/u;

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function slug(value: string): string {
  const normalized = value.normalize('NFKD').toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 36);
  return normalized || 'local';
}
function dictionariesRoot(workspace: string) { return path.join(path.resolve(workspace), 'dictionaries'); }
function dictionaryRoot(workspace: string, id: string) {
  if (!DICTIONARY_ID.test(id)) throw new MercuryError('DICTIONARY_ID_INVALID', '词典 ID 格式无效。', { exitCode: 2 });
  return path.join(dictionariesRoot(workspace), id);
}
function pointerPath(workspace: string, id: string) { return path.join(dictionaryRoot(workspace, id), 'dictionary.json'); }
function revisionPath(workspace: string, id: string, revision: string) {
  if (!/^rev-[a-f0-9]{12,64}$/u.test(revision)) throw new MercuryError('DICTIONARY_REVISION_NOT_FOUND', '词典 revision 格式无效。', { exitCode: 2 });
  return path.join(dictionaryRoot(workspace, id), 'revisions', `${revision}.json`);
}
function semanticMaterial(value: Omit<ExchangeDictionaryV1, 'revision' | 'content_hash'> | ExchangeDictionaryV1) {
  return {
    dictionary_id: value.dictionary_id, scope: value.scope, project_key: value.project_key, name: value.name,
    enabled: value.enabled, is_default: value.is_default,
    entries: value.entries.map((entry) => ({ entry_id: entry.entry_id, kind: entry.kind, canonical: entry.canonical.normalize('NFC'), variants: [...entry.variants].map((item) => item.normalize('NFC')).sort(), language: entry.language, case_sensitive: entry.case_sensitive, number_sensitive: entry.number_sensitive, notes: entry.notes?.normalize('NFC') ?? null, tags: [...entry.tags].sort(), enabled: entry.enabled })),
    extensions: value.extensions,
  };
}
function versioned(value: Omit<ExchangeDictionaryV1, 'revision' | 'content_hash'>): ExchangeDictionaryV1 {
  const contentHash = hash(canonicalJson(semanticMaterial(value)));
  return assertExchangeContract('dictionary', { ...value, revision: `rev-${contentHash.slice(0, 20)}`, content_hash: contentHash });
}
async function assertDirectorySafe(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MercuryError('DICTIONARY_PATH_UNSAFE', '词典路径必须是普通目录。');
  const parentReal = await realpath(path.dirname(target));
  const targetReal = await realpath(target);
  if (path.dirname(targetReal) !== parentReal) throw new MercuryError('DICTIONARY_PATH_UNSAFE', '词典路径真实位置超出预期父目录。');
}
async function ensurePlainDirectory(target: string, parent: string): Promise<void> {
  await assertDirectorySafe(parent);
  try {
    await assertDirectorySafe(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(target, { recursive: false, mode: 0o700 });
    await assertDirectorySafe(target);
  }
  await chmod(target, 0o700);
}
async function ensureDictionaryRoot(workspace: string, id?: string): Promise<string> {
  const workspaceRoot = path.resolve(workspace);
  await ensurePlainDirectory(workspaceRoot, path.dirname(workspaceRoot));
  const root = dictionariesRoot(workspace); await ensurePlainDirectory(root, workspaceRoot);
  if (!id) return root;
  const directory = dictionaryRoot(workspace, id); await ensurePlainDirectory(directory, root); await ensurePlainDirectory(path.join(directory, 'revisions'), directory); return directory;
}
async function readPointer(workspace: string, id: string): Promise<DictionaryPointerV1> {
  await assertDirectorySafe(path.resolve(workspace));
  await assertDirectorySafe(dictionariesRoot(workspace));
  await assertDirectorySafe(dictionaryRoot(workspace, id));
  await assertDirectorySafe(path.join(dictionaryRoot(workspace, id), 'revisions'));
  const value = await readStableJson(pointerPath(workspace, id), 'DICTIONARY_NOT_FOUND') as DictionaryPointerV1;
  if (value.contract !== 'mercury.dictionary-pointer/v1' || value.dictionary_id !== id || !/^rev-[a-f0-9]{12,64}$/u.test(value.current_revision)) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典当前指针损坏或 identity 错置。');
  return value;
}
async function persistRevision(workspace: string, dictionary: ExchangeDictionaryV1): Promise<void> {
  const root = await ensureDictionaryRoot(workspace, dictionary.dictionary_id);
  const target = revisionPath(workspace, dictionary.dictionary_id, dictionary.revision);
  try {
    const existing = assertExchangeContract('dictionary', await readStableJson(target, 'DICTIONARY_REVISION_NOT_FOUND'));
    if (existing.content_hash !== dictionary.content_hash) throw new MercuryError('DICTIONARY_RECORD_INVALID', '内容寻址 revision 与文件内容冲突。');
  } catch (error) {
    if (!(error instanceof MercuryError) || error.code !== 'DICTIONARY_REVISION_NOT_FOUND') throw error;
    await writeStableJsonAtomic(target, dictionary);
  }
  const pointer: DictionaryPointerV1 = { contract: 'mercury.dictionary-pointer/v1', dictionary_id: dictionary.dictionary_id, current_revision: dictionary.revision, content_hash: dictionary.content_hash, scope: dictionary.scope, project_key: dictionary.project_key, name: dictionary.name, enabled: dictionary.enabled, is_default: dictionary.is_default, updated_at: dictionary.updated_at };
  await writeStableJsonAtomic(path.join(root, 'dictionary.json'), pointer);
}

export async function createDictionary(workspace: string, input: { name: string; scope: 'global' | 'project'; projectKey?: string | null; isDefault?: boolean; now?: () => Date }): Promise<ExchangeDictionaryV1> {
  const name = input.name.normalize('NFC').trim();
  if (!name) throw new MercuryError('DICTIONARY_INVALID', '词典名称不能为空。', { exitCode: 2 });
  const projectKey = input.scope === 'project' ? input.projectKey ?? null : null;
  if (input.scope === 'project' && !projectKey) throw new MercuryError('DICTIONARY_INVALID', '项目词典必须提供稳定 project key。', { exitCode: 2 });
  if (input.scope === 'global' && input.projectKey) throw new MercuryError('DICTIONARY_INVALID', '全局词典不能绑定 project key。', { exitCode: 2 });
  const id = `dict-${slug(name)}-${hash(`${input.scope}\n${projectKey ?? ''}\n${name}`).slice(0, 8)}`.slice(0, 69);
  const at = (input.now ?? (() => new Date()))().toISOString();
  await ensureDictionaryRoot(workspace, id);
  return withOwnedLock(path.join(dictionaryRoot(workspace, id), 'dictionary.lock'), async () => {
    try { return await readDictionary(workspace, id); } catch (error) { if (!(error instanceof MercuryError) || error.code !== 'DICTIONARY_NOT_FOUND') throw error; }
    const dictionary = versioned({ contract: 'mercury.dictionary/v1', dictionary_id: id, scope: input.scope, project_key: projectKey, name, created_at: at, updated_at: at, enabled: true, is_default: input.isDefault ?? false, entries: [], extensions: {} });
    await persistRevision(workspace, dictionary); return dictionary;
  }, { waitMs: 5000, errorCode: 'DICTIONARY_LOCKED', errorMessage: '词典正在由另一个操作修改。' });
}

export async function readDictionary(workspace: string, id: string, revision?: string): Promise<ExchangeDictionaryV1> {
  const pointer = await readPointer(workspace, id);
  const selected = revision ?? pointer.current_revision;
  const value = assertExchangeContract('dictionary', await readStableJson(revisionPath(workspace, id, selected), 'DICTIONARY_REVISION_NOT_FOUND'));
  if (value.dictionary_id !== id || value.revision !== selected || value.content_hash !== hash(canonicalJson(semanticMaterial(value)))) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典 revision identity 或内容 hash 不匹配。');
  return value;
}

export async function listDictionaries(workspace: string, filter: { scope?: 'global' | 'project'; projectKey?: string } = {}): Promise<ExchangeDictionaryV1[]> {
  let entries;
  try {
    await assertDirectorySafe(path.resolve(workspace));
    await assertDirectorySafe(dictionariesRoot(workspace));
    entries = await readdir(dictionariesRoot(workspace), { withFileTypes: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: ExchangeDictionaryV1[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !DICTIONARY_ID.test(entry.name)) continue;
    const value = await readDictionary(workspace, entry.name);
    if (filter.scope && value.scope !== filter.scope) continue;
    if (filter.projectKey && value.project_key !== filter.projectKey) continue;
    result.push(value);
  }
  return result;
}

export async function mutateDictionary(workspace: string, id: string, expectedRevision: string, operation: (current: ExchangeDictionaryV1) => void, now = () => new Date()): Promise<{ previous_revision: string; dictionary: ExchangeDictionaryV1; changed: boolean }> {
  await ensureDictionaryRoot(workspace, id);
  return withOwnedLock(path.join(dictionaryRoot(workspace, id), 'dictionary.lock'), async () => {
    const current = await readDictionary(workspace, id);
    if (current.revision !== expectedRevision) throw new MercuryError('DICTIONARY_REVISION_CONFLICT', `词典已从 ${expectedRevision} 更新为 ${current.revision}；请重新读取后决定。`, { exitCode: 3 });
    const candidate = structuredClone(current); operation(candidate); candidate.updated_at = now().toISOString();
    candidate.entries = candidate.entries.sort((a, b) => a.entry_id.localeCompare(b.entry_id));
    const next = versioned(candidate);
    if (next.revision === current.revision) return { previous_revision: current.revision, dictionary: current, changed: false };
    await persistRevision(workspace, next); return { previous_revision: current.revision, dictionary: next, changed: true };
  }, { waitMs: 5000, errorCode: 'DICTIONARY_LOCKED', errorMessage: '词典正在由另一个操作修改。' });
}

export function makeDictionaryEntry(input: Partial<Entry> & Pick<Entry, 'entry_id' | 'canonical'>, now = () => new Date()): Entry {
  if (!ENTRY_ID.test(input.entry_id)) throw new MercuryError('DICTIONARY_ENTRY_INVALID', 'entry ID 格式无效。', { exitCode: 2 });
  const at = now().toISOString();
  return {
    entry_id: input.entry_id, kind: input.kind ?? 'term', canonical: input.canonical.normalize('NFC').trim(), variants: [...new Set(input.variants ?? [])].map((value) => value.normalize('NFC').trim()).filter(Boolean), language: input.language ?? 'zh-CN', case_sensitive: input.case_sensitive ?? false, number_sensitive: input.number_sensitive ?? false, notes: input.notes?.normalize('NFC').trim() || null, tags: [...new Set(input.tags ?? [])].map((value) => value.normalize('NFC').trim()).filter(Boolean), enabled: input.enabled ?? true, created_at: input.created_at ?? at, updated_at: at,
  };
}

export function validateDictionaryDocument(value: unknown): ExchangeDictionaryV1 { return assertExchangeContract('dictionary', value); }

function normalizedKey(value: string, caseSensitive: boolean) { const n = value.normalize('NFC'); return caseSensitive ? n : n.toLocaleLowerCase('und'); }

export async function resolveDictionarySnapshot(workspace: string, request: ExchangeRequestV1, taskId: string, transcriptText: string): Promise<ResolvedDictionarySnapshot> {
  const all = (await listDictionaries(workspace)).filter((dictionary) => dictionary.enabled);
  const selected = new Set(request.dictionaries.selected);
  for (const id of selected) if (!all.some((dictionary) => dictionary.dictionary_id === id)) throw new MercuryError('DICTIONARY_REVISION_NOT_FOUND', `所选词典不存在或已停用：${id}`, { exitCode: 2 });
  for (const dictionary of all.filter((entry) => selected.has(entry.dictionary_id) && entry.scope === 'project')) {
    if (dictionary.project_key !== request.dictionaries.project_key) throw new MercuryError('DICTIONARY_SCOPE_MISMATCH', `项目词典 ${dictionary.dictionary_id} 不属于 request.project_key。`, { exitCode: 3 });
  }
  const ranked = all.map((dictionary) => {
    const explicit = selected.has(dictionary.dictionary_id);
    const source: DictionaryReference['source'] | null = dictionary.scope === 'project' && explicit ? 'explicit_project'
      : dictionary.scope === 'project' && dictionary.is_default && dictionary.project_key === request.dictionaries.project_key ? 'project_default'
        : dictionary.scope === 'global' && explicit ? 'explicit_global'
          : dictionary.scope === 'global' && dictionary.is_default ? 'global_default' : null;
    const priority = source === 'explicit_project' ? 2 : source === 'project_default' ? 3 : source === 'explicit_global' ? 4 : 5;
    return source ? { dictionary, source, priority } : null;
  }).filter((value): value is NonNullable<typeof value> => value !== null).sort((a, b) => a.priority - b.priority || a.dictionary.dictionary_id.localeCompare(b.dictionary.dictionary_id));
  const resolved: DictionaryReference[] = ranked.map(({ dictionary, source }) => ({ dictionary_id: dictionary.dictionary_id, revision: dictionary.revision, content_hash: dictionary.content_hash, source }));
  const candidates: Array<Entry & { source: DictionaryReference['source']; dictionary_id: string; revision: string; priority: number }> = [];
  const orderedOverrides = [...request.dictionaries.task_overrides].sort((a, b) => a.entry_id.localeCompare(b.entry_id));
  if (orderedOverrides.length > 0) {
    const overrideHash = hash(canonicalJson(orderedOverrides));
    const overrideRevision = `rev-${overrideHash.slice(0, 20)}`;
    resolved.unshift({ dictionary_id: 'dict-task-override', revision: overrideRevision, content_hash: overrideHash, source: 'task_override' });
    for (const override of orderedOverrides) candidates.push({ ...override, source: 'task_override', dictionary_id: 'dict-task-override', revision: overrideRevision, priority: 1 });
  }
  for (const value of ranked) for (const entry of value.dictionary.entries.filter((candidate) => candidate.enabled)) candidates.push({ ...entry, source: value.source, dictionary_id: value.dictionary.dictionary_id, revision: value.dictionary.revision, priority: value.priority });
  const entries = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority)) if (!entries.has(candidate.entry_id)) entries.set(candidate.entry_id, candidate);
  const spelling = new Map<string, typeof candidates[number]>(); const canonicalPolicies = new Map<string, typeof candidates[number]>(); const conflicts: ResolvedDictionarySnapshot['conflicts'] = [];
  for (const candidate of entries.values()) {
    const policyKey = candidate.canonical.normalize('NFC').toLocaleLowerCase('und');
    const existing = canonicalPolicies.get(policyKey);
    if (existing && (existing.case_sensitive !== candidate.case_sensitive || existing.number_sensitive !== candidate.number_sensitive)) {
      conflicts.push({ key: hash(`policy:${policyKey}`).slice(0, 12), entry_ids: [existing.entry_id, candidate.entry_id].sort() });
    } else if (!existing) canonicalPolicies.set(policyKey, candidate);
  }
  for (const candidate of entries.values()) for (const form of [candidate.canonical, ...candidate.variants]) {
    const key = normalizedKey(form, candidate.case_sensitive); const existing = spelling.get(key);
    if (existing && existing.canonical !== candidate.canonical) conflicts.push({ key: hash(key).slice(0, 12), entry_ids: [existing.entry_id, candidate.entry_id].sort() });
    else spelling.set(key, candidate);
  }
  if (conflicts.length > 0) throw new MercuryError('DICTIONARY_CONFLICT', `词典存在 ${conflicts.length} 组写法冲突；任务未提交。`, { exitCode: 3 });
  const effective = [...entries.values()].map(({ priority: _priority, ...entry }) => entry).sort((a, b) => a.entry_id.localeCompare(b.entry_id));
  const matched = effective.filter((entry) => [entry.canonical, ...entry.variants].some((form) => normalizedKey(transcriptText, entry.case_sensitive).includes(normalizedKey(form, entry.case_sensitive))));
  return {
    contract: 'mercury.dictionary-snapshot/v1', task_id: taskId, created_at: request.created_at, resolved, entries: effective, conflicts: [],
    matched_entry_ids: matched.map((entry) => entry.entry_id), chat_context_entry_ids: matched.map((entry) => entry.entry_id),
    asr_hints: request.transcription_mode === 'provided'
      ? { status: 'not_applicable', adapter_id: null, entry_ids: [], available_count: effective.length, input_count: 0, truncated: false, input_hash: null, reason: '外部提供转录不会调用 ASR。' }
      : { status: 'pending', adapter_id: null, entry_ids: [], available_count: effective.length, input_count: 0, truncated: false, input_hash: null, reason: '等待所选 ASR adapter 声明能力。' },
    extensions: {},
  };
}
