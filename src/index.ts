import { Command } from 'commander';

const program = new Command();

program
  .name('supaflow')
  .description('CLI for Supaflow data integration platform')
  .version('0.1.0');

program.parse();
