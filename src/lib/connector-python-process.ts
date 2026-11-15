import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const FRAME_LIMIT = 512 * 1024;

export class ToolchainTransportError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'UNAVAILABLE'
      | 'INVALID_RESPONSE'
      | 'CANCELLED'
      | 'PROCESS_FAILED'
      | 'TIMEOUT',
    message: string,
  ) {
    super(message);
    this.name = 'ToolchainTransportError';
  }
}

/** Shared by the installed toolchain and its package-free interpreter probe. */
export function runPythonProcess<T>(
  pythonExecutable: string,
  arguments_: string[],
  request: unknown,
  validate: (raw: Buffer, status: number | null) => T,
  options: { signal?: AbortSignal; timeoutMs?: number; stderr?: 'inherit' | 'ignore' } = {},
): Promise<T> {
  if (
    typeof pythonExecutable !== 'string' ||
    !isAbsolute(pythonExecutable) ||
    pythonExecutable.includes('\0') ||
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 2_147_483_647))
  ) {
    return Promise.reject(
      new ToolchainTransportError(
        'INVALID_INPUT',
        'Select an absolute Python executable and a positive operation timeout',
      ),
    );
  }
  if (options.signal?.aborted) {
    return Promise.reject(
      new ToolchainTransportError('CANCELLED', 'Connector operation cancelled'),
    );
  }
  const input = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(input) > FRAME_LIMIT) {
    return Promise.reject(
      new ToolchainTransportError(
        'INVALID_INPUT',
        'Connector request exceeds the toolchain frame limit',
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, arguments_, {
      stdio: ['pipe', 'pipe', options.stderr ?? 'inherit'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: ToolchainTransportError | undefined;
    // Keep the deadline through stream close: spawn's built-in timeout ends
    // at exit, while an inherited stdout descriptor can stay open longer.
    const timer = setTimeout(() => {
      failure ??= new ToolchainTransportError(
        'TIMEOUT',
        'Connector toolchain exceeded its operation timeout',
      );
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      child.stdout.destroy();
    }, options.timeoutMs ?? 60_000);
    const onAbort = () => {
      failure ??= new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      child.stdout.destroy();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      size += chunk.length;
      if (size > FRAME_LIMIT) {
        failure ??= new ToolchainTransportError(
          'INVALID_RESPONSE',
          'Connector response exceeds the toolchain frame limit',
        );
        child.kill('SIGTERM');
        child.stdout.destroy();
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => {
      failure ??= new ToolchainTransportError(
        'UNAVAILABLE',
        'Cannot start the connector toolchain; check the selected Python installation',
      );
      child.stdout.destroy();
    });
    child.stdin.on('error', () => {
      // Early process exit can close stdin. Its close/error status and output
      // decide the result; an EPIPE must not become an unhandled stream error.
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      if (signal)
        return reject(
          new ToolchainTransportError(
            'PROCESS_FAILED',
            'Connector toolchain was interrupted by a signal',
          ),
        );
      try {
        resolve(validate(Buffer.concat(chunks), status));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}
