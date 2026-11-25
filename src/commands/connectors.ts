import { Command } from 'commander';
import { withAuthOnly } from '../lib/middleware.js';
import { CliError, ErrorCode, handleError } from '../lib/errors.js';
import { formatTable, formatListJson, printOutput } from '../lib/output.js';
import { fetchConnectors } from '../lib/connector.js';
import {
  registerBuiltConnector,
  registeredConnectorStatus,
} from '../lib/connector-registration.js';
import { deployBuiltConnector } from '../lib/connector-deployment.js';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerBundledConnectorAuthoringCommands } from './connector-bundled-authoring.js';
import { CONNECTOR_AUTHORING_ENABLED } from '../lib/connector-authoring-feature.js';

function formatCapabilities(caps: string[]): string {
  if (!caps || caps.length === 0) return '';
  // Shorten for table display: REPLICATION_SOURCE -> repl_source, etc.
  return caps
    .map((c) => c.toLowerCase().replace('replication_', 'repl_').replace('reverse_etl_', 'retl_'))
    .join(', ');
}

export function registerConnectorsCommands(program: Command): void {
  const connectors = program.command('connectors').description('Browse available connectors');
  if (CONNECTOR_AUTHORING_ENABLED) {
    const configuredCache = process.env.XDG_CACHE_HOME;
    const cacheHome =
      configuredCache && isAbsolute(configuredCache) ? configuredCache : join(homedir(), '.cache');
    registerBundledConnectorAuthoringCommands(
      connectors,
      fileURLToPath(new URL('./connectors/', import.meta.url)),
      { cacheDir: join(cacheHome, 'supaflow', 'connector-toolchains') },
    );
  }

  connectors
    .command('group')
    .description('Manage the organization connector group')
    .command('register <group-id>')
    .description('Reserve a connector group for the active organization')
    .action(
      withAuthOnly(async ({ supabase, outputOptions }, groupId) => {
        const { data, error } = await supabase.rpc('reserve_connector_group', {
          p_group_id: groupId,
        });
        if (error) {
          const code =
            error.code === '42501'
              ? ErrorCode.FORBIDDEN
              : ['22023', '23505'].includes(error.code)
                ? ErrorCode.INVALID_INPUT
                : ErrorCode.API_ERROR;
          throw new CliError(error.message, code);
        }
        if (typeof data !== 'string' || data !== groupId) {
          throw new CliError(
            'The connector group reservation could not be verified.',
            ErrorCode.API_ERROR,
          );
        }
        printOutput(
          outputOptions.json
            ? JSON.stringify({ group_id: data })
            : `Organization connector group: ${data}`,
        );
      }),
    );

  const development = connectors.command('dev').description('Manage tenant development connectors');
  development
    .command('deploy')
    .description('Copy and prepare a built connector on a local Docker agent (no registration)')
    .requiredOption('--artifact <directory>', 'Built connector artifact directory')
    .option('--name <container>', 'Target agent container', 'supaflow-agent')
    .option(
      '--runtime-wheels <directory>',
      'Exact locked SDK/runtime wheels, if absent on the agent',
    )
    .action(async (...args) => {
      const cmd = args[args.length - 1] as Command;
      const options = cmd.optsWithGlobals() as {
        artifact: string;
        name: string;
        runtimeWheels?: string;
        json?: boolean;
      };
      try {
        const result = await deployBuiltConnector(options);
        printOutput(
          options.json ? JSON.stringify(result) : `Prepared local connector on ${result.container}`,
        );
      } catch (error) {
        handleError(error, options.json ?? false);
      }
    });

  development
    .command('status <version-id>')
    .description('Compare a built artifact with an accessible registered version')
    .requiredOption('--artifact <directory>', 'Built connector artifact directory')
    .action(
      withAuthOnly(async ({ supabase, outputOptions }, versionId, options) => {
        const { artifact } = options as { artifact: string };
        const result = await registeredConnectorStatus(artifact, versionId as string, supabase);
        printOutput(outputOptions.json ? JSON.stringify(result) : result.status);
      }),
    );

  development
    .command('register')
    .description('Register the exact built connector for the active organization')
    .requiredOption('--artifact <directory>', 'Built connector artifact directory')
    .action(
      withAuthOnly(async ({ conn, outputOptions }, options) => {
        const { artifact } = options as { artifact: string };
        const result = await registerBuiltConnector(artifact, conn.bearerToken);
        printOutput(
          outputOptions.json
            ? JSON.stringify(result)
            : `${result.created ? 'Registered' : 'Already registered'} ${result.type} ${result.version}`,
        );
      }),
    );

  connectors
    .command('list')
    .description('List available connector types')
    .action(
      withAuthOnly(async (ctx) => {
        const { supabase, outputOptions } = ctx;
        const all = await fetchConnectors(supabase);
        const sorted = all.sort((a, b) => a.type.localeCompare(b.type));

        if (outputOptions.json) {
          printOutput(
            formatListJson(
              sorted.map((c) => ({
                type: c.type,
                name: c.name,
                version: c.latest_version,
                capabilities: c.connector_capabilities || [],
              })),
              sorted.length,
              sorted.length,
              0,
            ),
          );
        } else {
          const headers = ['TYPE', 'NAME', 'CAPABILITIES', 'VERSION'];
          const rows = sorted.map((c) => [
            c.type,
            c.name,
            formatCapabilities(c.connector_capabilities),
            c.latest_version || '',
          ]);
          printOutput(formatTable(headers, rows));
        }
      }),
    );
}
