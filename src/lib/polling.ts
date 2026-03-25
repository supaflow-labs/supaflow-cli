import type { SupabaseClient } from '@supabase/supabase-js';
import { CliError, ErrorCode } from './errors.js';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150; // 5 minutes

const SUCCESS_STATES = new Set(['completed', 'completed_with_warning']);
const FAILURE_STATES = new Set(['failed', 'cancelled', 'timed_out', 'skipped']);

export interface PollResult {
  success: boolean;
  jobStatus: string;
  statusMessage: string | null;
}

export async function pollJobUntilDone(
  supabase: SupabaseClient,
  jobId: string,
): Promise<PollResult> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < MAX_POLLS; i++) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_status, status_message')
      .eq('id', jobId)
      .single();

    if (error) {
      throw new CliError(`Failed to check job status: ${error.message}`, ErrorCode.API_ERROR);
    }

    const status = data.job_status;

    if (SUCCESS_STATES.has(status)) {
      return { success: true, jobStatus: status, statusMessage: data.status_message };
    }
    if (FAILURE_STATES.has(status)) {
      return { success: false, jobStatus: status, statusMessage: data.status_message };
    }

    await wait(POLL_INTERVAL_MS);
  }

  throw new CliError(
    'Connection test timed out. Check the Supaflow web UI for details.',
    ErrorCode.API_ERROR,
  );
}
