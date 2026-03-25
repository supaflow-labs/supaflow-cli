import { Command } from 'commander';
import { withAuthOnly } from '../lib/middleware.js';
import { formatTable, formatListJson, printOutput } from '../lib/output.js';
import { fetchConnectors } from '../lib/connector.js';

export function registerConnectorsCommands(program: Command): void {
  const connectors = program.command('connectors').description('Browse available connectors');

  connectors
    .command('list')
    .description('List available connector types')
    .action(
      withAuthOnly(async (ctx) => {
        const { supabase, outputOptions } = ctx;
        const all = await fetchConnectors(supabase);
        const sorted = all.sort((a, b) => a.type.localeCompare(b.type));

        if (outputOptions.json) {
          printOutput(formatListJson(
            sorted.map((c) => ({ type: c.type, name: c.name, version: c.latest_version })),
            sorted.length,
            sorted.length,
            0,
          ));
        } else {
          const headers = ['TYPE', 'NAME', 'VERSION'];
          const rows = sorted.map((c) => [c.type, c.name, c.latest_version || '']);
          printOutput(formatTable(headers, rows));
        }
      }),
    );
}
