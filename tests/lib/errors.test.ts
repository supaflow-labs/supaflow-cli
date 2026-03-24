import { describe, it, expect } from 'vitest';
import { CliError, ErrorCode, formatError } from '../../src/lib/errors.js';

describe('CliError', () => {
  it('creates error with code and exit code', () => {
    const err = new CliError('Not found', ErrorCode.NOT_FOUND);
    expect(err.message).toBe('Not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.exitCode).toBe(1);
  });

  it('uses exit code 2 for auth errors', () => {
    const err = new CliError('No key', ErrorCode.NOT_AUTHENTICATED);
    expect(err.exitCode).toBe(2);
  });
});

describe('formatError', () => {
  it('formats as text by default', () => {
    const err = new CliError('Pipeline not found', ErrorCode.NOT_FOUND);
    const output = formatError(err, false);
    expect(output).toBe('Error: Pipeline not found');
  });

  it('formats as JSON when json flag is true', () => {
    const err = new CliError('Pipeline not found', ErrorCode.NOT_FOUND);
    const output = formatError(err, true);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      error: { code: 'NOT_FOUND', message: 'Pipeline not found' },
    });
  });
});
