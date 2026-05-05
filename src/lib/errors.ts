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

/**
 * Render an unknown error value as a single human-readable string.
 *
 * `String(value)` on a plain object renders as `"[object Object]"` -- which
 * is exactly what propagates when a Supabase `PostgrestError` (or any other
 * non-Error object) is thrown raw from a command. This helper handles three
 * categories explicitly:
 *
 * 1. ``Error`` instance: return ``error.message``.
 * 2. ``string``: return as-is.
 * 3. Plain object that looks like a structured error
 *    (Supabase `PostgrestError` shape: ``{ message, code?, details?, hint? }``):
 *    use ``message`` as the human string, suffix ``(code: ...)`` when present.
 * 4. Any other object: ``JSON.stringify`` (with a circular-safe fallback).
 * 5. ``null`` / ``undefined`` / primitives: ``String(value)`` is fine.
 *
 * Exported for tests; not part of the public CLI surface.
 */
export function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error !== null && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    // Supabase PostgrestError + similar { message, code?, details?, hint? }
    if (typeof obj.message === 'string' && obj.message.length > 0) {
      const code = typeof obj.code === 'string' && obj.code.length > 0
        ? ` (code: ${obj.code})`
        : '';
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Circular reference or other non-serializable structure
      return '[unserializable error object]';
    }
  }
  return String(error);
}

export function handleError(error: unknown, json: boolean): never {
  if (error instanceof CliError) {
    // JSON errors go to stdout so piped parsers can read them;
    // human-readable errors go to stderr (conventional CLI behavior)
    if (json) {
      console.log(formatError(error, json));
    } else {
      console.error(formatError(error, json));
    }
    process.exit(error.exitCode);
  }
  const message = stringifyUnknownError(error);
  const cliError = new CliError(message, ErrorCode.API_ERROR);
  if (json) {
    console.log(formatError(cliError, json));
  } else {
    console.error(formatError(cliError, json));
  }
  process.exit(1);
}
