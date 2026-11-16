import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
import { prepareOfflineConnectorEnvironment } from '../../src/lib/connector-environment.js';

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
