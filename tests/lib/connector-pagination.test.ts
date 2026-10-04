import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { fetchConnectors, type ConnectorInfo } from '../../src/lib/connector.js';

const connector = (id: string): ConnectorInfo => ({
  id,
  name: `Connector ${id}`,
  type: `TYPE_${id}`,
  latest_version_id: `version-${id}`,
  latest_version: '1.0.0',
  connector_capabilities: [],
});

describe('fetchConnectors pagination', () => {
  it('returns every connector when the server caps each response', async () => {
    const source = ['a', 'b', 'c'].map(connector);
    const orderCalls: Array<[string, { ascending: boolean }]> = [];
    const cursors: Array<string | null> = [];
    const rpc = vi.fn(() => {
      let cursor: string | null = null;
      let orderedById = false;
      const readPage = () => ({
        data: source.filter((item) => cursor === null || item.id > cursor).slice(0, 2),
        error: null,
      });
      const query: any = {
        gt: vi.fn((column: string, value: string) => {
          if (column !== 'id') throw new Error(`Unexpected connector cursor: ${column}`);
          cursor = value;
          return query;
        }),
        order: vi.fn((column: string, options: { ascending: boolean }) => {
          orderCalls.push([column, options]);
          orderedById = column === 'id' && options.ascending === true;
          return query;
        }),
        limit: vi.fn(async () => {
          if (!orderedById) throw new Error('Connector page must be ordered by ascending ID');
          cursors.push(cursor);
          return readPage();
        }),
        then: (
          resolve: (value: { data: ConnectorInfo[]; error: null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(readPage()).then(resolve, reject),
      };
      return query;
    });

    const result = await fetchConnectors({ rpc } as unknown as SupabaseClient);

    expect(result).toEqual(source);
    expect(cursors).toEqual([null, 'b', 'c']);
    expect(orderCalls).toEqual(Array.from({ length: 3 }, () => ['id', { ascending: true }]));
  });
});
