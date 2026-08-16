import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import commonSchema from '../../schemas/v1/common.schema.json' with { type: 'json' };
import calibrationResultV2Schema from '../../schemas/v2/calibration-result.schema.json' with { type: 'json' };
import calibrationResultV3Schema from '../../schemas/v3/calibration-result.schema.json' with { type: 'json' };
import type { CalibrationResultV3 } from './generated/calibration-result-v3.js';

export type V3ValidationResult =
  | { valid: true; value: CalibrationResultV3; issues: [] }
  | { valid: false; value: null; issues: Array<{ path: string; message: string }> };

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addKeyword({
  keyword: 'x-mercury-invariant-id',
  schemaType: 'string',
  valid: true,
});
ajv.addKeyword({
  keyword: 'x-mercury-semantic-checks',
  schemaType: 'array',
  valid: true,
});
ajv.addSchema(commonSchema);
ajv.addSchema(calibrationResultV2Schema);
ajv.addSchema(calibrationResultV3Schema);

function semanticIssues(value: CalibrationResultV3): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const ids = value.corrected_units.map((unit) => unit.unit_id);
  if (new Set(ids).size !== ids.length) {
    issues.push({ path: '/corrected_units', message: '校验单元 ID 必须唯一' });
  }
  value.corrected_units.forEach((unit, index) => {
    if (unit.end_ms <= unit.start_ms) {
      issues.push({ path: `/corrected_units/${index}`, message: '校验单元时间范围必须为正' });
    }
    if (unit.changed !== (unit.original_text !== unit.corrected_text)) {
      issues.push({ path: `/corrected_units/${index}/changed`, message: 'changed 必须与正文差异一致' });
    }
    if (unit.asr_segment_refs.length === 0 && unit.reference_segment_refs.length === 0) {
      issues.push({ path: `/corrected_units/${index}`, message: '校验单元必须保留 ASR 或参考字幕来源' });
    }
  });
  if (value.status === 'completed') {
    if (
      value.strategy.input_unit_count !== value.corrected_units.length ||
      value.strategy.returned_unit_count !== value.corrected_units.length
    ) {
      issues.push({ path: '/strategy', message: '完成结果的输入、返回与持久化单元数必须一致' });
    }
    const changed = value.corrected_units.filter((unit) => unit.changed).length;
    if (value.suggestions.length !== changed) {
      issues.push({ path: '/suggestions', message: 'suggestions 必须完全由发生变化的校验单元派生' });
    }
  }
  return issues;
}

export function validateV3CalibrationResult(value: unknown): V3ValidationResult {
  const validator = ajv.getSchema(calibrationResultV3Schema.$id)!;
  if (!validator(value)) {
    return {
      valid: false,
      value: null,
      issues: (validator.errors ?? []).map((error: ErrorObject) => ({
        path: error.instancePath || '/',
        message: error.message ?? error.keyword,
      })),
    };
  }
  const cloned = structuredClone(value) as CalibrationResultV3;
  const issues = semanticIssues(cloned);
  return issues.length === 0
    ? { valid: true, value: cloned, issues: [] }
    : { valid: false, value: null, issues };
}

export function assertV3CalibrationResult(value: unknown): CalibrationResultV3 {
  const result = validateV3CalibrationResult(value);
  if (!result.valid) {
    throw new Error(
      `calibration-result v3 invalid: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    );
  }
  return result.value;
}
