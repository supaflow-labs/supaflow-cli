import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveIdentifier: vi.fn(),
  softDeleteEntity: vi.fn(),
}));

vi.mock('../src/lib/middleware.js', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      const command = args.at(-1) as Command;
      await handler(
        {
          supabase: {},
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

vi.mock('../src/lib/resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/resolve.js')>();
  return { ...actual, resolveIdentifier: mocks.resolveIdentifier };
});

vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, softDeleteEntity: mocks.softDeleteEntity };
});

import { registerPipelinesCommands } from '../src/commands/pipelines.js';
import { ErrorCode } from '../src/lib/errors.js';

const PIPELINE_ID = '13cfe303-c67e-4a5b-8f9d-1e2f3a4b5c6d';

function program(): Command {
  const command = new Command();
  command.exitOverride().option('--json', 'Output as JSON');
  registerPipelinesCommands(command);
  return command;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveIdentifier.mockResolvedValue(PIPELINE_ID);
  mocks.softDeleteEntity.mockResolvedValue(undefined);
});

describe('pipelines delete confirmation', () => {
  it('fails closed in JSON mode without --yes', async () => {
    await expect(
      program().parseAsync(['node', 'test', '--json', 'pipelines', 'delete', 'orders']),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      message: 'Refusing to delete a pipeline without --yes in non-interactive mode.',
    });

    expect(mocks.softDeleteEntity).not.toHaveBeenCalled();
  });

  it('allows explicit --yes in JSON mode', async () => {
    await expect(
      program().parseAsync(['node', 'test', '--json', 'pipelines', 'delete', 'orders', '--yes']),
    ).resolves.toBeInstanceOf(Command);

    expect(mocks.softDeleteEntity).toHaveBeenCalledWith({}, 'pipeline', PIPELINE_ID);
  });
});
