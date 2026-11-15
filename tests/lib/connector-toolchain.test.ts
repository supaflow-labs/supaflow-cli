import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runConnectorToolchain, type ToolchainRequest } from '../../src/lib/connector-toolchain.js';

const info = { protocolVersion: 1, operation: 'info' } as const;
const success = { protocolVersion: 1, ok: true, result: { operations: ['info'] } };
let root: string;
let python: string;
let scenario: string;
let captured: string;

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
details = {'request': request, 'isolated': sys.flags.isolated, 'pid': os.getpid()}
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

  it('sends the checked test request and returns its exact success shape', async () => {
    const request: ToolchainRequest = {
      protocolVersion: 1,
      operation: 'test',
      projectDir: '/fixture/project with spaces',
      options: {
        uvExecutable: '/fixture/uv',
        nodeExecutable: process.execPath,
        runtimeWheelDir: '/fixture/locked wheels',
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
          runtimeWheelDir: '/fixture/locked wheels',
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
        runtimeWheelDir: '/fixture/wheels',
        outputDir: '/fixture/deps',
        offline: true,
      },
    };
    await expect(runConnectorToolchain(python, request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
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
