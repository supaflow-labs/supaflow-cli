import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  registerBuiltConnector,
  registeredConnectorStatus,
} from '../../src/lib/connector-registration.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fixtureRoots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'supaflow-connector-registration-'));
  fixtureRoots.push(root);
  const manifest = 'manifest_version: 1\n';
  const runtime = 'runtime fixture';
  const projection = 'project fixture';
  const deps = 'dependency fixture';
  const wheel = 'wheel fixture';
  const wheelPath = 'wheels/example-1.2.3.dev1-py3-none-any.whl';
  const lock = JSON.stringify({
    schemaVersion: 1,
    manifest: { path: 'connector.yaml', sha256: digest(manifest) },
    connectorWheel: { path: wheelPath, sha256: digest(wheel) },
    runtimeLockSha256: digest(runtime),
    dependencyLockSha256: digest(
      JSON.stringify({
        'deps/pyproject.toml': digest(projection),
        'deps/uv.lock': digest(deps),
      }),
    ),
  });
  await mkdir(join(root, 'wheels'));
  await mkdir(join(root, 'deps'));
  for (const [path, bytes] of Object.entries({
    'connector.yaml': manifest,
    'connector.lock': lock,
    'runtime.lock': runtime,
    'deps/pyproject.toml': projection,
    'deps/uv.lock': deps,
    [wheelPath]: wheel,
  }))
    await writeFile(join(root, path), bytes);
  return { root, lock, manifest, wheelPath };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('sends only checked artifact metadata and accepts the exact lock receipt', async () => {
  const { root, lock, manifest } = await fixture();
  vi.stubEnv('SUPAFLOW_APP_URL', 'http://localhost:3000');
  const receipt = {
    connector_id: 'id',
    version_id: 'version-id',
    type: 'COM_EXAMPLE__EXAMPLE',
    version: '1.2.3.dev1',
    created: true,
    lock_sha256: digest(lock),
  };
  const request = vi.fn().mockResolvedValue(Response.json(receipt));
  vi.stubGlobal('fetch', request);
  await expect(registerBuiltConnector(root, 'test-session')).resolves.toEqual(receipt);
  expect(request.mock.calls[0][0].pathname).toBe('/api/cli/connectors/register');
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ lock, manifest });
});

it('rejects a mutated wheel before reaching the server', async () => {
  const { root, wheelPath } = await fixture();
  await writeFile(join(root, wheelPath), 'changed');
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  await expect(registerBuiltConnector(root, 'test-session')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(request).not.toHaveBeenCalled();
});

it('reads registration status through the existing version RPC without writing', async () => {
  const { root, lock } = await fixture();
  const rpc = vi
    .fn()
    .mockResolvedValue({ data: [{ wheel_lock_sha256: digest(lock) }], error: null });
  const client = { rpc } as unknown as Parameters<typeof registeredConnectorStatus>[2];
  await expect(registeredConnectorStatus(root, 'version-id', client)).resolves.toMatchObject({
    status: 'registered',
  });
  rpc.mockResolvedValue({ data: [{ wheel_lock_sha256: 'b'.repeat(64) }], error: null });
  await expect(registeredConnectorStatus(root, 'version-id', client)).resolves.toMatchObject({
    status: 'different_artifact',
  });
  rpc.mockResolvedValue({ data: [], error: null });
  await expect(registeredConnectorStatus(root, 'version-id', client)).resolves.toMatchObject({
    status: 'unavailable',
  });
  expect(rpc).toHaveBeenCalledWith('get_connector_version', { connectorVersionId: 'version-id' });
});
