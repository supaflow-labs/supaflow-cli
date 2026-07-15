import { describe, it, expect } from 'vitest';
import {
  buildPreflight,
  getContainerStatus,
  freeDiskGb,
  ExecError,
  type ExecRunner,
} from '../../src/lib/docker.js';
import { buildRunArgs } from '../../src/commands/agents.js';

/**
 * Scripted runner: each entry maps "cmd arg0 arg1 ..." prefixes to a stdout
 * response or a thrown ExecError. Unlisted commands throw, mimicking a
 * failing binary.
 */
function scriptedRunner(script: Record<string, string | ExecError>): ExecRunner {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    for (const [prefix, result] of Object.entries(script)) {
      if (key.startsWith(prefix)) {
        if (result instanceof ExecError) throw result;
        return { stdout: result, stderr: '' };
      }
    }
    throw new ExecError(`unscripted: ${key}`, { code: 1 });
  };
}

const DF_OK = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 500000000 100000000 209715200 33% /\n'; // 200 GB avail
const DF_LOW = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 500000000 490000000 1048576 99% /\n'; // 1 GB avail

const NAMES = { container: 'supaflow-agent', volume: 'supaflow-agent-data', image: 'supaflow/agent:latest' };

describe('buildPreflight', () => {
  it('all green on a healthy fresh host', async () => {
    const run = scriptedRunner({
      'docker --version': 'Docker version 28.0.0',
      'docker version --format': '28.0.0\n',
      'docker inspect --format {{.State.Status}} {{.Config.Image}} supaflow-agent': new ExecError('no such container', { code: 1 }),
      'docker volume inspect': new ExecError('no such volume', { code: 1 }),
      'docker image inspect': new ExecError('no such image', { code: 1 }),
      'df -Pk /': DF_OK,
    });
    const { checks, ok, state } = await buildPreflight(run, NAMES);
    expect(ok).toBe(true);
    expect(state.containerStatus).toBe('missing');
    expect(state.volumeExists).toBe(false);
    expect(checks.find((c) => c.name === 'disk space')?.status).toBe('ok');
    expect(checks.find((c) => c.name.startsWith('image'))?.detail).toContain('pulled');
  });

  it('fails when the docker binary is missing', async () => {
    const run = scriptedRunner({
      'docker --version': new ExecError('spawn docker ENOENT', { code: 'ENOENT' }),
      'df -Pk /': DF_OK,
    });
    const { checks, ok } = await buildPreflight(run, NAMES);
    expect(ok).toBe(false);
    const binary = checks.find((c) => c.name === 'docker binary');
    expect(binary?.status).toBe('fail');
    expect(binary?.detail).toContain('Install Docker');
  });

  it('fails when the daemon is not reachable', async () => {
    const run = scriptedRunner({
      'docker --version': 'Docker version 28.0.0',
      'docker version --format': new ExecError('Cannot connect to the Docker daemon', { code: 1 }),
      'df -Pk /': DF_OK,
    });
    const { checks, ok } = await buildPreflight(run, NAMES);
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'docker daemon')?.status).toBe('fail');
  });

  it('warns (does not fail) on low disk space', async () => {
    const run = scriptedRunner({
      'docker --version': 'Docker version 28.0.0',
      'docker version --format': '28.0.0\n',
      'docker inspect --format': new ExecError('no such container', { code: 1 }),
      'docker volume inspect': new ExecError('no such volume', { code: 1 }),
      'docker image inspect': '[]',
      'df -Pk /': DF_LOW,
    });
    const { checks, ok } = await buildPreflight(run, NAMES);
    expect(ok).toBe(true);
    const disk = checks.find((c) => c.name === 'disk space');
    expect(disk?.status).toBe('warn');
    expect(disk?.detail).toContain('GB free');
  });

  it('reports an existing identity volume with re-enroll guidance', async () => {
    const run = scriptedRunner({
      'docker --version': 'Docker version 28.0.0',
      'docker version --format': '28.0.0\n',
      'docker inspect --format': new ExecError('no such container', { code: 1 }),
      'docker volume inspect': '[]',
      'docker image inspect': '[]',
      'df -Pk /': DF_OK,
    });
    const { checks, state } = await buildPreflight(run, NAMES);
    expect(state.volumeExists).toBe(true);
    expect(checks.find((c) => c.name.startsWith('volume'))?.detail).toContain('remove --purge');
  });
});

describe('getContainerStatus', () => {
  it('parses running state and image', async () => {
    const run = scriptedRunner({ 'docker inspect --format': 'running supaflow/agent:latest\n' });
    expect(await getContainerStatus(run, 'supaflow-agent')).toEqual({
      status: 'running',
      image: 'supaflow/agent:latest',
    });
  });

  it('maps any non-running state to exited', async () => {
    const run = scriptedRunner({ 'docker inspect --format': 'exited supaflow/agent:latest\n' });
    expect((await getContainerStatus(run, 'supaflow-agent')).status).toBe('exited');
  });

  it('maps inspect failure to missing', async () => {
    const run = scriptedRunner({});
    expect((await getContainerStatus(run, 'supaflow-agent')).status).toBe('missing');
  });
});

describe('freeDiskGb', () => {
  it('parses df -Pk output', async () => {
    const run = scriptedRunner({ 'df -Pk /': DF_OK });
    expect(await freeDiskGb(run)).toBe(200);
  });

  it('returns null when df is unavailable', async () => {
    const run = scriptedRunner({});
    expect(await freeDiskGb(run)).toBeNull();
  });
});

describe('buildRunArgs', () => {
  it('mirrors the wizard command for a fresh enrollment', () => {
    const args = buildRunArgs({
      container: 'supaflow-agent',
      volume: 'supaflow-agent-data',
      image: 'supaflow/agent:latest',
      token: 'supa_otp_aws_us-east-1_abc',
    });
    expect(args).toEqual([
      'run', '-d', '--name', 'supaflow-agent', '--restart', 'unless-stopped',
      '-v', 'supaflow-agent-data:/data',
      '-e', 'AGENT_REGISTRATION_TOKEN=supa_otp_aws_us-east-1_abc',
      'supaflow/agent:latest',
    ]);
  });

  it('omits the token for volume-resume starts and appends the api-url override', () => {
    const args = buildRunArgs({
      container: 'supaflow-agent',
      volume: 'supaflow-agent-data',
      image: 'supaflow/agent:latest',
      apiUrl: 'http://host.docker.internal:3000',
    });
    expect(args.join(' ')).not.toContain('AGENT_REGISTRATION_TOKEN');
    expect(args).toContain('SUPAFLOW_API_URL=http://host.docker.internal:3000');
    expect(args[args.length - 1]).toBe('supaflow/agent:latest');
  });
});
