import { Command } from 'commander';
import { withAuthOnly } from '../lib/middleware.js';
import { readConfig, writeConfig } from '../lib/config.js';
import { formatTable, formatListJson, formatGetJson, printOutput, truncateUuid } from '../lib/output.js';
import { CliError, ErrorCode } from '../lib/errors.js';

export function registerWorkspacesCommands(program: Command): void {
  const workspaces = program.command('workspaces').description('Manage workspaces');

  workspaces
    .command('list')
    .description('List accessible workspaces')
    .action(
      withAuthOnly(async (ctx) => {
        const { supabase, outputOptions } = ctx;
        const { data, error } = await supabase
          .from('workspaces_with_access')
          .select('id, name, api_name, environment, user_access_level')
          .neq('state', 'deleted');

        if (error) throw error;
        const rows = data || [];

        if (outputOptions.json) {
          printOutput(formatListJson(rows, rows.length, rows.length, 0));
        } else {
          if (rows.length === 0) {
            console.log('No workspaces found.');
            return;
          }
          const config = readConfig();
          const headers = ['ID', 'NAME', 'ENVIRONMENT', 'ACCESS', 'ACTIVE'];
          const tableRows = rows.map((ws) => [
            truncateUuid(ws.id),
            ws.name || ws.api_name || '',
            ws.environment || '',
            ws.user_access_level || '',
            ws.id === config.workspace_id ? '*' : '',
          ]);
          printOutput(formatTable(headers, tableRows));
        }
      }),
    );

  workspaces
    .command('select [identifier]')
    .description('Set active workspace (by UUID, api_name, or name)')
    .action(
      withAuthOnly(async (ctx, id?: string) => {
        const { supabase, outputOptions } = ctx;

        if (!id) {
          const { data, error } = await supabase
            .from('workspaces_with_access')
            .select('id, name, api_name, environment')
            .neq('state', 'deleted');

          if (error) throw error;
          if (!data || data.length === 0) {
            throw new CliError('No workspaces available.', ErrorCode.NOT_FOUND);
          }

          if (data.length === 1) {
            id = data[0].id;
            if (!outputOptions.json) {
              console.log(`Auto-selected workspace: ${data[0].name || data[0].api_name}`);
            }
          } else if (outputOptions.json) {
            // In JSON mode, cannot prompt interactively -- require an identifier
            throw new CliError(
              `Multiple workspaces available. Pass a workspace name, api_name, or UUID. Options: ${data.map((ws) => ws.api_name || ws.name).join(', ')}`,
              ErrorCode.INVALID_INPUT,
            );
          } else {
            console.log('Available workspaces:');
            data.forEach((ws, i) => {
              console.log(`  ${i + 1}. ${ws.name || ws.api_name} (${truncateUuid(ws.id)})`);
            });

            const readline = await import('node:readline/promises');
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
            const answer = await rl.question('Select workspace (number): ');
            rl.close();

            const index = parseInt(answer, 10) - 1;
            if (isNaN(index) || index < 0 || index >= data.length) {
              throw new CliError('Invalid selection.', ErrorCode.INVALID_INPUT);
            }
            id = data[index].id;
          }
        }

        // Resolve workspace by UUID, api_name, or name
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let ws: Record<string, string> | null = null;

        if (isUuid) {
          const { data } = await supabase.from('workspaces_with_access').select('id, name, api_name').eq('id', id).single();
          ws = data;
        } else {
          // Try api_name first, then name
          const { data: byApiName } = await supabase.from('workspaces_with_access').select('id, name, api_name').eq('api_name', id).single();
          if (byApiName) {
            ws = byApiName;
          } else {
            const { data: byName } = await supabase.from('workspaces_with_access').select('id, name, api_name').ilike('name', id).single();
            ws = byName;
          }
        }

        if (!ws) {
          throw new CliError(`Workspace "${id}" not found. Use UUID, api_name, or name.`, ErrorCode.NOT_FOUND);
        }

        const config = readConfig();
        config.workspace_id = ws.id;
        config.workspace_name = ws.name || ws.api_name;
        writeConfig(config);

        if (outputOptions.json) {
          printOutput(formatGetJson({ workspace_id: ws.id, workspace_name: ws.name || ws.api_name }));
        } else {
          console.log(`Workspace set to: ${ws.name || ws.api_name} (${truncateUuid(ws.id)})`);
        }
      }),
    );
}
