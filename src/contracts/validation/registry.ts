import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import commonSchema from '../../../schemas/v1/common.schema.json' with { type: 'json' };
import {
  assertSemanticCheckCoverage,
  semanticKeywordDefinition
} from './semantic.js';
import type { ContractName, ValidationIssue } from './types.js';

export const SUPPORTED_SCHEMA_VERSION = '1.0.0' as const;

const contractNames = [
  'model-config',
  'model-snapshot',
  'transcript.raw',
  'calibration-result',
  'audio-verification'
] as const satisfies readonly ContractName[];

interface ContractSchema {
  $id: string;
  [key: string]: unknown;
}

function loadContractSchema(filename: string): ContractSchema {
  const require = createRequire(import.meta.url);
  const candidates = [
    new URL(`../../../schemas/v1/${filename}`, import.meta.url),
    new URL(`../../../../schemas/v1/${filename}`, import.meta.url)
  ];
  const schemaUrl = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (!schemaUrl) throw new Error(`Contract Schema is unavailable: ${filename}`);
  return require(fileURLToPath(schemaUrl)) as ContractSchema;
}

function loadCandidateContractSchemas(): Record<ContractName, ContractSchema> {
  return {
    'model-config': loadContractSchema('model-config.schema.json'),
    'model-snapshot': loadContractSchema('model-snapshot.schema.json'),
    'transcript.raw': loadContractSchema('transcript.raw.schema.json'),
    'calibration-result': loadContractSchema('calibration-result.schema.json'),
    'audio-verification': loadContractSchema('audio-verification.schema.json')
  };
}

const contractSchemas = loadCandidateContractSchemas();

export const registeredSchemas = [commonSchema, ...Object.values(contractSchemas)] as const;

export interface ContractRegistry {
  validators: Record<ContractName, ValidateFunction>;
  sharedValidators: {
    adapterFailure: ValidateFunction;
    protocolId: ValidateFunction;
    taskRelativePath: ValidateFunction;
  };
  schemas: Record<ContractName, ContractSchema>;
  schemaDocuments: ReadonlyMap<string, ContractSchema>;
}

function annotationKeyword(keyword: string, schemaType: 'string' | 'array') {
  return { keyword, schemaType, valid: true } as const;
}

export function registryContractNames(): ContractName[] {
  return [...contractNames];
}

function createAjv(withSemanticChecks: boolean): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    validateFormats: true,
    verbose: true
  });

  addFormats(ajv);
  ajv.addKeyword(annotationKeyword('x-mercury-invariant-id', 'string'));
  if (withSemanticChecks) ajv.addKeyword(semanticKeywordDefinition());
  return ajv;
}

export function validateRegisteredSchemas(): void {
  if (commonSchema.$defs.SchemaVersion.const !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error('SchemaVersion and SUPPORTED_SCHEMA_VERSION must match');
  }
  const ajv = createAjv(false);
  for (const schema of registeredSchemas) {
    if (!ajv.validateSchema(schema)) {
      throw new Error(`Invalid JSON Schema: ${ajv.errorsText(ajv.errors)}`);
    }
    ajv.addSchema(schema);
  }
}

export function createContractRegistry(): ContractRegistry {
  const schemas = [commonSchema, ...Object.values(contractSchemas)];
  const ajv = createAjv(true);
  assertSemanticCheckCoverage(schemas);

  for (const schema of schemas) {
    if (!ajv.validateSchema(schema)) {
      throw new Error(`Invalid JSON Schema: ${ajv.errorsText(ajv.errors)}`);
    }
    ajv.addSchema(schema);
  }

  const schemaDocuments = new Map<string, ContractSchema>();
  for (const schema of schemas) {
    schemaDocuments.set(schema.$id, schema);
    schemaDocuments.set(new URL(schema.$id).pathname.split('/').at(-1)!, schema);
  }

  return {
    validators: Object.fromEntries(
      Object.entries(contractSchemas).map(([name, schema]) => [name, ajv.getSchema(schema.$id)!])
    ) as Record<ContractName, ValidateFunction>,
    sharedValidators: {
      adapterFailure: ajv.getSchema(`${commonSchema.$id}#/$defs/AdapterFailureRecord`)!,
      protocolId: ajv.getSchema(`${commonSchema.$id}#/$defs/ProtocolId`)!,
      taskRelativePath: ajv.getSchema(`${commonSchema.$id}#/$defs/TaskRelativePath`)!
    },
    schemas: contractSchemas,
    schemaDocuments
  };
}

function documentForReference(
  registry: ContractRegistry,
  reference: string,
  currentDocument: ContractSchema
): ContractSchema | undefined {
  if (!reference) return currentDocument;
  if (reference === currentDocument.$id) return currentDocument;
  return (
    registry.schemaDocuments.get(reference) ??
    registry.schemaDocuments.get(reference.split('/').at(-1)!)
  );
}

function invariantFromNode(
  registry: ContractRegistry,
  node: unknown,
  currentDocument: ContractSchema,
  visited = new Set<string>()
): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const ownInvariant = record['x-mercury-invariant-id'];
  if (typeof ownInvariant === 'string') return ownInvariant;

  const reference = record.$ref;
  if (typeof reference === 'string') {
    const [documentReference = '', pointer = ''] = reference.split('#', 2);
    const document = documentForReference(registry, documentReference, currentDocument);
    if (document) {
      const visitKey = `${document.$id}#${pointer}`;
      if (!visited.has(visitKey)) {
        visited.add(visitKey);
        const resolved = invariantFromNode(
          registry,
          pointer
            .replace(/^\//, '')
            .split('/')
            .filter(Boolean)
            .map((segment) =>
              decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~')
            )
            .reduce<unknown>((current, segment) => {
              if (typeof current !== 'object' || current === null) return undefined;
              return (current as Record<string, unknown>)[segment];
            }, document),
          document,
          visited
        );
        if (resolved) return resolved;
      }
    }
  }

  const nestedInvariants = ['allOf', 'anyOf', 'oneOf']
    .flatMap((keyword) => (Array.isArray(record[keyword]) ? record[keyword] : []))
    .map((entry) => invariantFromNode(registry, entry, currentDocument, new Set(visited)))
    .filter((entry): entry is string => typeof entry === 'string');
  return new Set(nestedInvariants).size === 1 ? nestedInvariants[0] : undefined;
}

function nodeAtJsonPointer(document: ContractSchema, pointer: string): unknown {
  return pointer
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, segment) => {
      if (typeof current !== 'object' || current === null) return undefined;
      return (current as Record<string, unknown>)[segment];
    }, document);
}

function invariantFromSchemaPath(
  registry: ContractRegistry,
  document: ContractSchema,
  schemaPath: string
): string | undefined {
  const segments = schemaPath.replace(/^#\/?/, '').split('/').filter(Boolean);
  while (segments.length > 0) {
    const invariant = invariantFromNode(
      registry,
      nodeAtJsonPointer(document, `#/${segments.join('/')}`),
      document
    );
    if (invariant) return invariant;
    segments.pop();
  }
  return undefined;
}

export function schemaErrorInvariantId(
  registry: ContractRegistry,
  contract: ContractName,
  error: ErrorObject
): string | undefined {
  return schemaErrorInvariantIdInDocument(registry, registry.schemas[contract], error);
}

function schemaErrorInvariantIdInDocument(
  registry: ContractRegistry,
  document: ContractSchema,
  error: ErrorObject
): string | undefined {
  const container = (error as ErrorObject & { parentSchema?: unknown }).parentSchema;
  if (error.keyword === 'required' && typeof container === 'object' && container !== null) {
    const missingProperty = (error.params as Record<string, unknown>).missingProperty;
    const properties = (container as Record<string, unknown>).properties;
    if (
      typeof missingProperty === 'string' &&
      typeof properties === 'object' &&
      properties !== null
    ) {
      const propertyInvariant = invariantFromNode(
        registry,
        (properties as Record<string, unknown>)[missingProperty],
        document
      );
      if (propertyInvariant) return propertyInvariant;
    }
  }
  const containerInvariant = invariantFromNode(registry, container, document);
  if (containerInvariant) return containerInvariant;
  const pathInvariant = invariantFromSchemaPath(registry, document, error.schemaPath);
  if (pathInvariant) return pathInvariant;
  return invariantFromNode(registry, document, document);
}

export function sharedSchemaErrorInvariantId(
  registry: ContractRegistry,
  error: ErrorObject
): string | undefined {
  return schemaErrorInvariantIdInDocument(
    registry,
    commonSchema as ContractSchema,
    error
  );
}

export function registryBuildIssue(error: unknown): ValidationIssue {
  return {
    invariant_id: 'INV-API-001',
    path: '/schemas',
    message: error instanceof Error ? error.message : 'contract registry could not be created'
  };
}

export function rawSchemaErrors(validator: ValidateFunction): ErrorObject[] {
  return validator.errors ?? [];
}
