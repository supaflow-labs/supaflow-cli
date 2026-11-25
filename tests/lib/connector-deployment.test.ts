import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deployBuiltConnector } from '../../src/lib/connector-deployment.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/connector-registration.js', () => ({
  readBuiltConnector: vi.fn(async () => ({ lockSha256: 'a'.repeat(64) })),
}));

describe('local connector deployment', () => {
  const run = vi.fn();
  beforeEach(() => {
    run.mockReset();
    run.mockImplementation(async (_command, args: string[]) => ({
      stdout:
        args[0] === 'inspect'
          ? 'running agent-image sha256:image'
          : args.includes('mktemp')
            ? '/tmp/connector-deploy.12345678\n'
            : '',
      stderr: '',
    }));
  });

  it('uses only local Docker transport, the agent installer and exact build identity', async () => {
    const artifact = await mkdtemp(join(tmpdir(), 'deployment-'));
    try {
      const result = await deployBuiltConnector(
        { artifact, name: 'my-agent', runtimeWheels: artifact },
        run,
      );
      expect(result).toEqual({
        status: 'prepared',
        container: 'my-agent',
        artifact_lock_sha256: 'a'.repeat(64),
      });
      expect(run.mock.calls.every(([command]) => command === 'docker')).toBe(true);
      expect(run.mock.calls.find(([, args]) => args.includes('-c'))?.[1].join(' ')).toContain(
        'install-local-wheel',
      );
      expect(run.mock.calls.filter(([, args]) => args[0] === 'cp')).toHaveLength(2);
      expect(run.mock.calls.at(-1)?.[1]).toEqual([
        'exec',
        'my-agent',
        'rm',
        '-rf',
        '--',
        '/tmp/connector-deploy.12345678',
      ]);
    } finally {
      await rm(artifact, { recursive: true });
    }
  });

  it('keeps a successful preparation result if staging cleanup fails', async () => {
    const artifact = await mkdtemp(join(tmpdir(), 'deployment-'));
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      run.mockImplementation(async (_command, args: string[]) => {
        if (args.includes('rm')) throw new Error('container stopped');
        return {
          stdout:
            args[0] === 'inspect'
              ? 'running image sha256:image'
              : args.includes('mktemp')
                ? '/tmp/connector-deploy.12345678\n'
                : '',
          stderr: '',
        };
      });
      await expect(
        deployBuiltConnector({ artifact, name: 'my-agent' }, run),
      ).resolves.toMatchObject({ status: 'prepared' });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      await rm(artifact, { recursive: true });
    }
  });

  it('cleans its staging on preparation failure and never starts or restarts an agent', async () => {
    const artifact = await mkdtemp(join(tmpdir(), 'deployment-'));
    try {
      run.mockImplementation(async (_command, args: string[]) => {
        if (args.includes('-c')) throw new Error('private process output');
        return {
          stdout:
            args[0] === 'inspect'
              ? 'running image sha256:image'
              : args.includes('mktemp')
                ? '/tmp/connector-deploy.12345678\n'
                : '',
          stderr: '',
        };
      });
      await expect(deployBuiltConnector({ artifact, name: 'my-agent' }, run)).rejects.toThrow(
        'Local deployment failed',
      );
      expect(run.mock.calls.at(-1)?.[1]).toContain('rm');
      expect(run.mock.calls.some(([, args]) => ['start', 'restart', 'run'].includes(args[0]))).toBe(
        false,
      );
    } finally {
      await rm(artifact, { recursive: true });
    }
  });
});
