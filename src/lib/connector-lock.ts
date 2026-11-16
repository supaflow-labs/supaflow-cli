import { mkdtemp, mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runConnectorToolchain,
  ToolchainTransportError,
  type ConnectorAgentTarget,
  type ToolchainRequest,
} from './connector-toolchain.js';

const FILES = ['deps/pyproject.toml', 'deps/uv.lock'] as const;
const INPUTS = ['pyproject.toml', 'runtime.lock', ...FILES, 'uv.toml', 'deps/uv.toml'] as const;

type LockTools = {
  pythonExecutable: string;
  uvExecutable: string;
  agentTargets?: readonly ConnectorAgentTarget[];
};
type LockOptions = { offline: boolean; signal?: AbortSignal; timeoutMs?: number };
export type ConnectorRuntimeProposal = Pick<
  Extract<ToolchainRequest, { operation: 'runtime.propose' }>['options'],
  'sdkVersion' | 'runtimeVersion' | 'requiredHostProtocol' | 'agentExecutionPython'
>;
export interface ConnectorRuntimeLockChange {
  before: Buffer;
  after: Buffer;
}

export class ConnectorLockOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function snapshot(root: string): Promise<(Buffer | null)[]> {
  return Promise.all(
    INPUTS.map(async (name) => {
      try {
        return await readFile(join(root, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }),
  );
}

/** One caller owns the project; normal errors roll back, power loss needs re-locking. */
export async function refreshConnectorDependencyLocks(
  projectDir: string,
  tools: LockTools,
  options: LockOptions,
): Promise<void> {
  await refreshLocks(projectDir, tools, options);
}

/** Explicit selection only; the native producer checks authored constraints. */
export async function upgradeConnectorRuntimeLocks(
  projectDir: string,
  tools: LockTools,
  selection: ConnectorRuntimeProposal,
  options: LockOptions,
): Promise<ConnectorRuntimeLockChange> {
  if (!selection)
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Choose an explicit runtime proposal before upgrading locks',
    );
  return refreshLocks(projectDir, tools, options, selection);
}

async function refreshLocks(
  projectDir: string,
  tools: LockTools,
  options: LockOptions,
  selection?: ConnectorRuntimeProposal,
): Promise<ConnectorRuntimeLockChange> {
  const files: readonly (typeof INPUTS)[number][] = selection ? ['runtime.lock', ...FILES] : FILES;
  const active = () => {
    if (options.signal?.aborted)
      throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
  };
  active();
  const modes = await Promise.all(
    files.map(async (name) => {
      try {
        const info = await lstat(join(projectDir, name));
        if (!info.isFile())
          throw new ToolchainTransportError(
            'INVALID_INPUT',
            'Connector lock files must be regular files; preserve symlinks before locking',
          );
        return info.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0o666;
        throw error;
      }
    }),
  );
  let before: (Buffer | null)[];
  try {
    before = await snapshot(projectDir);
  } catch {
    throw new ToolchainTransportError(
      'PROCESS_FAILED',
      'Cannot read connector lock inputs; check project permissions',
    );
  }
  if (before[1] === null)
    throw new ConnectorLockOperationError(
      'MISSING_RUNTIME_LOCK',
      'Commit pyproject.toml and runtime.lock before locking dependencies; use connectors init for initial selection',
    );
  if (before[0] === null)
    throw new ConnectorLockOperationError(
      'LOCK_FAILED',
      'Declare pyproject.toml before locking connector dependencies',
    );
  const runtimeBefore = before[1];
  const previous = files.map((name) => before[INPUTS.indexOf(name)]);
  const scratch = await mkdtemp(join(tmpdir(), 'supaflow-connector-lock-'));
  let replacement: string | undefined;
  let retainReplacement = false;
  try {
    const outputDir = join(scratch, 'generated');
    const request: ToolchainRequest = selection
      ? {
          protocolVersion: 1,
          operation: 'runtime.propose',
          projectDir,
          options: {
            ...selection,
            uvExecutable: tools.uvExecutable,
            outputDir,
            offline: options.offline,
            ...(tools.agentTargets === undefined ? {} : { agentTargets: tools.agentTargets }),
          },
        }
      : {
          protocolVersion: 1,
          operation: 'dependencies.generate',
          projectDir,
          options: {
            uvExecutable: tools.uvExecutable,
            outputDir,
            offline: options.offline,
            ...(tools.agentTargets === undefined ? {} : { agentTargets: tools.agentTargets }),
          },
        };
    const result = await runConnectorToolchain(tools.pythonExecutable, request, options);
    if (!result.ok) throw new ConnectorLockOperationError(result.error.code, result.error.message);
    const next = await Promise.all(
      files.map((name) => readFile(join(outputDir, selection ? name : name.slice('deps/'.length)))),
    );
    active();
    const current = await snapshot(projectDir);
    if (
      !current.every((value, i) => (value === null ? before[i] === null : before[i]?.equals(value)))
    )
      throw new ToolchainTransportError(
        'PROCESS_FAILED',
        'Project inputs changed during locking; review the edits and retry',
      );
    const change = { before: runtimeBefore, after: selection ? next[0] : runtimeBefore };
    if (next.every((value, i) => previous[i]?.equals(value))) return change;
    const deps = join(projectDir, 'deps');
    await mkdir(deps, { recursive: true });
    replacement = await mkdtemp(join(deps, '.supaflow-lock-'));
    await writeFile(join(replacement, '.gitignore'), '*\n');
    for (let i = 0; i < files.length; i++) {
      await writeFile(join(replacement, `new-${i}`), next[i], { mode: modes[i] });
      if (previous[i] !== null)
        await writeFile(join(replacement, `old-${i}`), previous[i]!, { mode: modes[i] });
    }
    active();
    const published: number[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        await rename(join(replacement, `new-${i}`), join(projectDir, files[i]));
        published.push(i);
      }
    } catch {
      // Finish restoring all published files even after cancellation.
      let restored = true;
      for (const i of published.reverse()) {
        try {
          if (previous[i] === null) await rm(join(projectDir, files[i]));
          else await rename(join(replacement, `old-${i}`), join(projectDir, files[i]));
        } catch {
          restored = false;
        }
      }
      retainReplacement = !restored;
      const recovery = files
        .map(
          (name, i) =>
            `${name}: ${
              previous[i] === null
                ? 'originally absent; remove if still present'
                : `restore old-${i} if present`
            }`,
        )
        .join('; ');
      throw new ConnectorLockOperationError(
        'LOCK_PUBLICATION_FAILED',
        restored
          ? 'Cannot publish connector locks; original files restored. Check storage and retry'
          : `Connector lock publication is incomplete; recovery files remain in ${replacement} (${recovery}). Restore the original state before check/build`,
      );
    }
    return change;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (replacement !== undefined && !retainReplacement)
      await rm(replacement, { recursive: true, force: true }).catch(() => {});
  }
}
