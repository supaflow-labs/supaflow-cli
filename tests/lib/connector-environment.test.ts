import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (original) => {
  const module = await original<typeof import('node:fs/promises')>();
  return { ...module, rm: vi.fn(module.rm) };
});
vi.mock('../../src/lib/connector-python-process.js', async (original) => {
  const module = await original<typeof import('../../src/lib/connector-python-process.js')>();
  return { ...module, runPythonProcess: vi.fn() };
});
import {
  runPythonProcess,
  ToolchainTransportError,
} from '../../src/lib/connector-python-process.js';
import {
  prepareLockedProjectEnvironment,
  prepareOfflineConnectorEnvironment,
} from '../../src/lib/connector-environment.js';

let root: string;
let output: string;
let tools: { uvExecutable: string; pythonExecutable: string; wheelDir: string; uvCacheDir: string };

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'supaflow env ; '));
  output = join(root, 'output');
  tools = {
    uvExecutable: '/tools/uv',
    pythonExecutable: '/tools/python',
    wheelDir: join(root, 'wheels'),
    uvCacheDir: join(root, 'uv-cache'),
  };
  vi.mocked(runPythonProcess).mockImplementation(async (_uv, args, _input, validate) => {
    if (args[0] === 'venv') {
      await mkdir(join(args[1], 'bin'), { recursive: true });
      await writeFile(join(args[1], 'created'), 'private environment');
    }
    return validate(Buffer.alloc(0), 0);
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('offline environment staging', () => {
  async function existingProject() {
    await mkdir(output);
    await writeFile(join(output, 'pyvenv.cfg'), 'include-system-site-packages = false\n');
    tools.pythonExecutable = join(root, 'base-python');
    await writeFile(tools.pythonExecutable, 'selected interpreter');
    const facts = [await realpath(output), await realpath(tools.pythonExecutable)];
    vi.mocked(runPythonProcess).mockImplementation(async (_executable, args, _input, validate) =>
      validate(args[0] === '-I' ? Buffer.from(JSON.stringify(facts) + '\n') : Buffer.alloc(0), 0),
    );
    return facts;
  }

  it('explicitly syncs a matching project venv with the same native installer and no recreation', async () => {
    await existingProject();
    const configuration = await readFile(join(output, 'pyvenv.cfg'));
    const selected = await prepareLockedProjectEnvironment(
      output,
      Buffer.from('checked native lock'),
      tools,
      {
        offline: true,
        reuseExisting: true,
      },
    );
    expect(selected).toBe(
      join(output, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    );
    expect(vi.mocked(runPythonProcess).mock.calls.map((call) => call[1].slice(0, 2))).toEqual([
      ['-I', '-S'],
      ['pip', 'sync'],
      ['pip', 'check'],
    ]);
    const sync = vi.mocked(runPythonProcess).mock.calls[1][1];
    expect(sync).toEqual(
      expect.arrayContaining([
        '--python',
        selected,
        '--require-hashes',
        '--link-mode=copy',
        '--offline',
      ]),
    );
    expect(await readFile(join(output, 'pyvenv.cfg'))).toEqual(configuration);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.supaflow-environment-')),
    ).toEqual([]);
  });

  it.each(['system-site', 'foreign-prefix', 'base-python'])(
    'rejects a %s existing target before uv can modify it',
    async (kind) => {
      const facts = await existingProject();
      if (kind === 'system-site')
        await writeFile(join(output, 'pyvenv.cfg'), 'include-system-site-packages = true\n');
      if (kind === 'foreign-prefix') facts[0] = root;
      if (kind === 'base-python') facts[1] = root;
      const configuration = await readFile(join(output, 'pyvenv.cfg'));
      await expect(
        prepareLockedProjectEnvironment(output, Buffer.from('checked native lock'), tools, {
          offline: true,
          reuseExisting: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(
        vi.mocked(runPythonProcess).mock.calls.some((call) => call[0] === tools.uvExecutable),
      ).toBe(false);
      expect(await readFile(join(output, 'pyvenv.cfg'))).toEqual(configuration);
    },
  );

  it.each(['CANCELLED', 'TIMEOUT'] as const)('preserves %s from the reuse probe', async (code) => {
    await existingProject();
    vi.mocked(runPythonProcess).mockRejectedValueOnce(
      new ToolchainTransportError(code, 'probe interrupted'),
    );
    await expect(
      prepareLockedProjectEnvironment(output, Buffer.from('checked native lock'), tools, {
        offline: true,
        reuseExisting: true,
      }),
    ).rejects.toMatchObject({ code });
    expect(await readFile(join(output, 'pyvenv.cfg'), 'utf8')).toContain('false');
    expect(vi.mocked(runPythonProcess).mock.calls).toHaveLength(1);
  });

  it('preserves an existing project on native sync failure and does not claim it ready', async () => {
    await existingProject();
    const native = vi.mocked(runPythonProcess).getMockImplementation()!;
    vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
      if (args[1][1] === 'sync')
        throw new ToolchainTransportError('PROCESS_FAILED', 'native failure');
      return native(...args);
    });
    await expect(
      prepareLockedProjectEnvironment(output, Buffer.from('checked native lock'), tools, {
        offline: true,
        reuseExisting: true,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect(await readFile(join(output, 'pyvenv.cfg'), 'utf8')).toContain('false');
    expect(vi.mocked(runPythonProcess).mock.calls.some((call) => call[1][1] === 'check')).toBe(
      false,
    );
    expect((await readdir(root)).some((name) => name.startsWith('.supaflow-environment-'))).toBe(
      false,
    );
  });

  it('preserves an ordinary directory or symlink instead of recreating it for reuse', async () => {
    await mkdir(output);
    await writeFile(join(output, 'sentinel'), 'keep');
    await expect(
      prepareLockedProjectEnvironment(output, Buffer.from('checked native lock'), tools, {
        offline: true,
        reuseExisting: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const alias = join(root, 'alias');
    await symlink(output, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      prepareLockedProjectEnvironment(alias, Buffer.from('checked native lock'), tools, {
        offline: true,
        reuseExisting: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await readFile(join(output, 'sentinel'), 'utf8')).toBe('keep');
    expect(runPythonProcess).not.toHaveBeenCalled();
  });

  it('uses the same lifecycle for a frozen native project pylock without index/config redirects', async () => {
    vi.stubEnv('UV_TARGET', join(root, 'foreign'));
    vi.stubEnv('UV_CONFIG_FILE', join(root, 'author-config.toml'));
    vi.stubEnv('UV_FIND_LINKS', join(root, 'foreign-wheels'));
    vi.stubEnv('UV_DEFAULT_INDEX', 'https://example.invalid/simple');
    vi.stubEnv('UV_CREDENTIALS_DIR', join(root, 'credentials'));
    vi.stubEnv('UV_NATIVE_TLS', 'true');
    vi.stubEnv('UV_HTTP_TIMEOUT', '37');
    vi.stubEnv('UV_NO_VERIFY_HASHES', 'true');
    vi.stubEnv('UV_OFFLINE', 'true');
    await prepareLockedProjectEnvironment(output, Buffer.from('checked native lock'), tools, {
      offline: false,
    });
    const calls = vi.mocked(runPythonProcess).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][1]).toContain('--no-seed');
    for (const call of [calls[0], calls[2]])
      expect(Object.keys(call[4]!.env!).some((name) => name.toUpperCase().startsWith('UV_'))).toBe(
        false,
      );
    const args = calls[1][1];
    expect(args).toEqual(
      expect.arrayContaining([
        'pip',
        'sync',
        '--python',
        '--no-index',
        '--no-config',
        '--require-hashes',
        '--verify-hashes',
        '--only-binary=:all:',
        '--link-mode=copy',
        '--preview-features',
        'pylock',
      ]),
    );
    expect(args[2]).toMatch(/pylock\.toml$/);
    expect(args).not.toContain('--target');
    expect(args).not.toContain('--prefix');
    expect(args).not.toContain('--offline');
    expect(calls[1][4]?.env?.UV_OFFLINE).toBe('true');
    expect(calls[1][4]?.env?.UV_TARGET).toBeUndefined();
    expect(calls[1][4]?.env?.UV_CONFIG_FILE).toBeUndefined();
    expect(calls[1][4]?.env?.UV_FIND_LINKS).toBeUndefined();
    expect(calls[1][4]?.env?.UV_DEFAULT_INDEX).toBeUndefined();
    expect(calls[1][4]?.env?.UV_CREDENTIALS_DIR).toBe(join(root, 'credentials'));
    expect(calls[1][4]?.env?.UV_NATIVE_TLS).toBe('true');
    expect(calls[1][4]?.env?.UV_HTTP_TIMEOUT).toBe('37');
    expect(calls[1][4]?.env?.UV_NO_VERIFY_HASHES).toBeUndefined();
    expect(calls[2][1].slice(0, 2)).toEqual(['pip', 'check']);
  });

  it('forces the frozen install offline even when the native environment says false', async () => {
    vi.stubEnv('UV_OFFLINE', 'false');
    await prepareLockedProjectEnvironment(output, Buffer.from('checked native lock'), tools, {
      offline: true,
    });
    expect(vi.mocked(runPythonProcess).mock.calls[1][1]).toContain('--offline');
  });
  it('uses fixed offline/hash/copy flags, checks dependencies and publishes once', async () => {
    vi.stubEnv('UV_TARGET', join(root, 'must-not-write'));
    vi.stubEnv('uv_target', join(root, 'must-not-write-either'));
    vi.stubEnv('UV_VENV_SEED', 'true');
    vi.stubEnv('UV_NO_VERIFY_HASHES', 'true');
    const transport = { signal: new AbortController().signal, timeoutMs: 10_000 };
    const python = await prepareOfflineConnectorEnvironment(
      output,
      Buffer.from('checked requirements'),
      tools,
      transport,
    );
    expect(python).toBe(
      join(output, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    );
    expect(await readFile(join(output, 'created'), 'utf8')).toBe('private environment');
    expect(await readdir(root)).toEqual(['output']);
    const calls = vi.mocked(runPythonProcess).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][1]).toEqual(expect.arrayContaining(['venv', '--relocatable', '--no-project']));
    expect(calls[1][1]).toEqual(
      expect.arrayContaining([
        'pip',
        'sync',
        '--no-index',
        '--require-hashes',
        '--only-binary=:all:',
        '--link-mode=copy',
      ]),
    );
    expect(calls[2][1].slice(0, 2)).toEqual(['pip', 'check']);
    for (const [executable, args, input, , options] of calls) {
      expect(executable).toBe(tools.uvExecutable);
      expect(args).toEqual(
        expect.arrayContaining([
          '--offline',
          '--no-config',
          '--no-python-downloads',
          '--cache-dir',
          tools.uvCacheDir,
        ]),
      );
      expect(input).toBeNull();
      expect(options).toMatchObject({ ...transport, stderr: 'ignore' });
      expect(Object.keys(options!.env!).some((name) => name.toUpperCase().startsWith('UV_'))).toBe(
        false,
      );
    }
  });

  it.each([0, 1, 2])('never publishes when native phase %s fails', async (phase) => {
    const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
    let count = 0;
    vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
      if (count++ === phase) return args[3](Buffer.from('PRIVATE_NATIVE_OUTPUT'), 1);
      return previous(...args);
    });
    const error = await prepareOfflineConnectorEnvironment(
      output,
      Buffer.from('checked'),
      tools,
    ).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'PROCESS_FAILED' });
    expect(error.message).not.toContain('PRIVATE_NATIVE_OUTPUT');
    expect(await readdir(root)).toEqual([]);
  });

  it('preserves transport cancellation and cleans partial staging', async () => {
    const error = new ToolchainTransportError('CANCELLED', 'Fixture cancelled');
    vi.mocked(runPythonProcess).mockRejectedValue(error);
    await expect(
      prepareOfflineConnectorEnvironment(output, Buffer.from('checked'), tools),
    ).rejects.toBe(error);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['success', 'cancelled'])(
    'preserves the %s result if scratch cleanup fails',
    async (result) => {
      const error = new ToolchainTransportError('CANCELLED', 'Fixture cancelled');
      if (result === 'cancelled') vi.mocked(runPythonProcess).mockRejectedValue(error);
      vi.mocked(rm).mockRejectedValueOnce(new Error('fixture cleanup failure'));
      const pending = prepareOfflineConnectorEnvironment(output, Buffer.from('checked'), tools);
      if (result === 'cancelled') await expect(pending).rejects.toBe(error);
      else {
        await expect(pending).resolves.toBe(
          join(output, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        );
        expect(await readFile(join(output, 'created'), 'utf8')).toBe('private environment');
      }
    },
  );

  it('checks cancellation after successful native verification before publication', async () => {
    const controller = new AbortController();
    const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
    vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
      const result = await previous(...args);
      if (args[1][1] === 'check') controller.abort();
      return result;
    });
    await expect(
      prepareOfflineConnectorEnvironment(output, Buffer.from('checked'), tools, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['directory', 'empty-directory', 'file', 'dangling-link'])(
    'refuses an occupied %s output before starting uv',
    async (kind) => {
      if (kind === 'directory' || kind === 'empty-directory') {
        await mkdir(output);
        if (kind === 'directory') await writeFile(join(output, 'keep'), 'author data');
      } else if (kind === 'file') await writeFile(output, 'author data');
      else await symlink(join(root, 'missing'), output, 'dir');
      const before = await lstat(output);
      await expect(
        prepareOfflineConnectorEnvironment(output, Buffer.from('checked'), tools),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(runPythonProcess).not.toHaveBeenCalled();
      expect((await lstat(output)).ino).toBe(before.ino);
      if (kind === 'directory')
        expect(await readFile(join(output, 'keep'), 'utf8')).toBe('author data');
      if (kind === 'file') expect(await readFile(output, 'utf8')).toBe('author data');
    },
  );

  it('copies the trusted requirement bytes before the caller can reuse its buffer', async () => {
    const requirements = Buffer.from('original checked requirements');
    const previous = vi.mocked(runPythonProcess).getMockImplementation()!;
    let observed: string | undefined;
    vi.mocked(runPythonProcess).mockImplementation(async (...args) => {
      if (args[1][0] === 'pip' && args[1][1] === 'sync')
        observed = await readFile(args[1][2], 'utf8');
      return previous(...args);
    });
    const pending = prepareOfflineConnectorEnvironment(output, requirements, tools);
    requirements.fill(0);
    await pending;
    expect(observed).toBe('original checked requirements');
  });

  it('does not start a pre-cancelled preparation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareOfflineConnectorEnvironment(output, Buffer.from('checked'), tools, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(runPythonProcess).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['same', 'inside-output', 'contains-output'])(
    'rejects overlapping cache/output paths: %s',
    async (kind) => {
      tools.uvCacheDir =
        kind === 'same' ? output : kind === 'inside-output' ? join(output, 'cache') : root;
      await expect(
        prepareOfflineConnectorEnvironment(output, Buffer.from('checked'), tools),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(runPythonProcess).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('rejects relative paths and empty requirements without work', async () => {
    await expect(
      prepareOfflineConnectorEnvironment('relative', Buffer.from('checked'), tools),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      prepareOfflineConnectorEnvironment(output, Buffer.alloc(0), tools),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(runPythonProcess).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
