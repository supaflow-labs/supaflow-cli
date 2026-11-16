import { lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { runConnectorToolchain, ToolchainTransportError } from './connector-toolchain.js';

export class ConnectorBuildOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorBuildOperationError';
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    await mkdir(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ConnectorBuildOperationError(
        'BUILD_FAILED',
        'Build output must use real directories; preserve existing files or links',
      );
    return false;
  }
}

/** One caller owns local output. Stage fully, then replace only its checked leaf. */
export async function buildVersionedConnectorArtifact(
  projectDir: string,
  tools: { pythonExecutable: string; uvExecutable: string; nodeExecutable: string },
  options: { offline: boolean; signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  if (typeof projectDir !== 'string' || !isAbsolute(projectDir) || projectDir.includes('\0'))
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Select an absolute connector project directory',
    );
  const active = () => {
    if (options.signal?.aborted)
      throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
  };
  const outputRoot = join(projectDir, 'dist');
  let createdRoot = false,
    createdParent = false,
    retain = false;
  let scratch: string | undefined, parent: string | undefined;
  try {
    active();
    createdRoot = await directory(outputRoot);
    scratch = await mkdtemp(join(outputRoot, '.supaflow-build-'));
    const candidateRoot = join(scratch, 'candidate');
    await mkdir(candidateRoot);
    const response = await runConnectorToolchain(
      tools.pythonExecutable,
      {
        protocolVersion: 1,
        operation: 'artifact.build',
        projectDir,
        options: {
          uvExecutable: tools.uvExecutable,
          nodeExecutable: tools.nodeExecutable,
          offline: options.offline,
          outputDir: candidateRoot,
          versionedOutput: true,
        },
      },
      options,
    );
    if (!response.ok)
      throw new ConnectorBuildOperationError(response.error.code, response.error.message);
    if (!('artifactDir' in response.result))
      throw new ToolchainTransportError(
        'INVALID_RESPONSE',
        'Cannot locate the checked artifact staging output',
      );
    active();
    const staged = response.result.artifactDir;
    const rootInfo = await lstat(candidateRoot),
      info = await lstat(staged);
    const physical = relative(await realpath(candidateRoot), await realpath(staged));
    const parts = physical.split(sep);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      isAbsolute(physical) ||
      parts.length !== 2 ||
      parts.some((part) => !part || part === '.' || part === '..')
    )
      throw new ConnectorBuildOperationError(
        'BUILD_FAILED',
        'Checked artifact staging must remain inside its owned directory',
      );
    const target = join(outputRoot, ...parts);
    parent = dirname(target);
    createdParent = await directory(parent);
    let previous = false;
    try {
      const entry = await lstat(target);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new ConnectorBuildOperationError(
          'BUILD_FAILED',
          'Existing build output must be a real directory; preserve the file or link',
        );
      previous = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    active();
    const backup = join(scratch, 'previous');
    if (previous) await rename(target, backup);
    try {
      // Complete publication/rollback once cutover starts, even after a signal.
      await rename(staged, target);
    } catch {
      if (previous) {
        try {
          await rename(backup, target);
        } catch {
          retain = true;
          throw new ConnectorBuildOperationError(
            'BUILD_PUBLICATION_FAILED',
            `Build publication is incomplete; restore ${backup} to ${target} before using the artifact`,
          );
        }
      }
      throw new ConnectorBuildOperationError(
        'BUILD_FAILED',
        'Cannot publish the new build; previous output preserved. Check storage and retry',
      );
    }
    return target;
  } catch (error) {
    if (error instanceof ToolchainTransportError || error instanceof ConnectorBuildOperationError)
      throw error;
    throw new ConnectorBuildOperationError(
      'BUILD_FAILED',
      'Cannot prepare or publish build output; check project storage and permissions',
    );
  } finally {
    if (scratch !== undefined && !retain)
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (createdParent && parent !== undefined) await rmdir(parent).catch(() => {});
    if (createdRoot) await rmdir(outputRoot).catch(() => {});
  }
}
