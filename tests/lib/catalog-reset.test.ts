import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  catalogResetOutcomeMessage,
  enqueueCatalogReset,
  pollCatalogResetUntilFinished,
  type CatalogResetStatus,
} from '../../src/lib/catalog-reset.js';

function status(
  catalogState: CatalogResetStatus['catalog_state'],
  maintenanceActive: boolean,
): CatalogResetStatus {
  return {
    job_id: 'job-1',
    maintenance_active: maintenanceActive,
    catalog_state: catalogState,
    finished_at: maintenanceActive ? null : '2026-08-16T00:00:00Z',
  };
}

describe('catalog reset polling', () => {
  it('uses the authoritative enqueue RPC and datasource parameter', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'job-1', error: null });

    await expect(
      enqueueCatalogReset({ rpc } as unknown as SupabaseClient, 'datasource-1'),
    ).resolves.toBe('job-1');
    expect(rpc).toHaveBeenCalledWith('create_datasource_catalog_reset_job', {
      p_datasource_id: 'datasource-1',
    });
  });

  it.each(['cancelled', 'timed_out'])(
    'continues through an ordinary %s stop signal until restoration finishes',
    async () => {
      const pending = status('restoration_pending', true);
      const restored = status('restored', false);
      const rpc = vi
        .fn()
        .mockResolvedValueOnce({ data: [pending], error: null })
        .mockResolvedValueOnce({ data: [restored], error: null });
      const observed: string[] = [];

      const result = await pollCatalogResetUntilFinished(
        { rpc } as unknown as SupabaseClient,
        'job-1',
        {
          wait: async () => undefined,
          onStatus: (value) => observed.push(value.catalog_state),
        },
      );

      expect(rpc).toHaveBeenCalledTimes(2);
      expect(observed).toEqual(['restoration_pending', 'restored']);
      expect(result).toEqual(restored);
    },
  );

  it('returns immediately for a terminal outcome', async () => {
    const completed = status('completed', false);
    const rpc = vi.fn().mockResolvedValue({ data: [completed], error: null });

    await expect(
      pollCatalogResetUntilFinished({ rpc } as unknown as SupabaseClient, 'job-1'),
    ).resolves.toEqual(completed);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('keeps user-facing outcomes free of internal recovery terms', () => {
    const messages = [
      status('maintenance_in_progress', true),
      status('restoration_pending', true),
      status('completed', false),
      status('unchanged', false),
      status('restored', false),
    ]
      .map(catalogResetOutcomeMessage)
      .join(' ');

    expect(messages).not.toMatch(/receipt|tombstone|lineage|abort/i);
  });

  it('continues polling after a transient status failure', async () => {
    const completed = status('completed', false);
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'temporary' } })
      .mockResolvedValueOnce({ data: [completed], error: null });
    const onError = vi.fn();

    await expect(
      pollCatalogResetUntilFinished({ rpc } as unknown as SupabaseClient, 'job-1', {
        wait: async () => undefined,
        onError,
      }),
    ).resolves.toEqual(completed);
    expect(onError).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
