import { describe, it, expect, vi } from 'vitest';
import { decodeJwtRegion, softDeleteEntity } from '../../src/lib/client.js';

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

describe('softDeleteEntity', () => {
  it('uses the UI recursive RPC and returns its affected-row details', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          affected_count: 1,
          entity_type: 'project',
          details: { pipelines_soft_deleted: 2 },
        },
      ],
      error: null,
    });

    const result = await softDeleteEntity({ rpc } as never, 'project', 'project-id');

    expect(rpc).toHaveBeenCalledWith('soft_delete_project', {
      p_project_id: 'project-id',
    });
    expect(result).toMatchObject({ affected_count: 1, entity_type: 'project' });
  });

  it('rejects an RLS-filtered or already-deleted zero-row result', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ affected_count: 0, entity_type: 'datasource', details: {} }],
      error: null,
    });

    await expect(softDeleteEntity({ rpc } as never, 'datasource', 'datasource-id')).rejects.toThrow(
      'no row was affected',
    );
  });
});
