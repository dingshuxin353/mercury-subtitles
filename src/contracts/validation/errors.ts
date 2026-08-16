import type { ValidationIssue } from './types.js';

export class ContractValidationError extends Error {
  readonly code = 'CONTRACT_VALIDATION_FAILED' as const;

  constructor(readonly issues: ValidationIssue[]) {
    super(
      issues.length === 0
        ? 'Contract validation failed.'
        : `Contract validation failed: ${issues
            .map((entry) => `${entry.path}: ${entry.message}`)
            .join('; ')}`
    );
    this.name = 'ContractValidationError';
  }
}

export class ContractRegistryError extends Error {
  readonly code = 'CONTRACT_REGISTRY_INVALID' as const;

  constructor(readonly issues: ValidationIssue[]) {
    super(
      issues.length === 0
        ? 'Contract registry is invalid.'
        : `Contract registry is invalid: ${issues
            .map((entry) => `${entry.path}: ${entry.message}`)
            .join('; ')}`
    );
    this.name = 'ContractRegistryError';
  }
}
