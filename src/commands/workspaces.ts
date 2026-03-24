import { Command } from 'commander';
import { withAuthOnly } from '../lib/middleware.js';
import { readConfig, writeConfig } from '../lib/config.js';
import { formatTable, formatListJson, formatGetJson, printOutput, truncateUuid } from '../lib/output.js';

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
    .command('select [id]')
    .description('Set active workspace')
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
            console.log('No workspaces available.');
            return;
          }

          if (data.length === 1) {
            id = data[0].id;
            console.log(`Auto-selected workspace: ${data[0].name || data[0].api_name}`);
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
              console.error('Invalid selection.');
              process.exit(1);
            }
            id = data[index].id;
          }
        }

        // Verify workspace exists -- support both UUID and api_name
        const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let wsQuery = supabase.from('workspaces_with_access').select('id, name, api_name');
        wsQuery = isId ? wsQuery.eq('id', id) : wsQuery.eq('api_name', id);
        const { data: ws, error: wsError } = await wsQuery.single();

        if (wsError || !ws) {
          console.error(`Error: Workspace "${id}" not found.`);
          process.exit(1);
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
