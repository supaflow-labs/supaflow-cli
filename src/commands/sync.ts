import { Command } from 'commander';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import { formatGetJson, printOutput, truncateUuid } from '../lib/output.js';
import { resolveIdentifier } from '../lib/resolve.js';
import { CliError, ErrorCode } from '../lib/errors.js';

export function registerSyncCommands(program: Command): void {
  const sync = program.command('sync').description('Trigger pipeline syncs');

  sync
    .command('run <pipeline>')
    .description('Trigger a pipeline sync')
    .option('--full-resync', 'Force full resync', false)
    .action(
      withAuth(async (ctx: AuthContext, pipeline: string, opts: Record<string, unknown>) => {
        const { supabase, workspaceId, outputOptions } = ctx;
        const pipelineId = await resolveIdentifier(
          supabase, 'pipelines_and_datasources', pipeline,
          'pipeline_id', 'pipeline_api_name', workspaceId,
        );

        const { data, error } = await supabase.rpc('create_pipeline_run_job', {
          p_pipeline_id: pipelineId,
          p_job_type: 'pipeline_run',
          p_reset_target: false,
          p_full_resync: opts.fullResync ?? false,
        });

        if (error) throw new CliError(error.message, ErrorCode.API_ERROR);

        const jobId = data as string;

        if (outputOptions.json) {
          printOutput(formatGetJson({ job_id: jobId, pipeline_id: pipelineId, status: 'queued' }));
        } else {
          console.log(`Sync triggered for pipeline ${truncateUuid(pipelineId)}.`);
          console.log(`Job ID: ${jobId}`);
          console.log(`Track progress: supaflow jobs get ${jobId}`);
        }
      }),
    );
}
