import { Command } from 'commander';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import { formatTable, formatListJson, formatGetJson, printOutput, truncateUuid } from '../lib/output.js';
import { isUuid } from '../lib/resolve.js';
import { CliError, ErrorCode } from '../lib/errors.js';

const DATASOURCE_SELECT = `
  id, name, api_name, state, description,
  connector_name, connector_type, connector_icon, connector_vendor,
  workspace_id, created_at, updated_at, user_access_level,
  source_pipeline_count, destination_pipeline_count, total_pipeline_count
`;

export function registerDatasourcesCommands(program: Command): void {
  const datasources = program.command('datasources').description('Manage datasources');

  datasources
    .command('list')
    .description('List datasources in workspace')
    .option('--limit <n>', 'Max results', '25')
    .option('--offset <n>', 'Pagination offset', '0')
    .option('--filter <field=value>', 'Filter by field', (val: string, acc: string[]) => [...acc, val], [])
    .action(
      withAuth(async (ctx: AuthContext, opts: Record<string, unknown>) => {
        const { supabase, workspaceId, outputOptions } = ctx;
        const limit = parseInt(opts.limit as string, 10);
        const offset = parseInt(opts.offset as string, 10);

        let query = supabase
          .from('datasources_with_access')
          .select(DATASOURCE_SELECT, { count: 'exact' })
          .eq('workspace_id', workspaceId)
          .neq('state', 'deleted')
          .range(offset, offset + limit - 1)
          .order('updated_at', { ascending: false });

        const filters = opts.filter as string[];
        for (const f of filters) {
          const [key, value] = f.split('=');
          if (key === 'type') query = query.eq('connector_type', value.toUpperCase());
          if (key === 'state' || key === 'status') query = query.eq('state', value);
        }

        const { data, error, count } = await query;
        if (error) throw new CliError(error.message, ErrorCode.API_ERROR);
        const rows = data || [];

        if (outputOptions.json) {
          printOutput(formatListJson(rows, count ?? rows.length, limit, offset));
        } else {
          if (rows.length === 0) { console.log('No datasources found.'); return; }
          const headers = ['ID', 'NAME', 'TYPE', 'CONNECTOR', 'STATE', 'PIPELINES'];
          const tableRows = rows.map((d) => [
            truncateUuid(d.id),
            d.name || d.api_name || '',
            d.connector_type || '',
            d.connector_name || '',
            d.state || '',
            String(d.total_pipeline_count || 0),
          ]);
          printOutput(formatTable(headers, tableRows));
        }
      }),
    );

  datasources
    .command('get <identifier>')
    .description('Get datasource details')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        let query = supabase
          .from('datasources_with_access')
          .select(DATASOURCE_SELECT)
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          query = query.eq('id', identifier);
        } else {
          query = query.eq('api_name', identifier);
        }

        const { data, error } = await query.single();
        if (error || !data) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson(data));
        } else {
          console.log(`Name:       ${data.name}`);
          console.log(`ID:         ${data.id}`);
          console.log(`API Name:   ${data.api_name}`);
          console.log(`Connector:  ${data.connector_name} (${data.connector_type})`);
          console.log(`State:      ${data.state}`);
          console.log(`Pipelines:  ${data.total_pipeline_count || 0}`);
        }
      }),
    );
}
