import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query: any = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    in: vi.fn(),
    ilike: vi.fn(),
    gt: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    range: vi.fn(),
  };
  for (const method of ['select', 'eq', 'neq', 'in', 'ilike', 'gt', 'order', 'limit', 'range']) {
    query[method].mockReturnValue(query);
  }
  query.then = (
    resolve: (value: { data: unknown[]; error: null; count: number }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);

  return {
    query,
    supabase: { from: vi.fn(() => query) },
  };
});

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

import { registerDatasourcesCommands } from '../src/commands/datasources.js';
import { registerJobsCommands } from '../src/commands/jobs.js';
import { registerPipelinesCommands } from '../src/commands/pipelines.js';

function program(register: (command: Command) => void): Command {
  const command = new Command();
  command.exitOverride().option('--json', 'Output as JSON');
  register(command);
  return command;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ['select', 'eq', 'neq', 'in', 'ilike', 'gt', 'order', 'limit', 'range']) {
    mocks.query[method].mockReturnValue(mocks.query);
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('CLI offset list ordering', () => {
  it('documents mutable-sort offsets as independent live views', () => {
    const datasourceProgram = program(registerDatasourcesCommands);
    const pipelineProgram = program(registerPipelinesCommands);
    const datasourceList = datasourceProgram.commands
      .find((command) => command.name() === 'datasources')
      ?.commands.find((command) => command.name() === 'list');
    const pipelineList = pipelineProgram.commands
      .find((command) => command.name() === 'pipelines')
      ?.commands.find((command) => command.name() === 'list');
    const jobsProgram = program(registerJobsCommands);
    const jobsList = jobsProgram.commands
      .find((command) => command.name() === 'jobs')
      ?.commands.find((command) => command.name() === 'list');

    const datasourceHelp = datasourceList?.helpInformation().replace(/\s+/g, ' ');
    const pipelineHelp = pipelineList?.helpInformation().replace(/\s+/g, ' ');

    expect(datasourceHelp).toContain(
      'fresh live result; concurrent updates can move rows between calls',
    );
    expect(pipelineHelp).toContain(
      'fresh live result; concurrent updates can move rows between calls',
    );
    expect(jobsList?.helpInformation().replace(/\s+/g, ' ')).toContain(
      'fresh live result; concurrent inserts can move rows between calls',
    );

    const initial = [
      { id: 'a', updatedAt: 4 },
      { id: 'b', updatedAt: 3 },
      { id: 'c', updatedAt: 2 },
      { id: 'd', updatedAt: 1 },
    ];
    const order = (rows: typeof initial) =>
      [...rows].sort(
        (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      );
    const firstPage = order(initial).slice(0, 2);
    const afterUpdate = initial.map((row) => (row.id === 'd' ? { ...row, updatedAt: 5 } : row));
    const secondPage = order(afterUpdate).slice(2, 4);
    const combined = [...firstPage, ...secondPage].map((row) => row.id);

    expect(combined).toEqual(['a', 'b', 'b', 'c']);
    expect(combined).not.toContain('d');
  });

  it('adds datasource ID after updated_at', async () => {
    await program(registerDatasourcesCommands).parseAsync([
      'node',
      'test',
      '--json',
      'datasources',
      'list',
    ]);

    expect(mocks.query.order.mock.calls).toEqual([
      ['updated_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('adds pipeline ID after the selected user-facing sort', async () => {
    await program(registerPipelinesCommands).parseAsync([
      'node',
      'test',
      '--json',
      'pipelines',
      'list',
      '--sort',
      'updated_at',
      '--order',
      'desc',
    ]);

    expect(mocks.query.order.mock.calls).toEqual([
      ['pipeline_updated_at', { ascending: false }],
      ['pipeline_id', { ascending: true }],
    ]);
  });

  it('adds job ID after created_at', async () => {
    await program(registerJobsCommands).parseAsync(['node', 'test', '--json', 'jobs', 'list']);

    expect(mocks.query.order.mock.calls).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('offers immutable ID cursors for complete datasource and pipeline scans', async () => {
    await program(registerDatasourcesCommands).parseAsync([
      'node',
      'test',
      '--json',
      'datasources',
      'list',
      '--sort',
      'id',
      '--after-id',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(mocks.query.order.mock.calls).toEqual([['id', { ascending: true }]]);
    expect(mocks.query.gt).toHaveBeenCalledWith('id', '00000000-0000-4000-8000-000000000001');
    expect(mocks.query.range).not.toHaveBeenCalled();
    expect(mocks.query.limit).toHaveBeenCalledWith(25);

    vi.clearAllMocks();
    for (const method of ['select', 'eq', 'neq', 'in', 'ilike', 'gt', 'order', 'limit', 'range']) {
      mocks.query[method].mockReturnValue(mocks.query);
    }

    await program(registerPipelinesCommands).parseAsync([
      'node',
      'test',
      '--json',
      'pipelines',
      'list',
      '--sort',
      'id',
      '--order',
      'asc',
      '--after-id',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(mocks.query.order.mock.calls).toEqual([['pipeline_id', { ascending: true }]]);
    expect(mocks.query.gt).toHaveBeenCalledWith(
      'pipeline_id',
      '00000000-0000-4000-8000-000000000002',
    );
    expect(mocks.query.range).not.toHaveBeenCalled();
    expect(mocks.query.limit).toHaveBeenCalledWith(25);
  });
});
