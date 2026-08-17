import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDictionary, listDictionaries, makeDictionaryEntry, mutateDictionary, readDictionary, resolveDictionarySnapshot } from '../src/dictionary.js';
import { runDictionaryCommand } from '../src/stable-cli/dictionary.js';

async function workspace() { const root = await mkdtemp(path.join(os.tmpdir(), 'mercury-dictionary-')); return path.join(root, 'workspace'); }
function request(selected: string[] = [], projectKey: string | null = null, overrides: any[] = []) {
  return {
    contract: 'mercury.exchange.request/v1', request_id: 'dictionary-request', created_at: '2026-08-17T00:00:00.000Z', operation: 'subtitle_calibration',
    inputs: { media: null, transcript: { path: '/private/tmp/source.srt', sha256: 'a'.repeat(64), format: 'srt', role: 'transcript_source' } }, transcription_mode: 'provided',
    calibration: { mode: 'text-only', source_language: 'zh-CN' }, models: { asr: null, chat: 'chat-default' }, dictionaries: { project_key: projectKey, selected, task_overrides: overrides }, output: { formats: ['srt', 'report'], workspace_policy: 'managed' }, extensions: {},
  } as any;
}

describe('versioned dictionaries', () => {
  it('creates stable global/project assets, immutable revisions, and rejects stale concurrent edits', async () => {
    const root = await workspace();
    const global = await createDictionary(root, { name: '产品术语', scope: 'global', isDefault: true, now: () => new Date('2026-08-17T00:00:00.000Z') });
    const project = await createDictionary(root, { name: '项目术语', scope: 'project', projectKey: 'demo-project', isDefault: true, now: () => new Date('2026-08-17T00:00:00.000Z') });
    expect((await listDictionaries(root)).map((entry) => entry.scope)).toEqual(['project', 'global']);
    const changed = await mutateDictionary(root, global.dictionary_id, global.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: 'entry-wan-model', canonical: 'Wan 3.0', variants: ['千问万 3.0'], kind: 'product', language: 'zh-CN', number_sensitive: true }, () => new Date('2026-08-17T00:01:00.000Z'))), () => new Date('2026-08-17T00:01:00.000Z'));
    expect(changed.dictionary.revision).not.toBe(global.revision);
    expect((await readDictionary(root, global.dictionary_id, global.revision)).entries).toHaveLength(0);
    await expect(mutateDictionary(root, global.dictionary_id, global.revision, () => undefined)).rejects.toMatchObject({ code: 'DICTIONARY_REVISION_CONFLICT' });
    for (const target of [path.join(root, 'dictionaries', global.dictionary_id, 'dictionary.json'), path.join(root, 'dictionaries', global.dictionary_id, 'revisions', `${changed.dictionary.revision}.json`)]) expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(project.project_key).toBe('demo-project');
  });

  it('resolves override/project/global priority, detects cross-dictionary conflicts, and freezes task snapshots', async () => {
    const root = await workspace();
    const global = await createDictionary(root, { name: 'Global', scope: 'global', isDefault: true });
    const globalV2 = (await mutateDictionary(root, global.dictionary_id, global.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: 'entry-product-name', canonical: 'Global Name', variants: ['格罗包'], kind: 'product' })))).dictionary;
    const project = await createDictionary(root, { name: 'Project', scope: 'project', projectKey: 'p1', isDefault: true });
    const projectV2 = (await mutateDictionary(root, project.dictionary_id, project.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: 'entry-product-name', canonical: 'Project Name', variants: ['项目名'], kind: 'product' })))).dictionary;
    const override = makeDictionaryEntry({ entry_id: 'entry-product-name', canonical: 'Task Name', variants: ['任务名'], kind: 'product' }, () => new Date('2026-08-17T00:00:00.000Z'));
    const snapshot = await resolveDictionarySnapshot(root, request([], 'p1', [override]), 'tsk-20260817-000000-aaaaaaaa', '这里说任务名');
    expect(snapshot.entries.find((entry) => entry.entry_id === 'entry-product-name')?.canonical).toBe('Task Name');
    expect(snapshot.matched_entry_ids).toEqual(['entry-product-name']);
    expect(snapshot.resolved.map((entry) => entry.source)).toEqual(['task_override', 'project_default', 'global_default']);
    const overrideReference = snapshot.resolved[0]!;
    expect(overrideReference).toMatchObject({ dictionary_id: 'dict-task-override', source: 'task_override' });
    expect(snapshot.entries[0]).toMatchObject({ revision: overrideReference.revision, dictionary_id: overrideReference.dictionary_id });
    await mutateDictionary(root, project.dictionary_id, projectV2.revision, (current) => { current.entries[0]!.canonical = 'Later Name'; });
    expect(snapshot.entries[0]!.canonical).toBe('Task Name');
    expect(snapshot.resolved.find((entry) => entry.dictionary_id === global.dictionary_id)?.revision).toBe(globalV2.revision);

    const conflict = await createDictionary(root, { name: 'Conflict', scope: 'global' });
    const conflictV2 = (await mutateDictionary(root, conflict.dictionary_id, conflict.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: 'entry-other', canonical: 'Other', variants: ['格罗包'] })))).dictionary;
    await expect(resolveDictionarySnapshot(root, request([global.dictionary_id, conflictV2.dictionary_id]), 'tsk-20260817-000001-bbbbbbbb', '格罗包')).rejects.toMatchObject({ code: 'DICTIONARY_CONFLICT' });

    const policy = await createDictionary(root, { name: 'Policy', scope: 'global' });
    const policyV2 = (await mutateDictionary(root, policy.dictionary_id, policy.revision, (current) => {
      current.entries.push(makeDictionaryEntry({ entry_id: 'entry-api-upper', canonical: 'API', case_sensitive: true, number_sensitive: true }));
      current.entries.push(makeDictionaryEntry({ entry_id: 'entry-api-lower', canonical: 'API', case_sensitive: false, number_sensitive: true }));
    })).dictionary;
    await expect(resolveDictionarySnapshot(root, request([policyV2.dictionary_id]), 'tsk-20260817-000002-cccccccc', 'API')).rejects.toMatchObject({ code: 'DICTIONARY_CONFLICT' });
    const numeric = await createDictionary(root, { name: 'Numeric', scope: 'global' });
    const numericV2 = (await mutateDictionary(root, numeric.dictionary_id, numeric.revision, (current) => {
      current.entries.push(makeDictionaryEntry({ entry_id: 'entry-wan-strict', canonical: 'Wan 3.0', number_sensitive: true }));
      current.entries.push(makeDictionaryEntry({ entry_id: 'entry-wan-loose', canonical: 'Wan 3.0', number_sensitive: false }));
    })).dictionary;
    await expect(resolveDictionarySnapshot(root, request([numericV2.dictionary_id]), 'tsk-20260817-000003-dddddddd', 'Wan 3.0')).rejects.toMatchObject({ code: 'DICTIONARY_CONFLICT' });
  });

  it('rejects dictionary path symlinks before changing anything outside the workspace', async () => {
    const root = await workspace();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const outside = await mkdtemp(path.join(os.tmpdir(), 'mercury-dictionary-outside-'));
    await chmod(outside, 0o755);
    await symlink(outside, path.join(root, 'dictionaries'));
    await expect(createDictionary(root, { name: 'Unsafe', scope: 'global' })).rejects.toMatchObject({ code: 'DICTIONARY_PATH_UNSAFE' });
    expect((await stat(outside)).mode & 0o777).toBe(0o755);
    expect(await readdir(outside)).toEqual([]);

    const safeRoot = await workspace();
    const first = await createDictionary(safeRoot, { name: 'Safe', scope: 'global' });
    const outsideDictionary = await mkdtemp(path.join(os.tmpdir(), 'mercury-dictionary-id-outside-'));
    await chmod(outsideDictionary, 0o755);
    const unsafeId = 'dict-unsafe-link';
    await symlink(outsideDictionary, path.join(safeRoot, 'dictionaries', unsafeId));
    await expect(mutateDictionary(safeRoot, unsafeId, first.revision, () => undefined)).rejects.toMatchObject({ code: 'DICTIONARY_PATH_UNSAFE' });
    expect((await stat(outsideDictionary)).mode & 0o777).toBe(0o755);
    expect(await readdir(outsideDictionary)).toEqual([]);
  });

  it('supports deterministic CLI dry-run/confirm and JSON/CSV export without dry-run writes', async () => {
    const root = await workspace();
    const dictionary = await createDictionary(root, { name: 'Import', scope: 'global' });
    const source = path.join(path.dirname(root), 'import.csv');
    await writeFile(source, 'entry_id,canonical,variants,kind,language,case_sensitive,number_sensitive,notes,tags,enabled\nentry-api-name,API,"[""接口""]",acronym,zh-CN,true,false,接口名,"[""tech""]",true\n');
    const before = await readdir(path.join(root, 'dictionaries', dictionary.dictionary_id, 'revisions'));
    const dry = await runDictionaryCommand(root, ['import', '--dictionary', dictionary.dictionary_id, '--file', source, '--format', 'csv', '--dry-run', '--json']) as any;
    expect(dry).toMatchObject({ added: 1, updated: 0, writes: 0 });
    expect(await readdir(path.join(root, 'dictionaries', dictionary.dictionary_id, 'revisions'))).toEqual(before);
    const applied = await runDictionaryCommand(root, ['import', '--dictionary', dictionary.dictionary_id, '--file', source, '--format', 'csv', '--confirm', dry.plan_id, '--json']) as any;
    expect(applied.revision).not.toBe(dictionary.revision);
    const jsonOutput = path.join(path.dirname(root), 'export.json');
    const csvOutput = path.join(path.dirname(root), 'export.csv');
    await runDictionaryCommand(root, ['export', dictionary.dictionary_id, '--format', 'json', '--output', jsonOutput, '--json']);
    await runDictionaryCommand(root, ['export', dictionary.dictionary_id, '--format', 'csv', '--output', csvOutput, '--json']);
    expect(JSON.parse(await readFile(jsonOutput, 'utf8')).entries[0].canonical).toBe('API');
    expect(await readFile(csvOutput, 'utf8')).toContain('entry-api-name,API');
    expect((await stat(jsonOutput)).mode & 0o777).toBe(0o600);
  });

  it('round-trips explicit boolean values and clear operations for editable entry fields', async () => {
    const root = await workspace();
    const dictionary = await createDictionary(root, { name: 'Editable', scope: 'global' });
    const added = await runDictionaryCommand(root, [
      'entry', 'add', dictionary.dictionary_id, '--revision', dictionary.revision,
      '--entry-id', 'entry-editable', '--canonical', 'API', '--variant', '接口', '--tag', 'tech',
      '--notes', 'initial', '--case-sensitive', 'true', '--number-sensitive', 'true', '--json',
    ]) as any;
    const edited = await runDictionaryCommand(root, [
      'entry', 'edit', dictionary.dictionary_id, '--revision', added.dictionary.revision,
      '--entry-id', 'entry-editable', '--case-sensitive', 'false', '--number-sensitive', 'false',
      '--clear-variants', '--clear-tags', '--clear-notes', '--json',
    ]) as any;
    const entry = edited.dictionary.entries[0];
    expect(entry).toMatchObject({ case_sensitive: false, number_sensitive: false, variants: [], tags: [], notes: null });
  });
});
