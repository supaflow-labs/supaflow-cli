import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BootstrapResponse } from '../types/index.js';

interface RegionConfig {
  url: string;
  anonKey: string;
}

// Fallback region configs -- same public values as NEXT_PUBLIC_SUPABASE_* in supaflow-app.
// Used only when the bootstrap endpoint is unreachable.
// TODO: Replace placeholder values with actual Supabase project URLs and anon keys.
export const REGION_CONFIGS: Record<string, RegionConfig> = {
  us: {
    url: 'https://cklwdlcrqlsbokeqaqrx.supabase.co',
    anonKey: '',
  },
  eu: {
    url: '',
    anonKey: '',
  },
};

// Read env vars at call time, not module load time.
function getEnvOverride(): RegionConfig | null {
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

export function getRegionConfig(region: string | undefined): RegionConfig {
  if (!region) return REGION_CONFIGS.us;
  const config = REGION_CONFIGS[region];
  if (!config) return REGION_CONFIGS.us;
  return config;
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
    if (!response.ok) return null;
    return (await response.json()) as BootstrapResponse;
  } catch {
    return null;
  }
}

export interface AuthenticatedClient {
  client: SupabaseClient;
  supabaseUrl: string;
  anonKey: string;
  apiKey: string;
}

export async function createAuthenticatedClient(
  apiKey: string,
  supabaseUrlOverride?: string,
): Promise<AuthenticatedClient> {
  const clientOpts = {
    global: { headers: { Authorization: `Bearer ${apiKey}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };

  const makeResult = (url: string, key: string) => ({
    client: createClient(url, key, clientOpts),
    supabaseUrl: url,
    anonKey: key,
    apiKey,
  });

  // 1. Explicit env var override (highest priority)
  const envOverride = getEnvOverride();
  if (envOverride) {
    return makeResult(envOverride.url, envOverride.anonKey);
  }

  // 1b. --supabase-url flag override
  if (supabaseUrlOverride) {
    const key = process.env.SUPAFLOW_SUPABASE_ANON_KEY;
    if (!key) {
      throw new Error('--supabase-url requires SUPAFLOW_SUPABASE_ANON_KEY environment variable.');
    }
    return makeResult(supabaseUrlOverride, key);
  }

  // 2. Primary: bootstrap endpoint
  const bootstrap = await fetchBootstrap(apiKey);
  if (bootstrap) {
    return makeResult(bootstrap.supabase_url, bootstrap.supabase_anon_key);
  }

  // 3. Fallback: decode JWT region + shipped regionConfigs
  const region = decodeJwtRegion(apiKey);
  const config = getRegionConfig(region);
  if (!config.url || !config.anonKey) {
    throw new Error(
      'Cannot resolve Supabase connection. Set SUPAFLOW_SUPABASE_URL and SUPAFLOW_SUPABASE_ANON_KEY environment variables.',
    );
  }

  return makeResult(config.url, config.anonKey);
}

/**
 * Soft delete using PostgREST directly with Prefer: return=minimal.
 * Supabase JS .update() adds RETURNING which triggers RLS violation after state='deleted'.
 */
export async function softDeleteRecord(
  conn: { supabaseUrl: string; anonKey: string; apiKey: string },
  tableName: string,
  recordId: string,
): Promise<void> {
  const url = `${conn.supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}?id=eq.${encodeURIComponent(recordId)}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: conn.anonKey,
      Authorization: `Bearer ${conn.apiKey}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ state: 'deleted' }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete ${tableName}: ${response.status} ${errorText}`);
  }
}
