import { Command } from 'commander';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import {
  formatTable,
  formatListJson,
  formatGetJson,
  printOutput,
  truncateUuid,
  relativeTime,
} from '../lib/output.js';
import { resolveIdentifier, isUuid } from '../lib/resolve.js';
import { softDeleteRecord } from '../lib/client.js';
import { CliError, ErrorCode } from '../lib/errors.js';

interface PipelineRow {
  pipeline_id: string;
  pipeline_name: string;
  pipeline_api_name: string;
  pipeline_state: string;
  pipeline_configs: unknown;
  pipeline_created_at: string;
  pipeline_updated_at: string;
  source_datasource_id: string | null;
  source_name: string | null;
  source_connector_name: string | null;
  destination_datasource_id: string | null;
  destination_name: string | null;
  destination_connector_name: string | null;
  project_id: string | null;
  project_name: string | null;
  last_sync_at: string | null;
  last_job_status: string | null;
  schedules: unknown;
}

const SORT_MAP: Record<string, string> = {
  name: 'pipeline_name',
  state: 'pipeline_state',
  created_at: 'pipeline_created_at',
  updated_at: 'pipeline_updated_at',
  last_sync_at: 'last_sync_at',
};

function normalizePipeline(row: PipelineRow) {
  return {
    id: row.pipeline_id,
    name: row.pipeline_name,
    api_name: row.pipeline_api_name,
    state: row.pipeline_state,
    configs: row.pipeline_configs,
    created_at: row.pipeline_created_at,
    updated_at: row.pipeline_updated_at,
    source: {
      datasource_id: row.source_datasource_id,
      name: row.source_name,
      connector_name: row.source_connector_name,
    },
    destination: {
      datasource_id: row.destination_datasource_id,
      name: row.destination_name,
      connector_name: row.destination_connector_name,
    },
    project: { id: row.project_id, name: row.project_name },
    last_sync_at: row.last_sync_at,
    last_job_status: row.last_job_status,
    schedules: row.schedules,
  };
}

export function registerPipelinesCommands(program: Command): void {
  const pipelines = program.command('pipelines').description('Manage pipelines');

  // list
  pipelines
    .command('list')
    .description('List pipelines in the current workspace')
    .option('-l, --limit <n>', 'Maximum number of results', '25')
    .option('-o, --offset <n>', 'Offset for pagination', '0')
    .option('-s, --status <status>', 'Filter by pipeline state (e.g. active, inactive)')
    .option('--sort <field>', 'Sort field: name, state, created_at, updated_at, last_sync_at', 'name')
    .option('--order <dir>', 'Sort direction: asc, desc', 'asc')
    .action(
      withAuth(async (ctx: AuthContext, opts: unknown) => {
        const options = opts as {
          limit: string;
          offset: string;
          status?: string;
          sort: string;
          order: string;
        };

        const limit = Math.min(parseInt(options.limit, 10) || 25, 200);
        const offset = parseInt(options.offset, 10) || 0;
        const sortField = SORT_MAP[options.sort] ?? 'pipeline_name';
        const ascending = options.order !== 'desc';

        let query = ctx.supabase
          .from('pipelines_and_datasources')
          .select('*', { count: 'exact' })
          .eq('workspace_id', ctx.workspaceId)
          .order(sortField, { ascending })
          .range(offset, offset + limit - 1);

        if (options.status) {
          query = query.eq('pipeline_state', options.status);
        }

        const { data, error, count } = await query;

        if (error) {
          throw new CliError(`Failed to list pipelines: ${error.message}`, ErrorCode.API_ERROR);
        }

        const rows = (data as PipelineRow[]) ?? [];
        const total = count ?? 0;

        if (ctx.outputOptions.json) {
          printOutput(formatListJson(rows.map(normalizePipeline), total, limit, offset));
          return;
        }

        if (rows.length === 0) {
          console.log('No pipelines found.');
          return;
        }

        const headers = ['ID', 'NAME', 'STATE', 'SOURCE', 'DESTINATION', 'LAST SYNC'];
        const tableRows = rows.map((row) => [
          truncateUuid(row.pipeline_id),
          row.pipeline_name ?? '-',
          row.pipeline_state ?? '-',
          row.source_connector_name ?? '-',
          row.destination_connector_name ?? '-',
          relativeTime(row.last_sync_at),
        ]);

        printOutput(formatTable(headers, tableRows));
        if (total > offset + rows.length) {
          console.log(`\nShowing ${offset + 1}-${offset + rows.length} of ${total}. Use --offset to page.`);
        }
      }),
    );

  // get
  pipelines
    .command('get <identifier>')
    .description('Get details of a pipeline by UUID or api_name')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown) => {
        const id = identifier as string;

        let query = ctx.supabase
          .from('pipelines_and_datasources')
          .select('*')
          .eq('workspace_id', ctx.workspaceId);

        if (isUuid(id)) {
          query = query.eq('pipeline_id', id);
        } else {
          query = query.eq('pipeline_api_name', id);
        }

        const { data, error } = await query.limit(1).single();

        if (error || !data) {
          throw new CliError(
            `Pipeline "${id}" not found.`,
            ErrorCode.NOT_FOUND,
          );
        }

        const normalized = normalizePipeline(data as PipelineRow);

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson(normalized));
          return;
        }

        const row = data as PipelineRow;
        console.log(`ID:          ${row.pipeline_id}`);
        console.log(`Name:        ${row.pipeline_name}`);
        console.log(`API Name:    ${row.pipeline_api_name}`);
        console.log(`State:       ${row.pipeline_state}`);
        console.log(`Source:      ${row.source_name ?? '-'} (${row.source_connector_name ?? '-'})`);
        console.log(`Destination: ${row.destination_name ?? '-'} (${row.destination_connector_name ?? '-'})`);
        console.log(`Project:     ${row.project_name ?? '-'}`);
        console.log(`Last Sync:   ${relativeTime(row.last_sync_at)}`);
        console.log(`Last Job:    ${row.last_job_status ?? '-'}`);
        console.log(`Created:     ${relativeTime(row.pipeline_created_at)}`);
        console.log(`Updated:     ${relativeTime(row.pipeline_updated_at)}`);
      }),
    );

  // pause
  pipelines
    .command('pause <identifier>')
    .description('Pause a pipeline (set state to inactive)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown) => {
        const id = await resolveIdentifier(
          ctx.supabase,
          'pipelines_and_datasources',
          identifier as string,
          'pipeline_id',
          'pipeline_api_name',
          ctx.workspaceId,
        );

        const { error } = await ctx.supabase
          .from('pipelines')
          .update({ state: 'inactive' })
          .eq('id', id)
          .eq('workspace_id', ctx.workspaceId);

        if (error) {
          throw new CliError(`Failed to pause pipeline: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson({ id, state: 'inactive' }));
        } else {
          console.log(`Pipeline ${truncateUuid(id)} paused.`);
        }
      }),
    );

  // resume
  pipelines
    .command('resume <identifier>')
    .description('Resume a pipeline (set state to active)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown) => {
        const id = await resolveIdentifier(
          ctx.supabase,
          'pipelines_and_datasources',
          identifier as string,
          'pipeline_id',
          'pipeline_api_name',
          ctx.workspaceId,
        );

        const { error } = await ctx.supabase
          .from('pipelines')
          .update({ state: 'active' })
          .eq('id', id)
          .eq('workspace_id', ctx.workspaceId);

        if (error) {
          throw new CliError(`Failed to resume pipeline: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson({ id, state: 'active' }));
        } else {
          console.log(`Pipeline ${truncateUuid(id)} resumed.`);
        }
      }),
    );

  // delete
  pipelines
    .command('delete <identifier>')
    .description('Delete a pipeline (soft delete)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown, opts: unknown) => {
        const options = opts as { yes?: boolean };

        const id = await resolveIdentifier(
          ctx.supabase,
          'pipelines_and_datasources',
          identifier as string,
          'pipeline_id',
          'pipeline_api_name',
          ctx.workspaceId,
        );

        if (!options.yes && !ctx.outputOptions.json && process.stdin.isTTY) {
          const { createInterface } = await import('node:readline/promises');
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          const answer = await rl.question(
            `Delete pipeline ${truncateUuid(id)}? This cannot be undone. [y/N] `,
          );
          rl.close();
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('Aborted.');
            process.exit(0);
          }
        }

        await softDeleteRecord(ctx.conn, 'pipelines', id);

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson({ id, state: 'deleted' }));
        } else {
          console.log(`Pipeline ${truncateUuid(id)} deleted.`);
        }
      }),
    );
}
