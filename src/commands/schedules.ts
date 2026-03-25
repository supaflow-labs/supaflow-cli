import { Command } from 'commander';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import { formatTable, formatListJson, formatGetJson, printOutput, truncateUuid, relativeTime } from '../lib/output.js';
import { isUuid } from '../lib/resolve.js';
import { CliError, ErrorCode } from '../lib/errors.js';

/**
 * Resolve a schedule by UUID or name (schedules have unique names per workspace, not api_name).
 */
async function resolveSchedule(
  supabase: ReturnType<typeof import('@supabase/supabase-js').createClient>,
  identifier: string,
  workspaceId: string,
  select: string = 'id, name, state',
) {
  let query = supabase
    .from('schedule_jobs')
    .select(select)
    .eq('workspace_id', workspaceId)
    .neq('state', 'deleted');

  if (isUuid(identifier)) {
    query = query.eq('id', identifier);
  } else {
    query = query.eq('name', identifier);
  }

  const { data, error } = await query.single();
  if (error || !data) {
    throw new CliError(`Schedule "${identifier}" not found.`, ErrorCode.NOT_FOUND);
  }
  return data;
}

/**
 * Resolve target: exactly one of --pipeline, --task, --orchestration on create,
 * at most one on edit. Returns { targetType, targetId } or null if none provided.
 */
function resolveTarget(opts: { pipeline?: string; task?: string; orchestration?: string }, required: boolean): { targetType: string; targetId: string } | null {
  const targets = [
    opts.pipeline && { targetType: 'pipeline', targetId: opts.pipeline },
    opts.task && { targetType: 'task', targetId: opts.task },
    opts.orchestration && { targetType: 'orchestration', targetId: opts.orchestration },
  ].filter(Boolean) as Array<{ targetType: string; targetId: string }>;

  if (targets.length > 1) {
    throw new CliError(
      'Provide only one of --pipeline, --task, or --orchestration.',
      ErrorCode.INVALID_INPUT,
    );
  }

  if (required && targets.length === 0) {
    throw new CliError(
      'A target is required. Provide one of --pipeline, --task, or --orchestration.',
      ErrorCode.INVALID_INPUT,
    );
  }

  return targets[0] || null;
}

export function registerSchedulesCommands(program: Command): void {
  const schedules = program.command('schedules').description('Manage schedules');

  // -----------------------------------------------------------------------
  // schedules list
  // -----------------------------------------------------------------------
  schedules
    .command('list')
    .description('List schedules in workspace')
    .option('--state <state>', 'Filter by state (active, inactive)')
    .action(
      withAuth(async (ctx: AuthContext, opts: { state?: string }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        let query = supabase
          .from('schedule_jobs')
          .select('id, name, description, cron_schedule, timezone, state, target_type, target_id, last_run_at, created_at')
          .eq('workspace_id', workspaceId)
          .neq('state', 'deleted')
          .order('created_at', { ascending: false });

        if (opts.state) {
          query = query.eq('state', opts.state);
        }

        const { data, error } = await query;
        if (error) throw new CliError(error.message, ErrorCode.API_ERROR);
        const rows = data || [];

        if (outputOptions.json) {
          printOutput(formatListJson(rows, rows.length, rows.length, 0));
        } else {
          if (rows.length === 0) { console.log('No schedules found.'); return; }
          const headers = ['ID', 'NAME', 'CRON', 'TARGET', 'STATE', 'LAST RUN'];
          const tableRows = rows.map((s) => [
            truncateUuid(s.id),
            s.name || '',
            s.cron_schedule || '',
            `${s.target_type || ''}`,
            s.state || '',
            relativeTime(s.last_run_at),
          ]);
          printOutput(formatTable(headers, tableRows));
        }
      }),
    );

  // -----------------------------------------------------------------------
  // schedules create
  // -----------------------------------------------------------------------
  schedules
    .command('create')
    .description('Create a new schedule')
    .requiredOption('--name <name>', 'Schedule name')
    .requiredOption('--cron <expression>', 'Cron expression (5-field, UTC)')
    .option('--pipeline <identifier>', 'Target pipeline (UUID or api_name)')
    .option('--task <identifier>', 'Target task (UUID or api_name)')
    .option('--orchestration <identifier>', 'Target orchestration (UUID or api_name)')
    .option('--timezone <tz>', 'Display timezone (e.g., America/New_York)', 'UTC')
    .option('--description <desc>', 'Schedule description')
    .action(
      withAuth(async (ctx: AuthContext, opts: {
        name: string;
        cron: string;
        pipeline?: string;
        task?: string;
        orchestration?: string;
        timezone: string;
        description?: string;
      }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        // Resolve target (exactly one required)
        const target = resolveTarget(opts, true)!;

        // If target is a pipeline, resolve by api_name if needed
        let targetId = target.targetId;
        if (!isUuid(targetId)) {
          // Resolve by name/api_name based on target type
          const table = target.targetType === 'pipeline' ? 'pipelines_and_datasources' : target.targetType === 'task' ? 'tasks' : 'orchestrations';
          const idCol = target.targetType === 'pipeline' ? 'pipeline_id' : 'id';
          const nameCol = target.targetType === 'pipeline' ? 'pipeline_api_name' : 'api_name';

          let resolveQuery = supabase.from(table).select(idCol).eq(nameCol, targetId).eq('workspace_id', workspaceId);
          const { data, error } = await resolveQuery.limit(1).single();
          if (error || !data) {
            throw new CliError(`${target.targetType} "${targetId}" not found.`, ErrorCode.NOT_FOUND);
          }
          targetId = (data as Record<string, string>)[idCol];
        }

        const { data: scheduleId, error } = await supabase.rpc('create_schedule', {
          p_workspace_id: workspaceId,
          p_name: opts.name,
          p_description: opts.description || '',
          p_cron_schedule: opts.cron,
          p_target_type: target.targetType,
          p_target_id: targetId,
          p_run_config: {},
          p_timezone: opts.timezone,
        });

        if (error) {
          throw new CliError(`Failed to create schedule: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({
            id: scheduleId,
            name: opts.name,
            cron: opts.cron,
            target_type: target.targetType,
            target_id: targetId,
            state: 'active',
          }));
        } else {
          console.log(`Schedule "${opts.name}" created. ID: ${scheduleId}`);
          console.log(`Cron: ${opts.cron} (${opts.timezone})`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // schedules edit
  // -----------------------------------------------------------------------
  schedules
    .command('edit <identifier>')
    .description('Update a schedule')
    .option('--name <name>', 'Update name')
    .option('--cron <expression>', 'Update cron expression')
    .option('--timezone <tz>', 'Update display timezone')
    .option('--description <desc>', 'Update description')
    .option('--pipeline <identifier>', 'Change target to pipeline')
    .option('--task <identifier>', 'Change target to task')
    .option('--orchestration <identifier>', 'Change target to orchestration')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: {
        name?: string;
        cron?: string;
        timezone?: string;
        description?: string;
        pipeline?: string;
        task?: string;
        orchestration?: string;
      }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const schedule = await resolveSchedule(supabase, identifier, workspaceId);

        // Resolve target change (at most one)
        const target = resolveTarget(opts, false);

        // Must change at least something
        if (!opts.name && !opts.cron && !opts.timezone && !opts.description && !target) {
          throw new CliError(
            'Nothing to update. Provide at least one of --name, --cron, --timezone, --description, or a target flag.',
            ErrorCode.INVALID_INPUT,
          );
        }

        // Resolve target ID if changing target
        let targetType: string | null = null;
        let targetId: string | null = null;
        if (target) {
          targetType = target.targetType;
          targetId = target.targetId;
          if (!isUuid(targetId)) {
            const table = target.targetType === 'pipeline' ? 'pipelines_and_datasources' : target.targetType === 'task' ? 'tasks' : 'orchestrations';
            const idCol = target.targetType === 'pipeline' ? 'pipeline_id' : 'id';
            const nameCol = target.targetType === 'pipeline' ? 'pipeline_api_name' : 'api_name';

            let resolveQuery = supabase.from(table).select(idCol).eq(nameCol, targetId).eq('workspace_id', workspaceId);
            const { data, error } = await resolveQuery.limit(1).single();
            if (error || !data) {
              throw new CliError(`${target.targetType} "${targetId}" not found.`, ErrorCode.NOT_FOUND);
            }
            targetId = (data as Record<string, string>)[idCol];
          }
        }

        const { error } = await supabase.rpc('update_schedule', {
          p_schedule_id: schedule.id,
          p_workspace_id: workspaceId,
          p_name: opts.name || null,
          p_description: opts.description || null,
          p_cron_schedule: opts.cron || null,
          p_timezone: opts.timezone || null,
          p_target_type: targetType,
          p_target_id: targetId,
          p_run_config: null,
        });

        if (error) {
          throw new CliError(`Failed to update schedule: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: schedule.id, name: opts.name || schedule.name, updated: true }));
        } else {
          console.log(`Schedule "${opts.name || schedule.name}" updated.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // schedules delete
  // -----------------------------------------------------------------------
  schedules
    .command('delete <identifier>')
    .description('Delete a schedule')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const schedule = await resolveSchedule(supabase, identifier, workspaceId);

        const { error } = await supabase
          .from('schedule_jobs')
          .update({ state: 'deleted' })
          .eq('id', schedule.id)
          .eq('workspace_id', workspaceId);

        if (error) {
          throw new CliError(`Failed to delete schedule: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: schedule.id, name: schedule.name, state: 'deleted' }));
        } else {
          console.log(`Schedule "${schedule.name}" deleted.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // schedules enable
  // -----------------------------------------------------------------------
  schedules
    .command('enable <identifier>')
    .description('Enable a schedule (set state to active)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const schedule = await resolveSchedule(supabase, identifier, workspaceId, 'id, name, state');

        if (schedule.state === 'active') {
          throw new CliError(`Schedule "${schedule.name}" is already active.`, ErrorCode.INVALID_INPUT);
        }

        // Direct table update (same as FE) -- the update_schedule_state RPC
        // calls bw_internal.manage_cron_job which requires elevated privileges
        const { error } = await supabase
          .from('schedule_jobs')
          .update({ state: 'active' })
          .eq('id', schedule.id)
          .eq('workspace_id', workspaceId);

        if (error) {
          throw new CliError(`Failed to enable schedule: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: schedule.id, name: schedule.name, state: 'active' }));
        } else {
          console.log(`Schedule "${schedule.name}" enabled.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // schedules disable
  // -----------------------------------------------------------------------
  schedules
    .command('disable <identifier>')
    .description('Disable a schedule (set state to inactive)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const schedule = await resolveSchedule(supabase, identifier, workspaceId, 'id, name, state');

        if (schedule.state === 'inactive') {
          throw new CliError(`Schedule "${schedule.name}" is already inactive.`, ErrorCode.INVALID_INPUT);
        }

        const { error } = await supabase
          .from('schedule_jobs')
          .update({ state: 'inactive' })
          .eq('id', schedule.id)
          .eq('workspace_id', workspaceId);

        if (error) {
          throw new CliError(`Failed to disable schedule: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: schedule.id, name: schedule.name, state: 'inactive' }));
        } else {
          console.log(`Schedule "${schedule.name}" disabled.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // schedules run
  // -----------------------------------------------------------------------
  schedules
    .command('run <identifier>')
    .description('Trigger immediate execution of a schedule')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const schedule = await resolveSchedule(supabase, identifier, workspaceId);

        const { error } = await supabase.rpc('run_schedule_now', {
          p_schedule_job_id: schedule.id,
        });

        if (error) {
          throw new CliError(`Failed to run schedule: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: schedule.id, name: schedule.name, status: 'triggered' }));
        } else {
          console.log(`Schedule "${schedule.name}" triggered.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // schedules history
  // -----------------------------------------------------------------------
  schedules
    .command('history <identifier>')
    .description('View execution history for a schedule')
    .option('--limit <n>', 'Number of executions to show', '10')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: { limit: string }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        const schedule = await resolveSchedule(supabase, identifier, workspaceId);
        const limit = parseInt(opts.limit, 10) || 10;

        const { data, error } = await supabase.rpc('get_schedule_history', {
          p_schedule_job_id: schedule.id,
          p_limit: limit,
        });

        if (error) {
          throw new CliError(`Failed to fetch history: ${error.message}`, ErrorCode.API_ERROR);
        }

        const rows = (data || []) as Array<Record<string, unknown>>;

        if (outputOptions.json) {
          printOutput(formatListJson(rows, rows.length, limit, 0));
        } else {
          if (rows.length === 0) { console.log(`No execution history for "${schedule.name}".`); return; }
          const headers = ['TRIGGERED', 'STATUS', 'DURATION', 'TOTAL', 'OK', 'FAILED'];
          const tableRows = rows.map((r) => [
            relativeTime(r.triggered_at as string | null),
            String(r.status || ''),
            r.duration ? String(r.duration) : '-',
            String(r.entries_total || 0),
            String(r.entries_completed || 0),
            String(r.entries_failed || 0),
          ]);
          printOutput(formatTable(headers, tableRows));
        }
      }),
    );
}
