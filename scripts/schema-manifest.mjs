import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const schemaDirectory = path.join(projectRoot, 'schemas');
export const generatedDirectory = path.join(projectRoot, 'src', 'contracts', 'generated');

export const schemaManifest = [
  ['v1/common.schema.json', 'common.ts'],
  ['v1/model-config.schema.json', 'model-config.ts'],
  ['v1/model-snapshot.schema.json', 'model-snapshot.ts'],
  ['v1/transcript.raw.schema.json', 'transcript-raw.ts'],
  ['v1/calibration-result.schema.json', 'calibration-result.ts'],
  ['v1/audio-verification.schema.json', 'audio-verification.ts'],
  ['v2/model-config.schema.json', 'model-config-v2.ts'],
  ['v2/model-snapshot.schema.json', 'model-snapshot-v2.ts'],
  ['v2/calibration-result.schema.json', 'calibration-result-v2.ts'],
  ['v3/calibration-result.schema.json', 'calibration-result-v3.ts'],
  ['v4/background-task.schema.json', 'background-task-v4.ts'],
  ['v4/background-job.schema.json', 'background-job-v1.ts'],
  ['v4/background-request.schema.json', 'background-request-v1.ts'],
  ['v4/task-event.schema.json', 'task-event-v1.ts'],
  ['v4/review.schema.json', 'review-v1.ts'],
  ['exchange/v1/request.schema.json', 'exchange-request-v1.ts'],
  ['exchange/v1/task.schema.json', 'exchange-task-v1.ts'],
  ['exchange/v1/event.schema.json', 'exchange-event-v1.ts'],
  ['exchange/v1/result.schema.json', 'exchange-result-v1.ts'],
  ['exchange/v1/error.schema.json', 'exchange-error-v1.ts'],
  ['exchange/v1/transcript.schema.json', 'exchange-transcript-v1.ts'],
  ['exchange/v1/dictionary.schema.json', 'exchange-dictionary-v1.ts'],
  ['v5/task-record.schema.json', 'task-record-v5.ts']
];
