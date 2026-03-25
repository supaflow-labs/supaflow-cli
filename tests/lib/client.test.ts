import { describe, it, expect } from 'vitest';
import { decodeJwtRegion } from '../../src/lib/client.js';

describe('decodeJwtRegion', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'HS256' }));
    const body = btoa(JSON.stringify(payload));
    return `${header}.${body}.signature`;
  }

  it('extracts org_region from JWT', () => {
    const jwt = makeJwt({ org_region: 'eu', user_region: 'us' });
    expect(decodeJwtRegion(jwt)).toBe('eu');
  });

  it('falls back to user_region if org_region is absent', () => {
    const jwt = makeJwt({ user_region: 'eu' });
    expect(decodeJwtRegion(jwt)).toBe('eu');
  });

  it('returns undefined for invalid JWT', () => {
    expect(decodeJwtRegion('not-a-jwt')).toBeUndefined();
  });

  it('returns undefined when no region claims present', () => {
    const jwt = makeJwt({ sub: 'user_123' });
    expect(decodeJwtRegion(jwt)).toBeUndefined();
  });
});
