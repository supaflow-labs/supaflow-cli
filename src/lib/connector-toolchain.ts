import { isAbsolute, resolve as resolvePath } from 'node:path';
import { TextDecoder } from 'node:util';

import { runPythonProcess, ToolchainTransportError } from './connector-python-process.js';
export { ToolchainTransportError } from './connector-python-process.js';

/** Validated project selection, not wheel verification or deployment approval. */
export interface RuntimeSelection {
  schemaVersion: 1;
  connectorApiVersion: number;
  sdkDistributionVersion: string;
  requiredHostProtocol: number;
  agentExecutionPython: string;
  wheels: {
    name: 'supaflow-python-sdk' | 'supaflow-connector-runtime';
    version: string;
    filename: string;
    sha256: string;
    tags: string[];
  }[];
}

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
  | {
      protocolVersion: 1;
      operation: 'doctor' | 'runtime.inspect';
      projectDir: string;
      options: Record<string, never>;
    }
  | {
      protocolVersion: 1;
      operation: 'check';
      projectDir: string;
      options: { uvExecutable: string; nodeExecutable: string; offline: boolean };
    }
  | {
      protocolVersion: 1;
      operation: 'test';
      projectDir: string;
      options: {
        uvExecutable: string;
        nodeExecutable: string;
        offline: boolean;
        live?: boolean;
      };
    }
  | {
      protocolVersion: 1;
      operation: 'artifact.build';
      projectDir: string;
      options: {
        uvExecutable: string;
        nodeExecutable: string;
        offline: boolean;
        outputDir: string;
      };
    }
  | {
      protocolVersion: 1;
      operation: 'dependencies.generate';
      projectDir: string;
      options: {
        uvExecutable: string;
        outputDir: string;
        offline: boolean;
      };
    }
  | {
      protocolVersion: 1;
      operation: 'dependencies.export';
      projectDir: string;
      options: { uvExecutable: string; outputDir: string };
    }
  | {
      protocolVersion: 1;
      operation: 'dependencies.check';
      projectDir: string;
      options: { uvExecutable: string; offline: boolean };
    }
  | {
      protocolVersion: 1;
      operation: 'authoring.prepare';
      projectDir: string;
      options: {
        uvExecutable: string;
        outputDir: string;
        bundleRequirementsFile: string;
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
        sdkVersion: string;
        runtimeVersion: string | null;
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
        | { requirementsDir: string }
        | { proposalDir: string }
        | { diagnostics: AuthoringDiagnostics }
        | { runtime: RuntimeSelection; runtimeSha256: string }
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
  field: 'artifactDir' | 'dependencyDir' | 'requirementsDir' | 'proposalDir',
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

function runtimeSelection(value: unknown): boolean {
  if (
    !record(value) ||
    !keys(value, [
      'schemaVersion',
      'connectorApiVersion',
      'sdkDistributionVersion',
      'requiredHostProtocol',
      'agentExecutionPython',
      'wheels',
    ]) ||
    value.schemaVersion !== 1 ||
    !positiveInteger(value.connectorApiVersion) ||
    !positiveInteger(value.requiredHostProtocol) ||
    !nonEmptyString(value.sdkDistributionVersion) ||
    !nonEmptyString(value.agentExecutionPython) ||
    !Array.isArray(value.wheels) ||
    value.wheels.length < 1 ||
    value.wheels.length > 2
  )
    return false;
  const names = new Set<string>();
  const filenames = new Set<string>();
  for (const wheel of value.wheels) {
    if (
      !record(wheel) ||
      !keys(wheel, ['name', 'version', 'filename', 'sha256', 'tags']) ||
      (wheel.name !== 'supaflow-python-sdk' && wheel.name !== 'supaflow-connector-runtime') ||
      names.has(wheel.name) ||
      !nonEmptyString(wheel.version) ||
      typeof wheel.filename !== 'string' ||
      filenames.has(wheel.filename) ||
      !wheel.filename.endsWith('.whl') ||
      /[\\/:]/.test(wheel.filename) ||
      wheel.filename.includes('\0') ||
      typeof wheel.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(wheel.sha256) ||
      !Array.isArray(wheel.tags) ||
      wheel.tags.length === 0 ||
      !wheel.tags.every(nonEmptyString)
    )
      return false;
    names.add(wheel.name);
    filenames.add(wheel.filename);
    if (wheel.name === 'supaflow-python-sdk' && wheel.version !== value.sdkDistributionVersion)
      return false;
  }
  return names.has('supaflow-python-sdk');
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
          : request.operation === 'check' || request.operation === 'dependencies.check'
            ? keys(result, ['checked']) && result.checked === true
            : request.operation === 'test'
              ? keys(result, ['tested']) && result.tested === true
              : request.operation === 'artifact.build'
                ? stagingDirectory(result, 'artifactDir', request.options.outputDir)
                : request.operation === 'dependencies.generate'
                  ? stagingDirectory(result, 'dependencyDir', request.options.outputDir)
                  : request.operation === 'dependencies.export' ||
                      request.operation === 'authoring.prepare'
                    ? stagingDirectory(result, 'requirementsDir', request.options.outputDir)
                    : request.operation === 'runtime.propose'
                      ? stagingDirectory(result, 'proposalDir', request.options.outputDir)
                      : request.operation === 'runtime.inspect'
                        ? keys(result, ['runtime', 'runtimeSha256']) &&
                          runtimeSelection(result.runtime) &&
                          typeof result.runtimeSha256 === 'string' &&
                          /^[0-9a-f]{64}$/.test(result.runtimeSha256)
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
  options: { signal?: AbortSignal; timeoutMs?: number; offline?: boolean } = {},
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
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      ...(options.offline === true
        ? {
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'UV_OFFLINE'),
              ),
              UV_OFFLINE: 'true',
            },
          }
        : {}),
    },
  );
}
