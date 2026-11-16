import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { renderCustomSourceTemplate } from './connector-templates.js';
import {
  runConnectorToolchain,
  ToolchainTransportError,
  type ToolchainRequest,
} from './connector-toolchain.js';
import { VERSION } from '../version.js';

type ConnectorTemplate = Omit<ReturnType<typeof renderCustomSourceTemplate>, 'templateId'> & {
  templateId: 'custom-source' | 'api-source' | 'sql-source';
};

const METADATA_PATH = '.supaflow/template.json';

export class ConnectorInitConflictError extends Error {
  constructor(readonly targetDir: string) {
    super(`Connector project target already exists: ${targetDir}; choose a new directory`);
    this.name = 'ConnectorInitConflictError';
  }
}

export class ConnectorInitOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorInitOperationError';
  }
}

export interface LockedConnectorInitOptions {
  toolchainVersion: string;
  pythonExecutable: string;
  uvExecutable: string;
  nodeExecutable: string;
  sdkVersion: string;
  runtimeVersion: string | null;
  requiredHostProtocol: number;
  agentExecutionPython: string;
  offline: boolean;
}

async function requireAbsent(targetDir: string): Promise<void> {
  try {
    await lstat(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ConnectorInitConflictError(targetDir);
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
  }
}

/** Inactive init primitive. The caller owns bundled selection and toolchain validation. */
export async function initializeConnectorProject(
  targetDir: string,
  template: ConnectorTemplate,
  toolchainVersion: string,
  prepareAndValidate: (stagingDir: string) => Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!isAbsolute(targetDir) || targetDir.includes('\0')) {
    throw new Error('Select an absolute connector project target');
  }
  if (!/^[0-9][A-Za-z0-9.!+-]*$/.test(toolchainVersion)) {
    throw new Error('Provide the selected toolchain distribution version');
  }
  const target = resolve(targetDir);
  const files = Object.entries(template.files).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [path] of files) {
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      path.includes(':') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      path === METADATA_PATH
    ) {
      throw new Error('Bundled connector template contains an invalid file path');
    }
  }
  requireActive(options.signal);
  await requireAbsent(target);
  const scratch = await mkdtemp(join(dirname(target), '.supaflow-init-'));
  const staging = join(scratch, 'project');
  try {
    // Keep the temporary wrapper private and publish a normal umask-created root.
    await mkdir(staging);
    for (const [path, contents] of files) {
      const destination = join(staging, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents, { encoding: 'utf8', flag: 'wx' });
    }
    await mkdir(join(staging, '.supaflow'), { recursive: true });
    await writeFile(
      join(staging, METADATA_PATH),
      JSON.stringify(
        {
          schemaVersion: 1,
          templateId: template.templateId,
          templateVersion: template.templateVersion,
          cliVersion: VERSION,
          toolchainVersion,
          createdAt: new Date().toISOString(),
          files: Object.fromEntries(
            files.map(([path, contents]) => [
              path,
              createHash('sha256').update(contents, 'utf8').digest('hex'),
            ]),
          ),
        },
        null,
        2,
      ) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    );
    await prepareAndValidate(staging);
    // One caller owns the target. Recheck observed conflicts before publishing;
    // concurrent writers and power-loss durability are outside this primitive.
    await requireAbsent(target);
    requireActive(options.signal);
    await rename(staging, target);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Inactive composition; bootstrap owns acquisition and the project environment.
 * timeoutMs bounds each machine call; the signal also guards final publication.
 */
export async function initializeLockedConnectorProject(
  targetDir: string,
  template: ConnectorTemplate,
  tools: LockedConnectorInitOptions,
  transport: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  await initializeConnectorProject(
    targetDir,
    template,
    tools.toolchainVersion,
    async (staging) => {
      const invoke = async (request: ToolchainRequest) => {
        const response = await runConnectorToolchain(tools.pythonExecutable, request, transport);
        if (!response.ok) {
          throw new ConnectorInitOperationError(response.error.code, response.error.message);
        }
      };
      // The outer initializer owns this private wrapper and cleans its children.
      const proposal = join(dirname(staging), 'runtime');
      await invoke({
        protocolVersion: 1,
        operation: 'runtime.propose',
        projectDir: staging,
        options: {
          uvExecutable: tools.uvExecutable,
          outputDir: proposal,
          sdkVersion: tools.sdkVersion,
          runtimeVersion: tools.runtimeVersion,
          requiredHostProtocol: tools.requiredHostProtocol,
          agentExecutionPython: tools.agentExecutionPython,
          offline: tools.offline,
        },
      });
      await rename(join(proposal, 'runtime.lock'), join(staging, 'runtime.lock'));
      await rename(join(proposal, 'deps'), join(staging, 'deps'));
      await invoke({
        protocolVersion: 1,
        operation: 'manifest.generate',
        projectDir: staging,
        options: { nodeExecutable: tools.nodeExecutable },
      });
      await invoke({
        protocolVersion: 1,
        operation: 'check',
        projectDir: staging,
        options: {
          uvExecutable: tools.uvExecutable,
          nodeExecutable: tools.nodeExecutable,
          offline: tools.offline,
        },
      });
    },
    { signal: transport.signal },
  );
}
