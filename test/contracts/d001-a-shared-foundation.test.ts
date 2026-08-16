import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import commonSchema from '../../schemas/v1/common.schema.json' with { type: 'json' };
import {
  assertContract,
  ContractRegistryError,
  ContractValidationError,
  SUPPORTED_SCHEMA_VERSION,
  validateAllSchemas,
  validateContract
} from '../../src/contracts/index.js';
import {
  isAllowedCredentialReference,
  isSensitiveFieldName,
  sensitiveInformationIssues,
  sensitiveTextIssues
} from '../../src/contracts/validation/security.js';
import {
  computeModelConfigFingerprint,
  semanticKeywordDefinition
} from '../../src/contracts/validation/semantic.js';
import { fakeSecrets } from '../fixtures/security/fake-secrets.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(testDirectory, '..', 'fixtures', 'valid');
const forbiddenInvisibleCharacters = [
  ['C0 tab', '\u0009'],
  ['C1 next-line', '\u0085'],
  ['zero-width space', '\u200B'],
  ['right-to-left override', '\u202E'],
  ['left-to-right isolate', '\u2066'],
  ['byte-order mark', '\uFEFF'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029']
] as const;

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

async function validFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

function credentialUrl(field: string): string {
  return ['https://example.invalid/object?', field, '=fixture-value'].join('');
}

function privateKeyMaterial(format: string): string {
  return ['-----BEGIN ', format, '-----', '\nfixture-only'].join('');
}

describe('D001-A protocol version and shared primitives', () => {
  it('accepts only protocol version 1.0.0', () => {
    const validate = commonValidator('SchemaVersion');
    expect(SUPPORTED_SCHEMA_VERSION).toBe('1.0.0');
    expect(validate('1.0.0')).toBe(true);
    expect(validate('1.0.1')).toBe(false);
    expect(validate('2.0.0')).toBe(false);
  });

  it('requires trimmed non-blank text without control characters', () => {
    const validate = commonValidator('NonBlankString');
    expect(validate('水星 Mercury')).toBe(true);
    for (const invalid of ['', ' ', ' leading', 'trailing ', '\ttab', 'line\nbreak', 'nul\0']) {
      expect(validate(invalid), JSON.stringify(invalid)).toBe(false);
    }
    for (const [label, character] of forbiddenInvisibleCharacters) {
      expect(validate(`Mercury${character}text`), label).toBe(false);
    }
  });

  it('requires timezone-aware timestamps with millisecond precision', () => {
    const validate = commonValidator('Timestamp');
    expect(validate('2026-08-05T12:00:00.000Z')).toBe(true);
    expect(validate('2026-08-05T20:00:00.123+08:00')).toBe(true);
    for (const invalid of [
      '2026-08-05T12:00:00Z',
      '2026-08-05T12:00:00.000',
      '2026-08-05T12:00:00.000000Z'
    ]) {
      expect(validate(invalid), invalid).toBe(false);
    }
  });

  it('validates millisecond integers, protocol IDs, hashes, task paths, and GCS URIs', () => {
    const nonNegativeMs = commonValidator('NonNegativeMilliseconds');
    const positiveMs = commonValidator('PositiveMilliseconds');
    const protocolId = commonValidator('ProtocolId');
    const sha256 = commonValidator('Sha256');
    const taskPath = commonValidator('TaskRelativePath');
    const gcsUri = commonValidator('GcsObjectUri');

    expect(nonNegativeMs(0)).toBe(true);
    expect(nonNegativeMs(-1)).toBe(false);
    expect(nonNegativeMs(1.5)).toBe(false);
    expect(positiveMs(1)).toBe(true);
    expect(positiveMs(0)).toBe(false);

    expect(protocolId('task:2026-08-05_01')).toBe(true);
    expect(protocolId('-invalid')).toBe(false);
    expect(protocolId(`a${'b'.repeat(128)}`)).toBe(false);
    expect(sha256('a'.repeat(64))).toBe(true);
    expect(sha256('A'.repeat(64))).toBe(false);

    expect(taskPath('work/transcript.raw.json')).toBe(true);
    expect(taskPath('/absolute/path')).toBe(false);
    expect(taskPath('../outside')).toBe(false);
    expect(taskPath('work/../outside')).toBe(false);
    expect(taskPath('work\\windows-path.json')).toBe(false);
    expect(gcsUri('gs://private-bucket/tasks/object.mp3')).toBe(true);
    expect(gcsUri(fakeSecrets.gcsSignedUri)).toBe(false);
    expect(gcsUri('gs://private-bucket/windows\\object.mp3')).toBe(false);
    for (const [label, character] of forbiddenInvisibleCharacters) {
      expect(taskPath(`work/Mercury${character}text.json`), `path: ${label}`).toBe(false);
      expect(gcsUri(`gs://private-bucket/Mercury${character}text`), `GCS: ${label}`).toBe(false);
    }
  });
});

describe('D001-A errors and warnings', () => {
  it('accepts the complete closed ErrorRecord shape', () => {
    const validate = commonValidator('ErrorRecord');
    const valid = {
      error_id: 'error-001',
      code: 'MODEL_CALL_FAILED',
      message: 'The model call failed.',
      stage: 'model_call',
      retryable: true,
      resource_uri: 'gs://private-bucket/task/object.mp3',
      remediation: 'Delete the object after checking access.'
    };
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, error_id: undefined })).toBe(false);
    expect(validate({ ...valid, stage: 'provider_specific_stage' })).toBe(false);
    expect(validate({ ...valid, provider_response: {} })).toBe(false);
  });

  it('accepts the complete closed WarningRecord shape without remediation', () => {
    const validate = commonValidator('WarningRecord');
    const valid = {
      warning_id: 'warning-001',
      code: 'CLEANUP_REQUIRES_ATTENTION',
      message: 'Review the related cleanup error.',
      stage: 'gcs_cleanup',
      severity: 'high',
      related_error_ref: 'error-001',
      related_staging_ref: 'staging-001'
    };
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, warning_id: undefined })).toBe(false);
    expect(validate({ ...valid, severity: 'critical' })).toBe(false);
    expect(validate({ ...valid, remediation: 'duplicated instruction' })).toBe(false);
  });
});

describe('D001-A public validation boundary', () => {
  it('loads every currently registered schema without provider access', () => {
    expect(validateAllSchemas()).toBeUndefined();
  });

  it('returns the exact success and failure result shapes', async () => {
    const valid = await validFixture('model-config.json');
    expect(validateContract('model-config', valid)).toEqual({ valid: true, value: valid, issues: [] });

    const invalid = structuredClone(valid);
    invalid.schema_version = '2.0.0';
    const result = validateContract('model-config', invalid);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.value).toBeNull();
      expect(result.issues).not.toHaveLength(0);
      expect(result.issues).toEqual(
        [...result.issues].sort(
          (left, right) =>
            (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
            (left.invariant_id < right.invariant_id
              ? -1
              : left.invariant_id > right.invariant_id
                ? 1
                : 0) ||
            (left.message < right.message ? -1 : left.message > right.message ? 1 : 0)
        )
      );
      expect(result.issues.some((issue) => issue.invariant_id === 'INV-GEN-001')).toBe(true);
    }
  });

  it('narrows successful values and throws the fixed validation error contract', async () => {
    const valid = await validFixture('model-config.json');
    expect(assertContract('model-config', valid)).toBe(valid);

    const invalid = structuredClone(valid);
    delete invalid.schema_version;
    const result = validateContract('model-config', invalid);
    expect(result.valid).toBe(false);
    try {
      assertContract('model-config', invalid);
      throw new Error('expected ContractValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect(error).toMatchObject({
        name: 'ContractValidationError',
        code: 'CONTRACT_VALIDATION_FAILED',
        issues: result.issues
      });
    }
  });

  it('derives structural and semantic invariant IDs from registered Schema declarations', async () => {
    const cases: Array<[string, (value: any) => void, string, string]> = [
      ['missing schema version', (value) => delete value.schema_version, '/schema_version', 'INV-GEN-001'],
      ['non-blank model', (value) => (value.models[0].model = ' trailing '), '/models/0/model', 'INV-GEN-002'],
      [
        'timestamp precision',
        (value) => (value.models[0].last_check.started_at = '2026-08-05T12:00:00Z'),
        '/models/0/last_check/started_at',
        'INV-GEN-003'
      ],
      [
        'duplicate config ID',
        (value) => (value.models[1].config_id = value.models[0].config_id),
        '/models/1/config_id',
        'INV-GEN-004'
      ],
      ['closed object', (value) => (value.unknown_field = true), '/unknown_field', 'INV-GEN-005'],
      [
        'default role mismatch',
        (value) => (value.defaults.calibration = value.models[0].config_id),
        '/defaults/calibration',
        'INV-MOD-001'
      ],
      [
        'sensitive provider field',
        (value) => (value.models[0].provider_config = { credentials: 'fixture' }),
        '/models/0/provider_config/credentials',
        'INV-SEC-001'
      ]
    ];

    for (const [label, mutate, path, invariantId] of cases) {
      const value = await validFixture('model-config.json');
      mutate(value);
      const result = validateContract('model-config', value);
      expect(result.valid, label).toBe(false);
      if (!result.valid) {
        const pathIssues = result.issues.filter((issue) => issue.path === path);
        expect(pathIssues.some((issue) => issue.invariant_id === invariantId), label).toBe(true);
        expect(pathIssues.some((issue) => issue.invariant_id === 'INV-API-001'), label).toBe(false);
      }
    }
  });

  it('keeps ErrorRecord and WarningRecord failures on their shared invariant', async () => {
    const failed = await validFixture('audio-verification.failed.json') as any;
    failed.errors[0].stage = 'provider_specific_stage';
    const errorResult = validateContract('audio-verification', failed);
    expect(errorResult.valid).toBe(false);
    if (!errorResult.valid) {
      const issues = errorResult.issues.filter((issue) => issue.path === '/errors/0/stage');
      expect(issues.some((issue) => issue.invariant_id === 'INV-GEN-006')).toBe(true);
      expect(issues.some((issue) => issue.invariant_id === 'INV-API-001')).toBe(false);
    }

    const withWarning = await validFixture('audio-verification.failed.json') as any;
    withWarning.warnings.push({
      warning_id: 'invalid-warning',
      code: 'INVALID_WARNING',
      message: 'fixture warning',
      stage: 'execution',
      severity: 'critical'
    });
    const warningResult = validateContract('audio-verification', withWarning);
    expect(warningResult.valid).toBe(false);
    if (!warningResult.valid) {
      const issues = warningResult.issues.filter((issue) => issue.path === '/warnings/0/severity');
      expect(issues.some((issue) => issue.invariant_id === 'INV-GEN-006')).toBe(true);
      expect(issues.some((issue) => issue.invariant_id === 'INV-API-001')).toBe(false);
    }
  });

  it('rejects unknown runtime contract names with the fixed registry error contract', () => {
    expect(() => validateContract('unknown' as never, {})).toThrowError(ContractRegistryError);
    try {
      validateContract('unknown' as never, {});
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ContractRegistryError',
        code: 'CONTRACT_REGISTRY_INVALID'
      });
    }
  });
});

describe('D001-A shared definition consumer audit', () => {
  it('applies NonBlankString through every existing top-level consumer', async () => {
    const cases: Array<
      [Parameters<typeof validateContract>[0], string, (value: any, text: string) => void]
    > = [
      ['model-config', 'model-config.json', (value, text) => (value.models[0].model = text)],
      ['model-snapshot', 'model-snapshot.json', (value, text) => (value.models.asr.model = text)],
      ['transcript.raw', 'transcript.raw.json', (value, text) => (value.full_text = text)],
      [
        'calibration-result',
        'calibration-result.json',
        (value, text) => (value.suggestions[0].rationale = text)
      ],
      [
        'audio-verification',
        'audio-verification.completed.json',
        (value, text) => (value.findings[0].rationale = text)
      ]
    ];

    for (const [contract, name, mutate] of cases) {
      for (const [label, character] of forbiddenInvisibleCharacters) {
        const value = await validFixture(name);
        mutate(value, `Mercury${character}text`);
        const result = validateContract(contract, value);
        expect(result.valid, `${contract}: ${label}`).toBe(false);
        if (!result.valid) {
          expect(result.issues.some((issue) => issue.invariant_id === 'INV-GEN-002')).toBe(true);
        }
      }
    }
  });

  it('applies the millisecond timestamp primitive through every timestamp consumer', async () => {
    const cases: Array<[Parameters<typeof validateContract>[0], string, (value: any) => void]> = [
      [
        'model-config',
        'model-config.json',
        (value) => (value.models[0].last_check.started_at = '2026-08-05T12:00:00Z')
      ],
      [
        'model-snapshot',
        'model-snapshot.json',
        (value) => (value.captured_at = '2026-08-05T12:00:00Z')
      ],
      [
        'transcript.raw',
        'transcript.raw.json',
        (value) => (value.call.started_at = '2026-08-05T12:00:00Z')
      ],
      [
        'calibration-result',
        'calibration-result.json',
        (value) => (value.call.started_at = '2026-08-05T12:00:00Z')
      ],
      [
        'audio-verification',
        'audio-verification.completed.json',
        (value) => (value.calls[0].started_at = '2026-08-05T12:00:00Z')
      ]
    ];

    for (const [contract, name, mutate] of cases) {
      const value = await validFixture(name);
      mutate(value);
      const result = validateContract(contract, value);
      expect(result.valid, contract).toBe(false);
      if (!result.valid) {
        expect(result.issues.some((issue) => issue.invariant_id === 'INV-GEN-003')).toBe(true);
      }
    }
  });
});

describe('D001-A sensitive information boundary', () => {
  it('accepts only approved credential reference forms', () => {
    const validate = commonValidator('CredentialRef');
    const approvedReferences = [
      'env:MERCURY_API_TOKEN',
      `keychain:${fakeSecrets.apiToken}`,
      `adc:${fakeSecrets.apiToken}`,
      `file:/controlled/${fakeSecrets.apiToken}.json`
    ];
    for (const valid of approvedReferences) {
      expect(validate(valid), valid).toBe(true);
      expect(isAllowedCredentialReference(valid), valid).toBe(true);
      expect(sensitiveInformationIssues({ credential_ref: valid }), valid).toEqual([]);
    }
    for (const invalid of [
      'plain-secret',
      'env:lowercase',
      'file:relative.json',
      'file:/controlled/../outside.json',
      ...forbiddenInvisibleCharacters.map(
        ([, character]) => `keychain:mercury${character}credential`
      )
    ]) {
      expect(validate(invalid), invalid).toBe(false);
      expect(isAllowedCredentialReference(invalid), invalid).toBe(false);
      expect(sensitiveInformationIssues({ credential_ref: invalid }), invalid).not.toEqual([]);
    }
  });

  it('accepts secret-shaped names only when they are valid credential references', async () => {
    for (const reference of [
      `keychain:${fakeSecrets.apiToken}`,
      `adc:${fakeSecrets.apiToken}`,
      `file:/controlled/${fakeSecrets.apiToken}.json`
    ]) {
      const config = await validFixture('model-config.json') as any;
      config.models[0].credential_ref = reference;
      config.models[0].config_fingerprint = computeModelConfigFingerprint(config.models[0]);
      config.models[0].last_check = null;
      expect(validateContract('model-config', config), reference).toEqual({
        valid: true,
        value: config,
        issues: []
      });
    }

    const config = await validFixture('model-config.json') as any;
    config.models[0].credential_ref = fakeSecrets.apiToken;
    const result = validateContract('model-config', config);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path === '/models/0/credential_ref' && issue.invariant_id === 'INV-SEC-001'
        )
      ).toBe(true);
    }
  });

  it('keeps raw-file scanning context-aware for valid credential references', () => {
    const reference = `keychain:${fakeSecrets.apiToken}`;
    for (const context of [
      `credential_ref: "${reference}"`,
      `credential_ref: ${reference}`,
      `"credential_ref": "${reference}"`,
      `'credential_ref': '${reference}'`,
      `credential_ref: \`${reference}\``
    ]) {
      expect(sensitiveTextIssues(context), context).toEqual([]);
    }
    for (const context of [
      `opaque_value: "${fakeSecrets.apiToken}"`,
      `"opaque_value": "${fakeSecrets.apiToken}"`,
      `opaque_value: \`${fakeSecrets.apiToken}\``
    ]) {
      expect(sensitiveTextIssues(context), context).not.toEqual([]);
    }
  });

  it('rejects credential and signature query fields through one normalized rule', async () => {
    const sensitiveQueryFields = [
      'api_key',
      'apiKey',
      'authorization',
      'auth_token',
      'refresh_token',
      'client_secret',
      'credential_ref',
      'signature',
      'X-Goog-Credential'
    ];

    for (const field of sensitiveQueryFields) {
      const url = credentialUrl(field);
      expect(sensitiveInformationIssues({ resource_uri: url }), field).not.toEqual([]);
      expect(sensitiveTextIssues(`resource_uri: "${url}"`), field).not.toEqual([]);

      const artifact = await validFixture('audio-verification.failed.json') as any;
      artifact.errors[0].resource_uri = url;
      const result = validateContract('audio-verification', artifact);
      expect(result.valid, field).toBe(false);
      if (!result.valid) {
        expect(
          result.issues.some(
            (issue) =>
              issue.path === '/errors/0/resource_uri' &&
              issue.invariant_id === 'INV-SEC-001'
          ),
          field
        ).toBe(true);
      }
    }

    const ordinaryUrl = credentialUrl('page');
    expect(sensitiveInformationIssues({ resource_uri: ordinaryUrl })).toEqual([]);
    expect(sensitiveTextIssues(`resource_uri: "${ordinaryUrl}"`)).toEqual([]);
    expect(sensitiveTextIssues('pattern: ^gs://[^/?#\\s]+/[^?#\\s]+$')).toEqual([]);
  });

  it('rejects common unencrypted, encrypted, vendor, and PGP private-key headers', async () => {
    const privateKeyFormats = [
      'PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'DSA PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'PGP PRIVATE KEY BLOCK'
    ];

    for (const format of privateKeyFormats) {
      const material = privateKeyMaterial(format);
      expect(sensitiveInformationIssues({ material }), format).not.toEqual([]);
      expect(sensitiveTextIssues(material), format).not.toEqual([]);

      const config = await validFixture('model-config.json') as any;
      config.models[0].provider_config = { material };
      const result = validateContract('model-config', config);
      expect(result.valid, format).toBe(false);
      if (!result.valid) {
        expect(
          result.issues.some((issue) => issue.invariant_id === 'INV-SEC-001'),
          format
        ).toBe(true);
      }
    }

    expect(sensitiveInformationIssues({ material: 'public certificate metadata' })).toEqual([]);
  });

  it('normalizes singular, plural, snake-case, camelCase, and acronym sensitive fields', async () => {
    const sensitiveFields = [
      'secret',
      'secrets',
      'credentials',
      'tokens',
      'api_key',
      'apiKeys',
      'APIKeys',
      'clientSecrets',
      'accessTokens',
      'passwords',
      'privateKeys',
      'authorizationHeaders',
      'creditCodes',
      'credentialRef'
    ];

    for (const field of sensitiveFields) {
      expect(isSensitiveFieldName(field), field).toBe(true);
      const issues = sensitiveInformationIssues({ provider_config: { [field]: 'fixture' } });
      expect(issues.some((issue) => issue.path.endsWith(`/${field}`)), field).toBe(true);

      const config = await validFixture('model-config.json') as any;
      config.models[0].provider_config = { [field]: 'fixture' };
      const result = validateContract('model-config', config);
      expect(result.valid, field).toBe(false);
      if (!result.valid) {
        expect(result.issues.some((issue) => issue.invariant_id === 'INV-SEC-001'), field).toBe(true);
      }
    }
    expect(isSensitiveFieldName('credential_ref')).toBe(false);
    expect(isSensitiveFieldName('token_count')).toBe(true);
    expect(isSensitiveFieldName('project')).toBe(false);
  });

  it('finds fake secrets in nested keys, values, headers, private keys, and URLs', () => {
    const value = {
      provider_config: {
        nested: { clientSecret: 'fixture' },
        values: [
          fakeSecrets.apiToken,
          fakeSecrets.authorization,
          fakeSecrets.privateKey,
          fakeSecrets.creditCode
        ],
        resource: fakeSecrets.signedUrl
      }
    };
    const issues = sensitiveInformationIssues(value);
    expect(issues).not.toHaveLength(0);
    expect(issues.every((issue) => issue.invariant_id === 'INV-SEC-001')).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith('/clientSecret'))).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith('/resource'))).toBe(true);
  });

  it('does not mistake credential references or ordinary non-sensitive metadata for secrets', () => {
    expect(
      sensitiveInformationIssues({
        credential_ref: 'env:MERCURY_API_TOKEN',
        provider_config: { project: 'mercury-fixture', location: 'asia-east1' }
      })
    ).toEqual([]);
  });
});
