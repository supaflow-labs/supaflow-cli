import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BootstrapResponse } from '../types/index.js';

// Read env vars at call time, not module load time.
function getEnvOverride(): { url: string; anonKey: string } | null {
  const url = process.env.SUPAFLOW_SUPABASE_URL;
  const key = process.env.SUPAFLOW_SUPABASE_ANON_KEY;
  if (url && key) return { url, anonKey: key };
  return null;
}

function getBootstrapUrl(): string {
  return process.env.SUPAFLOW_APP_URL || 'https://app.supa-flow.io';
}

export function decodeJwtRegion(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (payload.org_region as string) || (payload.user_region as string) || undefined;
  } catch {
    return undefined;
  }
}

async function fetchBootstrap(apiKey: string): Promise<BootstrapResponse | null> {
  try {
    const response = await fetch(`${getBootstrapUrl()}/api/cli/bootstrap`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Bootstrap failed (${response.status}): ${body}`);
    }
    return (await response.json()) as BootstrapResponse;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Bootstrap failed')) {
      throw err; // Re-throw auth/validation errors from bootstrap
    }
    return null; // Network errors -- bootstrap unreachable
  }
}

export interface AuthenticatedClient {
  client: SupabaseClient;
  conn: {
    supabaseUrl: string;
    anonKey: string;
    bearerToken: string; // The JWT used as Supabase bearer token
  };
}

export async function createAuthenticatedClient(
  apiKey: string,
  supabaseUrlOverride?: string,
): Promise<AuthenticatedClient> {
  const makeClient = (url: string, anonKey: string, bearerToken: string): AuthenticatedClient => ({
    client: createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
    conn: { supabaseUrl: url, anonKey, bearerToken },
  });

  // 1. Explicit env var override (highest priority)
  // When using env vars, the apiKey itself is used as bearer token (assumed to be a JWT)
  const envOverride = getEnvOverride();
  if (envOverride) {
    return makeClient(envOverride.url, envOverride.anonKey, apiKey);
  }

  // 1b. --supabase-url flag override
  if (supabaseUrlOverride) {
    const key = process.env.SUPAFLOW_SUPABASE_ANON_KEY;
    if (!key) {
      throw new Error('--supabase-url requires SUPAFLOW_SUPABASE_ANON_KEY environment variable.');
    }
    return makeClient(supabaseUrlOverride, key, apiKey);
  }

  // 2. Bootstrap endpoint (required for normal operation)
  // Exchanges ak_ API key for a self-signed HS256 JWT with Supabase-compatible claims.
  // The returned token (not the ak_ key) is used as the Supabase bearer token.
  const bootstrap = await fetchBootstrap(apiKey);
  if (bootstrap) {
    return makeClient(bootstrap.supabase_url, bootstrap.supabase_anon_key, bootstrap.token);
  }

  // Bootstrap unreachable -- fail explicitly.
  throw new Error(
    'Bootstrap endpoint unavailable. Cannot resolve Supabase connection.\n' +
    'Set SUPAFLOW_SUPABASE_URL and SUPAFLOW_SUPABASE_ANON_KEY environment variables,\n' +
    'or ensure https://app.supa-flow.io is reachable.',
  );
}

/**
 * Soft delete using PostgREST directly with Prefer: return=minimal.
 * Supabase JS .update() adds RETURNING which triggers RLS violation after state='deleted'.
 */
export async function softDeleteRecord(
  conn: { supabaseUrl: string; anonKey: string; bearerToken: string },
  tableName: string,
  recordId: string,
): Promise<void> {
  const url = `${conn.supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}?id=eq.${encodeURIComponent(recordId)}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: conn.anonKey,
      Authorization: `Bearer ${conn.bearerToken}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ state: 'deleted' }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete ${tableName}: ${response.status} ${errorText}`);
  }
}
