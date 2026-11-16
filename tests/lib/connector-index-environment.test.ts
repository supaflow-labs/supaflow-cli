import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/connector-python-process.js', async (original) => {
  const module = await original<typeof import('../../src/lib/connector-python-process.js')>();
  return { ...module, runPythonProcess: vi.fn() };
});
import { runPythonProcess } from '../../src/lib/connector-python-process.js';
import { prepareIndexedToolchainEnvironment } from '../../src/lib/connector-environment.js';

let root: string;
let output: string;
let tools: {
  uvExecutable: string;
  pythonExecutable: string;
  uvCacheDir: string;
  configurationDir: string;
};
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'supaflow index environment '));
  output = join(root, 'published');
  tools = {
    uvExecutable: '/tools/uv',
    pythonExecutable: '/tools/python',
    uvCacheDir: join(root, 'cache'),
    configurationDir: join(root, 'project'),
  };
  vi.mocked(runPythonProcess).mockImplementation(async (executable, args, _input, validate) => {
    if (args[0] === 'venv') await mkdir(join(args[1], 'bin'), { recursive: true });
    if (args[0] === '-I') {
      const library = join(dirname(dirname(executable)), 'lib', 'python-fixture', 'site-packages');
      await mkdir(library, { recursive: true });
      return validate(Buffer.from(JSON.stringify(library) + '\n'), 0);
    }
    if (args[1] === 'sync') {
      const target = args[args.indexOf('--target') + 1];
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'fixture'), 'installed');
    }
    return validate(Buffer.alloc(0), 0);
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('reuses staged publication and fixes the installation target while retaining registry settings', async () => {
  vi.stubEnv('UV_CONFIG_FILE', join(root, 'uv.toml'));
  vi.stubEnv('UV_NO_SYSTEM_CONFIG', 'true');
  vi.stubEnv('UV_DEFAULT_INDEX', 'https://mirror.example.invalid/simple');
  vi.stubEnv('UV_INDEX_CORPORATE_PASSWORD', '<TEST_ONLY_PASSWORD>');
  vi.stubEnv('UV_CREDENTIALS_DIR', join(root, 'credentials'));
  vi.stubEnv('UV_HTTP_TIMEOUT', '9');
  vi.stubEnv('UV_TARGET', join(root, 'forbidden'));
  vi.stubEnv('UV_NO_VERIFY_HASHES', 'true');
  vi.stubEnv('UV_VENV_SEED', 'true');
  const signal = new AbortController().signal;
  const result = await prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, {
    offline: false,
    signal,
    timeoutMs: 1234,
  });
  expect(result).toEqual({
    pythonExecutable: join(
      output,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    ),
    sitePackages: join(output, 'lib/python-fixture/site-packages'),
  });
  expect(await readFile(join(result.sitePackages, 'fixture'), 'utf8')).toBe('installed');
  expect(await readdir(root)).toEqual(['published']);
  const calls = vi.mocked(runPythonProcess).mock.calls;
  expect(calls).toHaveLength(4);
  expect(calls[0][1]).toEqual(expect.arrayContaining(['--offline', '--no-config', '--no-seed']));
  expect(calls[1][1].slice(0, 2)).toEqual(['-I', '-B']);
  const args = calls[2][1];
  expect(args).toEqual(
    expect.arrayContaining([
      '--target',
      '--require-hashes',
      '--verify-hashes',
      '--only-binary=:all:',
      '--link-mode=copy',
      '--directory',
      tools.configurationDir,
    ]),
  );
  expect(args).not.toContain('--no-config');
  expect(args).not.toContain('--offline');
  expect(calls[2][4]?.env).toMatchObject({
    UV_CONFIG_FILE: join(root, 'uv.toml'),
    UV_NO_SYSTEM_CONFIG: 'true',
    UV_DEFAULT_INDEX: 'https://mirror.example.invalid/simple',
    UV_INDEX_CORPORATE_PASSWORD: '<TEST_ONLY_PASSWORD>',
    UV_CREDENTIALS_DIR: join(root, 'credentials'),
    UV_HTTP_TIMEOUT: '9',
  });
  expect(calls[2][4]?.env).not.toHaveProperty('UV_TARGET');
  expect(calls[2][4]?.env).not.toHaveProperty('UV_NO_VERIFY_HASHES');
  expect(calls[2][4]?.env).not.toHaveProperty('UV_VENV_SEED');
  expect(calls[3][1]).toEqual(expect.arrayContaining(['pip', 'check', '--offline', '--no-config']));
});

it('forces offline mode in the only acquisition phase', async () => {
  await prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, {
    offline: true,
  });
  expect(vi.mocked(runPythonProcess).mock.calls[2][1]).toContain('--offline');
});

it.each([0, 1, 2, 3])('cleans staging without publishing when phase %s fails', async (phase) => {
  const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
  let call = 0;
  vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
    if (call++ === phase) return args[3](Buffer.from('PRIVATE_INSTALLER_OUTPUT'), 1);
    return previous(...args);
  });
  const error = await prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, {
    offline: false,
  }).catch((caught) => caught);
  expect(error).toMatchObject({ code: phase === 1 ? 'INVALID_RESPONSE' : 'PROCESS_FAILED' });
  expect(error.message).not.toContain('PRIVATE_INSTALLER_OUTPUT');
  expect(await readdir(root)).toEqual([]);
});

it.each(['relative', '/outside', '/tmp/../outside'])(
  'rejects unsafe installation fact %s',
  async (path) => {
    const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
    vi.mocked(runPythonProcess).mockImplementation(async (...args) =>
      args[1][0] === '-I'
        ? args[3](Buffer.from(JSON.stringify(path) + '\n'), 0)
        : previous(...args),
    );
    await expect(
      prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, { offline: false }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(vi.mocked(runPythonProcess).mock.calls).toHaveLength(2);
    expect(await readdir(root)).toEqual([]);
  },
);

it('checks cancellation again after dependency validation', async () => {
  const controller = new AbortController();
  const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
  vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
    const result = await previous(...args);
    if (args[1][1] === 'check') controller.abort();
    return result;
  });
  await expect(
    prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, {
      offline: false,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readdir(root)).toEqual([]);
});

it('rejects an existing external installation directory before invoking the installer', async () => {
  const external = join(root, 'external');
  await mkdir(external);
  await writeFile(join(external, 'preserve'), 'unchanged');
  const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
  vi.mocked(runPythonProcess).mockImplementation(async (...args) =>
    args[1][0] === '-I'
      ? args[3](Buffer.from(JSON.stringify(external) + '\n'), 0)
      : previous(...args),
  );
  await expect(
    prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, { offline: false }),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(vi.mocked(runPythonProcess).mock.calls).toHaveLength(2);
  expect(await readdir(root)).toEqual(['external']);
  expect(await readFile(join(external, 'preserve'), 'utf8')).toBe('unchanged');
});

it.skipIf(process.platform === 'win32')(
  'rejects an installation-directory symlink escaping staging',
  async () => {
    const external = join(root, 'external');
    await mkdir(external);
    const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
    vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
      if (args[1][0] !== '-I') return previous(...args);
      const link = join(dirname(dirname(args[0])), 'library-link');
      await symlink(external, link);
      return args[3](Buffer.from(JSON.stringify(link) + '\n'), 0);
    });
    await expect(
      prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, { offline: false }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(vi.mocked(runPythonProcess).mock.calls).toHaveLength(2);
    expect(await readdir(root)).toEqual(['external']);
  },
);

it('requires an explicit network policy before starting any native operation', async () => {
  await expect(
    prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, {
      offline: undefined as unknown as boolean,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(runPythonProcess).not.toHaveBeenCalled();
});

it.each(['true', 'false'])(
  'preserves UV_OFFLINE=%s when the explicit flag is absent',
  async (value) => {
    vi.stubEnv('UV_OFFLINE', value);
    await prepareIndexedToolchainEnvironment(output, Buffer.from('checked'), tools, {
      offline: false,
    });
    expect(vi.mocked(runPythonProcess).mock.calls[2][4]?.env?.UV_OFFLINE).toBe(value);
    expect(vi.mocked(runPythonProcess).mock.calls[2][1]).not.toContain('--offline');
  },
);
