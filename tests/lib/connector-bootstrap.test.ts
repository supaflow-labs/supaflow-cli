import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/connector-authoring-prerequisites.js', () => ({
  discoverConnectorAuthoringPrerequisites: vi.fn(),
}));
vi.mock('../../src/lib/connector-environment.js', () => ({
  prepareIndexedToolchainEnvironment: vi.fn(),
}));
vi.mock('../../src/lib/connector-python-process.js', async (original) => ({
  ...(await original<typeof import('../../src/lib/connector-python-process.js')>()),
  runPythonProcess: vi.fn(),
}));
import {
  bootstrapConnectorToolchain,
  type ConnectorToolchainBundle,
} from '../../src/lib/connector-bootstrap.js';
import { discoverConnectorAuthoringPrerequisites } from '../../src/lib/connector-authoring-prerequisites.js';
import { prepareIndexedToolchainEnvironment } from '../../src/lib/connector-environment.js';
import { runPythonProcess } from '../../src/lib/connector-python-process.js';

const requirements = Buffer.from('uv==0.11.5 --hash=sha256:' + 'a'.repeat(64) + '\n');
const bundle: ConnectorToolchainBundle = {
  schemaVersion: 1,
  requiresPython: '>=3.11',
  toolchainVersion: '0.1.0',
  sdkVersion: '1.0.73.dev0',
  runtimeVersion: null,
  testkitVersion: '0.1.0',
  uvVersion: '0.11.5',
  requirementsSha256: createHash('sha256').update(requirements).digest('hex'),
};
let root: string;
let output: string;
let versions: Record<string, string | null>;
let sitePackages: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'supaflow bootstrap ; '));
  versions = {
    'supaflow-connector-toolchain': bundle.toolchainVersion,
    'supaflow-python-sdk': bundle.sdkVersion,
    'supaflow-connector-runtime': null,
    'supaflow-connector-testkit': bundle.testkitVersion,
    uv: bundle.uvVersion,
  };
  vi.mocked(discoverConnectorAuthoringPrerequisites).mockResolvedValue({
    uvExecutable: '/tools/uv',
    uvVersion: '0.13.4',
    python: { executable: '/tools/python', implementation: 'cpython', version: [3, 12, 8] },
  });
  vi.mocked(prepareIndexedToolchainEnvironment).mockImplementation(async (destination) => {
    output = destination;
    sitePackages = join(output, 'lib', 'site-packages');
    await mkdir(join(sitePackages, 'bin'), { recursive: true });
    await writeFile(
      join(sitePackages, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
      'fixture',
    );
    return { pythonExecutable: join(output, 'bin', 'python'), sitePackages };
  });
  vi.mocked(runPythonProcess).mockImplementation(async (_program, args, _input, validate) =>
    validate(
      Buffer.from(
        args.includes('--version')
          ? 'uv 0.11.5 (fixture build)\n'
          : JSON.stringify({ versions, sitePackages }) + '\n',
      ),
      0,
    ),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const options = () => ({
  cacheDir: join(root, 'cache'),
  configurationDir: root,
  offline: true,
  timeoutMs: 3210,
});

it('composes discovery and the existing hash installer, then reuses the ready environment', async () => {
  const first = await bootstrapConnectorToolchain(bundle, requirements, options());
  expect(first.nodeExecutable).toBe(process.execPath);
  expect(first.uvExecutable).toBe(
    join(sitePackages, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
  );
  expect(first.pythonExecutable).toBe(
    join(output, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  );
  expect(prepareIndexedToolchainEnvironment).toHaveBeenCalledWith(
    output,
    requirements,
    {
      uvExecutable: '/tools/uv',
      pythonExecutable: '/tools/python',
      uvCacheDir: join(root, 'cache', 'uv'),
      configurationDir: root,
    },
    options(),
  );
  expect(await bootstrapConnectorToolchain(bundle, requirements, options())).toEqual(first);
  expect(prepareIndexedToolchainEnvironment).toHaveBeenCalledTimes(1);
  expect(runPythonProcess).toHaveBeenCalledTimes(4);
});

it.each([Buffer.from('changed'), new Uint8Array()])(
  'rejects bad bundled requirements before discovery',
  async (raw) => {
    await expect(bootstrapConnectorToolchain(bundle, raw, options())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(discoverConnectorAuthoringPrerequisites).not.toHaveBeenCalled();
  },
);

it('separates environments for a different selected interpreter', async () => {
  await bootstrapConnectorToolchain(bundle, requirements, options());
  const first = output;
  vi.mocked(discoverConnectorAuthoringPrerequisites).mockResolvedValue({
    uvExecutable: '/tools/uv',
    uvVersion: '0.13.4',
    python: { executable: '/other/python', implementation: 'cpython', version: [3, 13, 4] },
  });
  await bootstrapConnectorToolchain(bundle, requirements, options());
  expect(output).not.toBe(first);
  expect(prepareIndexedToolchainEnvironment).toHaveBeenCalledTimes(2);
});

it('reuses the same verified interpreter and wheel set across compatible selection ranges', async () => {
  const first = await bootstrapConnectorToolchain(bundle, requirements, options());
  const second = await bootstrapConnectorToolchain(
    { ...bundle, requiresPython: '>=3.12,<3.13' },
    requirements,
    options(),
  );
  expect(second).toEqual(first);
  expect(discoverConnectorAuthoringPrerequisites).toHaveBeenCalledTimes(2);
  expect(prepareIndexedToolchainEnvironment).toHaveBeenCalledTimes(1);
});

it.each([
  'supaflow-connector-toolchain',
  'supaflow-python-sdk',
  'supaflow-connector-runtime',
  'supaflow-connector-testkit',
  'uv',
])('rejects changed installed %s metadata without replacing cached files', async (name) => {
  await bootstrapConnectorToolchain(bundle, requirements, options());
  versions[name] = '9.0.0';
  await expect(bootstrapConnectorToolchain(bundle, requirements, options())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  expect(prepareIndexedToolchainEnvironment).toHaveBeenCalledTimes(1);
});

it('does not execute a native binary outside the prepared environment', async () => {
  await bootstrapConnectorToolchain(bundle, requirements, options());
  const binary = join(sitePackages, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
  const foreign = join(root, 'foreign');
  await writeFile(foreign, 'fixture');
  await rm(binary);
  await symlink(foreign, binary);
  vi.mocked(runPythonProcess).mockClear();
  await expect(bootstrapConnectorToolchain(bundle, requirements, options())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  expect(runPythonProcess).toHaveBeenCalledTimes(1);
});

it('rejects a native binary version that differs from package metadata', async () => {
  vi.mocked(runPythonProcess).mockImplementation(async (_program, args, _input, validate) =>
    validate(
      Buffer.from(
        args.includes('--version')
          ? 'uv 0.99.0\n'
          : JSON.stringify({ versions, sitePackages }) + '\n',
      ),
      0,
    ),
  );
  await expect(bootstrapConnectorToolchain(bundle, requirements, options())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});

it('passes cancellation to existing operations without creating another preparation mechanism', async () => {
  const signal = new AbortController().signal;
  await bootstrapConnectorToolchain(bundle, requirements, { ...options(), signal, offline: false });
  expect(discoverConnectorAuthoringPrerequisites).toHaveBeenCalledWith(bundle.requiresPython, {
    ...options(),
    signal,
    offline: false,
  });
  expect(runPythonProcess).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(Array),
    null,
    expect.any(Function),
    { signal, timeoutMs: 3210, stderr: 'ignore' },
  );
});

it('keeps cache identity stable across descriptor key ordering and unrelated properties', async () => {
  const first = await bootstrapConnectorToolchain(bundle, requirements, options());
  const reordered = Object.fromEntries(
    Object.entries(bundle).reverse(),
  ) as unknown as ConnectorToolchainBundle;
  expect(
    await bootstrapConnectorToolchain(
      { ...reordered, unrelated: 'ignored' } as ConnectorToolchainBundle,
      requirements,
      options(),
    ),
  ).toEqual(first);
  expect(prepareIndexedToolchainEnvironment).toHaveBeenCalledTimes(1);
});

it('reports the exact cache entry when cached Python cannot start', async () => {
  await bootstrapConnectorToolchain(bundle, requirements, options());
  const { ToolchainTransportError } = await import('../../src/lib/connector-python-process.js');
  vi.mocked(runPythonProcess).mockRejectedValueOnce(
    new ToolchainTransportError('UNAVAILABLE', 'Cannot start'),
  );
  await expect(bootstrapConnectorToolchain(bundle, requirements, options())).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: `Cannot start cached Python; remove ${output} and retry`,
  });
});

it('reports the exact cache entry when the cached native uv cannot start', async () => {
  await bootstrapConnectorToolchain(bundle, requirements, options());
  const { ToolchainTransportError } = await import('../../src/lib/connector-python-process.js');
  const inspect = vi.mocked(runPythonProcess).getMockImplementation()!;
  vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
    if (args[1].includes('--version'))
      throw new ToolchainTransportError('UNAVAILABLE', 'Cannot start');
    return inspect(...args);
  });
  await expect(bootstrapConnectorToolchain(bundle, requirements, options())).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: `Cannot start cached uv; remove ${output} and retry`,
  });
});
