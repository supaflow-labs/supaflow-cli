import { describe, it, expect } from 'vitest';
import {
  TOOLS,
  listToolDefinitions,
  buildSupaflowArgv,
  buildPipelineCreateFromPlanArgv,
  normalizeObjectPreviewLimit,
  applyConfigPatch,
  applyObjectSelection,
  validatePlanBinding,
  validatePlanWorkspace,
} from '../src/mcp/server.js';

const defByName = new Map(listToolDefinitions().map((d) => [d.name, d]));

describe('MCP tool surface', () => {
  it('exposes 49 unique tools', () => {
    const names = TOOLS.map((t) => t.name);
    expect(TOOLS.length).toBe(49);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the guided pair and excludes auth/encrypt tools', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('pipelines_prepare_create');
    expect(names).toContain('pipelines_create_from_plan');
    expect(names).not.toContain('auth_login');
    expect(names).not.toContain('auth_logout');
    expect(names).not.toContain('encrypt');
  });

  it('closes every input schema', () => {
    expect(
      listToolDefinitions().every(
        (t) => t.inputSchema && (t.inputSchema as any).additionalProperties === false,
      ),
    ).toBe(true);
  });
});

describe('annotations', () => {
  it('marks reads read-only and deletes destructive', () => {
    expect(defByName.get('auth_status')!.annotations.readOnlyHint).toBe(true);
    expect(defByName.get('pipelines_prepare_create')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('pipelines_create_from_plan')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('datasources_get')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('datasources_catalog')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('pipelines_create')!.annotations.readOnlyHint).toBe(false);
    expect(defByName.get('docs')!.annotations.readOnlyHint).toBe(false);
    // Derive from the table so a new destructive tool cannot escape the
    // contract: destructiveHint annotation AND the explicit
    // workflow-confirmation wording in the description.
    const destructive = TOOLS.filter((t) => t.destructive === true);
    const destructiveNames = destructive.map((t) => t.name);
    expect(destructiveNames).toEqual(
      expect.arrayContaining(['pipelines_delete', 'datasources_delete', 'schedules_delete', 'agent_remove']),
    );
    for (const t of destructive) {
      expect(defByName.get(t.name)!.annotations.destructiveHint).toBe(true);
      expect(t.description).toMatch(/explicit user confirmation/i);
    }
  });

  it('gives the guided tools output schemas', () => {
    expect(defByName.get('pipelines_prepare_create')!.outputSchema).toBeTruthy();
    expect(defByName.get('pipelines_create_from_plan')!.outputSchema).toBeTruthy();
  });
});

describe('guided defaults + delete safety wording', () => {
  it('defaults the prepare-create object preview to 1000', () => {
    const schema = defByName.get('pipelines_prepare_create')!.inputSchema as any;
    expect(schema.properties.object_preview_limit.default).toBe(1000);
  });

  it('requires skill-side confirmation in every destructive delete description (not the MCP prompt)', () => {
    for (const name of ['pipelines_delete', 'datasources_delete', 'schedules_delete']) {
      const desc = TOOLS.find((t) => t.name === name)!.description;
      expect(/skill must get explicit user confirmation before this tool call/i.test(desc)).toBe(true);
      expect(/MCP approval prompt is the confirmation/i.test(desc)).toBe(false);
    }
  });
});

describe('argv mapping', () => {
  // Assert the token array directly (tokens like "Test create" contain spaces, so a joined string is ambiguous).
  it('builds exact argv for representative tools', () => {
    expect(buildSupaflowArgv('datasources_get', { identifier: 'pg', output_file: '/tmp/pg.env' }))
      .toEqual(['datasources', 'get', 'pg', '--output', '/tmp/pg.env', '--json']);
    expect(buildSupaflowArgv('datasources_catalog', { identifier: 'pg', output_file: '/tmp/objects.json', refresh: true, with_fields: true }))
      .toEqual(['datasources', 'catalog', 'pg', '--output', '/tmp/objects.json', '--refresh', '--with-fields', '--json']);
    expect(buildSupaflowArgv('pipelines_schema_list', { identifier: 'orders', all: true, with_fields: true }))
      .toEqual(['pipelines', 'schema', 'list', 'orders', '--all', '--with-fields', '--json']);
    expect(buildSupaflowArgv('pipelines_delete', { identifier: 'orders' }))
      .toEqual(['pipelines', 'delete', 'orders', '--yes', '--json']);
    expect(buildSupaflowArgv('pipelines_sync', { identifier: 'orders', full_resync: true, reset_target: true }))
      .toEqual(['pipelines', 'sync', 'orders', '--full-resync', '--reset-target', '--json']);
    expect(buildSupaflowArgv('docs', { topic: 'postgres', output_file: '/tmp/postgres-docs.md', refresh: true }))
      .toEqual(['docs', 'postgres', '--output', '/tmp/postgres-docs.md', '--refresh']); // docs omits --json
  });

  it('always passes the prepared objects file in guided create', () => {
    expect(buildPipelineCreateFromPlanArgv({
      name: 'Orders', description: 'Test create', source: 'sql_server',
      project: 'postgres_project', configFile: '/tmp/config.json', objectsFile: '/tmp/objects.json',
    })).toEqual([
      'pipelines', 'create', '--name', 'Orders', '--source', 'sql_server', '--project', 'postgres_project',
      '--config', '/tmp/config.json', '--objects', '/tmp/objects.json', '--description', 'Test create', '--json',
    ]);
  });
});

describe('preview limit + selection + plan binding', () => {
  it('clamps the preview limit to 1..1000', () => {
    expect(normalizeObjectPreviewLimit(undefined)).toBe(1000);
    expect(normalizeObjectPreviewLimit(618)).toBe(618);
    expect(normalizeObjectPreviewLimit(5000)).toBe(1000);
    expect(normalizeObjectPreviewLimit(0)).toBe(1);
  });

  it('marks a changed pipeline_prefix as custom', () => {
    const patched = applyConfigPatch({ pipeline_prefix: 'postgres', ingestion_mode: 'incremental' }, { pipeline_prefix: 'analytics' });
    expect(patched.pipeline_prefix).toBe('analytics');
    expect(patched.is_custom_prefix).toBe(true);
  });

  it('keeps only included objects and rejects unknown ones', () => {
    const sel = applyObjectSelection(
      [{ fully_qualified_name: 'public.accounts' }, { fully_qualified_name: 'public.orders' }],
      { mode: 'subset', include: ['public.orders'] },
    );
    expect(sel.objects.map((o: any) => `${o.fully_qualified_name}:${o.selected}`)).toEqual(['public.accounts:false', 'public.orders:true']);
    expect(() => applyObjectSelection([{ fully_qualified_name: 'public.accounts' }], { mode: 'subset', include: ['public.missing'] })).toThrow();
  });

  it('enforces workspace/source/project plan binding', () => {
    const plan = { workspace: { id: 'ws_1' }, resolved: { source: { id: 'src_1' }, project: { id: 'proj_1' } } };
    expect(validatePlanBinding(plan, { workspace: { id: 'ws_1' }, source: { id: 'src_1' }, project: { id: 'proj_1' } })).toBe(true);
    expect(() => validatePlanWorkspace(plan, { id: 'ws_2' })).toThrow();
    expect(() => validatePlanBinding({ schema_version: 1 }, { workspace: { id: 'ws_1' }, source: { id: 'src_1' }, project: { id: 'proj_1' } })).toThrow();
  });
});
