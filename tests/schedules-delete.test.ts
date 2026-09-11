import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    single: vi.fn(),
    update: vi.fn(),
    maybeSingle: vi.fn(),
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.neq.mockReturnValue(query);
  query.update.mockReturnValue(query);

  return {
    query,
    supabase: { from: vi.fn(() => query) },
  };
});

vi.mock('../src/lib/middleware.js', () => ({
  withAuth:
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
    },
}));

import { registerSchedulesCommands } from '../src/commands/schedules.js';
import { ErrorCode } from '../src/lib/errors.js';

const SCHEDULE_ID = '13cfe303-c67e-4a5b-8f9d-1e2f3a4b5c6d';

function program(): Command {
  const command = new Command();
  command.exitOverride().option('--json', 'Output as JSON');
  registerSchedulesCommands(command);
  return command;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.select.mockReturnValue(mocks.query);
  mocks.query.eq.mockReturnValue(mocks.query);
  mocks.query.neq.mockReturnValue(mocks.query);
  mocks.query.update.mockReturnValue(mocks.query);
  mocks.query.single.mockResolvedValue({
    data: { id: SCHEDULE_ID, name: 'Daily sync', state: 'active' },
    error: null,
  });
  mocks.query.maybeSingle.mockResolvedValue({ data: { id: SCHEDULE_ID }, error: null });
});

describe('schedules delete confirmation', () => {
  it('fails closed in JSON mode without --yes', async () => {
    await expect(
      program().parseAsync(['node', 'test', '--json', 'schedules', 'delete', 'daily-sync']),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      message: 'Refusing to delete a schedule without --yes in non-interactive mode.',
    });

    expect(mocks.query.update).not.toHaveBeenCalled();
  });

  it('allows explicit --yes in JSON mode', async () => {
    await expect(
      program().parseAsync([
        'node',
        'test',
        '--json',
        'schedules',
        'delete',
        'daily-sync',
        '--yes',
      ]),
    ).resolves.toBeInstanceOf(Command);

    expect(mocks.query.update).toHaveBeenCalledWith({ state: 'deleted' });
    expect(mocks.query.maybeSingle).toHaveBeenCalledOnce();
  });
});
