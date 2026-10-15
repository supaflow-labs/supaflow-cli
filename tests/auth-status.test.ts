import { Command } from 'commander';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CliConfig } from '../src/types/index.js';
import { registerAuthCommands } from '../src/commands/auth.js';

const { state } = vi.hoisted(() => ({ state: { config: {} as CliConfig } }));
vi.mock('../src/lib/config.js', async (original) => ({
  ...(await original<typeof import('../src/lib/config.js')>()),
  readConfig: () => state.config,
}));
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.config = {
    api_key: 'stored-test-key',
    workspace_id: 'stored-workspace',
    workspace_name: 'Stored workspace',
  };
  vi.stubEnv('SUPAFLOW_API_KEY', '');
  vi.stubEnv('SUPAFLOW_WORKSPACE_ID', 'env-workspace');
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function status(args: string[] = []) {
  const program = new Command()
    .option('--json')
    .option('--api-key <key>')
    .option('--workspace <id>');
  registerAuthCommands(program);
  await program.parseAsync(['node', 'supaflow', '--json', ...args, 'auth', 'status']);
  return JSON.parse(String(output.mock.calls[0][0]));
}

it('reports explicit credentials and workspace ahead of environment and config', async () => {
  vi.stubEnv('SUPAFLOW_API_KEY', 'env-test-key');
  expect(
    await status(['--api-key', 'flag-test-key', '--workspace', 'flag-workspace']),
  ).toMatchObject({
    authenticated: true,
    method: 'api_key',
    source: 'flag',
    workspace_id: 'flag-workspace',
    workspace_source: 'flag',
    workspace_name: '(from flag)',
  });
});
it('reports environment workspace and credential ahead of stored defaults', async () => {
  vi.stubEnv('SUPAFLOW_API_KEY', 'env-test-key');
  expect(await status()).toMatchObject({
    source: 'env',
    workspace_id: 'env-workspace',
    workspace_source: 'env',
    workspace_name: '(from env)',
  });
});
it('recognizes an explicit key without any stored login', async () => {
  state.config = {};
  expect(await status(['--api-key', 'flag-test-key'])).toMatchObject({
    authenticated: true,
    method: 'api_key',
    source: 'flag',
  });
});
