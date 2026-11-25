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
const API_TEMPLATE_ID = 'api-source';
const SQL_TEMPLATE_ID = 'sql-source';

export interface ApiSourceTemplateInput extends CustomSourceTemplateInput {
  /** Exact canonical version of the selected public runtime wheel. */
  runtimeVersion: string;
}

function projectNames(connectorName: string) {
  const localName = connectorName.toLowerCase();
  return {
    localName,
    moduleName: `supaflow_connector_${localName}`,
    distribution: `supaflow-connector-${localName.replaceAll('_', '-')}-python`,
  };
}

function definitionIdentity(input: CustomSourceTemplateInput): string {
  // Source spelling only: the SDK validates the group and canonical type.
  const field =
    input.groupId === 'io.supaflow' || input.groupId.startsWith('io.supaflow.')
      ? 'connector_type'
      : 'connector_name';
  return `${field}=${JSON.stringify(input.connectorName)}`;
}

function projectMetadata(
  input: CustomSourceTemplateInput,
  templateId: string,
  runtimeVersion?: string,
  additionalDependencies: readonly string[] = [],
): string {
  const { localName, moduleName, distribution } = projectNames(input.connectorName);
  const dependencies = [`supaflow-python-sdk==${input.sdkVersion}`];
  if (runtimeVersion !== undefined)
    dependencies.push(`supaflow-connector-runtime==${runtimeVersion}`);
  dependencies.push(...additionalDependencies);
  return `[build-system]
requires = ["setuptools>=77"]
build-backend = "setuptools.build_meta"

[project]
name = ${JSON.stringify(distribution)}
version = ${JSON.stringify(input.version)}
requires-python = ${JSON.stringify(input.requiresPython)}
dependencies = ${JSON.stringify(dependencies)}

[project.entry-points."supaflow.connectors"]
${localName} = ${JSON.stringify(`${moduleName}.connector:Connector`)}

[tool.supaflow.connector]
template = ${JSON.stringify(templateId)}
group_id = ${JSON.stringify(input.groupId)}

[dependency-groups]
dev = ["pytest>=8", ${JSON.stringify(`supaflow-connector-testkit==${input.testkitVersion}`)}]

[tool.setuptools.packages.find]
where = ["src"]
namespaces = false

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
`;
}

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
  const { moduleName } = projectNames(input.connectorName);
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
the namespaced type from the group. Registration checks group ownership;
local deployment copies and prepares the built artifact.

After initialization, use supaflow connectors check, test and build. Ordinary
checks and builds reject stale locks; use the explicit lock command after a
dependency change. A successful local build is not deployment approval.
`,
      'pyproject.toml': projectMetadata(input, TEMPLATE_ID),
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
        ${literal(input.displayName)}, ${definitionIdentity(input)},
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

/** Runtime-backed source project data; public adapter owns normalization. */
export function renderApiSourceTemplate(input: ApiSourceTemplateInput): {
  templateId: typeof API_TEMPLATE_ID;
  templateVersion: 1;
  files: Record<string, string>;
} {
  if (typeof input.runtimeVersion !== 'string' || !input.runtimeVersion.trim()) {
    throw new Error('Provide the exact selected runtime version');
  }
  const base = renderCustomSourceTemplate(input);
  const { moduleName } = projectNames(input.connectorName);
  return {
    templateId: API_TEMPLATE_ID,
    templateVersion: 1,
    files: {
      ...base.files,
      'pyproject.toml': projectMetadata(input, API_TEMPLATE_ID, input.runtimeVersion),
      'README.md': `# API source connector

This template uses the public Supaflow source adapter and one finite example
resource. Replace source.py records(config) with source access, update schemas.py,
and update expected rows in tests/connector_fixture.py. Keep default unit tests
mocked as shown; live source tests must be separate and explicitly enabled.
Never put credentials in source or committed fixtures.

pyproject.toml owns version, group, entry point and dependency pins. The definition
declares its local name, resources and normalization flags. Package binding
derives its full connector type;
the control plane checks group ownership at deployment.

After initialization, use supaflow connectors check, test and build. Refresh
dependencies with the explicit lock command; ordinary checks/builds do not repair
locks or select another runtime. A local build does not grant deployment approval.
`,
      [`src/${moduleName}/schemas.py`]: `from supaflow_connector import ConnectorResource

RESOURCES = (
    ConnectorResource(
        name="records", mode="full_refresh", primary_key="id",
        static_fields=(("id", "text"),), schema_strategy="static_only",
    ),
)
`,
      [`src/${moduleName}/source.py`]: `"""Keep source acquisition here so unit tests can supply finite sample rows."""
import dlt


def records(config):
    yield {"id": "example-1"}


def create_source(resource_name, config):
    @dlt.source(name="example_source")
    def source():
        return dlt.resource(records(config), name=resource_name, primary_key="id")
    return source()
`,
      [`src/${moduleName}/connector.py`]: `from supaflow_connector import ConnectorDefinition, SupaflowConnector
from .schemas import RESOURCES
from .source import create_source


class Connector(SupaflowConnector):
    DEFINITION = ConnectorDefinition(
        ${JSON.stringify(input.displayName)}, ${definitionIdentity(input)},
        vendor=${JSON.stringify(input.displayName)}, description="An API source connector",
        icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
        resources=RESOURCES, use_full_normalize=True, jsonl_certified=True,
    )

    def _create_source(self, resource, **kwargs):
        return create_source(resource.name, self._config)
`,
      'tests/test_connector.py': `from copy import deepcopy
from pathlib import Path
import tomllib
from unittest.mock import patch

from ${moduleName}.connector import Connector
from ${moduleName} import source
from supaflow_python_sdk import ConnectorPackageMetadata
from supaflow_python_testkit import ConnectorHarness
from connector_fixture import CONNECTOR_FIXTURE


def test_source_lifecycle(tmp_path):
    metadata = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    entry, = metadata["project"]["entry-points"]["supaflow.connectors"].values()
    bound = Connector.with_package_metadata(ConnectorPackageMetadata(
        metadata["project"]["version"], metadata["tool"]["supaflow"]["connector"]["group_id"], entry,
    ))
    expected = list(CONNECTOR_FIXTURE.sample_records_by_resource["records"])
    with patch.object(source, "records", side_effect=lambda config: iter(deepcopy(expected))):
        harness = ConnectorHarness(bound, dict(CONNECTOR_FIXTURE.config), work_dir=str(tmp_path))
        try:
            assert harness.run_init().product_name == ${JSON.stringify(input.displayName)}
            schema = harness.run_schema()
            assert [obj.name for obj in schema.objects] == ["records"]
            result, emitted = harness.run_read("records")
            assert result.status == "COMPLETED"
            assert result.statistics.records_read == len(expected)
            actual = [{key: row[key] for key in sample} for row, sample in zip(emitted, expected, strict=True)]
            assert actual == expected
        finally:
            harness.close()
`,
    },
  };
}

/** SQL table source project data using dlt's maintained SQLAlchemy extra. */
export function renderSqlSourceTemplate(input: ApiSourceTemplateInput): {
  templateId: typeof SQL_TEMPLATE_ID;
  templateVersion: 1;
  files: Record<string, string>;
} {
  const base = renderApiSourceTemplate(input);
  const { moduleName } = projectNames(input.connectorName);
  return {
    templateId: SQL_TEMPLATE_ID,
    templateVersion: 1,
    files: {
      ...base.files,
      'pyproject.toml': projectMetadata(input, SQL_TEMPLATE_ID, input.runtimeVersion, [
        'dlt[sql_database]',
      ]),
      'README.md': `# SQL source connector

This template reads one records table through dlt's SQLAlchemy backend. Update
schemas.py, source.py and tests/connector_fixture.py for your source. Add its
database driver to pyproject.toml
and refresh locks explicitly; the SQL extra owns SQLAlchemy compatibility.
Provide connectionUrl at runtime, never in committed source or fixtures. Use a
read-only database account. Init validates that the URL is present; schema/read
perform the actual connection, so successful init alone is not a connectivity test.

The default test creates a disposable SQLite file under pytest's temporary
folder and compares exact fixture values through the real SQL source. It needs
no database service or credentials. Keep live-source tests separate and opt-in.

pyproject.toml owns version, group, entry point and selected public runtime pins.
After initialization, use supaflow connectors check, test and build. Ordinary
checks/builds do not repair locks. Local success is not deployment approval.
`,
      [`src/${moduleName}/source.py`]: `"""SQL source acquisition; test data and database setup belong in tests."""
from dlt.sources.sql_database import sql_database


def create_source(resource_name, config):
    return sql_database(
        credentials=config["connectionUrl"], table_names=[resource_name],
        backend="sqlalchemy", reflection_level="full_with_precision",
    )
`,
      [`src/${moduleName}/connector.py`]: `from supaflow_connector import ConnectorDefinition, ConnectorProperty, SupaflowConnector
from supaflow_python_sdk.errors import ErrorType, fail
from .schemas import RESOURCES
from .source import create_source


class Connector(SupaflowConnector):
    DEFINITION = ConnectorDefinition(
        ${JSON.stringify(input.displayName)}, ${definitionIdentity(input)},
        vendor=${JSON.stringify(input.displayName)}, description="A SQL table source connector",
        icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
        properties=(ConnectorProperty(
            name="connectionUrl", label="Connection URL", type="STRING",
            description="SQLAlchemy connection URL; provide credentials at runtime",
            required=True, encrypted=True, sensitive=True,
        ),),
        resources=RESOURCES, use_full_normalize=True, jsonl_certified=True,
    )

    def _bind_config(self, config):
        super()._bind_config(config)
        value = config.get("connectionUrl")
        if not isinstance(value, str) or not value.strip():
            fail(ErrorType.CONFIGURATION, "connectionUrl is required")

    def _create_source(self, resource, **kwargs):
        return create_source(resource.name, self._config)
`,
      'tests/test_connector.py': `from contextlib import closing
from pathlib import Path
import sqlite3
import tomllib

from ${moduleName}.connector import Connector
from supaflow_python_sdk import ConnectorPackageMetadata
from supaflow_python_sdk.errors import ConnectorException, ErrorType
from supaflow_python_testkit import ConnectorHarness
from connector_fixture import CONNECTOR_FIXTURE


def bound_connector():
    metadata = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    entry, = metadata["project"]["entry-points"]["supaflow.connectors"].values()
    return Connector.with_package_metadata(ConnectorPackageMetadata(
        metadata["project"]["version"], metadata["tool"]["supaflow"]["connector"]["group_id"], entry,
    ))


def test_source_lifecycle(tmp_path):
    expected = list(CONNECTOR_FIXTURE.sample_records_by_resource["records"])
    database = tmp_path / "source.sqlite"
    with closing(sqlite3.connect(database)) as connection:
        with connection:
            connection.execute("CREATE TABLE records (id TEXT PRIMARY KEY)")
            connection.executemany("INSERT INTO records (id) VALUES (?)", [(row["id"],) for row in expected])
    harness = ConnectorHarness(
        bound_connector(), {**CONNECTOR_FIXTURE.config, "connectionUrl": "sqlite:///" + database.as_posix()},
        work_dir=str(tmp_path / "job"),
    )
    try:
        assert harness.run_init().product_name == ${JSON.stringify(input.displayName)}
        assert [obj.name for obj in harness.run_schema().objects] == ["records"]
        result, emitted = harness.run_read("records")
        assert result.status == "COMPLETED"
        assert result.statistics.records_read == len(expected)
        actual = [{key: row[key] for key in sample} for row, sample in zip(emitted, expected, strict=True)]
        assert actual == expected
    finally:
        harness.close()


def test_missing_connection_url(tmp_path):
    harness = ConnectorHarness(bound_connector(), {}, work_dir=str(tmp_path))
    try:
        try:
            harness.run_init()
        except ConnectorException as error:
            assert error.error.type == ErrorType.CONFIGURATION
            assert error.error.message == "connectionUrl is required"
        else:
            raise AssertionError("Missing connectionUrl must fail init")
    finally:
        harness.close()
`,
    },
  };
}
