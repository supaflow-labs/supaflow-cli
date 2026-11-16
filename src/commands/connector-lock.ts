import type { Command } from 'commander';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ConnectorAuthoringTools } from './connector-authoring.js';
import {
  refreshConnectorDependencyLocks,
  ConnectorLockOperationError,
  upgradeConnectorRuntimeLocks,
  initializeConnectorRuntimeLocks,
  type ConnectorRuntimeProposal,
} from '../lib/connector-lock.js';
import { runConnectorToolchain, ToolchainTransportError } from '../lib/connector-toolchain.js';
import { formatGetJson, printOutput } from '../lib/output.js';

export type ConnectorLockBootstrap = (
  projectDir: string,
  options: { offline: boolean; signal: AbortSignal },
) => Promise<ConnectorAuthoringTools & { runtimeProposal?: ConnectorRuntimeProposal }>;

/** Inactive lock adapter; runtime replacement requires the explicit upgrade flag. */
export function registerConnectorLockCommand(
  connectors: Command,
  bootstrap: ConnectorLockBootstrap,
  transport: { timeoutMs?: number } = {},
): void {
  connectors
    .command('lock')
    .description('Select an initial runtime or refresh dependency locks; upgrade explicitly')
    .allowExcessArguments(false)
    .option('--project <directory>', 'Connector project directory (default: current directory)')
    .option('--check', 'Check lock freshness without changing project files')
    .option('--upgrade-runtime', 'Explicitly select a compatible runtime and replace its locks')
    .option(
      '--to <version>',
      'Target SDK version for SDK-only projects; connector-runtime version otherwise',
    )
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
        const upgrading = options.upgradeRuntime === true;
        if (
          (options.check === true && upgrading) ||
          (options.to !== undefined &&
            (!upgrading ||
              typeof options.to !== 'string' ||
              !options.to.trim() ||
              options.to.startsWith('-') ||
              options.to.includes('\0')))
        )
          throw new ToolchainTransportError(
            'INVALID_INPUT',
            'Use --to with --upgrade-runtime and an explicit version; --check cannot upgrade a runtime',
          );
        const projectDir = resolve(options.project ?? process.cwd());
        const context = { signal: controller.signal, offline: options.offline === true };
        const tools = await bootstrap(projectDir, context);
        const checking = options.check === true;
        let runtimeDiff: { before: string; after: string } | undefined;
        let initialized = false;
        if (upgrading) {
          if (!tools.runtimeProposal)
            throw new ToolchainTransportError(
              'UNAVAILABLE',
              'The selected CLI toolchain has no runtime recommendation',
            );
          const inspected = await runConnectorToolchain(
            tools.pythonExecutable,
            {
              protocolVersion: 1,
              operation: 'runtime.inspect',
              projectDir,
              options: {},
            },
            { signal: context.signal, timeoutMs: transport.timeoutMs },
          );
          if (!inspected.ok)
            throw new ConnectorLockOperationError(inspected.error.code, inspected.error.message);
          if (!('runtime' in inspected.result))
            throw new ToolchainTransportError(
              'INVALID_RESPONSE',
              'Cannot inspect the selected project runtime',
            );
          const hasRuntime = inspected.result.runtime.wheels.some(
            (wheel) => wheel.name === 'supaflow-connector-runtime',
          );
          const selection = {
            ...tools.runtimeProposal,
            sdkVersion:
              !hasRuntime && options.to !== undefined
                ? options.to
                : tools.runtimeProposal.sdkVersion,
            runtimeVersion: hasRuntime
              ? (options.to ?? tools.runtimeProposal.runtimeVersion)
              : null,
          };
          if (hasRuntime && selection.runtimeVersion === null)
            throw new ToolchainTransportError(
              'UNAVAILABLE',
              'The CLI bundle has no compatible connector-runtime recommendation',
            );
          const changed = await upgradeConnectorRuntimeLocks(projectDir, tools, selection, {
            ...context,
            timeoutMs: transport.timeoutMs,
          });
          runtimeDiff = {
            before: changed.before.toString('utf8'),
            after: changed.after.toString('utf8'),
          };
        } else if (checking) {
          const result = await runConnectorToolchain(
            tools.pythonExecutable,
            {
              protocolVersion: 1,
              operation: 'dependencies.check',
              projectDir,
              options: {
                uvExecutable: tools.uvExecutable,
                offline: context.offline,
                ...(tools.agentTargets === undefined ? {} : { agentTargets: tools.agentTargets }),
              },
            },
            { ...context, timeoutMs: transport.timeoutMs },
          );
          if (!result.ok)
            throw new ConnectorLockOperationError(result.error.code, result.error.message);
          if (controller.signal.aborted)
            throw new ToolchainTransportError('CANCELLED', 'Connector operation cancelled');
        } else {
          try {
            await lstat(join(projectDir, 'runtime.lock'));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            initialized = true;
          }
          if (initialized) {
            if (!tools.runtimeProposal)
              throw new ToolchainTransportError(
                'UNAVAILABLE',
                'The selected CLI toolchain has no runtime recommendation',
              );
            await initializeConnectorRuntimeLocks(projectDir, tools, tools.runtimeProposal, {
              ...context,
              timeoutMs: transport.timeoutMs,
            });
          } else
            await refreshConnectorDependencyLocks(projectDir, tools, {
              ...context,
              timeoutMs: transport.timeoutMs,
            });
        }
        if (json)
          printOutput(
            formatGetJson(
              runtimeDiff
                ? { locked: true, runtimeLockDiff: runtimeDiff }
                : checking
                  ? { checked: true }
                  : { locked: true },
            ),
          );
        else if (runtimeDiff)
          printOutput(
            runtimeDiff.before === runtimeDiff.after
              ? 'Runtime selection unchanged; dependency locks are current.'
              : [
                  '--- runtime.lock',
                  '+++ runtime.lock',
                  ...runtimeDiff.before
                    .trimEnd()
                    .split('\n')
                    .map((line) => '-' + line),
                  ...runtimeDiff.after
                    .trimEnd()
                    .split('\n')
                    .map((line) => '+' + line),
                ].join('\n'),
          );
        else
          printOutput(
            checking
              ? 'Dependency locks are current; project files unchanged.'
              : initialized
                ? 'Initial runtime and dependency locks written.'
                : 'Dependency locks updated; runtime.lock preserved.',
          );
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
