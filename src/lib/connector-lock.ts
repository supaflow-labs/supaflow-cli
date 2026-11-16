import { mkdtemp, mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnectorToolchain, ToolchainTransportError } from './connector-toolchain.js';

const FILES = ['deps/pyproject.toml', 'deps/uv.lock'] as const;
const INPUTS = ['pyproject.toml', 'runtime.lock', ...FILES, 'uv.toml', 'deps/uv.toml'] as const;

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
  tools: { pythonExecutable: string; uvExecutable: string },
  options: { offline: boolean; signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const active = () => {
    if (options.signal?.aborted)
      throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
  };
  active();
  const modes = await Promise.all(
    FILES.map(async (name) => {
      try {
        const info = await lstat(join(projectDir, name));
        if (!info.isFile())
          throw new ToolchainTransportError(
            'INVALID_INPUT',
            'Generated dependency files must be regular files; preserve symlinks before locking',
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
  const scratch = await mkdtemp(join(tmpdir(), 'supaflow-connector-lock-'));
  let replacement: string | undefined;
  try {
    const outputDir = join(scratch, 'generated');
    const result = await runConnectorToolchain(
      tools.pythonExecutable,
      {
        protocolVersion: 1,
        operation: 'dependencies.generate',
        projectDir,
        options: { uvExecutable: tools.uvExecutable, outputDir, offline: options.offline },
      },
      options,
    );
    if (!result.ok) throw new ConnectorLockOperationError(result.error.code, result.error.message);
    const next = await Promise.all(
      ['pyproject.toml', 'uv.lock'].map((name) => readFile(join(outputDir, name))),
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
    if (next.every((value, i) => before[i + 2]?.equals(value))) return;
    const deps = join(projectDir, 'deps');
    await mkdir(deps, { recursive: true });
    replacement = await mkdtemp(join(deps, '.supaflow-lock-'));
    await writeFile(join(replacement, '.gitignore'), '*\n');
    for (let i = 0; i < FILES.length; i++) {
      await writeFile(join(replacement, `new-${i}`), next[i], { mode: modes[i] });
      if (before[i + 2] !== null)
        await writeFile(join(replacement, `old-${i}`), before[i + 2]!, { mode: modes[i] });
    }
    active();
    const published: number[] = [];
    try {
      for (let i = 0; i < FILES.length; i++) {
        await rename(join(replacement, `new-${i}`), join(projectDir, FILES[i]));
        published.push(i);
      }
    } catch {
      // Finish restoring the pair even if cancellation arrived during rename.
      let restored = true;
      for (const i of published.reverse()) {
        try {
          if (before[i + 2] === null) await rm(join(projectDir, FILES[i]));
          else await rename(join(replacement, `old-${i}`), join(projectDir, FILES[i]));
        } catch {
          restored = false;
        }
      }
      throw new ConnectorLockOperationError(
        'LOCK_PUBLICATION_FAILED',
        restored
          ? 'Cannot publish dependency locks; original files restored. Check storage and retry'
          : 'Dependency lock publication is incomplete; review deps/pyproject.toml and deps/uv.lock and rerun connectors lock before check/build',
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (replacement !== undefined)
      await rm(replacement, { recursive: true, force: true }).catch(() => {});
  }
}
