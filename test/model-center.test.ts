import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateContract } from '../src/contracts/index.js';
import type { ModelConfigRegistry, ModelSnapshot, ModelSnapshotEntry } from '../src/contracts/index.js';
import { MercuryError } from '../src/errors.js';
import {
  BuiltinPluginRegistry,
  CHAT_PROOFREADING_PROFILE,
  VOLCENGINE_TRANSCRIPTION_PROFILE,
  createBuiltinPluginRegistry,
  loadNormalizedModelRegistry,
  modelCenterConfiguration,
  normalizeModelRegistry,
  normalizeSnapshotEntry,
  type BuiltinModelPlugin
} from '../src/model-center/index.js';
import { setupFromFile } from '../src/models.js';

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mercury-model-center-'));
  temporaryRoots.push(directory);
  return directory;
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/valid/${name}`, import.meta.url), 'utf8')
  ) as T;
}

async function baseRegistry(): Promise<ModelConfigRegistry> {
  const value = await fixture<ModelConfigRegistry>('model-config.json');
  value.models = value.models.filter((model) => model.role !== 'audio_verification') as ModelConfigRegistry['models'];
  delete value.defaults.audio_verification;
  return value;
}

async function pluginSnapshotEntries() {
  const snapshot = await fixture<ModelSnapshot>('model-snapshot.json');
  return {
    asr: normalizeSnapshotEntry(snapshot.models.asr as ModelSnapshotEntry),
    calibration: normalizeSnapshotEntry(snapshot.models.calibration as ModelSnapshotEntry)
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('built-in model plugin registry', () => {
  it('registers the D008 providers and D009 Gemini plugin with unique connection and capability declarations', () => {
    expect(createBuiltinPluginRegistry().list()).toEqual([
      {
        plugin_id: 'volcengine_asr',
        api_version: 1,
        connection_types: ['volcengine_cloud'],
        task_capabilities: ['transcription']
      },
      {
        plugin_id: 'volcengine_subtitle_asr',
        api_version: 1,
        connection_types: ['volcengine_subtitle_cloud'],
        task_capabilities: ['transcription']
      },
      {
        plugin_id: 'openai_chat_completions',
        api_version: 1,
        connection_types: ['compatible_endpoint'],
        task_capabilities: ['proofreading']
      },
      {
        plugin_id: 'gemini',
        api_version: 1,
        connection_types: ['developer_api', 'vertex_ai'],
        task_capabilities: ['audio_verification']
      }
    ]);
  });

  it('rejects duplicate identifiers and incompatible plugin API versions at startup', () => {
    const valid: BuiltinModelPlugin = {
      pluginId: 'duplicate',
      apiVersion: 1,
      connectionTypes: ['test'],
      declaredCapabilities: VOLCENGINE_TRANSCRIPTION_PROFILE
    };
    expect(() => new BuiltinPluginRegistry([valid, valid])).toThrowError(
      expect.objectContaining({ code: 'MODEL_PLUGIN_DUPLICATE' })
    );
    expect(() => new BuiltinPluginRegistry([
      { ...valid, apiVersion: 2 as 1 }
    ])).toThrowError(expect.objectContaining({ code: 'MODEL_PLUGIN_VERSION_INCOMPATIBLE' }));
  });

  it('advertises only the four shipped built-ins without third-party installation or dynamic loading', () => {
    const plugins = createBuiltinPluginRegistry().list();
    expect(plugins.map((plugin) => plugin.plugin_id)).toEqual([
      'volcengine_asr', 'volcengine_subtitle_asr', 'openai_chat_completions', 'gemini'
    ]);
    expect(plugins).toHaveLength(4);
  });
});

describe('V01-D008 legacy configuration migration', () => {
  it('normalizes D007 adapters into connections, instances, assignments, and separate verified capabilities', async () => {
    const registry = normalizeModelRegistry(await baseRegistry());
    const view = modelCenterConfiguration(registry);

    expect(view.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ plugin_id: 'volcengine_asr', connection_type: 'volcengine_cloud' }),
      expect.objectContaining({ plugin_id: 'openai_chat_completions', connection_type: 'compatible_endpoint' })
    ]));
    expect(view.model_instances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model_instance_id: 'asr-default',
        declared_capabilities: VOLCENGINE_TRANSCRIPTION_PROFILE,
        verified_capabilities: VOLCENGINE_TRANSCRIPTION_PROFILE
      }),
      expect.objectContaining({
        model_instance_id: 'calibration-default',
        declared_capabilities: CHAT_PROOFREADING_PROFILE,
        verified_capabilities: CHAT_PROOFREADING_PROFILE
      })
    ]));
    expect(view.role_assignments).toEqual([
      { role: 'asr', capability: 'transcription', model_instance_id: 'asr-default' },
      { role: 'calibration', capability: 'proofreading', model_instance_id: 'calibration-default' }
    ]);
  });

  it('loads a legal D007 file without rewriting it or requiring credential re-entry', async () => {
    const workspace = await temporaryDirectory();
    await mkdir(path.join(workspace, 'config'));
    const legacy = await baseRegistry();
    const credentialRefs = legacy.models.map((model) => model.credential_ref);
    const source = `${JSON.stringify(legacy, null, 2)}\n`;
    const filePath = path.join(workspace, 'config', 'model-config.json');
    await writeFile(filePath, source);

    const registry = await loadNormalizedModelRegistry(workspace);

    expect(await readFile(filePath, 'utf8')).toBe(source);
    expect((registry.models[0] as any).plugin_id).toBe('volcengine_asr');
    expect(registry.models.map((model) => model.credential_ref)).toEqual(credentialRefs);
  });

  it('atomically rejects an unmappable legacy configuration and leaves the file byte-identical', async () => {
    const workspace = await temporaryDirectory();
    await mkdir(path.join(workspace, 'config'));
    const invalid = await baseRegistry() as any;
    invalid.models[0].adapter = 'unknown_provider';
    const source = `${JSON.stringify(invalid, null, 2)}\n`;
    const filePath = path.join(workspace, 'config', 'model-config.json');
    await writeFile(filePath, source);

    await expect(loadNormalizedModelRegistry(workspace)).rejects.toMatchObject({ code: 'MODEL_CONFIG_INVALID' });
    expect(await readFile(filePath, 'utf8')).toBe(source);
  });

  it('accepts the D008 setup import shape and persists plugin fields instead of adapter bindings', async () => {
    const workspace = path.join(await temporaryDirectory(), 'workspace');
    const configPath = path.join(await temporaryDirectory(), 'setup.json');
    await writeFile(configPath, JSON.stringify({
      models: [
        {
          config_id: 'asr-default', name: 'ASR', role: 'asr', runtime: 'cloud',
          plugin_id: 'volcengine_asr', connection_type: 'volcengine_cloud', model: 'bigmodel',
          endpoint: null, credential_ref: 'env:VOLCENGINE_API_KEY',
          provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true
        },
        {
          config_id: 'calibration-default', name: 'Proofreader', role: 'calibration', runtime: 'cloud',
          plugin_id: 'openai_chat_completions', connection_type: 'compatible_endpoint', model: 'chat-model',
          endpoint: 'https://chat.example.test/v1', credential_ref: 'env:CALIBRATION_API_KEY',
          provider_config: {}, default: true
        }
      ]
    }));

    const saved = await setupFromFile(workspace, configPath, true);

    expect(saved.models.every((model: any) => typeof model.plugin_id === 'string')).toBe(true);
    expect(saved.models.every((model: any) => model.adapter === undefined)).toBe(true);
  });

  it('enforces plugin identity, connection fields, and verified modality through the public Schema API', async () => {
    const normalized = normalizeModelRegistry(await baseRegistry()) as any;
    expect(validateContract('model-config', normalized).valid).toBe(true);

    const missingConnection = structuredClone(normalized);
    delete missingConnection.models[0].connection_type;
    expect(validateContract('model-config', missingConnection).valid).toBe(false);

    const unknownPlugin = structuredClone(normalized);
    unknownPlugin.models[0].plugin_id = 'unknown';
    expect(validateContract('model-config', unknownPlugin).valid).toBe(false);

    const unverifiedModality = structuredClone(normalized);
    unverifiedModality.models[0].last_check.verified_capabilities.input_modalities = ['text'];
    expect(validateContract('model-config', unverifiedModality).valid).toBe(false);
  });
});

describe('V01-D008 capability-bound runtime resolution', () => {
  it('resolves both stable capability interfaces from verified snapshot evidence', async () => {
    const entries = await pluginSnapshotEntries();
    const registry = createBuiltinPluginRegistry();
    const transcription = registry.resolveTranscription(entries.asr as unknown as ModelSnapshotEntry, {
      resolveAsrCredential: async () => ({ mode: 'api_key', uid: 'test', value: 'fake-test-value' })
    });
    const proofreading = registry.resolveProofreading(entries.calibration as unknown as ModelSnapshotEntry);

    expect(transcription.runtime.capability).toBe('transcription');
    expect(proofreading.runtime.capability).toBe('proofreading');
  });

  it.each([
    ['unknown plugin', (entry: any) => { entry.plugin_id = 'unknown'; }, 'MODEL_PLUGIN_UNKNOWN'],
    ['unsupported connection', (entry: any) => { entry.connection_type = 'other'; }, 'MODEL_CONNECTION_TYPE_UNSUPPORTED'],
    ['missing verified result', (entry: any) => { entry.check_snapshot.verified_capabilities = null; }, 'MODEL_CAPABILITY_NOT_VERIFIED'],
    ['missing audio modality', (entry: any) => { entry.check_snapshot.verified_capabilities.input_modalities = ['text']; }, 'MODEL_CAPABILITY_NOT_VERIFIED']
  ])('rejects %s before constructing a provider runtime', async (_name, mutate, code) => {
    const entry = (await pluginSnapshotEntries()).asr as any;
    mutate(entry);
    expect(() => createBuiltinPluginRegistry().resolveTranscription(entry, {
      resolveAsrCredential: async () => ({ mode: 'api_key', uid: 'test', value: 'fake-test-value' })
    })).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects a missing role assignment instead of selecting another configured model', async () => {
    const registry = await baseRegistry() as any;
    delete registry.defaults.calibration;
    expect(() => normalizeModelRegistry(registry)).toThrowError(MercuryError);
  });

  it('propagates a selected plugin failure without trying another plugin', async () => {
    const entries = await pluginSnapshotEntries();
    const fallbackFactory = vi.fn();
    const selected: BuiltinModelPlugin = {
      pluginId: 'selected', apiVersion: 1, connectionTypes: ['selected'],
      declaredCapabilities: VOLCENGINE_TRANSCRIPTION_PROFILE,
      createTranscriptionRuntime: () => ({
        capability: 'transcription',
        run: async () => { throw new Error('selected failed'); }
      })
    };
    const fallback: BuiltinModelPlugin = {
      pluginId: 'fallback', apiVersion: 1, connectionTypes: ['fallback'],
      declaredCapabilities: VOLCENGINE_TRANSCRIPTION_PROFILE,
      createTranscriptionRuntime: fallbackFactory
    };
    const entry = {
      ...entries.asr,
      plugin_id: 'selected',
      connection_type: 'selected'
    } as any;
    const resolved = new BuiltinPluginRegistry([selected, fallback]).resolveTranscription(entry);

    await expect(resolved.runtime.run({} as any)).rejects.toThrow('selected failed');
    expect(fallbackFactory).not.toHaveBeenCalled();
  });

  it('keeps the core pipeline free of direct supplier construction', async () => {
    const source = await readFile(new URL('../src/core-integration.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/new\s+(?:VolcengineAsrAdapter|OpenAiChatCompletionsCalibrationAdapter)/);
    expect(source).toContain('resolveTranscription');
    expect(source).toContain('resolveProofreading');
  });
});
