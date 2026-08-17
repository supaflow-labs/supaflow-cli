import type { SupabaseClient } from '@supabase/supabase-js';
import { CliError, ErrorCode } from './errors.js';

export type CatalogResetState =
  | 'maintenance_in_progress'
  | 'restoration_pending'
  | 'completed'
  | 'unchanged'
  | 'restored';

export interface CatalogResetStatus {
  job_id: string;
  maintenance_active: boolean;
  catalog_state: CatalogResetState;
  finished_at: string | null;
}

interface PollOptions {
  intervalMs?: number;
  maxConsecutiveErrors?: number;
  wait?: (milliseconds: number) => Promise<void>;
  onStatus?: (status: CatalogResetStatus) => void;
  onError?: () => void;
}

const MAX_CONSECUTIVE_STATUS_ERRORS = 5;

const STATES = new Set<CatalogResetState>([
  'maintenance_in_progress',
  'restoration_pending',
  'completed',
  'unchanged',
  'restored',
]);

export async function getCatalogResetStatus(
  supabase: SupabaseClient,
  jobId: string,
): Promise<CatalogResetStatus> {
  const { data, error } = await supabase.rpc('get_datasource_catalog_reset_status', {
    p_job_id: jobId,
  });

  if (error) {
    throw new CliError('Unable to check source catalog maintenance status.', ErrorCode.API_ERROR);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (
    !row ||
    typeof row.job_id !== 'string' ||
    typeof row.maintenance_active !== 'boolean' ||
    !STATES.has(row.catalog_state)
  ) {
    throw new CliError('Source catalog maintenance status is unavailable.', ErrorCode.API_ERROR);
  }

  return row as CatalogResetStatus;
}

export async function enqueueCatalogReset(
  supabase: SupabaseClient,
  datasourceId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('create_datasource_catalog_reset_job', {
    p_datasource_id: datasourceId,
  });
  if (error || typeof data !== 'string' || data.length === 0) {
    throw new CliError('Source catalog reset could not be started.', ErrorCode.API_ERROR);
  }
  return data;
}

export async function pollCatalogResetUntilFinished(
  supabase: SupabaseClient,
  jobId: string,
  options: PollOptions = {},
): Promise<CatalogResetStatus> {
  const {
    intervalMs = 2000,
    maxConsecutiveErrors = MAX_CONSECUTIVE_STATUS_ERRORS,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onStatus,
    onError,
  } = options;
  let consecutiveErrors = 0;

  while (true) {
    let status: CatalogResetStatus;
    try {
      status = await getCatalogResetStatus(supabase, jobId);
    } catch {
      onError?.();
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new CliError(
          'Unable to check source catalog maintenance status after repeated attempts. Rerun this command to reattach to the source catalog reset.',
          ErrorCode.API_ERROR,
        );
      }
      await wait(intervalMs);
      continue;
    }
    consecutiveErrors = 0;
    onStatus?.(status);

    if (!status.maintenance_active) return status;
    await wait(intervalMs);
  }
}

export function catalogResetOutcomeMessage(status: CatalogResetStatus): string {
  switch (status.catalog_state) {
    case 'maintenance_in_progress':
      return 'Source catalog maintenance is in progress.';
    case 'restoration_pending':
      return 'The reset stopped. The previous source catalog is being restored.';
    case 'completed':
      return 'Source catalog reset completed. Existing pipelines and selections were preserved.';
    case 'unchanged':
      return 'Source catalog reset did not start. The existing catalog was unchanged.';
    case 'restored':
      return 'Source catalog reset did not complete. The previous catalog was restored and existing pipelines were preserved.';
  }
}
