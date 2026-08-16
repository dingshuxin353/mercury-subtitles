export class MercuryError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly remediation: string | undefined;

  constructor(code: string, message: string, options: { exitCode?: number; remediation?: string } = {}) {
    super(message);
    this.name = 'MercuryError';
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.remediation = options.remediation;
  }
}
