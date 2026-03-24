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
        const status = {
          authenticated: hasKey,
          source: config.api_key ? 'config' : process.env.SUPAFLOW_API_KEY ? 'env' : 'none',
          workspace_id: config.workspace_id || null,
          workspace_name: config.workspace_name || null,
        };

        if (json) {
          printOutput(formatGetJson(status));
        } else {
          if (hasKey) {
            console.log(`Authenticated (source: ${status.source})`);
            if (status.workspace_name) {
              console.log(`Workspace: ${status.workspace_name} (${status.workspace_id})`);
            } else {
              console.log('No workspace selected. Run "supaflow workspaces select".');
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
