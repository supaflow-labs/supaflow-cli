import type { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OutputOptions } from '../types/index.js';
import { readConfig, resolveApiKey, resolveWorkspaceId } from './config.js';
import { createAuthenticatedClient, type AuthenticatedClient } from './client.js';
import { CliError, ErrorCode, handleError } from './errors.js';

export interface AuthContext {
  supabase: SupabaseClient;
  conn: AuthenticatedClient['conn'];
  workspaceId: string;
  outputOptions: OutputOptions;
}

type AuthHandler = (ctx: AuthContext, ...args: unknown[]) => Promise<void>;

export function withAuth(handler: AuthHandler) {
  return async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    const opts = cmd.optsWithGlobals();
    const json = opts.json ?? false;

    try {
      const config = readConfig();
      const apiKey = resolveApiKey(opts.apiKey, process.env.SUPAFLOW_API_KEY, config);

      if (!apiKey) {
        throw new CliError(
          'Not authenticated. Run "supaflow auth login" or set SUPAFLOW_API_KEY.',
          ErrorCode.NOT_AUTHENTICATED,
        );
      }

      const authResult = await createAuthenticatedClient(apiKey, opts.supabaseUrl);

      const workspaceId = resolveWorkspaceId(
        opts.workspace,
        process.env.SUPAFLOW_WORKSPACE_ID,
        config,
      );

      if (!workspaceId) {
        throw new CliError(
          'No workspace selected. Run "supaflow workspaces select" or set --workspace.',
          ErrorCode.NO_WORKSPACE,
        );
      }

      // Validate workspace exists and user has access
      const { data: wsCheck, error: wsError } = await authResult.client
        .from('workspaces_with_access')
        .select('id, name')
        .eq('id', workspaceId)
        .single();

      if (wsError || !wsCheck) {
        throw new CliError(
          `Workspace "${workspaceId}" not found or you don't have access. Run "supaflow workspaces list" to see available workspaces, then "supaflow workspaces select" to pick one.`,
          ErrorCode.NO_WORKSPACE,
        );
      }

      const outputOptions: OutputOptions = {
        json,
        noColor: opts.color === false || !process.stdout.isTTY,
        verbose: opts.verbose ?? false,
      };

      await handler({ supabase: authResult.client, conn: authResult.conn, workspaceId, outputOptions }, ...args.slice(0, -1));
    } catch (error) {
      handleError(error, json);
    }
  };
}

// Variant that only requires auth, not workspace (for workspaces list/select)
type AuthOnlyHandler = (ctx: Omit<AuthContext, 'workspaceId'> & { workspaceId?: string }, ...args: unknown[]) => Promise<void>;

export function withAuthOnly(handler: AuthOnlyHandler) {
  return async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    const opts = cmd.optsWithGlobals();
    const json = opts.json ?? false;

    try {
      const config = readConfig();
      const apiKey = resolveApiKey(opts.apiKey, process.env.SUPAFLOW_API_KEY, config);

      if (!apiKey) {
        throw new CliError(
          'Not authenticated. Run "supaflow auth login" or set SUPAFLOW_API_KEY.',
          ErrorCode.NOT_AUTHENTICATED,
        );
      }

      const authResult = await createAuthenticatedClient(apiKey, opts.supabaseUrl);

      const workspaceId = resolveWorkspaceId(
        opts.workspace,
        process.env.SUPAFLOW_WORKSPACE_ID,
        config,
      );

      const outputOptions: OutputOptions = {
        json,
        noColor: opts.color === false || !process.stdout.isTTY,
        verbose: opts.verbose ?? false,
      };

      await handler({ supabase: authResult.client, conn: authResult.conn, workspaceId, outputOptions }, ...args.slice(0, -1));
    } catch (error) {
      handleError(error, json);
    }
  };
}
