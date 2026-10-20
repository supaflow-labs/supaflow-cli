import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSupaflowArgv, listToolDefinitions } from '../src/mcp/server.js';

const mocks = vi.hoisted(() => ({ from: vi.fn(), insert: vi.fn() }));
vi.mock('../src/lib/middleware.js', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user_test' })).toString('base64url');
      await handler(
        {
          supabase: { from: mocks.from },
          workspaceId: 'workspace-1',
          conn: { bearerToken: `test.${payload}.test` },
          outputOptions: { json: true },
        },
        ...args.slice(0, -1),
      );
    },
}));
import { registerProjectsCommands } from '../src/commands/projects.js';

function program() {
  const command = new Command().exitOverride().option('--json');
  command.configureOutput({ writeErr: () => {} });
  registerProjectsCommands(command);
  return command;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.from.mockImplementation((table: string) => {
    if (table === 'datasources_with_access') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { id: 'destination-1' }, error: null }),
      };
    }
    if (table === 'projects')
      return {
        insert: mocks.insert.mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { id: 'project-1' }, error: null }),
      };
    throw new Error(`Unexpected table: ${table}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const baseArgs = ['projects', 'create', '--name', 'Audience', '--destination', 'warehouse'];

describe('project creation types through CLI and stdio MCP', () => {
  it('advertises only pipeline and transformation in the MCP schema', () => {
    const schema = listToolDefinitions().find(
      (tool) => tool.name === 'projects_create',
    )!.inputSchema;
    expect(schema.properties.type.enum).toEqual(['pipeline', 'transformation']);
    expect(schema.properties.type.default).toBe('pipeline');
  });

  it.each([undefined, 'pipeline', 'transformation'])(
    'creates supported type %s through CLI and MCP argv',
    async (type) => {
      for (const args of [
        [...baseArgs, ...(type ? ['--type', type] : [])],
        buildSupaflowArgv('projects_create', { name: 'Audience', destination: 'warehouse', type }),
      ]) {
        await program().parseAsync(['node', 'test', ...args]);
        expect(mocks.insert).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: type ?? 'pipeline',
            workspace_id: 'workspace-1',
            warehouse_datasource_id: 'destination-1',
          }),
        );
      }
    },
  );

  it.each(['activation', 'ingestion', 'unknown'])(
    'rejects %s through CLI and MCP argv before database access',
    async (type) => {
      for (const args of [
        [...baseArgs, '--type', type],
        buildSupaflowArgv('projects_create', { name: 'Audience', destination: 'warehouse', type }),
      ]) {
        await expect(program().parseAsync(['node', 'test', ...args])).rejects.toMatchObject({
          code: 'commander.invalidArgument',
        });
        expect(mocks.from).not.toHaveBeenCalled();
      }
    },
  );
});
