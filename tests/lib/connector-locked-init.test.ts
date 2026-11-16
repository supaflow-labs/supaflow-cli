import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/connector-toolchain.js', async (original) => {
  const module = await original<typeof import('../../src/lib/connector-toolchain.js')>();
  return { ...module, runConnectorToolchain: vi.fn() };
});

import { runConnectorToolchain } from '../../src/lib/connector-toolchain.js';
import { ToolchainTransportError } from '../../src/lib/connector-python-process.js';
import {
  ConnectorInitOperationError,
  initializeLockedConnectorProject,
  type LockedConnectorInitOptions,
} from '../../src/lib/connector-init.js';
import {
  renderApiSourceTemplate,
  renderCustomSourceTemplate,
  renderSqlSourceTemplate,
} from '../../src/lib/connector-templates.js';

const metadata = {
  connectorName: 'ACME',
  displayName: 'Acme',
  groupId: 'com.acme',
  version: '1.2.3.dev1',
  requiresPython: '>=3.11,<3.15',
  sdkVersion: '1.0.73.dev0',
  testkitVersion: '0.1.0',
  runtimeVersion: '0.1.0',
};
const tools: LockedConnectorInitOptions = {
  toolchainVersion: '0.1.0',
  pythonExecutable: '/tools/python',
  uvExecutable: '/tools/uv',
  nodeExecutable: process.execPath,
  runtimeWheelDir: '/tools/wheels',
  runtimeWheels: ['/tools/wheels/sdk.whl'],
  requiredHostProtocol: 2,
  agentExecutionPython: '>=3.12,<3.15',
  offline: true,
};
let root: string;
let target: string;
let fail: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  fail = undefined;
  root = await mkdtemp(join(tmpdir(), 'supaflow locked init ; '));
  target = join(root, 'project');
  vi.mocked(runConnectorToolchain).mockImplementation(async (_python, request) => {
    expect(existsSync(target)).toBe(false);
    if (request.operation === fail) {
      return {
        protocolVersion: 1,
        ok: false,
        error: {
          code: request.operation === 'runtime.propose' ? 'LOCK_FAILED' : 'CHECK_FAILED',
          message: 'Fixture phase did not pass',
        },
      };
    }
    if (request.operation === 'runtime.propose') {
      const output = request.options.outputDir;
      await mkdir(join(output, 'deps'), { recursive: true });
      await writeFile(join(output, 'runtime.lock'), 'selected runtime bytes\n');
      await writeFile(join(output, 'deps/pyproject.toml'), 'generated projection\n');
      await writeFile(join(output, 'deps/uv.lock'), 'generated dependency lock\n');
      return { protocolVersion: 1, ok: true, result: { proposalDir: output } };
    }
    if (request.operation === 'manifest.generate') {
      expect(await readFile(join(request.projectDir, 'runtime.lock'), 'utf8')).toBe(
        'selected runtime bytes\n',
      );
      await writeFile(join(request.projectDir, 'connector.yaml'), 'canonical manifest\n');
      return { protocolVersion: 1, ok: true, result: { manifest: 'connector.yaml' } };
    }
    if (request.operation === 'check') {
      expect(await readFile(join(request.projectDir, 'connector.yaml'), 'utf8')).toBe(
        'canonical manifest\n',
      );
      return { protocolVersion: 1, ok: true, result: { checked: true } };
    }
    throw new Error('Unexpected init operation');
  });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe('locked project initialization composition', () => {
  it.each([renderCustomSourceTemplate, renderApiSourceTemplate, renderSqlSourceTemplate])(
    'publishes only after selection, canonical manifest and full check (%#)',
    async (render) => {
      const template = render(metadata);
      const transport = { signal: new AbortController().signal, timeoutMs: 25_000 };
      await initializeLockedConnectorProject(target, template, tools, transport);
      expect(await readdir(root)).toEqual(['project']);
      expect(await readFile(join(target, 'runtime.lock'), 'utf8')).toBe('selected runtime bytes\n');
      expect(await readFile(join(target, 'deps/uv.lock'), 'utf8')).toBe(
        'generated dependency lock\n',
      );
      expect(await readFile(join(target, 'deps/pyproject.toml'), 'utf8')).toBe(
        'generated projection\n',
      );
      expect(await readFile(join(target, 'connector.yaml'), 'utf8')).toBe('canonical manifest\n');
      for (const [name, raw] of Object.entries(template.files)) {
        expect(await readFile(join(target, name), 'utf8')).toBe(raw);
      }
      expect(
        JSON.parse(await readFile(join(target, '.supaflow/template.json'), 'utf8')),
      ).toMatchObject({
        templateId: template.templateId,
        toolchainVersion: tools.toolchainVersion,
      });
      const calls = vi.mocked(runConnectorToolchain).mock.calls;
      expect(calls.map((call) => call[1].operation)).toEqual([
        'runtime.propose',
        'manifest.generate',
        'check',
      ]);
      expect(
        calls.every((call) => call[0] === tools.pythonExecutable && call[2] === transport),
      ).toBe(true);
      expect(calls[0][1]).toMatchObject({
        options: {
          uvExecutable: tools.uvExecutable,
          runtimeWheels: tools.runtimeWheels,
          requiredHostProtocol: tools.requiredHostProtocol,
          agentExecutionPython: tools.agentExecutionPython,
          offline: true,
        },
      });
      expect(calls[2][1]).toMatchObject({
        options: {
          uvExecutable: tools.uvExecutable,
          nodeExecutable: tools.nodeExecutable,
          runtimeWheelDir: tools.runtimeWheelDir,
        },
      });
      expect(existsSync(join(target, '.venv'))).toBe(false);
    },
  );

  it.each(['runtime.propose', 'manifest.generate', 'check'])(
    'preserves a %s failure and removes only private staging',
    async (operation) => {
      fail = operation;
      const error = await initializeLockedConnectorProject(
        target,
        renderCustomSourceTemplate(metadata),
        tools,
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(ConnectorInitOperationError);
      expect(error).toMatchObject({
        code: operation === 'runtime.propose' ? 'LOCK_FAILED' : 'CHECK_FAILED',
        message: 'Fixture phase did not pass',
      });
      expect(await readdir(root)).toEqual([]);
      expect(vi.mocked(runConnectorToolchain).mock.calls.at(-1)![1].operation).toBe(operation);
    },
  );

  it.each(['runtime.propose', 'manifest.generate'])(
    'keeps cancellation at %s intact and cleans any staged locks',
    async (phase) => {
      const cancelled = new ToolchainTransportError('CANCELLED', 'Fixture cancelled');
      const previous = vi.mocked(runConnectorToolchain).getMockImplementation()!;
      vi.mocked(runConnectorToolchain).mockImplementation(async (...args) => {
        if (args[1].operation === phase) throw cancelled;
        return previous(...args);
      });
      await expect(
        initializeLockedConnectorProject(target, renderCustomSourceTemplate(metadata), tools),
      ).rejects.toBe(cancelled);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('stops pre-cancelled initialization before staging or machine work', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      initializeLockedConnectorProject(target, renderCustomSourceTemplate(metadata), tools, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(runConnectorToolchain).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('honors cancellation after successful check before final publication', async () => {
    const controller = new AbortController();
    const previous = vi.mocked(runConnectorToolchain).getMockImplementation()!;
    vi.mocked(runConnectorToolchain).mockImplementation(async (...args) => {
      const result = await previous(...args);
      if (args[1].operation === 'check') controller.abort();
      return result;
    });
    await expect(
      initializeLockedConnectorProject(target, renderCustomSourceTemplate(metadata), tools, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses an existing project before starting any machine operation', async () => {
    await mkdir(target);
    await writeFile(join(target, 'keep'), 'author data');
    await expect(
      initializeLockedConnectorProject(target, renderCustomSourceTemplate(metadata), tools),
    ).rejects.toThrow('target already exists');
    expect(runConnectorToolchain).not.toHaveBeenCalled();
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('author data');
  });
});
