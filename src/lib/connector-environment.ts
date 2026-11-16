import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';

interface BaseTools {
  uvExecutable: string;
  pythonExecutable: string;
  uvCacheDir: string;
}

interface EnvironmentTools extends BaseTools {
  wheelDir: string;
}

type Source =
  | { kind: 'wheels'; directory: string }
  | {
      kind: 'index';
      configurationDir: string;
      offline: boolean;
    };
type Options = { signal?: AbortSignal; timeoutMs?: number };

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
  options: Options = {},
): Promise<string> {
  const prepared = await prepareEnvironment(
    outputDir,
    requirements,
    tools,
    { kind: 'wheels', directory: tools.wheelDir },
    options,
  );
  return prepared.pythonExecutable;
}

/**
 * Inactive private toolchain cache, from trusted complete hash requirements.
 * Native uv owns index/mirror/auth configuration. Target installs put scripts
 * in sitePackages/bin; this is not the normal project/agent environment layout.
 * Use Python -m for Python entry points; invoke relocatable native binaries
 * through their exact paths rather than relying on generated console launchers.
 */
export async function prepareIndexedToolchainEnvironment(
  outputDir: string,
  requirements: Uint8Array,
  tools: BaseTools & { configurationDir: string },
  options: Options & { offline: boolean },
): Promise<{ pythonExecutable: string; sitePackages: string }> {
  const prepared = await prepareEnvironment(
    outputDir,
    requirements,
    tools,
    { kind: 'index', configurationDir: tools.configurationDir, offline: options.offline },
    options,
  );
  // The fixed index branch below always obtains this fact before installation.
  return { pythonExecutable: prepared.pythonExecutable, sitePackages: prepared.sitePackages! };
}

async function prepareEnvironment(
  outputDir: string,
  requirements: Uint8Array,
  tools: BaseTools,
  source: Source,
  options: Options,
): Promise<{ pythonExecutable: string; sitePackages: string | null }> {
  const sourcePath = source.kind === 'wheels' ? source.directory : source.configurationDir;
  if (
    !(requirements instanceof Uint8Array) ||
    requirements.byteLength === 0 ||
    (source.kind === 'index' && typeof source.offline !== 'boolean') ||
    [outputDir, tools.uvExecutable, tools.pythonExecutable, sourcePath, tools.uvCacheDir].some(
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
  // Creation, inspection and offline installs/checks have a neutral UV context.
  // Only the index acquisition phase below consumes registry configuration.
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
  const run = async (args: string[], phase: string, env = environment) =>
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
      { signal: options.signal, timeoutMs: options.timeoutMs, stderr: 'ignore', env },
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
        ...(source.kind === 'index' ? ['--no-seed'] : []),
        ...common,
      ],
      'create the connector environment',
    );
    let sitePackages: string | null = null;
    if (source.kind === 'index') {
      const reportedLibrary = await runPythonProcess(
        python,
        [
          '-I',
          '-B',
          '-c',
          'import json, sysconfig; print(json.dumps(sysconfig.get_path("purelib")))',
        ],
        null,
        (raw, status) => {
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
            if (status !== 0 || !text.endsWith('\n') || text.split('\n').length !== 2)
              throw new Error();
            const path: unknown = JSON.parse(text);
            if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
              throw new Error();
            return path;
          } catch {
            throw new ToolchainTransportError(
              'INVALID_RESPONSE',
              'Cannot inspect the toolchain installation directory',
            );
          }
        },
        {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          stderr: 'ignore',
          env: environment,
        },
      );
      try {
        // uv/Python may canonicalize a parent alias (for example /var versus
        // /private/var on macOS). Compare the existing directories themselves.
        const stagedRoot = await realpath(staged);
        const libraryRoot = await realpath(reportedLibrary);
        if (!inside(stagedRoot, libraryRoot) || libraryRoot === stagedRoot) throw new Error();
        sitePackages = join(staged, relative(stagedRoot, libraryRoot));
      } catch {
        throw new ToolchainTransportError(
          'INVALID_RESPONSE',
          'Cannot inspect the toolchain installation directory',
        );
      }
      // Retain native registry/configuration and transport settings, while
      // excluding environment redirects and flags that change this operation.
      const registryEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.toUpperCase().startsWith('UV_') ||
            /^UV_(CONFIG_FILE|NO_CONFIG|NO_SYSTEM_CONFIG|CREDENTIALS_DIR|INDEX(?:_.*)?|DEFAULT_INDEX|EXTRA_INDEX_URL|FIND_LINKS|NO_INDEX|KEYRING_PROVIDER|INSECURE_HOST|SYSTEM_CERTS|NATIVE_TLS|HTTP_.*|REQUEST_TIMEOUT|AZURE_ENDPOINT_URL|GCS_ENDPOINT_URL|S3_ENDPOINT_URL)$/.test(
              key.toUpperCase(),
            ),
        ),
      );
      await run(
        [
          'pip',
          'sync',
          input,
          '--python',
          python,
          '--target',
          sitePackages,
          '--require-hashes',
          '--verify-hashes',
          '--only-binary=:all:',
          '--link-mode=copy',
          '--no-allow-empty-requirements',
          '--no-python-downloads',
          '--cache-dir',
          cache,
          '--directory',
          source.configurationDir,
          '--quiet',
          ...(source.offline ? ['--offline'] : []),
        ],
        'install the exact toolchain wheel set',
        registryEnvironment,
      );
    } else
      await run(
        [
          'pip',
          'sync',
          input,
          '--python',
          python,
          '--no-index',
          '--find-links',
          source.directory,
          '--require-hashes',
          '--only-binary=:all:',
          '--link-mode=copy',
          '--no-allow-empty-requirements',
          ...common,
        ],
        'install the exact wheel set',
      );
    // Keep this check config-neutral: it validates the real interpreter,
    // including wheels acquired with foreign platform/Python config overrides.
    await run(['pip', 'check', '--python', python, ...common], 'verify environment dependencies');
    await requireAbsent(output);
    requireActive(options.signal);
    await rename(staged, output);
    return {
      pythonExecutable: join(
        output,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
      sitePackages: sitePackages === null ? null : join(output, relative(staged, sitePackages)),
    };
  } finally {
    // Cleanup must not replace cancellation/errors or report a published env as failed.
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
