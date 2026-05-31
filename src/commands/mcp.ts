import type { Command } from 'commander';
import { main } from '../mcp/server.js';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the stdio MCP server for Claude Desktop host registration. Emits only JSON-RPC on stdout.')
    .action(async (_options: unknown, command: Command) => {
      // Forward the parent's global overrides to every child CLI invocation, so tool
      // calls operate on the same workspace/identity/backend the server was launched
      // with. The api key goes via env (not argv) to avoid process-listing exposure.
      const g = command.optsWithGlobals();
      const env: Record<string, string> = {};
      const argv: string[] = [];
      if (g.apiKey) env.SUPAFLOW_API_KEY = String(g.apiKey);
      if (g.workspace) env.SUPAFLOW_WORKSPACE_ID = String(g.workspace);
      if (g.supabaseUrl) argv.push('--supabase-url', String(g.supabaseUrl));
      // stdout is reserved for MCP JSON-RPC framing. Do NOT print here.
      // The stdio transport keeps the process alive by reading stdin.
      await main({ env, argv });
    });
}
