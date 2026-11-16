import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/connector-lock.js', async (original) => {
  const module = await original<typeof import('../src/lib/connector-lock.js')>();
  return { ...module, refreshConnectorDependencyLocks: vi.fn() };
});
import {
  refreshConnectorDependencyLocks,
  ConnectorLockOperationError,
} from '../src/lib/connector-lock.js';
import { ToolchainTransportError } from '../src/lib/connector-toolchain.js';
import {
  registerConnectorLockCommand,
  type ConnectorLockBootstrap,
} from '../src/commands/connector-lock.js';
const bootstrap = vi.fn<ConnectorLockBootstrap>();
const tools = {
  pythonExecutable: '/fixture/python',
  uvExecutable: '/fixture/uv',
  nodeExecutable: '/fixture/node',
};
let logs: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
let originalExit: typeof process.exitCode;
let listeners: Function[][];
beforeEach(() => {
  vi.clearAllMocks();
  originalExit = process.exitCode;
  process.exitCode = undefined;
  listeners = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
  bootstrap.mockResolvedValue(tools);
  vi.mocked(refreshConnectorDependencyLocks).mockResolvedValue();
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = originalExit;
  expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(listeners);
  vi.restoreAllMocks();
});
function parse(args: string[]) {
  const root = new Command().version('0.0.0').exitOverride().option('--json');
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerConnectorLockCommand(root.command('connectors'), bootstrap, { timeoutMs: 17_000 });
  return root.parseAsync(['node', 'supaflow', ...args]);
}
const output = () => {
  expect(logs).toHaveBeenCalledTimes(1);
  return JSON.parse(logs.mock.calls[0][0] as string);
};
describe('inactive ordinary connector lock command', () => {
  it('keeps shipped lock inactive', () => {
    const help = execFileSync(process.execPath, ['bin/supaflow.mjs', 'connectors', '--help'], {
      encoding: 'utf8',
    });
    expect(help).not.toMatch(/^\s+lock\b/m);
  });
  it.each([true, false])('locks with exact offline=%s and one JSON result', async (offline) => {
    const projectDir = resolve('./project ; path');
    await parse([
      '--json',
      'connectors',
      'lock',
      '--project',
      projectDir,
      ...(offline ? ['--offline'] : []),
    ]);
    expect(bootstrap).toHaveBeenCalledExactlyOnceWith(projectDir, {
      offline,
      signal: expect.any(AbortSignal),
    });
    expect(refreshConnectorDependencyLocks).toHaveBeenCalledExactlyOnceWith(projectDir, tools, {
      offline,
      signal: bootstrap.mock.calls[0][1].signal,
      timeoutMs: 17_000,
    });
    expect(output()).toEqual({ locked: true });
    expect(errors).not.toHaveBeenCalled();
  });
  it('uses current directory and plain output', async () => {
    await parse(['connectors', 'lock']);
    expect(bootstrap.mock.calls[0][0]).toBe(process.cwd());
    expect(logs).toHaveBeenCalledExactlyOnceWith(
      'Dependency locks updated; runtime.lock preserved.',
    );
  });
  it.each(['', ' ', 'bad\0path'])(
    'rejects malformed project before bootstrap: %j',
    async (project) => {
      await parse(['--json', 'connectors', 'lock', '--project', project]);
      expect(bootstrap).not.toHaveBeenCalled();
      expect(output().error.code).toBe('INVALID_INPUT');
    },
  );
  it.each([['--help'], ['--upgrade-runtime'], ['extra'], ['--project']])(
    'does not bootstrap for parser exits: %j',
    async (...args) => {
      await expect(parse(['connectors', 'lock', ...args])).rejects.toThrow();
      expect(bootstrap).not.toHaveBeenCalled();
    },
  );
  it.each([
    new ConnectorLockOperationError('LOCK_FAILED', 'Fix the graph'),
    new ToolchainTransportError('TIMEOUT', 'Timed out'),
  ])('preserves typed errors: %j', async (error) => {
    vi.mocked(refreshConnectorDependencyLocks).mockRejectedValue(error);
    await parse(['--json', 'connectors', 'lock']);
    expect(output()).toEqual({ error: { code: error.code, message: error.message } });
    expect(process.exitCode).toBe(1);
  });
  it('redacts unexpected errors', async () => {
    bootstrap.mockRejectedValue(new Error('PRIVATE_LOCK_DETAIL'));
    await parse(['--json', 'connectors', 'lock']);
    expect(JSON.stringify(output())).not.toContain('PRIVATE_LOCK_DETAIL');
    expect(process.exitCode).toBe(1);
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('cancels bootstrap with %s', async (signal) => {
    bootstrap.mockImplementation(
      (_project, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new ToolchainTransportError('CANCELLED', 'cancelled')),
            { once: true },
          ),
        ),
    );
    const pending = parse(['--json', 'connectors', 'lock']);
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    process.emit(signal);
    await pending;
    expect(output().error.code).toBe('CANCELLED');
    expect(process.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(refreshConnectorDependencyLocks).not.toHaveBeenCalled();
  });
  it('reports a completed publication when a late signal arrives', async () => {
    vi.mocked(refreshConnectorDependencyLocks).mockImplementation(async () => {
      process.emit('SIGINT');
    });
    await parse(['--json', 'connectors', 'lock']);
    expect(output()).toEqual({ locked: true });
    expect(process.exitCode).toBeUndefined();
  });
  it('preserves publication recovery diagnostics despite cancellation', async () => {
    vi.mocked(refreshConnectorDependencyLocks).mockImplementation(async () => {
      process.emit('SIGINT');
      throw new ConnectorLockOperationError(
        'LOCK_PUBLICATION_FAILED',
        'Review the generated files and rerun lock',
      );
    });
    await parse(['--json', 'connectors', 'lock']);
    expect(output().error.code).toBe('LOCK_PUBLICATION_FAILED');
    expect(process.exitCode).toBe(1);
  });
});
