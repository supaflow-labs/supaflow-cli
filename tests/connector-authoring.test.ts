import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/connector-toolchain.js', async (original) => {
  const module = await original<typeof import('../src/lib/connector-toolchain.js')>();
  return { ...module, runConnectorToolchain: vi.fn() };
});
import { runConnectorToolchain, ToolchainTransportError } from '../src/lib/connector-toolchain.js';
import { CliError, ErrorCode, formatError } from '../src/lib/errors.js';
import {
  registerConnectorAuthoringCommands,
  type ConnectorAuthoringBootstrap,
} from '../src/commands/connector-authoring.js';

const tools = {
  pythonExecutable: '/tools/python',
  uvExecutable: '/tools/uv',
  nodeExecutable: '/tools/node',
  runtimeWheelDir: '/cache/wheels',
};
const bootstrap = vi.fn<ConnectorAuthoringBootstrap>();
let logs: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
let originalExit: typeof process.exitCode;
let signalListeners: Record<'SIGINT' | 'SIGTERM', Function[]>;

beforeEach(() => {
  vi.clearAllMocks();
  originalExit = process.exitCode;
  process.exitCode = undefined;
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  signalListeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  bootstrap.mockResolvedValue(tools);
  vi.mocked(runConnectorToolchain).mockResolvedValue({
    protocolVersion: 1,
    ok: true,
    result: { checked: true },
  });
});
afterEach(() => {
  const actual = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  expect(actual.SIGINT).toEqual(signalListeners.SIGINT);
  expect(actual.SIGTERM).toEqual(signalListeners.SIGTERM);
});

function program() {
  const root = new Command().exitOverride().option('--json');
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerConnectorAuthoringCommands(root.command('connectors'), bootstrap, { timeoutMs: 10_000 });
  return root;
}

const parse = (args: string[]) => program().parseAsync(['node', 'supaflow', ...args]);
const jsonOutput = () => {
  expect(logs).toHaveBeenCalledTimes(1);
  return JSON.parse(logs.mock.calls[0][0] as string);
};

describe('inactive unauthenticated authoring adapters', () => {
  it('keeps the shipped connectors command surface unchanged', () => {
    const help = execFileSync(process.execPath, ['bin/supaflow.mjs', 'connectors', '--help'], {
      encoding: 'utf8',
    });
    expect(help).toMatch(/^\s+list\b/m);
    expect(help).not.toMatch(/^\s+(check|test|doctor|manifest|build)\b/m);
    expect(bootstrap).not.toHaveBeenCalled();
  });
  it.each([
    {
      args: ['build'],
      operation: 'artifact.build',
      result: { artifactDir: resolve('./fixture ; project/dist') },
      options: {
        uvExecutable: tools.uvExecutable,
        nodeExecutable: tools.nodeExecutable,
        runtimeWheelDir: tools.runtimeWheelDir,
        outputDir: resolve('./fixture ; project/dist'),
      },
    },
    {
      args: ['check'],
      operation: 'check',
      result: { checked: true },
      options: {
        uvExecutable: tools.uvExecutable,
        nodeExecutable: tools.nodeExecutable,
        runtimeWheelDir: tools.runtimeWheelDir,
      },
    },
    {
      args: ['test'],
      operation: 'test',
      result: { tested: true },
      options: {
        uvExecutable: tools.uvExecutable,
        nodeExecutable: tools.nodeExecutable,
        runtimeWheelDir: tools.runtimeWheelDir,
      },
    },
    {
      args: ['test', '--live'],
      operation: 'test',
      result: { tested: true },
      options: {
        uvExecutable: tools.uvExecutable,
        nodeExecutable: tools.nodeExecutable,
        runtimeWheelDir: tools.runtimeWheelDir,
        live: true,
      },
    },
    {
      args: ['doctor'],
      operation: 'doctor',
      result: { diagnostics: { fixture: true } },
      options: {},
    },
    {
      args: ['manifest', 'generate'],
      operation: 'manifest.generate',
      result: { manifest: 'connector.yaml' },
      options: { nodeExecutable: tools.nodeExecutable },
    },
    {
      args: ['manifest', 'check'],
      operation: 'manifest.check',
      result: { manifest: 'connector.yaml' },
      options: { nodeExecutable: tools.nodeExecutable },
    },
  ])(
    'dispatches $operation with strict machine fields and one JSON result',
    async ({ args, operation, result, options }) => {
      vi.mocked(runConnectorToolchain).mockResolvedValue({
        protocolVersion: 1,
        ok: true,
        result,
      } as Awaited<ReturnType<typeof runConnectorToolchain>>);
      await parse([
        '--json',
        'connectors',
        ...args,
        '--project',
        './fixture ; project',
        '--offline',
      ]);
      const projectDir = resolve('./fixture ; project');
      expect(bootstrap).toHaveBeenCalledExactlyOnceWith(projectDir, {
        operation,
        offline: true,
        signal: expect.any(AbortSignal),
      });
      expect(runConnectorToolchain).toHaveBeenCalledExactlyOnceWith(
        tools.pythonExecutable,
        { protocolVersion: 1, operation, projectDir, options },
        { signal: bootstrap.mock.calls[0][1].signal, timeoutMs: 10_000, offline: true },
      );
      expect(jsonOutput()).toEqual(result);
      expect(errors).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each(['./output ; folder', '/absolute/artifact'])(
    'resolves build output %s from the project',
    async (output) => {
      const project = resolve('./project'),
        outputDir = resolve(project, output);
      vi.mocked(runConnectorToolchain).mockResolvedValue({
        protocolVersion: 1,
        ok: true,
        result: { artifactDir: outputDir },
      });
      await parse(['connectors', 'build', '--project', project, '--output', output]);
      expect(runConnectorToolchain).toHaveBeenCalledExactlyOnceWith(
        tools.pythonExecutable,
        {
          protocolVersion: 1,
          operation: 'artifact.build',
          projectDir: project,
          options: {
            uvExecutable: tools.uvExecutable,
            nodeExecutable: tools.nodeExecutable,
            runtimeWheelDir: tools.runtimeWheelDir,
            outputDir,
          },
        },
        { signal: expect.any(AbortSignal), timeoutMs: 10_000, offline: false },
      );
      expect(logs).toHaveBeenCalledExactlyOnceWith(`Built connector artifact: ${outputDir}`);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'bad\0path'])('rejects an invalid output before bootstrap: %j', async (output) => {
    await parse(['--json', 'connectors', 'build', '--output', output]);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(runConnectorToolchain).not.toHaveBeenCalled();
    expect(jsonOutput()).toEqual({
      error: {
        code: 'INVALID_INPUT',
        message: 'Provide a nonempty artifact output path without NUL characters',
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it('preserves a build rejection without retrying or changing outputs', async () => {
    vi.mocked(runConnectorToolchain).mockResolvedValue({
      protocolVersion: 1,
      ok: false,
      error: { code: 'BUILD_FAILED', message: 'Artifact output already exists' },
    });
    await parse(['--json', 'connectors', 'build']);
    expect(runConnectorToolchain).toHaveBeenCalledOnce();
    expect(jsonOutput()).toEqual({
      error: { code: 'BUILD_FAILED', message: 'Artifact output already exists' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('defaults to cwd, keeps live tests off and prints a concise human result', async () => {
    vi.mocked(runConnectorToolchain).mockResolvedValue({
      protocolVersion: 1,
      ok: true,
      result: { tested: true },
    });
    await parse(['connectors', 'test']);
    expect(bootstrap.mock.calls[0].slice(0, 1)).toEqual([process.cwd()]);
    expect(bootstrap.mock.calls[0][1].offline).toBe(false);
    expect(runConnectorToolchain).toHaveBeenCalledWith(
      tools.pythonExecutable,
      expect.objectContaining({
        options: expect.not.objectContaining({ live: expect.anything() }),
      }),
      expect.anything(),
    );
    expect(logs).toHaveBeenCalledExactlyOnceWith('Connector tests passed.');
  });

  it.each([
    ['connectors', 'check', '--help'],
    ['connectors', 'build', '--help'],
    ['connectors', 'build', '--live'],
    ['connectors', 'build', '--output'],
    ['connectors', 'build', 'stray'],
    ['connectors', 'manifest', 'generate', '--help'],
    ['connectors', 'check', '--live'],
    ['connectors', 'doctor', '--live'],
    ['connectors', 'manifest', 'check', '--live'],
    ['connectors', 'check', '--unknown'],
    ['connectors', 'test', '--project'],
    ['connectors', 'check', 'stray'],
    ['connectors', 'manifest', 'check', 'extra'],
  ])('does not bootstrap for help or invalid arguments: %j', async (...args) => {
    await expect(parse(args)).rejects.toBeDefined();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(runConnectorToolchain).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  });

  it.each(['CHECK_FAILED', 'TESTS_FAILED', 'UNSUPPORTED_PROTOCOL', 'CANCELLED'])(
    'preserves machine error %s and exit status',
    async (code) => {
      vi.mocked(runConnectorToolchain).mockResolvedValue({
        protocolVersion: 1,
        ok: false,
        error: { code, message: 'Fixture actionable failure' },
      });
      await parse(['--json', 'connectors', 'check']);
      expect(jsonOutput()).toEqual({ error: { code, message: 'Fixture actionable failure' } });
      expect(process.exitCode).toBe(code === 'CANCELLED' ? 130 : 1);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it('keeps the existing CLI JSON error envelope', async () => {
    const error = new CliError('Fixture failure', ErrorCode.API_ERROR);
    vi.mocked(runConnectorToolchain).mockResolvedValue({
      protocolVersion: 1,
      ok: false,
      error: { code: error.code, message: error.message },
    });
    await parse(['--json', 'connectors', 'check']);
    expect(jsonOutput()).toEqual(JSON.parse(formatError(error, true)));
    expect(logs.mock.calls[0][0]).toBe(formatError(error, true));
  });

  it('sends a human failure to stderr with no success output', async () => {
    vi.mocked(runConnectorToolchain).mockResolvedValue({
      protocolVersion: 1,
      ok: false,
      error: { code: 'CHECK_FAILED', message: 'Refresh the stale manifest' },
    });
    await parse(['connectors', 'check']);
    expect(errors).toHaveBeenCalledExactlyOnceWith('Error: Refresh the stale manifest');
    expect(logs).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each(['bootstrap', 'transport'])('preserves typed %s failures', async (phase) => {
    const error = new ToolchainTransportError('UNAVAILABLE', 'Install compatible Python');
    if (phase === 'bootstrap') bootstrap.mockRejectedValue(error);
    else vi.mocked(runConnectorToolchain).mockRejectedValue(error);
    await parse(['--json', 'connectors', 'check']);
    expect(jsonOutput()).toEqual({
      error: { code: 'UNAVAILABLE', message: 'Install compatible Python' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('does not expose unknown internal exception content', async () => {
    bootstrap.mockRejectedValue(new Error('PRIVATE_TEST_DETAILS'));
    await parse(['--json', 'connectors', 'check']);
    expect(jsonOutput()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Connector operation failed; verify the selected toolchain.',
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it('preserves cancellation during bootstrap without starting the machine', async () => {
    bootstrap.mockImplementation(
      (_project, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new Error('PRIVATE_ABORT_DETAIL')),
            { once: true },
          );
        }),
    );
    const pending = parse(['--json', 'connectors', 'check']);
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    const added = process
      .listeners('SIGINT')
      .filter((listener) => !signalListeners.SIGINT.includes(listener));
    expect(added).toHaveLength(1);
    added[0]();
    await pending;
    expect(runConnectorToolchain).not.toHaveBeenCalled();
    expect(jsonOutput()).toEqual({
      error: { code: 'CANCELLED', message: 'Connector operation cancelled' },
    });
    expect(process.exitCode).toBe(130);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('aborts on %s and preserves existing listeners', async (signal, exitCode) => {
    vi.mocked(runConnectorToolchain).mockImplementation(
      (_python, _request, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => reject(new ToolchainTransportError('CANCELLED', 'Fixture cancelled')),
            { once: true },
          );
        }),
    );
    const pending = parse(['--json', 'connectors', 'check']);
    await vi.waitFor(() => expect(runConnectorToolchain).toHaveBeenCalledOnce());
    const added = process
      .listeners(signal)
      .filter((listener) => !signalListeners[signal].includes(listener));
    expect(added).toHaveLength(1);
    // Invoke only this adapter's listener; never signal the test runner itself.
    added[0]();
    await pending;
    expect(bootstrap.mock.calls[0][1].signal.aborted).toBe(true);
    expect(jsonOutput()).toMatchObject({ error: { code: 'CANCELLED' } });
    expect(process.exitCode).toBe(exitCode);
  });
});
