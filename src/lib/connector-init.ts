import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { renderCustomSourceTemplate } from './connector-templates.js';
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

async function requireAbsent(targetDir: string): Promise<void> {
  try {
    await lstat(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ConnectorInitConflictError(targetDir);
}

/** Inactive init primitive. The caller owns bundled selection and toolchain validation. */
export async function initializeConnectorProject(
  targetDir: string,
  template: ConnectorTemplate,
  toolchainVersion: string,
  prepareAndValidate: (stagingDir: string) => Promise<void>,
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
    await rename(staging, target);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
