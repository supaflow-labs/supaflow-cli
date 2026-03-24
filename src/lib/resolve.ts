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
  if (isUuid(identifier)) {
    return identifier;
  }

  let query = supabase.from(table).select(idColumn).eq(apiNameColumn, identifier);
  if (workspaceId) {
    query = query.eq('workspace_id', workspaceId);
  }
  const { data, error } = await query.limit(1).single();

  if (error || !data) {
    throw new CliError(
      `Could not resolve "${identifier}" in ${table}. Use a UUID or valid api_name.`,
      ErrorCode.NOT_FOUND,
    );
  }

  return (data as Record<string, string>)[idColumn];
}
