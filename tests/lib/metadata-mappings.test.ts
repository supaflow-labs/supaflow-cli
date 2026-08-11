import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { fetchAllMetadataMappings } from '../../src/lib/metadata-mappings.js';

const row = (name: string) => ({
  fully_qualified_source_object_name: name,
});

describe('fetchAllMetadataMappings', () => {
  it('uses keyset pagination for object-only responses', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [row('catalog.schema.a'), row('catalog.schema.b')], error: null })
      .mockResolvedValueOnce({ data: [row('catalog.schema.c')], error: null });

    const result = await fetchAllMetadataMappings(
      { rpc } as unknown as Pick<SupabaseClient, 'rpc'>,
      {
        pipelineId: null,
        datasourceId: 'datasource-1',
        includeFields: false,
        deletedObjectMode: 'EXCLUDE',
        objectOnlyPageSize: 2,
      },
    );

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
  });

  it('keeps full-field responses on the legacy OFFSET RPC', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [row('catalog.schema.a'), row('catalog.schema.b')], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    await fetchAllMetadataMappings(
      { rpc } as unknown as Pick<SupabaseClient, 'rpc'>,
      {
        pipelineId: 'pipeline-1',
        datasourceId: 'datasource-1',
        includeFields: true,
        deletedObjectMode: 'INCLUDE_SELECTED',
        fullFieldsPageSize: 2,
      },
    );

    expect(rpc).toHaveBeenNthCalledWith(1, 'get_pipeline_metadata_mappings', {
      p_pipeline_id: 'pipeline-1',
      p_datasource_id: 'datasource-1',
      p_limit: 2,
      p_offset: 0,
      p_include_fields: true,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'get_pipeline_metadata_mappings', {
      p_pipeline_id: 'pipeline-1',
      p_datasource_id: 'datasource-1',
      p_limit: 2,
      p_offset: 2,
      p_include_fields: true,
    });
  });

  it('fails instead of looping when the keyset cursor does not advance', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [row('catalog.schema.a')], error: null })
      .mockResolvedValueOnce({ data: [row('catalog.schema.a')], error: null });

    await expect(fetchAllMetadataMappings(
      { rpc } as unknown as Pick<SupabaseClient, 'rpc'>,
      {
        pipelineId: null,
        datasourceId: 'datasource-1',
        includeFields: false,
        deletedObjectMode: 'EXCLUDE',
        objectOnlyPageSize: 1,
      },
    )).rejects.toThrow('did not return an advancing cursor');
  });
});
