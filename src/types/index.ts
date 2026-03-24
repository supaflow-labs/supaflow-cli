export interface CliConfig {
  api_key?: string;
  workspace_id?: string;
  workspace_name?: string;
}

export interface BootstrapResponse {
  supabase_url: string;
  supabase_anon_key: string;
  region: string;
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
