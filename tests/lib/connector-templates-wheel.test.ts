import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { initializeConnectorProject } from '../../src/lib/connector-init.js';
import {
  renderCustomSourceTemplate,
  renderApiSourceTemplate,
  renderSqlSourceTemplate,
} from '../../src/lib/connector-templates.js';

const sdkWheel = process.env.SUPAFLOW_TEST_SDK_WHEEL;
const testkitWheel = process.env.SUPAFLOW_TEST_TESTKIT_WHEEL;
const runtimeWheel = process.env.SUPAFLOW_TEST_RUNTIME_WHEEL;
const runtimeWheelhouse = process.env.SUPAFLOW_TEST_RUNTIME_WHEELHOUSE;

function publicWheelMetadata(paths: string[]): Array<{ name: string; version: string }> {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-I',
        '-c',
        `import email.parser,json,sys,zipfile
values=[]
for filename in sys.argv[1:]:
    with zipfile.ZipFile(filename) as archive:
        path,=[name for name in archive.namelist() if name.endswith('.dist-info/METADATA')]
        item=email.parser.Parser().parsestr(archive.read(path).decode('utf-8'))
        values.append({'name':item['Name'],'version':item['Version']})
print(json.dumps(values))
`,
        ...paths,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    ),
  );
}

// SDK/testkit publication and packed init are separate gates. This additional
// offline gate accepts exact locally built public wheels; it never fetches.
it.skipIf(!sdkWheel && !testkitWheel)(
  'runs generated lifecycle tests using only installed public SDK/testkit wheels',
  async () => {
    expect(
      sdkWheel && testkitWheel,
      'Provide both public wheel paths for the offline gate',
    ).toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), 'supaflow-template-wheel-'));
    try {
      const metadata = publicWheelMetadata([sdkWheel!, testkitWheel!]);
      expect(metadata[0].name).toBe('supaflow-python-sdk');
      expect(metadata[1].name).toBe('supaflow-connector-testkit');
      const template = renderCustomSourceTemplate({
        connectorName: 'ACME_RECORDS',
        displayName: 'Acme',
        groupId: 'com.acme',
        version: '1.2.3.dev1',
        requiresPython: '>=3.11,<3.15',
        sdkVersion: metadata[0].version,
        testkitVersion: metadata[1].version,
      });
      const project = join(root, 'project');
      const environment = join(root, 'environment');
      execFileSync('python3', ['-m', 'venv', environment], { timeout: 60_000 });
      const python = join(
        environment,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      );
      execFileSync(
        python,
        [
          '-I',
          '-m',
          'pip',
          '--isolated',
          'install',
          '--no-index',
          '--no-deps',
          '--disable-pip-version-check',
          '--no-cache-dir',
          sdkWheel!,
          testkitWheel!,
        ],
        { cwd: root, timeout: 60_000 },
      );
      let output = '';
      await initializeConnectorProject(project, template, '0.1.0', async (staging) => {
        expect(existsSync(project)).toBe(false);
        output = execFileSync(
          python,
          [
            '-I',
            '-c',
            `import importlib, importlib.util, json, pathlib, sys, tomllib
root = pathlib.Path(sys.argv[1]).resolve()
project = pathlib.Path(sys.argv[2]).resolve()
import supaflow_python_sdk as sdk
import supaflow_python_testkit as testkit
assert pathlib.Path(sdk.__file__).resolve().is_relative_to(root)
assert pathlib.Path(testkit.__file__).resolve().is_relative_to(root)
for name in ('dlt', 'supaflow_dlt_runtime', 'supaflow_python_runtime', 'supaflow_connector_toolchain', 'supaflow_connector_cli'):
    assert importlib.util.find_spec(name) is None, name
sys.path[:0] = [str(project / 'src'), str(project / 'tests')]
from test_connector import test_source_lifecycle
work = root / 'work'
work.mkdir()
test_source_lifecycle(work)
metadata = tomllib.loads((project / 'pyproject.toml').read_text())
entry, = metadata['project']['entry-points']['supaflow.connectors'].values()
module, symbol = entry.split(':')
Connector = getattr(importlib.import_module(module), symbol)
bound = Connector.with_package_metadata(sdk.ConnectorPackageMetadata('1.2.3.dev1', 'com.acme', entry))
assert Connector.DEFINITION.type is None
assert bound.get_definition().type == 'COM_ACME__ACME_RECORDS'
assert bound.generated_manifest_dict()['connector']['artifact_id'] == metadata['project']['name']
from supaflow_python_sdk.connector_identity import parse_customer_connector_type
for case in json.loads(sys.argv[3]):
    value = tomllib.loads(case['pyproject'])
    definition = sdk.ConnectorDefinition('Example', connector_name=case['name'], description='example', icon='<svg/>')
    resolved = definition.with_package_metadata(sdk.ConnectorPackageMetadata(value['project']['version'], value['tool']['supaflow']['connector']['group_id'], next(iter(value['project']['entry-points']['supaflow.connectors'].values()))))
    assert resolved.artifact() == value['project']['name']
    assert parse_customer_connector_type(resolved.type) == ('com.acme', case['name'])
print(json.dumps({'lifecycle': 'passed', 'type': bound.get_definition().type}))
`,
            environment,
            staging,
            JSON.stringify(
              ['ACME__X', 'ACME_X', 'ACME_', 'ACME', '_LEADING'].map((name) => ({
                name,
                pyproject: renderCustomSourceTemplate({
                  connectorName: name,
                  displayName: 'Example',
                  groupId: 'com.acme',
                  version: '1.2.3.dev1',
                  requiresPython: '>=3.11,<3.15',
                  sdkVersion: metadata[0].version,
                  testkitVersion: metadata[1].version,
                }).files['pyproject.toml'],
              })),
            ),
          ],
          { cwd: root, timeout: 30_000, encoding: 'utf8' },
        );
      });
      expect(JSON.parse(output)).toEqual({
        lifecycle: 'passed',
        type: 'COM_ACME__ACME_RECORDS',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);

// Optional local runtime gate: CI omits these exact wheel inputs, never fetches.
it.skipIf(!runtimeWheel && !runtimeWheelhouse).each([
  { id: 'API', name: 'ACME_API', render: renderApiSourceTemplate, sql: false },
  { id: 'SQL', name: 'ACME_SQL', render: renderSqlSourceTemplate, sql: true },
])(
  'runs the $id template with exact public wheels and offline runtime dependencies',
  async (variant) => {
    expect(
      sdkWheel && testkitWheel && runtimeWheel && runtimeWheelhouse,
      'Provide SDK/testkit/runtime wheels and the runtime dependency wheelhouse',
    ).toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), 'supaflow-api-template-wheel-'));
    try {
      const metadata = publicWheelMetadata([sdkWheel!, testkitWheel!, runtimeWheel!]);
      expect(metadata.map((item) => item.name)).toEqual([
        'supaflow-python-sdk',
        'supaflow-connector-testkit',
        'supaflow-connector-runtime',
      ]);
      const template = variant.render({
        connectorName: variant.name,
        displayName: `Acme ${variant.id}`,
        groupId: 'com.acme',
        version: '1.2.3.dev1',
        requiresPython: '>=3.11,<3.15',
        sdkVersion: metadata[0].version,
        testkitVersion: metadata[1].version,
        runtimeVersion: metadata[2].version,
      });
      const project = join(root, 'project');
      const environment = join(root, 'environment');
      execFileSync('python3', ['-m', 'venv', environment], { timeout: 60_000 });
      const python = join(
        environment,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      );
      execFileSync(
        python,
        [
          '-I',
          '-m',
          'pip',
          '--isolated',
          'install',
          '--no-index',
          '--find-links',
          runtimeWheelhouse!,
          '--no-cache-dir',
          '--disable-pip-version-check',
          sdkWheel!,
          testkitWheel!,
          runtimeWheel!,
          ...(variant.sql ? ['dlt[sql_database]'] : []),
        ],
        { cwd: root, timeout: 60_000 },
      );
      execFileSync(python, ['-I', '-m', 'pip', '--isolated', 'check'], {
        cwd: root,
        timeout: 30_000,
      });
      let output = '';
      await initializeConnectorProject(project, template, '0.1.0', async (staging) => {
        expect(existsSync(project)).toBe(false);
        output = execFileSync(
          python,
          [
            '-I',
            '-c',
            `import importlib,importlib.util,json,pathlib,sys,tomllib
root=pathlib.Path(sys.argv[1]).resolve();project=pathlib.Path(sys.argv[2]).resolve()
import supaflow_connector,supaflow_python_sdk,supaflow_python_testkit
for module in (supaflow_connector,supaflow_python_sdk,supaflow_python_testkit):
    assert pathlib.Path(module.__file__).resolve().is_relative_to(root)
for name in ('supaflow_python_runtime','supaflow_connector_toolchain','supaflow_connector_cli'):
    assert importlib.util.find_spec(name) is None,name
sys.path[:0]=[str(project/'src'),str(project/'tests')]
import test_connector
for name in json.loads(sys.argv[3]):
    work=root/name;work.mkdir();getattr(test_connector,name)(work)
metadata=tomllib.loads((project/'pyproject.toml').read_text())
entry,=metadata['project']['entry-points']['supaflow.connectors'].values()
module,symbol=entry.split(':');Connector=getattr(importlib.import_module(module),symbol)
from supaflow_python_sdk import ConnectorPackageMetadata
bound=Connector.with_package_metadata(ConnectorPackageMetadata('1.2.3.dev1','com.acme',entry))
assert Connector.DEFINITION.type is None
assert bound.get_definition().type==sys.argv[4]
assert bound.get_definition().use_full_normalize and bound.get_definition().jsonl_certified
print(json.dumps({'lifecycle':'passed','type':bound.get_definition().type}))
`,
            environment,
            staging,
            JSON.stringify(
              variant.sql
                ? ['test_source_lifecycle', 'test_missing_connection_url']
                : ['test_source_lifecycle'],
            ),
            `COM_ACME__${variant.name}`,
          ],
          {
            cwd: root,
            timeout: 30_000,
            encoding: 'utf8',
            env: { ...process.env, DLT_TELEMETRY: '0', RUNTIME__DLTHUB_TELEMETRY: 'false' },
          },
        );
      });
      const lastLine = output.trim().split('\n').at(-1)!;
      expect(JSON.parse(lastLine)).toEqual({
        lifecycle: 'passed',
        type: `COM_ACME__${variant.name}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
