import { describe, it, expect } from 'vitest';
import { isEncryptedValue, encodeEnvelope, decodeEnvelope, resolveEncryptedConfigs } from '../../src/lib/encryption.js';

describe('resolveEncryptedConfigs', () => {
  it('decodes enc: values to JSONB envelopes', () => {
    const envelope = { v: 1, fp: 'abc123', data: 'encrypted' };
    const encoded = encodeEnvelope(envelope);
    const configs = { host: 'localhost', password: encoded };
    const resolved = resolveEncryptedConfigs(configs);

    expect(resolved.host).toBe('localhost');
    expect(resolved.password).toEqual(envelope);
  });

  it('passes through non-enc: values unchanged', () => {
    const configs = { host: 'localhost', port: 5432, ssl: true };
    const resolved = resolveEncryptedConfigs(configs);
    expect(resolved).toEqual(configs);
  });

  it('handles mixed enc: and plain values', () => {
    const envelope = { v: 1, fp: 'fp1', data: 'secret' };
    const encoded = encodeEnvelope(envelope);
    const configs = { host: 'db.com', password: encoded, port: '5432' };
    const resolved = resolveEncryptedConfigs(configs);

    expect(resolved.host).toBe('db.com');
    expect(resolved.password).toEqual(envelope);
    expect(resolved.port).toBe('5432');
  });
});

describe('isEncryptedValue edge cases', () => {
  it('rejects enc: without valid base64', () => {
    expect(isEncryptedValue('enc:')).toBe(true); // prefix matches
    expect(() => decodeEnvelope('enc:')).toThrow(); // but decode fails
  });

  it('rejects values that start with enc but not enc:', () => {
    expect(isEncryptedValue('encrypted_value')).toBe(false);
    expect(isEncryptedValue('encode:something')).toBe(false);
  });
});
