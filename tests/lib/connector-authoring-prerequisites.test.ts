import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/connector-python-process.js', async (original) => {
  const module = await original<typeof import('../../src/lib/connector-python-process.js')>();
  return { ...module, runPythonProcess: vi.fn() };
});
vi.mock('../../src/lib/connector-python-selection.js', () => ({ selectConnectorPython: vi.fn() }));
import { discoverConnectorAuthoringPrerequisites } from '../../src/lib/connector-authoring-prerequisites.js';
import {
  runPythonProcess,
  ToolchainTransportError,
} from '../../src/lib/connector-python-process.js';
import { selectConnectorPython } from '../../src/lib/connector-python-selection.js';

const python = {
  executable: '/tools/python',
  version: [3, 12, 8],
  implementation: 'cpython',
} as const;
let root: string;
const filename = process.platform === 'win32' ? 'uv.exe' : 'uv';

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'supaflow prerequisites ; '));
  vi.mocked(runPythonProcess).mockImplementation(async (_uv, _args, _input, validate) =>
    validate(Buffer.from('uv 0.11.5 (fixture build)\n'), 0),
  );
  vi.mocked(selectConnectorPython).mockResolvedValue({ ...python, version: [...python.version] });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function executable(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path;
}

describe('installed authoring prerequisites', () => {
  it('probes the first executable PATH candidate and reuses offline Python selection', async () => {
    const first = await executable(join(root, 'first'));
    await executable(join(root, 'second'));
    vi.stubEnv(
      'PATH',
      [join(root, 'missing'), join(root, 'first'), join(root, 'second')].join(delimiter),
    );
    const options = { signal: new AbortController().signal, timeoutMs: 4321 };
    await expect(discoverConnectorAuthoringPrerequisites('>=3.12', options)).resolves.toEqual({
      uvExecutable: first,
      uvVersion: '0.11.5',
      python,
    });
    expect(runPythonProcess).toHaveBeenCalledWith(
      first,
      ['--offline', '--no-config', '--no-cache', '--no-python-downloads', '--version'],
      null,
      expect.any(Function),
      { ...options, stderr: 'ignore' },
    );
    expect(selectConnectorPython).toHaveBeenCalledWith(first, '>=3.12', options);
  });

  it('ignores empty and relative PATH entries and directories named uv', async () => {
    await mkdir(join(root, 'directory', filename), { recursive: true });
    await executable(join(root, 'relative'));
    const selected = await executable(join(root, 'selected'));
    vi.stubEnv(
      'PATH',
      [
        '',
        '.',
        relative(process.cwd(), join(root, 'relative')),
        join(root, 'directory'),
        join(root, 'selected'),
      ].join(delimiter),
    );
    expect((await discoverConnectorAuthoringPrerequisites('>=3.12')).uvExecutable).toBe(selected);
  });

  it.skipIf(process.platform === 'win32')(
    'skips nonexecutable files and follows installed symlinks',
    async () => {
      const denied = await executable(join(root, 'denied'));
      await chmod(denied, 0o644);
      const target = await executable(join(root, 'target'));
      await mkdir(join(root, 'linked'));
      const linked = join(root, 'linked', filename);
      await symlink(target, linked);
      vi.stubEnv('PATH', [join(root, 'denied'), join(root, 'linked')].join(delimiter));
      expect((await discoverConnectorAuthoringPrerequisites('>=3.12')).uvExecutable).toBe(linked);
    },
  );

  it('accepts an explicit absolute uv without searching PATH', async () => {
    vi.stubEnv('PATH', '');
    expect(
      (await discoverConnectorAuthoringPrerequisites('>=3.12', { uvExecutable: '/selected/uv' }))
        .uvExecutable,
    ).toBe('/selected/uv');
  });

  it('reports a missing prerequisite before launching a process', async () => {
    vi.stubEnv('PATH', ['', '.', join(root, 'missing')].join(delimiter));
    await expect(discoverConnectorAuthoringPrerequisites('>=3.12')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(runPythonProcess).not.toHaveBeenCalled();
    expect(selectConnectorPython).not.toHaveBeenCalled();
  });

  it.each(['', '  ', '\0'])(
    'rejects invalid requirement %j before discovery',
    async (requirement) => {
      await expect(discoverConnectorAuthoringPrerequisites(requirement)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(runPythonProcess).not.toHaveBeenCalled();
    },
  );

  it.each(['uv 0.11.5\r\n', 'uv 0.11.5-dev.1 (fixture)\n'])(
    'accepts version wire spelling %j',
    async (wire) => {
      vi.mocked(runPythonProcess).mockImplementation(async (_uv, _args, _input, validate) =>
        validate(Buffer.from(wire), 0),
      );
      expect(
        (await discoverConnectorAuthoringPrerequisites('>=3.12', { uvExecutable: '/selected/uv' }))
          .uvVersion,
      ).toBe(wire.split(' ')[1].trim());
    },
  );

  it.each(['', 'pip 0.11.5\n', 'uv 0.11.5', 'uv 0.11.5\nPRIVATE_OUTPUT\n', 'uv unknown\n'])(
    'rejects invalid version wire %j',
    async (wire) => {
      vi.mocked(runPythonProcess).mockImplementation(async (_uv, _args, _input, validate) =>
        validate(Buffer.from(wire), 0),
      );
      const error = await discoverConnectorAuthoringPrerequisites('>=3.12', {
        uvExecutable: '/selected/uv',
      }).catch((caught) => caught);
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(error.message).not.toContain('PRIVATE_OUTPUT');
      expect(selectConnectorPython).not.toHaveBeenCalled();
    },
  );

  it('maps a failed uv probe without exposing its output', async () => {
    vi.mocked(runPythonProcess).mockImplementation(async (_uv, _args, _input, validate) =>
      validate(Buffer.from('PRIVATE_OUTPUT'), 7),
    );
    await expect(
      discoverConnectorAuthoringPrerequisites('>=3.12', { uvExecutable: '/selected/uv' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(selectConnectorPython).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 in the native version frame', async () => {
    vi.mocked(runPythonProcess).mockImplementation(async (_uv, _args, _input, validate) =>
      validate(Buffer.from([0xff, 0x0a]), 0),
    );
    await expect(
      discoverConnectorAuthoringPrerequisites('>=3.12', { uvExecutable: '/selected/uv' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(selectConnectorPython).not.toHaveBeenCalled();
  });

  it('preserves cancellation and native timeout errors', async () => {
    const signal = AbortSignal.abort();
    await expect(
      discoverConnectorAuthoringPrerequisites('>=3.12', { signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(runPythonProcess).not.toHaveBeenCalled();
    const timeout = new ToolchainTransportError('TIMEOUT', 'Fixture timed out');
    vi.mocked(runPythonProcess).mockRejectedValue(timeout);
    await expect(
      discoverConnectorAuthoringPrerequisites('>=3.12', { uvExecutable: '/selected/uv' }),
    ).rejects.toBe(timeout);
  });

  it('preserves a missing-compatible-Python error', async () => {
    const unavailable = new ToolchainTransportError('UNAVAILABLE', 'No compatible Python');
    vi.mocked(selectConnectorPython).mockRejectedValue(unavailable);
    await expect(
      discoverConnectorAuthoringPrerequisites('>=3.12', { uvExecutable: '/selected/uv' }),
    ).rejects.toBe(unavailable);
  });
});
