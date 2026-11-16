import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
  | { kind: 'pylock'; offline: boolean; reuseExisting: boolean }
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

/**
 * Normal project venv from the toolchain's checked, wheel-only native pylock.
 * Artifact URLs/hashes are already resolved; this frozen install never searches
 * an index or reads pip target/prefix configuration. Native uv owns acquisition.
 * offline=false preserves ambient UV_OFFLINE; true always forces offline.
 * Input must be the toolchain's validated wheel-only output, not a source lock.
 * Explicit reuse syncs an isolated matching venv in place. Native sync failure
 * can leave partial changes; callers must not launch until preparation passes.
 */
export async function prepareLockedProjectEnvironment(
  outputDir: string,
  pylock: Uint8Array,
  tools: BaseTools,
  options: Options & { offline: boolean; reuseExisting?: boolean },
): Promise<string> {
  return (
    await prepareEnvironment(
      outputDir,
      pylock,
      tools,
      { kind: 'pylock', offline: options.offline, reuseExisting: options.reuseExisting ?? false },
      options,
    )
  ).pythonExecutable;
}

async function prepareEnvironment(
  outputDir: string,
  requirements: Uint8Array,
  tools: BaseTools,
  source: Source,
  options: Options,
): Promise<{ pythonExecutable: string; sitePackages: string | null }> {
  const sourcePath =
    source.kind === 'wheels'
      ? source.directory
      : source.kind === 'index'
        ? source.configurationDir
        : null;
  if (
    !(requirements instanceof Uint8Array) ||
    requirements.byteLength === 0 ||
    (source.kind !== 'wheels' && typeof source.offline !== 'boolean') ||
    (source.kind === 'pylock' && typeof source.reuseExisting !== 'boolean') ||
    [
      outputDir,
      tools.uvExecutable,
      tools.pythonExecutable,
      ...(sourcePath === null ? [] : [sourcePath]),
      tools.uvCacheDir,
    ].some((path) => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
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
  let reuse = false;
  if (source.kind === 'pylock' && source.reuseExisting) {
    try {
      if (!(await lstat(output)).isDirectory())
        throw new ToolchainTransportError(
          'INVALID_INPUT',
          'Project environment must be a real directory',
        );
      reuse = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } else await requireAbsent(output);
  await mkdir(dirname(output), { recursive: true });
  const scratch = await mkdtemp(join(dirname(output), '.supaflow-environment-'));
  const staged = reuse ? output : join(scratch, 'environment');
  const python = join(staged, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  // Creation, inspection and offline installs/checks have a neutral UV context.
  // Only the index acquisition phase below consumes registry configuration.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('UV_')),
  );
  const registryEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith('UV_') ||
        /^UV_(OFFLINE|CONFIG_FILE|NO_CONFIG|NO_SYSTEM_CONFIG|CREDENTIALS_DIR|INDEX(?:_.*)?|DEFAULT_INDEX|EXTRA_INDEX_URL|FIND_LINKS|NO_INDEX|KEYRING_PROVIDER|INSECURE_HOST|SYSTEM_CERTS|NATIVE_TLS|HTTP_.*|REQUEST_TIMEOUT|AZURE_ENDPOINT_URL|GCS_ENDPOINT_URL|S3_ENDPOINT_URL)$/.test(
          key.toUpperCase(),
        ),
    ),
  );
  // Frozen URLs use credential-store/transport settings, not index selection.
  // Exact URLs use uv's native credential store, not named-index credentials.
  // Explicit config files and registry selection are excluded from this phase.
  const frozenEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith('UV_') ||
        /^UV_(OFFLINE|CREDENTIALS_DIR|KEYRING_PROVIDER|INSECURE_HOST|SYSTEM_CERTS|NATIVE_TLS|HTTP_.*|REQUEST_TIMEOUT|AZURE_ENDPOINT_URL|GCS_ENDPOINT_URL|S3_ENDPOINT_URL)$/.test(
          key.toUpperCase(),
        ),
    ),
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
    if (reuse) {
      try {
        await requireAbsent(join(dirname(python), 'pyvenv.cfg'));
        const configuration = join(output, 'pyvenv.cfg');
        if (!(await lstat(configuration)).isFile()) throw new Error();
        const settings = (await readFile(configuration, 'utf8'))
          .split(/\r?\n/)
          .filter((line) => /^\s*include-system-site-packages\s*=/i.test(line));
        if (settings.length !== 1 || !/=\s*false\s*$/i.test(settings[0])) throw new Error();
        const expectedRoot = await realpath(output);
        const expectedBase = await realpath(tools.pythonExecutable);
        await runPythonProcess(
          python,
          [
            '-I',
            '-S',
            '-B',
            '-c',
            // pyvenv.cfg above establishes isolation. Before Python 3.14, -S
            // leaves sys.prefix at the base; inspect the standard bin/Scripts
            // location and base executable without running installed hooks.
            'import json,os,sys; print(json.dumps([os.path.realpath(os.path.dirname(os.path.dirname(sys.executable))),os.path.realpath(sys._base_executable)]))',
          ],
          null,
          (raw, status) => {
            const facts: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(raw),
            );
            if (
              status !== 0 ||
              !Array.isArray(facts) ||
              facts.length !== 2 ||
              facts[0] !== expectedRoot ||
              facts[1] !== expectedBase
            )
              throw new Error();
          },
          {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            stderr: 'ignore',
            env: environment,
          },
        );
      } catch (error) {
        if (
          error instanceof ToolchainTransportError &&
          (error.code === 'CANCELLED' || error.code === 'TIMEOUT')
        )
          throw error;
        throw new ToolchainTransportError(
          'INVALID_INPUT',
          'Existing project environment must be an isolated venv using the selected Python; preserve it and choose a fresh environment if it differs',
        );
      }
    }
    const input = join(scratch, source.kind === 'pylock' ? 'pylock.toml' : 'requirements.txt');
    await writeFile(input, snapshot, { flag: 'wx' });
    if (!reuse)
      await run(
        [
          'venv',
          staged,
          '--python',
          tools.pythonExecutable,
          '--no-project',
          '--relocatable',
          ...(source.kind !== 'wheels' ? ['--no-seed'] : []),
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
    } else if (source.kind === 'pylock') {
      await run(
        [
          'pip',
          'sync',
          input,
          '--python',
          python,
          '--no-index',
          '--require-hashes',
          '--verify-hashes',
          '--only-binary=:all:',
          '--link-mode=copy',
          '--no-allow-empty-requirements',
          '--preview-features',
          'pylock',
          ...common.filter((value) => value !== '--offline'),
          ...(source.offline ? ['--offline'] : []),
        ],
        'install the exact project wheel set',
        frozenEnvironment,
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
    requireActive(options.signal);
    if (!reuse) {
      await requireAbsent(output);
      await rename(staged, output);
    }
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
