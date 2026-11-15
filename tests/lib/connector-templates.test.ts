import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  renderCustomSourceTemplate,
  renderApiSourceTemplate,
  renderSqlSourceTemplate,
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

function inspect(template: { files: Record<string, string> }, allowRuntime = false) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-I',
        '-c',
        `import ast, json, sys, tomllib
request = json.load(sys.stdin)
files = request['files']
project = tomllib.loads(files['pyproject.toml'])
for name, text in files.items():
    assert not name.startswith('/') and '..' not in name.split('/')
    if name.endswith('.py'):
        tree = ast.parse(text, filename=name)
        for node in ast.walk(tree):
            modules = [item.name for item in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) else []
            blocked = {'supaflow_dlt_runtime', 'supaflow_python_runtime', 'supaflow_connector_cli', 'supaflow_connector_toolchain'}
            if not request['allowRuntime']: blocked.add('dlt')
            assert not blocked & {module.split('.')[0] for module in modules}
connector, = [value for name, value in files.items() if name.endswith('/connector.py')]
tree = ast.parse(connector)
definition = next(node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'ConnectorDefinition')
assert 'connector_name' in {item.arg for item in definition.keywords}
assert not {'connector_type', 'type', 'version', 'group_id', 'entrypoint'} & {item.arg for item in definition.keywords}
flags = {item.arg: ast.literal_eval(item.value) for item in definition.keywords if item.arg in {'use_full_normalize', 'jsonl_certified'}}
api = {}
if request['allowRuntime']:
    imports = {node.module: sorted(item.name for item in node.names) for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert any(item.arg == 'resources' and isinstance(item.value, ast.Name) and item.value.id == 'RESOURCES' for item in definition.keywords)
    schemas, = [value for name, value in files.items() if name.endswith('/schemas.py')]
    resource, = [node for node in ast.walk(ast.parse(schemas)) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'ConnectorResource']
    properties = [{item.arg: ast.literal_eval(item.value) for item in node.keywords} for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'ConnectorProperty']
    api = {'imports': imports, 'properties': properties, 'resource': {item.arg: ast.literal_eval(item.value) for item in resource.keywords}}

print(json.dumps({'project': project, 'displayName': ast.literal_eval(definition.args[0]), 'connectorName': ast.literal_eval(next(item.value for item in definition.keywords if item.arg == 'connector_name')), 'flags': flags, 'api': api}))
`,
      ],
      { input: JSON.stringify({ files: template.files, allowRuntime }), encoding: 'utf8' },
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

describe('API source template data', () => {
  it('pins the selected runtime and keeps current adapter normalization flags', () => {
    const template = renderApiSourceTemplate({ ...input, runtimeVersion: '0.1.0' });
    expect(template.templateId).toBe('api-source');
    const { project, connectorName, flags, api } = inspect(template, true);
    expect(connectorName).toBe(input.connectorName);
    expect(project.project.dependencies).toEqual([
      `supaflow-python-sdk==${input.sdkVersion}`,
      'supaflow-connector-runtime==0.1.0',
    ]);
    expect(project.tool.supaflow.connector).toEqual({
      template: 'api-source',
      group_id: input.groupId,
    });
    expect(flags).toEqual({ use_full_normalize: true, jsonl_certified: true });
    expect(api.imports).toEqual({
      supaflow_connector: ['ConnectorDefinition', 'SupaflowConnector'],
      schemas: ['RESOURCES'],
      source: ['create_source'],
    });
    expect(api.resource).toEqual({
      name: 'records',
      mode: 'full_refresh',
      primary_key: 'id',
      static_fields: [['id', 'text']],
      schema_strategy: 'static_only',
    });
    expect(Object.keys(template.files)).toHaveLength(9);
  });

  it('requires an explicit selected runtime and escapes author text', () => {
    expect(() => renderApiSourceTemplate({ ...input, runtimeVersion: '' })).toThrow(
      'exact selected runtime',
    );
    const displayName = 'API "quoted"\nnot executable';
    expect(
      inspect(renderApiSourceTemplate({ ...input, displayName, runtimeVersion: '0.1.0' }), true)
        .displayName,
    ).toBe(displayName);
  });
});

describe('SQL source template data', () => {
  it('declares the SQL extra, encrypted URL and existing public source adapter', () => {
    const template = renderSqlSourceTemplate({ ...input, runtimeVersion: '0.1.0' });
    expect(template.templateId).toBe('sql-source');
    const { project, api, flags } = inspect(template, true);
    expect(project.project.dependencies).toEqual([
      `supaflow-python-sdk==${input.sdkVersion}`,
      'supaflow-connector-runtime==0.1.0',
      'dlt[sql_database]',
    ]);
    expect(project.tool.supaflow.connector.template).toBe('sql-source');
    expect(api.imports.supaflow_connector).toEqual([
      'ConnectorDefinition',
      'ConnectorProperty',
      'SupaflowConnector',
    ]);
    expect(api.properties).toEqual([
      {
        name: 'connectionUrl',
        label: 'Connection URL',
        type: 'STRING',
        description: 'SQLAlchemy connection URL; provide credentials at runtime',
        required: true,
        encrypted: true,
        sensitive: true,
      },
    ]);
    expect(api.resource.name).toBe('records');
    expect(flags).toEqual({ use_full_normalize: true, jsonl_certified: true });
    expect(template.files['src/supaflow_connector_acme_records/source.py']).toContain(
      'from dlt.sources.sql_database import sql_database',
    );
    expect(template.files['src/supaflow_connector_acme_records/source.py']).not.toContain(
      'example-1',
    );
    expect(Object.keys(template.files)).toHaveLength(9);
  });

  it('retains selected-runtime validation and safe display-name quoting', () => {
    expect(() => renderSqlSourceTemplate({ ...input, runtimeVersion: '' })).toThrow(
      'exact selected runtime',
    );
    const displayName = 'SQL "quoted"\nnot executable';
    expect(
      inspect(renderSqlSourceTemplate({ ...input, displayName, runtimeVersion: '0.1.0' }), true)
        .displayName,
    ).toBe(displayName);
  });
});
