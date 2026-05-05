import { describe, it, expect } from 'vitest';
import { CliError, ErrorCode, formatError, stringifyUnknownError } from '../../src/lib/errors.js';

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

describe('stringifyUnknownError', () => {
  // Pin the contract that handleError uses to render arbitrary thrown
  // values into the CliError message. The motivating case is Supabase's
  // PostgrestError, which is a plain object literal (NOT an Error
  // instance). Before this helper, `String(error)` rendered such objects
  // as the literal "[object Object]" string and the user saw
  // {"error":{"code":"API_ERROR","message":"[object Object]"}} from
  // commands that did `if (error) throw error;` on a Supabase response.

  it('returns Error.message for Error instances', () => {
    expect(stringifyUnknownError(new Error('boom'))).toBe('boom');
  });

  it('returns strings as-is', () => {
    expect(stringifyUnknownError('something went wrong')).toBe('something went wrong');
  });

  it('uses .message for Supabase PostgrestError shape', () => {
    const supabaseLike = {
      message: 'permission denied for table workspaces_with_access',
      code: '42501',
      details: null,
      hint: null,
    };
    expect(stringifyUnknownError(supabaseLike)).toBe(
      'permission denied for table workspaces_with_access (code: 42501)',
    );
  });

  it('omits "(code: ...)" suffix when code is missing or empty', () => {
    expect(stringifyUnknownError({ message: 'no code here' })).toBe('no code here');
    expect(stringifyUnknownError({ message: 'empty code', code: '' })).toBe('empty code');
  });

  it('JSON-stringifies plain objects without a usable message field', () => {
    const obj = { foo: 'bar', count: 3 };
    expect(stringifyUnknownError(obj)).toBe('{"foo":"bar","count":3}');
  });

  it('does NOT render plain objects as "[object Object]"', () => {
    // Regression: this is the exact bug the helper exists to prevent.
    const supabaseLike = { message: 'JWT expired', code: 'PGRST301' };
    const obj = { foo: 'bar' };
    expect(stringifyUnknownError(supabaseLike)).not.toBe('[object Object]');
    expect(stringifyUnknownError(obj)).not.toBe('[object Object]');
  });

  it('survives circular references', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(stringifyUnknownError(circular)).toBe('[unserializable error object]');
  });

  it('handles null, undefined, and primitives', () => {
    expect(stringifyUnknownError(null)).toBe('null');
    expect(stringifyUnknownError(undefined)).toBe('undefined');
    expect(stringifyUnknownError(42)).toBe('42');
    expect(stringifyUnknownError(true)).toBe('true');
  });

  it('treats an empty .message string as missing (falls through to JSON)', () => {
    // PostgrestError-shaped object whose message is an empty string -- not
    // useful as a human string. Fall through to JSON.stringify so the user
    // sees the structured fields rather than an empty message.
    const obj = { message: '', code: 'PGRST116', details: 'no matching rows' };
    const out = stringifyUnknownError(obj);
    expect(out).toContain('PGRST116');
    expect(out).not.toBe('');
    expect(out).not.toBe('[object Object]');
  });
});
