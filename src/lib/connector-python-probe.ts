import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';

export interface PythonInterpreter {
  executable: string;
  version: [number, number, number];
  implementation: string;
}

const PROGRAM = `import json, sys
print(json.dumps({"executable": sys.executable, "version": list(sys.version_info[:3]), "implementation": sys.implementation.name}))
`;

/** Inspect an existing interpreter; bootstrap owns compatibility and setup. */
export function probeConnectorPython(
  executable: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PythonInterpreter> {
  return runPythonProcess(
    executable,
    ['-I', '-S', '-B', '-c', PROGRAM],
    null,
    (raw, status) => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (status !== 0 || !text.endsWith('\n') || text.split('\n').length !== 2)
          throw new Error();
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        const data = value as Record<string, unknown>;
        if (
          Object.keys(data).length !== 3 ||
          typeof data.executable !== 'string' ||
          !isAbsolute(data.executable) ||
          data.executable.includes('\0') ||
          typeof data.implementation !== 'string' ||
          !data.implementation ||
          !Array.isArray(data.version) ||
          data.version.length !== 3 ||
          !data.version.every((part) => Number.isSafeInteger(part) && part >= 0) ||
          data.version[0] < 1
        )
          throw new Error();
        return data as unknown as PythonInterpreter;
      } catch {
        throw new ToolchainTransportError(
          'INVALID_RESPONSE',
          'Cannot inspect the selected Python interpreter; choose a working Python installation',
        );
      }
    },
    { signal: options.signal, timeoutMs: options.timeoutMs ?? 5_000, stderr: 'ignore' },
  );
}
