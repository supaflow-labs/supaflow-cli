import { Command } from 'commander';
import { readConfig, writeConfig, clearConfig } from '../lib/config.js';
import { createAuthenticatedClient } from '../lib/client.js';
import { handleError, CliError, ErrorCode } from '../lib/errors.js';
import { printOutput, formatGetJson } from '../lib/output.js';
import * as readline from 'node:readline/promises';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('login')
    .description('Authenticate with Supaflow')
    .action(async (_opts, cmd) => {
      const json = cmd.optsWithGlobals().json ?? false;
      try {
        let apiKey = process.env.SUPAFLOW_API_KEY;

        if (!apiKey) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          apiKey = await rl.question('Enter your Supaflow API key: ');
          rl.close();
        }

        if (!apiKey || !apiKey.trim()) {
          throw new CliError('API key is required.', ErrorCode.INVALID_INPUT);
        }

        apiKey = apiKey.trim();

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
        const hasKey = !!config.api_key || !!process.env.SUPAFLOW_API_KEY;
        const wsId = config.workspace_id || process.env.SUPAFLOW_WORKSPACE_ID || null;
        const wsName = config.workspace_name || (process.env.SUPAFLOW_WORKSPACE_ID ? '(from env)' : null);
        const wsSource = config.workspace_id ? 'config' : process.env.SUPAFLOW_WORKSPACE_ID ? 'env' : 'none';
        const status = {
          authenticated: hasKey,
          source: config.api_key ? 'config' : process.env.SUPAFLOW_API_KEY ? 'env' : 'none',
          workspace_id: wsId,
          workspace_name: wsName,
          workspace_source: wsSource,
        };

        if (json) {
          printOutput(formatGetJson(status));
        } else {
          if (hasKey) {
            console.log(`Authenticated (source: ${status.source})`);
            if (wsId) {
              console.log(`Workspace: ${wsName} (${wsId}) [source: ${wsSource}]`);
            } else {
              console.log('No workspace selected. Run "supaflow workspaces select" or set SUPAFLOW_WORKSPACE_ID.');
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
