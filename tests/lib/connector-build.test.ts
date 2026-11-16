import * as fs from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
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
import { buildVersionedConnectorArtifact } from '../../src/lib/connector-build.js';
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const tools = {
  pythonExecutable: '/tools/python',
  uvExecutable: '/tools/uv',
  nodeExecutable: '/tools/node',
};
let root: string, target: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  root = await fs.mkdtemp(join(tmpdir(), 'supaflow versioned build ; '));
  target = join(root, 'dist/fixture/1.2.3.dev1');
  await fs.writeFile(join(root, 'pyproject.toml'), 'source metadata');
  vi.mocked(runConnectorToolchain).mockImplementation(async (_python, request) => {
    if (request.operation !== 'artifact.build') throw Error('Unexpected operation');
    expect(request.options.versionedOutput).toBe(true);
    const staged = join(request.options.outputDir, 'fixture/1.2.3.dev1');
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(join(staged, 'connector.lock'), 'new artifact');
    return { protocolVersion: 1, ok: true, result: { artifactDir: staged } };
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const run = (signal?: AbortSignal) =>
  buildVersionedConnectorArtifact(root, tools, { offline: true, signal });
const old = async () => {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(join(target, 'connector.lock'), 'previous artifact');
};
const content = () => fs.readFile(join(target, 'connector.lock'), 'utf8');
const temporary = async () =>
  (await fs.readdir(join(root, 'dist'))).filter((name) => name.startsWith('.supaflow-build-'));

it('publishes a checked artifact into the versioned layout', async () => {
  expect(await run()).toBe(target);
  expect(await content()).toBe('new artifact');
  expect(await temporary()).toEqual([]);
  expect(await fs.readFile(join(root, 'pyproject.toml'), 'utf8')).toBe('source metadata');
});

it('keeps the previous output until the build succeeds and preserves sibling versions', async () => {
  await old();
  const sibling = join(dirname(target), '0.9.0');
  await fs.mkdir(sibling);
  await fs.writeFile(join(sibling, 'keep'), 'sibling');
  const previous = vi.mocked(runConnectorToolchain).getMockImplementation()!;
  vi.mocked(runConnectorToolchain).mockImplementation(async (...args) => {
    expect(await content()).toBe('previous artifact');
    return previous(...args);
  });
  await run();
  expect(await content()).toBe('new artifact');
  expect(await fs.readFile(join(sibling, 'keep'), 'utf8')).toBe('sibling');
  expect(await temporary()).toEqual([]);
});

it('preserves previous output on producer rejection', async () => {
  await old();
  vi.mocked(runConnectorToolchain).mockResolvedValue({
    protocolVersion: 1,
    ok: false,
    error: { code: 'CHECK_FAILED', message: 'Manifest is stale' },
  });
  await expect(run()).rejects.toMatchObject({ code: 'CHECK_FAILED', message: 'Manifest is stale' });
  expect(await content()).toBe('previous artifact');
  expect(await temporary()).toEqual([]);
});

it('restores the previous complete artifact after a failed final rename', async () => {
  await old();
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(from).includes(sep + 'candidate' + sep)) throw Error('PRIVATE_STORAGE_DETAIL');
    return actual.rename(from, to);
  });
  await expect(run()).rejects.toMatchObject({
    code: 'BUILD_FAILED',
    message: expect.stringContaining('previous output preserved'),
  });
  expect(await content()).toBe('previous artifact');
  expect(await temporary()).toEqual([]);
});

it('retains the complete previous artifact if restoration fails', async () => {
  await old();
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(from).includes(sep + 'candidate' + sep) || basename(String(from)) === 'previous')
      throw Error('PRIVATE_STORAGE_DETAIL');
    return actual.rename(from, to);
  });
  await expect(run()).rejects.toMatchObject({
    code: 'BUILD_PUBLICATION_FAILED',
    message: expect.stringContaining('restore'),
  });
  const kept = await temporary();
  expect(kept).toHaveLength(1);
  expect(await fs.readFile(join(root, 'dist', kept[0], 'previous/connector.lock'), 'utf8')).toBe(
    'previous artifact',
  );
});

it('cancels before cutover and preserves the previous output', async () => {
  await old();
  const controller = new AbortController();
  const previous = vi.mocked(runConnectorToolchain).getMockImplementation()!;
  vi.mocked(runConnectorToolchain).mockImplementation(async (...args) => {
    const result = await previous(...args);
    controller.abort();
    return result;
  });
  await expect(run(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await content()).toBe('previous artifact');
  expect(await temporary()).toEqual([]);
});

it('finishes cutover if a signal arrives after it starts', async () => {
  await old();
  const controller = new AbortController();
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    const result = await actual.rename(from, to);
    controller.abort();
    return result;
  });
  expect(await run(controller.signal)).toBe(target);
  expect(await content()).toBe('new artifact');
});

it('removes an operation-created empty output root after failure', async () => {
  vi.mocked(runConnectorToolchain).mockResolvedValue({
    protocolVersion: 1,
    ok: false,
    error: { code: 'BUILD_FAILED', message: 'Backend failed' },
  });
  await expect(run()).rejects.toMatchObject({ code: 'BUILD_FAILED' });
  expect(await fs.readdir(root)).toEqual(['pyproject.toml']);
});

it.each(['relative/project', 'invalid\0path'])(
  'rejects an invalid project before work: %j',
  async (project) => {
    await expect(
      buildVersionedConnectorArtifact(project, tools, { offline: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(runConnectorToolchain).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === 'win32')(
  'preserves an output-root symlink instead of following it',
  async () => {
    const foreign = join(root, 'foreign');
    await fs.mkdir(foreign);
    await fs.writeFile(join(foreign, 'keep'), 'untouched');
    await fs.symlink(foreign, join(root, 'dist'));
    await expect(run()).rejects.toMatchObject({ code: 'BUILD_FAILED' });
    expect(runConnectorToolchain).not.toHaveBeenCalled();
    expect(await fs.readFile(join(foreign, 'keep'), 'utf8')).toBe('untouched');
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects physically escaping staging without moving foreign files',
  async () => {
    const foreign = join(root, 'foreign/1.2.3.dev1');
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(join(foreign, 'keep'), 'untouched');
    vi.mocked(runConnectorToolchain).mockImplementation(async (_python, request) => {
      if (request.operation !== 'artifact.build') throw Error('Unexpected operation');
      await fs.symlink(dirname(foreign), join(request.options.outputDir, 'fixture'));
      return {
        protocolVersion: 1,
        ok: true,
        result: { artifactDir: join(request.options.outputDir, 'fixture/1.2.3.dev1') },
      };
    });
    await expect(run()).rejects.toMatchObject({ code: 'BUILD_FAILED' });
    expect(await fs.readFile(join(foreign, 'keep'), 'utf8')).toBe('untouched');
  },
);
