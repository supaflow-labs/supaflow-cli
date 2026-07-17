import { describe, it, expect, afterEach } from 'vitest';
import {
  buildPreflight,
  containerIdentifier,
  getContainerStatus,
  freeDiskGb,
  isNotFound,
  readVolumeIdentity,
  volumeExists,
  ExecError,
  type ExecRunner,
} from '../../src/lib/docker.js';
import { buildRunArgs, resolveAgentApiUrl } from '../../src/commands/agents.js';

/**
 * Scripted runner: each entry maps "cmd arg0 arg1 ..." prefixes to a stdout
 * response or a thrown ExecError. Unlisted commands throw a NON-not-found
 * error, mimicking an unexpected failure.
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

const NOT_FOUND = (what: string) => new ExecError(`Error: No such ${what}`, { code: 1, stderr: `Error: No such ${what}` });
const DAEMON_DOWN = new ExecError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock', { code: 1 });

const DF_OK = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 500000000 100000000 209715200 33% /\n'; // 200 GB avail
const DF_LOW = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 500000000 490000000 1048576 99% /\n'; // 1 GB avail

const NAMES = { container: 'supaflow-agent', volume: 'supaflow-agent-data', image: 'supaflow/agent:latest' };

describe('buildPreflight', () => {
  it('all green on a healthy fresh host', async () => {
    const run = scriptedRunner({
      'docker --version': 'Docker version 28.0.0',
      'docker version --format': '28.0.0\n',
      'docker inspect --format': NOT_FOUND('object: supaflow-agent'),
      'docker volume inspect': NOT_FOUND('volume: supaflow-agent-data'),
      'docker image inspect': NOT_FOUND('image: supaflow/agent:latest'),
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
      'docker version --format': DAEMON_DOWN,
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
      'docker inspect --format': NOT_FOUND('object: supaflow-agent'),
      'docker volume inspect': NOT_FOUND('volume: supaflow-agent-data'),
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
      'docker inspect --format': NOT_FOUND('object: supaflow-agent'),
      'docker volume inspect': '[]',
      'docker image inspect': '[]',
      'df -Pk /': DF_OK,
    });
    const { checks, state } = await buildPreflight(run, NAMES);
    expect(state.volumeExists).toBe(true);
    expect(checks.find((c) => c.name.startsWith('volume'))?.detail).toContain('remove --purge');
  });
});

describe('not-found vs real failures', () => {
  it('isNotFound recognizes docker not-found phrasing in message or stderr', () => {
    expect(isNotFound(NOT_FOUND('container: x'))).toBe(true);
    expect(isNotFound(NOT_FOUND('object: x'))).toBe(true);
    expect(isNotFound(DAEMON_DOWN)).toBe(false);
    expect(isNotFound(new Error('No such container'))).toBe(false); // not an ExecError
  });

  it('getContainerStatus maps not-found to missing but propagates daemon failures', async () => {
    const missing = scriptedRunner({ 'docker inspect --format': NOT_FOUND('object: supaflow-agent') });
    expect((await getContainerStatus(missing, 'supaflow-agent')).status).toBe('missing');

    const down = scriptedRunner({ 'docker inspect --format': DAEMON_DOWN });
    await expect(getContainerStatus(down, 'supaflow-agent')).rejects.toThrow('Cannot connect');
  });

  it('volumeExists maps not-found to false but propagates other errors', async () => {
    const missing = scriptedRunner({ 'docker volume inspect': NOT_FOUND('volume: v') });
    expect(await volumeExists(missing, 'v')).toBe(false);

    const down = scriptedRunner({ 'docker volume inspect': DAEMON_DOWN });
    await expect(volumeExists(down, 'v')).rejects.toThrow('Cannot connect');
  });
});

describe('getContainerStatus parsing', () => {
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
});

describe('containerIdentifier', () => {
  it('prefers the RESOURCE_INSTANCE_ID env set by the CLI', async () => {
    const run = scriptedRunner({
      'docker inspect --format {{.Id}}': 'abc123def456full|PATH=/usr/bin;RESOURCE_INSTANCE_ID=supaflow-agent-3fa2b1;HOME=/app;',
    });
    expect(await containerIdentifier(run, 'supaflow-agent')).toBe('supaflow-agent-3fa2b1');
  });

  it('falls back to the hostname convention for wizard-created containers', async () => {
    const run = scriptedRunner({
      'docker inspect --format {{.Id}}': 'abc123def456fullid|PATH=/usr/bin;HOME=/app;',
    });
    expect(await containerIdentifier(run, 'supaflow-agent')).toBe('abc123def456_local_docker_agent');
  });

  it('returns null for a missing container', async () => {
    const run = scriptedRunner({ 'docker inspect --format {{.Id}}': NOT_FOUND('object: supaflow-agent') });
    expect(await containerIdentifier(run, 'supaflow-agent')).toBeNull();
  });
});

describe('readVolumeIdentity', () => {
  const read = (script: Record<string, string | ExecError>) =>
    readVolumeIdentity(scriptedRunner(script), 'supaflow-agent-data', 'supaflow/agent:latest');

  const FULL_IDENTITY = {
    signing_identity_id: 'f4b23418-2d59-4d62-98e3-86ab9b8f1199',
    tenant_id: 'e29bf9fa-9b1a-4664-92cd-e7463112e834',
    instance_identifier: 'supaflow-agent-3fa2b1',
    cloud_provider: 'aws',
    region: 'us-east-1',
  };

  it('reads a structurally complete identity (agent_id optional)', async () => {
    expect(await read({ 'docker run --rm --entrypoint cat': JSON.stringify(FULL_IDENTITY) })).toEqual({
      kind: 'identity',
      instanceIdentifier: 'supaflow-agent-3fa2b1',
      agentId: null,
    });
    expect(
      await read({
        'docker run --rm --entrypoint cat': JSON.stringify({ ...FULL_IDENTITY, agent_id: '80f7eb5b-7710-4c52-89a2-7846476e1134' }),
      }),
    ).toEqual({
      kind: 'identity',
      instanceIdentifier: 'supaflow-agent-3fa2b1',
      agentId: '80f7eb5b-7710-4c52-89a2-7846476e1134',
    });
  });

  // execFile puts the FULL command line -- which contains
  // /data/identity.json -- into err.message. Fixtures model that real
  // shape so the classifier cannot pass by matching the command echo.
  const PROBE_CMD =
    'Command failed: docker run --rm --entrypoint cat -v supaflow-agent-data:/data:ro supaflow/agent:latest /data/identity.json';

  it('reports missing only for cat not-found about identity.json in stderr with exit code 1', async () => {
    expect(
      await read({
        'docker run --rm --entrypoint cat': new ExecError(
          `${PROBE_CMD}\ncat: /data/identity.json: No such file or directory`,
          { code: 1, stderr: 'cat: /data/identity.json: No such file or directory\n' },
        ),
      }),
    ).toEqual({ kind: 'missing' });
  });

  it('accepts the busybox not-found phrasing', async () => {
    expect(
      await read({
        'docker run --rm --entrypoint cat': new ExecError(
          `${PROBE_CMD}\ncat: can't open '/data/identity.json': No such file or directory`,
          { code: 1, stderr: "cat: can't open '/data/identity.json': No such file or directory\n" },
        ),
      }),
    ).toEqual({ kind: 'missing' });
  });

  it('propagates storage failures even though err.message echoes the identity path', async () => {
    // Real defaultRunner shape: message carries the command (and thus the
    // /data/identity.json string) while stderr describes an unrelated
    // overlay2 path. Must NOT classify as an empty volume.
    await expect(
      read({
        'docker run --rm --entrypoint cat': new ExecError(
          `${PROBE_CMD}\nfailed to create shim task: open /var/lib/docker/overlay2/abc/merged: no such file or directory`,
          { code: 125, stderr: 'failed to create shim task: open /var/lib/docker/overlay2/abc/merged: no such file or directory\n' },
        ),
      }),
    ).rejects.toThrow('overlay2');
  });

  it('propagates identity-path not-found with a non-cat exit code (daemon-level failure)', async () => {
    await expect(
      read({
        'docker run --rm --entrypoint cat': new ExecError(
          `${PROBE_CMD}\nmount: /data/identity.json: no such file or directory`,
          { code: 126, stderr: 'mount: /data/identity.json: no such file or directory\n' },
        ),
      }),
    ).rejects.toThrow('mount');
  });

  it('reports corrupt for unparseable identity content instead of treating it as empty', async () => {
    expect(await read({ 'docker run --rm --entrypoint cat': 'not-json' })).toEqual({
      kind: 'corrupt',
      reason: 'identity.json is not valid JSON',
    });
  });

  it('mirrors the agent identity invariants: incomplete identities are corrupt, not resumable', async () => {
    // The agent requires all five fields non-blank (IdentityJson.validateInvariants)
    // and fails closed otherwise; resuming on instance_identifier alone would
    // poll a container that never boots.
    expect(await read({ 'docker run --rm --entrypoint cat': JSON.stringify({ instance_identifier: 'x' }) })).toEqual({
      kind: 'corrupt',
      reason: 'identity.json is incomplete (missing or blank: signing_identity_id, tenant_id, cloud_provider, region)',
    });
    expect(
      await read({ 'docker run --rm --entrypoint cat': JSON.stringify({ ...FULL_IDENTITY, tenant_id: '  ' }) }),
    ).toEqual({
      kind: 'corrupt',
      reason: 'identity.json is incomplete (missing or blank: tenant_id)',
    });
  });

  it('propagates execution failures (daemon down, pull failure) instead of reporting an empty volume', async () => {
    await expect(read({ 'docker run --rm --entrypoint cat': DAEMON_DOWN })).rejects.toThrow('Cannot connect');
    await expect(
      read({
        'docker run --rm --entrypoint cat': new ExecError(
          'Unable to find image; pull access denied for supaflow/agent',
          { code: 125, stderr: 'pull access denied' },
        ),
      }),
    ).rejects.toThrow('pull access denied');
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
  it('mirrors the wizard command plus a stable identifier for fresh enrollment', () => {
    const args = buildRunArgs({
      container: 'supaflow-agent',
      volume: 'supaflow-agent-data',
      image: 'supaflow/agent:latest',
      instanceId: 'supaflow-agent-3fa2b1',
      token: 'supa_otp_aws_us-east-1_abc',
    });
    expect(args).toEqual([
      'run', '-d', '--name', 'supaflow-agent', '--restart', 'unless-stopped',
      '-v', 'supaflow-agent-data:/data',
      '-e', 'RESOURCE_INSTANCE_ID=supaflow-agent-3fa2b1',
      '-e', 'AGENT_REGISTRATION_TOKEN=supa_otp_aws_us-east-1_abc',
      'supaflow/agent:latest',
    ]);
  });

  it('omits the token for volume-resume starts and appends the api-url override', () => {
    const args = buildRunArgs({
      container: 'supaflow-agent',
      volume: 'supaflow-agent-data',
      image: 'supaflow/agent:latest',
      instanceId: 'supaflow-agent-3fa2b1',
      apiUrl: 'http://host.docker.internal:3000',
    });
    expect(args.join(' ')).not.toContain('AGENT_REGISTRATION_TOKEN');
    expect(args).toContain('RESOURCE_INSTANCE_ID=supaflow-agent-3fa2b1');
    expect(args).toContain('SUPAFLOW_API_URL=http://host.docker.internal:3000');
    expect(args[args.length - 1]).toBe('supaflow/agent:latest');
  });

  it('adds the host-gateway mapping only when the api url targets host.docker.internal', () => {
    const local = buildRunArgs({
      container: 'supaflow-agent',
      volume: 'supaflow-agent-data',
      image: 'supaflow/agent:latest',
      apiUrl: 'http://host.docker.internal:3000',
    });
    // Native Docker Engine on Linux does not resolve host.docker.internal
    // without this mapping; flags must precede the image ref.
    const flagIdx = local.indexOf('--add-host');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(local[flagIdx + 1]).toBe('host.docker.internal:host-gateway');
    expect(local[local.length - 1]).toBe('supaflow/agent:latest');

    const prod = buildRunArgs({
      container: 'supaflow-agent',
      volume: 'supaflow-agent-data',
      image: 'supaflow/agent:latest',
      apiUrl: 'https://app.supa-flow.io',
    });
    expect(prod).not.toContain('--add-host');
  });
});

describe('resolveAgentApiUrl', () => {
  const savedAppUrl = process.env.SUPAFLOW_APP_URL;
  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.SUPAFLOW_APP_URL;
    else process.env.SUPAFLOW_APP_URL = savedAppUrl;
  });

  it('defaults to production when no override or env is set', () => {
    delete process.env.SUPAFLOW_APP_URL;
    expect(resolveAgentApiUrl()).toBe('https://app.supa-flow.io');
  });

  it('derives from SUPAFLOW_APP_URL, rewriting localhost so the container can reach the host app', () => {
    process.env.SUPAFLOW_APP_URL = 'http://localhost:3000';
    expect(resolveAgentApiUrl()).toBe('http://host.docker.internal:3000');
    process.env.SUPAFLOW_APP_URL = 'http://127.0.0.1:3000';
    expect(resolveAgentApiUrl()).toBe('http://host.docker.internal:3000');
  });

  it('does not rewrite non-localhost SUPAFLOW_APP_URL hosts', () => {
    process.env.SUPAFLOW_APP_URL = 'https://stage.example.io';
    expect(resolveAgentApiUrl()).toBe('https://stage.example.io');
  });

  it('passes an explicit override through verbatim', () => {
    process.env.SUPAFLOW_APP_URL = 'http://localhost:3000';
    expect(resolveAgentApiUrl('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000');
  });
});
