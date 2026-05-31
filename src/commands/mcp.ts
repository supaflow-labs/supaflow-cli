import type { Command } from 'commander';
import { main } from '../mcp/server.js';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the stdio MCP server for Claude Desktop host registration. Emits only JSON-RPC on stdout.')
    .action(async () => {
      // stdout is reserved for MCP JSON-RPC framing. Do NOT print here.
      // The stdio transport keeps the process alive by reading stdin.
      await main();
    });
}
