import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/connector-authoring-feature.js', () => ({ CONNECTOR_AUTHORING_ENABLED: true }));
import { registerConnectorsCommands } from '../src/commands/connectors.js';
import { TOOLS, buildSupaflowArgv, listToolDefinitions } from '../src/mcp/server.js';

const authoring = TOOLS.filter(
  (tool) => tool.name.startsWith('connectors_') && tool.name !== 'connectors_list',
);
describe('inactive authoring MCP wrappers in a test-enabled build', () => {
  it('matches the authoring CLI leaf surface without activating production', () => {
    const program = new Command();
    registerConnectorsCommands(program);
    const names: string[] = [];
    function leaves(command: Command, prefix: string[]) {
      for (const child of command.commands) {
        const name = [...prefix, child.name()];
        if (child.commands.length) leaves(child, name);
        else names.push(name.join('_'));
      }
    }
    leaves(program, []);
    expect(authoring).toHaveLength(8);
    expect(authoring.map((tool) => tool.name).sort()).toEqual(
      names.filter((name) => name !== 'connectors_list').sort(),
    );
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(61);
  });

  it.each([
    ['connectors_check', ['check']],
    ['connectors_doctor', ['doctor']],
    ['connectors_manifest_check', ['manifest', 'check']],
    ['connectors_manifest_generate', ['manifest', 'generate']],
  ])('maps %s to the existing JSON CLI boundary', (name, command) => {
    expect(
      buildSupaflowArgv(name as string, {
        project_dir: '/tmp/project ; $(literal)',
        offline: true,
      }),
    ).toEqual([
      'connectors',
      ...command,
      '--project',
      '/tmp/project ; $(literal)',
      '--offline',
      '--json',
    ]);
    expect(buildSupaflowArgv(name as string)).toEqual(['connectors', ...command, '--json']);
  });

  it('forwards init identity and optional authoring inputs without interpreting them', () => {
    expect(
      buildSupaflowArgv('connectors_init', {
        directory: '/tmp/new project',
        name: 'ACME',
        group: 'io.supaflow',
        template: 'custom-source',
        display_name: 'Acme records',
        connector_version: '1.2.3.dev1',
        requires_python: '>=3.14,<3.15',
        offline: true,
      }),
    ).toEqual([
      'connectors',
      'init',
      '/tmp/new project',
      '--name',
      'ACME',
      '--group',
      'io.supaflow',
      '--template',
      'custom-source',
      '--display-name',
      'Acme records',
      '--connector-version',
      '1.2.3.dev1',
      '--requires-python',
      '>=3.14,<3.15',
      '--offline',
      '--json',
    ]);
  });

  it('keeps live tests explicit and default build publication distinct from --output', () => {
    expect(buildSupaflowArgv('connectors_test', { live: false })).toEqual([
      'connectors',
      'test',
      '--json',
    ]);
    expect(buildSupaflowArgv('connectors_test', { live: true })).toEqual([
      'connectors',
      'test',
      '--live',
      '--json',
    ]);
    expect(buildSupaflowArgv('connectors_build', {})).toEqual(['connectors', 'build', '--json']);
    expect(buildSupaflowArgv('connectors_build', { output: 'fresh artifact' })).toEqual([
      'connectors',
      'build',
      '--output',
      'fresh artifact',
      '--json',
    ]);
  });

  it('forwards lock modes and leaves conflict validation to the CLI', () => {
    expect(buildSupaflowArgv('connectors_lock', { check: true, offline: true })).toEqual([
      'connectors',
      'lock',
      '--offline',
      '--check',
      '--json',
    ]);
    expect(buildSupaflowArgv('connectors_lock', { upgrade_runtime: true, to: '1.2.4' })).toEqual([
      'connectors',
      'lock',
      '--upgrade-runtime',
      '--to',
      '1.2.4',
      '--json',
    ]);
  });

  it('closes input schemas and marks preparation commands as writes', () => {
    const definitions = listToolDefinitions().filter((tool) =>
      authoring.some((spec) => spec.name === tool.name),
    );
    for (const tool of definitions) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations.readOnlyHint).toBe(tool.name === 'connectors_doctor');
      expect(tool.annotations.destructiveHint).toBe(false);
    }
    expect(
      definitions.find((tool) => tool.name === 'connectors_init')!.inputSchema.required,
    ).toEqual(['directory', 'name', 'group']);
  });
});
