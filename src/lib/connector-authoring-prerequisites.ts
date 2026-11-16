import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';
import { selectConnectorPython } from './connector-python-selection.js';
import type { PythonInterpreter } from './connector-python-probe.js';

async function installedUv(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    // Empty/relative entries could select a program from an unchecked project.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, process.platform === 'win32' ? 'uv.exe' : 'uv');
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // PATH can contain absent or inaccessible directories.
    }
  }
  throw new ToolchainTransportError(
    'UNAVAILABLE',
    'Install uv alongside Python and add it to an absolute PATH directory.',
  );
}

/**
 * Inactive discovery of user-provided tools. Does not provision packages or Python.
 * The caller supplies a validated Python requirement; the toolchain owner still
 * chooses its pinned uv for dependency locking, independently of this installer.
 */
export async function discoverConnectorAuthoringPrerequisites(
  requiresPython: string,
  options: { uvExecutable?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ uvExecutable: string; uvVersion: string; python: PythonInterpreter }> {
  if (
    typeof requiresPython !== 'string' ||
    !requiresPython.trim() ||
    requiresPython.includes('\0')
  ) {
    throw new ToolchainTransportError(
      'INVALID_INPUT',
      'Provide a Python compatibility requirement',
    );
  }
  if (options.signal?.aborted)
    throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
  const uvExecutable = options.uvExecutable ?? (await installedUv());
  const uvVersion = await runPythonProcess(
    uvExecutable,
    ['--offline', '--no-config', '--no-cache', '--no-python-downloads', '--version'],
    null,
    (raw, status) => {
      if (status !== 0)
        throw new ToolchainTransportError(
          'UNAVAILABLE',
          'Select a working installed uv executable.',
        );
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        const match = /^uv ([0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9.+-]*)(?: [^\r\n]+)?\r?\n$/.exec(text);
        if (!match) throw new Error();
        return match[1];
      } catch {
        throw new ToolchainTransportError(
          'INVALID_RESPONSE',
          'Cannot read the installed uv version.',
        );
      }
    },
    { signal: options.signal, timeoutMs: options.timeoutMs ?? 5_000, stderr: 'ignore' },
  );
  const python = await selectConnectorPython(uvExecutable, requiresPython, options);
  return { uvExecutable, uvVersion, python };
}
