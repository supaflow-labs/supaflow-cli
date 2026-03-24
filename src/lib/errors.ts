export enum ErrorCode {
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  NO_WORKSPACE = 'NO_WORKSPACE',
  NOT_FOUND = 'NOT_FOUND',
  INVALID_INPUT = 'INVALID_INPUT',
  FORBIDDEN = 'FORBIDDEN',
  API_ERROR = 'API_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
}

const AUTH_ERRORS = new Set([ErrorCode.NOT_AUTHENTICATED, ErrorCode.NO_WORKSPACE]);

export class CliError extends Error {
  public readonly code: ErrorCode;
  public readonly exitCode: number;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = AUTH_ERRORS.has(code) ? 2 : 1;
  }
}

export function formatError(error: CliError, json: boolean): string {
  if (json) {
    return JSON.stringify({ error: { code: error.code, message: error.message } });
  }
  return `Error: ${error.message}`;
}

export function handleError(error: unknown, json: boolean): never {
  if (error instanceof CliError) {
    console.error(formatError(error, json));
    process.exit(error.exitCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  const cliError = new CliError(message, ErrorCode.API_ERROR);
  console.error(formatError(cliError, json));
  process.exit(1);
}
