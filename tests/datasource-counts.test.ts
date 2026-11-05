import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  columns: '',
  from: vi.fn(),
  eq: vi.fn(),
  neq: vi.fn(),
}));

vi.mock('../src/lib/middleware.js', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      const command = args.at(-1) as Command;
      await handler(
        {
          supabase: { from: mocks.from },
          workspaceId: 'workspace-1',
          outputOptions: { json: command.optsWithGlobals().json ?? false, noColor: true },
        },
        ...args.slice(0, -1),
      );
    },
}));

import { registerDatasourcesCommands } from '../src/commands/datasources.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const projected = () =>
    Object.fromEntries(
      mocks.columns
        .split(',')
        .map((key) => key.trim())
        .map((key) => [key, mocks.row[key]]),
    );
  const query = {
    select: vi.fn((columns: string) => {
      mocks.columns = columns;
      return query;
    }),
    eq: mocks.eq.mockImplementation(() => query),
    neq: mocks.neq.mockImplementation(() => query),
    order: vi.fn(() => query),
    range: vi.fn(() => query),
    single: vi.fn(async () => ({ data: projected(), error: null })),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: [projected()],
        count: 1,
        error: null,
      }).then(resolve),
  };
  mocks.from.mockReturnValue(query);
});
afterEach(() => vi.restoreAllMocks());

describe('datasource catalog summary counts', () => {
  it.each(['list', 'get'])(
    '%s preserves unknown, empty, and populated counts with workspace scoping',
    async (action) => {
      for (const counts of [
        [null, null],
        [0, 0],
        [8, 13],
      ]) {
        mocks.row = {
          id: 'source-1',
          api_name: 'source',
          name: 'Source',
          state: 'active',
          supported_source_object_count: counts[0],
          total_source_object_count: counts[1],
        };
        const program = new Command().option('--json');
        registerDatasourcesCommands(program);
        await program.parseAsync(
          ['--json', 'datasources', action, ...(action === 'get' ? ['source'] : [])],
          { from: 'user' },
        );
        const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
        const row = action === 'list' ? output.data[0] : output;
        expect(row.supported_source_object_count).toBe(counts[0]);
        expect(row.total_source_object_count).toBe(counts[1]);
        expect(mocks.from).toHaveBeenCalledWith('datasources_with_access');
        expect(mocks.eq).toHaveBeenCalledWith('workspace_id', 'workspace-1');
        if (action === 'get') expect(mocks.eq).toHaveBeenCalledWith('api_name', 'source');
        else {
          expect(mocks.neq).toHaveBeenCalledWith('state', 'deleted');
          expect(mocks.columns).not.toContain('configs');
        }
      }
    },
  );

  it.each(['list', 'get'])('%s renders unknown counts distinctly from zero', async (action) => {
    mocks.row = {
      id: 'source-1',
      supported_source_object_count: null,
      total_source_object_count: 0,
    };
    const program = new Command();
    registerDatasourcesCommands(program);
    await program.parseAsync(['datasources', action, ...(action === 'get' ? ['source'] : [])], {
      from: 'user',
    });
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
    expect(output).toContain('unknown');
    expect(output).toContain('0');
  });
});
