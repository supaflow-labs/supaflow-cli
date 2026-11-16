import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (original) => {
  const module = await original<typeof import('node:fs/promises')>();
  return { ...module, rename: vi.fn(module.rename) };
});
vi.mock('../../src/lib/connector-toolchain.js', async (original) => ({
  ...(await original<typeof import('../../src/lib/connector-toolchain.js')>()),
  runConnectorToolchain: vi.fn(),
}));
import { runConnectorToolchain } from '../../src/lib/connector-toolchain.js';
import { upgradeConnectorRuntimeLocks } from '../../src/lib/connector-lock.js';
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const files = ['runtime.lock', 'deps/pyproject.toml', 'deps/uv.lock'];
const old = ['old runtime selection\n', 'old dependency metadata\n', 'old dependency lock\n'];
const next = ['new runtime selection\n', 'new dependency metadata\n', 'new dependency lock\n'];
const tools = {
  pythonExecutable: '/tools/python',
  uvExecutable: '/tools/uv',
  agentTargets: [{ name: 'wire-fixture', environment: {}, wheelTags: ['py3-none-any'] }],
};
const selection = {
  sdkVersion: '1.2.4',
  runtimeVersion: null,
  requiredHostProtocol: 2,
  agentExecutionPython: '>=3.14,<3.15',
};
let root: string, output: string;
beforeEach(async () => {
  vi.clearAllMocks();
  output = '';
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  root = await fs.mkdtemp(join(tmpdir(), 'supaflow runtime upgrade ; '));
  await fs.mkdir(join(root, 'deps'));
  await fs.writeFile(join(root, 'pyproject.toml'), 'authored root constraints');
  await fs.writeFile(join(root, 'deps/uv.toml'), 'authored registry configuration');
  await Promise.all(
    files.map((name, i) => fs.writeFile(join(root, name), old[i], { mode: 0o600 })),
  );
  vi.mocked(runConnectorToolchain).mockImplementation(async (_python, request) => {
    if (request.operation !== 'runtime.propose') throw Error('Unexpected operation');
    output = request.options.outputDir;
    await fs.mkdir(join(output, 'deps'), { recursive: true });
    await Promise.all(files.map((name, i) => fs.writeFile(join(output, name), next[i])));
    return { protocolVersion: 1, ok: true, result: { proposalDir: output } };
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  if (output) await expect(fs.stat(dirname(output))).rejects.toMatchObject({ code: 'ENOENT' });
});
const contents = () => Promise.all(files.map((name) => fs.readFile(join(root, name), 'utf8')));
const run = (signal?: AbortSignal) =>
  upgradeConnectorRuntimeLocks(root, tools, selection, { offline: true, signal });

it('publishes the checked three-file selection and returns exact bytes for the diff', async () => {
  const change = await run();
  expect(change).toEqual({ before: Buffer.from(old[0]), after: Buffer.from(next[0]) });
  expect(await contents()).toEqual(next);
  expect(await fs.readFile(join(root, 'pyproject.toml'), 'utf8')).toBe('authored root constraints');
  expect(await fs.readFile(join(root, 'deps/uv.toml'), 'utf8')).toBe(
    'authored registry configuration',
  );
  expect(vi.mocked(runConnectorToolchain).mock.calls[0][1]).toEqual({
    protocolVersion: 1,
    operation: 'runtime.propose',
    projectDir: root,
    options: {
      ...selection,
      uvExecutable: tools.uvExecutable,
      outputDir: output,
      offline: true,
      agentTargets: tools.agentTargets,
    },
  });
  if (process.platform !== 'win32')
    for (const name of files) expect((await fs.stat(join(root, name))).mode & 0o777).toBe(0o600);
});

it.each([0, 1, 2])(
  'restores every original after publication failure at file %s',
  async (position) => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (basename(String(from)) === `new-${position}`) throw Error('PRIVATE_RENAME_DETAIL');
      return actual.rename(from, to);
    });
    await expect(run()).rejects.toMatchObject({
      code: 'LOCK_PUBLICATION_FAILED',
      message: expect.stringContaining('original files restored'),
    });
    expect(await contents()).toEqual(old);
    expect(
      (await fs.readdir(join(root, 'deps'))).some((name) => name.startsWith('.supaflow-lock-')),
    ).toBe(false);
  },
);

it('retains the authoritative old runtime if rollback itself fails', async () => {
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (['new-1', 'old-0'].includes(basename(String(from)))) throw Error('PRIVATE_RENAME_DETAIL');
    return actual.rename(from, to);
  });
  await expect(run()).rejects.toMatchObject({
    code: 'LOCK_PUBLICATION_FAILED',
    message: expect.stringContaining('runtime.lock: restore old-0 if present'),
  });
  const retained = (await fs.readdir(join(root, 'deps'))).filter((name) =>
    name.startsWith('.supaflow-lock-'),
  );
  expect(retained).toHaveLength(1);
  expect(await fs.readFile(join(root, 'deps', retained[0], 'old-0'), 'utf8')).toBe(old[0]);
  expect(await contents()).toEqual([next[0], old[1], old[2]]);
});

it('rejects changed inputs after proposal without overwriting the author', async () => {
  const previous = vi.mocked(runConnectorToolchain).getMockImplementation()!;
  vi.mocked(runConnectorToolchain).mockImplementation(async (...args) => {
    const result = await previous(...args);
    await fs.writeFile(join(root, 'runtime.lock'), 'author changed the selection');
    return result;
  });
  await expect(run()).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
  expect(await contents()).toEqual(['author changed the selection', old[1], old[2]]);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('preserves a rejected candidate and never changes the project environment', async () => {
  vi.mocked(runConnectorToolchain).mockResolvedValue({
    protocolVersion: 1,
    ok: false,
    error: { code: 'LOCK_FAILED', message: 'Candidate conflicts with root metadata' },
  });
  await expect(run()).rejects.toMatchObject({ code: 'LOCK_FAILED' });
  expect(await contents()).toEqual(old);
  expect(fs.rename).not.toHaveBeenCalled();
  await expect(fs.stat(join(root, '.venv'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not replace byte-identical lock files', async () => {
  await Promise.all(files.map((name, i) => fs.writeFile(join(root, name), next[i])));
  await run();
  expect(fs.rename).not.toHaveBeenCalled();
});

it('cancels before proposal and preserves all original locks', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(run(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(runConnectorToolchain).not.toHaveBeenCalled();
  expect(await contents()).toEqual(old);
});

it('cancels after validation before publishing any candidate file', async () => {
  const controller = new AbortController();
  const previous = vi.mocked(runConnectorToolchain).getMockImplementation()!;
  vi.mocked(runConnectorToolchain).mockImplementation(async (...args) => {
    const result = await previous(...args);
    controller.abort();
    return result;
  });
  await expect(run(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await contents()).toEqual(old);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('rejects a missing explicit proposal rather than falling back to ordinary locking', async () => {
  await expect(
    upgradeConnectorRuntimeLocks(root, tools, undefined as never, { offline: true }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(runConnectorToolchain).not.toHaveBeenCalled();
  expect(await contents()).toEqual(old);
});

it.skipIf(process.platform === 'win32')(
  'preserves runtime symlinks by rejecting before proposal',
  async () => {
    const external = join(root, 'external-runtime');
    await fs.rename(join(root, 'runtime.lock'), external);
    await fs.symlink(external, join(root, 'runtime.lock'));
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(runConnectorToolchain).not.toHaveBeenCalled();
    expect(await fs.readFile(external, 'utf8')).toBe(old[0]);
  },
);
