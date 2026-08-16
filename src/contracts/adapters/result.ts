import type { AdapterFailureRecord } from '../generated/common.js';

export type AdapterExecutionResult<T> =
  | { kind: 'artifact'; artifact: T }
  | { kind: 'failure'; failure: AdapterFailureRecord };
