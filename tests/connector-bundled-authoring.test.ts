import { Command } from 'commander';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/connector-authoring-bundle.js', () => ({
  readConnectorAuthoringBundle: vi.fn(),
}));
vi.mock('../src/lib/connector-bootstrap.js', () => ({ bootstrapConnectorToolchain: vi.fn() }));
vi.mock('../src/lib/connector-environment.js', async (original) => ({
  ...(await original<typeof import('../src/lib/connector-environment.js')>()),
  prepareConnectorProjectEnvironment: vi.fn(),
}));
vi.mock('../src/lib/connector-init.js', async (original) => ({
  ...(await original<typeof import('../src/lib/connector-init.js')>()),
  initializeLockedConnectorProject: vi.fn(),
}));
vi.mock('../src/lib/connector-lock.js', async (original) => ({
  ...(await original<typeof import('../src/lib/connector-lock.js')>()),
  upgradeConnectorRuntimeLocks: vi.fn(),
}));
vi.mock('../src/lib/connector-toolchain.js', async (original) => ({
  ...(await original<typeof import('../src/lib/connector-toolchain.js')>()),
  runConnectorToolchain: vi.fn(),
}));
import { readConnectorAuthoringBundle } from '../src/lib/connector-authoring-bundle.js';
import { bootstrapConnectorToolchain } from '../src/lib/connector-bootstrap.js';
import {
  prepareConnectorProjectEnvironment,
  ConnectorProjectPreparationError,
} from '../src/lib/connector-environment.js';
import { initializeLockedConnectorProject } from '../src/lib/connector-init.js';
import { upgradeConnectorRuntimeLocks } from '../src/lib/connector-lock.js';
import { runConnectorToolchain } from '../src/lib/connector-toolchain.js';
import { registerBundledConnectorAuthoringCommands } from '../src/commands/connector-bundled-authoring.js';

const assets = '/cli-owned/assets',
  project = '/fixture/project',
  cacheDir = '/fixture/cache';
const requirements = Buffer.from('verified requirements');
const bundle = {
  schemaVersion: 1 as const,
  cliVersion: '0.8.0',
  requiresPython: '>=3.11,<3.15',
  toolchainVersion: '0.1.0',
  sdkVersion: '1.0.73.dev0',
  runtimeVersion: '0.1.0',
  testkitVersion: '0.1.0',
  uvVersion: '0.13.4',
  requirementsSha256: 'a'.repeat(64),
  projectRequiresPython: '>=3.12,<3.15',
  requiredHostProtocol: 2,
  agentExecutionPython: '>=3.14,<3.15',
  templateVersions: {
    'custom-source': 1 as const,
    'api-source': 1 as const,
    'sql-source': 1 as const,
  },
  agentTargets: [{ name: 'wire-fixture', environment: {}, wheelTags: ['py3-none-any'] }],
};
const tools = {
  pythonExecutable: '/cache/python',
  uvExecutable: '/cache/uv',
  nodeExecutable: process.execPath,
};
let local = true,
  exit: typeof process.exitCode,
  log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  local = true;
  exit = process.exitCode;
  process.exitCode = undefined;
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(readConnectorAuthoringBundle).mockResolvedValue({ bundle, requirements });
  vi.mocked(bootstrapConnectorToolchain).mockResolvedValue(tools);
  vi.mocked(prepareConnectorProjectEnvironment).mockResolvedValue(
    join(project, '.venv/bin/python'),
  );
  vi.mocked(initializeLockedConnectorProject).mockResolvedValue();
  vi.mocked(runConnectorToolchain).mockImplementation(async (_python, request) => ({
    protocolVersion: 1,
    ok: true,
    result:
      request.operation === 'doctor'
        ? {
            diagnostics: {
              python: { currentMatches: { local }, intersections: { local: '>=3.12,<3.13' } },
            } as never,
          }
        : request.operation === 'test'
          ? { tested: true }
          : { checked: true },
  }));
});
afterEach(() => {
  process.exitCode = exit;
  vi.restoreAllMocks();
});
function program() {
  const root = new Command().exitOverride().option('--json');
  registerBundledConnectorAuthoringCommands(root.command('connectors'), assets, {
    cacheDir,
    timeoutMs: 7000,
  });
  return root;
}
const parse = (args: string[]) =>
  program().parseAsync(['--json', 'connectors', ...args, '--offline'], { from: 'user' });

it('does not read or provision anything during registration', () => {
  program();
  expect(readConnectorAuthoringBundle).not.toHaveBeenCalled();
  expect(bootstrapConnectorToolchain).not.toHaveBeenCalled();
});

it.each(['custom-source', 'api-source', 'sql-source'])(
  'initializes %s with checked bundle selection and project preparation',
  async (template) => {
    await parse([
      'init',
      project,
      '--template',
      template,
      '--name',
      'ACME',
      '--group',
      'io.supaflow',
      '--requires-python',
      '>=3.12,<3.13',
    ]);
    expect(vi.mocked(bootstrapConnectorToolchain).mock.calls[0]).toEqual([
      { ...bundle, requiresPython: `${bundle.requiresPython},>=3.12,<3.13` },
      requirements,
      {
        offline: true,
        signal: expect.any(AbortSignal),
        cacheDir,
        timeoutMs: 7000,
        configurationDir: '/fixture',
      },
    ]);
    expect(vi.mocked(initializeLockedConnectorProject).mock.calls[0][2]).toEqual({
      ...tools,
      toolchainVersion: bundle.toolchainVersion,
      sdkVersion: bundle.sdkVersion,
      runtimeVersion: template === 'custom-source' ? null : bundle.runtimeVersion,
      testkitVersion: bundle.testkitVersion,
      projectRequiresPython: bundle.projectRequiresPython,
      requiredHostProtocol: bundle.requiredHostProtocol,
      agentExecutionPython: bundle.agentExecutionPython,
      offline: true,
      projectEnvironment: {
        bundleRequirements: requirements,
        uvCacheDir: join(cacheDir, 'uv'),
        agentTargets: bundle.agentTargets,
      },
    });
    expect(process.exitCode).toBeUndefined();
  },
);

it.each(['check', 'test', 'manifest'])(
  'prepares before %s using project inputs and checked targets',
  async (operation) => {
    await parse([operation, ...(operation === 'manifest' ? ['check'] : []), '--project', project]);
    expect(readConnectorAuthoringBundle).toHaveBeenCalledExactlyOnceWith(assets);
    expect(prepareConnectorProjectEnvironment).toHaveBeenCalledExactlyOnceWith(
      project,
      {
        ...tools,
        bundleRequirements: requirements,
        uvCacheDir: join(cacheDir, 'uv'),
        agentTargets: bundle.agentTargets,
      },
      { offline: true, signal: expect.any(AbortSignal), timeoutMs: 7000 },
    );
    expect(vi.mocked(runConnectorToolchain).mock.calls.map((call) => call[0])).toEqual([
      tools.pythonExecutable,
      join(project, '.venv/bin/python'),
    ]);
    expect(process.exitCode).toBeUndefined();
  },
);

it('uses native bootstrap to select the project intersection when its current Python cannot run it', async () => {
  local = false;
  const compatible = {
    ...tools,
    pythonExecutable: '/other-compatible/python',
    uvExecutable: '/other-compatible/uv',
  };
  vi.mocked(bootstrapConnectorToolchain)
    .mockResolvedValueOnce(tools)
    .mockResolvedValueOnce(compatible);
  await parse(['check', '--project', project]);
  expect(vi.mocked(bootstrapConnectorToolchain).mock.calls[1][0]).toEqual({
    ...bundle,
    requiresPython: `${bundle.requiresPython},>=3.12,<3.13`,
  });
  expect(prepareConnectorProjectEnvironment).toHaveBeenCalledOnce();
  expect(vi.mocked(prepareConnectorProjectEnvironment).mock.calls[0][1]).toMatchObject(compatible);
  expect(vi.mocked(bootstrapConnectorToolchain).mock.calls[1][2]).toMatchObject({
    configurationDir: project,
  });
});

it('selects the recommended project Python when init has no explicit range', async () => {
  await parse([
    'init',
    project,
    '--template',
    'custom-source',
    '--name',
    'ACME',
    '--group',
    'com.acme',
  ]);
  expect(vi.mocked(bootstrapConnectorToolchain).mock.calls[0][0].requiresPython).toBe(
    `${bundle.requiresPython},${bundle.projectRequiresPython}`,
  );
  expect(process.exitCode).toBeUndefined();
});

it('supplies the checked bundle recommendation to the explicit upgrade command', async () => {
  vi.mocked(runConnectorToolchain).mockResolvedValue({
    protocolVersion: 1,
    ok: true,
    result: {
      runtime: { wheels: [{ name: 'supaflow-python-sdk' }] } as never,
      runtimeSha256: 'a'.repeat(64),
    },
  });
  vi.mocked(upgradeConnectorRuntimeLocks).mockResolvedValue({
    before: Buffer.from('before'),
    after: Buffer.from('after'),
  });
  await parse(['lock', '--upgrade-runtime', '--project', project]);
  expect(vi.mocked(upgradeConnectorRuntimeLocks).mock.calls[0][2]).toEqual({
    sdkVersion: bundle.sdkVersion,
    runtimeVersion: null,
    requiredHostProtocol: bundle.requiredHostProtocol,
    agentExecutionPython: bundle.agentExecutionPython,
  });
  expect(prepareConnectorProjectEnvironment).not.toHaveBeenCalled();
});

it.each(['doctor', 'lock'])('keeps %s read-only for the project environment', async (operation) => {
  await parse([operation, ...(operation === 'lock' ? ['--check'] : []), '--project', project]);
  expect(prepareConnectorProjectEnvironment).not.toHaveBeenCalled();
  if (operation === 'lock')
    expect(vi.mocked(runConnectorToolchain).mock.calls[0][1]).toMatchObject({
      options: { agentTargets: bundle.agentTargets },
    });
});

it('passes a preparation rejection through the command without launching source', async () => {
  vi.mocked(prepareConnectorProjectEnvironment).mockRejectedValue(
    new ConnectorProjectPreparationError('LOCK_FAILED', 'Uncovered fixture target'),
  );
  await parse(['check', '--project', project]);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ error: { code: 'LOCK_FAILED', message: 'Uncovered fixture target' } }),
  );
  expect(vi.mocked(runConnectorToolchain).mock.calls.map((call) => call[1].operation)).toEqual([
    'doctor',
  ]);
  expect(process.exitCode).toBe(1);
});
