import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { cancelJobById } from '../src/commands/jobs.js';
import { CliError, ErrorCode } from '../src/lib/errors.js';

const JOB_ID = '13cfe303-c67e-4a5b-8f9d-1e2f3a4b5c6d';

function clientWithRpc(result: { data: boolean | null; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('cancelJobById', () => {
  it('calls the actor-stamping RPC exactly once', async () => {
    const { client, rpc } = clientWithRpc({ data: true, error: null });

    await expect(cancelJobById(client, JOB_ID)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('cancel_job', { p_job_id: JOB_ID });
  });

  it('rejects an invalid job id before calling the API', async () => {
    const { client, rpc } = clientWithRpc({ data: true, error: null });

    await expect(cancelJobById(client, 'not-a-uuid')).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    } satisfies Partial<CliError>);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports an inactive, inaccessible, or missing job without another API call', async () => {
    const { client, rpc } = clientWithRpc({ data: false, error: null });

    await expect(cancelJobById(client, JOB_ID)).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      message: `Job "${JOB_ID}" is no longer active or cannot be cancelled.`,
    } satisfies Partial<CliError>);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
