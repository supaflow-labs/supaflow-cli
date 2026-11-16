import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';

interface EnvironmentTools {
  uvExecutable: string;
  pythonExecutable: string;
  wheelDir: string;
  uvCacheDir: string;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'))
  );
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ToolchainTransportError(
    'INVALID_INPUT',
    'Environment output already exists; choose a fresh destination',
  );
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
}

/**
 * Inactive bootstrap from trusted checked requirements, not raw project input.
 * The caller owns compatibility, acquisition, identity and an unshared output.
 * Each native process has its own deadline; published environments are never updated.
 */
export async function prepareOfflineConnectorEnvironment(
  outputDir: string,
  requirements: Uint8Array,
  tools: EnvironmentTools,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  if (
    !(requirements instanceof Uint8Array) ||
    requirements.byteLength === 0 ||
    [outputDir, tools.uvExecutable, tools.pythonExecutable, tools.wheelDir, tools.uvCacheDir].some(
      (path) => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'),
    )
  ) {
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Supply absolute environment/tool/cache paths and nonempty checked requirements',
    );
  }
  const snapshot = Buffer.from(requirements);
  const output = resolve(outputDir),
    cache = resolve(tools.uvCacheDir);
  if (inside(output, cache) || inside(cache, output)) {
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Use separate environment and UV cache directories',
    );
  }
  requireActive(options.signal);
  await requireAbsent(output);
  await mkdir(dirname(output), { recursive: true });
  const scratch = await mkdtemp(join(dirname(output), '.supaflow-environment-'));
  const staged = join(scratch, 'environment');
  const python = join(staged, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  // No UV target/seed/override flags may redirect this fixed offline operation.
  // Index/proxy configuration is not consumed: all wheels are already available.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('UV_')),
  );
  const common = [
    '--offline',
    '--no-config',
    '--no-python-downloads',
    '--cache-dir',
    cache,
    '--quiet',
  ];
  const run = async (args: string[], phase: string) =>
    runPythonProcess(
      tools.uvExecutable,
      args,
      null,
      (_raw, status) => {
        if (status !== 0)
          throw new ToolchainTransportError(
            'PROCESS_FAILED',
            `Cannot ${phase}; check the selected Python, locked wheels and storage`,
          );
      },
      { signal: options.signal, timeoutMs: options.timeoutMs, stderr: 'ignore', env: environment },
    );
  try {
    const input = join(scratch, 'requirements.txt');
    await writeFile(input, snapshot, { flag: 'wx' });
    await run(
      [
        'venv',
        staged,
        '--python',
        tools.pythonExecutable,
        '--no-project',
        '--relocatable',
        ...common,
      ],
      'create the connector environment',
    );
    await run(
      [
        'pip',
        'sync',
        input,
        '--python',
        python,
        '--no-index',
        '--find-links',
        tools.wheelDir,
        '--require-hashes',
        '--only-binary=:all:',
        '--link-mode=copy',
        '--no-allow-empty-requirements',
        ...common,
      ],
      'install the exact wheel set',
    );
    await run(['pip', 'check', '--python', python, ...common], 'verify environment dependencies');
    await requireAbsent(output);
    requireActive(options.signal);
    await rename(staged, output);
    return join(output, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  } finally {
    // Cleanup must not replace cancellation/errors or report a published env as failed.
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
