import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../src/lib/middleware.js', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      await handler(
        {
          supabase: mocks,
          workspaceId: 'workspace-1',
          conn: {
            bearerToken: `test.${Buffer.from('{"sub":"test-user"}').toString('base64url')}.test`,
          },
          outputOptions: { json: true },
        },
        ...args.slice(0, -1),
      );
    },
}));

import { registerPipelinesCommands } from '../src/commands/pipelines.js';
import { applyConfigPatch, buildSupaflowArgv } from '../src/mcp/server.js';

let directory: string;
let configPath: string;
let objectsPath: string;
let capabilities: Record<string, unknown> | null;
let currentConfig: Record<string, unknown>;
let destinationError: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supaflow-keyless-policy-'));
  configPath = path.join(directory, 'config.json');
  objectsPath = path.join(directory, 'objects.json');
  fs.writeFileSync(
    objectsPath,
    JSON.stringify([{ fully_qualified_name: 'public.events', selected: true, fields: null }]),
  );
  capabilities = { supports_row_hash_merge: { supported: true } };
  currentConfig = {
    keyless_object_handling: 'ROW_HASH',
    load_mode: 'APPEND',
    custom_backend_field: 'preserve',
  };
  destinationError = false;
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((key: string, value: unknown) => {
        filters[key] = value;
        return query;
      }),
      neq: vi.fn(() => query),
      insert: mocks.insert.mockImplementation(() => query),
      update: mocks.update.mockImplementation(() => query),
      single: vi.fn(async () => {
        if (table === 'datasources_with_access') {
          if (filters.id === 'destination-1' && destinationError)
            return { data: null, error: { message: 'unavailable' } };
          return {
            data: {
              id: filters.id ?? 'source-1',
              name: 'Fixture',
              api_name: 'fixture',
              state: 'active',
              connector_type: 'MYSQL',
              connector_version_capabilities_config: capabilities,
            },
            error: null,
          };
        }
        if (table === 'projects')
          return {
            data: { id: 'project-1', name: 'Project', warehouse_datasource_id: 'destination-1' },
            error: null,
          };
        if (table === 'pipelines_and_datasources')
          return {
            data: {
              pipeline_id: 'pipeline-1',
              pipeline_configs: currentConfig,
              destination_datasource_id: 'destination-1',
            },
            error: null,
          };
        if (table === 'pipelines') return { data: { id: 'pipeline-1' }, error: null };
        throw new Error(`Unexpected table: ${table}`);
      }),
      maybeSingle: vi.fn(async () => ({ data: { id: 'pipeline-1' }, error: null })),
    };
    return query;
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_active_pipeline_version') return { data: [{ id: 'version-1' }], error: null };
    if (name === 'save_pipeline_metadata_mappings')
      return {
        data: [
          {
            processed_count: 1,
            inserted_count: 1,
            updated_count: 0,
            snapshotted_count: 0,
            error_count: 0,
            error_messages: [],
          },
        ],
        error: null,
      };
    throw new Error(`Unexpected RPC: ${name}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function run(action: 'create' | 'edit', config: Record<string, unknown>, viaMcp = false) {
  fs.writeFileSync(configPath, JSON.stringify(config));
  const args =
    action === 'create'
      ? {
          name: 'Policy test',
          source: 'source',
          project: 'project',
          config_file: configPath,
          objects_file: objectsPath,
        }
      : { identifier: 'pipeline', config_file: configPath };
  const argv = viaMcp
    ? buildSupaflowArgv(`pipelines_${action}`, args)
    : action === 'create'
      ? [
          'pipelines',
          'create',
          '--name',
          'Policy test',
          '--source',
          'source',
          '--project',
          'project',
          '--config',
          configPath,
          '--objects',
          objectsPath,
        ]
      : ['pipelines', 'edit', 'pipeline', '--config', configPath];
  const program = new Command().exitOverride().option('--json');
  registerPipelinesCommands(program);
  await program.parseAsync(['node', 'test', ...argv]);
}

describe('keyless policy command persistence', () => {
  it.each([undefined, null, 'UUID', 'ROW_HASH'])(
    'creates with %s through CLI and MCP arguments',
    async (policy) => {
      for (const viaMcp of [false, true]) {
        const config = { keyless_object_handling: policy, load_mode: 'APPEND' };
        await run(
          'create',
          viaMcp ? applyConfigPatch({}, config) : config,
          viaMcp,
        );
        expect(mocks.insert).toHaveBeenLastCalledWith(
          expect.objectContaining({
            configs: expect.objectContaining({
              keyless_object_handling: policy ?? 'UUID',
              load_mode: 'APPEND',
            }),
          }),
        );
      }
    },
  );

  it('defaults an ordinary create without the field to UUID', async () => {
    await run('create', {});
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        configs: expect.objectContaining({ keyless_object_handling: 'UUID' }),
      }),
    );
  });

  it.each(['create', 'edit'] as const)(
    '%s rejects invalid and unsupported policies before writing',
    async (action) => {
      for (const policy of ['APPEND', false, '', 'ROW_HASH']) {
        capabilities = { supports_row_hash_merge: { supported: false } };
        await expect(run(action, { keyless_object_handling: policy })).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
      }
    },
  );

  it.each([null, 'UUID', 'ROW_HASH'])(
    'edits %s through CLI and MCP without replacing other config or creating a job',
    async (policy) => {
      for (const viaMcp of [false, true]) {
        await run('edit', { keyless_object_handling: policy }, viaMcp);
        expect(mocks.update).toHaveBeenLastCalledWith(
          expect.objectContaining({
            configs: { ...currentConfig, keyless_object_handling: policy ?? 'UUID' },
          }),
        );
        expect(mocks.rpc).not.toHaveBeenCalled();
      }
    },
  );

  it('preserves an omitted policy on unrelated edits without fetching capabilities', async () => {
    await run('edit', { error_handling: 'STRICT' });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ configs: { ...currentConfig, error_handling: 'STRICT' } }),
    );
    expect(mocks.from).not.toHaveBeenCalledWith('datasources_with_access');
  });

  it('rejects a hash-policy edit if destination capabilities cannot be read', async () => {
    destinationError = true;
    await expect(run('edit', { keyless_object_handling: 'ROW_HASH' })).rejects.toMatchObject({
      code: 'API_ERROR',
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
