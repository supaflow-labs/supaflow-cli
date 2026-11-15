import { spawn } from 'node:child_process';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { TextDecoder } from 'node:util';

const FRAME_LIMIT = 512 * 1024;

export type ToolchainRequest =
  | { protocolVersion: 1; operation: 'info' }
  | {
      protocolVersion: 1;
      operation: 'check' | 'test';
      projectDir: string;
      options: { uvExecutable: string; nodeExecutable: string; runtimeWheelDir: string };
    }
  | {
      protocolVersion: 1;
      operation: 'artifact.build';
      projectDir: string;
      options: {
        uvExecutable: string;
        nodeExecutable: string;
        runtimeWheelDir: string;
        outputDir: string;
      };
    }
  | {
      protocolVersion: 1;
      operation: 'dependencies.generate';
      projectDir: string;
      options: {
        uvExecutable: string;
        runtimeWheelDir: string;
        outputDir: string;
        offline: boolean;
      };
    }
  | {
      protocolVersion: 1;
      operation: 'runtime.propose';
      projectDir: string;
      options: {
        uvExecutable: string;
        outputDir: string;
        runtimeWheels: string[];
        requiredHostProtocol: number;
        agentExecutionPython: string;
        offline: boolean;
      };
    }
  | {
      protocolVersion: 1;
      operation: 'manifest.generate' | 'manifest.check';
      projectDir: string;
      options: { nodeExecutable: string };
    };

export type ToolchainResponse =
  | {
      protocolVersion: 1;
      ok: true;
      result:
        | { operations: string[] }
        | { checked: true }
        | { tested: true }
        | { artifactDir: string }
        | { dependencyDir: string }
        | { proposalDir: string }
        | { manifest: 'connector.yaml' };
    }
  | { protocolVersion: 1; ok: false; error: { code: string; message: string } };

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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function stagingDirectory(
  result: Record<string, unknown>,
  field: 'artifactDir' | 'dependencyDir' | 'proposalDir',
  outputDir: string,
): boolean {
  const value = result[field];
  return (
    keys(result, [field]) &&
    typeof value === 'string' &&
    isAbsolute(value) &&
    !value.includes('\0') &&
    resolvePath(value) === resolvePath(outputDir)
  );
}

function response(
  raw: Buffer,
  status: number | null,
  request: ToolchainRequest,
): ToolchainResponse {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (!text.endsWith('\n') || text.split('\n').length !== 2) throw new Error();
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.protocolVersion !== 1 || typeof value.ok !== 'boolean')
      throw new Error();
    if (
      value.ok &&
      status === 0 &&
      keys(value, ['protocolVersion', 'ok', 'result']) &&
      record(value.result)
    ) {
      const result = value.result;
      const valid =
        request.operation === 'info'
          ? keys(result, ['operations']) &&
            Array.isArray(result.operations) &&
            result.operations.every((item) => typeof item === 'string')
          : request.operation === 'check'
            ? keys(result, ['checked']) && result.checked === true
            : request.operation === 'test'
              ? keys(result, ['tested']) && result.tested === true
              : request.operation === 'artifact.build'
                ? stagingDirectory(result, 'artifactDir', request.options.outputDir)
                : request.operation === 'dependencies.generate'
                  ? stagingDirectory(result, 'dependencyDir', request.options.outputDir)
                  : request.operation === 'runtime.propose'
                    ? stagingDirectory(result, 'proposalDir', request.options.outputDir)
                    : keys(result, ['manifest']) && result.manifest === 'connector.yaml';
      if (valid) return value as ToolchainResponse;
    }
    if (
      !value.ok &&
      (status === 1 || status === 130) &&
      keys(value, ['protocolVersion', 'ok', 'error']) &&
      record(value.error) &&
      keys(value.error, ['code', 'message']) &&
      typeof value.error.code === 'string' &&
      value.error.code.length > 0 &&
      typeof value.error.message === 'string' &&
      value.error.message.length > 0
    ) {
      return value as ToolchainResponse;
    }
  } catch {
    // Captured output can contain arbitrary source text; never include it in
    // transport diagnostics or treat it as a successful operation.
  }
  throw new ToolchainTransportError(
    'INVALID_RESPONSE',
    'The connector toolchain returned an invalid response; use the matching toolchain installation',
  );
}

/** Inactive transport only: selection/bootstrap and customer commands own policy. */
export function runConnectorToolchain(
  pythonExecutable: string,
  request: ToolchainRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ToolchainResponse> {
  if (
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
        'Select an absolute toolchain Python executable and a positive operation timeout',
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
    const child = spawn(pythonExecutable, ['-I', '-m', 'supaflow_connector_toolchain'], {
      stdio: ['pipe', 'pipe', 'inherit'],
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
        resolve(response(Buffer.concat(chunks), status, request));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}
