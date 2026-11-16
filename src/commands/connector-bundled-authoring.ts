import type { Command } from 'commander';
import { dirname, join } from 'node:path';
import { readConnectorAuthoringBundle } from '../lib/connector-authoring-bundle.js';
import { bootstrapConnectorToolchain } from '../lib/connector-bootstrap.js';
import {
  prepareConnectorProjectEnvironment,
  ConnectorProjectPreparationError,
} from '../lib/connector-environment.js';
import { runConnectorToolchain, ToolchainTransportError } from '../lib/connector-toolchain.js';
import { registerConnectorInitCommand } from './connector-init.js';
import { registerConnectorLockCommand } from './connector-lock.js';
import { registerConnectorAuthoringCommands } from './connector-authoring.js';

/** Inactive until the entrypoint supplies its CLI-owned checked asset directory. */
export function registerBundledConnectorAuthoringCommands(
  connectors: Command,
  assetDirectory: string,
  options: { cacheDir: string; timeoutMs?: number },
): void {
  type Context = { offline: boolean; signal: AbortSignal };
  const selected = async (configurationDir: string, context: Context, initPython?: string) => {
    const { bundle, requirements } = await readConnectorAuthoringBundle(assetDirectory);
    const selection =
      initPython === undefined
        ? bundle
        : {
            ...bundle,
            requiresPython: `${bundle.requiresPython},${initPython || bundle.projectRequiresPython}`,
          };
    const tools = await bootstrapConnectorToolchain(selection, requirements, {
      offline: context.offline,
      signal: context.signal,
      ...options,
      configurationDir,
    });
    return { bundle, requirements, tools };
  };
  registerConnectorInitCommand(
    connectors,
    async (project, context) => {
      const { bundle, requirements, tools } = await selected(
        dirname(project),
        context,
        context.requiresPython ?? '',
      );
      return {
        ...tools,
        toolchainVersion: bundle.toolchainVersion,
        sdkVersion: bundle.sdkVersion,
        runtimeVersion: bundle.runtimeVersion,
        testkitVersion: bundle.testkitVersion,
        projectRequiresPython: bundle.projectRequiresPython,
        requiredHostProtocol: bundle.requiredHostProtocol,
        agentExecutionPython: bundle.agentExecutionPython,
        offline: context.offline,
        projectEnvironment: {
          bundleRequirements: requirements,
          uvCacheDir: join(options.cacheDir, 'uv'),
          agentTargets: bundle.agentTargets,
        },
      };
    },
    options,
  );
  registerConnectorLockCommand(
    connectors,
    async (project, context) => {
      const { bundle, tools } = await selected(project, context);
      return { ...tools, agentTargets: bundle.agentTargets };
    },
    options,
  );
  registerConnectorAuthoringCommands(
    connectors,
    async (project, context) => {
      const { bundle, requirements, tools } = await selected(project, context);
      // Doctor reports this environment and the project selection separately;
      // it never creates/syncs the project's .venv just to produce diagnostics.
      if (context.operation === 'doctor') return tools;
      const diagnostics = await runConnectorToolchain(
        tools.pythonExecutable,
        {
          protocolVersion: 1,
          operation: 'doctor',
          projectDir: project,
          options: {},
        },
        { signal: context.signal, timeoutMs: options.timeoutMs },
      );
      if (!diagnostics.ok)
        throw new ConnectorProjectPreparationError(
          diagnostics.error.code,
          diagnostics.error.message,
        );
      if (!('diagnostics' in diagnostics.result))
        throw new ToolchainTransportError(
          'INVALID_RESPONSE',
          'Cannot inspect project Python compatibility',
        );
      const facts = diagnostics.result.diagnostics.python;
      const compatible = facts.currentMatches.local
        ? tools
        : await bootstrapConnectorToolchain(
            {
              ...bundle,
              requiresPython: `${bundle.requiresPython},${facts.intersections.local}`,
            },
            requirements,
            {
              offline: context.offline,
              signal: context.signal,
              ...options,
              configurationDir: project,
            },
          );
      const pythonExecutable = await prepareConnectorProjectEnvironment(
        project,
        {
          ...compatible,
          bundleRequirements: requirements,
          uvCacheDir: join(options.cacheDir, 'uv'),
          agentTargets: bundle.agentTargets,
        },
        { offline: context.offline, signal: context.signal, timeoutMs: options.timeoutMs },
      );
      return { ...compatible, pythonExecutable, agentTargets: bundle.agentTargets };
    },
    options,
  );
}
