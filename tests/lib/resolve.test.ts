import { describe, it, expect } from 'vitest';
import { isUuid } from '../../src/lib/resolve.js';

describe('isUuid', () => {
  it('detects valid UUID', () => {
    expect(isUuid('8a3f1b2c-4d5e-6f7a-8b9c-0d1e2f3a4b5c')).toBe(true);
  });

  it('rejects non-UUID', () => {
    expect(isUuid('salesforce-to-snowflake')).toBe(false);
    expect(isUuid('abc')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
