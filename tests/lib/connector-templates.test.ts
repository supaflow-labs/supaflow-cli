import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  renderCustomSourceTemplate,
  type CustomSourceTemplateInput,
} from '../../src/lib/connector-templates.js';

const input: CustomSourceTemplateInput = {
  connectorName: 'ACME_RECORDS',
  displayName: 'Acme records',
  groupId: 'com.acme',
  version: '1.2.3.dev1',
  requiresPython: '>=3.11,<3.15',
  sdkVersion: '1.0.73.dev0',
  testkitVersion: '0.1.0',
};

function inspect(template: ReturnType<typeof renderCustomSourceTemplate>) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-I',
        '-c',
        `import ast, json, sys, tomllib
files = json.load(sys.stdin)
project = tomllib.loads(files['pyproject.toml'])
for name, text in files.items():
    assert not name.startswith('/') and '..' not in name.split('/')
    if name.endswith('.py'):
        tree = ast.parse(text, filename=name)
        for node in ast.walk(tree):
            modules = [item.name for item in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) else []
            assert not {'dlt', 'supaflow_dlt_runtime', 'supaflow_python_runtime', 'supaflow_connector_cli', 'supaflow_connector_toolchain'} & {module.split('.')[0] for module in modules}
connector, = [value for name, value in files.items() if name.endswith('/connector.py')]
tree = ast.parse(connector)
definition = next(node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'ConnectorDefinition')
assert 'connector_name' in {item.arg for item in definition.keywords}
assert not {'connector_type', 'type', 'version', 'group_id', 'entrypoint'} & {item.arg for item in definition.keywords}
print(json.dumps({'project': project, 'displayName': ast.literal_eval(definition.args[0]), 'connectorName': ast.literal_eval(next(item.value for item in definition.keywords if item.arg == 'connector_name'))}))
`,
      ],
      { input: JSON.stringify(template.files), encoding: 'utf8' },
    ),
  );
}

describe('custom source template data', () => {
  it('renders conventional src metadata and valid Python without writing a project', () => {
    const template = renderCustomSourceTemplate(input);
    expect(template.templateId).toBe('custom-source');
    expect(template.templateVersion).toBe(1);
    const { project } = inspect(template);
    expect(project.project).toMatchObject({
      name: 'supaflow-connector-acme-records-python',
      version: input.version,
      'requires-python': input.requiresPython,
      dependencies: [`supaflow-python-sdk==${input.sdkVersion}`],
      'entry-points': {
        'supaflow.connectors': {
          acme_records: 'supaflow_connector_acme_records.connector:Connector',
        },
      },
    });
    expect(project.tool.supaflow.connector).toEqual({
      template: 'custom-source',
      group_id: input.groupId,
    });
    expect(project['dependency-groups'].dev).toContain(
      `supaflow-connector-testkit==${input.testkitVersion}`,
    );
    expect(Object.keys(template.files)).toHaveLength(9);
    expect(Object.keys(template.files)).not.toContain('runtime.lock');
    expect(Object.keys(template.files)).not.toContain('connector.yaml');
  });

  it('escapes quotes, newlines and code-like display text as a literal', () => {
    const displayName = 'Acme "quoted"\n__import__("os").system("must never execute")';
    expect(inspect(renderCustomSourceTemplate({ ...input, displayName })).displayName).toBe(
      displayName,
    );
  });

  it.each(['ACME__X', 'ACME_', '_LEADING'])(
    'preserves SDK-supported underscore names %s',
    (connectorName) => {
      expect(inspect(renderCustomSourceTemplate({ ...input, connectorName })).connectorName).toBe(
        connectorName,
      );
    },
  );

  it.each(['../escape', 'acme', 'ACME-RECORDS', 'A/B', 'A\\B', ''])(
    'rejects unsafe local names %j',
    (connectorName) => {
      expect(() => renderCustomSourceTemplate({ ...input, connectorName })).toThrow(
        'canonical local connector name',
      );
    },
  );

  it('requires explicit nonempty selected metadata and renders deterministically', () => {
    expect(() => renderCustomSourceTemplate({ ...input, sdkVersion: '' })).toThrow(
      'nonempty template metadata',
    );
    expect(renderCustomSourceTemplate(input)).toEqual(renderCustomSourceTemplate(input));
  });
});
