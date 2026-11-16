import { Command } from 'commander';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/lib/connector-lock.js', async (original) => ({
  ...(await original<typeof import('../src/lib/connector-lock.js')>()),
  refreshConnectorDependencyLocks: vi.fn(),
  upgradeConnectorRuntimeLocks: vi.fn(),
}));
vi.mock('../src/lib/connector-toolchain.js', async (original) => ({
  ...(await original<typeof import('../src/lib/connector-toolchain.js')>()),
  runConnectorToolchain: vi.fn(),
}));
import {
  upgradeConnectorRuntimeLocks,
  refreshConnectorDependencyLocks,
  ConnectorLockOperationError,
} from '../src/lib/connector-lock.js';
import { runConnectorToolchain, type RuntimeSelection } from '../src/lib/connector-toolchain.js';
import {
  registerConnectorLockCommand,
  type ConnectorLockBootstrap,
} from '../src/commands/connector-lock.js';
const bootstrap = vi.fn<ConnectorLockBootstrap>();
const recommendation = {
  sdkVersion: '1.0.74.dev0',
  runtimeVersion: '0.2.0',
  requiredHostProtocol: 2,
  agentExecutionPython: '>=3.14,<3.15',
};
const tools = {
  pythonExecutable: '/tools/python',
  uvExecutable: '/tools/uv',
  nodeExecutable: '/tools/node',
  runtimeProposal: recommendation,
};
const before = Buffer.from('old runtime.lock bytes\n'),
  after = Buffer.from('new runtime.lock bytes\n');
let exit: typeof process.exitCode, logs: ReturnType<typeof vi.spyOn>, listeners: Function[][];
function inspectedRuntime(hasRuntime: boolean): RuntimeSelection {
  const sdk = {
    name: 'supaflow-python-sdk' as const,
    version: '1.0.73.dev0',
    filename: 'supaflow_python_sdk-1.0.73.dev0-py3-none-any.whl',
    sha256: 'a'.repeat(64),
    tags: ['py3-none-any'],
  };
  return {
    schemaVersion: 1,
    connectorApiVersion: 1,
    sdkDistributionVersion: sdk.version,
    requiredHostProtocol: 2,
    agentExecutionPython: '>=3.14,<3.15',
    wheels: hasRuntime
      ? [
          sdk,
          {
            ...sdk,
            name: 'supaflow-connector-runtime',
            version: '0.1.0',
            filename: 'supaflow_connector_runtime-0.1.0-py3-none-any.whl',
          },
        ]
      : [sdk],
  };
}
function inspect(hasRuntime: boolean) {
  vi.mocked(runConnectorToolchain).mockResolvedValue({
    protocolVersion: 1,
    ok: true,
    result: { runtime: inspectedRuntime(hasRuntime), runtimeSha256: 'b'.repeat(64) },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  exit = process.exitCode;
  process.exitCode = undefined;
  listeners = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  bootstrap.mockResolvedValue(tools);
  vi.mocked(upgradeConnectorRuntimeLocks).mockResolvedValue({ before, after });
  inspect(false);
});
afterEach(() => {
  process.exitCode = exit;
  expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(listeners);
  vi.restoreAllMocks();
});
const parse = (args: string[], json = true) => {
  const root = new Command().exitOverride().option('--json');
  registerConnectorLockCommand(root.command('connectors'), bootstrap, { timeoutMs: 7000 });
  return root.parseAsync([...(json ? ['--json'] : []), 'connectors', 'lock', ...args], {
    from: 'user',
  });
};
const output = () => {
  expect(logs).toHaveBeenCalledTimes(1);
  return JSON.parse(logs.mock.calls[0][0]);
};

it.each([false, true])(
  'upgrades independent recommended versions (runtime=%s)',
  async (hasRuntime) => {
    inspect(hasRuntime);
    await parse(['--upgrade-runtime', '--offline']);
    expect(vi.mocked(upgradeConnectorRuntimeLocks).mock.calls[0][2]).toEqual({
      ...recommendation,
      runtimeVersion: hasRuntime ? recommendation.runtimeVersion : null,
    });
    expect(output()).toEqual({
      locked: true,
      runtimeLockDiff: { before: before.toString(), after: after.toString() },
    });
    expect(refreshConnectorDependencyLocks).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  },
);

it.each([false, true])('applies --to to the project package (runtime=%s)', async (hasRuntime) => {
  inspect(hasRuntime);
  await parse(['--upgrade-runtime', '--to', '9.1.0']);
  expect(vi.mocked(upgradeConnectorRuntimeLocks).mock.calls[0][2]).toEqual({
    ...recommendation,
    sdkVersion: hasRuntime ? recommendation.sdkVersion : '9.1.0',
    runtimeVersion: hasRuntime ? '9.1.0' : null,
  });
  expect(process.exitCode).toBeUndefined();
});

it('shows the exact runtime.lock change in plain output', async () => {
  await parse(['--upgrade-runtime'], false);
  expect(logs).toHaveBeenCalledExactlyOnceWith(
    '--- runtime.lock\n+++ runtime.lock\n-old runtime.lock bytes\n+new runtime.lock bytes',
  );
});

it('reports an unchanged selection without a misleading diff', async () => {
  vi.mocked(upgradeConnectorRuntimeLocks).mockResolvedValue({ before, after: before });
  await parse(['--upgrade-runtime'], false);
  expect(logs).toHaveBeenCalledExactlyOnceWith(
    'Runtime selection unchanged; dependency locks are current.',
  );
});

it.each([
  ['--upgrade-runtime', '--check'],
  ['--to', '1.2.3'],
  ['--upgrade-runtime', '--to', ''],
  ['--upgrade-runtime', '--to', '--offline'],
])('rejects conflicting options before bootstrap: %j', async (...args) => {
  await parse(args);
  expect(output().error.code).toBe('INVALID_INPUT');
  expect(bootstrap).not.toHaveBeenCalled();
});

it('reports missing recommendations instead of doing an ordinary lock', async () => {
  bootstrap.mockResolvedValue({ ...tools, runtimeProposal: undefined });
  await parse(['--upgrade-runtime']);
  expect(output().error.code).toBe('UNAVAILABLE');
  expect(runConnectorToolchain).not.toHaveBeenCalled();
  expect(refreshConnectorDependencyLocks).not.toHaveBeenCalled();
});

it('preserves candidate compatibility errors', async () => {
  vi.mocked(upgradeConnectorRuntimeLocks).mockRejectedValue(
    new ConnectorLockOperationError('LOCK_FAILED', 'Candidate violates authored constraints'),
  );
  await parse(['--upgrade-runtime']);
  expect(output()).toEqual({
    error: { code: 'LOCK_FAILED', message: 'Candidate violates authored constraints' },
  });
  expect(process.exitCode).toBe(1);
});

it('keeps recovery failures visible even when interrupted', async () => {
  vi.mocked(upgradeConnectorRuntimeLocks).mockImplementation(async () => {
    process.emit('SIGINT');
    throw new ConnectorLockOperationError(
      'LOCK_PUBLICATION_FAILED',
      'Restore retained recovery files',
    );
  });
  await parse(['--upgrade-runtime']);
  expect(output().error.code).toBe('LOCK_PUBLICATION_FAILED');
  expect(process.exitCode).toBe(1);
});
