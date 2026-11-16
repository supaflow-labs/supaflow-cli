import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runConnectorToolchain,
  type ToolchainRequest,
  type AuthoringDiagnostics,
  type RuntimeSelection,
} from '../../src/lib/connector-toolchain.js';

const info = { protocolVersion: 1, operation: 'info' } as const;
const success = { protocolVersion: 1, ok: true, result: { operations: ['info'] } };
let root: string;
let python: string;
let scenario: string;
let captured: string;

function runtimeFixture(sdkOnly = false): { runtime: RuntimeSelection; runtimeSha256: string } {
  const sdk = {
    name: 'supaflow-python-sdk' as const,
    version: '1.2.3',
    filename: 'supaflow_python_sdk-1.2.3-py3-none-any.whl',
    sha256: 'a'.repeat(64),
    tags: ['py3-none-any'],
  };
  const runtime = {
    name: 'supaflow-connector-runtime' as const,
    version: '2.0.0',
    filename: 'supaflow_connector_runtime-2.0.0-py3-none-any.whl',
    sha256: 'b'.repeat(64),
    tags: ['py3-none-any'],
  };
  return {
    runtime: {
      schemaVersion: 1,
      connectorApiVersion: 1,
      sdkDistributionVersion: '1.2.3',
      requiredHostProtocol: 2,
      agentExecutionPython: '>=3.12,<3.15',
      wheels: sdkOnly ? [sdk] : [runtime, sdk],
    },
    runtimeSha256: 'c'.repeat(64),
  };
}

function doctorFixture(): AuthoringDiagnostics {
  const distribution = { version: '0.1.0', requiresPython: '>=3.11,<3.15' };
  return {
    schemaVersion: 1,
    installed: {
      toolchain: { ...distribution },
      sdk: { ...distribution, version: '8.0.0' },
      testkit: { ...distribution },
      runtime: null,
    },
    selected: {
      sdkDistributionVersion: '1.2.3',
      runtimeDistributionVersion: null,
      connectorApiVersion: 1,
      requiredHostProtocol: 2,
    },
    python: {
      version: '3.14.0+',
      executable: '/fixture/env/bin/python',
      environment: '/fixture/env',
      interpreterTag: 'cp314-cp314-manylinux_2_28_x86_64',
      declaredRanges: {
        toolchainRequiresPython: '>=3.11',
        projectRequiresPython: '>=3.11,<3.15',
        dependencyRequiresPython: '>=3.12,<3.15',
        runtimeDeclaredAgentPython: '>=99',
      },
      intersections: { local: '>=3.12,<3.15', execution: '>=99,<3.15', all: '>=99,<3.15' },
      currentMatches: { local: true, execution: false, all: false },
    },
    locks: {
      runtimeSha256: 'a'.repeat(64),
      dependenciesSha256: 'b'.repeat(64),
      dependencyLockVersion: 1,
      projectionRuntimeMatches: false,
    },
    template: null,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'supaflow toolchain ; '));
  execFileSync('python3', ['-m', 'venv', '--without-pip', root]);
  python = join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const site = execFileSync(
    python,
    ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
    { encoding: 'utf8' },
  ).trim();
  const module = join(site, 'supaflow_connector_toolchain');
  mkdirSync(module);
  writeFileSync(join(module, '__init__.py'), '');
  scenario = join(module, 'scenario.json');
  captured = join(module, 'captured.json');
  writeFileSync(
    join(module, '__main__.py'),
    `import base64, json, os, subprocess, sys, time
from pathlib import Path
root = Path(__file__).parent
request = json.load(sys.stdin)
scenario = json.loads((root / 'scenario.json').read_text())
details = {'request': request, 'isolated': sys.flags.isolated, 'pid': os.getpid(),
           'uvOffline': os.environ.get('UV_OFFLINE')}
if scenario.get('descendant'):
    descendant = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(10)'])
    details['descendantPid'] = descendant.pid
(root / 'captured.pending').write_text(json.dumps(details))
os.replace(root / 'captured.pending', root / 'captured.json')
if scenario.get('progress'):
    print('Fixture progress', file=sys.stderr, flush=True)
if scenario.get('sleep'):
    time.sleep(10)
sys.stdout.buffer.write(base64.b64decode(scenario['stdout']))
sys.stdout.buffer.flush()
raise SystemExit(scenario['status'])
`,
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function configure(
  stdout: string | Buffer = JSON.stringify(success) + '\n',
  status = 0,
  extra = {},
) {
  writeFileSync(
    scenario,
    JSON.stringify({ stdout: Buffer.from(stdout).toString('base64'), status, ...extra }),
  );
  rmSync(captured, { force: true });
}

describe('connector toolchain subprocess', () => {
  it.each([undefined, false, true])(
    'keeps offline control in the child environment (%j)',
    async (offline) => {
      vi.stubEnv('UV_OFFLINE', 'false');
      try {
        configure();
        expect(await runConnectorToolchain(python, info, { offline })).toEqual(success);
        expect(JSON.parse(readFileSync(captured, 'utf8')).uvOffline).toBe(
          offline ? 'true' : 'false',
        );
        expect(process.env.UV_OFFLINE).toBe('false');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it('uses isolated Python, stdin JSON and executable paths with spaces/metacharacters', async () => {
    configure();
    expect(await runConnectorToolchain(python, info)).toEqual(success);
    expect(JSON.parse(readFileSync(captured, 'utf8'))).toMatchObject({
      request: info,
      isolated: 1,
    });
  });

  it('keeps project strings in stdin rather than shell arguments', async () => {
    const manifest = { protocolVersion: 1, ok: true, result: { manifest: 'connector.yaml' } };
    configure(JSON.stringify(manifest) + '\n');
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'manifest.check',
      projectDir: '/fixture/$(never-run); "quoted"',
      options: { nodeExecutable: process.execPath },
    };
    expect(await runConnectorToolchain(python, request)).toEqual(manifest);
    expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
  });

  it.each([
    [1, 'CHECK_FAILED'],
    [130, 'CANCELLED'],
  ] as const)(
    'returns a structured Python failure with status %s unchanged',
    async (status, code) => {
      const failure = {
        protocolVersion: 1,
        ok: false,
        error: { code, message: 'Actionable fixture failure' },
      };
      configure(JSON.stringify(failure) + '\n', status);
      expect(await runConnectorToolchain(python, info)).toEqual(failure);
    },
  );

  it.each([undefined, false, true])('forwards explicit live test selection %s', async (live) => {
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'test',
      projectDir: '/fixture/project with spaces',
      options: {
        uvExecutable: '/fixture/uv',
        nodeExecutable: process.execPath,
        runtimeWheelDir: '/fixture/locked wheels',
        ...(live === undefined ? {} : { live }),
      },
    };
    const passed = { protocolVersion: 1, ok: true, result: { tested: true } };
    configure(JSON.stringify(passed) + '\n');
    expect(await runConnectorToolchain(python, request)).toEqual(passed);
    expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
    const failed = {
      protocolVersion: 1,
      ok: false,
      error: { code: 'TESTS_FAILED', message: 'See pytest diagnostics on stderr' },
    };
    configure(JSON.stringify(failed) + '\n', 1);
    expect(await runConnectorToolchain(python, request)).toEqual(failed);
  });

  it.each([
    ['test', { checked: true }],
    ['check', { tested: true }],
    ['test', { tested: false }],
    ['test', { tested: true, extra: true }],
    ['test', { operations: ['test'] }],
    ['test', { manifest: 'connector.yaml' }],
  ] as const)(
    'rejects success for the wrong operation or result shape (%#)',
    async (operation, result) => {
      configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
      const request: ToolchainRequest = {
        protocolVersion: 1,
        operation,
        projectDir: '/fixture/project',
        options: {
          uvExecutable: '/fixture/uv',
          nodeExecutable: process.execPath,
          runtimeWheelDir: '/fixture/wheels',
        },
      };
      await expect(runConnectorToolchain(python, request)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    },
  );

  it('sends dependency-check fields without Node or output and preserves worker failures', async () => {
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'dependencies.check',
      projectDir: '/fixture/project ; quoted',
      options: { uvExecutable: '/fixture/uv', offline: true },
    };
    const checked = { protocolVersion: 1, ok: true, result: { checked: true } };
    configure(JSON.stringify(checked) + '\n');
    expect(await runConnectorToolchain(python, request)).toEqual(checked);
    expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
    for (const code of [
      'LOCK_FAILED',
      'MISSING_RUNTIME_LOCK',
      'MISSING_RUNTIME_WHEEL',
      'UNSUPPORTED_OPERATION',
    ]) {
      const failure = {
        protocolVersion: 1,
        ok: false,
        error: { code, message: 'Fixture failure' },
      };
      configure(JSON.stringify(failure) + '\n', 1);
      expect(await runConnectorToolchain(python, request)).toEqual(failure);
    }
  });

  it.each([
    { checked: false },
    { checked: true, extra: true },
    { tested: true },
    { dependencyDir: '/output' },
  ])('rejects an invalid dependency-check success: %j', async (result) => {
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
    await expect(
      runConnectorToolchain(python, {
        protocolVersion: 1,
        operation: 'dependencies.check',
        projectDir: '/fixture/project',
        options: { uvExecutable: '/fixture/uv', offline: true },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('sends the build staging destination in stdin and accepts its matching absolute result', async () => {
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'artifact.build',
      projectDir: '/fixture/project with spaces',
      options: {
        uvExecutable: '/fixture/uv',
        nodeExecutable: process.execPath,
        runtimeWheelDir: '/fixture/wheels',
        outputDir: '/fixture/staging ; quoted',
      },
    };
    for (const artifactDir of ['/fixture/staging ; quoted', '/fixture/./staging ; quoted/']) {
      const built = { protocolVersion: 1, ok: true, result: { artifactDir } };
      configure(JSON.stringify(built) + '\n');
      expect(await runConnectorToolchain(python, request)).toEqual(built);
      expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
    }
    const failed = {
      protocolVersion: 1,
      ok: false,
      error: { code: 'BUILD_FAILED', message: 'Staging already exists' },
    };
    configure(JSON.stringify(failed) + '\n', 1);
    expect(await runConnectorToolchain(python, request)).toEqual(failed);
  });

  it.each([
    { artifactDir: 'relative' },
    { artifactDir: '/different/staging' },
    { artifactDir: '/fixture/invalid\0path' },
    { artifactDir: 1 },
    { artifactDir: '/fixture/staging', extra: true },
    { tested: true },
    { manifest: 'connector.yaml' },
  ])('rejects invalid artifact staging responses (%#)', async (result) => {
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'artifact.build',
      projectDir: '/fixture/project',
      options: {
        uvExecutable: '/fixture/uv',
        nodeExecutable: process.execPath,
        runtimeWheelDir: '/fixture/wheels',
        outputDir: '/fixture/staging',
      },
    };
    await expect(runConnectorToolchain(python, request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it.each([true, false])(
    'sends dependency staging with offline=%s and preserves lock failures',
    async (offline) => {
      const request: ToolchainRequest = {
        protocolVersion: 1,
        operation: 'dependencies.generate',
        projectDir: '/fixture/project with spaces',
        options: {
          uvExecutable: '/fixture/uv',
          outputDir: '/fixture/deps ; quoted',
          offline,
        },
      };
      for (const dependencyDir of ['/fixture/deps ; quoted', '/fixture/./deps ; quoted/']) {
        const generated = { protocolVersion: 1, ok: true, result: { dependencyDir } };
        configure(JSON.stringify(generated) + '\n');
        expect(await runConnectorToolchain(python, request)).toEqual(generated);
        expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
      }
      const failure = {
        protocolVersion: 1,
        ok: false,
        error: { code: 'LOCK_FAILED', message: 'Dependency output already exists' },
      };
      configure(JSON.stringify(failure) + '\n', 1);
      expect(await runConnectorToolchain(python, request)).toEqual(failure);
    },
  );

  it('forwards requirements export and preserves its staged output and failures', async () => {
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'dependencies.export',
      projectDir: '/fixture/project with spaces',
      options: {
        uvExecutable: '/fixture/uv',
        outputDir: '/fixture/requirements ; quoted',
      },
    };
    for (const requirementsDir of [
      '/fixture/requirements ; quoted',
      '/fixture/./requirements ; quoted/',
    ]) {
      const exported = { protocolVersion: 1, ok: true, result: { requirementsDir } };
      configure(JSON.stringify(exported) + '\n');
      expect(await runConnectorToolchain(python, request)).toEqual(exported);
      expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
    }
    const failure = {
      protocolVersion: 1,
      ok: false,
      error: { code: 'LOCK_FAILED', message: 'Cannot export installer requirements' },
    };
    configure(JSON.stringify(failure) + '\n', 1);
    expect(await runConnectorToolchain(python, request)).toEqual(failure);
  });

  it.each([
    { requirementsDir: 'relative' },
    { requirementsDir: '/different/requirements' },
    { requirementsDir: '/fixture/invalid\0path' },
    { requirementsDir: 1 },
    { requirementsDir: '/fixture/requirements', extra: true },
    { dependencyDir: '/fixture/requirements' },
    { checked: true },
  ])('rejects invalid requirements staging responses (%#)', async (result) => {
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'dependencies.export',
      projectDir: '/fixture/project',
      options: {
        uvExecutable: '/fixture/uv',
        outputDir: '/fixture/requirements',
      },
    };
    await expect(runConnectorToolchain(python, request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it.each([
    { dependencyDir: 'relative' },
    { dependencyDir: '/different/deps' },
    { dependencyDir: '/fixture/invalid\0path' },
    { dependencyDir: 1 },
    { dependencyDir: '/fixture/deps', extra: true },
    { artifactDir: '/fixture/deps' },
    { checked: true },
    { manifest: 'connector.yaml' },
  ])('rejects invalid dependency staging responses (%#)', async (result) => {
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'dependencies.generate',
      projectDir: '/fixture/project',
      options: {
        uvExecutable: '/fixture/uv',
        outputDir: '/fixture/deps',
        offline: true,
      },
    };
    await expect(runConnectorToolchain(python, request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('sends an explicit runtime proposal and preserves its structured failures', async () => {
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'runtime.propose',
      projectDir: '/fixture/project with spaces',
      options: {
        uvExecutable: '/fixture/uv',
        outputDir: '/fixture/proposal ; quoted',
        runtimeWheels: ['/fixture/selected wheels/sdk.whl', '/fixture/selected wheels/runtime.whl'],
        requiredHostProtocol: 2,
        agentExecutionPython: '>=3.12,<3.15',
        offline: true,
      },
    };
    for (const proposalDir of ['/fixture/proposal ; quoted', '/fixture/./proposal ; quoted/']) {
      const proposed = { protocolVersion: 1, ok: true, result: { proposalDir } };
      configure(JSON.stringify(proposed) + '\n');
      expect(await runConnectorToolchain(python, request)).toEqual(proposed);
      expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
    }
    for (const code of ['LOCK_FAILED', 'MISSING_RUNTIME_WHEEL']) {
      const failure = {
        protocolVersion: 1,
        ok: false,
        error: { code, message: 'Proposal rejected' },
      };
      configure(JSON.stringify(failure) + '\n', 1);
      expect(await runConnectorToolchain(python, request)).toEqual(failure);
    }
  });

  it.each([
    { proposalDir: 'relative' },
    { proposalDir: '/different/proposal' },
    { proposalDir: '/fixture/invalid\0path' },
    { proposalDir: 1 },
    { proposalDir: '/fixture/proposal', extra: true },
    { dependencyDir: '/fixture/proposal' },
    { artifactDir: '/fixture/proposal' },
    { checked: true },
  ])('rejects invalid runtime proposal responses (%#)', async (result) => {
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'runtime.propose',
      projectDir: '/fixture/project',
      options: {
        uvExecutable: '/fixture/uv',
        outputDir: '/fixture/proposal',
        runtimeWheels: ['/fixture/sdk.whl'],
        requiredHostProtocol: 2,
        agentExecutionPython: '>=3.12,<3.15',
        offline: false,
      },
    };
    await expect(runConnectorToolchain(python, request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it.each([true, false])(
    'forwards source-free runtime inspection without changing project selection (SDK-only %s)',
    async (sdkOnly) => {
      const request: ToolchainRequest = {
        protocolVersion: 1,
        operation: 'runtime.inspect',
        projectDir: '/fixture/project with spaces',
        options: {},
      };
      const result = { protocolVersion: 1, ok: true, result: runtimeFixture(sdkOnly) };
      configure(JSON.stringify(result) + '\n');
      expect(await runConnectorToolchain(python, request)).toEqual(result);
      expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
      for (const code of ['MISSING_RUNTIME_LOCK', 'CHECK_FAILED']) {
        const failure = {
          protocolVersion: 1,
          ok: false,
          error: { code, message: 'Select a valid project runtime' },
        };
        configure(JSON.stringify(failure) + '\n', 1);
        expect(await runConnectorToolchain(python, request)).toEqual(failure);
      }
    },
  );

  it.each(['connectorApiVersion', 'requiredHostProtocol'] as const)(
    'preserves the largest exact JSON integer in %s',
    async (field) => {
      const result = runtimeFixture();
      result.runtime[field] = Number.MAX_SAFE_INTEGER;
      configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
      expect(
        await runConnectorToolchain(python, {
          protocolVersion: 1,
          operation: 'runtime.inspect',
          projectDir: '/fixture/project',
          options: {},
        }),
      ).toEqual({ protocolVersion: 1, ok: true, result });
    },
  );

  it.each([
    [
      'unknown schema',
      (r: ReturnType<typeof runtimeFixture>) => Object.assign(r.runtime, { schemaVersion: 2 }),
    ],
    [
      'unsafe API integer',
      (r: ReturnType<typeof runtimeFixture>) =>
        (r.runtime.connectorApiVersion = Number.MAX_SAFE_INTEGER + 1),
    ],
    [
      'nonpositive protocol',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.requiredHostProtocol = 0),
    ],
    [
      'noninteger API',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.connectorApiVersion = 1.5),
    ],
    [
      'nonwheel suffix',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].filename = 'wheel.tar.gz'),
    ],
    [
      'extra wheel field',
      (r: ReturnType<typeof runtimeFixture>) =>
        Object.assign(r.runtime.wheels[0], { source: 'untrusted' }),
    ],
    [
      'uppercase wheel digest',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].sha256 = 'A'.repeat(64)),
    ],
    [
      'short wheel digest',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].sha256 = 'a'.repeat(63)),
    ],
    [
      'unsupported runtime field',
      (r: ReturnType<typeof runtimeFixture>) => Object.assign(r.runtime, { source: 'untrusted' }),
    ],
    [
      'missing runtime field',
      (r: ReturnType<typeof runtimeFixture>) =>
        Reflect.deleteProperty(r.runtime, 'agentExecutionPython'),
    ],
    ['no wheels', (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels = [])],
    [
      'missing SDK',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels = r.runtime.wheels.slice(0, 1)),
    ],
    [
      'duplicate names',
      (r: ReturnType<typeof runtimeFixture>) =>
        (r.runtime.wheels = [r.runtime.wheels[1], r.runtime.wheels[1]]),
    ],
    [
      'duplicate filenames',
      (r: ReturnType<typeof runtimeFixture>) =>
        (r.runtime.wheels[0].filename = r.runtime.wheels[1].filename),
    ],
    [
      'unselected package',
      (r: ReturnType<typeof runtimeFixture>) =>
        Object.assign(r.runtime.wheels[0], { name: 'third-party' }),
    ],
    [
      'mismatched SDK version',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.sdkDistributionVersion = '9.0.0'),
    ],
    [
      'traversal filename',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].filename = '../wheel.whl'),
    ],
    [
      'Windows path',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].filename = 'C:\\wheel.whl'),
    ],
    [
      'NUL filename',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].filename = 'bad\0.whl'),
    ],
    [
      'bad wheel digest',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].sha256 = 'g'.repeat(64)),
    ],
    ['empty tags', (r: ReturnType<typeof runtimeFixture>) => (r.runtime.wheels[0].tags = [])],
    [
      'bad tag type',
      (r: ReturnType<typeof runtimeFixture>) => Object.assign(r.runtime.wheels[0], { tags: [1] }),
    ],
    [
      'uppercase lock digest',
      (r: ReturnType<typeof runtimeFixture>) => (r.runtimeSha256 = 'C'.repeat(64)),
    ],
    [
      'extra result field',
      (r: ReturnType<typeof runtimeFixture>) => Object.assign(r, { extra: true }),
    ],
  ] as const)('rejects malformed runtime inspection data: %s', async (_name, edit) => {
    const result = runtimeFixture();
    edit(result);
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result }) + '\n');
    await expect(
      runConnectorToolchain(python, {
        protocolVersion: 1,
        operation: 'runtime.inspect',
        projectDir: '/fixture/project',
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('forwards empty doctor options without changing reported versions or compatibility', async () => {
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'doctor',
      projectDir: '/fixture/project with spaces',
      options: {},
    };
    const diagnostics = doctorFixture();
    for (const template of [
      null,
      {
        templateId: 'api-source',
        templateVersion: 1,
        cliVersion: '0.8.0',
        toolchainVersion: '0.1.0',
        createdAt: '2026-11-15T00:00:00.000Z',
      },
    ]) {
      diagnostics.template = template;
      const result = { protocolVersion: 1, ok: true, result: { diagnostics } };
      configure(JSON.stringify(result) + '\n');
      expect(await runConnectorToolchain(python, request)).toEqual(result);
      expect(JSON.parse(readFileSync(captured, 'utf8')).request).toEqual(request);
    }
    diagnostics.selected.runtimeDistributionVersion = '2.0.0';
    const missingRuntime = { protocolVersion: 1, ok: true, result: { diagnostics } };
    configure(JSON.stringify(missingRuntime) + '\n');
    expect(await runConnectorToolchain(python, request)).toEqual(missingRuntime);
    diagnostics.installed.runtime = { version: '2.0.0', requiresPython: '>=3.11' };
    const result = { protocolVersion: 1, ok: true, result: { diagnostics } };
    configure(JSON.stringify(result) + '\n');
    expect(await runConnectorToolchain(python, request)).toEqual(result);
    const failure = {
      protocolVersion: 1,
      ok: false,
      error: { code: 'CHECK_FAILED', message: 'Prepare project inputs' },
    };
    configure(JSON.stringify(failure) + '\n', 1);
    expect(await runConnectorToolchain(python, request)).toEqual(failure);
  });

  it.each([
    ['schema', (d: AuthoringDiagnostics) => Object.assign(d, { schemaVersion: 2 })],
    ['extra root', (d: AuthoringDiagnostics) => Object.assign(d, { extra: true })],
    ['missing selected', (d: AuthoringDiagnostics) => Reflect.deleteProperty(d, 'selected')],
    [
      'missing required installed',
      (d: AuthoringDiagnostics) => Reflect.deleteProperty(d.installed, 'sdk'),
    ],
    [
      'malformed optional installed',
      (d: AuthoringDiagnostics) => Object.assign(d.installed, { runtime: [] }),
    ],
    [
      'extra distribution field',
      (d: AuthoringDiagnostics) => Object.assign(d.installed.sdk, { extra: true }),
    ],
    [
      'nonstring installed version',
      (d: AuthoringDiagnostics) => Object.assign(d.installed.sdk, { version: 1 }),
    ],
    [
      'nonstring selected',
      (d: AuthoringDiagnostics) => Object.assign(d.selected, { sdkDistributionVersion: true }),
    ],
    [
      'invalid optional selected',
      (d: AuthoringDiagnostics) => Object.assign(d.selected, { runtimeDistributionVersion: 1 }),
    ],
    [
      'API boolean',
      (d: AuthoringDiagnostics) => Object.assign(d.selected, { connectorApiVersion: true }),
    ],
    [
      'host negative',
      (d: AuthoringDiagnostics) => Object.assign(d.selected, { requiredHostProtocol: -1 }),
    ],
    [
      'host unsafe integer',
      (d: AuthoringDiagnostics) =>
        Object.assign(d.selected, { requiredHostProtocol: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      'empty interpreter tag',
      (d: AuthoringDiagnostics) => {
        d.python.interpreterTag = '';
      },
    ],
    [
      'relative executable',
      (d: AuthoringDiagnostics) => {
        d.python.executable = 'python';
      },
    ],
    [
      'relative environment',
      (d: AuthoringDiagnostics) => {
        d.python.environment = 'env';
      },
    ],
    [
      'NUL environment',
      (d: AuthoringDiagnostics) => {
        d.python.environment = '/bad\0env';
      },
    ],
    [
      'missing range',
      (d: AuthoringDiagnostics) =>
        Reflect.deleteProperty(d.python.declaredRanges, 'runtimeDeclaredAgentPython'),
    ],
    [
      'nonstring intersection',
      (d: AuthoringDiagnostics) => Object.assign(d.python.intersections, { all: true }),
    ],
    [
      'nonboolean match',
      (d: AuthoringDiagnostics) => Object.assign(d.python.currentMatches, { all: 'false' }),
    ],
    [
      'extra match',
      (d: AuthoringDiagnostics) => Object.assign(d.python.currentMatches, { extra: false }),
    ],
    [
      'bad hash',
      (d: AuthoringDiagnostics) => {
        d.locks.runtimeSha256 = 'bad';
      },
    ],
    [
      'uppercase hash',
      (d: AuthoringDiagnostics) => {
        d.locks.runtimeSha256 = 'A'.repeat(64);
      },
    ],
    [
      'nonboolean projection',
      (d: AuthoringDiagnostics) => Object.assign(d.locks, { projectionRuntimeMatches: 1 }),
    ],
    [
      'noninteger lock version',
      (d: AuthoringDiagnostics) => {
        d.locks.dependencyLockVersion = 1.5;
      },
    ],
    ['empty template', (d: AuthoringDiagnostics) => Object.assign(d, { template: {} })],
    [
      'nonpositive template version',
      (d: AuthoringDiagnostics) =>
        Object.assign(d, {
          template: {
            templateId: 'api-source',
            templateVersion: 0,
            cliVersion: '0.8.0',
            toolchainVersion: '0.1.0',
            createdAt: 'today',
          },
        }),
    ],
  ] as const)('rejects malformed doctor diagnostics: %s', async (_name, edit) => {
    const diagnostics = doctorFixture();
    edit(diagnostics);
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result: { diagnostics } }) + '\n');
    await expect(
      runConnectorToolchain(python, {
        protocolVersion: 1,
        operation: 'doctor',
        projectDir: '/fixture/project',
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects an unrelated successful result for doctor', async () => {
    configure(JSON.stringify({ protocolVersion: 1, ok: true, result: { checked: true } }) + '\n');
    await expect(
      runConnectorToolchain(python, {
        protocolVersion: 1,
        operation: 'doctor',
        projectDir: '/fixture/project',
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('keeps inherited stderr progress out of the protocol result', async () => {
    configure(JSON.stringify(success) + '\n', 0, { progress: true });
    expect(await runConnectorToolchain(python, info)).toEqual(success);
  });

  it.each([
    ['PRIVATE_SUBPROCESS_DETAIL\n', 0],
    [JSON.stringify(success), 0],
    [JSON.stringify(success) + '\n{}\n', 0],
    [JSON.stringify({ ...success, protocolVersion: 2 }) + '\n', 0],
    [JSON.stringify({ ...success, extra: true }) + '\n', 0],
    ['{"protocolVersion":1,"ok":true,"result":{}}\n', 0],
    ['{"protocolVersion":1,"ok":true,"result":{"operations":[],"extra":1}}\n', 0],
    [
      '{"protocolVersion":1,"ok":false,"error":{"code":"CHECK_FAILED","message":"stale","extra":1}}\n',
      1,
    ],
    [JSON.stringify(success) + '\n', 1],
    ['{"protocolVersion":1,"ok":false,"error":{"code":"CHECK_FAILED","message":"stale"}}\n', 0],
    [Buffer.from([0xff, 0x0a]), 0],
    ['x'.repeat(512 * 1024 + 1), 0],
  ])('rejects malformed responses without echoing subprocess content (%#)', async (raw, status) => {
    configure(raw, status);
    const error = await runConnectorToolchain(python, info).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect((error as Error).message).not.toContain('PRIVATE_SUBPROCESS_DETAIL');
  });

  it('accepts a valid response exactly at the byte limit including its newline', async () => {
    const raw = JSON.stringify(success);
    configure(' '.repeat(512 * 1024 - Buffer.byteLength(raw) - 1) + raw + '\n');
    expect(await runConnectorToolchain(python, info)).toEqual(success);
  });

  it('reports unavailable Python safely', async () => {
    await expect(runConnectorToolchain(join(root, 'missing-python'), info)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('rejects a relative Python executable before starting a process', async () => {
    configure();
    await expect(runConnectorToolchain('python', info)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(existsSync(captured)).toBe(false);
  });

  it('does not start a process for a pre-aborted signal', async () => {
    configure();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runConnectorToolchain(python, info, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(existsSync(captured)).toBe(false);
  });

  it('forwards cancellation and waits for child close', async () => {
    configure('', 0, { sleep: true });
    const controller = new AbortController();
    const pending = runConnectorToolchain(python, info, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(existsSync(captured)).toBe(true));
    controller.abort();
    await rejected;
    const { pid } = JSON.parse(readFileSync(captured, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('bounds an unresponsive process with the operation timeout', async () => {
    configure('', 0, { sleep: true });
    await expect(runConnectorToolchain(python, info, { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('keeps the deadline after Python exits while a descendant retains stdout', async () => {
    configure(JSON.stringify(success) + '\n', 0, { descendant: true });
    try {
      await expect(runConnectorToolchain(python, info, { timeoutMs: 1000 })).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
      const { pid, descendantPid } = JSON.parse(readFileSync(captured, 'utf8'));
      expect(typeof descendantPid).toBe('number');
      expect(() => process.kill(pid, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).not.toThrow();
    } finally {
      if (existsSync(captured)) {
        const { descendantPid } = JSON.parse(readFileSync(captured, 'utf8'));
        if (descendantPid) process.kill(descendantPid, 'SIGTERM');
      }
    }
  });

  it('cancels after Python exits while a descendant retains stdout', async () => {
    configure(JSON.stringify(success) + '\n', 0, { descendant: true });
    const controller = new AbortController();
    const pending = runConnectorToolchain(python, info, {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      await vi.waitFor(() => expect(existsSync(captured)).toBe(true));
      const { pid } = JSON.parse(readFileSync(captured, 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      controller.abort();
      await rejected;
    } finally {
      controller.abort();
      await rejected;
      if (existsSync(captured)) {
        const { descendantPid } = JSON.parse(readFileSync(captured, 'utf8'));
        if (descendantPid) process.kill(descendantPid, 'SIGTERM');
      }
    }
  });
});
