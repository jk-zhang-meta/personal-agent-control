export class PacError extends Error {
  constructor(code, message, details = undefined, exitCode = 1) {
    super(message);
    this.name = 'PacError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function usage(message) {
  return new PacError('USAGE', message, undefined, 2);
}

export function asPacError(error) {
  if (error instanceof PacError) return error;
  return new PacError('INTERNAL', error?.message || String(error));
}
