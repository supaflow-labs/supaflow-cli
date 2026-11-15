import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';
import { probeConnectorPython, type PythonInterpreter } from './connector-python-probe.js';

/**
 * Inactive bootstrap for a caller-validated bundled Python version requirement.
 * uv owns compatibility/discovery; timeoutMs bounds each of the two subprocesses.
 */
export async function selectConnectorPython(
  uvExecutable: string,
  requiresPython: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PythonInterpreter> {
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
  const selected = await runPythonProcess(
    uvExecutable,
    [
      'python',
      'find',
      '--no-project',
      '--system',
      '--no-python-downloads',
      '--offline',
      '--no-config',
      '--no-cache',
      '--',
      requiresPython,
    ],
    null,
    (raw, status) => {
      if (status !== 0) {
        throw new ToolchainTransportError(
          'UNAVAILABLE',
          'No compatible installed Python was selected; check the Python requirement, installed Python and pinned uv executable',
        );
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (!text.endsWith('\n') || text.split('\n').length !== 2) throw new Error();
        const path = text.slice(0, -1).replace(/\r$/, '');
        if (!isAbsolute(path) || path.includes('\0') || path.includes('\r')) throw new Error();
        return path;
      } catch {
        throw new ToolchainTransportError(
          'INVALID_RESPONSE',
          'Cannot read the selected Python path; check the pinned uv executable',
        );
      }
    },
    { signal: options.signal, timeoutMs: options.timeoutMs ?? 5_000, stderr: 'ignore' },
  );
  return probeConnectorPython(selected, options);
}
