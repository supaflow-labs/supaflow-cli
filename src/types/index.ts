export interface CliConfig {
  api_key?: string;
  workspace_id?: string;
  workspace_name?: string;
}

export interface BootstrapResponse {
  token: string;
  supabase_url: string;
  supabase_anon_key: string;
  region: string;
  org_id: string | null;
  user_id: string;
  org_role: string | null;
  expires_at: string;
  ttl_seconds: number;
}

export interface ListOptions {
  limit: number;
  offset: number;
  filter: string[];
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface OutputOptions {
  json: boolean;
  noColor: boolean;
  verbose: boolean;
}

// AuthContext is defined in src/lib/middleware.ts, not here, to avoid circular imports.
