import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteModelV2,
  loadModelRegistryV2,
  migrateModelRegistryV1,
  setupFromFileV2,
} from '../src/models-v2.js';
import { parseVolcengineCredential } from '../src/models.js';
import { validateContract } from '../src/contracts/index.js';
import { findTask } from '../src/tasks.js';
import fixture from './fixtures/valid/model-config.json' with { type: 'json' };
import snapshotFixture from './fixtures/valid/model-snapshot.json' with { type: 'json' };
import audioFixture from './fixtures/valid/audio-verification.completed.json' with { type: 'json' };

async function workspace() {
  const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-models-'));
  const root = path.join(home, 'mercury-workspace');
  await mkdir(path.join(root, 'config'), { recursive: true });
  return root;
}
describe('D011 model configuration migration', () => {
  it('maps a current-console raw APP Key to both X-Api-Key and user.uid', () => {
    expect(parseVolcengineCredential('fixture-current-app-key')).toEqual({
      mode: 'api_key',
      uid: 'fixture-current-app-key',
      value: 'fixture-current-app-key',
    });
  });
  it('C10 migrates the legacy Gemini role into an unchecked non-default Chat candidate', () => {
    const legacy = structuredClone(fixture) as any;
    expect(validateContract('model-config', legacy).valid).toBe(true);
    const migrated = migrateModelRegistryV1(legacy);
    expect(migrated.schema_version).toBe('2.0.0');
    expect(migrated.defaults).toEqual({
      asr: legacy.defaults.asr,
      chat: legacy.defaults.calibration,
    });
    expect(Object.keys(migrated.defaults)).not.toContain('audio_verification');
    const old = legacy.models.find(
      (item: any) => item.role === 'audio_verification',
    );
    const gemini = migrated.models.find(
      (item) => item.model_id === old.config_id,
    )!;
    expect(gemini).toMatchObject({
      category: 'chat',
      plugin_id: 'gemini',
      connection_type: 'vertex_ai',
      provider_model: old.model,
      endpoint: old.endpoint,
      credential_ref: old.credential_ref,
      provider_config: old.provider_config,
      cloud_data_confirmation: old.cloud_data_confirmation,
      check: null,
      verified_capabilities: null,
    });
    expect(migrated.defaults.chat).not.toBe(gemini.model_id);
  });
  it('C10 reads a historical three-role snapshot, verifying_audio stage, and audio-verification artifact without rewriting them', async () => {
    const root = await workspace();
    const taskId = 'tsk-20260801-120000-1234abcd';
    const directory = `${taskId}-legacy`;
    const taskRoot = path.join(root, 'tasks', directory);
    await mkdir(path.join(taskRoot, 'work'), { recursive: true });
    const task = {
      schema_version: '1.0.0',
      task_id: taskId,
      task_type: 'subtitle_calibration',
      created_at: '2026-08-01T12:00:00.000Z',
      updated_at: '2026-08-01T12:00:01.000Z',
      task_directory: directory,
      input_config: {
        has_reference_srt: false,
        mode: null,
        source_language: 'zh-CN',
      },
      inputs: {
        audio: {
          original_path: '/legacy/input.mp3',
          original_name: 'input.mp3',
          workspace_copy_path: 'input/input.mp3',
          bytes: 834,
          modified_at: '2026-08-01T12:00:00.000Z',
          sha256: '0'.repeat(64),
          copy_verified: true,
          duration_ms: 52,
        },
        reference_srt: null,
      },
      model_snapshot: { path: 'work/model-snapshot.json', sha256: null },
      audio_verification: {
        requested: true,
        artifact_path: 'work/audio-verification.json',
        sha256: null,
      },
      execution: {
        status: 'verifying_audio',
        last_completed_stage: 'calibrating',
        started_at: '2026-08-01T12:00:00.000Z',
        ended_at: null,
        execution_interrupted: false,
      },
      artifacts: {
        work: ['work/model-snapshot.json', 'work/audio-verification.json'],
        outputs: [],
        report: null,
      },
      adapter_failures: [],
      warnings: [],
      error: null,
      failure_stage: null,
    };
    await writeFile(
      path.join(taskRoot, 'task.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    const snapshotBytes = `${JSON.stringify(snapshotFixture, null, 2)}\n`;
    const audioBytes = `${JSON.stringify(audioFixture, null, 2)}\n`;
    await writeFile(
      path.join(taskRoot, 'work/model-snapshot.json'),
      snapshotBytes,
    );
    await writeFile(
      path.join(taskRoot, 'work/audio-verification.json'),
      audioBytes,
    );
    const found = await findTask(root, taskId);
    expect(found.execution).toMatchObject({
      status: 'verifying_audio',
      last_completed_stage: 'calibrating',
    });
    expect(
      validateContract('model-snapshot', JSON.parse(snapshotBytes)).valid,
    ).toBe(true);
    expect(
      validateContract('audio-verification', JSON.parse(audioBytes)).valid,
    ).toBe(true);
    expect(Object.keys(snapshotFixture.models)).toEqual([
      'asr',
      'calibration',
      'audio_verification',
    ]);
    expect(
      await readFile(path.join(taskRoot, 'work/model-snapshot.json'), 'utf8'),
    ).toBe(snapshotBytes);
    expect(
      await readFile(
        path.join(taskRoot, 'work/audio-verification.json'),
        'utf8',
      ),
    ).toBe(audioBytes);
  });
  it('C12 leaves original v1 bytes untouched for parse, validation, temporary-write and pre-replace failures', async () => {
    const root = await workspace();
    const file = path.join(root, 'config/model-config.json');
    const original = `${JSON.stringify(fixture, null, 2)}\n`;
    await writeFile(file, original);
    await expect(
      loadModelRegistryV2(root, {
        beforeMigrationTempWrite: () => {
          throw new Error('temp');
        },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIG_MIGRATION_FAILED' });
    expect(await readFile(file, 'utf8')).toBe(original);
    await expect(
      loadModelRegistryV2(root, {
        beforeMigrationReplace: () => {
          throw new Error('replace');
        },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIG_MIGRATION_FAILED' });
    expect(await readFile(file, 'utf8')).toBe(original);
    await writeFile(file, '{bad');
    const malformed = await readFile(file, 'utf8');
    await expect(loadModelRegistryV2(root)).rejects.toMatchObject({
      code: 'MODEL_CONFIG_INVALID',
    });
    expect(await readFile(file, 'utf8')).toBe(malformed);
    await writeFile(
      file,
      JSON.stringify({
        ...fixture,
        defaults: { ...fixture.defaults, asr: 'missing' },
      }),
    );
    const invalid = await readFile(file, 'utf8');
    await expect(loadModelRegistryV2(root)).rejects.toMatchObject({
      code: 'MODEL_CONFIG_MIGRATION_FAILED',
    });
    expect(await readFile(file, 'utf8')).toBe(invalid);
  });
  it('C12 preserves stable fields and valid ASR/text checks while clearing failed and legacy-audio checks', async () => {
    const root = await workspace();
    const file = path.join(root, 'config/model-config.json');
    const legacy = structuredClone(fixture) as any;
    const failed = legacy.models.find(
      (item: any) => item.role === 'calibration',
    ).last_check;
    failed.outcome = 'failed';
    failed.actual_model = null;
    failed.capabilities = null;
    failed.error = {
      error_id: 'error-calibration-check',
      code: 'MODEL_CHECK_FAILED',
      message: 'historical failed check',
      stage: 'capability',
      retryable: false,
    };
    expect(validateContract('model-config', legacy).valid).toBe(true);
    await writeFile(file, `${JSON.stringify(legacy)}\n`);
    const migrated = await loadModelRegistryV2(root);
    const oldAsr = legacy.models.find((item: any) => item.role === 'asr');
    const asr = migrated.models.find(
      (item) => item.model_id === oldAsr.config_id,
    )!;
    const chat = migrated.models.find(
      (item) => item.model_id === legacy.defaults.calibration,
    )!;
    const oldAudio = legacy.models.find(
      (item: any) => item.role === 'audio_verification',
    );
    const audio = migrated.models.find(
      (item) => item.model_id === oldAudio.config_id,
    )!;
    expect(migrated.defaults).toEqual({
      asr: legacy.defaults.asr,
      chat: legacy.defaults.calibration,
    });
    expect(asr).toMatchObject({
      model_id: oldAsr.config_id,
      connection_id: oldAsr.config_id,
      provider_model: oldAsr.model,
      endpoint: oldAsr.endpoint,
      credential_ref: oldAsr.credential_ref,
      provider_config: oldAsr.provider_config,
      cloud_data_confirmation: oldAsr.cloud_data_confirmation,
      check: { check_id: oldAsr.last_check.check_id, outcome: 'passed' },
    });
    expect(chat.check).toBeNull();
    expect(chat.verified_capabilities).toBeNull();
    expect(audio).toMatchObject({
      credential_ref: oldAudio.credential_ref,
      provider_config: oldAudio.provider_config,
      check: null,
      verified_capabilities: null,
    });
    expect(JSON.parse(await readFile(file, 'utf8')).schema_version).toBe(
      '2.0.0',
    );
  });

  it('deletes only an unshared model-owned secret inside the Mercury secrets directory', async () => {
    const root = await workspace();
    const secrets = path.join(root, 'config', 'secrets');
    await mkdir(secrets, { recursive: true });
    const owned = path.join(secrets, 'owned.secret');
    const shared = path.join(secrets, 'shared-one.secret');
    const external = path.join(path.dirname(root), 'external.secret');
    await writeFile(owned, 'owned-fixture');
    await writeFile(shared, 'shared-fixture');
    await writeFile(external, 'external-fixture');
    const setupFile = path.join(path.dirname(root), 'setup.json');
    const chat = (
      model_id: string,
      credential_ref: string,
      defaultValue = false,
    ) => ({
      model_id, name: model_id, category: 'chat',
      plugin_id: 'openai_chat_completions', connection_id: `conn-${model_id}`,
      connection_type: 'compatible_endpoint', provider_model: `provider-${model_id}`,
      runtime: 'cloud', endpoint: 'https://chat.example/v1', credential_ref,
      provider_config: {}, default: defaultValue,
    });
    await writeFile(
      setupFile,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default', name: 'ASR', category: 'asr',
            plugin_id: 'volcengine_asr', connection_id: 'conn-asr',
            connection_type: 'volcengine_cloud', provider_model: 'bigmodel',
            runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY',
            provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true,
          },
          chat('chat-default', 'env:CHAT_KEY', true),
          chat('owned', `file:${owned}`),
          chat('shared-one', `file:${shared}`),
          chat('shared-holder', `file:${shared}`),
          chat('external', `file:${external}`),
        ],
      }),
    );
    await setupFromFileV2(root, setupFile, true);

    await deleteModelV2(root, 'owned');
    await expect(readFile(owned, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await deleteModelV2(root, 'shared-one');
    expect(await readFile(shared, 'utf8')).toBe('shared-fixture');

    await deleteModelV2(root, 'external');
    expect(await readFile(external, 'utf8')).toBe('external-fixture');
  });
});
