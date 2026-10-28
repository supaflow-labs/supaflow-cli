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

// Bootstrap only mints a session; replaying it does not replay the user's command.
const BOOTSTRAP_MAX_ATTEMPTS = 3;
const BOOTSTRAP_BUDGET_MS = 30_000;
const BOOTSTRAP_ATTEMPT_MS = 15_000;

class BootstrapHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
    accessMessage?: string,
  ) {
    super(`Bootstrap failed (${status})${accessMessage ? `: ${accessMessage}` : ''}`);
  }
}

function bootstrapAccessMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined;
  // Translate only recognized policy codes. Never echo upstream response text.
  switch (body.error) {
    case 'cli_oauth_disabled':
      return (
        'CLI OAuth access is disabled for the selected account. Ask its owner or an organization ' +
        'administrator to enable Supaflow CLI under Settings > API Keys > OAuth applications, save, and retry.'
      );
    case 'api_disabled':
      return (
        'API access is disabled for the selected account. Ask its owner or an organization ' +
        'administrator to enable API access and the required authentication option under Settings > API Keys, save, and retry.'
      );
    case 'api_keys_disabled':
      return (
        'API key access is disabled for the selected account. Ask its owner or an organization ' +
        'administrator to enable Allow API keys under Settings > API Keys, save, and retry.'
      );
    case 'organization_administrator_required':
      return 'CLI access requires the personal account owner or an organization administrator. Sign in with an eligible account and retry.';
    default:
      return undefined;
  }
}

function bootstrapRetryDelay(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

function retryableBootstrapError(error: unknown): boolean {
  if (error instanceof BootstrapHttpError) {
    return [408, 425, 429].includes(error.status) || (error.status >= 500 && error.status <= 599);
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
  );
}

async function fetchBootstrap(apiKey: string): Promise<BootstrapResponse | null> {
  const url = new URL('/api/cli/bootstrap', getBootstrapUrl()).toString();
  const deadline = Date.now() + BOOTSTRAP_BUDGET_MS;
  for (let attempt = 0; attempt < BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(BOOTSTRAP_ATTEMPT_MS, remaining));
    let failure: unknown;
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        const retryAfter = bootstrapRetryDelay(response.headers.get('retry-after'));
        let accessMessage: string | undefined;
        if (response.status === 403) {
          accessMessage = bootstrapAccessMessage(await response.json().catch(() => undefined));
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
        throw new BootstrapHttpError(response.status, retryAfter, accessMessage);
      }
      try {
        return (await response.json()) as BootstrapResponse;
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('Bootstrap returned invalid JSON');
        throw error;
      }
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    if (!retryableBootstrapError(failure)) throw failure;
    const delay = Math.max(
      Math.round(250 * 2 ** attempt * (0.75 + Math.random() * 0.5)),
      failure instanceof BootstrapHttpError ? failure.retryAfterMs : 0,
    );
    if (attempt + 1 >= BOOTSTRAP_MAX_ATTEMPTS || Date.now() + delay >= deadline) {
      if (failure instanceof BootstrapHttpError) throw failure;
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  return null;
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
  authMethod: 'api_key' | 'oauth' = 'api_key',
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
  if (envOverride && authMethod === 'api_key') {
    return makeClient(envOverride.url, envOverride.anonKey, apiKey);
  }

  // 1b. --supabase-url flag override
  if (supabaseUrlOverride && authMethod === 'api_key') {
    const key = process.env.SUPAFLOW_SUPABASE_ANON_KEY;
    if (!key) {
      throw new Error('--supabase-url requires SUPAFLOW_SUPABASE_ANON_KEY environment variable.');
    }
    return makeClient(supabaseUrlOverride, key, apiKey);
  }

  // 2. Bootstrap endpoint (required for normal operation)
  // Exchanges a Clerk API key or OAuth access token for a Supabase-compatible JWT.
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

export type SoftDeletableEntity = 'datasource' | 'pipeline' | 'project';

/**
 * Soft-delete through the same recursive RPCs used by the Supaflow UI.
 * The affected count prevents RLS-filtered zero-row updates from being
 * reported as successful.
 */
export async function softDeleteEntity(
  supabase: SupabaseClient,
  entityType: SoftDeletableEntity,
  recordId: string,
): Promise<Record<string, unknown>> {
  const argumentName = `p_${entityType}_id`;
  const { data, error } = await supabase.rpc(`soft_delete_${entityType}`, {
    [argumentName]: recordId,
  });
  if (error) {
    throw new Error(`Failed to delete ${entityType}: ${error.message}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (
    !row ||
    row.entity_type !== entityType ||
    typeof row.affected_count !== 'number' ||
    row.affected_count < 1
  ) {
    throw new Error(
      `Failed to delete ${entityType}: no row was affected; it may no longer exist or access was denied`,
    );
  }
  return row;
}
