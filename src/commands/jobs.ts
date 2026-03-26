import { Command } from 'commander';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import { formatTable, formatListJson, formatGetJson, printOutput, truncateUuid, relativeTime } from '../lib/output.js';
import { CliError, ErrorCode } from '../lib/errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new CliError(
      `${label} must be a UUID (e.g. 550e8400-e29b-41d4-a716-446655440000), got: ${value}`,
      ErrorCode.INVALID_INPUT,
    );
  }
}

function parseFilters(filters: string[]): { status?: string; type?: string; pipeline?: string } {
  const result: { status?: string; type?: string; pipeline?: string } = {};
  for (const f of filters) {
    const eq = f.indexOf('=');
    if (eq === -1) {
      throw new CliError(
        `Invalid filter "${f}". Expected format: key=value (e.g. status=running)`,
        ErrorCode.INVALID_INPUT,
      );
    }
    const key = f.slice(0, eq).trim().toLowerCase();
    const val = f.slice(eq + 1).trim();
    if (key === 'status') {
      result.status = val;
    } else if (key === 'type') {
      result.type = val;
    } else if (key === 'pipeline') {
      assertUuid(val, 'pipeline filter value');
      result.pipeline = val;
    } else {
      throw new CliError(
        `Unknown filter key "${key}". Supported: status, type, pipeline`,
        ErrorCode.INVALID_INPUT,
      );
    }
  }
  return result;
}

export function registerJobsCommands(program: Command): void {
  const jobs = program.command('jobs').description('Manage pipeline jobs');

  // -----------------------------------------------------------------------
  // jobs list
  // -----------------------------------------------------------------------
  jobs
    .command('list')
    .description('List jobs in the current workspace')
    .option('--filter <filter>', 'Filter: status=<value>, type=<value>, pipeline=<uuid> (repeatable)', (v, acc: string[]) => { acc.push(v); return acc; }, [] as string[])
    .option('--limit <n>', 'Maximum number of results', '25')
    .option('--offset <n>', 'Number of results to skip', '0')
    .action(
      withAuth(async (ctx: AuthContext, opts: { filter: string[]; limit: string; offset: string }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const limit = Math.max(1, parseInt(opts.limit, 10) || 25);
        const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
        const filters = parseFilters(opts.filter || []);

        let query = supabase
          .from('jobs')
          .select('id, job_type, job_status, reference_id, reference_type, created_at, updated_at', { count: 'exact' })
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (filters.status) {
          query = query.eq('job_status', filters.status);
        }
        if (filters.type) {
          query = query.eq('job_type', filters.type);
        }
        if (filters.pipeline) {
          query = query.eq('reference_id', filters.pipeline).eq('reference_type', 'pipeline');
        }

        const { data, error, count } = await query;
        if (error) throw error;

        const rows = data || [];
        const total = count ?? rows.length;

        if (outputOptions.json) {
          printOutput(formatListJson(rows, total, limit, offset));
          return;
        }

        if (rows.length === 0) {
          console.log('No jobs found.');
          return;
        }

        const headers = ['ID', 'TYPE', 'STATUS', 'REFERENCE', 'CREATED'];
        const tableRows = rows.map((j) => [
          truncateUuid(j.id),
          j.job_type || '-',
          j.job_status || '-',
          j.reference_id ? truncateUuid(j.reference_id) : '-',
          relativeTime(j.created_at),
        ]);
        printOutput(formatTable(headers, tableRows));
      }),
    );

  // -----------------------------------------------------------------------
  // jobs get
  // -----------------------------------------------------------------------
  jobs
    .command('get <id>')
    .description('Get a job by UUID, including per-object metrics')
    .action(
      withAuth(async (ctx: AuthContext, id: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        assertUuid(id, 'Job ID');

        // Select only useful fields -- exclude job_parameters (contains encrypted
        // credentials and internal connector config that wastes agent context)
        const { data: job, error: jobError } = await supabase
          .from('jobs')
          .select('id, name, job_type, job_status, job_command, status_message, reference_id, reference_type, started_at, ended_at, execution_duration_ms, created_at, updated_at, job_response')
          .eq('id', id)
          .eq('workspace_id', workspaceId)
          .single();

        if (jobError || !job) {
          throw new CliError(`Job "${id}" not found.`, ErrorCode.NOT_FOUND);
        }

        // Select only useful detail fields -- exclude raw metrics JSONB blobs
        const { data: details, error: detailsError } = await supabase
          .from('job_details_v2')
          .select('id, fully_qualified_source_object_name, ingestion_status, staging_status, loading_status, ingestion_metrics, staging_metrics, loading_metrics, job_status, status_message')
          .eq('job_id', id);

        if (detailsError) throw detailsError;
        const objectDetails = details || [];

        if (outputOptions.json) {
          printOutput(formatGetJson({ ...job, object_details: objectDetails }));
          return;
        }

        // Human-readable output: job header
        console.log(`Job:      ${job.id}`);
        console.log(`Type:     ${job.job_type || '-'}`);
        console.log(`Status:   ${job.job_status || '-'}`);
        console.log(`Pipeline: ${job.pipeline_id || '-'}`);
        console.log(`Created:  ${relativeTime(job.created_at)}`);
        console.log(`Updated:  ${relativeTime(job.updated_at)}`);

        if (objectDetails.length === 0) {
          console.log('\nNo per-object details available.');
          return;
        }

        console.log('\nObject Details:');
        const headers = ['OBJECT', 'INGESTION', 'STAGING', 'LOADING', 'ROWS'];
        const tableRows = objectDetails.map((d) => {
          const ingestRows =
            (d.ingestion_metrics as Record<string, unknown> | null)?.output_row_count ?? '-';
          return [
            d.fully_qualified_source_object_name
              ? String(d.fully_qualified_source_object_name).substring(0, 40)
              : '-',
            d.ingestion_status || '-',
            d.staging_status || '-',
            d.loading_status || '-',
            String(ingestRows),
          ];
        });
        printOutput(formatTable(headers, tableRows));
      }),
    );

  // -----------------------------------------------------------------------
  // jobs logs
  // -----------------------------------------------------------------------
  jobs
    .command('logs <id>')
    .description('Show stored job response/logs for a job')
    .action(
      withAuth(async (ctx: AuthContext, id: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        assertUuid(id, 'Job ID');

        const { data: job, error: jobError } = await supabase
          .from('jobs')
          .select('id, job_status, job_response')
          .eq('id', id)
          .eq('workspace_id', workspaceId)
          .single();

        if (jobError || !job) {
          throw new CliError(`Job "${id}" not found.`, ErrorCode.NOT_FOUND);
        }

        const response = job.job_response ?? null;

        if (outputOptions.json) {
          printOutput(
            formatGetJson({
              id: job.id,
              status: job.job_status,
              message: response
                ? typeof response === 'object' && 'message' in (response as object)
                  ? (response as Record<string, unknown>).message
                  : null
                : null,
              response,
            }),
          );
          return;
        }

        // Human-readable: print the raw job_response JSON
        if (response === null || response === undefined) {
          console.log(`No response data stored for job ${id}.`);
          console.log('Note: full execution logs are stored on the agent filesystem, not in the database.');
          return;
        }

        console.log(`Job: ${id}  Status: ${job.job_status || '-'}`);
        console.log('Response:');
        console.log(JSON.stringify(response, null, 2));
      }),
    );
}
