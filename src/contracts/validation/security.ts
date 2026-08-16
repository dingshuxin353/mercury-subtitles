import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import commonSchema from '../../../schemas/v1/common.schema.json' with { type: 'json' };
import type { ValidationIssue } from './types.js';

type JsonRecord = Record<string, unknown>;

const sensitiveFieldPattern =
  /(?:^|_)(?:api_keys?|access_tokens?|refresh_tokens?|auth_tokens?|client_secrets?|tokens?|authorizations?|passwords?|secrets?|credentials?|private_keys?|credit_(?:codes?|vouchers?))(?:_|$)/;
const signatureQueryFieldPattern =
  /^(?:keys?|signatures?|sigs?|x_amz_(?:signatures?|credentials?)|x_goog_(?:signatures?|credentials?))$/;
const urlCandidatePattern =
  /\b(?:https?|gs):\/\/(?:[A-Za-z0-9]|\[[0-9A-Fa-f:]+\])[^\s"'<>`]*/gi;
const sensitiveValuePatterns = [
  /-----BEGIN (?:[A-Z0-9]+(?: [A-Z0-9]+)* )?PRIVATE KEY(?: BLOCK)?-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/i,
  /\bcredit[-_ ]?(?:code|voucher)\s*[:=]\s*[A-Za-z0-9_-]{8,}\b/i
];

function credentialReferenceValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, validateFormats: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-mercury-invariant-id', schemaType: 'string', valid: true });
  ajv.addSchema(commonSchema);
  const validator = ajv.getSchema(`${commonSchema.$id}#/$defs/CredentialRef`);
  if (!validator) throw new Error('CredentialRef definition is unavailable');
  return validator;
}

const validateCredentialReference = credentialReferenceValidator();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizeFieldName(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function isSensitiveFieldName(value: string): boolean {
  return value !== 'credential_ref' && matchesSensitiveFieldName(value);
}

function matchesSensitiveFieldName(value: string): boolean {
  return sensitiveFieldPattern.test(normalizeFieldName(value));
}

export function isAllowedCredentialReference(value: unknown): value is string {
  return typeof value === 'string' && validateCredentialReference(value);
}

function containsSensitiveValue(value: string): boolean {
  return sensitiveValuePatterns.some((pattern) => pattern.test(value));
}

function unsafeUrlReason(value: string): string | null {
  if (!/^https?:\/\//i.test(value)) {
    return /^gs:\/\//i.test(value) && /[?#]/.test(value)
      ? 'GCS object URI must not contain query parameters or fragments'
      : null;
  }

  try {
    const url = new URL(value);
    if (url.username || url.password) return 'URL must not contain user information';
    for (const key of url.searchParams.keys()) {
      if (
        matchesSensitiveFieldName(key) ||
        signatureQueryFieldPattern.test(normalizeFieldName(key))
      ) {
        return 'URL must not contain credential or signature query parameters';
      }
    }
  } catch {
    return null;
  }
  return null;
}

function valueIssues(value: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (containsSensitiveValue(value)) {
    issues.push({
      invariant_id: 'INV-SEC-001',
      path,
      message: 'persisted contract value must not contain credential material'
    });
  }
  const directUrlReason = unsafeUrlReason(value);
  const embeddedUrlReason = directUrlReason
    ? null
    : [...value.matchAll(urlCandidatePattern)]
        .map(([candidate]) => unsafeUrlReason(candidate))
        .find((reason): reason is string => reason !== null) ?? null;
  const urlReason = directUrlReason ?? embeddedUrlReason;
  if (urlReason) issues.push({ invariant_id: 'INV-SEC-001', path, message: urlReason });
  return issues;
}

function maskAllowedCredentialReferences(value: string): string {
  return value.replace(
    /(?:(?:(["'`])credential_ref\1)|\bcredential_ref\b)\s*[:=]\s*(?:(["'`])([^"'`\r\n]+)\2|([^\s,}\];]+))/g,
    (
      match,
      _keyQuote: string | undefined,
      _valueQuote: string | undefined,
      quotedReference: string | undefined,
      bareReference: string | undefined
    ) => {
      const reference = quotedReference ?? bareReference;
      if (!isAllowedCredentialReference(reference)) return match;
      const referenceIndex = match.lastIndexOf(reference);
      return `${match.slice(0, referenceIndex)}<allowed-credential-reference>${match.slice(
        referenceIndex + reference.length
      )}`;
    }
  );
}

export function sensitiveTextIssues(value: string, path = '/'): ValidationIssue[] {
  return valueIssues(maskAllowedCredentialReferences(value), path);
}

export interface SecurityInspectionOptions {
  inspectFieldNames?: boolean;
}

export function sensitiveInformationIssues(
  value: unknown,
  options: SecurityInspectionOptions = {}
): ValidationIssue[] {
  const inspectFieldNames = options.inspectFieldNames ?? true;
  const issues: ValidationIssue[] = [];

  function visit(current: unknown, path: string): void {
    if (typeof current === 'string') {
      issues.push(...valueIssues(current, path || '/'));
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    if (!isRecord(current)) return;

    for (const [key, child] of Object.entries(current)) {
      const childPath = `${path}/${escapePointerSegment(key)}`;
      if (key === 'credential_ref') {
        if (child === null || isAllowedCredentialReference(child)) continue;
        if (inspectFieldNames) {
          issues.push({
            invariant_id: 'INV-SEC-001',
            path: childPath,
            message: 'credential_ref must use an approved reference form'
          });
        }
        visit(child, childPath);
        continue;
      }
      if (inspectFieldNames && isSensitiveFieldName(key)) {
        issues.push({
          invariant_id: 'INV-SEC-001',
          path: childPath,
          message: 'persisted contract must not contain credential fields'
        });
      }
      visit(child, childPath);
    }
  }

  visit(value, '');
  return issues;
}
