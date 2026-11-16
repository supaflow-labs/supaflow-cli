import * as fs from 'node:fs/promises';
import {
  mkdtempSync,
  chmodSync,
  statSync,
  symlinkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (original) => {
  const module = await original<typeof import('node:fs/promises')>();
  return { ...module, rename: vi.fn(module.rename) };
});
vi.mock('../../src/lib/connector-toolchain.js', async (original) => {
  const module = await original<typeof import('../../src/lib/connector-toolchain.js')>();
  return { ...module, runConnectorToolchain: vi.fn() };
});
import { runConnectorToolchain, type ToolchainRequest } from '../../src/lib/connector-toolchain.js';
import { refreshConnectorDependencyLocks } from '../../src/lib/connector-lock.js';
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const tools = { pythonExecutable: '/fixture/python', uvExecutable: '/fixture/uv' };
let root: string;
let output: string;
let generated: (request: Extract<ToolchainRequest, { operation: 'dependencies.generate' }>) => void;
beforeEach(() => {
  output = '';
  vi.clearAllMocks();
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  root = mkdtempSync(join(tmpdir(), 'supaflow ordinary lock '));
  mkdirSync(join(root, 'deps'));
  for (const [name, value] of Object.entries({
    'pyproject.toml': 'root',
    'runtime.lock': 'exact runtime bytes',
    'deps/pyproject.toml': 'old project',
    'deps/uv.lock': 'old lock',
    'deps/uv.toml': 'authored config',
  }))
    writeFileSync(join(root, name), value);
  generated = () => {};
  vi.mocked(runConnectorToolchain).mockImplementation(async (_python, request) => {
    if (request.operation !== 'dependencies.generate') throw Error('Unexpected operation');
    output = request.options.outputDir;
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'pyproject.toml'), 'new project');
    writeFileSync(join(output, 'uv.lock'), 'new lock');
    generated(request);
    return { protocolVersion: 1, ok: true, result: { dependencyDir: output } };
  });
});
afterEach(() => {
  if (existsSync(join(root, 'deps')))
    expect(
      readdirSync(join(root, 'deps')).filter((name) => name.startsWith('.supaflow-lock-')),
    ).toEqual([]);
  rmSync(root, { recursive: true, force: true });
  if (output) expect(existsSync(dirname(output))).toBe(false);
});
const read = (name: string) => readFileSync(join(root, name), 'utf8');
const run = (options: { offline: boolean; signal?: AbortSignal } = { offline: true }) =>
  refreshConnectorDependencyLocks(root, tools, options);

describe('ordinary native dependency lock publication', () => {
  it.each([true, false])('replaces only generated files with offline=%s', async (offline) => {
    await run({ offline });
    expect(read('runtime.lock')).toBe('exact runtime bytes');
    expect(read('pyproject.toml')).toBe('root');
    expect(read('deps/pyproject.toml')).toBe('new project');
    expect(read('deps/uv.lock')).toBe('new lock');
    expect(read('deps/uv.toml')).toBe('authored config');
    expect(readdirSync(join(root, 'deps')).sort()).toEqual([
      'pyproject.toml',
      'uv.lock',
      'uv.toml',
    ]);
    expect(runConnectorToolchain).toHaveBeenCalledWith(
      tools.pythonExecutable,
      {
        protocolVersion: 1,
        operation: 'dependencies.generate',
        projectDir: root,
        options: { uvExecutable: tools.uvExecutable, outputDir: output, offline },
      },
      expect.objectContaining({ offline }),
    );
  });
  it('generates an initially absent pair without replacing authored config', async () => {
    rmSync(join(root, 'deps/pyproject.toml'));
    rmSync(join(root, 'deps/uv.lock'));
    await run();
    expect(read('deps/pyproject.toml')).toBe('new project');
    expect(read('deps/uv.lock')).toBe('new lock');
    expect(read('deps/uv.toml')).toBe('authored config');
  });
  it('preserves native pair bytes without replacing identical files', async () => {
    writeFileSync(join(root, 'deps/pyproject.toml'), 'new project');
    writeFileSync(join(root, 'deps/uv.lock'), 'new lock');
    await run();
    expect(fs.rename).not.toHaveBeenCalled();
  });
  it.each(['runtime.lock', 'pyproject.toml'])(
    'fails before the worker when %s is absent',
    async (file) => {
      rmSync(join(root, file));
      await expect(run()).rejects.toMatchObject({
        code: file === 'runtime.lock' ? 'MISSING_RUNTIME_LOCK' : 'LOCK_FAILED',
      });
      expect(runConnectorToolchain).not.toHaveBeenCalled();
    },
  );
  it('preserves structured worker failures and original files', async () => {
    vi.mocked(runConnectorToolchain).mockResolvedValue({
      protocolVersion: 1,
      ok: false,
      error: { code: 'LOCK_FAILED', message: 'Fix the dependency graph' },
    });
    await expect(run()).rejects.toMatchObject({
      code: 'LOCK_FAILED',
      message: 'Fix the dependency graph',
    });
    expect(read('deps/pyproject.toml')).toBe('old project');
    expect(read('deps/uv.lock')).toBe('old lock');
  });
  it.each([
    'runtime.lock',
    'pyproject.toml',
    'deps/pyproject.toml',
    'deps/uv.lock',
    'uv.toml',
    'deps/uv.toml',
  ])('rejects concurrent %s edits without restoring over them', async (file) => {
    generated = () => writeFileSync(join(root, file), 'authored concurrent edit');
    await expect(run()).rejects.toThrow('inputs changed');
    expect(read(file)).toBe('authored concurrent edit');
    expect(fs.rename).not.toHaveBeenCalled();
  });
  it('cancels before generation without touching files', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run({ offline: true, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(runConnectorToolchain).not.toHaveBeenCalled();
  });
  it('cancels after generation before publication', async () => {
    const controller = new AbortController();
    generated = () => controller.abort();
    await expect(run({ offline: true, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(read('runtime.lock')).toBe('exact runtime bytes');
  });
  it.each([true, false])(
    'restores first-file publication after a second-file error (existing=%s)',
    async (existing) => {
      if (!existing) {
        rmSync(join(root, 'deps/pyproject.toml'));
        rmSync(join(root, 'deps/uv.lock'));
      }
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (String(from).endsWith('new-1')) throw Error('PRIVATE_WRITE_DETAIL');
        return actual.rename(from, to);
      });
      await expect(run()).rejects.toMatchObject({
        code: 'LOCK_PUBLICATION_FAILED',
        message: expect.stringContaining('original files restored'),
      });
      expect(read('runtime.lock')).toBe('exact runtime bytes');
      expect(read('deps/uv.toml')).toBe('authored config');
      if (existing) {
        expect(read('deps/pyproject.toml')).toBe('old project');
        expect(read('deps/uv.lock')).toBe('old lock');
      } else {
        expect(existsSync(join(root, 'deps/pyproject.toml'))).toBe(false);
        expect(existsSync(join(root, 'deps/uv.lock'))).toBe(false);
      }
    },
  );
  it('reports incomplete restoration and keeps source/runtime inputs', async () => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (/(?:new-1|old-0)$/.test(String(from))) throw Error('PRIVATE_WRITE_DETAIL');
      return actual.rename(from, to);
    });
    await expect(run()).rejects.toMatchObject({
      code: 'LOCK_PUBLICATION_FAILED',
      message: expect.stringContaining('publication is incomplete'),
    });
    expect(read('runtime.lock')).toBe('exact runtime bytes');
    expect(read('pyproject.toml')).toBe('root');
    expect(read('deps/uv.lock')).toBe('old lock');
  });
  it('finishes publication if a signal arrives during the commit', async () => {
    const controller = new AbortController();
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      const result = await actual.rename(from, to);
      controller.abort();
      return result;
    });
    await run({ offline: true, signal: controller.signal });
    expect(read('deps/pyproject.toml')).toBe('new project');
    expect(read('deps/uv.lock')).toBe('new lock');
  });
  it('creates a missing generated dependency directory', async () => {
    rmSync(join(root, 'deps'), { recursive: true });
    await run();
    expect(read('deps/uv.lock')).toBe('new lock');
    expect(read('runtime.lock')).toBe('exact runtime bytes');
  });
  it.skipIf(process.platform === 'win32')(
    'preserves private generated file permissions',
    async () => {
      chmodSync(join(root, 'deps/pyproject.toml'), 0o600);
      chmodSync(join(root, 'deps/uv.lock'), 0o600);
      await run();
      expect(statSync(join(root, 'deps/pyproject.toml')).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, 'deps/uv.lock')).mode & 0o777).toBe(0o600);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'preserves generated-file symlinks by rejecting publication before work',
    async () => {
      const external = join(root, 'shared-lock');
      writeFileSync(external, 'shared lock bytes');
      rmSync(join(root, 'deps/uv.lock'));
      symlinkSync(external, join(root, 'deps/uv.lock'));
      await expect(run()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('regular files'),
      });
      expect(runConnectorToolchain).not.toHaveBeenCalled();
      expect(read('deps/uv.lock')).toBe('shared lock bytes');
      expect(readFileSync(external, 'utf8')).toBe('shared lock bytes');
    },
  );
});
