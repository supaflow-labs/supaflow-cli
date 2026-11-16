import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { discoverConnectorAuthoringPrerequisites } from './connector-authoring-prerequisites.js';
import { prepareIndexedToolchainEnvironment } from './connector-environment.js';
import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';

/** Trusted CLI bundle data, never connector project metadata. */
export interface ConnectorToolchainBundle {
  schemaVersion: 1;
  requiresPython: string;
  toolchainVersion: string;
  sdkVersion: string;
  runtimeVersion: string | null;
  testkitVersion: string;
  uvVersion: string;
  requirementsSha256: string;
}

const INSPECT = `import importlib.metadata as m,json,sysconfig
names=('supaflow-connector-toolchain','supaflow-python-sdk','supaflow-connector-runtime','supaflow-connector-testkit','uv')
versions={}
for name in names:
    try: versions[name]=m.version(name)
    except m.PackageNotFoundError: versions[name]=None
print(json.dumps({'versions':versions,'sitePackages':sysconfig.get_path('purelib')}))`;

/** Shared validation for trusted bundle bytes and direct inactive callers. */
export function validateConnectorToolchainBundle(
  value: unknown,
  requirements: Uint8Array,
): asserts value is ConnectorToolchainBundle {
  const bundle = value as ConnectorToolchainBundle | null;
  const versions = [
    bundle?.toolchainVersion,
    bundle?.sdkVersion,
    bundle?.testkitVersion,
    bundle?.uvVersion,
    ...(bundle?.runtimeVersion === null ? [] : [bundle?.runtimeVersion]),
  ];
  if (
    bundle?.schemaVersion !== 1 ||
    typeof bundle.requiresPython !== 'string' ||
    !bundle.requiresPython.trim() ||
    bundle.requiresPython.includes('\0') ||
    versions.some((value) => typeof value !== 'string' || !/^[0-9][A-Za-z0-9.!+-]*$/.test(value)) ||
    typeof bundle.requirementsSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(bundle.requirementsSha256) ||
    !(requirements instanceof Uint8Array) ||
    requirements.byteLength === 0
  )
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Invalid bundled connector toolchain selection',
    );
  if (createHash('sha256').update(requirements).digest('hex') !== bundle.requirementsSha256)
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Bundled connector requirements checksum differs; reinstall the CLI',
    );
}

/** Lazy composition of existing native preparation; no package acquisition of its own. */
export async function bootstrapConnectorToolchain(
  bundle: ConnectorToolchainBundle,
  requirements: Uint8Array,
  options: {
    cacheDir: string;
    configurationDir: string;
    offline: boolean;
    uvExecutable?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ pythonExecutable: string; uvExecutable: string; nodeExecutable: string }> {
  validateConnectorToolchainBundle(bundle, requirements);
  if (
    typeof options.offline !== 'boolean' ||
    [options.cacheDir, options.configurationDir].some(
      (value) => typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'),
    )
  )
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Invalid bundled connector toolchain selection',
    );
  const snapshot = Buffer.from(requirements);
  const prerequisite = await discoverConnectorAuthoringPrerequisites(
    bundle.requiresPython,
    options,
  );
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        bundle.schemaVersion,
        bundle.requiresPython,
        bundle.toolchainVersion,
        bundle.sdkVersion,
        bundle.runtimeVersion,
        bundle.testkitVersion,
        bundle.uvVersion,
        bundle.requirementsSha256,
        prerequisite.python.executable,
        prerequisite.python.implementation,
        prerequisite.python.version,
      ]),
    )
    .digest('hex');
  const output = join(resolve(options.cacheDir), 'environments', identity);
  let exists = false;
  try {
    const entry = await lstat(output);
    if (!entry.isDirectory()) throw new Error();
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new ToolchainTransportError(
        'PROCESS_FAILED',
        `Cannot use the local toolchain cache entry: ${output}`,
      );
  }
  const pythonExecutable = join(
    output,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  if (!exists)
    await prepareIndexedToolchainEnvironment(
      output,
      snapshot,
      {
        uvExecutable: prerequisite.uvExecutable,
        pythonExecutable: prerequisite.python.executable,
        uvCacheDir: join(resolve(options.cacheDir), 'uv'),
        configurationDir: options.configurationDir,
      },
      options,
    );
  const expected = {
    'supaflow-connector-toolchain': bundle.toolchainVersion,
    'supaflow-python-sdk': bundle.sdkVersion,
    'supaflow-connector-runtime': bundle.runtimeVersion,
    'supaflow-connector-testkit': bundle.testkitVersion,
    uv: bundle.uvVersion,
  };
  const sitePackages = await runPythonProcess(
    pythonExecutable,
    ['-I', '-B', '-c', INSPECT],
    null,
    (raw, status) => {
      try {
        if (status !== 0) throw new Error();
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (
          Object.entries(expected).some(([name, version]) => result.versions?.[name] !== version) ||
          typeof result.sitePackages !== 'string' ||
          !isAbsolute(result.sitePackages)
        )
          throw new Error();
        return result.sitePackages as string;
      } catch {
        throw new ToolchainTransportError(
          'INVALID_RESPONSE',
          `Local toolchain packages disagree with the CLI bundle; remove ${output} and retry`,
        );
      }
    },
    { signal: options.signal, timeoutMs: options.timeoutMs, stderr: 'ignore' },
  ).catch((error: unknown) => {
    if (error instanceof ToolchainTransportError && error.code === 'UNAVAILABLE')
      throw new ToolchainTransportError(
        'UNAVAILABLE',
        `Cannot start cached Python; remove ${output} and retry`,
      );
    throw error;
  });
  // The existing target installer puts native wheel scripts under purelib/bin.
  // Never execute a generated Python console launcher after moving the venv.
  const uvExecutable = join(sitePackages, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
  try {
    const root = await realpath(output),
      binary = await realpath(uvExecutable);
    const path = relative(root, binary);
    if (
      !path ||
      isAbsolute(path) ||
      path === '..' ||
      path.startsWith('../') ||
      path.startsWith('..\\')
    )
      throw new Error();
  } catch {
    throw new ToolchainTransportError(
      'INVALID_RESPONSE',
      `Cannot locate bundled uv; remove ${output} and retry`,
    );
  }
  await runPythonProcess(
    uvExecutable,
    ['--offline', '--no-config', '--no-cache', '--no-python-downloads', '--version'],
    null,
    (raw, status) => {
      const version = /^uv ([^\s]+)(?: [^\r\n]+)?\r?\n$/.exec(new TextDecoder().decode(raw));
      if (status !== 0 || version?.[1] !== bundle.uvVersion)
        throw new ToolchainTransportError(
          'INVALID_RESPONSE',
          `Installed uv disagrees with the CLI bundle; remove ${output} and retry`,
        );
    },
    { signal: options.signal, timeoutMs: options.timeoutMs, stderr: 'ignore' },
  ).catch((error: unknown) => {
    if (error instanceof ToolchainTransportError && error.code === 'UNAVAILABLE')
      throw new ToolchainTransportError(
        'UNAVAILABLE',
        `Cannot start cached uv; remove ${output} and retry`,
      );
    throw error;
  });
  return { pythonExecutable, uvExecutable, nodeExecutable: process.execPath };
}
