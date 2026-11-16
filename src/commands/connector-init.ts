import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import {
  initializeLockedConnectorProject,
  ConnectorInitOperationError,
  ConnectorInitConflictError,
  requireNewConnectorProject,
  type LockedConnectorInitOptions,
} from '../lib/connector-init.js';
import {
  renderCustomSourceTemplate,
  renderApiSourceTemplate,
  renderSqlSourceTemplate,
} from '../lib/connector-templates.js';
import { ToolchainTransportError } from '../lib/connector-toolchain.js';
import { ConnectorProjectPreparationError } from '../lib/connector-environment.js';
import { formatGetJson, printOutput } from '../lib/output.js';

export type ConnectorInitBootstrap = (
  targetDir: string,
  options: { offline: boolean; signal: AbortSignal },
) => Promise<
  LockedConnectorInitOptions & { testkitVersion: string; projectRequiresPython: string }
>;

/** Inactive registration; the caller supplies the selected installed toolchain. */
export function registerConnectorInitCommand(
  connectors: Command,
  bootstrap: ConnectorInitBootstrap,
  transport: { timeoutMs?: number } = {},
): void {
  connectors
    .command('init <directory>')
    .description('Create a checked connector project')
    .allowExcessArguments(false)
    .addOption(
      new Option('--template <type>', 'Connector template')
        .choices(['custom-source', 'api-source', 'sql-source'])
        .default('api-source'),
    )
    .requiredOption('--name <NAME>', 'Canonical connector name, such as ACME')
    .requiredOption('--group <group-id>', 'Connector group, such as com.acme')
    .option('--display-name <name>', 'Human-readable connector name')
    .option('--connector-version <version>', 'Canonical Python package version', '0.1.0.dev1')
    .option('--requires-python <range>', 'Project Python requirement')
    .option('--offline', 'Use available local packages without network access')
    .action(async (directory: string, _options: unknown, command: Command) => {
      const options = command.opts();
      const json = command.optsWithGlobals().json === true;
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
        if (
          !directory.trim() ||
          directory.includes('\0') ||
          !/^[A-Z_][A-Z0-9_]*$/.test(options.name) ||
          !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(options.group) ||
          [
            options.displayName ?? options.name,
            options.connectorVersion,
            options.requiresPython ?? 'default',
          ].some((value) => typeof value !== 'string' || !value.trim() || value.includes('\0'))
        ) {
          throw new ToolchainTransportError(
            'INVALID_INPUT',
            'Provide a directory, canonical connector name/group and nonempty project metadata',
          );
        }
        const projectDir = resolve(directory);
        await requireNewConnectorProject(projectDir);
        if (controller.signal.aborted)
          throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
        const selected = await bootstrap(projectDir, {
          offline: options.offline === true,
          signal: controller.signal,
        });
        const metadata = {
          connectorName: options.name,
          displayName: options.displayName ?? options.name,
          groupId: options.group,
          version: options.connectorVersion,
          requiresPython: options.requiresPython ?? selected.projectRequiresPython,
          sdkVersion: selected.sdkVersion,
          testkitVersion: selected.testkitVersion,
        };
        const template =
          options.template === 'custom-source'
            ? renderCustomSourceTemplate(metadata)
            : (() => {
                if (selected.runtimeVersion === null)
                  throw new ToolchainTransportError(
                    'UNAVAILABLE',
                    'Prepare a connector runtime for this template',
                  );
                return options.template === 'sql-source'
                  ? renderSqlSourceTemplate({
                      ...metadata,
                      runtimeVersion: selected.runtimeVersion,
                    })
                  : renderApiSourceTemplate({
                      ...metadata,
                      runtimeVersion: selected.runtimeVersion,
                    });
              })();
        await initializeLockedConnectorProject(
          projectDir,
          template,
          {
            ...selected,
            runtimeVersion: options.template === 'custom-source' ? null : selected.runtimeVersion,
            offline: options.offline === true,
          },
          { signal: controller.signal, timeoutMs: transport.timeoutMs },
        );
        if (json) printOutput(formatGetJson({ projectDir }));
        else printOutput(`Created connector project: ${projectDir}`);
      } catch (error) {
        let code: string, message: string;
        if (controller.signal.aborted) {
          code = 'CANCELLED';
          message = 'Connector operation cancelled';
        } else if (error instanceof ConnectorInitConflictError) {
          code = 'TARGET_EXISTS';
          message = error.message;
        } else if (
          error instanceof ToolchainTransportError ||
          error instanceof ConnectorProjectPreparationError ||
          error instanceof ConnectorInitOperationError
        ) {
          code = error.code;
          message = error.message;
        } else {
          code = 'INTERNAL_ERROR';
          message =
            'Cannot initialize the connector; verify the selected toolchain and project metadata.';
        }
        if (json) printOutput(JSON.stringify({ error: { code, message } }));
        else console.error(`Error: ${message}`);
        process.exitCode = code === 'CANCELLED' ? cancellationExit : 1;
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      }
    });
}
