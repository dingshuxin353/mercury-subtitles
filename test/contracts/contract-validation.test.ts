import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ContractRegistryError,
  ContractValidationError,
  assertContractGraph,
  validateAllSchemas,
  validateContract,
  validateContractGraph,
  type ContractGraph,
  type ContractName
} from '../../src/contracts/index.js';
import { registeredSchemas } from '../../src/contracts/validation/registry.js';
import { computeModelConfigFingerprint } from '../../src/contracts/validation/semantic.js';

const fixtureRoot = new URL('../fixtures/valid/', import.meta.url);
const invalidFixtureRoot = new URL('../fixtures/invalid/', import.meta.url);

async function fixture<T = any>(name: string): Promise<T> {
  return JSON.parse(await readFile(fileURLToPath(new URL(name, fixtureRoot)), 'utf8')) as T;
}

async function invalidFixture<T = any>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(fileURLToPath(new URL(name, invalidFixtureRoot)), 'utf8')
  ) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectInvariant(
  result: ReturnType<typeof validateContract> | ReturnType<typeof validateContractGraph>,
  invariantId: string
): void {
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.issues.some((issue) => issue.invariant_id === invariantId)).toBe(true);
    expect(result.issues.some((issue) => issue.invariant_id === 'INV-API-001')).toBe(false);
  }
}

async function completeGraph(): Promise<ContractGraph> {
  return {
    modelConfig: await fixture('model-config.json'),
    modelSnapshot: await fixture('model-snapshot.json'),
    transcriptRaw: await fixture('transcript.raw.json'),
    calibrationResult: await fixture('calibration-result.json'),
    audioVerification: await fixture('audio-verification.completed.json'),
    adapterFailures: [],
    availableTaskFiles: [
      'input/sample.mp3',
      'input/reference.srt',
      'work/transcript.raw.json',
      'work/calibration-result.json',
      'work/provider-response.asr.redacted.json'
    ],
    availableModificationIds: ['modification-0001'],
    availableReferenceSegmentIds: ['reference-0001']
  };
}

describe('registered D001 schemas', () => {
  it('meta-validates and compiles all five contracts and shared definitions', () => {
    expect(validateAllSchemas()).toBeUndefined();
  });

  it('rejects semantic-check declaration drift through the public full-registry API', () => {
    const snapshotSchema = registeredSchemas.find(
      (schema) => schema.title === 'ModelSnapshot'
    ) as Record<string, unknown>;
    const declarations = snapshotSchema['x-mercury-semantic-checks'] as Array<{
      check: string;
      invariant_id: string;
    }>;
    const original = declarations[0]!;
    declarations[0] = { ...original, check: 'unregistered-semantic-check' };
    try {
      expect(() => validateAllSchemas()).toThrowError(ContractRegistryError);
    } finally {
      declarations[0] = original;
    }
    expect(validateAllSchemas()).toBeUndefined();
  });

  it.each<[ContractName, string]>([
    ['model-config', 'model-config.json'],
    ['model-snapshot', 'model-snapshot.json'],
    ['transcript.raw', 'transcript.raw.json'],
    ['calibration-result', 'calibration-result.json'],
    ['audio-verification', 'audio-verification.not-requested.json'],
    ['audio-verification', 'audio-verification.skipped.json'],
    ['audio-verification', 'audio-verification.failed.json'],
    ['audio-verification', 'audio-verification.completed.json']
  ])('accepts %s fixture %s', async (contract, filename) => {
    expect(validateContract(contract, await fixture(filename)).valid).toBe(true);
  });

  it.each<[ContractName, string, string]>([
    ['transcript.raw', 'transcript.missing-full-text.json', 'INV-ASR-001'],
    ['audio-verification', 'audio-verification.illegal-status.json', 'INV-AV-001'],
    ['model-config', 'model-config.incompatible-version.json', 'INV-GEN-001']
  ])('keeps checked-in invalid fixture %s rejected', async (contract, filename, invariantId) => {
    expectInvariant(validateContract(contract, await invalidFixture(filename)), invariantId);
  });

  it.each<[ContractName, string]>([
    ['transcript.raw', 'transcript.raw.json'],
    ['calibration-result', 'calibration-result.json'],
    ['audio-verification', 'audio-verification.completed.json']
  ])('rejects missing fields, unknown fields, and incompatible versions for %s', async (contract, filename) => {
    const missing = await fixture(filename);
    delete missing.created_at;
    expect(validateContract(contract, missing).valid).toBe(false);

    const unknown = await fixture(filename);
    unknown.provider_payload = {};
    expectInvariant(validateContract(contract, unknown), 'INV-GEN-005');

    const version = await fixture(filename);
    version.schema_version = '2.0.0';
    expectInvariant(validateContract(contract, version), 'INV-GEN-001');
  });
});

describe('D001-C transcript protocol', () => {
  it('requires exact text joining, contiguous indexes, ordered bounded timings, and unique IDs', async () => {
    const transcript = await fixture('transcript.raw.json');
    transcript.full_text = 'different';
    expectInvariant(validateContract('transcript.raw', transcript), 'INV-ASR-001');

    const index = await fixture('transcript.raw.json');
    index.segments[1].index = 4;
    expectInvariant(validateContract('transcript.raw', index), 'INV-ASR-001');

    const overlap = await fixture('transcript.raw.json');
    overlap.segments[1].start_ms = 2000;
    expectInvariant(validateContract('transcript.raw', overlap), 'INV-ASR-001');

    const duration = await fixture('transcript.raw.json');
    duration.segments[1].end_ms = 5001;
    expectInvariant(validateContract('transcript.raw', duration), 'INV-ASR-001');

    const duplicate = await fixture('transcript.raw.json');
    duplicate.segments[1].segment_id = duplicate.segments[0].segment_id;
    expectInvariant(validateContract('transcript.raw', duplicate), 'INV-GEN-004');
  });

  it('requires word timing within the segment and a successful call', async () => {
    const transcript = await fixture('transcript.raw.json');
    transcript.segments[0].words[0].end_ms = 2600;
    expectInvariant(validateContract('transcript.raw', transcript), 'INV-ASR-001');

    const failed = await fixture('transcript.raw.json');
    failed.call.outcome = 'failed';
    failed.call.error_ref = 'asr-failed';
    expectInvariant(validateContract('transcript.raw', failed), 'INV-ASR-002');
  });

  it('allows only U+000A as the full-text control separator', async () => {
    const transcript = await fixture('transcript.raw.json');
    expect(validateContract('transcript.raw', transcript).valid).toBe(true);
    transcript.segments[0].text = '欢迎\u200B使用水星';
    transcript.full_text = `${transcript.segments[0].text}\n字幕工具`;
    expectInvariant(validateContract('transcript.raw', transcript), 'INV-GEN-002');
  });
});

describe('D001-C calibration protocol', () => {
  it('covers MP3-only and the two SRT modes', async () => {
    const mp3Only = await fixture('calibration-result.json');
    mp3Only.request.reference_srt_ref = null;
    mp3Only.request.mode = null;
    expect(validateContract('calibration-result', mp3Only).valid).toBe(true);

    const segmentation = await fixture('calibration-result.json');
    segmentation.request.mode = 'text-and-segmentation';
    segmentation.suggestions[0].kind = 'segmentation';
    expect(validateContract('calibration-result', segmentation).valid).toBe(true);
  });

  it('rejects ambiguous request combinations and text-only structural changes', async () => {
    const noReferenceWithMode = await fixture('calibration-result.json');
    noReferenceWithMode.request.reference_srt_ref = null;
    expectInvariant(validateContract('calibration-result', noReferenceWithMode), 'INV-CAL-001');

    const referenceWithoutMode = await fixture('calibration-result.json');
    referenceWithoutMode.request.mode = null;
    expectInvariant(validateContract('calibration-result', referenceWithoutMode), 'INV-CAL-001');

    const timing = await fixture('calibration-result.json');
    timing.suggestions[0].kind = 'timing';
    expectInvariant(validateContract('calibration-result', timing), 'INV-CAL-002');
  });

  it('enforces completed and failed terminal matrices', async () => {
    const completed = await fixture('calibration-result.json');
    completed.errors.push({
      error_id: 'unexpected-error', code: 'UNEXPECTED_ERROR', message: 'unexpected', stage: 'model_call', retryable: false
    });
    expectInvariant(validateContract('calibration-result', completed), 'INV-CAL-003-C');

    const failed = await fixture('calibration-result.json');
    failed.status = 'failed';
    failed.call.outcome = 'failed';
    failed.call.error_ref = 'calibration-failed';
    failed.suggestions = [];
    failed.errors = [{
      error_id: 'calibration-failed', code: 'MODEL_CALL_FAILED', message: 'fixture failure', stage: 'model_call', retryable: true
    }];
    expect(validateContract('calibration-result', failed).valid).toBe(true);

    failed.call.error_ref = 'missing-error';
    expectInvariant(validateContract('calibration-result', failed), 'INV-CAL-003-F');
  });
});

describe('D001-D audio verification state and GCS lifecycle', () => {
  it('accepts exactly the four terminal status literals', async () => {
    const value = await fixture('audio-verification.not-requested.json');
    value.status = 'requested';
    expectInvariant(validateContract('audio-verification', value), 'INV-AV-001');
  });

  it('keeps not_requested empty and covers every skipped reason family', async () => {
    const notRequested = await fixture('audio-verification.not-requested.json');
    notRequested.input = {
      audio_ref: 'input/sample.mp3', audio_sha256: 'a'.repeat(64), transcript_ref: 'work/transcript.raw.json', calibration_ref: 'work/calibration-result.json', reference_srt_ref: null
    };
    expectInvariant(validateContract('audio-verification', notRequested), 'INV-AV-002-N');

    for (const reason of ['not_configured', 'cloud_confirmation_missing', 'check_missing_or_stale']) {
      const skipped = await fixture('audio-verification.skipped.json');
      skipped.skip_reason = reason;
      expect(validateContract('audio-verification', skipped).valid).toBe(true);
    }
    for (const reason of ['input_limit_exceeded', 'known_model_limitation']) {
      const skipped = await fixture('audio-verification.skipped.json');
      skipped.skip_reason = reason;
      skipped.model_snapshot_ref = 'snapshot-001';
      expect(validateContract('audio-verification', skipped).valid).toBe(true);
    }
    const unavailable = await fixture('audio-verification.skipped.json');
    unavailable.skip_reason = 'base_result_unavailable';
    unavailable.model_snapshot_ref = 'snapshot-001';
    unavailable.input = null;
    expect(validateContract('audio-verification', unavailable).valid).toBe(true);
  });

  it('requires failed evidence and prevents applying failed findings', async () => {
    const missingEvidence = await fixture('audio-verification.failed.json');
    missingEvidence.calls = [];
    missingEvidence.errors = [];
    expectInvariant(validateContract('audio-verification', missingEvidence), 'INV-AV-002-F');

    const applied = await fixture('audio-verification.failed.json');
    applied.findings = [{
      finding_id: 'finding-failed', kind: 'text_correction', start_ms: 0, end_ms: 1,
      current_text: '甲', suggested_text: '乙', rationale: 'fixture', confidence: 'low'
    }];
    applied.application_results = [{
      application_id: 'application-failed', finding_ref: 'finding-failed', disposition: 'applied',
      reason: 'accepted_by_rules', modification_ref: 'modification-failed'
    }];
    expectInvariant(validateContract('audio-verification', applied), 'INV-AV-003');
  });

  it('accepts pre-call upload failure and requires closed cleanup-failure evidence', async () => {
    const uploadFailure = await fixture('audio-verification.failed.json');
    uploadFailure.calls = [];
    uploadFailure.errors[0].stage = 'gcs_upload';
    expect(validateContract('audio-verification', uploadFailure).valid).toBe(true);

    const uploadAfterCall = await fixture('audio-verification.failed.json');
    uploadAfterCall.errors[0].stage = 'gcs_upload';
    expectInvariant(validateContract('audio-verification', uploadAfterCall), 'INV-AV-002-F');

    const cleanupFailure = await fixture('audio-verification.failed.json');
    cleanupFailure.calls[0].outcome = 'completed';
    cleanupFailure.calls[0].error_ref = null;
    cleanupFailure.errors = [{
      error_id: 'cleanup-failed', code: 'GCS_CLEANUP_FAILED', message: 'cleanup failed',
      stage: 'gcs_cleanup', retryable: true, remediation: 'Delete the staged object manually.'
    }];
    cleanupFailure.staging = [{
      staging_id: 'staging-failed', call_ref: cleanupFailure.calls[0].call_id,
      object_uri: 'gs://fixture-bucket/task-001/failed.mp3', created_at: '2026-08-05T08:03:30.000+08:00',
      cleanup_status: 'failed', cleanup_finished_at: '2026-08-05T08:04:05.000+08:00', error_ref: 'cleanup-failed'
    }];
    cleanupFailure.warnings = [{
      warning_id: 'cleanup-warning', code: 'GCS_CLEANUP_FAILED', message: 'manual cleanup required',
      stage: 'gcs_cleanup', severity: 'high', related_error_ref: 'cleanup-failed', related_staging_ref: 'staging-failed'
    }];
    expect(validateContract('audio-verification', cleanupFailure).valid).toBe(true);

    cleanupFailure.errors[0].code = 'WRONG_CLEANUP_CODE';
    expectInvariant(validateContract('audio-verification', cleanupFailure), 'INV-GCS-004-F');
    cleanupFailure.errors[0].code = 'GCS_CLEANUP_FAILED';

    const geminiCleanupFailure = structuredClone(cleanupFailure);
    geminiCleanupFailure.staging[0].staging_kind = 'gemini_file';
    geminiCleanupFailure.staging[0].object_uri = 'files/task-001-audio';
    geminiCleanupFailure.errors[0].stage = 'staging_cleanup';
    geminiCleanupFailure.errors[0].code = 'STAGING_CLEANUP_FAILED';
    geminiCleanupFailure.warnings[0].stage = 'staging_cleanup';
    geminiCleanupFailure.warnings[0].code = 'STAGING_CLEANUP_FAILED';
    expect(validateContract('audio-verification', geminiCleanupFailure).valid).toBe(true);
    geminiCleanupFailure.errors[0].code = 'WRONG_CLEANUP_CODE';
    expectInvariant(validateContract('audio-verification', geminiCleanupFailure), 'INV-GCS-004-F');

    cleanupFailure.warnings = [];
    expectInvariant(validateContract('audio-verification', cleanupFailure), 'INV-GCS-004-F');
  });

  it('orders staging creation, model calls, and terminal cleanup', async () => {
    const lateUpload = await fixture('audio-verification.completed.json');
    lateUpload.staging[0].created_at = '2026-08-05T08:04:01.000+08:00';
    expectInvariant(validateContract('audio-verification', lateUpload), 'INV-GEN-003');

    const earlyCleanup = await fixture('audio-verification.completed.json');
    earlyCleanup.staging[0].cleanup_finished_at = '2026-08-05T08:04:02.000+08:00';
    expectInvariant(validateContract('audio-verification', earlyCleanup), 'INV-GEN-003');
  });

  it('requires one application per completed finding and never applies translations', async () => {
    const missingApplication = await fixture('audio-verification.completed.json');
    missingApplication.application_results = [];
    expectInvariant(validateContract('audio-verification', missingApplication), 'INV-AV-004');

    const translation = await fixture('audio-verification.completed.json');
    translation.findings[0].kind = 'translation';
    expectInvariant(validateContract('audio-verification', translation), 'INV-AV-003');
  });

  it('accepts multiple successful inline chunk calls and rejects a failed call in completed state', async () => {
    const chunked = await fixture('audio-verification.completed.json');
    chunked.calls.push({
      ...chunked.calls[0],
      call_id: 'call-audio-0002',
      provider_request_id: 'provider-audio-0002',
      started_at: '2026-08-05T08:04:01.000+08:00',
      ended_at: '2026-08-05T08:04:02.000+08:00'
    });
    expect(validateContract('audio-verification', chunked).valid).toBe(true);

    chunked.calls[1].outcome = 'failed';
    chunked.calls[1].error_ref = 'error-chunk-0002';
    expectInvariant(validateContract('audio-verification', chunked), 'INV-AV-002-C');
  });

  it('persists and closes every local audio chunk against one model call', async () => {
    const chunked = await fixture('audio-verification.completed.json');
    chunked.staging = [];
    chunked.calls = [
      { ...chunked.calls[0], call_id: 'call-chunk-0001', provider_request_id: 'provider-chunk-0001' },
      { ...chunked.calls[0], call_id: 'call-chunk-0002', provider_request_id: 'provider-chunk-0002' }
    ];
    chunked.local_chunking = {
      threshold_bytes: 15000000,
      source_bytes: 15000001,
      parts: [
        { chunk_id: 'chunk-0001', bytes: 8000000, start_ms: 0, end_ms: 2500, call_ref: 'call-chunk-0001', outcome: 'completed', error_ref: null },
        { chunk_id: 'chunk-0002', bytes: 7000001, start_ms: 2500, end_ms: 5000, call_ref: 'call-chunk-0002', outcome: 'completed', error_ref: null }
      ]
    };
    expect(validateContract('audio-verification', chunked).valid).toBe(true);

    const wrongBytes = clone(chunked);
    wrongBytes.local_chunking.source_bytes += 1;
    expectInvariant(validateContract('audio-verification', wrongBytes), 'INV-GEN-003');

    const gap = clone(chunked);
    gap.local_chunking.parts[1].start_ms += 1;
    expectInvariant(validateContract('audio-verification', gap), 'INV-GEN-003');

    const duplicateCall = clone(chunked);
    duplicateCall.local_chunking.parts[1].call_ref = 'call-chunk-0001';
    expectInvariant(validateContract('audio-verification', duplicateCall), 'INV-GEN-004');
  });
});

describe('D001-E ContractGraph', () => {
  it('validates a complete five-contract graph and preserves the input identity', async () => {
    const graph = await completeGraph();
    const result = validateContractGraph(graph);
    expect(result).toEqual({ valid: true, value: graph, issues: [] });
    expect(assertContractGraph(graph)).toBe(graph);
  });

  it('accepts multi-segment suggestion bounds and legal snapshot-backed skip states', async () => {
    const multipleSegments = await completeGraph();
    multipleSegments.calibrationResult!.suggestions[0]!.source_segment_refs = ['seg-0001', 'seg-0002'];
    multipleSegments.calibrationResult!.suggestions[0]!.end_ms = 5000;
    expect(validateContractGraph(multipleSegments).valid).toBe(true);

    const skipped = await completeGraph();
    skipped.audioVerification = await fixture('audio-verification.skipped.json');
    skipped.audioVerification.skip_reason = 'input_limit_exceeded';
    skipped.audioVerification.model_snapshot_ref = 'snapshot-001';
    skipped.availableModificationIds = [];
    expect(validateContractGraph(skipped).valid).toBe(true);
  });

  it('rejects unknown graph keys, duplicate context arrays, and missing direct dependencies', async () => {
    const unknown = await completeGraph() as ContractGraph & { extra: boolean };
    unknown.extra = true;
    expectInvariant(validateContractGraph(unknown), 'INV-GEN-005');

    const duplicates = await completeGraph();
    duplicates.availableTaskFiles!.push('input/sample.mp3');
    expectInvariant(validateContractGraph(duplicates), 'INV-GEN-004');

    const missing = await completeGraph();
    delete missing.modelSnapshot;
    expectInvariant(validateContractGraph(missing), 'INV-GEN-007');

    const unavailable = await completeGraph();
    unavailable.audioVerification = await fixture('audio-verification.skipped.json');
    unavailable.audioVerification.skip_reason = 'base_result_unavailable';
    unavailable.audioVerification.model_snapshot_ref = 'snapshot-001';
    unavailable.audioVerification.input = null;
    delete unavailable.modelSnapshot;
    expectInvariant(validateContractGraph(unavailable), 'INV-GEN-007');
  });

  it('uses the exact shared path and protocol ID primitives for graph context arrays', () => {
    expect(validateContractGraph({
      availableTaskFiles: ['input/sample.mp3'],
      availableModificationIds: ['modification-0001']
    }).valid).toBe(true);

    for (const invalidPath of ['bad\u2028path', '../escape']) {
      expectInvariant(
        validateContractGraph({ availableTaskFiles: [invalidPath] }),
        invalidPath.includes('\u2028') ? 'INV-GEN-002' : 'INV-GEN-004'
      );
    }
    for (const invalidId of ['bad id', '../escape']) {
      expectInvariant(
        validateContractGraph({ availableModificationIds: [invalidId] }),
        'INV-GEN-004'
      );
    }
  });

  it('returns stable issues for malformed nested contracts without unsafe dereferences', () => {
    for (const graph of [
      { audioVerification: {} },
      { modelSnapshot: [] },
      { transcriptRaw: null },
      { adapterFailures: [null] }
    ]) {
      const result = validateContractGraph(graph as unknown as ContractGraph);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues).toEqual([...result.issues].sort((left, right) =>
          left.path.localeCompare(right.path) ||
          left.invariant_id.localeCompare(right.invariant_id) ||
          left.message.localeCompare(right.message)
        ));
      }
      expect(() => assertContractGraph(graph as unknown as ContractGraph)).toThrowError(
        ContractValidationError
      );
    }
  });

  it('closes task, snapshot, call, file, source, modification, and bucket references', async () => {
    const task = await completeGraph();
    task.transcriptRaw!.task_id = 'other-task';
    expectInvariant(validateContractGraph(task), 'INV-GEN-007');

    const call = await completeGraph();
    call.transcriptRaw!.call.model_snapshot_entry_ref = 'missing-entry';
    expectInvariant(validateContractGraph(call), 'INV-CALL-001');

    const file = await completeGraph();
    file.availableTaskFiles = file.availableTaskFiles!.filter((path) => path !== 'input/sample.mp3');
    expectInvariant(validateContractGraph(file), 'INV-GEN-007');

    const source = await completeGraph();
    source.audioVerification!.input!.audio_sha256 = 'b'.repeat(64);
    expectInvariant(validateContractGraph(source), 'INV-AV-006');

    const modification = await completeGraph();
    modification.availableModificationIds = [];
    expectInvariant(validateContractGraph(modification), 'INV-AV-006');

    const bucket = await completeGraph();
    bucket.audioVerification!.staging[0]!.object_uri = 'gs://other-bucket/task-001/object.mp3';
    expectInvariant(validateContractGraph(bucket), 'INV-GCS-003');

    const asrEvidence = await completeGraph();
    asrEvidence.audioVerification!.findings[0]!.source_segment_refs = ['seg-0001'];
    expect(validateContractGraph(asrEvidence).valid).toBe(true);

    const referenceEvidence = await completeGraph();
    referenceEvidence.audioVerification!.findings[0]!.source_segment_refs = ['reference-0001'];
    expect(validateContractGraph(referenceEvidence).valid).toBe(true);

    for (const invalidReference of ['subtitle-0001', 'missing-segment']) {
      const invalidEvidence = await completeGraph();
      invalidEvidence.audioVerification!.findings[0]!.source_segment_refs = [invalidReference];
      expectInvariant(validateContractGraph(invalidEvidence), 'INV-GEN-004');
    }

    const forgedReferenceContext = await completeGraph();
    forgedReferenceContext.availableReferenceSegmentIds = ['subtitle-0001'];
    forgedReferenceContext.audioVerification!.findings[0]!.source_segment_refs = ['subtitle-0001'];
    const forgedResult = validateContractGraph(forgedReferenceContext);
    expectInvariant(forgedResult, 'INV-GEN-004');
    if (!forgedResult.valid) {
      expect(forgedResult.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/availableReferenceSegmentIds/0' }),
        expect.objectContaining({ path: '/audioVerification/findings/0/source_segment_refs' })
      ]));
    }

    for (const malformedReference of ['reference-001', 'reference-0000', 'reference-00001']) {
      const malformedReferenceContext = await completeGraph();
      malformedReferenceContext.availableReferenceSegmentIds = [malformedReference];
      expectInvariant(validateContractGraph(malformedReferenceContext), 'INV-GEN-004');
    }
  });

  it('binds Gemini Files staging to the developer_api snapshot without a GCS bucket', async () => {
    const graph = await completeGraph();
    const entry: any = graph.modelSnapshot!.models.audio_verification;
    delete entry.adapter;
    entry.plugin_id = 'gemini';
    entry.connection_id = entry.config_id;
    entry.connection_type = 'developer_api';
    entry.credential_ref = 'env:GEMINI_API_KEY';
    entry.provider_config = {};
    entry.declared_capabilities = {
      task_capabilities: ['audio_verification'], input_modalities: ['text', 'audio'],
      output_types: ['structured_result'], structured_output: true
    };
    entry.check_snapshot.verified_capabilities = structuredClone(entry.declared_capabilities);
    entry.check_snapshot.capabilities.private_gcs = null;
    entry.check_snapshot.capabilities.gemini_files = {
      resource_name: 'files/check-audio-001',
      uploaded_at: '2026-08-05T08:00:31.000+08:00',
      model_read_at: '2026-08-05T08:00:35.000+08:00',
      deleted_at: '2026-08-05T08:00:39.000+08:00',
      parsed_finding_count: 0,
      max_input_bytes: 2147483648,
      max_audio_duration_ms: 7200000
    };
    entry.config_fingerprint = computeModelConfigFingerprint(entry);
    entry.check_snapshot.config_fingerprint = entry.config_fingerprint;
    graph.audioVerification!.staging[0]!.staging_kind = 'gemini_file';
    graph.audioVerification!.staging[0]!.object_uri = 'files/task-audio-001';
    expect(validateContractGraph(graph).valid).toBe(true);

    entry.connection_type = 'vertex_ai';
    entry.provider_config = { project: 'fixture-project', location: 'us-central1' };
    delete entry.check_snapshot.capabilities.gemini_files;
    entry.config_fingerprint = computeModelConfigFingerprint(entry);
    entry.check_snapshot.config_fingerprint = entry.config_fingerprint;
    expectInvariant(validateContractGraph(graph), 'INV-GCS-003');
  });

  it('enforces snapshot fingerprints, calibration segment references, and text-only policy', async () => {
    const config = await completeGraph();
    config.modelSnapshot!.models.asr.check_snapshot.config_fingerprint = '0'.repeat(64);
    expectInvariant(validateContractGraph(config), 'INV-MOD-006');

    const segment = await completeGraph();
    segment.calibrationResult!.suggestions[0]!.source_segment_refs = ['missing-segment'];
    expectInvariant(validateContractGraph(segment), 'INV-GEN-004');

    const mode = await completeGraph();
    mode.audioVerification!.findings[0]!.kind = 'timing';
    expectInvariant(validateContractGraph(mode), 'INV-AV-006');

    const fakeMissingModel = await completeGraph();
    fakeMissingModel.audioVerification = await fixture('audio-verification.skipped.json');
    expectInvariant(validateContractGraph(fakeMissingModel), 'INV-MOD-009');

    const wrongRoleCapability = await completeGraph();
    wrongRoleCapability.modelSnapshot!.models.asr.check_snapshot.capabilities = clone(
      wrongRoleCapability.modelSnapshot!.models.calibration.check_snapshot.capabilities
    );
    expectInvariant(validateContractGraph(wrongRoleCapability), 'INV-MOD-006');
  });

  it('keeps adapter failures mutually exclusive with role artifacts and throws stable errors', async () => {
    const graph = await completeGraph();
    graph.adapterFailures = [{
      failure_id: 'failure-asr', task_id: 'task-001', role: 'asr', model_snapshot_ref: 'snapshot-001',
      occurred_at: '2026-08-05T08:02:02.000+08:00', provider_outcome_certainty: 'known_terminal', errors: [{
        error_id: 'error-asr', code: 'MODEL_CALL_FAILED', message: 'fixture failure', stage: 'model_call', retryable: true
      }], warnings: [], call: {
        call_id: 'call-asr-failed', model_snapshot_entry_ref: 'snapshot-entry-asr',
        started_at: '2026-08-05T08:02:00.000+08:00', ended_at: '2026-08-05T08:02:01.000+08:00',
        outcome: 'failed', error_ref: 'error-asr'
      }, staging: []
    }];
    const result = validateContractGraph(graph);
    expectInvariant(result, 'INV-ADP-001');
    expect(() => assertContractGraph(graph)).toThrowError(ContractValidationError);
    if (!result.valid) {
      expect(result.issues).toEqual([...result.issues].sort((a, b) =>
        a.path.localeCompare(b.path) || a.invariant_id.localeCompare(b.invariant_id) || a.message.localeCompare(b.message)
      ));
    }
  });

  it('accepts a pre-artifact failure with call null when snapshot and role references match', async () => {
    const complete = await completeGraph();
    const graph: ContractGraph = {
      modelSnapshot: complete.modelSnapshot!,
      adapterFailures: [{
      failure_id: 'failure-asr-pre-artifact',
      task_id: 'task-001',
      role: 'asr',
      model_snapshot_ref: 'snapshot-001',
      occurred_at: '2026-08-05T08:02:02.000+08:00',
      provider_outcome_certainty: 'not_dispatched',
      errors: [{
        error_id: 'error-asr-pre-artifact',
        code: 'ASR_ARTIFACT_INVALID',
        message: 'The adapter could not form a legal transcript artifact.',
        stage: 'artifact_write',
        retryable: false
      }],
      warnings: [],
      call: null,
      staging: []
      }]
    };

    const result = validateContractGraph(graph);
    expect(result.valid, result.valid ? '' : JSON.stringify(result.issues)).toBe(true);
  });

  it('keeps the frozen v1 AdapterFailureRecord valid without Alpha.1 certainty metadata', async () => {
    const complete = await completeGraph();
    const historicalFailure: any = {
      failure_id: 'failure-asr-historical',
      task_id: 'task-001',
      role: 'asr',
      model_snapshot_ref: 'snapshot-001',
      occurred_at: '2026-08-05T08:02:02.000+08:00',
      errors: [{
        error_id: 'error-asr-historical',
        code: 'MODEL_CALL_FAILED',
        message: 'historical fixture failure',
        stage: 'model_call',
        retryable: false,
      }],
      warnings: [],
      call: {
        call_id: 'call-asr-historical',
        model_snapshot_entry_ref: 'snapshot-entry-asr',
        started_at: '2026-08-05T08:02:00.000+08:00',
        ended_at: '2026-08-05T08:02:01.000+08:00',
        outcome: 'failed',
        error_ref: 'error-asr-historical',
      },
      staging: [],
    };
    const result = validateContractGraph({ modelSnapshot: complete.modelSnapshot!, adapterFailures: [historicalFailure] });
    expect(result.valid, result.valid ? '' : JSON.stringify(result.issues)).toBe(true);
  });
});
