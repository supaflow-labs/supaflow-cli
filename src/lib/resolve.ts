import type { SupabaseClient } from '@supabase/supabase-js';
import { CliError, ErrorCode } from './errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export async function resolveIdentifier(
  supabase: SupabaseClient,
  table: string,
  identifier: string,
  idColumn: string = 'id',
  apiNameColumn: string = 'api_name',
  workspaceId?: string,
): Promise<string> {
  let query = supabase.from(table).select(idColumn);

  if (isUuid(identifier)) {
    query = query.eq(idColumn, identifier);
  } else {
    query = query.eq(apiNameColumn, identifier);
  }

  if (workspaceId) {
    query = query.eq('workspace_id', workspaceId);
  }
  const { data, error } = await query.limit(1).single();

  if (error || !data) {
    throw new CliError(
      `"${identifier}" not found. Use a valid UUID or api_name.`,
      ErrorCode.NOT_FOUND,
    );
  }

  return (data as Record<string, string>)[idColumn];
}
