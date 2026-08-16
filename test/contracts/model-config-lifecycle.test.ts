import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import commonSchema from '../../schemas/v1/common.schema.json' with { type: 'json' };
import { validateContract } from '../../src/contracts/index.js';
import {
  computeModelConfigFingerprint,
  semanticKeywordDefinition
} from '../../src/contracts/validation/semantic.js';

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'valid'
);

async function fixture(name: string): Promise<any> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8'));
}

function commonValidator(definition: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-mercury-invariant-id', schemaType: 'string', valid: true });
  ajv.addKeyword(semanticKeywordDefinition());
  ajv.addSchema(commonSchema);
  const validator = ajv.getSchema(`${commonSchema.$id}#/$defs/${definition}`);
  if (!validator) throw new Error(`Missing common definition: ${definition}`);
  return validator;
}

function setFingerprint(model: any): void {
  model.config_fingerprint = computeModelConfigFingerprint(model);
  if (model.last_check) model.last_check.config_fingerprint = model.config_fingerprint;
}

function expectInvariant(result: ReturnType<typeof validateContract>, invariantId: string): void {
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.issues.some((entry) => entry.invariant_id === invariantId)).toBe(true);
    expect(result.issues.some((entry) => entry.invariant_id === 'INV-API-001')).toBe(false);
  }
}

function audioVerificationModel(withGcs = true): any {
  const model: any = {
    config_id: 'audio-verification-default',
    name: 'Audio verification contract fixture',
    role: 'audio_verification',
    runtime: 'cloud',
    adapter: 'vertex_gemini_audio_verifier',
    model: 'gemini-audio-fixture',
    endpoint: null,
    credential_ref: 'adc:mercury-audio-verification',
    provider_config: {
      project: 'fixture-project',
      location: 'us-central1'
    },
    enabled: true,
    cloud_data_confirmation: {
      confirmation_id: 'confirm-003',
      confirmed: true,
      confirmed_at: '2026-08-05T08:00:00.000+08:00',
      method: 'interactive_cli',
      data_categories: [
        'audio',
        'reference_srt',
        'calibration_candidate',
        'timed_text',
        'context'
      ]
    },
    config_fingerprint: '',
    last_check: {
      check_id: 'check-audio-001',
      config_id: 'audio-verification-default',
      config_fingerprint: '',
      role: 'audio_verification',
      confirmation_ref: 'confirm-003',
      started_at: '2026-08-05T08:00:30.000+08:00',
      ended_at: '2026-08-05T08:00:40.000+08:00',
      actual_model: 'gemini-audio-fixture-v1',
      outcome: 'passed',
      capabilities: {
        role: 'audio_verification',
        sample_sha256: 'b'.repeat(64),
        mime_type: 'audio/mpeg',
        timed_text_fixture_id: 'timed-text-fixture-v1',
        result_schema_version: '1.0.0',
        inline_audio: {
          max_inline_bytes: 20971520,
          max_audio_duration_ms: 3600000,
          parsed_finding_count: 0
        },
        private_gcs: null
      },
      error: null
    }
  };
  if (withGcs) {
    model.provider_config.gcs_bucket = 'fixture-bucket';
    model.last_check.capabilities.private_gcs = {
      object_uri: 'gs://fixture-bucket/check/object.mp3',
      uploaded_at: '2026-08-05T08:00:31.000+08:00',
      model_read_at: '2026-08-05T08:00:35.000+08:00',
      deleted_at: '2026-08-05T08:00:39.000+08:00',
      parsed_finding_count: 0,
      max_input_bytes: 104857600,
      max_audio_duration_ms: 7200000
    };
  }
  setFingerprint(model);
  return model;
}

function geminiDeveloperModel(): any {
  const model = audioVerificationModel(false);
  delete model.adapter;
  model.plugin_id = 'gemini';
  model.connection_id = model.config_id;
  model.connection_type = 'developer_api';
  model.credential_ref = 'env:GEMINI_API_KEY';
  model.provider_config = {};
  model.declared_capabilities = {
    task_capabilities: ['audio_verification'],
    input_modalities: ['text', 'audio'],
    output_types: ['structured_result'],
    structured_output: true
  };
  model.last_check.verified_capabilities = structuredClone(model.declared_capabilities);
  model.last_check.capabilities.gemini_files = {
    resource_name: 'files/check-audio-001',
    uploaded_at: '2026-08-05T08:00:31.000+08:00',
    model_read_at: '2026-08-05T08:00:35.000+08:00',
    deleted_at: '2026-08-05T08:00:39.000+08:00',
    parsed_finding_count: 0,
    max_input_bytes: 2147483648,
    max_audio_duration_ms: 7200000
  };
  setFingerprint(model);
  return model;
}

describe('INV-MOD-001/002/008 model configuration lifecycle', () => {
  it('keeps old Gemini Files evidence compatible while active checks use local chunking', async () => {
    const developer = await fixture('model-config.json');
    developer.models[2] = geminiDeveloperModel();
    developer.defaults.audio_verification = 'audio-verification-default';
    expect(validateContract('model-config', developer).valid).toBe(true);

    delete developer.models[2].last_check.capabilities.gemini_files;
    developer.models[2].last_check.capabilities.local_chunking = {
      threshold_bytes: 15000000,
      source_bytes: 1000,
      part_count: 1,
      largest_part_bytes: 1000,
      model_request_count: 1,
      parts: [{
        chunk_id: 'chunk-0001', bytes: 1000, start_ms: 0, end_ms: 1000,
        call_ref: 'call-0001', outcome: 'completed', error_ref: null
      }]
    };
    expect(validateContract('model-config', developer).valid).toBe(true);

    const vertex = await fixture('model-config.json');
    const vertexModel = geminiDeveloperModel();
    vertexModel.connection_type = 'vertex_ai';
    vertexModel.credential_ref = 'adc:mercury-audio-verification';
    vertexModel.provider_config = { project: 'fixture-project', location: 'us-central1' };
    delete vertexModel.last_check.capabilities.gemini_files;
    setFingerprint(vertexModel);
    vertex.models[2] = vertexModel;
    vertex.defaults.audio_verification = vertexModel.config_id;
    expect(validateContract('model-config', vertex).valid).toBe(true);

    vertexModel.last_check.capabilities.gemini_files = geminiDeveloperModel().last_check.capabilities.gemini_files;
    expect(validateContract('model-config', vertex).valid).toBe(false);

    delete vertexModel.last_check.capabilities.gemini_files;
    vertexModel.last_check.capabilities.local_chunking = {
      threshold_bytes: 15000000,
      source_bytes: 15000001,
      part_count: 2,
      largest_part_bytes: 8000000,
      model_request_count: 2,
      parts: [
        { chunk_id: 'chunk-0001', bytes: 8000000, start_ms: 0, end_ms: 1000, call_ref: 'call-0001', outcome: 'completed', error_ref: null },
        { chunk_id: 'chunk-0002', bytes: 7000001, start_ms: 1000, end_ms: 2000, call_ref: 'call-0002', outcome: 'completed', error_ref: null }
      ]
    };
    expect(validateContract('model-config', vertex).valid).toBe(true);

    vertexModel.last_check.capabilities.local_chunking.model_request_count = 1;
    expect(validateContract('model-config', vertex).valid).toBe(false);
  });

  it('matches the normative fingerprint vector', async () => {
    const value = await fixture('model-config.json');
    expect(computeModelConfigFingerprint(value.models[0])).toBe(
      '74ca3bf4886c9149dd3d516b2a8dc4278108e6022961dd94e25799f23c3b61ec'
    );
    expect(validateContract('model-config', value).valid).toBe(true);
  });

  it('allows unchecked confirmed and unconfirmed configs with a current fingerprint', async () => {
    const confirmed = await fixture('model-config.json');
    confirmed.models.forEach((model: any) => (model.last_check = null));
    expect(validateContract('model-config', confirmed).valid).toBe(true);

    const unconfirmed = await fixture('model-config.json');
    unconfirmed.models.forEach((model: any, index: number) => {
      model.cloud_data_confirmation = {
        confirmation_id: `withdrawn-${index}`,
        confirmed: false,
        confirmed_at: null,
        method: null,
        data_categories: []
      };
      model.last_check = null;
      setFingerprint(model);
    });
    expect(validateContract('model-config', unconfirmed).valid).toBe(true);
  });

  it('requires enabled role-matching defaults that reference real configs', async () => {
    for (const mutate of [
      (value: any) => (value.defaults.asr = 'missing'),
      (value: any) => (value.defaults.asr = value.defaults.calibration),
      (value: any) => (value.models[0].enabled = false)
    ]) {
      const value = await fixture('model-config.json');
      mutate(value);
      expect(validateContract('model-config', value).valid).toBe(false);
    }
  });

  it('accepts only the three frozen cloud role and adapter combinations', async () => {
    for (const mutate of [
      (model: any) => (model.runtime = 'local'),
      (model: any) => (model.adapter = 'openai_chat_completions'),
      (model: any) => (model.endpoint = 'https://asr.example.invalid'),
      (model: any) => (model.provider_config.resource_id = 'another-resource')
    ]) {
      const value = await fixture('model-config.json');
      mutate(value.models[0]);
      setFingerprint(value.models[0]);
      value.models[0].last_check = null;
      expect(validateContract('model-config', value).valid).toBe(false);
    }
  });

  it('requires an absolute HTTPS calibration endpoint and allows a null credential reference', async () => {
    const withoutCredential = await fixture('model-config.json');
    withoutCredential.models[1].credential_ref = null;
    setFingerprint(withoutCredential.models[1]);
    withoutCredential.models[1].last_check = null;
    expect(validateContract('model-config', withoutCredential).valid).toBe(true);

    for (const endpoint of ['http://chat.example.invalid/v1', 'https://', '/v1/chat']) {
      const value = await fixture('model-config.json');
      value.models[1].endpoint = endpoint;
      setFingerprint(value.models[1]);
      value.models[1].last_check = null;
      expect(validateContract('model-config', value).valid).toBe(false);
    }
  });

  it('excludes display, enabled, defaults, and checks from the fingerprint', async () => {
    const value = await fixture('model-config.json');
    const model = value.models[0];
    const fingerprint = computeModelConfigFingerprint(model);
    model.name = 'Renamed model';
    model.enabled = false;
    model.last_check = null;
    value.defaults.asr = value.models[0].config_id;
    expect(computeModelConfigFingerprint(model)).toBe(fingerprint);
  });

  it('requires execution changes to update the fingerprint and clear last_check', async () => {
    const value = await fixture('model-config.json');
    value.models[0].model = 'changed-model';
    expect(validateContract('model-config', value).valid).toBe(false);
    setFingerprint(value.models[0]);
    value.models[0].last_check.config_fingerprint = '0'.repeat(64);
    expect(validateContract('model-config', value).valid).toBe(false);
    value.models[0].last_check = null;
    expect(validateContract('model-config', value).valid).toBe(true);
  });

  it('rejects non-NFC strings throughout the fingerprint input without normalizing them', async () => {
    const decomposed = audioVerificationModel(false);
    const composedEquivalent = audioVerificationModel(false);
    decomposed.model = 'Cafe\u0301';
    composedEquivalent.model = 'Caf\u00e9';
    expect(computeModelConfigFingerprint(decomposed)).not.toBe(
      computeModelConfigFingerprint(composedEquivalent)
    );

    const mutations = [
      (model: any) => (model.model = 'Cafe\u0301'),
      (model: any) => (model.credential_ref = 'env:CAFE\u0301_KEY'),
      (model: any) => (model.provider_config.project = 'Cafe\u0301-project')
    ];

    for (const mutate of mutations) {
      const value = await fixture('model-config.json');
      const model = audioVerificationModel(false);
      mutate(model);
      model.last_check = null;
      setFingerprint(model);
      value.models[2] = model;
      expectInvariant(validateContract('model-config', value), 'INV-MOD-002-FP');
    }

    const composed = await fixture('model-config.json');
    const model = audioVerificationModel(false);
    model.model = 'Caf\u00e9';
    model.last_check = null;
    setFingerprint(model);
    composed.models[2] = model;
    expect(validateContract('model-config', composed).valid).toBe(true);
  });

  it('maps lifecycle failures to their declared public invariant IDs', async () => {
    const staleFingerprint = await fixture('model-config.json');
    staleFingerprint.models[0].model = 'changed-model';
    expectInvariant(validateContract('model-config', staleFingerprint), 'INV-MOD-002-FP');

    const invalidDefault = await fixture('model-config.json');
    invalidDefault.defaults.asr = invalidDefault.defaults.calibration;
    expectInvariant(validateContract('model-config', invalidDefault), 'INV-MOD-001');

    const invalidConfirmation = await fixture('model-config.json');
    invalidConfirmation.models[1].cloud_data_confirmation.data_categories = [
      'context',
      'transcript',
      'reference_srt'
    ];
    expectInvariant(validateContract('model-config', invalidConfirmation), 'INV-CLD-002');

    const staleCheck = await fixture('model-config.json');
    staleCheck.models[0].last_check.config_id = 'another-config';
    expectInvariant(validateContract('model-config', staleCheck), 'INV-MOD-002');

    const unconfirmedCheck = await fixture('model-config.json');
    unconfirmedCheck.models[0].last_check.confirmation_ref = 'another-confirmation';
    expectInvariant(validateContract('model-config', unconfirmedCheck), 'INV-CLD-001');

    const reversedCheck = await fixture('model-config.json');
    reversedCheck.models[0].last_check.ended_at = '2026-08-05T08:00:05.000+08:00';
    expectInvariant(validateContract('model-config', reversedCheck), 'INV-GEN-003');
  });
});

describe('INV-CLD-001/002 and INV-MOD-003 check states', () => {
  it('requires exact confirmation states, methods, categories, and ordering', async () => {
    for (const mutate of [
      (confirmation: any) => (confirmation.method = 'implicit_default'),
      (confirmation: any) => (confirmation.data_categories = ['context', 'transcript', 'reference_srt']),
      (confirmation: any) => (confirmation.confirmed_at = null)
    ]) {
      const value = await fixture('model-config.json');
      mutate(value.models[1].cloud_data_confirmation);
      setFingerprint(value.models[1]);
      value.models[1].last_check = null;
      expect(validateContract('model-config', value).valid).toBe(false);
    }
  });

  it('accepts failed checks only with null capabilities and a unified error', async () => {
    const value = await fixture('model-config.json');
    const check = value.models[0].last_check;
    check.outcome = 'failed';
    check.actual_model = null;
    check.capabilities = null;
    check.error = {
      error_id: 'check-error-001',
      code: 'MODEL_CHECK_FAILED',
      message: 'The model check failed.',
      stage: 'capability',
      retryable: true
    };
    expect(validateContract('model-config', value).valid).toBe(true);
    check.capabilities = { role: 'asr' };
    expectInvariant(validateContract('model-config', value), 'INV-MOD-003-F');

    check.capabilities = null;
    check.error = null;
    expectInvariant(validateContract('model-config', value), 'INV-MOD-003-F');
  });

  it('allows an actual model identity that differs from the configured alias', async () => {
    const value = await fixture('model-config.json');
    value.models[0].last_check.actual_model = 'provider-resolved-model-id';
    expect(validateContract('model-config', value).valid).toBe(true);
  });

  it('requires confirmation and ordered check times before execution', async () => {
    for (const mutate of [
      (value: any) => (value.models[0].last_check.confirmation_ref = 'another-confirmation'),
      (value: any) => (value.models[0].last_check.started_at = '2026-08-05T07:59:00.000+08:00'),
      (value: any) => (value.models[0].last_check.ended_at = '2026-08-05T08:00:05.000+08:00')
    ]) {
      const value = await fixture('model-config.json');
      mutate(value);
      expect(validateContract('model-config', value).valid).toBe(false);
    }
  });
});

describe('INV-MOD-004/007 and INV-GCS-001/002 role capabilities', () => {
  it('rejects partial, wrong-role, and legacy boolean capability summaries', async () => {
    for (const capabilities of [
      {},
      { role: 'calibration' },
      { role: 'asr', endpoint_accessible: true, runtime_matches: true }
    ]) {
      const value = await fixture('model-config.json');
      value.models[0].last_check.capabilities = capabilities;
      expectInvariant(validateContract('model-config', value), 'INV-MOD-003-P');
    }
  });

  it('accepts complete audio capabilities with and without private GCS', async () => {
    for (const withGcs of [false, true]) {
      const value = await fixture('model-config.json');
      const audio = audioVerificationModel(withGcs);
      value.models[2] = audio;
      value.defaults.audio_verification = audio.config_id;
      expect(validateContract('model-config', value).valid).toBe(true);
    }
  });

  it('allows an old gcs_bucket config to persist a new local-only check without remote evidence', async () => {
    const value = await fixture('model-config.json');
    const audio = value.models[2] as any;
    audio.last_check.capabilities.private_gcs = null;
    audio.last_check.capabilities.local_chunking = {
      threshold_bytes: 15000000,
      source_bytes: 15000001,
      part_count: 2,
      largest_part_bytes: 8000000,
      model_request_count: 2,
      parts: [
        { chunk_id: 'chunk-0001', bytes: 8000000, start_ms: 0, end_ms: 1000, call_ref: 'call-0001', outcome: 'completed', error_ref: null },
        { chunk_id: 'chunk-0002', bytes: 7000001, start_ms: 1000, end_ms: 2000, call_ref: 'call-0002', outcome: 'completed', error_ref: null }
      ]
    };
    expect(validateContract('model-config', value).valid).toBe(true);
  });

  it('requires private GCS evidence exactly with the configured bucket and lifecycle order', async () => {
    for (const mutate of [
      (model: any) => (model.last_check.capabilities.private_gcs = null),
      (model: any) => (model.last_check.capabilities.private_gcs.object_uri = 'gs://other-bucket/check/object.mp3'),
      (model: any) => (model.last_check.capabilities.private_gcs.deleted_at = '2026-08-05T08:00:32.000+08:00')
    ]) {
      const value = await fixture('model-config.json');
      const audio = audioVerificationModel(true);
      mutate(audio);
      value.models[2] = audio;
      expect(validateContract('model-config', value).valid).toBe(false);
    }

    const inline = await fixture('model-config.json');
    const inlineAudio = audioVerificationModel(false);
    inlineAudio.last_check.capabilities.private_gcs = {
      object_uri: 'gs://fixture-bucket/check/object.mp3',
      uploaded_at: '2026-08-05T08:00:31.000+08:00',
      model_read_at: '2026-08-05T08:00:35.000+08:00',
      deleted_at: '2026-08-05T08:00:39.000+08:00',
      parsed_finding_count: 0,
      max_input_bytes: 1,
      max_audio_duration_ms: 1
    };
    inline.models.push(inlineAudio);
    expect(validateContract('model-config', inline).valid).toBe(false);
  });
});

describe('INV-MOD-006 task model snapshots', () => {
  it('round-trips a complete frozen snapshot', async () => {
    const value = await fixture('model-snapshot.json');
    expect(validateContract('model-snapshot', value).valid).toBe(true);
  });

  it('preserves distinct configured and provider-returned model identities', async () => {
    const value = await fixture('model-snapshot.json');
    value.models.asr.check_snapshot.actual_model = 'provider-resolved-model-id';
    expect(validateContract('model-snapshot', value).valid).toBe(true);
  });

  it('rejects structurally valid capability evidence from another model role', async () => {
    const value = await fixture('model-snapshot.json');
    value.models.asr.check_snapshot.capabilities = structuredClone(
      value.models.calibration.check_snapshot.capabilities
    );
    expectInvariant(validateContract('model-snapshot', value), 'INV-MOD-006');
  });

  it('rejects duplicate IDs, failed checks, stale fingerprints, and late dependencies', async () => {
    for (const mutate of [
      (value: any) => (value.models.calibration.snapshot_entry_id = value.models.asr.snapshot_entry_id),
      (value: any) => (value.models.asr.check_snapshot.outcome = 'failed'),
      (value: any) => (value.models.asr.config_fingerprint = '0'.repeat(64)),
      (value: any) => (value.captured_at = '2026-08-05T08:00:15.000+08:00'),
      (value: any) => (value.models.asr.cloud_data_confirmation.confirmed = false)
    ]) {
      const value = await fixture('model-snapshot.json');
      mutate(value);
      expect(validateContract('model-snapshot', value).valid).toBe(false);
    }
  });

  it('rejects local or cross-role snapshot entries and unknown fields', async () => {
    for (const mutate of [
      (entry: any) => (entry.runtime = 'local'),
      (entry: any) => (entry.adapter = 'openai_chat_completions'),
      (entry: any) => (entry.provider = 'duplicated-provider-fact')
    ]) {
      const value = await fixture('model-snapshot.json');
      mutate(value.models.asr);
      expect(validateContract('model-snapshot', value).valid).toBe(false);
    }
  });

  it('maps frozen snapshot lifecycle failures to INV-MOD-006', async () => {
    const value = await fixture('model-snapshot.json');
    value.models.asr.check_snapshot.config_fingerprint = '0'.repeat(64);
    expectInvariant(validateContract('model-snapshot', value), 'INV-MOD-006');

    const lateConfirmation = await fixture('model-snapshot.json');
    lateConfirmation.models.asr.cloud_data_confirmation.confirmed_at =
      '2026-08-05T08:00:15.000+08:00';
    expectInvariant(validateContract('model-snapshot', lateConfirmation), 'INV-CLD-001');
  });

  it('rejects non-NFC fingerprint inputs in frozen snapshots', async () => {
    const value = await fixture('model-snapshot.json');
    const entry = value.models.asr;
    entry.model = 'Cafe\u0301';
    entry.config_fingerprint = computeModelConfigFingerprint(entry);
    entry.check_snapshot.config_fingerprint = entry.config_fingerprint;
    expectInvariant(validateContract('model-snapshot', value), 'INV-MOD-006');
  });
});

describe('INV-CALL-001/002/003 and INV-ADP-001 terminal primitives', () => {
  const completedCall = {
    call_id: 'call-001',
    model_snapshot_entry_ref: 'snapshot-entry-asr',
    started_at: '2026-08-05T08:01:10.000+08:00',
    ended_at: '2026-08-05T08:01:20.000+08:00',
    outcome: 'completed',
    provider_request_id: 'provider-request-001',
    error_ref: null
  };
  const completedStaging = {
    staging_id: 'staging-001',
    call_ref: 'call-001',
    object_uri: 'gs://fixture-bucket/task/object.mp3',
    created_at: '2026-08-05T08:01:09.000+08:00',
    cleanup_status: 'completed',
    cleanup_finished_at: '2026-08-05T08:01:21.000+08:00',
    error_ref: null
  };

  it('accepts only terminal calls without duplicated model facts', () => {
    const validate = commonValidator('CallRecord');
    expect(validate(completedCall)).toBe(true);
    expect(validate({ ...completedCall, outcome: 'pending' })).toBe(false);
    expect(validate({ ...completedCall, adapter: 'volcengine_asr' })).toBe(false);
    expect(validate({ ...completedCall, outcome: 'failed', error_ref: null })).toBe(false);
  });

  it('enforces call chronology on the shared CallRecord primitive', () => {
    const validate = commonValidator('CallRecord');
    const reversed = {
      ...completedCall,
      ended_at: '2026-08-05T08:01:09.000+08:00'
    };
    expect(validate(reversed)).toBe(false);
    expect(validate.errors?.some((entry) =>
      (entry.params as Record<string, unknown>).invariant_id === 'INV-CALL-002'
    )).toBe(true);
  });

  it('accepts only terminal staging without a duplicated bucket', () => {
    const validate = commonValidator('StagingRecord');
    expect(validate(completedStaging)).toBe(true);
    expect(validate({ ...completedStaging, staging_kind: 'gcs' })).toBe(true);
    expect(validate({
      ...completedStaging,
      staging_kind: 'gemini_file',
      object_uri: 'files/task-audio-001'
    })).toBe(true);
    expect(validate({ ...completedStaging, staging_kind: 'gemini_file' })).toBe(false);
    expect(validate({ ...completedStaging, staging_kind: 'gcs', object_uri: 'files/task-audio-001' })).toBe(false);
    expect(validate({ ...completedStaging, cleanup_status: 'pending' })).toBe(false);
    expect(validate({ ...completedStaging, bucket: 'fixture-bucket' })).toBe(false);
    expect(validate({ ...completedStaging, cleanup_status: 'failed', error_ref: null })).toBe(false);
  });

  it('validates a closed failure fallback and its call references', () => {
    const validate = commonValidator('AdapterFailureRecord');
    const failure: any = {
      failure_id: 'failure-001',
      provider_outcome_certainty: 'known_terminal',
      task_id: 'task-001',
      role: 'asr',
      model_snapshot_ref: 'snapshot-001',
      occurred_at: '2026-08-05T08:01:21.000+08:00',
      errors: [{
        error_id: 'error-call-001',
        code: 'MODEL_CALL_FAILED',
        message: 'The model call failed.',
        stage: 'model_call',
        retryable: true
      }],
      warnings: [],
      call: { ...completedCall, outcome: 'failed', error_ref: 'error-call-001' },
      staging: []
    };
    expect(validate(failure)).toBe(true);
    failure.call.error_ref = 'missing-error';
    expect(validate(failure)).toBe(false);
  });

  it('enforces call chronology and staging call linkage in failure fallbacks', () => {
    const validate = commonValidator('AdapterFailureRecord');
    const failure: any = {
      failure_id: 'failure-audio-call-001',
      provider_outcome_certainty: 'known_terminal',
      task_id: 'task-001',
      role: 'audio_verification',
      model_snapshot_ref: 'snapshot-001',
      occurred_at: '2026-08-05T08:01:22.000+08:00',
      errors: [{
        error_id: 'error-call-001',
        code: 'MODEL_CALL_FAILED',
        message: 'The model call failed.',
        stage: 'model_call',
        retryable: true
      }],
      warnings: [],
      call: { ...completedCall, outcome: 'failed', error_ref: 'error-call-001' },
      staging: [{ ...completedStaging }]
    };

    expect(validate(failure)).toBe(true);

    failure.staging[0].call_ref = null;
    expect(validate(failure)).toBe(false);
    expect(validate.errors?.some((entry) =>
      (entry.params as Record<string, unknown>).invariant_id === 'INV-ADP-001'
    )).toBe(true);

    failure.staging[0].call_ref = failure.call.call_id;
    failure.call.ended_at = '2026-08-05T08:01:09.000+08:00';
    expect(validate(failure)).toBe(false);
    expect(validate.errors?.some((entry) =>
      (entry.params as Record<string, unknown>).invariant_id === 'INV-CALL-002'
    )).toBe(true);
  });

  it('requires the canonical cleanup error and warning for failed staging', () => {
    const validate = commonValidator('AdapterFailureRecord');
    const failure: any = {
      failure_id: 'failure-audio-001',
      provider_outcome_certainty: 'known_terminal',
      task_id: 'task-001',
      role: 'audio_verification',
      model_snapshot_ref: 'snapshot-001',
      occurred_at: '2026-08-05T08:01:22.000+08:00',
      errors: [{
        error_id: 'error-cleanup-001',
        code: 'GCS_CLEANUP_FAILED',
        message: 'Cleanup failed.',
        stage: 'gcs_cleanup',
        retryable: true,
        remediation: 'Delete the object manually.'
      }],
      warnings: [{
        warning_id: 'warning-cleanup-001',
        code: 'GCS_CLEANUP_FAILED',
        message: 'Manual cleanup is required.',
        stage: 'gcs_cleanup',
        severity: 'high',
        related_error_ref: 'error-cleanup-001',
        related_staging_ref: 'staging-001'
      }],
      call: null,
      staging: [{
        ...completedStaging,
        call_ref: null,
        cleanup_status: 'failed',
        error_ref: 'error-cleanup-001'
      }]
    };
    expect(validate(failure)).toBe(true);

    failure.errors[0].code = 'WRONG_CLEANUP_CODE';
    expect(validate(failure)).toBe(false);
    failure.errors[0].code = 'GCS_CLEANUP_FAILED';

    failure.warnings[0].related_error_ref = 'missing-error';
    expect(validate(failure)).toBe(false);
    failure.warnings[0].related_error_ref = 'error-cleanup-001';

    failure.errors[0].resource_uri = 'gs://fixture-bucket/task/object.mp3';
    expect(validate(failure)).toBe(false);
    delete failure.errors[0].resource_uri;

    failure.warnings.push({ ...failure.warnings[0], warning_id: 'warning-cleanup-002' });
    expect(validate(failure)).toBe(false);
    failure.warnings.pop();

    failure.warnings = [];
    expect(validate(failure)).toBe(false);
    expect(validate.errors?.some((entry) =>
      (entry.params as Record<string, unknown>).invariant_id === 'INV-ADP-001'
    )).toBe(true);
  });

  it('closes Gemini Files cleanup failures with generic staging diagnostics', () => {
    const validate = commonValidator('AdapterFailureRecord');
    const failure: any = {
      failure_id: 'failure-gemini-file-001',
      provider_outcome_certainty: 'known_terminal',
      task_id: 'task-001',
      role: 'audio_verification',
      model_snapshot_ref: 'snapshot-001',
      occurred_at: '2026-08-05T08:01:22.000+08:00',
      errors: [{
        error_id: 'error-cleanup-gemini-001',
        code: 'STAGING_CLEANUP_FAILED',
        message: 'Gemini Files cleanup failed.',
        stage: 'staging_cleanup',
        retryable: true,
        remediation: 'Delete files/task-audio-001 manually.'
      }],
      warnings: [{
        warning_id: 'warning-cleanup-gemini-001',
        code: 'STAGING_CLEANUP_FAILED',
        message: 'Manual Gemini Files cleanup is required.',
        stage: 'staging_cleanup',
        severity: 'high',
        related_error_ref: 'error-cleanup-gemini-001',
        related_staging_ref: 'staging-gemini-001'
      }],
      call: null,
      staging: [{
        ...completedStaging,
        staging_id: 'staging-gemini-001',
        staging_kind: 'gemini_file',
        call_ref: null,
        object_uri: 'files/task-audio-001',
        cleanup_status: 'failed',
        error_ref: 'error-cleanup-gemini-001'
      }]
    };
    expect(validate(failure)).toBe(true);
    failure.errors[0].code = 'WRONG_CLEANUP_CODE';
    expect(validate(failure)).toBe(false);
    failure.errors[0].code = 'STAGING_CLEANUP_FAILED';
    failure.errors[0].stage = 'gcs_cleanup';
    expect(validate(failure)).toBe(false);
  });

  it('maps call chronology and non-terminal states without API fallbacks', async () => {
    const wrongReference = await fixture('transcript.raw.json');
    wrongReference.call.model_snapshot_entry_ref = 'snapshot-entry-calibration';
    expect(validateContract('transcript.raw', wrongReference).valid).toBe(true);

    const reversedTime = await fixture('transcript.raw.json');
    reversedTime.call.ended_at = '2026-08-05T08:01:59.000+08:00';
    expectInvariant(validateContract('transcript.raw', reversedTime), 'INV-CALL-002');

    const pendingCall = await fixture('transcript.raw.json');
    pendingCall.call.outcome = 'pending';
    expectInvariant(validateContract('transcript.raw', pendingCall), 'INV-CALL-003');

    const pendingStaging = await fixture('audio-verification.completed.json');
    pendingStaging.staging[0].cleanup_status = 'pending';
    expectInvariant(validateContract('audio-verification', pendingStaging), 'INV-CALL-003');
  });
});
