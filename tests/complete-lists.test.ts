import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  predicates: [] as Array<{
    table: string;
    operator: 'eq' | 'neq';
    column: string;
    value: unknown;
  }>,
  supabase: { from: vi.fn() },
}));

function newQuery(table: string) {
  let key = 'id';
  let cursor: string | null = null;
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      mocks.predicates.push({ table, operator: 'eq', column, value });
      return query;
    }),
    neq: vi.fn((column: string, value: unknown) => {
      mocks.predicates.push({ table, operator: 'neq', column, value });
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
    limit: vi.fn(async () => ({
      data: (mocks.rowsByTable[table] ?? [])
        .filter((row) => cursor === null || String(row[key]) > cursor)
        .sort((left, right) => String(left[key]).localeCompare(String(right[key])))
        .slice(0, 2),
      error: null,
    })),
  };
  return query;
}

vi.mock('../src/lib/middleware.js', () => {
  const wrap =
    (handler: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      const command = args.at(-1) as Command;
      await handler(
        {
          supabase: mocks.supabase,
          conn: {},
          workspaceId: 'workspace-1',
          outputOptions: {
            json: command.optsWithGlobals().json ?? false,
            noColor: true,
            verbose: false,
          },
        },
        ...args.slice(0, -1),
      );
    };
  return { withAuth: wrap, withAuthOnly: wrap };
});

import { registerProjectsCommands } from '../src/commands/projects.js';
import { registerSchedulesCommands } from '../src/commands/schedules.js';
import { registerWorkspacesCommands } from '../src/commands/workspaces.js';

function program(register: (command: Command) => void): Command {
  const command = new Command();
  command.exitOverride().option('--json', 'Output as JSON');
  register(command);
  return command;
}

async function listIds(register: (command: Command) => void, argv: string[]): Promise<string[]> {
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    output.push(String(value));
  });
  await program(register).parseAsync(['node', 'test', '--json', ...argv]);
  const parsed = JSON.parse(output.at(-1) ?? '{}') as { data?: Array<{ id: string }> };
  return (parsed.data ?? []).map((row) => row.id);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.rowsByTable = {};
  mocks.predicates = [];
  mocks.supabase.from.mockImplementation((table: string) => newQuery(table));
});

describe('complete CLI list commands', () => {
  it('returns every project and restores created-at display order', async () => {
    mocks.rowsByTable.projects_with_access = [
      { id: 'a', name: 'A', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', name: 'B', created_at: '2026-01-03T00:00:00Z' },
      { id: 'c', name: 'C', created_at: '2026-01-02T00:00:00Z' },
    ];

    await expect(listIds(registerProjectsCommands, ['projects', 'list'])).resolves.toEqual([
      'b',
      'c',
      'a',
    ]);
    const expectedPredicates = [
      {
        table: 'projects_with_access',
        operator: 'eq' as const,
        column: 'workspace_id',
        value: 'workspace-1',
      },
      {
        table: 'projects_with_access',
        operator: 'neq' as const,
        column: 'state',
        value: 'deleted',
      },
    ];
    expect(mocks.predicates).toEqual(Array.from({ length: 3 }, () => expectedPredicates).flat());
  });

  it('returns every schedule and restores created-at display order', async () => {
    mocks.rowsByTable.schedule_jobs = [
      { id: 'a', name: 'A', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', name: 'B', created_at: '2026-01-03T00:00:00Z' },
      { id: 'c', name: 'C', created_at: '2026-01-02T00:00:00Z' },
    ];

    await expect(listIds(registerSchedulesCommands, ['schedules', 'list'])).resolves.toEqual([
      'b',
      'c',
      'a',
    ]);
    const expectedPredicates = [
      {
        table: 'schedule_jobs',
        operator: 'eq' as const,
        column: 'workspace_id',
        value: 'workspace-1',
      },
      {
        table: 'schedule_jobs',
        operator: 'neq' as const,
        column: 'state',
        value: 'deleted',
      },
    ];
    expect(mocks.predicates).toEqual(Array.from({ length: 3 }, () => expectedPredicates).flat());
  });

  it('returns every workspace in deterministic name order', async () => {
    mocks.rowsByTable.workspaces_with_access = [
      { id: 'a', name: 'Zulu', api_name: 'zulu' },
      { id: 'b', name: 'Alpha', api_name: 'alpha' },
      { id: 'c', name: 'Middle', api_name: 'middle' },
    ];

    await expect(listIds(registerWorkspacesCommands, ['workspaces', 'list'])).resolves.toEqual([
      'b',
      'c',
      'a',
    ]);
    const expectedPredicates = [
      {
        table: 'workspaces_with_access',
        operator: 'neq' as const,
        column: 'state',
        value: 'deleted',
      },
    ];
    expect(mocks.predicates).toEqual(Array.from({ length: 3 }, () => expectedPredicates).flat());
  });
});
