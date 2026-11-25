import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/connector-init.js', async (original) => {
  const module = await original<typeof import('../src/lib/connector-init.js')>();
  return { ...module, initializeLockedConnectorProject: vi.fn() };
});
import {
  initializeLockedConnectorProject,
  ConnectorInitOperationError,
} from '../src/lib/connector-init.js';
import { ConnectorProjectPreparationError } from '../src/lib/connector-environment.js';
import { ToolchainTransportError } from '../src/lib/connector-toolchain.js';
import {
  registerConnectorInitCommand,
  type ConnectorInitBootstrap,
} from '../src/commands/connector-init.js';

const tools = {
  pythonExecutable: '/tools/python',
  uvExecutable: '/tools/uv',
  nodeExecutable: '/tools/node',
  sdkVersion: '1.0.73.dev0',
  runtimeVersion: '0.1.0',
  testkitVersion: '0.1.0',
  toolchainVersion: '0.1.0',
  projectRequiresPython: '>=3.12,<3.15',
  requiredHostProtocol: 2,
  agentExecutionPython: '>=3.14,<3.15',
  offline: false,
};
const bootstrap = vi.fn<ConnectorInitBootstrap>();
let root: string, target: string;
let logs: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
let originalExit: typeof process.exitCode;
let listeners: Function[][];
beforeEach(() => {
  vi.clearAllMocks();
  originalExit = process.exitCode;
  process.exitCode = undefined;
  root = mkdtempSync(join(tmpdir(), 'supaflow init command '));
  target = join(root, 'project ; target');
  listeners = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  bootstrap.mockResolvedValue(tools);
  vi.mocked(initializeLockedConnectorProject).mockResolvedValue();
});
afterEach(() => {
  const actual = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  expect(actual).toEqual(listeners);
});
function parse(extra: string[] = [], base = true) {
  const program = new Command().version('0.0.0').exitOverride().option('--json');
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerConnectorInitCommand(program.command('connectors'), bootstrap, { timeoutMs: 15_000 });
  return program.parseAsync([
    'node',
    'supaflow',
    ...(base
      ? ['--json', 'connectors', 'init', target, '--name', 'ACME', '--group', 'com.acme']
      : []),
    ...extra,
  ]);
}
const output = () => {
  expect(logs).toHaveBeenCalledTimes(1);
  return JSON.parse(logs.mock.calls[0][0] as string);
};

describe('connector init adapter', () => {
  it('ships the init command', () => {
    const help = execFileSync(process.execPath, ['bin/supaflow.mjs', 'connectors', '--help'], {
      encoding: 'utf8',
    });
    expect(help).toMatch(/^\s+init\b/m);
  });
  it.each(['custom-source', 'api-source', 'sql-source'])(
    'uses native staged %s initialization',
    async (template) => {
      await parse(['--template', template, '--offline', '--display-name', 'Acme Source']);
      expect(bootstrap).toHaveBeenCalledExactlyOnceWith(target, {
        offline: true,
        signal: expect.any(AbortSignal),
      });
      expect(initializeLockedConnectorProject).toHaveBeenCalledExactlyOnceWith(
        target,
        expect.objectContaining({ templateId: template, templateVersion: 1 }),
        {
          ...tools,
          runtimeVersion: template === 'custom-source' ? null : tools.runtimeVersion,
          offline: true,
        },
        { signal: bootstrap.mock.calls[0][1].signal, timeoutMs: 15_000 },
      );
      const files = vi.mocked(initializeLockedConnectorProject).mock.calls[0][1].files;
      expect(files['pyproject.toml']).toContain('version = "0.1.0.dev1"');
      expect(files['pyproject.toml']).toContain('requires-python = ">=3.12,<3.15"');
      expect(files['src/supaflow_connector_acme/connector.py']).toContain('connector_name="ACME"');
      expect(output()).toEqual({ projectDir: target });
      expect(errors).not.toHaveBeenCalled();
    },
  );
  it('preserves explicit project metadata and native online configuration', async () => {
    await parse([
      '--template',
      'custom-source',
      '--connector-version',
      '1.2.3.dev2',
      '--requires-python',
      '>=3.14,<3.15',
    ]);
    expect(bootstrap.mock.calls[0][1].offline).toBe(false);
    const [, , selected] = vi.mocked(initializeLockedConnectorProject).mock.calls[0];
    expect(selected.offline).toBe(false);
    const files = vi.mocked(initializeLockedConnectorProject).mock.calls[0][1].files;
    expect(files['pyproject.toml']).toContain('version = "1.2.3.dev2"');
    expect(files['pyproject.toml']).toContain('requires-python = ">=3.14,<3.15"');
  });
  it.each([
    ['custom-source', 'io.supaflow', 'connector_type'],
    ['api-source', 'io.supaflow', 'connector_type'],
    ['sql-source', 'io.supaflow', 'connector_type'],
    ['custom-source', 'io.supaflow.internal', 'connector_type'],
    ['api-source', 'io.supaflow.internal', 'connector_type'],
    ['sql-source', 'io.supaflow.internal', 'connector_type'],
    ['custom-source', 'io.supaflowx', 'connector_name'],
    ['api-source', 'io.supaflow2', 'connector_name'],
    ['sql-source', 'io.supaflowx.internal', 'connector_name'],
  ])('uses the SDK identity field for %s in %s', async (template, group, field) => {
    await parse(['--template', template, '--group', group]);
    const source = vi.mocked(initializeLockedConnectorProject).mock.calls[0][1].files[
      'src/supaflow_connector_acme/connector.py'
    ];
    expect(source).toContain(`${field}="ACME"`);
    expect(source).not.toContain(
      `${field === 'connector_type' ? 'connector_name' : 'connector_type'}="ACME"`,
    );
    expect(output()).toEqual({ projectDir: target });
  });
  it.each([
    ['--name', 'mixedCase'],
    ['--group', 'com.bad_group'],
    ['--display-name', ' '],
    ['--connector-version', 'bad\0version'],
    ['--requires-python', ' '],
  ])('rejects malformed local metadata before bootstrap: %j', async (...args) => {
    await parse(args);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(output().error.code).toBe('INVALID_INPUT');
    expect(process.exitCode).toBe(1);
  });
  it.each([
    ['connectors', 'init', '--help'],
    ['connectors', 'init', 'target'],
    [
      'connectors',
      'init',
      'target',
      '--name',
      'ACME',
      '--group',
      'com.acme',
      '--template',
      'other',
    ],
  ])('does not bootstrap for parser exits: %j', async (...args) => {
    await expect(parse(args, false)).rejects.toThrow();
    expect(bootstrap).not.toHaveBeenCalled();
  });
  it('preserves conflicting target contents before bootstrap', async () => {
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'preserve');
    await parse();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(output().error.code).toBe('TARGET_EXISTS');
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('preserve');
  });
  it('rejects a missing runtime for runtime-backed templates', async () => {
    bootstrap.mockResolvedValue({ ...tools, runtimeVersion: null });
    await parse();
    expect(initializeLockedConnectorProject).not.toHaveBeenCalled();
    expect(output().error.code).toBe('UNAVAILABLE');
  });
  it.each([
    new ConnectorInitOperationError('LOCK_FAILED', 'Fix the project lock'),
    new ConnectorProjectPreparationError('LOCK_FAILED', 'No compatible wheel for fixture target'),
    new ToolchainTransportError('TIMEOUT', 'Timed out'),
  ])('preserves actionable typed failures: %j', async (error) => {
    vi.mocked(initializeLockedConnectorProject).mockRejectedValue(error);
    await parse();
    expect(output()).toEqual({ error: { code: error.code, message: error.message } });
    expect(process.exitCode).toBe(1);
  });
  it('redacts unexpected bootstrap errors', async () => {
    bootstrap.mockRejectedValue(new Error('PRIVATE_INIT_DETAIL'));
    await parse();
    expect(JSON.stringify(output())).not.toContain('PRIVATE_INIT_DETAIL');
    expect(process.exitCode).toBe(1);
  });
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'cancels bootstrap with %s and restores listeners',
    async (signal) => {
      bootstrap.mockImplementation(
        (_project, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new ToolchainTransportError('CANCELLED', 'cancelled')),
              { once: true },
            );
          }),
      );
      const pending = parse();
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
      process.emit(signal);
      await pending;
      expect(output().error.code).toBe('CANCELLED');
      expect(process.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
    },
  );
  it('reports successful publication when a late signal arrives during completion', async () => {
    vi.mocked(initializeLockedConnectorProject).mockImplementation(async () => {
      mkdirSync(target);
      writeFileSync(join(target, 'published'), 'complete');
      process.emit('SIGINT');
    });
    await parse();
    expect(output()).toEqual({ projectDir: target });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(target, 'published'), 'utf8')).toBe('complete');
  });
  it('prints a plain result without JSON when requested', async () => {
    await parse(
      [
        'connectors',
        'init',
        target,
        '--name',
        'ACME',
        '--group',
        'com.acme',
        '--template',
        'custom-source',
      ],
      false,
    );
    expect(logs).toHaveBeenCalledExactlyOnceWith(`Created connector project: ${resolve(target)}`);
  });
});
