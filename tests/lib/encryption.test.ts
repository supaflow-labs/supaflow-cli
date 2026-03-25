import { describe, it, expect } from 'vitest';
import { isEncryptedValue, encodeEnvelope, decodeEnvelope } from '../../src/lib/encryption.js';

describe('isEncryptedValue', () => {
  it('detects enc: prefix', () => {
    expect(isEncryptedValue('enc:eyJ2IjoxfQ==')).toBe(true);
  });

  it('rejects plain values', () => {
    expect(isEncryptedValue('my-password')).toBe(false);
    expect(isEncryptedValue('')).toBe(false);
  });
});

describe('encodeEnvelope', () => {
  it('base64-encodes and adds enc: prefix', () => {
    const envelope = { v: 1, fp: 'abc123', data: 'encrypted-data' };
    const encoded = encodeEnvelope(envelope);
    expect(encoded.startsWith('enc:')).toBe(true);
  });
});

describe('decodeEnvelope', () => {
  it('round-trips with encodeEnvelope', () => {
    const envelope = { v: 1, fp: 'abc123', data: 'encrypted-data' };
    const encoded = encodeEnvelope(envelope);
    const decoded = decodeEnvelope(encoded);
    expect(decoded).toEqual(envelope);
  });

  it('throws on invalid enc: value', () => {
    expect(() => decodeEnvelope('enc:not-valid-base64!!!')).toThrow();
  });

  it('throws on non-enc: value', () => {
    expect(() => decodeEnvelope('plain-value')).toThrow();
  });
});
