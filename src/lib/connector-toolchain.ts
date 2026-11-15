import { isAbsolute, resolve as resolvePath } from 'node:path';
import { TextDecoder } from 'node:util';

import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';
export { ToolchainTransportError } from './connector-python-process.js';

export interface AuthoringDiagnostics {
  schemaVersion: 1;
  installed: {
    toolchain: { version: string; requiresPython: string };
    sdk: { version: string; requiresPython: string };
    testkit: { version: string; requiresPython: string };
    runtime: { version: string; requiresPython: string } | null;
  };
  selected: {
    sdkDistributionVersion: string;
    runtimeDistributionVersion: string | null;
    connectorApiVersion: number;
    requiredHostProtocol: number;
  };
  python: {
    version: string;
    executable: string;
    environment: string;
    interpreterTag: string;
    declaredRanges: {
      toolchainRequiresPython: string;
      projectRequiresPython: string;
      dependencyRequiresPython: string;
      runtimeDeclaredAgentPython: string;
    };
    intersections: { local: string; execution: string; all: string };
    currentMatches: { local: boolean; execution: boolean; all: boolean };
  };
  locks: {
    runtimeSha256: string;
    dependenciesSha256: string;
    dependencyLockVersion: number;
    projectionRuntimeMatches: boolean;
  };
  template: {
    templateId: string;
    templateVersion: number;
    cliVersion: string;
    toolchainVersion: string;
    createdAt: string;
  } | null;
}

export type ToolchainRequest =
  | { protocolVersion: 1; operation: 'info' }
  | { protocolVersion: 1; operation: 'doctor'; projectDir: string; options: Record<string, never> }
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
        | { diagnostics: AuthoringDiagnostics }
        | { manifest: 'connector.yaml' };
    }
  | { protocolVersion: 1; ok: false; error: { code: string; message: string } };

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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringFields(value: unknown, fields: string[]): boolean {
  return (
    record(value) && keys(value, fields) && fields.every((field) => nonEmptyString(value[field]))
  );
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function diagnosticReport(value: unknown): boolean {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !keys(value, ['schemaVersion', 'installed', 'selected', 'python', 'locks', 'template'])
  )
    return false;
  const { installed, selected, python, locks, template } = value;
  if (
    !record(installed) ||
    !keys(installed, ['toolchain', 'sdk', 'testkit', 'runtime']) ||
    !['toolchain', 'sdk', 'testkit'].every((name) =>
      stringFields(installed[name], ['version', 'requiresPython']),
    ) ||
    !(installed.runtime === null || stringFields(installed.runtime, ['version', 'requiresPython']))
  )
    return false;
  if (
    !record(selected) ||
    !keys(selected, [
      'sdkDistributionVersion',
      'runtimeDistributionVersion',
      'connectorApiVersion',
      'requiredHostProtocol',
    ]) ||
    !nonEmptyString(selected.sdkDistributionVersion) ||
    !(
      selected.runtimeDistributionVersion === null ||
      nonEmptyString(selected.runtimeDistributionVersion)
    ) ||
    !positiveInteger(selected.connectorApiVersion) ||
    !positiveInteger(selected.requiredHostProtocol)
  )
    return false;
  if (
    !record(python) ||
    !keys(python, [
      'version',
      'executable',
      'environment',
      'interpreterTag',
      'declaredRanges',
      'intersections',
      'currentMatches',
    ]) ||
    !['version', 'executable', 'environment', 'interpreterTag'].every((field) =>
      nonEmptyString(python[field]),
    ) ||
    !['executable', 'environment'].every(
      (field) =>
        typeof python[field] === 'string' &&
        isAbsolute(python[field]) &&
        !python[field].includes('\0'),
    ) ||
    !stringFields(python.declaredRanges, [
      'toolchainRequiresPython',
      'projectRequiresPython',
      'dependencyRequiresPython',
      'runtimeDeclaredAgentPython',
    ]) ||
    !stringFields(python.intersections, ['local', 'execution', 'all']) ||
    !record(python.currentMatches) ||
    !keys(python.currentMatches, ['local', 'execution', 'all'])
  )
    return false;
  const matches = python.currentMatches;
  if (!['local', 'execution', 'all'].every((field) => typeof matches[field] === 'boolean'))
    return false;
  if (
    !record(locks) ||
    !keys(locks, [
      'runtimeSha256',
      'dependenciesSha256',
      'dependencyLockVersion',
      'projectionRuntimeMatches',
    ]) ||
    !['runtimeSha256', 'dependenciesSha256'].every(
      (field) => typeof locks[field] === 'string' && /^[0-9a-f]{64}$/.test(locks[field]),
    ) ||
    !positiveInteger(locks.dependencyLockVersion) ||
    typeof locks.projectionRuntimeMatches !== 'boolean'
  )
    return false;
  return (
    template === null ||
    (record(template) &&
      keys(template, [
        'templateId',
        'templateVersion',
        'cliVersion',
        'toolchainVersion',
        'createdAt',
      ]) &&
      positiveInteger(template.templateVersion) &&
      ['templateId', 'cliVersion', 'toolchainVersion', 'createdAt'].every((field) =>
        nonEmptyString(template[field]),
      ))
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
                    : request.operation === 'doctor'
                      ? keys(result, ['diagnostics']) && diagnosticReport(result.diagnostics)
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
  return runPythonProcess(
    pythonExecutable,
    ['-I', '-m', 'supaflow_connector_toolchain'],
    request,
    (raw, status) => response(raw, status, request),
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
}
