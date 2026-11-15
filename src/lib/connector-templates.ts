/**
 * SDK/testkit versions are exact canonical versions from selected wheel metadata,
 * never PEP 508 requirements or marker fragments. Init must validate this
 * selection and the rendered project through Python before publishing staging.
 */
export interface CustomSourceTemplateInput {
  connectorName: string;
  displayName: string;
  groupId: string;
  version: string;
  requiresPython: string;
  sdkVersion: string;
  testkitVersion: string;
}

const TEMPLATE_ID = 'custom-source';

/** Pure project data; init owns staging, locks, canonical manifest and provenance. */
export function renderCustomSourceTemplate(input: CustomSourceTemplateInput): {
  templateId: typeof TEMPLATE_ID;
  templateVersion: 1;
  files: Record<string, string>;
} {
  const fields = [
    'connectorName',
    'displayName',
    'groupId',
    'version',
    'requiresPython',
    'sdkVersion',
    'testkitVersion',
  ] as const;
  if (
    !/^[A-Z_][A-Z0-9_]*$/.test(input.connectorName) ||
    fields.some((key) => typeof input[key] !== 'string' || !input[key].trim())
  ) {
    throw new Error('Provide a canonical local connector name and nonempty template metadata');
  }
  const localName = input.connectorName.toLowerCase();
  const moduleName = `supaflow_connector_${localName}`;
  const distribution = `supaflow-connector-${localName.replaceAll('_', '-')}-python`;
  // Quoting keeps author text inside string syntax. Python owns semantic
  // Unicode/version/range validation before a staged project is published.
  const literal = JSON.stringify;
  return {
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    files: {
      '.gitignore':
        '.venv/\n__pycache__/\n.pytest_cache/\nbuild/\ndist/\n*.egg-info/\n.supaflow/state/\n.supaflow-manifest-*/\n.env*\n!.env.example\n',
      'README.md': `# Custom source connector

This template starts with one local example record. Replace source.py with your
source access, update schemas.py, and update expected rows in
tests/connector_fixture.py. Keep credentials
out of source files and fixtures. The tests use local sample data and never
connect to a live service.

pyproject.toml owns package identity, dependencies and Python compatibility.
The definition declares only its local connector name; the toolchain derives
the namespaced type from the group. Group ownership is checked at deployment.

After initialization, use supaflow connectors check, test and build. Ordinary
checks and builds reject stale locks; use the explicit lock command after a
dependency change. A successful local build is not deployment approval.
`,
      'pyproject.toml': `[build-system]
requires = ["setuptools>=77"]
build-backend = "setuptools.build_meta"

[project]
name = ${literal(distribution)}
version = ${literal(input.version)}
requires-python = ${literal(input.requiresPython)}
dependencies = [${literal(`supaflow-python-sdk==${input.sdkVersion}`)}]

[project.entry-points."supaflow.connectors"]
${localName} = ${literal(`${moduleName}.connector:Connector`)}

[tool.supaflow.connector]
template = ${literal(TEMPLATE_ID)}
group_id = ${literal(input.groupId)}

[dependency-groups]
dev = ["pytest>=8", ${literal(`supaflow-connector-testkit==${input.testkitVersion}`)}]

[tool.setuptools.packages.find]
where = ["src"]
namespaces = false

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
`,
      [`src/${moduleName}/__init__.py`]: '',
      [`src/${moduleName}/source.py`]: `"""Replace this finite example with your source's record iterator."""


def records():
    yield {"id": "example-1"}
`,
      [`src/${moduleName}/schemas.py`]: `from supaflow_python_sdk.models import SchemaFieldInfo, SchemaObjectInfo


def records_object():
    return SchemaObjectInfo(
        name="records", type="TABLE", fully_qualified_name="records", path_segments=("records",),
        incremental_strategy="UNSUPPORTED", identity_strategy="SOURCE_PRIMARY_KEY",
        fields=[SchemaFieldInfo(
            "id", "STRING", original_data_type="text", cursor_capable=False,
            primary_key_capable=True, source_primary_key=True,
        )],
    )
`,
      [`src/${moduleName}/connector.py`]: `from supaflow_python_sdk import BaseConnector, ConnectorDefinition
from supaflow_python_sdk.errors import ErrorType, fail
from supaflow_python_sdk.models import InitResult, ReadResult, ReadStatistics, SchemaResult

from .schemas import records_object
from .source import records


class Connector(BaseConnector):
    DEFINITION = ConnectorDefinition(
        ${literal(input.displayName)}, connector_name=${literal(input.connectorName)},
        vendor=${literal(input.displayName)}, description="A custom source connector",
        icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
    )

    def init(self, request):
        return InitResult(product_name=${literal(input.displayName)}, product_version="1")

    def schema(self, request):
        return SchemaResult(objects=[records_object()])

    def read(self, request):
        if request.object_metadata is None or request.object_metadata.name != "records":
            fail(ErrorType.CONFIGURATION, "Select the records object")
        if request.record_emitter is None:
            fail(ErrorType.CONFIGURATION, "A record emitter is required")
        for record in records():
            request.record_emitter.emit(record)
        emitted = request.record_emitter.complete()
        return ReadResult(status="COMPLETED", statistics=ReadStatistics(records_read=emitted.records_emitted))

    def stage(self, request):
        fail(ErrorType.UNSUPPORTED, "This connector supports source operations only")
`,
      'tests/connector_fixture.py': `from supaflow_python_testkit import ConnectorFixture

CONNECTOR_FIXTURE = ConnectorFixture(
    config={}, sample_records_by_resource={"records": [{"id": "example-1"}]},
)
`,
      'tests/test_connector.py': `from ${moduleName}.connector import Connector
from supaflow_python_testkit import ConnectorHarness
from connector_fixture import CONNECTOR_FIXTURE


def test_source_lifecycle(tmp_path):
    harness = ConnectorHarness(Connector, dict(CONNECTOR_FIXTURE.config), work_dir=str(tmp_path))
    try:
        assert harness.run_init().product_name == ${literal(input.displayName)}
        schema = harness.run_schema()
        assert [obj.name for obj in schema.objects] == ["records"]
        result, emitted = harness.run_read("records")
        assert result.status == "COMPLETED"
        assert result.statistics.records_read == len(emitted)
        assert emitted == list(CONNECTOR_FIXTURE.sample_records_by_resource["records"])
    finally:
        harness.close()
`,
    },
  };
}
