import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchDefaultPipelineObjectMappings,
  fetchSelectedPipelineMappings,
} from '../src/commands/pipelines.js';
import { fetchAllJobObjectDetails } from '../src/commands/jobs.js';

function metadataRow(name: string) {
  return { fully_qualified_source_object_name: name };
}

function keysetClient(rowsByTable: Record<string, Array<Record<string, unknown>>>, cap = 2) {
  const cursors: Array<{ table: string; key: string; cursor: string | null }> = [];
  const predicates: Array<{ table: string; column: string; value: unknown }> = [];
  const from = vi.fn((table: string) => {
    let key = 'id';
    let cursor: string | null = null;
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        predicates.push({ table, column, value });
        return query;
      }),
      gt: vi.fn((column: string, value: string) => {
        key = column;
        cursor = value;
        return query;
      }),
      order: vi.fn((column: string) => {
        key = column;
        return query;
      }),
      limit: vi.fn(async () => {
        cursors.push({ table, key, cursor });
        return {
          data: (rowsByTable[table] ?? [])
            .filter((row) => cursor === null || String(row[key]) > cursor)
            .sort((left, right) => String(left[key]).localeCompare(String(right[key])))
            .slice(0, cap),
          error: null,
        };
      }),
    };
    return query;
  });
  return {
    client: { from } as unknown as Pick<SupabaseClient, 'from'>,
    cursors,
    predicates,
  };
}

describe('CLI complete-read consumers', () => {
  it('builds the default pipeline selection from every catalog keyset page', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [metadataRow('catalog.schema.a'), metadataRow('catalog.schema.b')],
        error: null,
      })
      .mockResolvedValueOnce({ data: [metadataRow('catalog.schema.c')], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const mappings = await fetchDefaultPipelineObjectMappings(
      { rpc } as unknown as Pick<SupabaseClient, 'rpc'>,
      'datasource-1',
    );

    expect(mappings).toEqual([
      { fully_qualified_name: 'catalog.schema.a', selected: true, fields: null },
      { fully_qualified_name: 'catalog.schema.b', selected: true, fields: null },
      { fully_qualified_name: 'catalog.schema.c', selected: true, fields: null },
    ]);
  });

  it('pages saved schema selections before filtering deselected objects', async () => {
    const { client, cursors, predicates } = keysetClient({
      pipeline_metadata_mappings: [
        {
          id: '1',
          source_fully_qualified_name: 'catalog.schema.a',
          selected_source_metadata: { selected: true },
          selection_origin: 'user',
        },
        {
          id: '2',
          source_fully_qualified_name: 'catalog.schema.b',
          selected_source_metadata: { selected: false },
          selection_origin: 'user',
        },
        {
          id: '3',
          source_fully_qualified_name: 'catalog.schema.c',
          selected_source_metadata: { selected: true },
          selection_origin: 'user',
        },
      ],
    });

    const mappings = await fetchSelectedPipelineMappings(client, 'pipeline-1', false);

    expect(mappings.map((item) => item.mapping.fully_qualified_name)).toEqual([
      'catalog.schema.a',
      'catalog.schema.c',
    ]);
    expect(cursors).toEqual([
      { table: 'pipeline_metadata_mappings', key: 'id', cursor: null },
      { table: 'pipeline_metadata_mappings', key: 'id', cursor: '2' },
      { table: 'pipeline_metadata_mappings', key: 'id', cursor: '3' },
    ]);
    expect(predicates).toEqual(
      Array.from({ length: 3 }, () => ({
        table: 'pipeline_metadata_mappings',
        column: 'pipeline_id',
        value: 'pipeline-1',
      })),
    );
  });

  it('does not omit a saved mapping renamed across the active cursor', async () => {
    const initial = [
      {
        id: '1',
        source_fully_qualified_name: 'catalog.schema.a',
        selected_source_metadata: { selected: true },
      },
      {
        id: '2',
        source_fully_qualified_name: 'catalog.schema.b',
        selected_source_metadata: { selected: true },
      },
      {
        id: '3',
        source_fully_qualified_name: 'catalog.schema.c',
        selected_source_metadata: { selected: true },
      },
      {
        id: '4',
        source_fully_qualified_name: 'catalog.schema.d',
        selected_source_metadata: { selected: true },
      },
    ];
    let request = 0;
    const predicates: Array<{ column: string; value: unknown }> = [];
    const from = vi.fn(() => {
      let key = 'id';
      let cursor: string | null = null;
      const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
          predicates.push({ column, value });
          return query;
        }),
        gt: vi.fn((column: string, value: string) => {
          key = column;
          cursor = value;
          return query;
        }),
        order: vi.fn((column: string) => {
          key = column;
          return query;
        }),
        limit: vi.fn(async () => {
          const rows = initial.map((item) =>
            request > 0 && item.id === '3'
              ? { ...item, source_fully_qualified_name: 'catalog.schema.aa' }
              : item,
          );
          request += 1;
          return {
            data: rows
              .filter((item) => cursor === null || String(item[key as keyof typeof item]) > cursor)
              .sort((left, right) =>
                String(left[key as keyof typeof left]).localeCompare(
                  String(right[key as keyof typeof right]),
                ),
              )
              .slice(0, 2),
            error: null,
          };
        }),
      };
      return query;
    });

    const result = await fetchSelectedPipelineMappings(
      { from } as unknown as Pick<SupabaseClient, 'from'>,
      'pipeline-1',
      false,
    );

    expect(new Set(result.map((item) => item.row.id))).toEqual(new Set(['1', '2', '3', '4']));
    expect(result.map((item) => item.mapping.fully_qualified_name)).toEqual([
      'catalog.schema.a',
      'catalog.schema.aa',
      'catalog.schema.b',
      'catalog.schema.d',
    ]);
    expect(predicates).toEqual(
      Array.from({ length: 3 }, () => ({ column: 'pipeline_id', value: 'pipeline-1' })),
    );
  });

  it('returns every terminal job-detail row across capped pages', async () => {
    const { client, cursors, predicates } = keysetClient({
      job_details_v2: [
        { id: 'a', fully_qualified_source_object_name: 'one' },
        { id: 'b', fully_qualified_source_object_name: 'two' },
        { id: 'c', fully_qualified_source_object_name: 'three' },
      ],
    });

    const details = await fetchAllJobObjectDetails(client, 'job-1');

    expect(details.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(cursors.map(({ cursor }) => cursor)).toEqual([null, 'b', 'c']);
    expect(predicates).toEqual(
      Array.from({ length: 3 }, () => ({
        table: 'job_details_v2',
        column: 'job_id',
        value: 'job-1',
      })),
    );
  });
});
