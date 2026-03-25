import { Command } from 'commander';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import { formatTable, formatListJson, formatGetJson, printOutput, truncateUuid } from '../lib/output.js';
import { isUuid } from '../lib/resolve.js';
import { CliError, ErrorCode } from '../lib/errors.js';
import { generateApiName } from '../lib/connector.js';

export function registerProjectsCommands(program: Command): void {
  const projects = program.command('projects').description('Manage projects');

  projects
    .command('list')
    .description('List projects in workspace')
    .action(
      withAuth(async (ctx: AuthContext) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const { data, error } = await supabase
          .from('projects')
          .select('id, name, api_name, type, state, warehouse_datasource_id, created_at')
          .eq('workspace_id', workspaceId)
          .neq('state', 'deleted')
          .order('created_at', { ascending: false });

        if (error) throw new CliError(error.message, ErrorCode.API_ERROR);
        const rows = data || [];

        if (outputOptions.json) {
          printOutput(formatListJson(rows, rows.length, rows.length, 0));
        } else {
          if (rows.length === 0) { console.log('No projects found.'); return; }
          const headers = ['ID', 'NAME', 'TYPE', 'STATE'];
          const tableRows = rows.map((p) => [
            truncateUuid(p.id),
            p.name,
            p.type || '',
            p.state || '',
          ]);
          printOutput(formatTable(headers, tableRows));
        }
      }),
    );

  projects
    .command('create')
    .description('Create a new project')
    .requiredOption('--name <name>', 'Project name')
    .requiredOption('--destination <id>', 'Destination datasource ID or api_name')
    .option('--type <type>', 'Project type (pipeline|ingestion|transformation|activation)', 'pipeline')
    .action(
      withAuth(async (ctx: AuthContext, opts: { name: string; destination: string; type: string }) => {
        const { supabase, workspaceId, outputOptions, conn } = ctx;

        // Resolve destination datasource
        let destQuery = supabase
          .from('datasources_with_access')
          .select('id, name')
          .eq('workspace_id', workspaceId);

        if (isUuid(opts.destination)) {
          destQuery = destQuery.eq('id', opts.destination);
        } else {
          destQuery = destQuery.eq('api_name', opts.destination);
        }

        const { data: dest, error: destError } = await destQuery.single();
        if (destError || !dest) {
          throw new CliError(`Destination datasource "${opts.destination}" not found.`, ErrorCode.NOT_FOUND);
        }

        const apiName = generateApiName(opts.name);
        const jwtPayload = JSON.parse(atob(conn.bearerToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const userId = jwtPayload.user_id || jwtPayload.sub;

        const { data: project, error } = await supabase
          .from('projects')
          .insert({
            workspace_id: workspaceId,
            name: opts.name,
            api_name: apiName,
            type: opts.type,
            warehouse_datasource_id: dest.id,
            state: 'active',
            created_by: userId,
            updated_by: userId,
          })
          .select('id')
          .single();

        if (error) {
          throw new CliError(`Failed to create project: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: project.id, name: opts.name, api_name: apiName }));
        } else {
          console.log(`Project "${opts.name}" created. ID: ${project.id}`);
        }
      }),
    );
}
