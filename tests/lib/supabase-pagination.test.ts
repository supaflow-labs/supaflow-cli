import { describe, expect, it, vi } from 'vitest';
import { fetchAllRowsByKey } from '../../src/lib/supabase-pagination.js';

function queryFor<T extends Record<string, string>>(
  source: T[],
  cursors: Array<string | null>,
  key: keyof T = 'id',
) {
  let cursor: string | null = null;
  const query = {
    gt: vi.fn((_key: string, value: string) => {
      cursor = value;
      return query;
    }),
    order: vi.fn(() => query),
    limit: vi.fn(async () => {
      cursors.push(cursor);
      return {
        data: source.filter((row) => cursor === null || row[key] > cursor).slice(0, 2),
        error: null,
      };
    }),
  };
  return query;
}

describe('fetchAllRowsByKey', () => {
  it('continues after short nonempty pages until an empty page', async () => {
    const source = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    const cursors: Array<string | null> = [];

    const rows = await fetchAllRowsByKey(() => queryFor(source, cursors), { pageSize: 500 });

    expect(rows).toEqual(source);
    expect(cursors).toEqual([null, 'b', 'd', 'e']);
  });

  it('fails closed when a page repeats a key', async () => {
    const query = {
      gt: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: [{ id: 'a' }, { id: 'a' }], error: null })),
    };

    await expect(fetchAllRowsByKey(() => query)).rejects.toThrow('missing or repeated id');
  });

  it('preserves an exact text database key when advancing the cursor', async () => {
    const source = [
      { source_fully_qualified_name: 'catalog.schema.a' },
      { source_fully_qualified_name: 'catalog.schema.b ' },
      { source_fully_qualified_name: 'catalog.schema.c' },
    ];
    const cursors: Array<string | null> = [];

    const rows = await fetchAllRowsByKey(
      () => queryFor(source, cursors, 'source_fully_qualified_name'),
      { key: 'source_fully_qualified_name', pageSize: 2 },
    );

    expect(rows).toEqual(source);
    expect(cursors).toEqual([null, 'catalog.schema.b ', 'catalog.schema.c']);
  });
});
