import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { fetchAllMetadataMappings } from '../../src/lib/metadata-mappings.js';

const row = (name: string) => ({
  fully_qualified_source_object_name: name,
});

function clientWithMappingRevisions(
  rpc: ReturnType<typeof vi.fn>,
  snapshots: Array<Array<{ id: string; updated_at: string }>> = [[]],
): Pick<SupabaseClient, 'rpc' | 'from'> {
  let snapshotIndex = 0;
  const from = vi.fn(() => {
    let cursor: string | null = null;
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      gt: vi.fn((_column: string, value: string) => {
        cursor = value;
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(async () => {
        const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)] ?? [];
        const data = snapshot.filter((revision) => cursor === null || revision.id > cursor);
        if (data.length === 0) snapshotIndex += 1;
        return { data, error: null };
      }),
    };
    return query;
  });

  return { rpc, from } as unknown as Pick<SupabaseClient, 'rpc' | 'from'>;
}

describe('fetchAllMetadataMappings', () => {
  it('uses keyset pagination for object-only responses', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [row('catalog.schema.a'), row('catalog.schema.b')],
        error: null,
      })
      .mockResolvedValueOnce({ data: [row('catalog.schema.c')], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const result = await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: null,
      datasourceId: 'datasource-1',
      includeFields: false,
      deletedObjectMode: 'EXCLUDE',
      objectOnlyPageSize: 2,
    });

    expect(result).toEqual([
      row('catalog.schema.a'),
      row('catalog.schema.b'),
      row('catalog.schema.c'),
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_pipeline_metadata_mappings_keyset', {
      p_pipeline_id: null,
      p_datasource_id: 'datasource-1',
      p_limit: 2,
      p_after_fully_qualified_name: null,
      p_include_fields: false,
      p_deleted_object_mode: 'EXCLUDE',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'get_pipeline_metadata_mappings_keyset', {
      p_pipeline_id: null,
      p_datasource_id: 'datasource-1',
      p_limit: 2,
      p_after_fully_qualified_name: 'catalog.schema.b',
      p_include_fields: false,
      p_deleted_object_mode: 'EXCLUDE',
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'get_pipeline_metadata_mappings_keyset', {
      p_pipeline_id: null,
      p_datasource_id: 'datasource-1',
      p_limit: 2,
      p_after_fully_qualified_name: 'catalog.schema.c',
      p_include_fields: false,
      p_deleted_object_mode: 'EXCLUDE',
    });
  });

  it('validates full-field responses against a deletion-aware object keyset', async () => {
    const source = [row('catalog.schema.a'), row('catalog.schema.b')];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_pipeline_metadata_mappings') {
        return { data: args.p_offset === 0 ? source : [], error: null };
      }
      return {
        data: args.p_after_fully_qualified_name === null ? source : [],
        error: null,
      };
    });

    await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: 'pipeline-1',
      datasourceId: 'datasource-1',
      includeFields: true,
      deletedObjectMode: 'INCLUDE_SELECTED',
      fullFieldsPageSize: 2,
      objectOnlyPageSize: 2,
    });

    expect(rpc).toHaveBeenNthCalledWith(1, 'get_pipeline_metadata_mappings', {
      p_pipeline_id: 'pipeline-1',
      p_datasource_id: 'datasource-1',
      p_limit: 2,
      p_offset: 0,
      p_include_fields: true,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'get_pipeline_metadata_mappings_keyset', {
      p_pipeline_id: 'pipeline-1',
      p_datasource_id: 'datasource-1',
      p_limit: 2,
      p_after_fully_qualified_name: null,
      p_include_fields: false,
      p_deleted_object_mode: 'INCLUDE_SELECTED',
    });
  });

  it('fails instead of looping when the keyset cursor does not advance', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [row('catalog.schema.a')], error: null })
      .mockResolvedValueOnce({ data: [row('catalog.schema.a')], error: null });

    await expect(
      fetchAllMetadataMappings({ rpc } as unknown as Pick<SupabaseClient, 'rpc'>, {
        pipelineId: null,
        datasourceId: 'datasource-1',
        includeFields: false,
        deletedObjectMode: 'EXCLUDE',
        objectOnlyPageSize: 1,
      }),
    ).rejects.toThrow('missing or repeated fully qualified name');
  });

  it('continues both validation phases after short pages imposed by a server cap', async () => {
    const source = ['a', 'b', 'c'].map((name) => row(`catalog.schema.${name}`));
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_pipeline_metadata_mappings') {
        const offset = args.p_offset as number;
        return { data: source.slice(offset, offset + 2), error: null };
      }
      const cursor = args.p_after_fully_qualified_name as string | null;
      return {
        data: source
          .filter((item) => cursor === null || item.fully_qualified_source_object_name > cursor)
          .slice(0, 2),
        error: null,
      };
    });

    const result = await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: 'pipeline-1',
      datasourceId: 'datasource-1',
      includeFields: true,
      deletedObjectMode: 'INCLUDE_SELECTED',
      fullFieldsPageSize: 500,
      objectOnlyPageSize: 500,
    });

    expect(result).toHaveLength(3);
    expect(
      rpc.mock.calls
        .filter(([name]) => name === 'get_pipeline_metadata_mappings')
        .map(([, args]) => args.p_offset),
    ).toEqual([0, 2, 3]);
    expect(
      rpc.mock.calls
        .filter(([name]) => name === 'get_pipeline_metadata_mappings_keyset')
        .map(([, args]) => args.p_after_fully_qualified_name),
    ).toEqual([null, 'catalog.schema.b', 'catalog.schema.c']);
  });

  it('retries the same full-field offset with a smaller page after a statement timeout', async () => {
    const source = [row('catalog.schema.a'), row('catalog.schema.b')];
    const fullFieldLimits: number[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_pipeline_metadata_mappings') {
        const limit = args.p_limit as number;
        const offset = args.p_offset as number;
        fullFieldLimits.push(limit);
        if (offset === 0 && limit === 50) {
          return {
            data: null,
            error: { code: '57014', message: 'canceling statement due to statement timeout' },
          };
        }
        return { data: source.slice(offset, offset + limit), error: null };
      }
      return {
        data: args.p_after_fully_qualified_name === null ? source : [],
        error: null,
      };
    });

    const result = await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: null,
      datasourceId: 'datasource-1',
      includeFields: true,
      deletedObjectMode: 'EXCLUDE',
      fullFieldsPageSize: 50,
    });

    expect(result).toEqual(source);
    expect(fullFieldLimits).toEqual([50, 25, 25]);
    expect(
      rpc.mock.calls
        .filter(([name]) => name === 'get_pipeline_metadata_mappings')
        .map(([, args]) => args.p_offset),
    ).toEqual([0, 0, 2]);
  });

  it('preserves the exact fully qualified name when advancing the keyset cursor', async () => {
    const source = [row('catalog.schema.a'), row('catalog.schema.b '), row('catalog.schema.c')];
    const cursors: Array<string | null> = [];
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const cursor = args.p_after_fully_qualified_name as string | null;
      cursors.push(cursor);
      return {
        data: source
          .filter((item) => cursor === null || item.fully_qualified_source_object_name > cursor)
          .slice(0, 2),
        error: null,
      };
    });

    const result = await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: null,
      datasourceId: 'datasource-1',
      includeFields: false,
      deletedObjectMode: 'EXCLUDE',
      objectOnlyPageSize: 2,
    });

    expect(result).toEqual(source);
    expect(cursors).toEqual([null, 'catalog.schema.b ', 'catalog.schema.c']);
  });

  it('honors the requested deletion mode for full-field metadata', async () => {
    const active = {
      ...row('catalog.schema.active'),
      source_metadata: { deleted: false, fields: [] },
    };
    const deleted = {
      ...row('catalog.schema.deleted'),
      source_metadata: { deleted: true, fields: [] },
    };
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_pipeline_metadata_mappings_keyset') {
        return {
          data: args.p_after_fully_qualified_name === null ? [active] : [],
          error: null,
        };
      }
      return { data: args.p_offset === 0 ? [active, deleted] : [], error: null };
    });

    const result = await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: null,
      datasourceId: 'datasource-1',
      includeFields: true,
      deletedObjectMode: 'EXCLUDE',
      fullFieldsPageSize: 2,
    });

    expect(result).toEqual([active]);
    expect(rpc).toHaveBeenCalledWith(
      'get_pipeline_metadata_mappings_keyset',
      expect.objectContaining({
        p_include_fields: false,
        p_deleted_object_mode: 'EXCLUDE',
      }),
    );
  });

  it('does not skip full-field metadata when membership changes between pages', async () => {
    const initial = ['a', 'b', 'c', 'd'].map((name) => row(`catalog.schema.${name}`));
    const afterDelete = initial.slice(1);
    let fullScan = 0;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_pipeline_metadata_mappings_keyset') {
        const cursor = args.p_after_fully_qualified_name as string | null;
        return {
          data: afterDelete
            .filter((item) => cursor === null || item.fully_qualified_source_object_name > cursor)
            .slice(0, 2),
          error: null,
        };
      }
      const offset = args.p_offset as number;
      const source = fullScan === 0 && offset === 0 ? initial : afterDelete;
      const data = source.slice(offset, offset + 2);
      if (data.length === 0) fullScan += 1;
      return { data, error: null };
    });

    const result = await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: 'pipeline-1',
      datasourceId: 'datasource-1',
      includeFields: true,
      deletedObjectMode: 'INCLUDE_SELECTED',
      fullFieldsPageSize: 2,
    });

    expect(result.map((item) => item.fully_qualified_source_object_name)).toEqual(
      afterDelete.map((item) => item.fully_qualified_source_object_name),
    );
    expect(
      rpc.mock.calls.filter(
        ([name, args]) => name === 'get_pipeline_metadata_mappings' && args.p_offset === 0,
      ),
    ).toHaveLength(2);
  });

  it('retries the full-field scan when offset drift repeats an object', async () => {
    const stable = ['a', 'b', 'c'].map((name) => row(`catalog.schema.${name}`));
    let fullScan = 0;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_pipeline_metadata_mappings_keyset') {
        const cursor = args.p_after_fully_qualified_name as string | null;
        return {
          data: stable
            .filter((item) => cursor === null || item.fully_qualified_source_object_name > cursor)
            .slice(0, 2),
          error: null,
        };
      }

      const offset = args.p_offset as number;
      if (fullScan === 0) {
        if (offset === 0) return { data: stable.slice(0, 2), error: null };
        fullScan += 1;
        return { data: [stable[1], stable[2]], error: null };
      }
      return { data: stable.slice(offset, offset + 2), error: null };
    });

    const result = await fetchAllMetadataMappings(
      { rpc } as unknown as Pick<SupabaseClient, 'rpc'>,
      {
        pipelineId: null,
        datasourceId: 'datasource-1',
        includeFields: true,
        deletedObjectMode: 'EXCLUDE',
        fullFieldsPageSize: 2,
        objectOnlyPageSize: 2,
      },
    );

    expect(result).toEqual(stable);
    expect(
      rpc.mock.calls.filter(
        ([name, args]) => name === 'get_pipeline_metadata_mappings' && args.p_offset === 0,
      ),
    ).toHaveLength(2);
  });

  it('retries when the same FQN resolves to a different catalog or mapping incarnation', async () => {
    const name = 'catalog.schema.a';
    const stale = {
      ...row(name),
      source_catalog_id: 'catalog-old',
      catalog_version: 1,
      mapping_id: 'mapping-old',
      catalog_updated_at: '2026-01-01T00:00:00Z',
      selected_at: '2026-01-01T00:00:00Z',
      merged_metadata: { fields: [{ name: 'old_field' }] },
    };
    const current = {
      ...row(name),
      source_catalog_id: 'catalog-new',
      catalog_version: 2,
      mapping_id: 'mapping-new',
      catalog_updated_at: '2026-01-02T00:00:00Z',
      selected_at: '2026-01-02T00:00:00Z',
      merged_metadata: { fields: [{ name: 'new_field' }] },
    };
    let fullScan = 0;
    const rpc = vi.fn(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'get_pipeline_metadata_mappings_keyset') {
        return {
          data: args.p_after_fully_qualified_name === null ? [current] : [],
          error: null,
        };
      }

      const offset = args.p_offset as number;
      if (offset === 0) return { data: [fullScan === 0 ? stale : current], error: null };
      fullScan += 1;
      return { data: [], error: null };
    });

    const result = await fetchAllMetadataMappings(clientWithMappingRevisions(rpc), {
      pipelineId: 'pipeline-1',
      datasourceId: 'datasource-1',
      includeFields: true,
      deletedObjectMode: 'INCLUDE_SELECTED',
      fullFieldsPageSize: 1,
    });

    expect(result).toEqual([current]);
    expect(
      rpc.mock.calls.filter(
        ([rpcName, args]) => rpcName === 'get_pipeline_metadata_mappings' && args.p_offset === 0,
      ),
    ).toHaveLength(2);
  });

  it('retries when a field selection changes during full-field pagination', async () => {
    const name = 'catalog.schema.a';
    const stableIdentity = {
      ...row(name),
      source_catalog_id: 'catalog-1',
      catalog_version: 1,
      mapping_id: 'mapping-1',
      catalog_updated_at: '2026-01-01T00:00:00Z',
      selected_at: '2026-01-01T00:00:00Z',
    };
    const stale = {
      ...stableIdentity,
      selected_source_metadata: { selected: true, fields: [{ name: 'old', selected: true }] },
      merged_metadata: { fields: [{ name: 'old', selected: true }] },
    };
    const current = {
      ...stableIdentity,
      selected_source_metadata: { selected: true, fields: [{ name: 'new', selected: true }] },
      merged_metadata: { fields: [{ name: 'new', selected: true }] },
    };
    let fullScan = 0;
    const rpc = vi.fn(async (rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'get_pipeline_metadata_mappings_keyset') {
        return {
          data: args.p_after_fully_qualified_name === null ? [stableIdentity] : [],
          error: null,
        };
      }

      if (args.p_offset === 0) return { data: [fullScan === 0 ? stale : current], error: null };
      fullScan += 1;
      return { data: [], error: null };
    });
    const firstRevision = [{ id: 'mapping-1', updated_at: '2026-01-01T00:00:00Z' }];
    const secondRevision = [{ id: 'mapping-1', updated_at: '2026-01-02T00:00:00Z' }];

    const result = await fetchAllMetadataMappings(
      clientWithMappingRevisions(rpc, [
        firstRevision,
        secondRevision,
        secondRevision,
        secondRevision,
      ]),
      {
        pipelineId: 'pipeline-1',
        datasourceId: 'datasource-1',
        includeFields: true,
        deletedObjectMode: 'INCLUDE_SELECTED',
        fullFieldsPageSize: 1,
      },
    );

    expect(result).toEqual([current]);
    expect(
      rpc.mock.calls.filter(
        ([rpcName, args]) => rpcName === 'get_pipeline_metadata_mappings' && args.p_offset === 0,
      ),
    ).toHaveLength(2);
  });
});
