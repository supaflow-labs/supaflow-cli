import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerWorkspacesCommands } from './commands/workspaces.js';
import { registerDatasourcesCommands } from './commands/datasources.js';
import { registerPipelinesCommands } from './commands/pipelines.js';
import { registerProjectsCommands } from './commands/projects.js';
import { registerJobsCommands } from './commands/jobs.js';
import { registerEncryptCommand } from './commands/encrypt.js';
import { registerConnectorsCommands } from './commands/connectors.js';
import { registerSchedulesCommands } from './commands/schedules.js';
import { registerDocsCommand } from './commands/docs.js';

const program = new Command();

program
  .name('supaflow')
  .description('CLI for Supaflow data integration platform')
  .version('0.1.12')
  .option('--json', 'Output as JSON')
  .option('--workspace <id>', 'Override active workspace')
  .option('--api-key <key>', 'Override stored API key')
  .option('--supabase-url <url>', 'Override Supabase project URL (dev/testing)')
  .option('--verbose', 'Enable debug output')
  .option('--no-color', 'Suppress ANSI colors');
  // Note: Commander.js treats --no-color as negation of --color, setting opts.color = false.
  // The middleware reads opts.color === false to detect this.

registerAuthCommands(program);
registerWorkspacesCommands(program);
registerDatasourcesCommands(program);
registerPipelinesCommands(program);
registerProjectsCommands(program);
registerJobsCommands(program);
registerEncryptCommand(program);
registerConnectorsCommands(program);
registerSchedulesCommands(program);
registerDocsCommand(program);

program.parse();
