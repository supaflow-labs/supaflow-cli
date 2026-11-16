import type { Command } from 'commander';
import { resolve } from 'node:path';
import type { ConnectorAuthoringTools } from './connector-authoring.js';
import {
  refreshConnectorDependencyLocks,
  ConnectorLockOperationError,
} from '../lib/connector-lock.js';
import { ToolchainTransportError } from '../lib/connector-toolchain.js';
import { formatGetJson, printOutput } from '../lib/output.js';

export type ConnectorLockBootstrap = (
  projectDir: string,
  options: { offline: boolean; signal: AbortSignal },
) => Promise<ConnectorAuthoringTools>;

/** Inactive ordinary lock adapter; explicit runtime upgrades are a separate concern. */
export function registerConnectorLockCommand(
  connectors: Command,
  bootstrap: ConnectorLockBootstrap,
  transport: { timeoutMs?: number } = {},
): void {
  connectors
    .command('lock')
    .description('Refresh dependencies without changing runtime.lock')
    .allowExcessArguments(false)
    .option('--project <directory>', 'Connector project directory (default: current directory)')
    .option('--offline', 'Use available local packages without network access')
    .action(async (_options: unknown, command: Command) => {
      const options = command.opts(),
        json = command.optsWithGlobals().json === true;
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
          options.project !== undefined &&
          (typeof options.project !== 'string' ||
            !options.project.trim() ||
            options.project.includes('\0'))
        )
          throw new ToolchainTransportError(
            'INVALID_INPUT',
            'Provide a nonempty project directory without NUL characters',
          );
        const projectDir = resolve(options.project ?? process.cwd());
        const context = { signal: controller.signal, offline: options.offline === true };
        const tools = await bootstrap(projectDir, context);
        await refreshConnectorDependencyLocks(projectDir, tools, {
          ...context,
          timeoutMs: transport.timeoutMs,
        });
        if (json) printOutput(formatGetJson({ locked: true }));
        else printOutput('Dependency locks updated; runtime.lock preserved.');
      } catch (error) {
        let code: string, message: string;
        if (
          error instanceof ConnectorLockOperationError &&
          error.code === 'LOCK_PUBLICATION_FAILED'
        ) {
          code = error.code;
          message = error.message;
        } else if (controller.signal.aborted) {
          code = 'CANCELLED';
          message = 'Connector operation cancelled';
        } else if (
          error instanceof ToolchainTransportError ||
          error instanceof ConnectorLockOperationError
        ) {
          code = error.code;
          message = error.message;
        } else {
          code = 'INTERNAL_ERROR';
          message = 'Cannot refresh dependency locks; check project inputs, toolchain and storage.';
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
