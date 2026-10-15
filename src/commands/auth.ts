import { Command } from 'commander';
import {
  readConfig,
  writeConfig,
  clearConfig,
  resolveApiKey,
  resolveWorkspaceId,
} from '../lib/config.js';
import { createAuthenticatedClient } from '../lib/client.js';
import { handleError, CliError, ErrorCode } from '../lib/errors.js';
import { printOutput, formatGetJson } from '../lib/output.js';
import { appOrigin, browserLogin } from '../lib/oauth.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('login')
    .description('Authenticate with Supaflow')
    .option('--key <apiKey>', 'API key (non-interactive, for agents)')
    .action(async (opts, cmd) => {
      const json = cmd.optsWithGlobals().json ?? false;
      try {
        let apiKey =
          opts.key ?? cmd.optsWithGlobals().apiKey ?? (process.env.SUPAFLOW_API_KEY || undefined);
        if (apiKey === undefined) {
          if (!process.stdin.isTTY) {
            throw new CliError(
              'Browser login requires an interactive terminal. Use --key or SUPAFLOW_API_KEY.',
              ErrorCode.INVALID_INPUT,
            );
          }
          await browserLogin(async (credentials, signal) => {
            const { client } = await createAuthenticatedClient(
              credentials.access_token,
              undefined,
              'oauth',
            );
            const { error } = await client
              .from('workspaces_with_access')
              .select('id')
              .limit(1)
              .abortSignal(signal);
            if (error)
              throw new CliError(
                'OAuth login could not access Supaflow workspaces.',
                ErrorCode.NOT_AUTHENTICATED,
              );
            const config = readConfig();
            signal.throwIfAborted();
            delete config.api_key;
            config.oauth = credentials;
            writeConfig(config);
          });
          if (json) printOutput(formatGetJson({ status: 'authenticated', method: 'oauth' }));
          else console.log('Authenticated successfully with OAuth.');
          return;
        }
        apiKey = apiKey.trim();
        if (!apiKey) throw new CliError('API key is required.', ErrorCode.INVALID_INPUT);

        // Validate token with a cheap read query
        const { client } = await createAuthenticatedClient(apiKey);
        const { error } = await client.from('workspaces_with_access').select('id').limit(1);
        if (error) {
          throw new CliError(
            `Authentication failed: ${error.message}`,
            ErrorCode.NOT_AUTHENTICATED,
          );
        }

        const config = readConfig();
        config.api_key = apiKey;
        delete config.oauth;
        writeConfig(config);

        if (json) {
          printOutput(formatGetJson({ status: 'authenticated' }));
        } else {
          console.log('Authenticated successfully.');
        }
      } catch (error) {
        handleError(error, json);
      }
    });

  auth
    .command('logout')
    .description('Clear stored credentials')
    .action(async (_opts, cmd) => {
      const json = cmd.optsWithGlobals().json ?? false;
      try {
        clearConfig();
        if (json) {
          printOutput(formatGetJson({ status: 'logged_out' }));
        } else {
          console.log('Logged out. Credentials cleared.');
        }
      } catch (error) {
        handleError(error, json);
      }
    });

  auth
    .command('status')
    .description('Show current authentication status')
    .action(async (_opts, cmd) => {
      const json = cmd.optsWithGlobals().json ?? false;
      try {
        const config = readConfig();
        const globals = cmd.optsWithGlobals();
        const hasKey = !!resolveApiKey(
          globals.apiKey,
          process.env.SUPAFLOW_API_KEY || undefined,
          config,
        );
        const hasOAuth = !!config.oauth && config.oauth.app_origin === appOrigin();
        const authenticated = hasKey || hasOAuth;
        const wsId =
          resolveWorkspaceId(globals.workspace, process.env.SUPAFLOW_WORKSPACE_ID, config) ?? null;
        const wsSource =
          globals.workspace !== undefined
            ? 'flag'
            : process.env.SUPAFLOW_WORKSPACE_ID !== undefined
              ? 'env'
              : config.workspace_id !== undefined
                ? 'config'
                : 'none';
        const wsName =
          wsSource === 'config'
            ? (config.workspace_name ?? null)
            : wsSource === 'none'
              ? null
              : `(from ${wsSource})`;
        const status = {
          authenticated,
          method: hasKey ? 'api_key' : hasOAuth ? 'oauth' : 'none',
          source: hasKey
            ? globals.apiKey !== undefined
              ? 'flag'
              : process.env.SUPAFLOW_API_KEY
                ? 'env'
                : 'config'
            : hasOAuth
              ? 'config'
              : 'none',
          workspace_id: wsId,
          workspace_name: wsName,
          workspace_source: wsSource,
        };

        if (json) {
          printOutput(formatGetJson(status));
        } else {
          if (authenticated) {
            console.log(`Authenticated (method: ${status.method}, source: ${status.source})`);
            if (wsId) {
              console.log(`Workspace: ${wsName} (${wsId}) [source: ${wsSource}]`);
            } else {
              console.log(
                'No workspace selected. Run "supaflow workspaces select" or set SUPAFLOW_WORKSPACE_ID.',
              );
            }
          } else {
            console.log('Not authenticated. Run "supaflow auth login" or set SUPAFLOW_API_KEY.');
          }
        }
      } catch (error) {
        handleError(error, json);
      }
    });
}
