import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { validateContract, validateV2Contract } from '../contracts/index.js';
import { MercuryError } from '../errors.js';
import { migrateModelRegistryV1 } from '../models-v2.js';
import { canonicalJson } from '../exchange/storage.js';

export interface ConfigMigrationStatus {
  configured: boolean;
  source_schema_version: string | null;
  target_schema_version: '2.0.0';
  state: 'not_configured' | 'current' | 'migration_required' | 'invalid';
  migration_required: boolean;
  plan_id: string | null;
  changes: string[];
}

function configPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'config', 'model-config.json');
}

async function sourceIfPresent(workspaceRoot: string): Promise<{ source: string; parsed: unknown } | null> {
  const target = configPath(workspaceRoot);
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new MercuryError('MODEL_CONFIG_INVALID', '模型配置必须是普通文件。');
    const source = await readFile(target, 'utf8');
    return { source, parsed: JSON.parse(source) as unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('MODEL_CONFIG_INVALID', '模型配置无法解析；未执行迁移。', { exitCode: 4 });
  }
}

function planId(source: string): string {
  return `migration-${createHash('sha256').update(source).update(':2.0.0').digest('hex').slice(0, 24)}`;
}

export async function inspectConfigMigration(workspaceRoot: string): Promise<ConfigMigrationStatus> {
  const found = await sourceIfPresent(workspaceRoot);
  if (!found) return { configured: false, source_schema_version: null, target_schema_version: '2.0.0', state: 'not_configured', migration_required: false, plan_id: null, changes: [] };
  const version = typeof found.parsed === 'object' && found.parsed !== null && 'schema_version' in found.parsed
    ? String((found.parsed as Record<string, unknown>).schema_version)
    : null;
  const current = validateV2Contract('model-config', found.parsed);
  if (current.valid) return { configured: true, source_schema_version: '2.0.0', target_schema_version: '2.0.0', state: 'current', migration_required: false, plan_id: null, changes: [] };
  const legacy = validateContract('model-config', found.parsed);
  if (!legacy.valid) return { configured: true, source_schema_version: version, target_schema_version: '2.0.0', state: 'invalid', migration_required: false, plan_id: null, changes: [] };
  return {
    configured: true, source_schema_version: '1.0.0', target_schema_version: '2.0.0', state: 'migration_required', migration_required: true,
    plan_id: planId(found.source),
    changes: ['把 v1 ASR/校准模型映射为 v2 asr/chat 实例。', '保留 credential_ref，不复制或显示秘密。', '创建同目录 0600 备份后原子替换配置。'],
  };
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function applyConfigMigration(workspaceRoot: string, expectedPlanId: string): Promise<ConfigMigrationStatus & { backup_path: string }> {
  const found = await sourceIfPresent(workspaceRoot);
  if (!found) throw new MercuryError('MODEL_NOT_CONFIGURED', '尚未找到模型配置。', { exitCode: 4, remediation: '运行 mercury 打开交互式 App，在模型中心完成配置。' });
  const expected = planId(found.source);
  if (expectedPlanId !== expected) throw new MercuryError('MIGRATION_PLAN_STALE', '迁移计划已过期；配置未改变。', { exitCode: 3, remediation: '重新执行 config migrate --check --json 获取当前 plan_id。' });
  const migrated = migrateModelRegistryV1(found.parsed);
  const target = configPath(workspaceRoot);
  const backup = `${target}.backup-${expected.slice(-12)}`;
  const temporary = `${target}.migrate-${process.pid}`;
  try {
    await copyFile(target, backup, constants.COPYFILE_EXCL);
    await chmod(backup, 0o600);
    await syncFile(backup);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(canonicalJson(migrated), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    await chmod(target, 0o600);
    const validated = validateV2Contract('model-config', JSON.parse(await readFile(target, 'utf8')));
    if (!validated.valid) throw new Error('replacement validation failed');
    return { ...(await inspectConfigMigration(workspaceRoot)), backup_path: backup };
  } catch (error) {
    await rm(temporary, { force: true });
    try {
      const backupEntry = await lstat(backup);
      if (backupEntry.isFile() && !backupEntry.isSymbolicLink()) {
        await copyFile(backup, target);
        await chmod(target, 0o600);
      }
    } catch {}
    throw new MercuryError('MIGRATION_FAILED', '配置迁移未完成，已保留或恢复原配置。', { exitCode: 1, remediation: '检查配置目录权限与备份文件后重新执行 --check。' });
  }
}
