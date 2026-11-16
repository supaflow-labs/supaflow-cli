import type { Command } from 'commander';
import { resolve } from 'node:path';
import { formatGetJson, formatTable, printOutput } from '../lib/output.js';
import {
  runConnectorToolchain,
  ToolchainTransportError,
  type AuthoringDiagnostics,
  type ToolchainRequest,
} from '../lib/connector-toolchain.js';
import { VERSION } from '../version.js';

type Operation =
  | 'check'
  | 'test'
  | 'doctor'
  | 'manifest.generate'
  | 'manifest.check'
  | 'artifact.build';

export interface ConnectorAuthoringTools {
  pythonExecutable: string;
  uvExecutable: string;
  nodeExecutable: string;
}

export type ConnectorAuthoringBootstrap = (
  projectDir: string,
  options: { operation: Operation; offline: boolean; signal: AbortSignal },
) => Promise<ConnectorAuthoringTools>;

function doctorText(report: AuthoringDiagnostics): string {
  const rows = [
    ['CLI', VERSION],
    ['Node', process.versions.node],
    ['Python', report.python.version],
    ...Object.entries(report.installed).map(([name, info]) => [
      name,
      info?.version ?? 'not installed',
    ]),
    ['Selected SDK', report.selected.sdkDistributionVersion],
    ['Selected runtime', report.selected.runtimeDistributionVersion ?? 'SDK only'],
    ['Template', report.template?.templateId ?? 'not recorded'],
    [
      'Template version',
      report.template ? String(report.template.templateVersion) : 'not recorded',
    ],
    ['Connector API', String(report.selected.connectorApiVersion)],
    ['Host protocol', String(report.selected.requiredHostProtocol)],
    ['Dependency lock', String(report.locks.dependencyLockVersion)],
  ];
  return (
    formatTable(['COMPONENT', 'VERSION'], rows) +
    '\n\n' +
    formatTable(
      ['PYTHON REQUIREMENT', 'DECLARED RANGE'],
      [
        ['Toolchain', report.python.declaredRanges.toolchainRequiresPython],
        ['Project', report.python.declaredRanges.projectRequiresPython],
        ['Dependencies', report.python.declaredRanges.dependencyRequiresPython],
        ['Declared agent execution', report.python.declaredRanges.runtimeDeclaredAgentPython],
      ],
    ) +
    '\n\n' +
    formatTable(
      ['INTERSECTION', 'RANGE', 'CURRENT PYTHON MATCHES'],
      Object.entries(report.python.intersections).map(([name, range]) => [
        name,
        range,
        String(report.python.currentMatches[name as keyof typeof report.python.currentMatches]),
      ]),
    ) +
    '\n\nExecution ranges are local declarations, not live agent deployment approval.'
  );
}

/**
 * Inactive registration: the shipped connectors command does not call this yet.
 * Bootstrap owns exact package selection/acquisition and environment readiness.
 */
export function registerConnectorAuthoringCommands(
  connectors: Command,
  bootstrap: ConnectorAuthoringBootstrap,
  transport: { timeoutMs?: number } = {},
): void {
  const action = (operation: Operation) => async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals();
    const controller = new AbortController();
    let cancellationExit = 130;
    const interrupt = () => controller.abort();
    const terminate = () => {
      cancellationExit = 143;
      controller.abort();
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      const projectDir = resolve(options.project ?? process.cwd());
      if (
        operation === 'artifact.build' &&
        (typeof options.output !== 'string' || !options.output || options.output.includes('\0'))
      ) {
        throw new ToolchainTransportError(
          'INVALID_INPUT',
          'Provide a nonempty artifact output path without NUL characters',
        );
      }
      const tools = await bootstrap(projectDir, {
        operation,
        offline: options.offline === true,
        signal: controller.signal,
      });
      let request: ToolchainRequest;
      if (operation === 'doctor') {
        request = { protocolVersion: 1, operation, projectDir, options: {} };
      } else if (operation === 'manifest.generate' || operation === 'manifest.check') {
        request = {
          protocolVersion: 1,
          operation,
          projectDir,
          options: { nodeExecutable: tools.nodeExecutable },
        };
      } else if (operation === 'artifact.build') {
        request = {
          protocolVersion: 1,
          operation,
          projectDir,
          options: {
            uvExecutable: tools.uvExecutable,
            nodeExecutable: tools.nodeExecutable,
            offline: options.offline === true,
            outputDir: resolve(projectDir, options.output),
          },
        };
      } else {
        request = {
          protocolVersion: 1,
          operation,
          projectDir,
          options: {
            uvExecutable: tools.uvExecutable,
            nodeExecutable: tools.nodeExecutable,
            offline: options.offline === true,
            ...(operation === 'test' && options.live === true ? { live: true } : {}),
          },
        };
      }
      const response = await runConnectorToolchain(tools.pythonExecutable, request, {
        signal: controller.signal,
        timeoutMs: transport.timeoutMs,
        offline: options.offline === true,
      });
      if (controller.signal.aborted)
        throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
      if (!response.ok) {
        failure(response.error.code, response.error.message);
      } else if (options.json) {
        printOutput(formatGetJson(response.result));
      } else if ('diagnostics' in response.result) {
        printOutput(doctorText(response.result.diagnostics));
      } else if ('artifactDir' in response.result) {
        printOutput(`Built connector artifact: ${response.result.artifactDir}`);
      } else {
        printOutput(
          operation === 'check'
            ? 'Connector checks passed.'
            : operation === 'test'
              ? 'Connector tests passed.'
              : operation === 'manifest.generate'
                ? 'Generated connector.yaml.'
                : 'Connector manifest is current.',
        );
      }
    } catch (error) {
      if (controller.signal.aborted) failure('CANCELLED', 'Connector operation cancelled');
      else if (error instanceof ToolchainTransportError) failure(error.code, error.message);
      else failure('INTERNAL_ERROR', 'Connector operation failed; verify the selected toolchain.');
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }

    function failure(code: string, message: string): void {
      if (options.json) printOutput(JSON.stringify({ error: { code, message } }));
      else console.error(`Error: ${message}`);
      process.exitCode = code === 'CANCELLED' ? cancellationExit : 1;
    }
  };

  const configure = (command: Command, operation: Operation) =>
    command
      .allowExcessArguments(false)
      .option('--project <directory>', 'Connector project directory (default: current directory)')
      .option('--offline', 'Use available local packages without network access')
      .action(action(operation));
  configure(
    connectors.command('check').description('Check the selected connector project'),
    'check',
  );
  configure(
    connectors.command('test').description('Run connector contract and project tests'),
    'test',
  ).option('--live', 'Explicitly include live integration tests');
  configure(
    connectors.command('doctor').description('Report local authoring diagnostics'),
    'doctor',
  );
  configure(
    connectors
      .command('build')
      .description('Build a connector artifact in a fresh output directory'),
    'artifact.build',
  ).option(
    '--output <directory>',
    'Fresh artifact output directory, relative to the project',
    'dist',
  );
  const manifest = connectors.command('manifest').description('Manage the connector manifest');
  configure(
    manifest.command('generate').description('Generate canonical connector.yaml'),
    'manifest.generate',
  );
  configure(
    manifest.command('check').description('Check canonical connector.yaml'),
    'manifest.check',
  );
}
